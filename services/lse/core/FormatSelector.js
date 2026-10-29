const { getQualityLabel } = require('../config/defaultSettings');

const MIME_TO_CONTAINER = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm'
};

const CODEC_RANK = {
  opus: 7,
  aac: 6,
  mp4a: 6,
  vorbis: 5,
  mp3: 4,
  flac: 3,
  wav: 2,
  unknown: 1
};

function normalizeMimeType(value = '') {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function inferContainer(url = '', mimeType = '') {
  const normalizedMime = normalizeMimeType(mimeType);
  if (MIME_TO_CONTAINER[normalizedMime]) return MIME_TO_CONTAINER[normalizedMime];

  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1] === 'oga' ? 'ogg' : match[1];
  } catch (error) {}

  return 'unknown';
}

function inferCodec(container = '', mimeType = '') {
  const normalized = `${container} ${normalizeMimeType(mimeType)}`.toLowerCase();
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('aac') || normalized.includes('m4a') || normalized.includes('mp4')) return 'aac';
  if (normalized.includes('vorbis') || normalized.includes('ogg')) return 'vorbis';
  if (normalized.includes('mp3') || normalized.includes('mpeg')) return 'mp3';
  if (normalized.includes('flac')) return 'flac';
  if (normalized.includes('wav')) return 'wav';
  return 'unknown';
}

function normalizeFormat(format = {}) {
  const mimeType = normalizeMimeType(format.mimeType || format.contentType);
  const container = String(format.container || format.ext || inferContainer(format.url, mimeType)).toLowerCase();
  const codec = String(format.acodec || format.codec || inferCodec(container, mimeType)).toLowerCase();
  const bitrate = Number(format.audioBitrate || format.bitrate || 0);

  return {
    id: format.id || format.formatId || `${container}:${codec}`,
    container,
    ext: container,
    mimeType: mimeType || null,
    acodec: codec === 'unknown' ? null : codec,
    vcodec: format.vcodec || 'none',
    audioBitrate: Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : null,
    sampleRate: Number(format.sampleRate || 0) || null,
    filesize: Number(format.filesize || format.contentLength || 0) || null,
    protocol: format.protocol || 'progressive',
    note: format.note || null,
    playable: format.playable !== false
  };
}

function targetBitrate(quality) {
  if (quality === 'low') return 128;
  if (quality === 'medium') return 192;
  if (quality === 'high') return 320;
  return null;
}

function selectFormat(formats = [], options = {}) {
  const quality = options.quality || 'auto';
  const preferredCodec = options.preferredCodec || 'auto';
  const candidates = formats.map(normalizeFormat).filter(format => format.playable);
  if (!candidates.length) return null;

  return [...candidates].sort((left, right) => {
    const compare = candidate => {
      const codecScore = preferredCodec !== 'auto' && candidate.acodec === preferredCodec
        ? 10000
        : (CODEC_RANK[candidate.acodec] || CODEC_RANK.unknown) * 100;
      const bitrate = candidate.audioBitrate || 0;
      if (quality === 'best') return codecScore + bitrate;
      const target = targetBitrate(quality);
      const distance = target === null ? 0 : Math.abs(bitrate - target);
      const overshoot = quality === 'low' && bitrate > 160 ? 80 : 0;
      return codecScore - distance - overshoot;
    };

    return compare(right) - compare(left);
  })[0];
}

function buildStreamingProfile(format, options = {}) {
  const selected = normalizeFormat(format || {});
  const requested = options.quality || 'auto';
  return {
    source: options.source || 'network',
    extractor: options.extractor || 'lse',
    requested,
    requestedLabel: getQualityLabel(requested),
    container: selected.container,
    effectiveBitrate: selected.audioBitrate,
    codec: selected.acodec,
    sampleRate: selected.sampleRate,
    formatId: selected.id,
    protocol: selected.protocol
  };
}

module.exports = {
  normalizeMimeType,
  inferContainer,
  inferCodec,
  normalizeFormat,
  selectFormat,
  buildStreamingProfile,
  getQualityLabel
};
