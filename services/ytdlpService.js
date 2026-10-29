const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { YOUTUBE_DL_PATH } = require('yt-dlp-exec/src/constants');
const ffmpegStaticPath = require('ffmpeg-static');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const MAX_JSON_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_RECENT_RUNS = 30;

const runtimeState = {
  activeProcesses: new Map(),
  completedRuns: [],
  totals: {
    invocations: 0,
    successes: 0,
    failures: 0,
    cancellations: 0,
    timeouts: 0,
    processMs: 0,
    parseMs: 0,
    formatMs: 0
  },
  lastError: null,
  lastVersion: null,
  versionCheckedAt: null
};

class YtDlpError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'YtDlpError';
    this.code = code;
    Object.assign(this, details);
  }
}

function uniquePaths(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate || typeof candidate !== 'string') return false;
    const normalized = path.normalize(candidate);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveAsarUnpackedPath(candidatePath) {
  if (!candidatePath) return candidatePath;
  return candidatePath.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1');
}

function getResourceCandidates(packageName, fileName) {
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (!resourcesPath) return [];

  return [
    path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', packageName, fileName),
    path.join(resourcesPath, 'node_modules', packageName, fileName),
    path.join(resourcesPath, packageName, fileName)
  ];
}

function resolveExistingPath(candidates) {
  const normalizedCandidates = uniquePaths(candidates);
  return normalizedCandidates.find(candidate => {
    try {
      return fs.existsSync(candidate);
    } catch (error) {
      return false;
    }
  }) || normalizedCandidates[0] || null;
}

function getYtDlpPath() {
  const binaryName = path.basename(YOUTUBE_DL_PATH || (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'));
  return resolveExistingPath([
    resolveAsarUnpackedPath(YOUTUBE_DL_PATH),
    YOUTUBE_DL_PATH,
    ...getResourceCandidates('yt-dlp-exec', path.join('bin', binaryName)),
    path.join(__dirname, '..', 'node_modules', 'yt-dlp-exec', 'bin', binaryName)
  ]);
}

function getFfmpegPath() {
  const binaryName = path.basename(ffmpegStaticPath || (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  return resolveExistingPath([
    resolveAsarUnpackedPath(ffmpegStaticPath),
    ffmpegStaticPath,
    ...getResourceCandidates('ffmpeg-static', binaryName),
    path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', binaryName)
  ]);
}

function getQualityLabel(value) {
  const labels = {
    low: 'Baja (128kbps)',
    medium: 'Media (256kbps)',
    high: 'Alta (mejor disponible)',
    lossless: 'Mejor disponible sin conversión'
  };
  return labels[value] || value || 'Desconocida';
}

function normalizeTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(numeric)));
}

function getManualAudioFormatId(value) {
  const candidate = String(value || '').trim();
  // An itag/format id is enough for the UI's manual selector. Do not pass an
  // arbitrary expression received from the renderer to yt-dlp.
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(candidate) ? candidate : null;
}

function getPreferredCodecSelector(value) {
  const codec = String(value || 'auto').toLowerCase();
  const selectors = {
    aac: '[acodec^=mp4a]',
    opus: '[acodec^=opus]',
    mp3: '[acodec^=mp3]',
    vorbis: '[acodec^=vorbis]',
    flac: '[acodec^=flac]'
  };
  return selectors[codec] || '';
}

function resolveJsRuntimePath(candidate) {
  const raw = String(candidate || '').trim();
  if (!raw || !path.isAbsolute(raw)) return null;
  try {
    const resolved = fs.realpathSync(raw);
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch (error) {
    return null;
  }
}

function buildAudioFormatSelector(quality = 'medium', manualFormatId = null, preferredCodec = 'auto') {
  // Chromium reproduce AAC/M4A y Opus/WebM sin conversión. El selector deja a
  // yt-dlp elegir una fuente real; la selección posterior solamente normaliza
  // la metadata que devuelve esa misma invocación.
  const manual = getManualAudioFormatId(manualFormatId);
  if (manual) return manual;
  const preferred = getPreferredCodecSelector(preferredCodec);
  const preferredLow = preferred ? `bestaudio${preferred}[abr<=128]/bestaudio${preferred}/` : '';
  const preferredBalanced = preferred ? `bestaudio${preferred}[abr<=256]/bestaudio${preferred}/` : '';
  const preferredBest = preferred ? `bestaudio${preferred}/` : '';
  if (quality === 'low') {
    return `${preferredLow}bestaudio[acodec^=mp4a][abr<=128]/bestaudio[ext=m4a][abr<=128]/bestaudio[abr<=128]/bestaudio/best`;
  }
  if (quality === 'high' || quality === 'lossless' || quality === 'best') {
    return `${preferredBest}bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio/best`;
  }
  return `${preferredBalanced}bestaudio[acodec^=mp4a][abr<=256]/bestaudio[ext=m4a][abr<=256]/bestaudio[abr<=256]/bestaudio/best`;
}

function getBaseArguments({ noPlaylist = true, formatSelector = null, jsRuntimePath = null } = {}) {
  const args = [
    '--ignore-config',
    '--no-warnings',
    '--no-progress',
    '--dump-single-json',
    '--skip-download'
  ];

  if (noPlaylist) args.push('--no-playlist');
  if (formatSelector) args.push('--format', formatSelector);
  const runtimePath = resolveJsRuntimePath(jsRuntimePath);
  if (runtimePath) args.push('--js-runtimes', `node:${runtimePath}`);
  return args;
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'<>\])}]+/gi, '[URL privada]')
    .replace(/\b(cookie|authorization|x-goog-[\w-]+)\s*[:=]\s*[^\s,;]+/gi, '$1=[redactado]');
}

function summarizeError(error) {
  if (!error) return 'Error desconocido';
  const stderr = redactSensitiveText(error.stderr).trim();
  const stdout = redactSensitiveText(error.stdout).trim();
  const message = redactSensitiveText(error.shortMessage || error.message).trim();
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

function selectPreferredAudioFormat(formats = [], quality = 'medium', preferredCodec = 'auto') {
  const audioOnlyFormats = formats.filter(isAudioFormat);
  const playableFormats = audioOnlyFormats.length
    ? audioOnlyFormats
    : formats.filter(format => format && format.url && String(format.acodec || '').toLowerCase() !== 'none');

  if (!playableFormats.length) return null;

  const preferredSelector = getPreferredCodecSelector(preferredCodec);
  const preferredPrefix = preferredSelector.match(/^\[acodec\^=([^\]]+)\]$/)?.[1] || '';
  const preferredFormats = preferredPrefix
    ? playableFormats.filter(format => String(format.acodec || '').toLowerCase().startsWith(preferredPrefix))
    : [];
  const candidates = preferredFormats.length ? preferredFormats : playableFormats;

  const requestedQuality = quality || 'medium';
  const sortedFormats = [...candidates].sort((a, b) => {
    const containerDiff = getContainerPriority(b) - getContainerPriority(a);
    if (containerDiff !== 0) return containerDiff;
    return getFormatBitrate(b) - getFormatBitrate(a);
  });

  if (requestedQuality === 'high' || requestedQuality === 'lossless' || requestedQuality === 'best') {
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
      codec: selectedFormat.acodec || null,
      effectiveBitrate: getFormatBitrate(selectedFormat) || null,
      formatId: selectedFormat.format_id || selectedFormat.id || null
    }
  };
}

function appendBoundedChunk(chunks, currentLength, chunk, limit) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (currentLength + buffer.length > limit) return null;
  chunks.push(buffer);
  return currentLength + buffer.length;
}

function createProcessError(code, message, details = {}) {
  return new YtDlpError(code, message, details);
}

function registerRun(summary) {
  runtimeState.completedRuns.push(summary);
  if (runtimeState.completedRuns.length > MAX_RECENT_RUNS) runtimeState.completedRuns.shift();
}

function trackCompletedRun(result = {}) {
  runtimeState.totals.processMs += Number(result.processMs || 0);
  runtimeState.totals.parseMs += Number(result.parseMs || 0);
  runtimeState.totals.formatMs += Number(result.formatMs || 0);

  if (result.ok) runtimeState.totals.successes += 1;
  else runtimeState.totals.failures += 1;
  if (result.code === 'ABORTED') runtimeState.totals.cancellations += 1;
  if (result.code === 'TIMEOUT') runtimeState.totals.timeouts += 1;

  if (!result.ok) runtimeState.lastError = {
    at: Date.now(),
    code: result.code || 'YT_DLP_ERROR',
    message: String(result.message || 'yt-dlp falló').slice(0, 500)
  };

  registerRun({
    at: Date.now(),
    ok: !!result.ok,
    code: result.code || null,
    processMs: Number(result.processMs || 0),
    parseMs: Number(result.parseMs || 0),
    formatMs: Number(result.formatMs || 0),
    totalMs: Number(result.totalMs || 0),
    stdoutBytes: Number(result.stdoutBytes || 0),
    stderrBytes: Number(result.stderrBytes || 0)
  });
}

function getSanitizedRequestId(options = {}) {
  const candidate = String(options.requestId || `yt-dlp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return candidate.slice(0, 128);
}

function runYtDlpJson(videoUrl, args, options = {}) {
  const binaryPath = getYtDlpPath();
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const requestId = getSanitizedRequestId(options);
  const startedAt = Date.now();

  if (!binaryPath || !fs.existsSync(binaryPath)) {
    const error = createProcessError('BINARY_NOT_FOUND', 'No se encontró el ejecutable de yt-dlp empaquetado', {
      executable: binaryPath || null
    });
    trackCompletedRun({ ok: false, code: error.code, message: error.message, totalMs: Date.now() - startedAt });
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let outputExceeded = false;
    let stdoutLength = 0;
    let stderrLength = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    let timeout = null;
    let killTimer = null;
    const processStartedAt = Date.now();

    const complete = (error, value, details = {}) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      runtimeState.activeProcesses.delete(requestId);

      const totalMs = Date.now() - startedAt;
      const runDetails = {
        ok: !error,
        code: error?.code || null,
        message: error?.message || null,
        processMs: details.processMs || (Date.now() - processStartedAt),
        parseMs: details.parseMs || 0,
        formatMs: details.formatMs || 0,
        totalMs,
        stdoutBytes: stdoutLength,
        stderrBytes: stderrLength
      };
      trackCompletedRun(runDetails);

      if (error) {
        error.metrics = {
          processMs: runDetails.processMs,
          parseMs: runDetails.parseMs,
          formatMs: runDetails.formatMs,
          totalMs: runDetails.totalMs,
          stdoutBytes: stdoutLength,
          stderrBytes: stderrLength
        };
        reject(error);
      } else {
        resolve({ value, metrics: runDetails });
      }
    };

    const stopChild = () => {
      if (!child || child.killed) return;
      try { child.kill(); } catch (error) {}
      killTimer = setTimeout(() => {
        if (child && !child.killed) {
          try { child.kill('SIGKILL'); } catch (error) {}
        }
      }, 1000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    };

    const onAbort = () => {
      aborted = true;
      stopChild();
    };

    if (options.signal?.aborted) {
      const error = createProcessError('ABORTED', 'La resolución de yt-dlp fue cancelada');
      complete(error);
      return;
    }

    try {
      // Nunca se usa una cadena de shell: URL y argumentos se pasan separados.
      child = spawn(binaryPath, [...args, '--', String(videoUrl)], {
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8'
        }
      });
    } catch (spawnError) {
      complete(createProcessError('SPAWN_FAILED', summarizeError(spawnError), { cause: spawnError }));
      return;
    }

    runtimeState.totals.invocations += 1;
    runtimeState.activeProcesses.set(requestId, {
      startedAt,
      command: 'json-resolution'
    });

    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, timeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();

    child.stdout.on('data', (chunk) => {
      const nextLength = appendBoundedChunk(stdoutChunks, stdoutLength, chunk, MAX_JSON_OUTPUT_BYTES);
      if (nextLength === null) {
        outputExceeded = true;
        stopChild();
        return;
      }
      stdoutLength = nextLength;
    });

    child.stderr.on('data', (chunk) => {
      const nextLength = appendBoundedChunk(stderrChunks, stderrLength, chunk, MAX_STDERR_BYTES);
      if (nextLength !== null) stderrLength = nextLength;
    });

    child.once('error', (spawnError) => {
      complete(createProcessError('SPAWN_FAILED', summarizeError(spawnError), { cause: spawnError }));
    });

    child.once('close', (exitCode, signal) => {
      const processMs = Date.now() - processStartedAt;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const safeStderr = redactSensitiveText(stderr);

      if (aborted) {
        complete(createProcessError('ABORTED', 'La resolución de yt-dlp fue cancelada', {
          exitCode,
          signal,
          stderr: safeStderr
        }), null, { processMs });
        return;
      }
      if (timedOut) {
        complete(createProcessError('TIMEOUT', `yt-dlp superó el tiempo límite de ${Math.round(timeoutMs / 1000)} segundos`, {
          exitCode,
          signal,
          stderr: safeStderr,
          timedOut: true
        }), null, { processMs });
        return;
      }
      if (outputExceeded) {
        complete(createProcessError('OUTPUT_LIMIT', 'yt-dlp produjo demasiada salida estructurada', {
          exitCode,
          signal,
          stderr: safeStderr
        }), null, { processMs });
        return;
      }
      if (exitCode !== 0) {
        complete(createProcessError('YT_DLP_EXIT', summarizeError({ stderr, stdout, message: `yt-dlp terminó con código ${exitCode}` }), {
          exitCode,
          signal,
          stderr: safeStderr
        }), null, { processMs });
        return;
      }

      const parseStartedAt = Date.now();
      try {
        if (!stdout) throw new Error('yt-dlp no devolvió JSON');
        const json = JSON.parse(stdout);
        complete(null, json, {
          processMs,
          parseMs: Date.now() - parseStartedAt
        });
      } catch (parseError) {
        complete(createProcessError('INVALID_JSON', 'yt-dlp devolvió una respuesta JSON inválida', {
          cause: parseError,
          stderr: safeStderr
        }), null, {
          processMs,
          parseMs: Date.now() - parseStartedAt
        });
      }
    });
  });
}

function findFormatById(formats, formatId) {
  if (!formatId) return null;
  const target = String(formatId);
  return formats.find(format => String(format?.format_id || format?.id || '') === target) || null;
}

function getRequestedFormat(info = {}) {
  const requested = Array.isArray(info.requested_downloads) ? info.requested_downloads[0] : null;
  if (requested?.url) return requested;
  if (Array.isArray(info.requested_formats)) {
    return info.requested_formats.find(format => format?.url && String(format.vcodec || '').toLowerCase() === 'none')
      || info.requested_formats.find(format => format?.url)
      || null;
  }
  return null;
}

function getResolvedAudioFormat(info = {}, quality = 'medium', preferredCodec = 'auto') {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const requested = getRequestedFormat(info);
  const resolvedId = requested?.format_id || info.format_id || info.format?.format_id;
  const fromId = findFormatById(formats, resolvedId);
  const selected = requested || fromId || selectPreferredAudioFormat(formats, quality, preferredCodec);

  if (!selected) return null;
  if (selected.url) return selected;
  if (info.url) return { ...selected, url: info.url };
  return null;
}

function normalizeExpiry(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const milliseconds = number < 1e12 ? number * 1000 : number;
  return milliseconds > Date.now() ? milliseconds : null;
}

function getUrlExpiry(info = {}, selectedFormat = {}, audioUrl = '') {
  const candidates = [
    selectedFormat.url_expiry,
    selectedFormat.expiry,
    info.url_expiry,
    info.expiry,
    info.expires
  ];

  for (const candidate of candidates) {
    const expiration = normalizeExpiry(candidate);
    if (expiration) return expiration;
  }

  try {
    const parsed = new URL(audioUrl);
    return normalizeExpiry(parsed.searchParams.get('expire') || parsed.searchParams.get('expires'));
  } catch (error) {
    return null;
  }
}

function getProviderName(info = {}) {
  const raw = String(info.extractor_key || info.extractor || 'youtube').toLowerCase();
  return raw.includes('youtube') ? 'youtube' : raw.slice(0, 80) || 'provider';
}

function mergeHttpHeaders(info = {}, selectedFormat = {}) {
  return {
    ...(info.http_headers && typeof info.http_headers === 'object' ? info.http_headers : {}),
    ...(selectedFormat.http_headers && typeof selectedFormat.http_headers === 'object' ? selectedFormat.http_headers : {})
  };
}

async function getInfo(videoUrl, options = {}) {
  const formatSelector = options.formatSelector || buildAudioFormatSelector(options.quality || 'medium', options.manualFormatId, options.preferredCodec);
  const { value } = await runYtDlpJson(videoUrl, getBaseArguments({
    noPlaylist: options.noPlaylist !== false,
    formatSelector,
    jsRuntimePath: options.jsRuntimePath
  }), options);
  return value;
}

async function extract(videoUrl, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  try {
    emitProgress(options, {
      step: 'metadata',
      message: 'yt-dlp: obteniendo metadata y URL de audio en una sola ejecución'
    });

    const selector = options.formatSelector || buildAudioFormatSelector(options.quality || 'medium', options.manualFormatId, options.preferredCodec);
    const { value: info, metrics } = await runYtDlpJson(videoUrl, getBaseArguments({
      noPlaylist: true,
      formatSelector: selector,
      jsRuntimePath: options.jsRuntimePath
    }), { ...options, timeoutMs });

    if (info?._type === 'playlist') {
      throw new YtDlpError('PLAYLIST_NOT_TRACK', 'La URL apunta a una playlist, no a una pista concreta');
    }

    emitProgress(options, {
      step: 'formats',
      formatsCount: Array.isArray(info.formats) ? info.formats.length : 0,
      message: 'yt-dlp: normalizando formato de audio reproducible'
    });
    const formatStartedAt = Date.now();
    const selectedFormat = getResolvedAudioFormat(info, options.quality, options.preferredCodec);
    const formatMs = Date.now() - formatStartedAt;
    if (!selectedFormat?.url) {
      throw new YtDlpError('AUDIO_URL_MISSING', 'yt-dlp no devolvió una URL directa de audio en la respuesta estructurada');
    }

    const metadata = buildMetadata(info, videoUrl, options.quality, selectedFormat);
    const extractionMs = Date.now() - startedAt;
    const provider = getProviderName(info);
    const expiresAt = getUrlExpiry(info, selectedFormat, selectedFormat.url);
    const extractionMetrics = {
      processMs: metrics.processMs,
      parseMs: metrics.parseMs,
      formatMs,
      totalMs: extractionMs,
      stdoutBytes: metrics.stdoutBytes,
      stderrBytes: metrics.stderrBytes
    };
    metadata.streamingProfile.extractionMs = extractionMs;
    metadata.streamingProfile.processMs = extractionMetrics.processMs;
    metadata.streamingProfile.parseMs = extractionMetrics.parseMs;
    metadata.streamingProfile.formatMs = extractionMetrics.formatMs;
    metadata.streamingProfile.provider = provider;

    // `trackCompletedRun` occurs when the process closes; register the
    // selection stage independently so diagnostics separates process/parse
    // from JavaScript format work without an extra yt-dlp invocation.
    runtimeState.totals.formatMs += formatMs;
    const lastRun = runtimeState.completedRuns[runtimeState.completedRuns.length - 1];
    if (lastRun) lastRun.formatMs = formatMs;

    emitProgress(options, {
      step: 'ready',
      formatId: selectedFormat.format_id || selectedFormat.id || null,
      elapsedMs: extractionMs,
      metrics: extractionMetrics,
      message: 'yt-dlp: audio listo'
    });

    return {
      extractor: 'yt-dlp',
      audioUrl: selectedFormat.url,
      metadata,
      formats: normalizeFormats(info.formats || []),
      selectedFormat: normalizeFormat(selectedFormat),
      httpHeaders: mergeHttpHeaders(info, selectedFormat),
      sourcePolicy: {
        type: 'provider-stream',
        provider,
        requiresProxy: true,
        supportsRange: true,
        ephemeralUrl: true,
        expiresAt,
        allowPersistentCache: true,
        persistMedia: true,
        mediaPersistence: 'user-controlled'
      },
      extractionMs,
      metrics: extractionMetrics
    };
  } catch (error) {
    const wrappedError = error instanceof YtDlpError
      ? error
      : new YtDlpError('YT_DLP_ERROR', summarizeError(error), { cause: error });
    wrappedError.extractor = 'yt-dlp';
    throw wrappedError;
  }
}

async function getPlaylist(videoUrl, options = {}) {
  try {
    const args = getBaseArguments({ noPlaylist: false });
    args.push('--flat-playlist', '--yes-playlist');
    const { value: info } = await runYtDlpJson(videoUrl, args, {
      ...options,
      timeoutMs: normalizeTimeout(options.timeoutMs)
    });
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
    const wrappedError = error instanceof YtDlpError
      ? error
      : new YtDlpError('YT_DLP_ERROR', summarizeError(error), { cause: error });
    wrappedError.extractor = 'yt-dlp';
    throw wrappedError;
  }
}

async function getPlaylistDetails(videoUrl, options = {}) {
  const args = getBaseArguments({ noPlaylist: false });
  args.push('--flat-playlist', '--yes-playlist', '--ignore-errors');
  const { value: info } = await runYtDlpJson(videoUrl, args, { ...options, timeoutMs: 120000 });
  const entries = Array.isArray(info?.entries) ? info.entries : [];
  const tracks = entries.map(entry => ({ id: entry?.id || '', title: entry?.title || 'Video no disponible',
    unavailable: !entry?.id || ['private', 'premium_only', 'subscriber_only', 'needs_auth'].includes(entry?.availability) || /\[(?:Private|Deleted) video\]/i.test(entry?.title || ''),
    artist: entry?.uploader || entry?.channel || 'YouTube', duration: Number(entry?.duration) || 0,
    thumbnail: entry?.thumbnail || '', url: entry?.id ? `https://www.youtube.com/watch?v=${entry.id}` : '' }));
  const expected = Number(info?.playlist_count || info?.entry_count) || entries.length;
  return { name: info?.title || 'Playlist de YouTube', tracks, expected,
    sourceIncomplete: tracks.length < expected, completenessUnknown: !info?.playlist_count && !info?.entry_count };
}

async function getYtDlpVersion(options = {}) {
  if (runtimeState.lastVersion && options.force !== true) return runtimeState.lastVersion;

  const binaryPath = getYtDlpPath();
  if (!binaryPath || !fs.existsSync(binaryPath)) return null;

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (version = null) => {
      if (settled) return;
      settled = true;
      runtimeState.lastVersion = version;
      runtimeState.versionCheckedAt = Date.now();
      resolve(version);
    };
    let child;
    try {
      child = spawn(binaryPath, ['--version'], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (error) {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch (error) {}
      finish(null);
    }, normalizeTimeout(options.timeoutMs, 5000));
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', chunk => {
      if (output.length < 256) output += chunk.toString('utf8');
    });
    child.once('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? output.trim().slice(0, 128) || null : null);
    });
  });
}

function getRuntimeDiagnostics(options = {}) {
  const completed = runtimeState.completedRuns;
  const divisor = Math.max(1, runtimeState.totals.successes + runtimeState.totals.failures);
  const ytDlpPath = getYtDlpPath();
  const ffmpegPath = getFfmpegPath();
  const jsRuntimePath = resolveJsRuntimePath(options.jsRuntimePath);

  return {
    engine: 'yt-dlp',
    ytDlp: {
      path: ytDlpPath,
      available: !!ytDlpPath && fs.existsSync(ytDlpPath),
      version: runtimeState.lastVersion,
      versionCheckedAt: runtimeState.versionCheckedAt
    },
    ffmpeg: {
      path: ffmpegPath,
      available: !!ffmpegPath && fs.existsSync(ffmpegPath),
      requiredForStreaming: false
    },
    ejs: {
      configured: !!jsRuntimePath,
      runtime: jsRuntimePath ? 'node' : null,
      message: jsRuntimePath
        ? 'Runtime Node externo verificado para EJS.'
        : 'No se configuró un runtime EJS externo. yt-dlp puede requerir uno actualizado para algunos cambios de YouTube.'
    },
    activeProcesses: runtimeState.activeProcesses.size,
    totals: {
      ...runtimeState.totals,
      averageProcessMs: Math.round(runtimeState.totals.processMs / divisor),
      averageParseMs: Math.round(runtimeState.totals.parseMs / divisor),
      averageFormatMs: Math.round(runtimeState.totals.formatMs / divisor)
    },
    recentRuns: completed.map(run => ({ ...run })),
    lastError: runtimeState.lastError ? { ...runtimeState.lastError } : null
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  YtDlpError,
  extract,
  getPlaylist,
  getPlaylistDetails,
  getInfo,
  getYtDlpPath,
  getFfmpegPath,
  getYtDlpVersion,
  getRuntimeDiagnostics,
  buildAudioFormatSelector,
  resolveJsRuntimePath,
  selectPreferredAudioFormat,
  summarizeError
};
