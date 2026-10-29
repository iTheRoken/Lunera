const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LuneraTurboEngine,
  DEFAULT_TURBO_SETTINGS,
  normalizeTurboSettings,
  TurboMetadataCache,
  selectTurboFormat,
  PerformanceMonitor,
  StreamManager
} = require('../services/lte');
const {
  extractAudio,
  configureTurboEngine,
  configureLseEngine,
  normalizeExtractorMode
} = require('../services/audioExtractor');

function createResolvedTrack(url, options = {}) {
  return {
    extractor: 'yt-dlp',
    audioUrl: `https://media.example.invalid/${encodeURIComponent(url)}.m4a`,
    metadata: {
      id: `id-${Buffer.from(url).toString('hex').slice(0, 12)}`,
      title: 'Pista de prueba',
      artist: 'Lunera',
      duration: 180,
      streamingProfile: {
        container: 'm4a',
        effectiveBitrate: 128
      }
    },
    selectedFormat: {
      id: '140',
      container: 'm4a',
      acodec: 'mp4a.40.2',
      audioBitrate: 128
    },
    formats: []
  };
}

test('LTE normaliza límites y mantiene los valores operativos seguros', () => {
  const settings = normalizeTurboSettings({
    enabled: 'yes',
    preloadTracks: 99,
    extractionTimeoutMs: 10,
    maxConcurrentExtractions: 99,
    manualFormatId: '140',
    bufferMode: 'invalid',
    qualityMode: 'invalid',
    fallbackEngine: 'invalid'
  });

  assert.equal(DEFAULT_TURBO_SETTINGS.preloadEnabled, true);
  assert.equal(settings.enabled, true);
  assert.equal(settings.preloadTracks, 5);
  assert.equal(settings.extractionTimeoutMs >= 1000, true);
  assert.equal(settings.maxConcurrentExtractions <= 4, true);
  assert.equal(settings.bufferMode, 'adaptive');
  assert.equal(settings.qualityMode, 'auto');
  assert.equal(settings.manualFormatId, '140');
  assert.equal(settings.fallbackEngine, 'yt-dlp');
  assert.equal(normalizeTurboSettings({ manualFormatId: 'bestaudio/best' }).manualFormatId, '');
});

test('LTE elige un formato de audio reproducible sin pedir conversión innecesaria', () => {
  const result = selectTurboFormat([
    { format_id: '137', url: 'https://example.invalid/video', acodec: 'none', vcodec: 'avc1', ext: 'mp4', tbr: 1500 },
    { format_id: '251', url: 'https://example.invalid/opus', acodec: 'opus', vcodec: 'none', ext: 'webm', abr: 160 },
    { format_id: '140', url: 'https://example.invalid/aac', acodec: 'mp4a.40.2', vcodec: 'none', ext: 'm4a', abr: 128 }
  ], { quality: 'medium' });

  assert.ok(result);
  assert.equal(result.vcodec, 'none');
  assert.equal(result.format_id, '140');
  assert.equal(result.requiresTranscode, false);
});

test('LTE aplica el codec preferido al selector y al resolvedor', async () => {
  const selected = selectTurboFormat([
    { format_id: '140', url: 'https://example.invalid/aac', acodec: 'mp4a.40.2', vcodec: 'none', ext: 'm4a', abr: 128 },
    { format_id: '251', url: 'https://example.invalid/opus', acodec: 'opus', vcodec: 'none', ext: 'webm', abr: 160 }
  ], { quality: 'balanced', preferredCodec: 'opus' });
  assert.equal(selected.format_id, '251');

  let resolverOptions = null;
  const engine = new LuneraTurboEngine({
    settings: { preferredCodec: 'opus', metadataCacheEnabled: false },
    resolver: async (url, options) => {
      resolverOptions = options;
      return createResolvedTrack(url);
    }
  });
  await engine.resolve('https://www.youtube.com/watch?v=preferred-codec', { quality: 'balanced' });
  assert.equal(resolverOptions.preferredCodec, 'opus');
  await engine.dispose();
});

test('LTE expira metadatos efímeros y no conserva URL de reproducción', () => {
  let now = 10_000;
  const cache = new TurboMetadataCache({
    now: () => now,
    ttlMs: 100
  });

  cache.set('video', {
    id: 'video',
    title: 'Canción',
    audioUrl: 'https://signed.example.invalid/audio?token=temporary'
  });

  const first = cache.get('video');
  assert.deepEqual(first, { id: 'video', title: 'Canción' });
  assert.equal(cache.getStats().hits, 1);

  now += 101;
  assert.equal(cache.get('video'), null);
  assert.equal(cache.getStats().expired, 1);
});

test('LTE persistently clears metadata cache on request', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lunera-lte-test-'));
  const cachePath = path.join(directory, 'metadata.json');
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const cache = new TurboMetadataCache({ persistencePath: cachePath });
  await cache.initialize();
  cache.set('track', { title: 'Track', audioUrl: 'https://private.example/audio?token=temporary' });
  await cache.flush();
  cache.clear();
  await cache.flush();

  const persisted = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
  assert.deepEqual(persisted.entries, []);
});

test('LTE comparte una sola extracción concurrente para la misma pista', async () => {
  let resolverCalls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const engine = new LuneraTurboEngine({
    settings: { metadataCacheEnabled: false },
    resolver: async (url) => {
      resolverCalls += 1;
      await gate;
      return createResolvedTrack(url);
    }
  });

  const first = engine.resolve('https://www.youtube.com/watch?v=first', { quality: 'medium' });
  const second = engine.resolve('https://www.youtube.com/watch?v=first', { quality: 'medium' });
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(resolverCalls, 1);
  assert.equal(firstResult.audioUrl, secondResult.audioUrl);
  assert.equal(engine.getDiagnostics().stats.deduplicatedRequests, 1);
  await engine.dispose();
});

test('LTE cancela un consumidor compartido sin abortar al otro', async () => {
  let resolverCalls = 0;
  let resolverAborted = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const engine = new LuneraTurboEngine({
    settings: { metadataCacheEnabled: false },
    resolver: (url, options = {}) => new Promise((resolve, reject) => {
      resolverCalls += 1;
      options.signal?.addEventListener('abort', () => {
        resolverAborted = true;
        const error = new Error('cancelled');
        error.name = 'AbortError';
        error.code = 'ABORTED';
        reject(error);
      }, { once: true });
      gate.then(() => resolve(createResolvedTrack(url)));
    })
  });
  const controller = new AbortController();
  const url = 'https://www.youtube.com/watch?v=shared-cancel';
  const cancelledCaller = engine.resolve(url, { quality: 'medium', signal: controller.signal });
  const activeCaller = engine.resolve(url, { quality: 'medium' });

  controller.abort();
  await assert.rejects(cancelledCaller, error => error?.code === 'ABORTED');
  release();
  const result = await activeCaller;

  assert.equal(resolverCalls, 1);
  assert.equal(resolverAborted, false);
  assert.equal(result.extractor, 'lte');
  await engine.dispose();
});

test('LTE cancela una precarga compartida sin interrumpir la reproduccion', async () => {
  let resolverAborted = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const engine = new LuneraTurboEngine({
    settings: { metadataCacheEnabled: false, preloadEnabled: true },
    resolver: (url, options = {}) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        resolverAborted = true;
        const error = new Error('cancelled');
        error.name = 'AbortError';
        error.code = 'ABORTED';
        reject(error);
      }, { once: true });
      gate.then(() => resolve(createResolvedTrack(url)));
    })
  });
  const url = 'https://www.youtube.com/watch?v=preload-handoff';
  const preload = engine.preload(url, { quality: 'medium' });
  const playback = engine.resolve(url, { quality: 'medium' });

  assert.equal(engine.cancelPreload(url, { quality: 'medium' }), true);
  release();
  const [preloadResult, playbackResult] = await Promise.all([preload, playback]);

  assert.equal(preloadResult.code, 'ABORTED');
  assert.equal(playbackResult.extractor, 'lte');
  assert.equal(resolverAborted, false);
  await engine.dispose();
});

test('audioExtractor enruta YouTube por LTE y conserva yt-dlp como resolvedor', async (t) => {
  let calls = 0;
  const engine = new LuneraTurboEngine({
    settings: { metadataCacheEnabled: false },
    resolver: async (url) => {
      calls += 1;
      return createResolvedTrack(url);
    }
  });
  configureTurboEngine(engine);
  t.after(() => engine.dispose());

  assert.equal(normalizeExtractorMode('auto'), 'lte');
  const result = await extractAudio('https://www.youtube.com/watch?v=lte-test', { mode: 'lte', quality: 'medium' });
  assert.equal(calls, 1);
  assert.equal(result.extractor, 'lte');
  assert.equal(result.metadata.streamingProfile.engine, 'lte');
  assert.equal(result.metadata.streamingProfile.resolver, 'yt-dlp');
  assert.equal(result.sourcePolicy.persistMedia, true);
  assert.equal(result.sourcePolicy.allowPersistentCache, true);
  assert.equal(result.sourcePolicy.mediaPersistence, 'user-controlled');
});

test('LTE cancela una precarga obsoleta sin cancelar una reproducción activa', async () => {
  let aborted = false;
  const engine = new LuneraTurboEngine({
    settings: { preloadEnabled: true },
    resolver: (url, options = {}) => new Promise((resolve, reject) => {
      const abort = () => {
        aborted = true;
        const error = new Error('cancelled');
        error.name = 'AbortError';
        reject(error);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      setTimeout(() => resolve(createResolvedTrack(url)), 1000);
    })
  });

  const pending = engine.preload('https://www.youtube.com/watch?v=next', { quality: 'medium' });
  assert.equal(engine.cancelPreload('https://www.youtube.com/watch?v=next', { quality: 'medium' }), true);
  const result = await pending;

  assert.equal(aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ABORTED');
  assert.equal(engine.getDiagnostics().stats.preloadsCancelled, 1);
  await engine.dispose();
});

test('LTE registra métricas medidas por etapa y conserva agregados', () => {
  let now = 100;
  const monitor = new PerformanceMonitor({ now: () => now, maxSamples: 3 });
  monitor.start('request-1', { source: 'network' });
  now += 20;
  monitor.mark('request-1', 'extraction-ready');
  now += 15;
  monitor.mark('request-1', 'stream-ready');
  now += 25;
  const sample = monitor.mark('request-1', 'first-audio');

  assert.equal(sample.extractionMs, 20);
  assert.equal(sample.preparationMs, 15);
  assert.equal(sample.timeToFirstAudioMs, 60);
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.samples, 1);
  assert.equal(snapshot.average.timeToFirstAudioMs, 60);
  assert.equal(snapshot.percentiles.p95.timeToFirstAudioMs, 60);
});

test('LTE forceRefresh replaces an expired transient URL', async () => {
  let calls = 0;
  const engine = new LuneraTurboEngine({
    settings: { metadataCacheEnabled: false },
    resolver: async (url) => {
      calls += 1;
      return {
        ...createResolvedTrack(url),
        audioUrl: `https://media.example.invalid/${calls}.m4a?expire=${Math.floor(Date.now() / 1000) + 60}`
      };
    }
  });

  const url = 'https://www.youtube.com/watch?v=force-refresh';
  const first = await engine.resolve(url, { quality: 'medium' });
  const refreshed = await engine.resolve(url, { quality: 'medium', forceRefresh: true });

  assert.equal(calls, 2);
  assert.notEqual(first.audioUrl, refreshed.audioUrl);
  assert.equal(engine.getDiagnostics().stats.expiryRefreshes, 1);
  await engine.dispose();
});

test('LTE applies a persisted manual format id without accepting a selector expression', async () => {
  let resolverOptions = null;
  const engine = new LuneraTurboEngine({
    settings: { qualityMode: 'manual', manualFormatId: '140' },
    resolver: async (url, options) => {
      resolverOptions = options;
      return createResolvedTrack(url);
    }
  });

  await engine.resolve('https://www.youtube.com/watch?v=manual-format');
  assert.equal(resolverOptions.quality, 'manual');
  assert.equal(resolverOptions.manualFormatId, '140');
  await engine.dispose();
});

test('StreamManager counts the first byte once per session', () => {
  let now = 1_000;
  const manager = new StreamManager({ now: () => now });
  const session = manager.create({ audioUrl: 'https://media.example.invalid/track.m4a' });

  now += 12;
  manager.markFirstByte(session.id);
  now += 8;
  manager.markFirstByte(session.id);

  assert.equal(manager.getDiagnostics().firstBytes, 1);
  assert.equal(manager.getDiagnostics().sessions[0].buffer.firstByteMs, 12);
});

test('StreamManager records measured throughput and adaptive buffering advice', () => {
  let now = 1_000;
  const manager = new StreamManager({ now: () => now });
  const session = manager.create(
    { audioUrl: 'https://media.example.invalid/track.m4a' },
    { requestId: 'buffer-test', settings: { dynamicBuffering: true, startupPriority: 'fast' } }
  );

  manager.markChunk(session.id, 1_000);
  now += 100;
  manager.markChunk(session.id, 1_000);
  manager.markStallByRequest('buffer-test', 1_200);

  const buffer = manager.getDiagnostics().sessions[0].buffer;
  assert.equal(buffer.throughputBps > 0, true);
  assert.equal(buffer.recommendedStartupSeconds > buffer.startupTargetSeconds, true);
});

test('LTE forwards an external AbortController to the queued resolver', async () => {
  let resolverAborted = false;
  const engine = new LuneraTurboEngine({
    resolver: (url, options = {}) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        resolverAborted = true;
        const error = new Error('cancelled');
        error.name = 'AbortError';
        error.code = 'ABORTED';
        reject(error);
      }, { once: true });
    })
  });
  const controller = new AbortController();
  const pending = engine.resolve('https://www.youtube.com/watch?v=abort-current', {
    quality: 'medium',
    signal: controller.signal
  });

  controller.abort();
  await assert.rejects(pending, error => error?.code === 'ABORTED');
  assert.equal(resolverAborted, true);
  await engine.dispose();
});

test('audioExtractor does not start a fallback after an aborted LTE request', async (t) => {
  let fallbackCalls = 0;
  const engine = new LuneraTurboEngine({
    settings: { fallbackEngine: 'lse' },
    resolver: (url, options = {}) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        error.code = 'ABORTED';
        reject(error);
      }, { once: true });
    })
  });
  const lse = new EventEmitter();
  lse.resolve = async () => {
    fallbackCalls += 1;
    return createResolvedTrack('fallback');
  };
  lse.getSettings = () => ({ fallbackEngine: 'none' });
  configureTurboEngine(engine);
  configureLseEngine(lse);
  t.after(() => engine.dispose());

  const controller = new AbortController();
  const pending = extractAudio('https://www.youtube.com/watch?v=cancel-no-fallback', {
    mode: 'lte',
    signal: controller.signal
  });
  controller.abort();

  await assert.rejects(pending, error => error?.code === 'ABORTED');
  assert.equal(fallbackCalls, 0);
});
