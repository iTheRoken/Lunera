const crypto = require('crypto');
const ytdlpService = require('./ytdlpService');
const ytdlCoreService = require('./ytdlCoreService');
const { LuneraStreamEngine, LSEError } = require('./lse');
const { LuneraTurboEngine } = require('./lte');

// `auto` se conserva sólo para migrar preferencias previas. Las instalaciones
// nuevas llegan al motor Turbo; LSE conserva fuentes directas y locales.
const VALID_EXTRACTOR_MODES = new Set(['lte', 'lse', 'yt-dlp', 'ytdl-core', 'auto']);
const FALLBACK_EXTRACTOR_MODES = new Set(['none', 'yt-dlp', 'ytdl-core', 'lse']);
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com'
]);

let lseEngine = null;
let turboEngine = null;

function configureTurboEngine(engine) {
  if (!engine || typeof engine.resolve !== 'function' || typeof engine.preload !== 'function') {
    throw new TypeError('LTE debe implementar resolve() y preload()');
  }
  turboEngine = engine;
  return turboEngine;
}

function getTurboEngine() {
  if (!turboEngine) turboEngine = new LuneraTurboEngine();
  return turboEngine;
}

function configureLseEngine(engine) {
  if (!engine || typeof engine.resolve !== 'function') {
    throw new TypeError('LSE debe implementar resolve()');
  }
  lseEngine = engine;
  return lseEngine;
}

function getLseEngine() {
  if (!lseEngine) lseEngine = new LuneraStreamEngine();
  return lseEngine;
}

function normalizeExtractorMode(mode) {
  if (mode === 'auto') return 'lte';
  return VALID_EXTRACTOR_MODES.has(mode) ? mode : 'lte';
}

function normalizeFallbackEngine(mode) {
  return FALLBACK_EXTRACTOR_MODES.has(mode) ? mode : 'none';
}

function getFallbackEngine(options = {}, mode = 'lse') {
  if (Object.prototype.hasOwnProperty.call(options, 'fallbackEngine')) {
    return normalizeFallbackEngine(options.fallbackEngine);
  }
  try {
    if (mode === 'lte') {
      return normalizeFallbackEngine(getTurboEngine().getSettings?.().fallbackEngine);
    }
    return normalizeFallbackEngine(getLseEngine().getSettings?.().fallbackEngine);
  } catch (error) {
    return 'none';
  }
}

function getAttemptOrder(mode, options = {}) {
  const normalizedMode = normalizeExtractorMode(mode);
  if (normalizedMode !== 'lse' && normalizedMode !== 'lte') return [normalizedMode];
  const fallback = getFallbackEngine(options, normalizedMode);
  return fallback !== 'none' ? [normalizedMode, fallback] : [normalizedMode];
}

function isAllowedYouTubeHost(hostname = '') {
  const normalizedHost = hostname.toLowerCase().replace(/^www\./, 'www.');
  return YOUTUBE_HOSTS.has(normalizedHost) || normalizedHost.endsWith('.youtube.com');
}

function parseHttpSource(videoUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(videoUrl);
  } catch (error) {
    throw new Error('URL de YouTube inválida');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Solo se permiten URLs http o https');
  }

  return parsedUrl;
}

function validateMediaUrl(videoUrl, mode = 'lte') {
  const normalizedMode = normalizeExtractorMode(typeof mode === 'object' ? mode.mode : mode);
  const parsedUrl = parseHttpSource(videoUrl);

  // LSE valida además destino de red, MIME y que la URL sea un recurso directo.
  // Los extractores heredados mantienen su límite histórico a YouTube.
  if (normalizedMode !== 'lse' && !isAllowedYouTubeHost(parsedUrl.hostname)) {
    throw new Error('El motor seleccionado solo acepta URLs de YouTube');
  }
  return true;
}

function getVideoId(videoUrl) {
  try {
    const parsedUrl = new URL(String(videoUrl || ''));
    if (!isAllowedYouTubeHost(parsedUrl.hostname)) {
      return `direct-${crypto.createHash('sha256').update(parsedUrl.toString()).digest('hex').slice(0, 24)}`;
    }
  } catch (error) {
    return '';
  }

  const ytdlVideoId = ytdlCoreService.getVideoId(videoUrl);
  if (ytdlVideoId) return ytdlVideoId;

  try {
    const parsedUrl = new URL(videoUrl);
    const host = parsedUrl.hostname.toLowerCase();

    if (host.includes('youtu.be')) {
      return parsedUrl.pathname.split('/').filter(Boolean)[0] || '';
    }

    const watchId = parsedUrl.searchParams.get('v');
    if (watchId) return watchId;

    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    const specialPathIndex = pathParts.findIndex(part => ['shorts', 'embed', 'live'].includes(part));
    if (specialPathIndex >= 0 && pathParts[specialPathIndex + 1]) {
      return pathParts[specialPathIndex + 1];
    }
  } catch (error) {
    return '';
  }

  return '';
}

function summarizeError(error) {
  if (!error) return 'Error desconocido';
  return String(error.message || error)
    .replace(/\s+/g, ' ')
    .slice(0, 500) || 'Error desconocido';
}

function log(logger, level, message, details) {
  if (!logger || typeof logger[level] !== 'function') return;
  if (details !== undefined) {
    logger[level](message, details);
  } else {
    logger[level](message);
  }
}

function emitProgress(options = {}, event) {
  if (typeof options.onProgress === 'function') {
    options.onProgress({
      requestId: options.requestId || null,
      ...event
    });
  }
}

async function runLseExtractor(mediaUrl, options = {}) {
  const engine = getLseEngine();
  const onProgress = (event = {}) => emitProgress(options, {
    type: 'extractor-step',
    extractor: 'lse',
    ...event
  });
  engine.on('progress', onProgress);
  try {
    const resolutionOptions = {
      quality: options.quality || engine.getSettings?.().qualityMode || 'auto',
      preferredCodec: options.preferredCodec,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      forceRefresh: options.forceRefresh === true,
      preload: options.preload === true
    };

    // La precarga LSE administra su propio AbortController y métricas. El
    // resto de motores conserva el comportamiento existente de Lunera.
    if (options.preload === true) {
      const preload = await engine.preload(mediaUrl, resolutionOptions);
      if (preload?.ok && preload.result) return preload.result;
      throw new LSEError(preload?.code || 'PRELOAD_ERROR', preload?.error || 'No se pudo precargar la fuente', {
        recoverable: preload?.code !== 'ABORTED'
      });
    }
    return await engine.resolve(mediaUrl, resolutionOptions);
  } finally {
    engine.off('progress', onProgress);
  }
}

async function runTurboExtractor(mediaUrl, options = {}) {
  const engine = getTurboEngine();
  const onProgress = (event = {}) => emitProgress(options, {
    type: 'extractor-step',
    extractor: 'lte',
    ...event
  });
  const resolutionOptions = {
    quality: options.quality || engine.getSettings?.().qualityMode || 'auto',
    manualFormatId: options.manualFormatId,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    forceRefresh: options.forceRefresh === true,
    recovery: options.recovery === true,
    preload: options.preload === true,
    metadataCacheEnabled: options.metadataCacheEnabled !== false,
    requestId: options.requestId,
    onProgress
  };

  if (options.preload === true) {
    const preload = await engine.preload(mediaUrl, resolutionOptions);
    if (preload?.ok && preload.result) return preload.result;
    const error = new Error(preload?.error || 'No se pudo preparar la pista con LTE');
    error.code = preload?.code || 'PRELOAD_ERROR';
    if (error.code === 'ABORTED') error.name = 'AbortError';
    throw error;
  }
  return engine.resolve(mediaUrl, resolutionOptions);
}

async function runExtractor(extractorName, videoUrl, options) {
  if (extractorName === 'lse') return runLseExtractor(videoUrl, options);
  if (extractorName === 'lte') return runTurboExtractor(videoUrl, options);

  const serviceOptions = {
    ...options,
    onProgress: (event = {}) => emitProgress(options, {
      type: 'extractor-step',
      extractor: extractorName,
      ...event
    })
  };

  if (extractorName === 'yt-dlp') {
    return ytdlpService.extract(videoUrl, serviceOptions);
  }

  return ytdlCoreService.extract(videoUrl, serviceOptions);
}

async function extractAudio(videoUrl, options = {}) {
  const selectedMode = normalizeExtractorMode(options.mode);
  validateMediaUrl(videoUrl, selectedMode);
  const attempts = [];
  let terminalError = null;
  const attemptOrder = getAttemptOrder(selectedMode, options);
  const startedAt = Date.now();

  log(options.logger, 'info', `[audio-extractor] extractor elegido: ${selectedMode}`);
  emitProgress(options, {
    type: 'selected',
    mode: selectedMode,
    attempts: attemptOrder,
    message: `Motor elegido: ${selectedMode}`
  });

  for (const extractorName of attemptOrder) {
    const attemptStartedAt = Date.now();
    try {
      validateMediaUrl(videoUrl, extractorName);
      log(options.logger, 'info', `[audio-extractor] intentando ${extractorName}`);
      emitProgress(options, {
        type: 'attempt-start',
        extractor: extractorName,
        message: `Intentando extraer con ${extractorName}`
      });
      const result = await runExtractor(extractorName, videoUrl, options);
      const attemptMs = Date.now() - attemptStartedAt;
      const totalMs = Date.now() - startedAt;
      const usedFallback = attempts.length > 0;

      attempts.push({
        extractor: extractorName,
        ok: true,
        ms: attemptMs
      });

      result.mode = selectedMode;
      result.usedFallback = usedFallback;
      result.attempts = attempts;
      result.extractionMs = totalMs;

      if (result.metadata?.streamingProfile) {
        result.metadata.streamingProfile.extractor = result.metadata.streamingProfile.extractor || extractorName;
        result.metadata.streamingProfile.extractorMode = selectedMode;
        result.metadata.streamingProfile.usedFallback = usedFallback;
        result.metadata.streamingProfile.extractionMs = totalMs;
        if (usedFallback) result.metadata.streamingProfile.fallbackFrom = selectedMode;
      }

      log(options.logger, 'info', `[audio-extractor] extractor usado: ${extractorName} fallback=${usedFallback} tiempo=${totalMs}ms`);
      emitProgress(options, {
        type: 'attempt-success',
        extractor: extractorName,
        usedFallback,
        attemptMs,
        totalMs,
        message: `${extractorName} encontró audio en ${attemptMs}ms`
      });
      return result;
    } catch (error) {
      terminalError = error;
      const errorSummary = summarizeError(error);
      const attemptMs = Date.now() - attemptStartedAt;
      attempts.push({
        extractor: extractorName,
        ok: false,
        ms: attemptMs,
        error: errorSummary
      });

      log(options.logger, 'warn', `[audio-extractor] ${extractorName} falló en ${attemptMs}ms: ${errorSummary}`);
      emitProgress(options, {
        type: 'attempt-error',
        extractor: extractorName,
        attemptMs,
        error: errorSummary,
        message: `${extractorName} falló: ${errorSummary}`
      });

      // A cancellation is terminal. Trying a fallback after the user selected
      // another song launches unnecessary work and competes with playback.
      if (error?.code === 'ABORTED' || error?.name === 'AbortError' || options.signal?.aborted) {
        const cancellation = error?.code === 'ABORTED' || error?.name === 'AbortError'
          ? error
          : Object.assign(new Error('Extraction cancelled'), { name: 'AbortError', code: 'ABORTED' });
        cancellation.attempts = attempts;
        emitProgress(options, {
          type: 'failed',
          attempts,
          code: 'ABORTED',
          message: cancellation.message
        });
        throw cancellation;
      }

      const nextExtractor = attemptOrder[attempts.length];
      if (nextExtractor) {
        emitProgress(options, {
          type: 'fallback',
          from: extractorName,
          to: nextExtractor,
          message: `Cambiando de ${extractorName} a ${nextExtractor}`
        });
      }
    }
  }

  const message = attempts
    .map(attempt => `${attempt.extractor}: ${attempt.ok ? 'ok' : attempt.error}`)
    .join(' | ');

  // Sin un fallback, conservar el error estructurado de LSE permite que la UI
  // y las herramientas de desarrollo expliquen la restricción real.
  if (attemptOrder.length === 1 && terminalError instanceof LSEError) {
    terminalError.attempts = attempts;
    emitProgress(options, {
      type: 'failed',
      attempts,
      code: terminalError.code,
      message: terminalError.message
    });
    throw terminalError;
  }

  const error = new Error(`No se pudo extraer audio con ningún motor. ${message}`);
  error.attempts = attempts;
  emitProgress(options, {
    type: 'failed',
    attempts,
    message: error.message
  });
  throw error;
}

async function getPlaylist(videoUrl, options = {}) {
  const selectedMode = normalizeExtractorMode(options.mode);

  if (selectedMode === 'lte') {
    validateMediaUrl(videoUrl, selectedMode);
    return ytdlpService.getPlaylist(videoUrl, options);
  }

  if (selectedMode === 'lse') {
    const fallback = getFallbackEngine(options);
    if (fallback === 'yt-dlp') {
      validateMediaUrl(videoUrl, fallback);
      return ytdlpService.getPlaylist(videoUrl, options);
    }
    throw new LSEError(
      'PLAYLIST_UNSUPPORTED',
      'LSE todavía no extrae playlists de páginas de proveedores. Usa una fuente directa o activa el fallback yt-dlp.',
      { recoverable: false }
    );
  }

  validateMediaUrl(videoUrl, selectedMode);

  if (selectedMode === 'ytdl-core') {
    throw new Error('ytdl-core no soporta extracción de playlists en esta integración');
  }

  return ytdlpService.getPlaylist(videoUrl, options);
}

module.exports = {
  VALID_EXTRACTOR_MODES,
  extractAudio,
  getPlaylist,
  getVideoId,
  normalizeExtractorMode,
  normalizeFallbackEngine,
  validateMediaUrl,
  configureLseEngine,
  getLseEngine,
  configureTurboEngine,
  getTurboEngine,
  getFallbackEngine
};
