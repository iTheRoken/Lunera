const ytdlpService = require('./ytdlpService');
const ytdlCoreService = require('./ytdlCoreService');

const VALID_EXTRACTOR_MODES = new Set(['auto', 'yt-dlp', 'ytdl-core']);
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

function normalizeExtractorMode(mode) {
  return VALID_EXTRACTOR_MODES.has(mode) ? mode : 'auto';
}

function getAttemptOrder(mode) {
  const normalizedMode = normalizeExtractorMode(mode);
  if (normalizedMode === 'yt-dlp') return ['yt-dlp'];
  if (normalizedMode === 'ytdl-core') return ['ytdl-core'];
  return ['ytdl-core', 'yt-dlp'];
}

function isAllowedYouTubeHost(hostname = '') {
  const normalizedHost = hostname.toLowerCase().replace(/^www\./, 'www.');
  return YOUTUBE_HOSTS.has(normalizedHost) || normalizedHost.endsWith('.youtube.com');
}

function validateMediaUrl(videoUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(videoUrl);
  } catch (error) {
    throw new Error('URL de YouTube inválida');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Solo se permiten URLs http o https');
  }

  if (!isAllowedYouTubeHost(parsedUrl.hostname)) {
    throw new Error('Solo se permiten URLs de YouTube');
  }

  return true;
}

function getVideoId(videoUrl) {
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

async function runExtractor(extractorName, videoUrl, options) {
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
  validateMediaUrl(videoUrl);

  const selectedMode = normalizeExtractorMode(options.mode);
  const attempts = [];
  const attemptOrder = getAttemptOrder(selectedMode);
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
        result.metadata.streamingProfile.extractor = extractorName;
        result.metadata.streamingProfile.extractorMode = selectedMode;
        result.metadata.streamingProfile.usedFallback = usedFallback;
        result.metadata.streamingProfile.extractionMs = totalMs;
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

      if (selectedMode !== 'auto') {
        break;
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
  validateMediaUrl(videoUrl);
  const selectedMode = normalizeExtractorMode(options.mode);

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
  validateMediaUrl
};
