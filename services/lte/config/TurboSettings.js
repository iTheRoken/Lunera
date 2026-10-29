'use strict';

// LTE deliberately keeps its switches separate from Lunera's long-lived media
// cache.  It controls *how* a source is resolved; the existing cache setting
// remains the single authority for whether authorised media may be persisted.
const DEFAULT_TURBO_SETTINGS = Object.freeze({
  configVersion: 1,
  enabled: true,
  fallbackEngine: 'yt-dlp',
  preloadEnabled: true,
  preloadTracks: 2,
  preloadStrategy: 'adaptive',
  cancelUnusedPreloads: true,
  metadataCacheEnabled: true,
  metadataCacheTtlMs: 10 * 60 * 1000,
  maxMetadataEntries: 250,
  qualityMode: 'auto',
  manualFormatId: '',
  preferredCodec: 'auto',
  bufferMode: 'adaptive',
  startupPriority: 'fast',
  stabilityPriority: 'balanced',
  dynamicBuffering: true,
  extractionTimeoutMs: 30_000,
  maxConcurrentExtractions: 2,
  retryEnabled: true,
  maxRetries: 1,
  diagnosticsEnabled: true,
  jsRuntimePath: ''
});

const FALLBACK_ENGINES = new Set(['none', 'yt-dlp', 'lse', 'ytdl-core']);
const QUALITY_MODES = new Set(['auto', 'best', 'balanced', 'low', 'manual']);
const CODECS = new Set(['auto', 'aac', 'opus', 'mp3', 'vorbis', 'flac']);
const BUFFER_MODES = new Set(['adaptive', 'low-latency', 'stable']);
const STARTUP_PRIORITIES = new Set(['fast', 'balanced', 'stable']);
const STABILITY_PRIORITIES = new Set(['fast', 'balanced', 'stable']);
const PRELOAD_STRATEGIES = new Set(['adaptive', 'next', 'conservative']);

function finiteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, minimum, maximum, fallback) {
  return Math.min(maximum, Math.max(minimum, Math.round(finiteNumber(value, fallback))));
}

function boolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true' || value.toLowerCase() === 'yes') return true;
    if (value.toLowerCase() === 'false' || value.toLowerCase() === 'no') return false;
  }
  return fallback;
}

function allowed(value, validValues, fallback) {
  return validValues.has(value) ? value : fallback;
}

function normalizeQualityMode(value) {
  // Existing Lunera profiles use these names.  Mapping them here preserves a
  // selected quality when LTE becomes the default engine.
  const legacy = {
    medium: 'balanced',
    high: 'best',
    lossless: 'best'
  };
  return allowed(legacy[value] || value, QUALITY_MODES, DEFAULT_TURBO_SETTINGS.qualityMode);
}

function normalizeManualFormatId(value, fallback = '') {
  const candidate = typeof value === 'string' ? value.trim() : String(fallback || '').trim();
  // Same conservative grammar accepted by the yt-dlp manager. A literal
  // format id is allowed; arbitrary selector expressions are not.
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(candidate) ? candidate : '';
}

function normalizeTurboSettings(candidate = {}, base = DEFAULT_TURBO_SETTINGS) {
  const source = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  const current = { ...DEFAULT_TURBO_SETTINGS, ...(base || {}) };
  const rawTimeout = source.extractionTimeoutMs ?? source.resolutionTimeoutMs ?? current.extractionTimeoutMs;

  const normalized = {
    configVersion: DEFAULT_TURBO_SETTINGS.configVersion,
    enabled: boolean(source.enabled, boolean(current.enabled, true)),
    fallbackEngine: allowed(source.fallbackEngine, FALLBACK_ENGINES, allowed(current.fallbackEngine, FALLBACK_ENGINES, 'yt-dlp')),
    preloadEnabled: boolean(source.preloadEnabled, boolean(current.preloadEnabled, true)),
    preloadTracks: clamp(source.preloadTracks, 0, 5, current.preloadTracks),
    preloadStrategy: allowed(source.preloadStrategy, PRELOAD_STRATEGIES, allowed(current.preloadStrategy, PRELOAD_STRATEGIES, 'adaptive')),
    cancelUnusedPreloads: boolean(source.cancelUnusedPreloads, boolean(current.cancelUnusedPreloads, true)),
    metadataCacheEnabled: boolean(source.metadataCacheEnabled, boolean(current.metadataCacheEnabled, true)),
    metadataCacheTtlMs: clamp(source.metadataCacheTtlMs, 15_000, 24 * 60 * 60 * 1000, current.metadataCacheTtlMs),
    maxMetadataEntries: clamp(source.maxMetadataEntries, 10, 1000, current.maxMetadataEntries),
    qualityMode: normalizeQualityMode(source.qualityMode ?? current.qualityMode),
    manualFormatId: normalizeManualFormatId(source.manualFormatId, current.manualFormatId),
    preferredCodec: allowed(source.preferredCodec, CODECS, allowed(current.preferredCodec, CODECS, 'auto')),
    bufferMode: allowed(source.bufferMode, BUFFER_MODES, allowed(current.bufferMode, BUFFER_MODES, 'adaptive')),
    startupPriority: allowed(source.startupPriority, STARTUP_PRIORITIES, allowed(current.startupPriority, STARTUP_PRIORITIES, 'fast')),
    stabilityPriority: allowed(source.stabilityPriority, STABILITY_PRIORITIES, allowed(current.stabilityPriority, STABILITY_PRIORITIES, 'balanced')),
    dynamicBuffering: boolean(source.dynamicBuffering, boolean(current.dynamicBuffering, true)),
    extractionTimeoutMs: clamp(rawTimeout, 1000, 120_000, current.extractionTimeoutMs),
    maxConcurrentExtractions: clamp(source.maxConcurrentExtractions, 1, 4, current.maxConcurrentExtractions),
    retryEnabled: boolean(source.retryEnabled, boolean(current.retryEnabled, true)),
    maxRetries: clamp(source.maxRetries, 0, 3, current.maxRetries),
    diagnosticsEnabled: boolean(source.diagnosticsEnabled, boolean(current.diagnosticsEnabled, true)),
    // A runtime path is optional and is validated again immediately before it
    // becomes a child-process argument.  Never infer Electron's binary here.
    jsRuntimePath: typeof source.jsRuntimePath === 'string'
      ? source.jsRuntimePath.trim().slice(0, 1024)
      : String(current.jsRuntimePath || '').trim().slice(0, 1024)
  };

  // Alias retained for the existing LSE-oriented diagnostics UI and imports.
  normalized.resolutionTimeoutMs = normalized.extractionTimeoutMs;
  return normalized;
}

module.exports = {
  DEFAULT_TURBO_SETTINGS,
  normalizeTurboSettings,
  FALLBACK_ENGINES,
  QUALITY_MODES
};

