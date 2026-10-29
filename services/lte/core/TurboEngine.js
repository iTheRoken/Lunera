'use strict';

const crypto = require('crypto');
const { DEFAULT_TURBO_SETTINGS, normalizeTurboSettings } = require('../config/TurboSettings');
const { TurboMetadataCache } = require('../extraction/ExtractionCache');
const { ExtractionQueue, isAbortError } = require('../extraction/ExtractionQueue');
const { YtDlpManager } = require('../extraction/YtDlpManager');
const { selectTurboFormat, normalizeTurboFormat, getUrlExpiry } = require('../extraction/FormatSelector');
const { StreamManager } = require('../streaming/StreamManager');
const { PerformanceMonitor } = require('../performance/PerformanceMonitor');

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeUrlKey(url) {
  try {
    const parsed = new URL(String(url));
    parsed.hash = '';
    // Start offsets do not change the media resource and should not force a
    // second metadata process for the same selected YouTube video.
    parsed.searchParams.delete('t');
    parsed.searchParams.delete('start');
    return parsed.toString();
  } catch (error) {
    return String(url || '').trim();
  }
}

function buildResolutionKey(url, options = {}) {
  const raw = [safeUrlKey(url), options.quality || 'auto', options.manualFormatId || '', options.preferredCodec || 'auto'].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function qualityForYtDlp(value) {
  const normalized = String(value || 'auto').toLowerCase();
  if (normalized === 'medium') return 'balanced';
  if (normalized === 'high' || normalized === 'lossless') return 'best';
  return ['auto', 'best', 'balanced', 'low', 'manual'].includes(normalized) ? normalized : 'auto';
}

function abortError(message = 'La operaciÃ³n LTE fue cancelada') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

function cleanError(error) {
  return String(error?.message || error || 'Error desconocido')
    .replace(/https?:\/\/[^\s)\]}]+/gi, '[url privada]')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

class LuneraTurboEngine {
  constructor(options = {}) {
    this.settings = normalizeTurboSettings(options.settings || {}, DEFAULT_TURBO_SETTINGS);
    this.ytdlpManager = options.ytdlpManager || new YtDlpManager({ resolver: options.resolver, diagnosticsProvider: options.diagnosticsProvider });
    this.metadataCache = options.metadataCache || new TurboMetadataCache({
      ttlMs: this.settings.metadataCacheTtlMs,
      maxEntries: this.settings.maxMetadataEntries,
      persistencePath: options.metadataCachePath,
      now: options.now
    });
    this.queue = options.queue || new ExtractionQueue({ maxConcurrent: this.settings.maxConcurrentExtractions });
    this.performance = options.performanceMonitor || new PerformanceMonitor({ now: options.now });
    this.streamManager = options.streamManager || new StreamManager({ now: options.now });
    // A cache without a persistence file is ready immediately. This keeps the
    // hot playback/preload path synchronous up to process launch while a
    // persisted cache is explicitly initialized during Electron startup.
    this.initialized = !options.metadataCachePath;
    // Multiple consumers can reuse the same extraction. Counts keep a
    // completed/aborted caller from erasing another caller's interest.
    this.interactiveKeys = new Map();
    this.preloadKeys = new Map();
    this.lastYtDlpDiagnostics = { available: null, status: 'not-checked' };
    this.stats = {
      resolutions: 0,
      cacheHits: 0,
      metadataHits: 0,
      deduplicatedRequests: 0,
      preloadsStarted: 0,
      preloadsCompleted: 0,
      preloadsCancelled: 0,
      retries: 0,
      errors: 0,
      expiryRefreshes: 0
    };
  }

  async initialize() {
    if (this.initialized) return this.getDiagnostics();
    this.initialized = true;
    await this.metadataCache.initialize();
    void this.refreshRuntimeDiagnostics();
    return this.getDiagnostics();
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(patch = {}) {
    const diagnosticsWereEnabled = this.settings.diagnosticsEnabled;
    this.settings = normalizeTurboSettings(patch, this.settings);
    this.metadataCache.ttlMs = this.settings.metadataCacheTtlMs;
    this.metadataCache.maxEntries = this.settings.maxMetadataEntries;
    this.queue.setMaxConcurrent(this.settings.maxConcurrentExtractions);
    if (diagnosticsWereEnabled && !this.settings.diagnosticsEnabled) this.performance.reset();
    return this.getSettings();
  }

  resetSettings() {
    this.settings = normalizeTurboSettings(DEFAULT_TURBO_SETTINGS, DEFAULT_TURBO_SETTINGS);
    this.metadataCache.ttlMs = this.settings.metadataCacheTtlMs;
    this.metadataCache.maxEntries = this.settings.maxMetadataEntries;
    this.queue.setMaxConcurrent(this.settings.maxConcurrentExtractions);
    return this.getSettings();
  }

  getResolutionKey(url, options = {}) {
    return buildResolutionKey(url, {
      quality: qualityForYtDlp(options.quality || this.settings.qualityMode),
      manualFormatId: options.manualFormatId || (this.settings.qualityMode === 'manual' ? this.settings.manualFormatId : ''),
      preferredCodec: options.preferredCodec || this.settings.preferredCodec
    });
  }

  async resolve(url, options = {}) {
    if (!this.settings.enabled) throw new Error('Lunera Turbo Engine estÃ¡ desactivado');
    if (!url || typeof url !== 'string') throw new Error('LTE necesita una URL vÃ¡lida de una pista');
    if (options.signal?.aborted) throw abortError();
    if (!this.initialized) await this.initialize();
    if (options.signal?.aborted) throw abortError();

    const quality = qualityForYtDlp(options.quality || this.settings.qualityMode);
    const manualFormatId = options.manualFormatId || (quality === 'manual' ? this.settings.manualFormatId : '');
    const preferredCodec = options.preferredCodec || this.settings.preferredCodec;
    const resolutionKey = this.getResolutionKey(url, { ...options, quality, manualFormatId, preferredCodec });
    const requestId = String(options.requestId || `lte-${Date.now()}-${resolutionKey.slice(0, 8)}`);
    const isPreload = options.preload === true;
    const isInteractive = !isPreload;
    const metadataCachingEnabled = this.settings.metadataCacheEnabled && options.metadataCacheEnabled !== false;
    this.startPerformance(requestId, {
      engine: 'lte',
      extractor: 'yt-dlp',
      source: 'network',
      preload: isPreload
    });

    if (isInteractive) this.addKeyInterest(this.interactiveKeys, resolutionKey);
    if (isPreload) this.addKeyInterest(this.preloadKeys, resolutionKey);

    try {
      if (!options.forceRefresh) {
        const cached = this.metadataCache.getResolved(resolutionKey);
        if (cached) {
          this.stats.cacheHits += 1;
          const result = this.decorateResolved(cached, { quality, manualFormatId, preferredCodec, resolutionKey, cache: 'memory', requestId });
          this.markPerformance(requestId, 'extraction-ready', { source: 'memory-cache' });
          return result;
        }
        if (metadataCachingEnabled && this.metadataCache.get(resolutionKey)) {
          this.stats.metadataHits += 1;
        }
      } else {
        this.metadataCache.delete(resolutionKey);
        this.stats.expiryRefreshes += 1;
      }

      const priority = options.recovery ? 'recovery' : isPreload ? 'preload' : 'playback';
      const queued = this.queue.run(resolutionKey, async ({ signal }) => {
        const startedAt = Date.now();
        const resolved = await this.resolveWithRetry(url, {
          quality,
          manualFormatId,
          preferredCodec,
          signal,
          requestId,
          onProgress: options.onProgress
        });
        const decorated = this.decorateResolved(resolved, { quality, manualFormatId, preferredCodec, resolutionKey, requestId });
        decorated.extractionMs = Math.max(0, Date.now() - startedAt);
        this.metadataCache.setResolved(resolutionKey, decorated, { expiresAt: decorated.sourcePolicy?.expiresAt });
        if (metadataCachingEnabled) {
          this.metadataCache.set(resolutionKey, {
            metadata: decorated.metadata,
            formats: decorated.formats,
            selectedFormat: decorated.selectedFormat,
            source: 'yt-dlp'
          });
        }
        this.stats.resolutions += 1;
        return decorated;
      }, { priority, kind: isPreload ? 'preload' : 'playback' });

      if (queued.shared) this.stats.deduplicatedRequests += 1;
      // Each caller receives its own cancellation boundary. The shared yt-dlp
      // process stops only when its final interested subscriber goes away.
      const result = await this.waitForQueueResult(queued, {
        resolutionKey,
        kind: isPreload ? 'preload' : 'playback',
        signal: options.signal
      });
      this.markPerformance(requestId, 'extraction-ready', {
        source: queued.shared ? 'shared-resolution' : 'network',
        extractor: 'yt-dlp'
      });
      return deepClone(result);
    } catch (error) {
      this.stats.errors += 1;
      this.failPerformance(requestId, error);
      throw error;
    } finally {
      if (isInteractive) this.releaseKeyInterest(this.interactiveKeys, resolutionKey);
      if (isPreload) this.releaseKeyInterest(this.preloadKeys, resolutionKey);
    }
  }

  addKeyInterest(keys, key) {
    keys.set(key, (Number(keys.get(key)) || 0) + 1);
  }

  releaseKeyInterest(keys, key) {
    const remaining = (Number(keys.get(key)) || 0) - 1;
    if (remaining > 0) keys.set(key, remaining);
    else keys.delete(key);
  }

  getQueueSubscribers(job) {
    if (!job) return new Set();
    if (!(job.lteSubscribers instanceof Set)) job.lteSubscribers = new Set();
    return job.lteSubscribers;
  }

  waitForQueueResult(queued, options = {}) {
    const job = queued?.job;
    if (!job) return Promise.reject(new Error('La cola LTE no devolvio una tarea valida'));

    const subscribers = this.getQueueSubscribers(job);
    const signal = options.signal;
    const kind = options.kind === 'preload' ? 'preload' : 'playback';
    const resolutionKey = String(options.resolutionKey || job.key || '');

    return new Promise((resolve, reject) => {
      let settled = false;
      let abortListener = null;
      const subscriber = { kind, active: true, cancel: null };
      const cleanup = () => {
        subscribers.delete(subscriber);
        if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      };
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        subscriber.active = false;
        cleanup();
        callback(value);
      };
      const cancel = (reason = 'La resolucion LTE fue cancelada') => {
        if (settled || !subscriber.active) return false;
        subscriber.active = false;
        const hasAnotherConsumer = [...subscribers].some(item => item !== subscriber && item.active);
        if (!hasAnotherConsumer) this.queue.cancel(resolutionKey, reason);
        settle(reject, abortError(reason));
        return true;
      };

      subscriber.cancel = cancel;
      subscribers.add(subscriber);
      abortListener = () => cancel('La resolucion LTE fue cancelada por el reproductor');
      if (signal) {
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) {
          abortListener();
          return;
        }
      }

      queued.promise.then(
        result => {
          if (signal?.aborted) {
            cancel('La resolucion LTE fue cancelada por el reproductor');
            return;
          }
          settle(resolve, result);
        },
        error => settle(reject, isAbortError(error) ? abortError() : error)
      );
    });
  }

  cancelSubscribers(resolutionKey, predicate, reason) {
    const job = this.queue.getJob?.(resolutionKey);
    if (!job) return 0;
    let cancelled = 0;
    for (const subscriber of [...this.getQueueSubscribers(job)]) {
      if (typeof predicate === 'function' && !predicate(subscriber)) continue;
      if (subscriber.cancel?.(reason)) cancelled += 1;
    }
    return cancelled;
  }

  startPerformance(...args) {
    if (!this.settings.diagnosticsEnabled) return null;
    return this.performance.start(...args);
  }

  markPerformance(...args) {
    if (!this.settings.diagnosticsEnabled) return null;
    return this.performance.mark(...args);
  }

  failPerformance(...args) {
    if (!this.settings.diagnosticsEnabled) return null;
    return this.performance.fail(...args);
  }

  getPerformanceSnapshot() {
    if (this.settings.diagnosticsEnabled) return this.performance.snapshot();
    return {
      enabled: false,
      samples: 0,
      active: [],
      average: {},
      median: {},
      percentiles: { p95: {} },
      counters: { started: 0, completed: 0, failed: 0, bufferingEvents: 0, bufferingMs: 0, streamFirstBytes: 0 },
      recent: [],
      recentErrors: [],
      system: {}
    };
  }

  async resolveWithRetry(url, options = {}) {
    const attempts = this.settings.retryEnabled ? this.settings.maxRetries + 1 : 1;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (options.signal?.aborted) throw abortError();
      try {
        return await this.ytdlpManager.resolve(url, {
          quality: options.quality,
          manualFormatId: options.manualFormatId,
          preferredCodec: options.preferredCodec,
          timeoutMs: options.timeoutMs || this.settings.extractionTimeoutMs,
          signal: options.signal,
          jsRuntimePath: this.settings.jsRuntimePath,
          requestId: options.requestId,
          onProgress: (event = {}) => {
            options.onProgress?.({ type: 'lte-ytdlp', attempt: attempt + 1, ...event });
          }
        });
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) throw abortError();
        lastError = error;
        if (attempt + 1 < attempts) this.stats.retries += 1;
      }
    }
    throw lastError || new Error('yt-dlp no pudo resolver la pista');
  }

  decorateResolved(result = {}, options = {}) {
    const metadata = result.metadata ? deepClone(result.metadata) : {};
    const directFormats = Array.isArray(result.rawFormats) ? result.rawFormats : Array.isArray(result.formats) ? result.formats : [];
    const rawSelected = result.rawSelectedFormat || result.selectedFormat || selectTurboFormat(directFormats, {
      quality: options.quality,
      manualFormatId: options.manualFormatId,
      preferredCodec: options.preferredCodec
    });
    const selectedFormat = rawSelected?.container ? { ...rawSelected, requiresTranscode: false } : normalizeTurboFormat(rawSelected || {});
    const audioUrl = result.audioUrl || rawSelected?.url;
    if (!audioUrl) throw new Error('yt-dlp no devolviÃ³ un recurso directo de audio compatible');

    const now = Date.now();
    const expiresAt = getUrlExpiry(audioUrl, now) || now + Math.min(this.settings.metadataCacheTtlMs, 8 * 60 * 1000);
    const normalizedFormats = directFormats.map(normalizeTurboFormat);
    const streamingProfile = {
      ...(metadata.streamingProfile || {}),
      source: 'network',
      engine: 'lte',
      extractor: 'lte',
      resolver: 'yt-dlp',
      requested: options.quality,
      requestedLabel: options.quality === 'best' ? 'Mejor disponible' : options.quality === 'low' ? 'Ahorro de datos' : options.quality === 'manual' ? 'Formato manual' : 'AutomÃ¡tica equilibrada',
      container: selectedFormat.container || metadata.streamingProfile?.container || 'unknown',
      codec: selectedFormat.acodec || metadata.streamingProfile?.codec || null,
      effectiveBitrate: selectedFormat.audioBitrate || metadata.streamingProfile?.effectiveBitrate || null,
      formatId: selectedFormat.id || metadata.streamingProfile?.formatId || null,
      requiresTranscode: false,
      cache: options.cache || 'miss',
      preload: options.preload === true
    };

    return {
      ...result,
      extractor: 'lte',
      resolver: 'yt-dlp',
      engine: 'lte',
      audioUrl,
      metadata: {
        ...metadata,
        streamingProfile
      },
      formats: normalizedFormats,
      selectedFormat,
      sourcePolicy: {
        ...(result.sourcePolicy || {}),
        type: 'provider-stream',
        provider: 'youtube',
        supportsRange: true,
        // Eligibility only: the application's cache toggle controls disk writes.
        persistMedia: true,
        allowPersistentCache: true,
        mediaPersistence: 'user-controlled',
        ephemeral: true,
        expiresAt
      },
      expiresAt,
      lte: {
        resolutionKey: options.resolutionKey,
        requestId: String(options.requestId || '').slice(0, 96)
      }
    };
  }

  async preload(url, options = {}) {
    if (!this.settings.preloadEnabled) return { ok: false, skipped: true, code: 'PRELOAD_DISABLED' };
    const resolutionKey = this.getResolutionKey(url, options);
    this.stats.preloadsStarted += 1;
    try {
      const result = await this.resolve(url, { ...options, preload: true });
      this.stats.preloadsCompleted += 1;
      return { ok: true, source: 'memory', result, resolutionKey };
    } catch (error) {
      if (isAbortError(error)) return { ok: false, code: 'ABORTED', error: 'Precarga cancelada', resolutionKey };
      return { ok: false, code: 'PRELOAD_ERROR', error: cleanError(error), resolutionKey };
    } finally {
      this.preloadKeys.delete(resolutionKey);
    }
  }

  cancelPreload(url, options = {}) {
    const key = this.getResolutionKey(url, options);
    const cancelled = this.cancelSubscribers(
      key,
      subscriber => subscriber.kind === 'preload',
      'La precarga LTE quedÃ³ obsoleta'
    );
    if (cancelled) this.stats.preloadsCancelled += cancelled;
    return cancelled > 0;
  }

  cancelAllPreloads() {
    let cancelled = 0;
    for (const job of this.queue.getJobs?.() || []) {
      cancelled += this.cancelSubscribers(
        job.key,
        subscriber => subscriber.kind === 'preload',
        'Las precargas LTE fueron canceladas'
      );
    }
    this.stats.preloadsCancelled += cancelled;
    return cancelled;
  }

  cancelResolution(url, options = {}) {
    const key = this.getResolutionKey(url, options);
    return this.cancelSubscribers(
      key,
      subscriber => subscriber.kind === 'playback',
      'La resolución LTE fue reemplazada por otra pista'
    ) > 0;
  }

  createStreamSession(extraction, options = {}) {
    const session = this.streamManager.create(extraction, { ...options, settings: this.settings });
    const requestId = options.requestId || extraction?.lte?.requestId;
    if (requestId) this.markPerformance(requestId, 'stream-ready', { source: 'local-proxy' });
    return session;
  }

  getStreamSession(id) {
    return this.streamManager.get(id);
  }

  refreshStreamSession(id, extraction) {
    return this.streamManager.refresh(id, extraction);
  }

  recordStreamFirstByte(sessionId, requestId = null) {
    const snapshot = this.streamManager.markFirstByte(sessionId);
    const session = this.streamManager.get(sessionId);
    const resolvedRequestId = requestId || session?.requestId;
    if (snapshot && resolvedRequestId) this.markPerformance(resolvedRequestId, 'first-byte');
    return snapshot;
  }

  recordStreamChunk(sessionId, bytes) {
    return this.streamManager.markChunk(sessionId, bytes);
  }

  recordStreamFailure(sessionId) {
    return this.streamManager.markFailure(sessionId);
  }

  reportPlaybackEvent(event, payload = {}) {
    const requestId = String(payload.requestId || '');
    if (!requestId) return this.getDiagnostics();
    if (event === 'buffering') {
      this.markPerformance(requestId, 'buffering', payload);
      this.streamManager.markStallByRequest(requestId, payload.durationMs);
    }
    else if (event === 'first-audio' || event === 'playing') this.markPerformance(requestId, 'first-audio', payload);
    else this.markPerformance(requestId, event, payload);
    return this.getDiagnostics();
  }

  getDiagnostics() {
    const performance = this.getPerformanceSnapshot();
    return {
      engine: 'lte',
      status: this.settings.enabled ? 'ready' : 'disabled',
      settings: this.getSettings(),
      stats: {
        ...this.stats,
        queue: this.queue.getStats(),
        metadataCache: this.metadataCache.getStats(),
        activePreloads: this.preloadKeys.size,
        activeRequests: performance.active.length
      },
      performance,
      streaming: this.streamManager.getDiagnostics(),
      ytDlp: this.lastYtDlpDiagnostics
    };
  }

  async refreshRuntimeDiagnostics() {
    this.lastYtDlpDiagnostics = await this.ytdlpManager.getDiagnostics({ jsRuntimePath: this.settings.jsRuntimePath });
    return this.getDiagnostics();
  }

  async checkDependencies() {
    if (typeof this.ytdlpManager.checkDependencies === 'function') {
      this.lastYtDlpDiagnostics = await this.ytdlpManager.checkDependencies({ jsRuntimePath: this.settings.jsRuntimePath });
    } else {
      this.lastYtDlpDiagnostics = await this.ytdlpManager.getDiagnostics({ jsRuntimePath: this.settings.jsRuntimePath });
    }
    return this.getDiagnostics();
  }

  async clearMetadataCache() {
    const removed = this.metadataCache.clear();
    await this.metadataCache.flush?.();
    return { removed, stats: this.metadataCache.getStats() };
  }

  async dispose() {
    this.cancelAllPreloads();
    this.streamManager.clear();
    await this.metadataCache.dispose();
  }
}

module.exports = { LuneraTurboEngine, buildResolutionKey, qualityForYtDlp };

