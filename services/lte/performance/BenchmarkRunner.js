'use strict';

// A small, opt-in benchmark harness for LTE.  It intentionally measures real
// resolver and byte-range work when called by the developer tooling; it does
// not manufacture a score or retain a provider URL in its report.
const http = require('http');
const https = require('https');

const MAX_RUNS = 3;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
const SAFE_REQUEST_HEADERS = new Set(['user-agent', 'accept', 'accept-language', 'referer', 'origin']);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum, fallback) {
  return Math.min(maximum, Math.max(minimum, Math.round(finite(value, fallback))));
}

function sanitizeError(error) {
  return String(error?.message || error || 'Error desconocido')
    .replace(/https?:\/\/[^\s)\]}]+/gi, '[url privada]')
    .replace(/[?&](?:sig|signature|token|expire|authorization)=[^&\s]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function safeHost(rawUrl) {
  try { return new URL(String(rawUrl)).hostname.toLowerCase().slice(0, 253); } catch (error) { return null; }
}

function average(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function percentile(values, value) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((value / 100) * sorted.length) - 1));
  return sorted[index];
}

function snapshotProcessResources() {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    cpuUsage: process.cpuUsage(),
    at: Date.now()
  };
}

function finishResourceSample(start, peakRssBytes) {
  const end = snapshotProcessResources();
  const elapsedMs = Math.max(1, end.at - start.at);
  const cpuMicros = (end.cpuUsage.user - start.cpuUsage.user) + (end.cpuUsage.system - start.cpuUsage.system);
  return {
    // This is process CPU during this serial benchmark sample, not a claim
    // about system-wide CPU use.
    cpuPercent: Math.max(0, Math.round((cpuMicros / (elapsedMs * 1000)) * 1000) / 10),
    rssBeforeBytes: start.rssBytes,
    rssAfterBytes: end.rssBytes,
    peakRssBytes: Math.max(peakRssBytes, end.rssBytes),
    heapUsedBeforeBytes: start.heapUsedBytes,
    heapUsedAfterBytes: end.heapUsedBytes
  };
}

function aggregate(samples = []) {
  const successful = samples.filter(sample => sample.ok);
  const resolution = successful.map(sample => sample.resolutionMs).filter(Number.isFinite);
  const rangeFirstByte = successful.map(sample => sample.rangeFirstByteMs).filter(Number.isFinite);
  const firstByte = successful.map(sample => sample.timeToFirstByteMs).filter(Number.isFinite);
  const cpu = samples.map(sample => sample.resources?.cpuPercent).filter(Number.isFinite);
  const peaks = samples.map(sample => sample.resources?.peakRssBytes).filter(Number.isFinite);
  const resolverProcess = successful.map(sample => sample.resolver?.processMs).filter(Number.isFinite);
  return {
    runs: samples.length,
    successfulRuns: successful.length,
    failedRuns: samples.length - successful.length,
    resolverRuns: samples.length,
    rangeProbes: samples.filter(sample => sample.probe?.skipped !== true).length,
    averageResolutionMs: average(resolution),
    medianResolutionMs: percentile(resolution, 50),
    p95ResolutionMs: percentile(resolution, 95),
    averageRangeFirstByteMs: average(rangeFirstByte),
    medianRangeFirstByteMs: percentile(rangeFirstByte, 50),
    p95RangeFirstByteMs: percentile(rangeFirstByte, 95),
    averageTimeToFirstByteMs: average(firstByte),
    medianTimeToFirstByteMs: percentile(firstByte, 50),
    p95TimeToFirstByteMs: percentile(firstByte, 95),
    averageResolverProcessMs: average(resolverProcess),
    p95ResolverProcessMs: percentile(resolverProcess, 95),
    averageCpuPercent: average(cpu),
    p95CpuPercent: percentile(cpu, 95),
    peakRssBytes: peaks.length ? Math.max(...peaks) : null
  };
}

function createAbortError() {
  const error = new Error('Benchmark LTE cancelado');
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function sanitizeForwardHeaders(headers = {}) {
  const output = {};
  if (!headers || typeof headers !== 'object') return output;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName || '').toLowerCase();
    if (!SAFE_REQUEST_HEADERS.has(name)) continue;
    const value = String(rawValue || '').trim();
    if (!value || value.length > 1024 || /[\r\n]/.test(value)) continue;
    output[name] = value;
  }
  return output;
}

/**
 * Performs a real one-range request without disclosing the signed source URL.
 * It reads at most the first response chunk and aborts the body immediately.
 */
function probeDirectFirstByte(extraction = {}, options = {}) {
  const sourceUrl = String(extraction.audioUrl || '');
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch (error) {
    return Promise.resolve({ ok: false, error: 'La extracciÃ³n no incluyÃ³ una URL de audio vÃ¡lida' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return Promise.resolve({ ok: false, error: 'El recurso de audio no usa HTTP o HTTPS' });
  }
  if (parsed.username || parsed.password) {
    return Promise.resolve({ ok: false, error: 'El recurso de audio no puede incluir credenciales en la URL' });
  }

  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const timeoutMs = clamp(options.timeoutMs, 1_000, 60_000, DEFAULT_TIMEOUT_MS);
  const redirectCount = clamp(options.redirectCount, 0, MAX_REDIRECTS, 0);
  const headers = {
    ...sanitizeForwardHeaders(extraction.httpHeaders),
    range: 'bytes=0-4095'
  };

  return new Promise((resolve) => {
    const startedAt = now();
    let finished = false;
    let request = null;
    let abortListener = null;

    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (options.signal && abortListener) options.signal.removeEventListener('abort', abortListener);
      resolve({ ...value, elapsedMs: Math.max(0, now() - startedAt) });
    };

    const stopRequest = () => {
      try { request?.destroy(createAbortError()); } catch (error) {}
    };

    if (options.signal?.aborted) {
      finish({ ok: false, code: 'ABORTED', error: 'Benchmark LTE cancelado' });
      return;
    }

    abortListener = () => {
      stopRequest();
      finish({ ok: false, code: 'ABORTED', error: 'Benchmark LTE cancelado' });
    };
    options.signal?.addEventListener('abort', abortListener, { once: true });

    const transport = parsed.protocol === 'https:' ? https : http;
    try {
      request = transport.request(parsed, {
        method: 'GET',
        headers,
        timeout: timeoutMs
      }, (response) => {
        const statusCode = Number(response.statusCode || 0);
        const location = response.headers.location;
        if (statusCode >= 300 && statusCode < 400 && location && redirectCount < MAX_REDIRECTS) {
          response.resume();
          let redirectUrl;
          try {
            redirectUrl = new URL(location, parsed).toString();
          } catch (error) {
            finish({ ok: false, statusCode, error: 'El servidor devolviÃ³ una redirecciÃ³n invÃ¡lida' });
            return;
          }
          // Do not expose, cache, or return the redirect location.  The outer
          // timer stays active so the final number includes every real hop.
          probeDirectFirstByte({
            ...extraction,
            audioUrl: redirectUrl
          }, {
            ...options,
            redirectCount: redirectCount + 1,
            now
          }).then(finish);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          finish({ ok: false, statusCode, error: `El servidor devolviÃ³ HTTP ${statusCode || 'desconocido'}` });
          return;
        }

        let received = 0;
        response.once('data', (chunk) => {
          received = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk || ''));
          // Never turn the diagnostic into a download.  The Range header is a
          // hint; destroying here also protects against servers that ignore it.
          response.destroy();
          finish({
            ok: true,
            statusCode,
            receivedBytes: received,
            contentType: String(response.headers['content-type'] || '').slice(0, 120),
            sourceHost: safeHost(sourceUrl)
          });
        });
        response.once('end', () => {
          if (!finished) finish({
            ok: false,
            statusCode,
            error: 'El servidor no enviÃ³ bytes de audio'
          });
        });
        response.once('error', (error) => {
          if (!finished) finish({ ok: false, statusCode, error: sanitizeError(error) });
        });
      });
      request.once('timeout', () => {
        stopRequest();
        finish({ ok: false, code: 'TIMEOUT', error: 'Se agotÃ³ el tiempo de la prueba de primer byte' });
      });
      request.once('error', (error) => {
        if (!finished) finish({ ok: false, error: sanitizeError(error) });
      });
      request.end();
    } catch (error) {
      finish({ ok: false, error: sanitizeError(error) });
    }
  });
}

class BenchmarkRunner {
  constructor(options = {}) {
    this.turboEngine = options.turboEngine || null;
    this.baselineResolver = typeof options.baselineResolver === 'function' ? options.baselineResolver : null;
    this.baselineName = String(options.baselineName || 'referencia').slice(0, 80);
    this.firstByteProbe = typeof options.firstByteProbe === 'function' ? options.firstByteProbe : probeDirectFirstByte;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  async run(videoUrl, options = {}) {
    if (!this.turboEngine || typeof this.turboEngine.resolve !== 'function') {
      throw new Error('LTE no estÃ¡ disponible para ejecutar el benchmark');
    }
    if (!this.baselineResolver) {
      throw new Error('No hay un resolvedor de referencia configurado para el benchmark');
    }
    if (!videoUrl || typeof videoUrl !== 'string') throw new Error('El benchmark necesita una URL de pista vÃ¡lida');

    const runs = clamp(options.runs, 1, MAX_RUNS, 1);
    const quality = String(options.quality || this.turboEngine.getSettings?.().qualityMode || 'auto');
    const timeoutMs = clamp(options.timeoutMs, 1_000, 120_000, DEFAULT_TIMEOUT_MS);
    const measureFirstByte = options.measureFirstByte !== false;
    const manualFormatId = quality === 'manual' ? String(options.manualFormatId || '') : '';
    const startedAt = this.now();
    const samples = { lte: [], baseline: [] };

    for (let index = 0; index < runs; index += 1) {
      assertNotAborted(options.signal);
      // Alternate the order on every run to reduce a simple warm-network bias.
      const order = index % 2 === 0 ? ['baseline', 'lte'] : ['lte', 'baseline'];
      for (const method of order) {
        assertNotAborted(options.signal);
        const sample = await this.runOne(method, videoUrl, {
          quality,
          timeoutMs,
          signal: options.signal,
          measureFirstByte,
          manualFormatId,
          preferredCodec: options.preferredCodec,
          run: index + 1
        });
        samples[method].push(sample);
        assertNotAborted(options.signal);
      }
    }

    const summary = {
      lte: aggregate(samples.lte),
      baseline: aggregate(samples.baseline)
    };
    const lteTtfb = summary.lte.averageTimeToFirstByteMs;
    const baselineTtfb = summary.baseline.averageTimeToFirstByteMs;
    const comparison = Number.isFinite(lteTtfb) && Number.isFinite(baselineTtfb)
      ? {
          averageTimeToFirstByteDeltaMs: lteTtfb - baselineTtfb,
          // Positive means LTE measured lower time-to-first-byte; null means
          // there was not enough successful, comparable data to make a claim.
          lteFasterByPercent: baselineTtfb > 0
            ? Math.round(((baselineTtfb - lteTtfb) / baselineTtfb) * 1000) / 10
            : null
        }
      : { averageTimeToFirstByteDeltaMs: null, lteFasterByPercent: null };

    const scenarios = options.includeReuseScenarios === true
      ? await this.runReuseScenarios(videoUrl, { quality, timeoutMs, signal: options.signal, measureFirstByte, manualFormatId, preferredCodec: options.preferredCodec })
      : null;
    assertNotAborted(options.signal);

    return {
      type: 'lunera-lte-real-benchmark',
      version: 1,
      runs,
      quality,
      baseline: this.baselineName,
      measuredAt: Date.now(),
      elapsedMs: Math.max(0, this.now() - startedAt),
      summary,
      comparison,
      scenarios,
      samples
    };
  }

  async runReuseScenarios(videoUrl, options = {}) {
    const measureResolved = async (label, resolveOptions = {}) => {
      const startedAt = this.now();
      try {
        const extraction = await this.turboEngine.resolve(videoUrl, {
          quality: options.quality,
          manualFormatId: options.manualFormatId,
          preferredCodec: options.preferredCodec,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          requestId: `lte-benchmark-${label}-${Date.now()}`,
          metadataCacheEnabled: false,
          ...resolveOptions
        });
        const resolutionMs = Math.max(0, this.now() - startedAt);
        const probe = options.measureFirstByte
          ? await this.firstByteProbe(extraction, { signal: options.signal, timeoutMs: options.timeoutMs, now: this.now })
          : { ok: true, skipped: true, elapsedMs: null };
        const rangeFirstByteMs = probe.ok && Number.isFinite(probe.elapsedMs) ? probe.elapsedMs : null;
        return {
          ok: probe.ok !== false,
          resolutionMs,
          rangeFirstByteMs,
          timeToFirstByteMs: rangeFirstByteMs === null ? null : resolutionMs + rangeFirstByteMs,
          cache: extraction?.metadata?.streamingProfile?.cache || null,
          selectedFormat: extraction?.selectedFormat?.id || extraction?.selectedFormat?.format_id || null,
          error: probe.ok === false ? sanitizeError(probe.error) : null
        };
      } catch (error) {
        if (error?.code === 'ABORTED' || error?.name === 'AbortError' || options.signal?.aborted) throw createAbortError();
        return {
          ok: false,
          resolutionMs: Math.max(0, this.now() - startedAt),
          rangeFirstByteMs: null,
          timeToFirstByteMs: null,
          cache: null,
          selectedFormat: null,
          error: sanitizeError(error)
        };
      }
    };

    assertNotAborted(options.signal);
    const resolvedReuse = await measureResolved('resolved-reuse');
    assertNotAborted(options.signal);

    const preloadStartedAt = this.now();
    let preload = null;
    let preloadError = null;
    try {
      if (this.turboEngine.getSettings?.().preloadEnabled === false) {
        preload = { ok: false, skipped: true, code: 'PRELOAD_DISABLED' };
      } else {
        preload = await this.turboEngine.preload(videoUrl, {
          quality: options.quality,
          manualFormatId: options.manualFormatId,
          preferredCodec: options.preferredCodec,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          requestId: `lte-benchmark-preload-${Date.now()}`,
          forceRefresh: true,
          metadataCacheEnabled: false
        });
      }
    } catch (error) {
      if (error?.code === 'ABORTED' || error?.name === 'AbortError' || options.signal?.aborted) throw createAbortError();
      preloadError = sanitizeError(error);
    }
    const preloadPreparationMs = Math.max(0, this.now() - preloadStartedAt);

    let preloadedHandoff = null;
    if (preload?.ok) {
      assertNotAborted(options.signal);
      preloadedHandoff = await measureResolved('preloaded-handoff');
    }

    return {
      // Warm reuse measures the same ephemeral result used by the next-track
      // path. The preload handoff is separately measured after a real forced
      // preload; neither scenario persists media to disk.
      resolvedReuse,
      preload: {
        ok: preload?.ok === true,
        skipped: preload?.skipped === true,
        code: preload?.code || null,
        preparationMs: preloadPreparationMs,
        error: preloadError || preload?.error || null,
        handoff: preloadedHandoff
      }
    };
  }

  async runOne(method, videoUrl, options = {}) {
    const startedAt = this.now();
    const resourceStart = snapshotProcessResources();
    let peakRssBytes = resourceStart.rssBytes;
    const resourceSampler = setInterval(() => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }, 100);
    if (typeof resourceSampler.unref === 'function') resourceSampler.unref();
    const requestId = `lte-benchmark-${method}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    try {
      const extraction = method === 'lte'
        ? await this.turboEngine.resolve(videoUrl, {
            quality: options.quality,
            manualFormatId: options.manualFormatId,
            preferredCodec: options.preferredCodec,
            timeoutMs: options.timeoutMs,
            signal: options.signal,
            requestId,
            forceRefresh: true,
            metadataCacheEnabled: false,
            benchmark: true
          })
        : await this.baselineResolver(videoUrl, {
            quality: options.quality,
            manualFormatId: options.manualFormatId,
            preferredCodec: options.preferredCodec,
            timeoutMs: options.timeoutMs,
            signal: options.signal,
            requestId,
            forceRefresh: true,
            benchmark: true
          });
      const resolutionMs = Math.max(0, this.now() - startedAt);
      const probe = options.measureFirstByte
        ? await this.firstByteProbe(extraction, { signal: options.signal, timeoutMs: options.timeoutMs, now: this.now })
        : { ok: true, skipped: true, elapsedMs: null };
      const rangeFirstByteMs = probe.ok && Number.isFinite(probe.elapsedMs) ? probe.elapsedMs : null;
      clearInterval(resourceSampler);
      return {
        ok: probe.ok !== false,
        run: options.run,
        resolutionMs,
        rangeFirstByteMs,
        timeToFirstByteMs: rangeFirstByteMs === null ? null : resolutionMs + rangeFirstByteMs,
        format: extraction?.selectedFormat?.id || extraction?.selectedFormat?.format_id || null,
        container: extraction?.selectedFormat?.container || extraction?.selectedFormat?.ext || null,
        resolver: {
          processMs: Number.isFinite(Number(extraction?.metrics?.processMs)) ? Number(extraction.metrics.processMs) : null,
          parseMs: Number.isFinite(Number(extraction?.metrics?.parseMs)) ? Number(extraction.metrics.parseMs) : null,
          formatMs: Number.isFinite(Number(extraction?.metrics?.formatMs)) ? Number(extraction.metrics.formatMs) : null,
          totalMs: Number.isFinite(Number(extraction?.metrics?.totalMs)) ? Number(extraction.metrics.totalMs) : null
        },
        probe: {
          statusCode: probe.statusCode || null,
          receivedBytes: probe.receivedBytes || null,
          contentType: probe.contentType || null,
          sourceHost: probe.sourceHost || null,
          skipped: probe.skipped === true
        },
        resources: finishResourceSample(resourceStart, peakRssBytes),
        error: probe.ok === false ? String(probe.error || 'No se pudo medir el primer byte').slice(0, 300) : null
      };
    } catch (error) {
      clearInterval(resourceSampler);
      if (error?.code === 'ABORTED' || error?.name === 'AbortError' || options.signal?.aborted) throw createAbortError();
      return {
        ok: false,
        run: options.run,
        resolutionMs: Math.max(0, this.now() - startedAt),
        rangeFirstByteMs: null,
        timeToFirstByteMs: null,
        format: null,
        container: null,
        resolver: { processMs: null, parseMs: null, formatMs: null, totalMs: null },
        probe: { statusCode: null, receivedBytes: null, contentType: null, sourceHost: null, skipped: false },
        resources: finishResourceSample(resourceStart, peakRssBytes),
        error: sanitizeError(error)
      };
    }
  }
}

module.exports = {
  BenchmarkRunner,
  probeDirectFirstByte,
  sanitizeForwardHeaders,
  sanitizeBenchmarkError: sanitizeError
};
