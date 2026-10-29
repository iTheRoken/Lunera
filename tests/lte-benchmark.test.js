'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BenchmarkRunner, probeDirectFirstByte } = require('../services/lte');

function extraction(label = 'track') {
  return {
    audioUrl: `https://media.example.invalid/${label}.m4a?token=private-token`,
    selectedFormat: { id: '140', container: 'm4a' },
    httpHeaders: { 'User-Agent': 'Lunera test', Cookie: 'never-forward-this' }
  };
}

test('el benchmark LTE mide ambas rutas reales solicitadas y no publica URLs firmadas', async () => {
  const lteCalls = [];
  const baselineCalls = [];
  const runner = new BenchmarkRunner({
    turboEngine: {
      getSettings: () => ({ qualityMode: 'auto' }),
      resolve: async (url, options) => {
        lteCalls.push({ url, options });
        return extraction('lte');
      }
    },
    baselineName: 'yt-dlp legacy',
    baselineResolver: async (url, options) => {
      baselineCalls.push({ url, options });
      return extraction('baseline');
    },
    firstByteProbe: async (result) => ({
      ok: true,
      elapsedMs: result.selectedFormat.id === '140' ? 9 : 0,
      statusCode: 206,
      receivedBytes: 4096,
      sourceHost: 'media.example.invalid'
    })
  });

  const result = await runner.run('https://www.youtube.com/watch?v=benchmark', { runs: 2, quality: 'balanced' });

  assert.equal(lteCalls.length, 2);
  assert.equal(baselineCalls.length, 2);
  assert.equal(lteCalls.every(call => call.options.forceRefresh && call.options.metadataCacheEnabled === false), true);
  assert.equal(baselineCalls.every(call => call.options.forceRefresh), true);
  assert.equal(result.summary.lte.successfulRuns, 2);
  assert.equal(result.summary.baseline.successfulRuns, 2);
  assert.equal(result.summary.lte.resolverRuns, 2);
  assert.equal(Number.isFinite(result.samples.lte[0].resources.peakRssBytes), true);
  assert.equal(result.samples.lte[0].probe.statusCode, 206);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(JSON.stringify(result).includes('media.example.invalid/lte.m4a'), false);
});

test('el benchmark conserva el formato manual en LTE y en la referencia', async () => {
  const lteOptions = [];
  const baselineOptions = [];
  const runner = new BenchmarkRunner({
    turboEngine: {
      getSettings: () => ({ qualityMode: 'manual', manualFormatId: '140' }),
      resolve: async (url, options) => {
        lteOptions.push(options);
        return extraction('lte-manual');
      }
    },
    baselineResolver: async (url, options) => {
      baselineOptions.push(options);
      return extraction('baseline-manual');
    },
    firstByteProbe: async () => ({ ok: true, elapsedMs: 1, statusCode: 206, receivedBytes: 4096 })
  });

  await runner.run('https://www.youtube.com/watch?v=benchmark-manual', {
    runs: 1,
    quality: 'manual',
    manualFormatId: '140',
    preferredCodec: 'opus'
  });

  assert.equal(lteOptions[0].manualFormatId, '140');
  assert.equal(baselineOptions[0].manualFormatId, '140');
  assert.equal(lteOptions[0].preferredCodec, 'opus');
  assert.equal(baselineOptions[0].preferredCodec, 'opus');
});

test('el benchmark propaga una cancelacion en curso', async () => {
  const controller = new AbortController();
  const runner = new BenchmarkRunner({
    turboEngine: { getSettings: () => ({ qualityMode: 'auto' }), resolve: async () => extraction('lte') },
    baselineResolver: (url, options = {}) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        error.code = 'ABORTED';
        reject(error);
      }, { once: true });
    }),
    firstByteProbe: async () => ({ ok: true, elapsedMs: 1 })
  });
  const pending = runner.run('https://www.youtube.com/watch?v=benchmark-abort', {
    runs: 1,
    includeReuseScenarios: false,
    signal: controller.signal
  });
  controller.abort();

  await assert.rejects(pending, error => error?.code === 'ABORTED');
});

test('la sonda de primer byte realiza un Range real y no reenvÃ­a cookies', async (t) => {
  let receivedHeaders = null;
  const server = http.createServer((request, response) => {
    receivedHeaders = request.headers;
    response.writeHead(206, {
      'content-type': 'audio/mp4',
      'content-range': 'bytes 0-15/16',
      'content-length': '16'
    });
    response.end(Buffer.alloc(16, 7));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();

  const result = await probeDirectFirstByte({
    audioUrl: `http://127.0.0.1:${address.port}/audio?signature=private`,
    httpHeaders: {
      'User-Agent': 'Lunera benchmark',
      Cookie: 'do-not-forward',
      Authorization: 'do-not-forward'
    }
  }, { timeoutMs: 5_000 });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 206);
  assert.equal(result.receivedBytes > 0, true);
  assert.equal(receivedHeaders.range, 'bytes=0-4095');
  assert.equal(receivedHeaders['user-agent'], 'Lunera benchmark');
  assert.equal(receivedHeaders.cookie, undefined);
  assert.equal(receivedHeaders.authorization, undefined);
  assert.equal(result.sourceHost, '127.0.0.1');
});

test('el benchmark informa errores de la ruta de referencia sin filtrar la URL', async () => {
  const runner = new BenchmarkRunner({
    turboEngine: { resolve: async () => extraction('lte') },
    baselineResolver: async () => {
      throw new Error('fallÃ³ https://media.example.invalid/audio?token=secret-value');
    },
    firstByteProbe: async () => ({ ok: true, elapsedMs: 1 })
  });

  const result = await runner.run('https://www.youtube.com/watch?v=benchmark', { runs: 1 });
  const baseline = result.samples.baseline[0];
  assert.equal(baseline.ok, false);
  assert.equal(baseline.error.includes('secret-value'), false);
  assert.equal(baseline.error.includes('https://'), false);
});

test('el benchmark mide reutilización y handoff de una precarga real del motor', async () => {
  let resolveCalls = 0;
  let preloadCalls = 0;
  const runner = new BenchmarkRunner({
    turboEngine: {
      getSettings: () => ({ qualityMode: 'auto', preloadEnabled: true }),
      resolve: async () => {
        resolveCalls += 1;
        return extraction(`lte-${resolveCalls}`);
      },
      preload: async () => {
        preloadCalls += 1;
        return { ok: true, result: extraction('preloaded') };
      }
    },
    baselineResolver: async () => extraction('baseline'),
    firstByteProbe: async () => ({ ok: true, elapsedMs: 5, statusCode: 206, receivedBytes: 4096 })
  });

  const result = await runner.run('https://www.youtube.com/watch?v=benchmark', {
    runs: 1,
    includeReuseScenarios: true
  });

  assert.equal(resolveCalls, 3);
  assert.equal(preloadCalls, 1);
  assert.equal(result.scenarios.resolvedReuse.ok, true);
  assert.equal(result.scenarios.preload.ok, true);
  assert.equal(result.scenarios.preload.handoff.ok, true);
});
