const QUALITY_MODES = new Set(['auto', 'best', 'low', 'medium', 'high']);
const CODEC_PREFERENCES = new Set(['auto', 'opus', 'aac', 'mp3', 'vorbis', 'flac', 'wav']);
const FALLBACK_ENGINES = new Set(['none', 'yt-dlp', 'ytdl-core']);
const STARTUP_PRIORITIES = new Set(['fast', 'balanced', 'stable']);
const BUFFER_MODES = new Set(['adaptive', 'low-latency', 'stable']);
const FAILURE_RECOVERIES = new Set(['stop', 'next']);

const DEFAULT_LSE_SETTINGS = Object.freeze({
  configVersion: 1,
  engine: 'lse',
  enabled: true,
  fallbackEngine: 'none',
  streamingEnabled: true,
  progressiveStreamingEnabled: true,
  preloadEnabled: true,
  preloadTrackCount: 2,
  metadataCacheEnabled: true,
  mediaCacheEnabled: true,
  gaplessEnabled: true,
  qualityMode: 'auto',
  preferredCodec: 'auto',
  startupPriority: 'fast',
  bufferMode: 'adaptive',
  initialBufferKB: 256,
  maxBufferKB: 2048,
  memoryCacheMB: 64,
  diskCacheMB: 500,
  maxConnections: 4,
  maxConcurrentDownloads: 2,
  resolutionTimeoutMs: 10000,
  connectionTimeoutMs: 8000,
  retryEnabled: true,
  maxRetries: 3,
  processingEnabled: false,
  failureRecovery: 'next',
  skipUnavailableSources: true,
  developerDiagnostics: false
});

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(numeric)));
}

function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function normalizeSettings(candidate = {}, base = DEFAULT_LSE_SETTINGS) {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const current = { ...DEFAULT_LSE_SETTINGS, ...(base || {}) };
  const initialBufferKB = asInteger(source.initialBufferKB, current.initialBufferKB, 64, 4096);

  return {
    configVersion: DEFAULT_LSE_SETTINGS.configVersion,
    engine: 'lse',
    enabled: asBoolean(source.enabled, current.enabled),
    fallbackEngine: oneOf(source.fallbackEngine, FALLBACK_ENGINES, current.fallbackEngine),
    streamingEnabled: asBoolean(source.streamingEnabled, current.streamingEnabled),
    progressiveStreamingEnabled: asBoolean(source.progressiveStreamingEnabled, current.progressiveStreamingEnabled),
    preloadEnabled: asBoolean(source.preloadEnabled, current.preloadEnabled),
    preloadTrackCount: asInteger(source.preloadTrackCount, current.preloadTrackCount, 0, 5),
    metadataCacheEnabled: asBoolean(source.metadataCacheEnabled, current.metadataCacheEnabled),
    mediaCacheEnabled: asBoolean(source.mediaCacheEnabled, current.mediaCacheEnabled),
    gaplessEnabled: asBoolean(source.gaplessEnabled, current.gaplessEnabled),
    qualityMode: oneOf(source.qualityMode, QUALITY_MODES, current.qualityMode),
    preferredCodec: oneOf(source.preferredCodec, CODEC_PREFERENCES, current.preferredCodec),
    startupPriority: oneOf(source.startupPriority, STARTUP_PRIORITIES, current.startupPriority),
    bufferMode: oneOf(source.bufferMode, BUFFER_MODES, current.bufferMode),
    initialBufferKB,
    maxBufferKB: Math.max(
      initialBufferKB,
      asInteger(source.maxBufferKB, current.maxBufferKB, 64, 16384)
    ),
    memoryCacheMB: asInteger(source.memoryCacheMB, current.memoryCacheMB, 8, 512),
    diskCacheMB: asInteger(source.diskCacheMB, current.diskCacheMB, 0, 10240),
    maxConnections: asInteger(source.maxConnections, current.maxConnections, 1, 8),
    maxConcurrentDownloads: asInteger(source.maxConcurrentDownloads, current.maxConcurrentDownloads, 1, 4),
    resolutionTimeoutMs: asInteger(source.resolutionTimeoutMs, current.resolutionTimeoutMs, 1000, 60000),
    connectionTimeoutMs: asInteger(source.connectionTimeoutMs, current.connectionTimeoutMs, 1000, 60000),
    retryEnabled: asBoolean(source.retryEnabled, current.retryEnabled),
    maxRetries: asInteger(source.maxRetries, current.maxRetries, 0, 5),
    processingEnabled: asBoolean(source.processingEnabled, current.processingEnabled),
    failureRecovery: oneOf(source.failureRecovery, FAILURE_RECOVERIES, current.failureRecovery),
    skipUnavailableSources: asBoolean(source.skipUnavailableSources, current.skipUnavailableSources),
    developerDiagnostics: asBoolean(source.developerDiagnostics, current.developerDiagnostics)
  };
}

function getQualityLabel(quality) {
  const labels = {
    auto: 'Automatica',
    best: 'Mejor disponible',
    low: 'Baja',
    medium: 'Media',
    high: 'Alta'
  };
  return labels[quality] || labels.auto;
}

module.exports = {
  DEFAULT_LSE_SETTINGS,
  normalizeSettings,
  getQualityLabel,
  QUALITY_MODES,
  CODEC_PREFERENCES
};
