const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function load(invoke = async () => {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/playlistTransfer.js'), 'utf8'), {
    module, require: name => name === 'electron' ? { ipcRenderer: { invoke, send() {} } } : name.startsWith('.') ? require(path.join(__dirname, '../services', name)) : require(name),
    URL, setTimeout, console
  });
  return module.exports;
}
test('Spotify lee hidratación JSON de ambas páginas, deduplica y detecta lista parcial', () => {
  const { parseSpotifyPages } = load();
  const track = index => ({ type: 'track', id: String(index).padStart(22, '0'), name: `Song ${index}`, artists: [{ name: 'Artist' }] });
  const html = items => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { tracks: { total: 150, items } } })}</script>`;
  const result = parseSpotifyPages([html(Array.from({ length: 100 }, (_, index) => track(index))), html([track(100), track(99)])]);
  assert.equal(result.tracks.length, 101);
  assert.equal(result.expected, 150);
  assert.equal(result.sourceIncomplete, true);
  assert.equal(result.tracks[100].title, 'Song 100');
});
test('CSV conserva títulos con comas, comillas y saltos de línea', () => {
  const { parseTrackCsv } = load();
  const result = parseTrackCsv('Track Name,Artist Name(s)\r\n"Song, part 2","Artist ""One"""\r\n"Two\nLines",Other');
  assert.equal(result.length, 2);
  assert.equal(result[0].title, 'Song, part 2');
  assert.equal(result[0].artist, 'Artist "One"');
  assert.equal(result[1].title, 'Two\nLines');
  assert.throws(() => parseTrackCsv('wrong,columns\na,b'), /columnas/);
  assert.throws(() => parseTrackCsv('Title,Artist\nSong,'), /Falta título o artista/);
  assert.throws(() => parseTrackCsv('Title,Artist\n"Song,Artist'), /comillas sin cerrar/);
});
test('Importación informa guardadas, existentes y fallos, y reintenta sólo pendientes', async () => {
  const writes = []; let fail = true;
  const { PlaylistTransfer } = load(async (channel, ...args) => {
    if (channel === 'get-playlists') return [];
    if (channel === 'create-playlist') return { id: 7 };
    if (channel === 'get-playlist-songs') return [{ video_id: 'existing' }, ...writes.map(id => ({ video_id: id }))];
    if (channel === 'add-to-library') return true;
    if (channel === 'add-to-playlist') {
      if (args[1].id === 'failed' && fail) throw new Error('Storage busy');
      writes.push(args[1].id); return true;
    }
  });
  const transfer = new PlaylistTransfer({ requestDelayMs: 0 });
  const result = await transfer.transfer({ provider: 'YouTube', name: 'Collection', tracks: [
    { id: 'existing', title: 'One' }, { id: 'saved', title: 'Two' }, { id: 'failed', title: 'Three' }
  ] });
  assert.equal(result.importedCount, 1); assert.equal(result.existingCount, 1); assert.equal(result.skippedCount, 1);
  assert.equal(result.skipped[0].reason, 'Storage busy');
  fail = false;
  const retry = await transfer.retryFailed();
  assert.equal(retry.total, 1); assert.equal(retry.importedCount, 1);
  assert.deepEqual(writes, ['saved', 'failed']);
});
test('Cancelar durante una búsqueda no guarda la canción pendiente', async () => {
  let transfer; const writes = [];
  const { PlaylistTransfer } = load(async (channel, ...args) => {
    if (channel === 'get-playlists') return [{ id: 1, name: 'Spotify: Test' }];
    if (channel === 'get-playlist-songs') return [];
    if (channel === 'search-songs') { transfer.cancel(); return [{ id: 'found', title: 'Song Artist' }]; }
    if (channel.startsWith('add-to')) writes.push(args);
  });
  transfer = new PlaylistTransfer({ requestDelayMs: 0 });
  const report = await transfer.transfer({ provider: 'Spotify', name: 'Test', tracks: [{ title: 'Song', artist: 'Artist' }] });
  assert.equal(report.cancelled, true); assert.equal(report.remainingCount, 1); assert.equal(writes.length, 0);
});
test('Normalización rechaza hosts falsos y reconoce URLs internacionales de Spotify', () => {
  const { spotifyUrl, YouTubeImporter } = load();
  assert.equal(spotifyUrl('https://open.spotify.com/intl-es/playlist/abc?si=123'), 'https://open.spotify.com/playlist/abc');
  assert.equal(spotifyUrl('https://example.com/playlist/abc'), '');
  assert.equal(YouTubeImporter.normalizePlaylistUrl('https://example.com/watch?list=PL123'), '');
});

test('Spotify prepara tres búsquedas en paralelo y guarda en el orden original', async () => {
  const requests = [], writes = []; let active = 0, maxActive = 0;
  const { PlaylistTransfer } = load(async (channel, ...args) => {
    if (channel === 'get-playlists') return [{ id: 1, name: 'Spotify: Speed' }];
    if (channel === 'get-playlist-songs') return [];
    if (channel === 'search-songs') {
      active++; maxActive = Math.max(active, maxActive);
      const index = Number(args[0].match(/Song(\d)/)[1]);
      return new Promise(resolve => requests.push({ index, release() { active--; resolve([{ id: `id${index}`, title: `Artist - Song${index}`, artist: 'Artist', duration: 180 }]); } }));
    }
    if (channel === 'add-to-library') return true;
    if (channel === 'add-to-playlist') { writes.push(args[1].id); return true; }
  });
  const transfer = new PlaylistTransfer({ cacheEnabled: false });
  const pending = transfer.transfer({ provider: 'Spotify', name: 'Speed', tracks: Array.from({ length: 4 }, (_, index) => ({ title: `Song${index}`, artist: 'Artist', duration: 180 })) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3);
  requests[2].release(); requests[1].release(); requests[0].release();
  await new Promise(resolve => setImmediate(resolve));
  requests[3].release();
  const report = await pending;
  assert.equal(report.importedCount, 4); assert.equal(maxActive, 3);
  assert.deepEqual(writes, ['id0', 'id1', 'id2', 'id3']);
  const callsBefore = requests.length;
  const cached = await transfer.match({ title: 'Song0', artist: 'Artist', duration: 180 });
  assert.equal(cached.id, 'id0'); assert.equal(requests.length, callsBefore);
});
