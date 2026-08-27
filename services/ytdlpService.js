const ytDlpExec = require('yt-dlp-exec');
const { YOUTUBE_DL_PATH } = require('yt-dlp-exec/src/constants');
const ffmpegStaticPath = require('ffmpeg-static');

const DEFAULT_TIMEOUT_MS = 30000;

function resolveAsarUnpackedPath(candidatePath) {
  if (!candidatePath) return candidatePath;
  return candidatePath.replace('app.asar', 'app.asar.unpacked');
}

function getYtDlpPath() {
  return resolveAsarUnpackedPath(YOUTUBE_DL_PATH);
}

function getFfmpegPath() {
  return resolveAsarUnpackedPath(ffmpegStaticPath);
}

const ytDlp = ytDlpExec.create(getYtDlpPath());

function getExecOptions(timeoutMs = DEFAULT_TIMEOUT_MS) {
  return {
    timeout: timeoutMs,
    cleanup: true,
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8'
    }
  };
}

function getQualityLabel(value) {
  const labels = {
    low: 'Baja (128kbps)',
    medium: 'Media (256kbps)',
    high: 'Alta (320kbps)',
    lossless: 'Sin pérdida'
  };
  return labels[value] || value || 'Desconocida';
}

function getBaseFlags({ noPlaylist = true } = {}) {
  const flags = {
    noWarnings: true,
    noProgress: true,
    noCheckCertificates: true,
    socketTimeout: 15,
    retries: 1,
    ffmpegLocation: getFfmpegPath()
  };

  if (noPlaylist) {
    flags.noPlaylist = true;
  }

  return flags;
}

function summarizeError(error) {
  if (!error) return 'Error desconocido';
  if (error.timedOut) return 'yt-dlp superó el tiempo límite';

  const stderr = String(error.stderr || '').trim();
  const stdout = String(error.stdout || '').trim();
  const message = String(error.shortMessage || error.message || '').trim();
  const details = stderr || stdout || message;

  return details
    .replace(/\s+/g, ' ')
    .slice(0, 500) || 'yt-dlp falló sin detalle';
}

function emitProgress(options = {}, event) {
  if (typeof options.onProgress === 'function') {
    options.onProgress(event);
  }
}

function toNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function getFormatBitrate(format = {}) {
  return Math.round(toNumber(format.abr || format.audioBitrate || format.tbr || 0));
}

function getFormatContainer(format = {}) {
  return String(format.ext || format.audio_ext || format.container || 'webm').toLowerCase();
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

function isAudioFormat(format = {}) {
  const acodec = String(format.acodec || '').toLowerCase();
  const vcodec = String(format.vcodec || '').toLowerCase();
  return !!format.url && acodec && acodec !== 'none' && vcodec === 'none';
}

function normalizeFormat(format = {}) {
  return {
    id: format.format_id || format.id || null,
    container: getFormatContainer(format),
    ext: getFormatContainer(format),
    acodec: format.acodec || null,
    vcodec: format.vcodec || null,
    audioBitrate: getFormatBitrate(format) || null,
    filesize: format.filesize || format.filesize_approx || null,
    protocol: format.protocol || null,
    note: format.format_note || format.resolution || null
  };
}

function normalizeFormats(formats = []) {
  return formats
    .filter(format => format && String(format.acodec || '').toLowerCase() !== 'none')
    .map(normalizeFormat);
}

function selectPreferredAudioFormat(formats = [], quality = 'medium') {
  const audioOnlyFormats = formats.filter(isAudioFormat);
  const playableFormats = audioOnlyFormats.length
    ? audioOnlyFormats
    : formats.filter(format => format && format.url && String(format.acodec || '').toLowerCase() !== 'none');

  if (!playableFormats.length) return null;

  const requestedQuality = quality || 'medium';
  const sortedFormats = [...playableFormats].sort((a, b) => {
    const containerDiff = getContainerPriority(b) - getContainerPriority(a);
    if (containerDiff !== 0) return containerDiff;
    return getFormatBitrate(b) - getFormatBitrate(a);
  });

  if (requestedQuality === 'high' || requestedQuality === 'lossless') {
    return sortedFormats.sort((a, b) => {
      const bitrateDiff = getFormatBitrate(b) - getFormatBitrate(a);
      if (bitrateDiff !== 0) return bitrateDiff;
      return getContainerPriority(b) - getContainerPriority(a);
    })[0];
  }

  const targetBitrate = requestedQuality === 'low' ? 128 : 256;
  let bestFormat = sortedFormats[0];
  let bestScore = Number.POSITIVE_INFINITY;

  sortedFormats.forEach(format => {
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

  const sortedThumbnails = [...thumbnails].sort((a, b) => {
    const aScore = toNumber(a.width) * toNumber(a.height);
    const bScore = toNumber(b.width) * toNumber(b.height);
    return bScore - aScore;
  });

  return sortedThumbnails.find(item => item?.url)?.url || '';
}

function buildMetadata(info = {}, videoUrl, requestedQuality, selectedFormat = {}) {
  return {
    id: info.id || info.display_id || '',
    title: info.title || 'Sin título',
    artist: info.artist || info.uploader || info.channel || info.creator || 'Desconocido',
    thumbnail: getBestThumbnail(info.thumbnails) || info.thumbnail || '',
    duration: Math.round(toNumber(info.duration)),
    url: info.webpage_url || videoUrl,
    streamingProfile: {
      source: 'network',
      extractor: 'yt-dlp',
      requested: requestedQuality || 'medium',
      requestedLabel: getQualityLabel(requestedQuality || 'medium'),
      container: getFormatContainer(selectedFormat),
      effectiveBitrate: getFormatBitrate(selectedFormat) || null,
      formatId: selectedFormat.format_id || selectedFormat.id || null
    }
  };
}

async function getInfo(videoUrl, options = {}) {
  const flags = {
    ...getBaseFlags({ noPlaylist: options.noPlaylist !== false }),
    dumpSingleJson: true,
    skipDownload: true
  };

  return ytDlp(videoUrl, flags, getExecOptions(options.timeoutMs));
}

async function getDirectUrl(videoUrl, formatId, options = {}) {
  const flags = {
    ...getBaseFlags({ noPlaylist: true }),
    getUrl: true
  };

  if (formatId) {
    flags.format = formatId;
  }

  const output = await ytDlp(videoUrl, flags, getExecOptions(options.timeoutMs));
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.startsWith('http://') || line.startsWith('https://')) || '';
}

async function extract(videoUrl, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  try {
    emitProgress(options, {
      step: 'metadata',
      message: 'yt-dlp: obteniendo metadata del video'
    });
    const info = await getInfo(videoUrl, { timeoutMs, noPlaylist: true });

    if (info?._type === 'playlist') {
      throw new Error('La URL apunta a una playlist, no a una pista concreta');
    }

    emitProgress(options, {
      step: 'formats',
      formatsCount: Array.isArray(info.formats) ? info.formats.length : 0,
      message: 'yt-dlp: seleccionando formato de audio'
    });
    const selectedFormat = selectPreferredAudioFormat(info.formats || [], options.quality);
    if (!selectedFormat) {
      throw new Error('yt-dlp no encontró formatos de audio reproducibles');
    }

    if (!selectedFormat.url) {
      emitProgress(options, {
        step: 'direct-url',
        formatId: selectedFormat.format_id || selectedFormat.id || null,
        message: 'yt-dlp: resolviendo URL directa de audio'
      });
    }

    const audioUrl = selectedFormat.url || await getDirectUrl(videoUrl, selectedFormat.format_id, { timeoutMs });
    if (!audioUrl) {
      throw new Error('yt-dlp no devolvió una URL directa de audio');
    }

    const metadata = buildMetadata(info, videoUrl, options.quality, selectedFormat);
    metadata.streamingProfile.extractionMs = Date.now() - startedAt;
    emitProgress(options, {
      step: 'ready',
      formatId: selectedFormat.format_id || selectedFormat.id || null,
      elapsedMs: metadata.streamingProfile.extractionMs,
      message: 'yt-dlp: audio listo'
    });

    return {
      extractor: 'yt-dlp',
      audioUrl,
      metadata,
      formats: normalizeFormats(info.formats || []),
      selectedFormat: normalizeFormat(selectedFormat),
      httpHeaders: info.http_headers || selectedFormat.http_headers || {},
      extractionMs: Date.now() - startedAt
    };
  } catch (error) {
    const wrappedError = new Error(summarizeError(error));
    wrappedError.cause = error;
    wrappedError.extractor = 'yt-dlp';
    throw wrappedError;
  }
}

async function getPlaylist(videoUrl, options = {}) {
  try {
    const flags = {
      ...getBaseFlags({ noPlaylist: false }),
      dumpSingleJson: true,
      skipDownload: true,
      flatPlaylist: true,
      yesPlaylist: true
    };
    const info = await ytDlp(videoUrl, flags, getExecOptions(options.timeoutMs || DEFAULT_TIMEOUT_MS));
    const entries = Array.isArray(info?.entries) ? info.entries : [];

    return entries.map(entry => ({
      id: entry.id || entry.url || '',
      title: entry.title || 'Sin título',
      artist: entry.uploader || entry.channel || 'Desconocido',
      duration: Math.round(toNumber(entry.duration)),
      thumbnail: entry.thumbnail || '',
      url: entry.webpage_url || entry.url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : '')
    })).filter(entry => entry.id && entry.url);
  } catch (error) {
    const wrappedError = new Error(summarizeError(error));
    wrappedError.cause = error;
    wrappedError.extractor = 'yt-dlp';
    throw wrappedError;
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  extract,
  getPlaylist,
  getInfo,
  getYtDlpPath,
  getFfmpegPath,
  selectPreferredAudioFormat,
  summarizeError
};
