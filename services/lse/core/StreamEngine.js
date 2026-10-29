const { EventEmitter } = require('events');
const crypto = require('crypto');
const { DEFAULT_LSE_SETTINGS, normalizeSettings } = require('../config/defaultSettings');
const { MetadataCache } = require('../cache/MetadataCache');
const { NetworkManager } = require('./NetworkManager');
const { LSEError, toLSEError, isAbortError, sanitizeDetails } = require('./errors');
const { ProviderRegistry } = require('../extractors/ProviderRegistry');
const { LocalExtractor } = require('../extractors/LocalExtractor');
const { HLSExtractor } = require('../extractors/HLSExtractor');
const { DASHExtractor } = require('../extractors/DASHExtractor');
const { DirectMediaExtractor } = require('../extractors/DirectMediaExtractor');

function clone(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function stableSourceKey(source) {
  if (typeof source === 'string') return source.trim();
  if (!source || typeof source !== 'object') return String(source || '');
  const relevant = {
    type: source.type || null,
    url: source.url || source.sourceUrl || source.audioUrl || null,
    path: source.filePath || source.localPath || source.path || null,
    id: source.id || null
  };
  return JSON.stringify(relevant);
}

function cacheKeyFor(source, options = {}) {
  const raw = `${stableSourceKey(source)}|${options.quality || 'auto'}|${options.preferredCodec || 'auto'}|${options.progressiveStreamingEnabled !== false}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function describeSource(source) {
  try {
    const raw = typeof source === 'string' ? source : source?.url || source?.filePath || source?.path || '';
    if (String(raw).startsWith('file:')) return 'archivo local';
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.pathname}`;
  } catch (error) {
    return typeof source === 'object' ? 'fuente estructurada' : 'fuente local';
  }
}

function normalizeOptions(options = {}, settings) {
  return {
    quality: options.quality && options.quality !== 'auto' ? options.quality : settings.qualityMode,
    preferredCodec: options.preferredCodec || settings.preferredCodec,
    progressiveStreamingEnabled: settings.progressiveStreamingEnabled,
    timeoutMs: Math.max(1000, Number(options.timeoutMs) || settings.resolutionTimeoutMs),
    signal: options.signal || null,
    preload: options.preload === true,
    forceRefresh: options.forceRefresh === true
  };
}

class LuneraStreamEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.settings = normalizeSettings(options.settings || {}, DEFAULT_LSE_SETTINGS);
    this.networkManager = options.networkManager || new NetworkManager({
      allowPrivateNetworkForTests: options.allowPrivateNetworkForTests === true,
      defaultTimeoutMs: this.settings.connectionTimeoutMs,
      maxConnections: this.settings.maxConnections,
      lookup: options.lookup
    });
    this.metadataCache = options.metadataCache || new MetadataCache({
      storagePath: options.metadataCachePath,
      maxEntries: this.getMetadataCacheEntryLimit(this.settings.memoryCacheMB),
      defaultTtlMs: options.metadataCacheTtlMs || 10 * 60 * 1000
    });
    this.registry = options.registry || new ProviderRegistry([
      new LocalExtractor(),
      new HLSExtractor(),
      new DASHExtractor(),
      new DirectMediaExtractor()
    ]);
    this.initialized = false;
    this.activeResolutions = new Map();
    this.preloads = new Map();
    this.logs = [];
    this.recentErrors = [];
    this.diagnostics = {
      status: 'idle',
      activeEngine: 'lse',
      currentSource: null,
      selectedAt: null,
      resolutionStartedAt: null,
      lastResolutionMs: null,
      timeToFirstAudioMs: null,
      lastBufferingMs: null,
      lastError: null,
      lastResult: null
    };
    this.stats = {
      resolutions: 0,
      cacheHits: 0,
      cacheMisses: 0,
      retries: 0,
      cancellations: 0,
      errors: 0,
      preloadsStarted: 0,
      preloadsCompleted: 0,
      preloadsCancelled: 0
    };
    // Mantiene disponible el evento convencional `error` sin convertir un
    // fallo recuperable de resolución en una excepción no controlada cuando
    // todavía no hay un consumidor de diagnósticos registrado.
    this.on('error', () => {});
  }

  getMetadataCacheEntryLimit(memoryMB) {
    return Math.min(1024, Math.max(20, Math.round(Number(memoryMB || 64) * 2)));
  }

  async initialize() {
    if (this.initialized) return this.getDiagnostics();
    await this.metadataCache.initialize();
    this.initialized = true;
    this.setStatus('ready');
    this.log('info', 'LSE inicializado', { engine: 'lse' });
    return this.getDiagnostics();
  }

  setStatus(status) {
    this.diagnostics.status = status;
    this.emit('state', { status, timestamp: Date.now() });
  }

  log(level, message, details = null) {
    const entry = {
      timestamp: Date.now(),
      level,
      message: String(message || '').slice(0, 400),
      details: sanitizeDetails(details)
    };
    this.logs.push(entry);
    if (this.logs.length > 120) this.logs.splice(0, this.logs.length - 120);
    this.emit('log', entry);
    return entry;
  }

  emitProgress(payload = {}) {
    const event = {
      engine: 'lse',
      timestamp: Date.now(),
      ...payload
    };
    this.emit('progress', event);
    return event;
  }

  async resolve(source, options = {}) {
    await this.initialize();
    if (!this.settings.enabled) {
      throw new LSEError('ENGINE_DISABLED', 'Lunera Stream Engine esta desactivado', { recoverable: false });
    }
    if (!this.settings.streamingEnabled) {
      throw new LSEError('STREAMING_DISABLED', 'El streaming esta desactivado en LSE', { recoverable: false });
    }

    const normalizedOptions = normalizeOptions(options, this.settings);
    if (normalizedOptions.signal?.aborted) {
      this.stats.cancellations += 1;
      throw new LSEError('ABORTED', 'La resolucion de audio fue cancelada', { recoverable: true });
    }
    const key = cacheKeyFor(source, normalizedOptions);

    if (!normalizedOptions.forceRefresh && this.settings.metadataCacheEnabled) {
      const cached = this.metadataCache.get(key);
      if (cached) {
        this.stats.cacheHits += 1;
        const extraction = clone(cached);
        extraction.extractionMs = 0;
        extraction.fromMetadataCache = true;
        if (extraction.metadata?.streamingProfile) {
          extraction.metadata.streamingProfile = {
            ...extraction.metadata.streamingProfile,
            cacheHit: true,
            cacheKind: 'metadata'
          };
        }
        this.diagnostics.lastResult = summarizeResult(extraction);
        this.emitProgress({
          stage: 'cache-hit',
          source: describeSource(source),
          message: 'Recurso preparado desde cache de metadatos'
        });
        return extraction;
      }
      this.stats.cacheMisses += 1;
    }

    if (!normalizedOptions.signal && this.activeResolutions.has(key)) {
      return clone(await this.activeResolutions.get(key));
    }

    const job = this.resolveFresh(source, normalizedOptions, key);
    if (!normalizedOptions.signal) this.activeResolutions.set(key, job);
    try {
      return clone(await job);
    } finally {
      if (!normalizedOptions.signal) this.activeResolutions.delete(key);
    }
  }

  async resolveFresh(source, options, key) {
    const selectedAt = Date.now();
    this.diagnostics.currentSource = describeSource(source);
    this.diagnostics.selectedAt = selectedAt;
    this.diagnostics.resolutionStartedAt = selectedAt;
    this.diagnostics.timeToFirstAudioMs = null;
    this.diagnostics.lastError = null;
    this.setStatus(options.preload ? 'preloading' : 'resolving');
    this.emitProgress({
      stage: 'selection',
      source: this.diagnostics.currentSource,
      preload: options.preload,
      message: options.preload ? 'Precargando recurso de audio' : 'Resolviendo recurso de audio'
    });

    const attempts = this.settings.retryEnabled ? this.settings.maxRetries + 1 : 1;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (options.signal?.aborted) {
        this.stats.cancellations += 1;
        throw new LSEError('ABORTED', 'La resolucion de audio fue cancelada', { recoverable: true });
      }
      try {
        this.emitProgress({
          stage: 'resolution',
          attempt,
          source: this.diagnostics.currentSource,
          message: attempt === 1 ? 'Resolviendo fuente compatible' : `Reintentando resolucion (${attempt}/${attempts})`
        });
        const rawResult = await this.registry.resolve(source, {
          networkManager: this.networkManager,
          signal: options.signal,
          options
        });
        const extractionMs = Date.now() - selectedAt;
        const result = this.toCompatibilityResult(rawResult, options, extractionMs, attempt);
        this.stats.resolutions += 1;
        this.diagnostics.lastResolutionMs = extractionMs;
        this.diagnostics.lastResult = summarizeResult(result);
        this.setStatus('ready');

        if (this.settings.metadataCacheEnabled && rawResult.cacheable !== false) {
          await this.metadataCache.set(key, result, {
            ttlMs: rawResult.cacheTtlMs,
            persist: rawResult.cachePersist !== false,
            reusable: true
          });
        }

        this.emitProgress({
          stage: 'ready',
          source: result.metadata?.streamingProfile?.source || 'network',
          provider: result.provider,
          elapsedMs: extractionMs,
          message: 'Audio preparado por Lunera Stream Engine'
        });
        this.emit('resolved', clone(result));
        return result;
      } catch (error) {
        const normalized = toLSEError(error, 'RESOLUTION_ERROR');
        lastError = normalized;
        if (normalized.code === 'ABORTED' || isAbortError(normalized)) {
          this.stats.cancellations += 1;
          this.setStatus('ready');
          throw normalized;
        }
        const canRetry = normalized.recoverable !== false && attempt < attempts;
        if (canRetry) {
          this.stats.retries += 1;
          this.emitProgress({
            stage: 'retry',
            attempt,
            error: normalized.message,
            message: 'La fuente fallo; reintentando'
          });
          continue;
        }
      }
    }

    this.stats.errors += 1;
    this.diagnostics.lastError = lastError?.toJSON?.() || { message: lastError?.message || 'Error desconocido' };
    this.recentErrors.push({ timestamp: Date.now(), ...this.diagnostics.lastError });
    if (this.recentErrors.length > 20) this.recentErrors.splice(0, this.recentErrors.length - 20);
    this.setStatus('error');
    this.log('error', lastError?.message || 'Fallo de resolucion', this.diagnostics.lastError);
    this.emit('error', lastError);
    throw lastError;
  }

  toCompatibilityResult(rawResult, options, extractionMs, attempt) {
    const result = clone(rawResult);
    const provider = result.extractor || 'lse-direct';
    result.provider = provider;
    result.extractor = 'lse';
    result.extractionMs = extractionMs;
    result.attempts = [{ extractor: provider, ok: true, ms: extractionMs, attempt }];
    result.metadata = result.metadata || {};
    result.metadata.streamingProfile = {
      ...(result.metadata.streamingProfile || {}),
      engine: 'lse',
      extractor: 'lse',
      provider,
      extractorMode: 'lse',
      usedFallback: false,
      extractionMs,
      preload: options.preload === true
    };
    return result;
  }

  async preload(source, options = {}) {
    await this.initialize();
    if (!this.settings.preloadEnabled) {
      return { ok: false, skipped: true, reason: 'PRELOAD_DISABLED' };
    }
    const normalizedOptions = normalizeOptions({ ...options, preload: true }, this.settings);
    const key = cacheKeyFor(source, normalizedOptions);
    const existing = this.preloads.get(key);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const preloadOptions = { ...options, preload: true, signal: controller.signal };
    const record = {
      source: describeSource(source),
      startedAt: Date.now(),
      controller,
      state: 'resolving',
      promise: null
    };
    this.stats.preloadsStarted += 1;
    record.promise = this.resolve(source, preloadOptions)
      .then(result => {
        record.state = 'ready';
        record.completedAt = Date.now();
        this.stats.preloadsCompleted += 1;
        this.emit('preload', { state: 'ready', source: record.source, elapsedMs: record.completedAt - record.startedAt });
        return { ok: true, source: 'metadata', result };
      })
      .catch(error => {
        record.state = error?.code === 'ABORTED' ? 'cancelled' : 'error';
        record.error = error?.toJSON?.() || { message: error?.message || 'Error desconocido' };
        if (record.state === 'cancelled') this.stats.preloadsCancelled += 1;
        this.emit('preload', { state: record.state, source: record.source, error: record.error });
        return { ok: false, error: error?.message || 'No se pudo precargar', code: error?.code || 'PRELOAD_ERROR' };
      })
      .finally(() => {
        if (this.preloads.get(key) === record) this.preloads.delete(key);
      });
    this.preloads.set(key, record);
    return record.promise;
  }

  cancelPreload(sourceOrKey) {
    const key = this.preloads.has(sourceOrKey)
      ? sourceOrKey
      : cacheKeyFor(sourceOrKey, normalizeOptions({}, this.settings));
    const record = this.preloads.get(key);
    if (!record) return false;
    record.controller.abort();
    return true;
  }

  cancelAllPreloads() {
    let count = 0;
    for (const record of this.preloads.values()) {
      record.controller.abort();
      count += 1;
    }
    return count;
  }

  recordPlaybackEvent(stage, details = {}) {
    const now = Date.now();
    if (stage === 'first-audio') {
      const startedAt = Number(details.selectedAt || this.diagnostics.selectedAt || now);
      this.diagnostics.timeToFirstAudioMs = Math.max(0, now - startedAt);
    }
    if (stage === 'buffering') {
      this.diagnostics.lastBufferingMs = Number(details.durationMs || 0) || null;
    }
    this.emitProgress({ stage, ...sanitizeDetails(details) });
  }

  getSettings() {
    return clone(this.settings);
  }

  updateSettings(patch = {}) {
    this.settings = normalizeSettings(patch, this.settings);
    this.networkManager.defaultTimeoutMs = this.settings.connectionTimeoutMs;
    this.networkManager.maxConnections = this.settings.maxConnections;
    this.metadataCache.maxEntries = this.getMetadataCacheEntryLimit(this.settings.memoryCacheMB);
    this.metadataCache.prune();
    this.emit('settings', this.getSettings());
    return this.getSettings();
  }

  resetSettings() {
    this.settings = normalizeSettings(DEFAULT_LSE_SETTINGS, DEFAULT_LSE_SETTINGS);
    this.networkManager.defaultTimeoutMs = this.settings.connectionTimeoutMs;
    this.networkManager.maxConnections = this.settings.maxConnections;
    this.metadataCache.maxEntries = this.getMetadataCacheEntryLimit(this.settings.memoryCacheMB);
    this.emit('settings', this.getSettings());
    return this.getSettings();
  }

  async clearCache() {
    this.cancelAllPreloads();
    await this.metadataCache.clear();
    this.emitProgress({ stage: 'cache-cleared', message: 'Cache de metadatos LSE eliminada' });
    return this.metadataCache.getStats();
  }

  getExtractorStatus() {
    return this.registry.getStatus();
  }

  setExtractorEnabled(id, enabled) {
    const status = this.registry.setEnabled(String(id || ''), enabled);
    this.emit('extractor-settings', { ...status });
    return status;
  }

  registerExtractor(extractor) {
    return this.registry.register(extractor);
  }

  getStats() {
    return {
      ...this.stats,
      network: this.networkManager.getStats(),
      metadataCache: this.metadataCache.getStats(),
      activePreloads: this.preloads.size,
      activeResolutions: this.activeResolutions.size
    };
  }

  getDiagnostics() {
    const activePreloads = [...this.preloads.values()].map(record => ({
      source: record.source,
      state: record.state,
      startedAt: record.startedAt,
      elapsedMs: Date.now() - record.startedAt,
      error: record.error || null
    }));
    return {
      ...clone(this.diagnostics),
      settings: this.getSettings(),
      stats: this.getStats(),
      extractors: this.getExtractorStatus(),
      activePreloads,
      recentErrors: clone(this.recentErrors),
      logs: clone(this.logs.slice(-60)),
      limitations: {
        firstAudio: 'La medicion de primer audio debe confirmarse desde el evento playing/audible del renderer; play() por si solo no garantiza audio audible.',
        hlsDash: 'HLS y DASH se detectan, pero no se anuncian como reproducibles sin un adaptador MSE real.'
      }
    };
  }

  async dispose() {
    this.cancelAllPreloads();
    this.activeResolutions.clear();
    this.removeAllListeners();
  }
}

function summarizeResult(result) {
  return {
    provider: result.provider || result.extractor || null,
    title: result.metadata?.title || null,
    source: result.metadata?.streamingProfile?.source || null,
    protocol: result.metadata?.streamingProfile?.protocol || null,
    extractionMs: result.extractionMs || null
  };
}

module.exports = {
  LuneraStreamEngine,
  cacheKeyFor,
  stableSourceKey
};
