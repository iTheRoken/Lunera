'use strict';

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function containerOf(format = {}) {
  return String(format.ext || format.audio_ext || format.container || '').toLowerCase().replace(/^audio\//, '');
}

function codecOf(format = {}) {
  return String(format.acodec || format.audio_codec || '').toLowerCase();
}

function bitrateOf(format = {}) {
  return Math.round(number(format.abr || format.audioBitrate || format.tbr || 0));
}

function isDirectAudio(format = {}) {
  const codec = codecOf(format);
  const videoCodec = String(format.vcodec || '').toLowerCase();
  return !!format.url && codec && codec !== 'none' && (!videoCodec || videoCodec === 'none');
}

function targetBitrate(quality) {
  if (quality === 'low') return 96;
  if (quality === 'best') return Number.POSITIVE_INFINITY;
  if (quality === 'manual') return 160;
  return 128;
}

function containerScore(container) {
  if (container === 'm4a' || container === 'm4b') return 62;
  if (container === 'mp4') return 58;
  if (container === 'webm') return 55;
  if (container === 'mp3') return 50;
  if (container === 'ogg' || container === 'opus') return 47;
  if (container === 'aac') return 45;
  return 20;
}

function codecScore(codec) {
  if (codec.includes('mp4a') || codec.includes('aac')) return 62;
  if (codec.includes('opus')) return 60;
  if (codec.includes('mp3')) return 52;
  if (codec.includes('vorbis')) return 46;
  if (codec.includes('flac')) return 42;
  return 18;
}

function matchesPreferredCodec(codec, preferredCodec) {
  const codecName = String(codec || '').toLowerCase();
  const preferred = String(preferredCodec || 'auto').toLowerCase();
  if (preferred === 'aac') return codecName.includes('mp4a') || codecName.includes('aac');
  if (preferred === 'opus') return codecName.includes('opus');
  if (preferred === 'mp3') return codecName.includes('mp3');
  if (preferred === 'vorbis') return codecName.includes('vorbis');
  if (preferred === 'flac') return codecName.includes('flac');
  return false;
}

function normalizeTurboFormat(format = {}) {
  return {
    id: format.format_id || format.id || null,
    format_id: format.format_id || format.id || null,
    container: containerOf(format) || 'unknown',
    ext: containerOf(format) || 'unknown',
    acodec: format.acodec || format.audio_codec || null,
    vcodec: format.vcodec || 'none',
    audioBitrate: bitrateOf(format) || null,
    abr: bitrateOf(format) || null,
    filesize: format.filesize || format.filesize_approx || null,
    protocol: format.protocol || null,
    note: format.format_note || format.resolution || null,
    requiresTranscode: false
  };
}

function selectTurboFormat(formats = [], options = {}) {
  const quality = options.quality === 'medium' ? 'balanced' : (options.quality || 'auto');
  const manualFormatId = String(options.formatId || options.manualFormatId || '');
  const preferredCodec = String(options.preferredCodec || 'auto').toLowerCase();
  const candidates = (Array.isArray(formats) ? formats : []).filter(isDirectAudio);
  if (!candidates.length) return null;

  if (quality === 'manual' && manualFormatId) {
    const manuallySelected = candidates.find(format => String(format.format_id || format.id) === manualFormatId);
    if (manuallySelected) return { ...manuallySelected, requiresTranscode: false };
  }

  const target = targetBitrate(quality);
  const sorted = [...candidates].sort((left, right) => {
    const leftBitrate = bitrateOf(left);
    const rightBitrate = bitrateOf(right);
    const preferredDifference = Number(matchesPreferredCodec(codecOf(right), preferredCodec))
      - Number(matchesPreferredCodec(codecOf(left), preferredCodec));
    if (preferredDifference !== 0) return preferredDifference;

    if (quality === 'best') {
      const bitrateDifference = rightBitrate - leftBitrate;
      if (bitrateDifference !== 0) return bitrateDifference;
    } else {
      const leftDistance = leftBitrate ? Math.abs(leftBitrate - target) : target;
      const rightDistance = rightBitrate ? Math.abs(rightBitrate - target) : target;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      if (quality === 'low' && leftBitrate !== rightBitrate) return leftBitrate - rightBitrate;
    }

    const codecDifference = codecScore(codecOf(right)) - codecScore(codecOf(left));
    if (codecDifference !== 0) return codecDifference;
    const containerDifference = containerScore(containerOf(right)) - containerScore(containerOf(left));
    if (containerDifference !== 0) return containerDifference;
    return rightBitrate - leftBitrate;
  });

  return { ...sorted[0], requiresTranscode: false };
}

function getUrlExpiry(url, now = Date.now()) {
  try {
    const parsed = new URL(String(url));
    const values = ['expire', 'expires', 'expiration'];
    for (const key of values) {
      const value = Number(parsed.searchParams.get(key));
      if (!Number.isFinite(value) || value <= 0) continue;
      // Providers commonly use epoch seconds; tolerate epoch milliseconds.
      const timestamp = value < 10_000_000_000 ? value * 1000 : value;
      if (timestamp > now) return timestamp;
    }
  } catch (error) {}
  return null;
}

module.exports = {
  selectTurboFormat,
  normalizeTurboFormat,
  containerOf,
  codecOf,
  bitrateOf,
  getUrlExpiry
};

