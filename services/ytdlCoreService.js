const ytdl = require('@distube/ytdl-core');

const DEFAULT_TIMEOUT_MS = 30000;

function getQualityLabel(value) {
  const labels = {
    low: 'Baja (128kbps)',
    medium: 'Media (256kbps)',
    high: 'Alta (320kbps)',
    lossless: 'Sin pérdida'
  };
  return labels[value] || value || 'Desconocida';
}

function summarizeError(error) {
  if (!error) return 'Error desconocido';
  return String(error.shortMessage || error.message || error)
    .replace(/\s+/g, ' ')
    .slice(0, 500) || 'ytdl-core falló sin detalle';
}

function emitProgress(options = {}, event) {
  if (typeof options.onProgress === 'function') {
    options.onProgress(event);
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timeout = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} superó el tiempo límite`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function validateUrl(videoUrl) {
  return ytdl.validateURL(videoUrl);
}

function getVideoId(videoUrl) {
  try {
    return ytdl.getURLVideoID(videoUrl);
  } catch (error) {
    return '';
  }
}

function getFormatBitrate(format = {}) {
  const numericValue = Number(format.audioBitrate || format.bitrate || 0);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function getFormatContainer(format = {}) {
  return String(format.container || format.mimeType || 'webm').split(';')[0].split('/').pop().toLowerCase();
}

function getContainerPriority(format = {}) {
  const container = getFormatContainer(format);
  if (container.includes('m4a')) return 5;
  if (container.includes('mp4')) return 4;
  if (container.includes('webm')) return 3;
  if (container.includes('opus')) return 2;
  if (container.includes('mp3')) return 1;
  return 0;
}

function selectPreferredAudioFormat(formats = [], quality = 'medium') {
  const playableFormats = formats.filter(format => format && format.hasAudio && format.url);
  if (!playableFormats.length) return null;

  const audioOnlyFormats = playableFormats.filter(format => !format.hasVideo);
  const preferredFormats = audioOnlyFormats.length ? audioOnlyFormats : playableFormats;
  const requestedQuality = quality || 'medium';

  if (requestedQuality === 'high' || requestedQuality === 'lossless') {
    return [...preferredFormats].sort((a, b) => {
      const bitrateDiff = getFormatBitrate(b) - getFormatBitrate(a);
      if (bitrateDiff !== 0) return bitrateDiff;
      return getContainerPriority(b) - getContainerPriority(a);
    })[0];
  }

  const targetBitrate = requestedQuality === 'low' ? 128 : 256;
  let bestFormat = preferredFormats[0];
  let bestScore = Number.POSITIVE_INFINITY;

  preferredFormats.forEach(format => {
    const bitrate = getFormatBitrate(format);
    const bitratePenalty = bitrate ? Math.abs(bitrate - targetBitrate) : targetBitrate;
    const overshootPenalty = requestedQuality === 'low' && bitrate > 170 ? 60 : 0;
    const score = bitratePenalty + overshootPenalty - getContainerPriority(format) * 12;

    if (score < bestScore) {
      bestScore = score;
      bestFormat = format;
    }
  });

  return bestFormat;
}

function getBestThumbnail(thumbnails = []) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return '';

  let bestThumbnail = thumbnails[0]?.url || '';
  for (const thumbnail of thumbnails) {
    if (!thumbnail?.url) continue;
    if (thumbnail.width >= 1280 || thumbnail.url.includes('maxres')) {
      bestThumbnail = thumbnail.url;
      break;
    }
    if (thumbnail.width >= 480) {
      bestThumbnail = thumbnail.url;
    }
  }

  return bestThumbnail;
}

function normalizeFormat(format = {}) {
  return {
    id: format.itag || null,
    container: getFormatContainer(format),
    ext: getFormatContainer(format),
    acodec: format.audioCodec || null,
    vcodec: format.hasVideo ? format.videoCodec || 'video' : 'none',
    audioBitrate: getFormatBitrate(format) || null,
    filesize: format.contentLength ? Number(format.contentLength) : null,
    protocol: format.isHLS ? 'hls' : null,
    note: format.qualityLabel || format.audioQuality || null
  };
}

function normalizeFormats(formats = []) {
  return formats
    .filter(format => format && format.hasAudio)
    .map(normalizeFormat);
}

function buildMetadata(info = {}, videoUrl, requestedQuality, selectedFormat = {}) {
  const details = info.videoDetails || {};

  return {
    id: details.videoId || getVideoId(videoUrl),
    title: details.title || 'Sin título',
    artist: details.author?.name || details.ownerChannelName || 'Desconocido',
    thumbnail: getBestThumbnail(details.thumbnails) || '',
    duration: Number(details.lengthSeconds || 0),
    url: videoUrl,
    streamingProfile: {
      source: 'network',
      extractor: 'ytdl-core',
      requested: requestedQuality || 'medium',
      requestedLabel: getQualityLabel(requestedQuality || 'medium'),
      container: getFormatContainer(selectedFormat),
      effectiveBitrate: getFormatBitrate(selectedFormat) || null,
      formatId: selectedFormat.itag || null
    }
  };
}

async function getInfo(videoUrl, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  try {
    return await withTimeout(ytdl.getInfo(videoUrl), timeoutMs, 'ytdl-core getInfo');
  } catch (error) {
    return withTimeout(ytdl.getBasicInfo(videoUrl), timeoutMs, 'ytdl-core getBasicInfo');
  }
}

async function extract(videoUrl, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  try {
    if (!validateUrl(videoUrl)) {
      throw new Error('URL de YouTube inválida para ytdl-core');
    }

    emitProgress(options, {
      step: 'metadata',
      message: 'ytdl-core: obteniendo metadata del video'
    });
    const info = await getInfo(videoUrl, { timeoutMs });
    emitProgress(options, {
      step: 'formats',
      formatsCount: Array.isArray(info.formats) ? info.formats.length : 0,
      message: 'ytdl-core: seleccionando formato de audio'
    });
    const selectedFormat = selectPreferredAudioFormat(info.formats || [], options.quality);

    if (!selectedFormat?.url) {
      throw new Error('ytdl-core no encontró una URL directa de audio');
    }

    const metadata = buildMetadata(info, videoUrl, options.quality, selectedFormat);
    metadata.streamingProfile.extractionMs = Date.now() - startedAt;
    emitProgress(options, {
      step: 'ready',
      formatId: selectedFormat.itag || null,
      elapsedMs: metadata.streamingProfile.extractionMs,
      message: 'ytdl-core: audio listo'
    });

    return {
      extractor: 'ytdl-core',
      audioUrl: selectedFormat.url,
      metadata,
      formats: normalizeFormats(info.formats || []),
      selectedFormat: normalizeFormat(selectedFormat),
      httpHeaders: {},
      extractionMs: Date.now() - startedAt
    };
  } catch (error) {
    const wrappedError = new Error(summarizeError(error));
    wrappedError.cause = error;
    wrappedError.extractor = 'ytdl-core';
    throw wrappedError;
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  extract,
  getInfo,
  getVideoId,
  validateUrl,
  selectPreferredAudioFormat,
  summarizeError
};
