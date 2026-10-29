const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  extractAudio,
  configureLseEngine,
  validateMediaUrl
} = require('../services/audioExtractor');
const { LuneraStreamEngine, LSEError } = require('../services/lse');

const AUDIO_BYTES = Buffer.from('ID3LuneraFacadeTest');

async function startDirectMediaServer() {
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith('/audio.mp3')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const headers = {
      'content-type': 'audio/mpeg',
      'content-length': AUDIO_BYTES.length,
      'accept-ranges': 'bytes'
    };
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? '' : AUDIO_BYTES);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/audio.mp3`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test('audioExtractor routes compatible direct media through LSE without a legacy engine', async (t) => {
  const fixture = await startDirectMediaServer();
  const engine = new LuneraStreamEngine({
    allowPrivateNetworkForTests: true,
    settings: { retryEnabled: false, metadataCacheEnabled: true }
  });
  configureLseEngine(engine);
  t.after(async () => {
    await engine.dispose();
    await fixture.close();
  });

  assert.equal(validateMediaUrl(fixture.url, 'lse'), true);
  const extraction = await extractAudio(fixture.url, { mode: 'lse', quality: 'medium' });

  assert.equal(extraction.extractor, 'lse');
  assert.equal(extraction.provider, 'lse-direct');
  assert.equal(extraction.usedFallback, false);
  assert.equal(extraction.sourcePolicy.requiresProxy, true);

  const preload = await extractAudio(fixture.url, { mode: 'lse', preload: true });
  assert.equal(preload.extractor, 'lse');
  assert.ok(engine.getStats().preloadsCompleted >= 1);
});

test('audioExtractor preserves the provider restriction when LSE fallback is disabled', async (t) => {
  const engine = new LuneraStreamEngine({ settings: { fallbackEngine: 'none', retryEnabled: false } });
  configureLseEngine(engine);
  t.after(() => engine.dispose());

  await assert.rejects(
    extractAudio('https://youtu.be/dQw4w9WgXcQ?t=12', { mode: 'lse', fallbackEngine: 'none' }),
    error => {
      assert.ok(error instanceof LSEError);
      assert.equal(error.code, 'PROVIDER_RESTRICTION');
      return true;
    }
  );
});
