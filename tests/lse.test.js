const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LuneraStreamEngine, LSEError } = require('../services/lse');

const AUDIO_BYTES = Buffer.from('ID3LuneraStreamEngineTestAudio');

async function createMediaServer() {
  const calls = { track: 0, slow: 0, hls: 0 };
  const server = http.createServer((request, response) => {
    const sendAudio = () => {
      calls.track += 1;
      const headers = {
        'content-type': 'audio/mpeg',
        'content-length': AUDIO_BYTES.length,
        'accept-ranges': 'bytes'
      };
      if (request.method === 'HEAD') {
        response.writeHead(200, headers);
        response.end();
        return;
      }
      if (request.headers.range) {
        response.writeHead(206, {
          ...headers,
          'content-range': `bytes 0-0/${AUDIO_BYTES.length}`,
          'content-length': 1
        });
        response.end(AUDIO_BYTES.subarray(0, 1));
        return;
      }
      response.writeHead(200, headers);
      response.end(AUDIO_BYTES);
    };

    if (request.url.startsWith('/track.mp3')) {
      sendAudio();
      return;
    }

    if (request.url === '/slow.mp3') {
      calls.slow += 1;
      setTimeout(() => {
        if (response.writableEnded || response.destroyed) return;
        response.writeHead(200, {
          'content-type': 'audio/mpeg',
          'content-length': AUDIO_BYTES.length,
          'accept-ranges': 'bytes'
        });
        response.end();
      }, 250);
      return;
    }

    if (request.url === '/live.m3u8') {
      calls.hls += 1;
      response.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': 27
      });
      response.end(request.method === 'HEAD' ? '' : '#EXTM3U\n#EXT-X-VERSION:3\n');
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    calls,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function createTestEngine() {
  return new LuneraStreamEngine({
    allowPrivateNetworkForTests: true,
    settings: {
      connectionTimeoutMs: 1000,
      resolutionTimeoutMs: 1000,
      metadataCacheEnabled: true,
      retryEnabled: false
    }
  });
}

test('LSE resolves direct audio progressively and reuses metadata cache', async (t) => {
  const fixture = await createMediaServer();
  const engine = createTestEngine();
  t.after(async () => {
    await engine.dispose();
    await fixture.close();
  });

  const first = await engine.resolve(`${fixture.url}/track.mp3`, { quality: 'medium' });
  assert.equal(first.extractor, 'lse');
  assert.equal(first.provider, 'lse-direct');
  assert.equal(first.audioUrl, `${fixture.url}/track.mp3`);
  assert.equal(first.metadata.streamingProfile.protocol, 'progressive');
  assert.equal(first.sourcePolicy.supportsRange, true);
  assert.equal(first.sourcePolicy.approvedAddress, '127.0.0.1');
  assert.equal(fixture.calls.track, 1);

  const second = await engine.resolve(`${fixture.url}/track.mp3`, { quality: 'medium' });
  assert.equal(second.fromMetadataCache, true);
  assert.equal(second.metadata.streamingProfile.cacheHit, true);
  assert.equal(fixture.calls.track, 1);
  assert.equal(engine.getStats().metadataCache.hits, 1);

  engine.updateSettings({ progressiveStreamingEnabled: false });
  const sequential = await engine.resolve(`${fixture.url}/track.mp3`, { quality: 'medium' });
  assert.equal(sequential.selectedFormat.protocol, 'sequential');
  assert.equal(sequential.sourcePolicy.supportsRange, false);
});

test('LSE persists reusable metadata but not the media payload itself', async (t) => {
  const fixture = await createMediaServer();
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lunera-lse-cache-'));
  const cachePath = path.join(folder, 'metadata.json');
  const source = `${fixture.url}/track.mp3`;
  const firstEngine = new LuneraStreamEngine({
    allowPrivateNetworkForTests: true,
    metadataCachePath: cachePath,
    settings: { retryEnabled: false, metadataCacheEnabled: true }
  });
  t.after(async () => {
    await firstEngine.dispose();
    await fixture.close();
    await fs.promises.rm(folder, { recursive: true, force: true });
  });

  await firstEngine.resolve(source);
  assert.equal(fixture.calls.track, 1);
  assert.equal(fs.existsSync(cachePath), true);

  const secondEngine = new LuneraStreamEngine({
    allowPrivateNetworkForTests: true,
    metadataCachePath: cachePath,
    settings: { retryEnabled: false, metadataCacheEnabled: true }
  });
  t.after(() => secondEngine.dispose());
  const cached = await secondEngine.resolve(source);

  assert.equal(cached.fromMetadataCache, true);
  assert.equal(fixture.calls.track, 1);
});

test('LSE does not persist temporary signed media URLs', async (t) => {
  const fixture = await createMediaServer();
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lunera-lse-temp-'));
  const cachePath = path.join(folder, 'metadata.json');
  const source = `${fixture.url}/track.mp3?token=temporary-value`;
  const firstEngine = new LuneraStreamEngine({
    allowPrivateNetworkForTests: true,
    metadataCachePath: cachePath,
    settings: { retryEnabled: false, metadataCacheEnabled: true }
  });
  t.after(async () => {
    await firstEngine.dispose();
    await fixture.close();
    await fs.promises.rm(folder, { recursive: true, force: true });
  });

  await firstEngine.resolve(source);
  const secondEngine = new LuneraStreamEngine({
    allowPrivateNetworkForTests: true,
    metadataCachePath: cachePath,
    settings: { retryEnabled: false, metadataCacheEnabled: true }
  });
  t.after(() => secondEngine.dispose());
  const second = await secondEngine.resolve(source);

  assert.equal(second.fromMetadataCache, undefined);
  assert.equal(fixture.calls.track, 2);
});

test('LSE cancels an obsolete network resolution through AbortController', async (t) => {
  const fixture = await createMediaServer();
  const engine = createTestEngine();
  t.after(async () => {
    await engine.dispose();
    await fixture.close();
  });

  const controller = new AbortController();
  const pending = engine.resolve(`${fixture.url}/slow.mp3`, { signal: controller.signal });
  setTimeout(() => controller.abort(), 25);

  await assert.rejects(pending, error => {
    assert.ok(error instanceof LSEError);
    assert.equal(error.code, 'ABORTED');
    return true;
  });
  assert.equal(engine.getStats().cancellations, 1);
});

test('LSE cancels an obsolete managed preload', async (t) => {
  const fixture = await createMediaServer();
  const engine = createTestEngine();
  const source = `${fixture.url}/slow.mp3`;
  t.after(async () => {
    await engine.dispose();
    await fixture.close();
  });

  const pending = engine.preload(source);
  setTimeout(() => engine.cancelPreload(source), 25);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ABORTED');
  assert.equal(engine.getStats().preloadsCancelled, 1);
});

test('LSE honors the configured concurrent network connection limit', async (t) => {
  const fixture = await createMediaServer();
  const engine = new LuneraStreamEngine({
    allowPrivateNetworkForTests: true,
    settings: { retryEnabled: false, maxConnections: 1, connectionTimeoutMs: 1000 }
  });
  t.after(async () => {
    await engine.dispose();
    await fixture.close();
  });

  const startedAt = Date.now();
  await Promise.all([
    engine.networkManager.probe(`${fixture.url}/slow.mp3`),
    engine.networkManager.probe(`${fixture.url}/slow.mp3`)
  ]);

  assert.ok(Date.now() - startedAt >= 420);
  assert.equal(engine.networkManager.getStats().maxConnections, 1);
});

test('LSE detects HLS but does not claim playback without a real MSE adapter', async (t) => {
  const fixture = await createMediaServer();
  const engine = createTestEngine();
  t.after(async () => {
    await engine.dispose();
    await fixture.close();
  });

  await assert.rejects(engine.resolve(`${fixture.url}/live.m3u8`), error => {
    assert.ok(error instanceof LSEError);
    assert.equal(error.code, 'PLAYBACK_UNSUPPORTED');
    return true;
  });
  assert.equal(fixture.calls.hls, 1);
  const hls = engine.getExtractorStatus().find(extractor => extractor.id === 'lse-hls');
  assert.equal(hls.capabilities.playback, false);
});

test('LSE blocks private network destinations outside the explicit test mode', async () => {
  const engine = new LuneraStreamEngine({
    settings: { retryEnabled: false }
  });
  await assert.rejects(engine.resolve('http://127.0.0.1:9/track.mp3'), error => {
    assert.ok(error instanceof LSEError);
    assert.equal(error.code, 'NETWORK_DESTINATION_BLOCKED');
    return true;
  });
  await engine.dispose();
});

test('LSE reports restrictions for YouTube provider pages without an official adapter', async () => {
  const engine = createTestEngine();
  await assert.rejects(engine.resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), error => {
    assert.ok(error instanceof LSEError);
    assert.equal(error.code, 'PROVIDER_RESTRICTION');
    return true;
  });
  await engine.dispose();
});

test('LSE still reports restrictions for provider pages without an official adapter', async () => {
  const engine = createTestEngine();
  await assert.rejects(engine.resolve('https://open.spotify.com/track/example'), error => {
    assert.ok(error instanceof LSEError);
    assert.equal(error.code, 'PROVIDER_RESTRICTION');
    return true;
  });
  await engine.dispose();
});

test('LSE resolves a local media file without network access', async (t) => {
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lunera-lse-'));
  const mediaPath = path.join(folder, 'prueba.mp3');
  await fs.promises.writeFile(mediaPath, AUDIO_BYTES);
  const engine = createTestEngine();
  t.after(async () => {
    await engine.dispose();
    await fs.promises.rm(folder, { recursive: true, force: true });
  });

  const result = await engine.resolve({ type: 'local', path: mediaPath, title: 'Prueba local' });
  assert.equal(result.extractor, 'lse');
  assert.equal(result.provider, 'lse-local');
  assert.equal(result.metadata.title, 'Prueba local');
  assert.match(result.audioUrl, /^file:/);
  assert.equal(result.sourcePolicy.requiresProxy, false);
});

test('LSE normalizes advanced settings and exposes a diagnostic snapshot', async () => {
  const engine = createTestEngine();
  await engine.initialize();
  const settings = engine.updateSettings({
    preloadTrackCount: 99,
    maxRetries: -2,
    preferredCodec: 'opus',
    fallbackEngine: 'yt-dlp'
  });
  assert.equal(settings.preloadTrackCount, 5);
  assert.equal(settings.maxRetries, 0);
  assert.equal(settings.preferredCodec, 'opus');
  assert.equal(settings.fallbackEngine, 'yt-dlp');
  const diagnostics = engine.getDiagnostics();
  assert.equal(diagnostics.activeEngine, 'lse');
  assert.ok(Array.isArray(diagnostics.extractors));
  await engine.dispose();
});
