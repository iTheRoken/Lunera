'use strict';
const { ipcRenderer } = require('electron');
const { chooseSpotifyCandidate, scoreSpotifyCandidate, normalize: normalizeMatch } = require('./spotifyMatch');
const clean = value => String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const normalize = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function spotifyUrl(value) {
  const text = String(value || '').trim();
  const uri = text.match(/^spotify:(playlist|album|track):([a-zA-Z0-9]+)$/);
  if (uri) return `https://open.spotify.com/${uri[1]}/${uri[2]}`;
  try {
    const url = new URL(text);
    const match = url.pathname.match(/^\/(?:intl-[a-z]+\/)?(playlist|album|track)\/([a-zA-Z0-9]+)\/?$/);
    return url.protocol === 'https:' && url.hostname === 'open.spotify.com' && match
      ? `https://open.spotify.com/${match[1]}/${match[2]}` : '';
  } catch { return ''; }
}

function parseSpotifyPages(pages) {
  const tracks = new Map();
  let expected = null;
  let name = '';
  const add = object => {
    const rawId = object.uri || object.id || object.url || object['@id'] || '';
    const match = String(rawId).match(/(?:spotify:track:|\/track\/)([A-Za-z0-9]+)/);
    const isTrack = object.type === 'track' || object['@type'] === 'MusicRecording' || object.__typename === 'Track' || !!match;
    if (!isTrack) return;
    const id = match?.[1] || (/^[A-Za-z0-9]{22}$/.test(String(object.id)) ? object.id : '');
    const title = clean(object.name || object.title);
    const artistItems = object.artists?.items || object.artists || object.byArtist || [];
    const artistArray = Array.isArray(artistItems) ? artistItems : [artistItems];
    const artist = artistArray.map(item => clean(item?.profile?.name || item?.name)).filter(Boolean).join(', ')
      || clean(object.subtitle || object.artist);
    if (id && title && !tracks.has(id)) tracks.set(id, {
      id, title, artist: artist || 'Desconocido',
      duration: Number(object.duration_ms || object.duration?.totalMilliseconds || (typeof object.duration === 'number' ? object.duration : 0)) / 1000,
      spotifyUrl: `https://open.spotify.com/track/${id}`
    });
  };
  const walk = (object, depth = 0) => {
    if (!object || typeof object !== 'object' || depth > 40) return;
    if (Array.isArray(object)) { object.forEach(item => walk(item, depth + 1)); return; }
    add(object);
    for (const key of ['tracks', 'trackList', 'tracklist', 'trackListV2']) {
      const count = Number(object[key]?.totalCount ?? object[key]?.total);
      if (Number.isFinite(count) && count > 0) expected = Math.max(expected || 0, count);
    }
    if (object.type === 'playlist' || object.type === 'album' || object.trackList) {
      const count = Number(object.totalTrackCount || object.trackCount);
      if (count > 0) expected = Math.max(expected || 0, count);
    }
    if (object['@type'] === 'MusicPlaylist' || object['@type'] === 'MusicAlbum') {
      name ||= clean(object.name);
      const count = Number(object.numTracks || object.numberOfItems);
      if (count > 0) expected = Math.max(expected || 0, count);
    }
    for (const [key, value] of Object.entries(object)) {
      if (!/recommend|related|suggest/i.test(key)) walk(value, depth + 1);
    }
  };
  for (const html of pages) {
    if (typeof html !== 'string') continue;
    name ||= clean(html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1]);
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/application\/(?:ld\+)?json|__NEXT_DATA__|initial-state/i.test(match[1])) continue;
      try {
        const raw = match[2].trim();
        const json = /initial-state/i.test(match[1]) && /^[A-Za-z0-9+/=\s]+$/.test(raw)
          ? require('buffer').Buffer.from(raw, 'base64').toString('utf8') : raw;
        walk(JSON.parse(json));
      } catch { /* Other scripts are not data. */ }
    }
    // Older public pages still expose ordinary track rows.
    for (const row of html.split('data-testid="track-row"').slice(1)) {
      const fragment = row.split(/<script|data-testid="track-row"/)[0];
      const id = fragment.match(/(?:\/track\/|spotify:track:)([A-Za-z0-9]+)/)?.[1];
      const title = fragment.match(/id="listrow-title-track-[^"]*"[^>]*>[\s\S]*?<span[^>]*>([^<]+)/)?.[1];
      const artist = fragment.match(/href="\/artist\/[^\"]+"[^>]*>([^<]+)/)?.[1];
      if (id && title) add({ uri: `spotify:track:${id}`, name: title, artists: [{ name: artist }] });
    }
  }
  return { name: name || 'Colección de Spotify', tracks: [...tracks.values()], expected,
    sourceIncomplete: expected !== null && tracks.size < expected, completenessUnknown: expected === null };
}

function parseTrackCsv(text) {
  const delimiter = text.split(/\r?\n/, 1)[0].includes(';') ? ';' : ',';
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i] ?? '\n';
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (char === delimiter || char === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (char === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else field += char;
  }
  if (quoted) throw new Error('El CSV contiene comillas sin cerrar. Comprueba el archivo.');
  const header = (rows.shift() || []).map(normalize);
  const column = candidates => header.findIndex(value => candidates.includes(value));
  const titleIndex = column(['track name', 'track title', 'title', 'name', 'nombre de la cancion']);
  const artistIndex = column(['artist name s', 'artist names', 'artist name', 'artist', 'artists', 'artista']);
  const idIndex = column(['track uri', 'spotify uri', 'track url', 'spotify url', 'uri']);
  if (titleIndex < 0 || artistIndex < 0) throw new Error('El CSV necesita columnas Track Name y Artist Name(s), o Title y Artist.');
  rows.forEach((row, index) => {
    if (!row[titleIndex]?.trim() || !row[artistIndex]?.trim()) throw new Error(`Falta título o artista en la fila ${index + 2} del CSV.`);
  });
  return rows.map((row, index) => ({ id: row[idIndex] || `csv-${index}`,
    title: clean(row[titleIndex]), artist: clean(row[artistIndex]), duration: 0 }));
}

class PlaylistTransfer {
  constructor(options = {}) {
    this.cancelled = false; this.delay = options.requestDelayMs ?? 0; this.lastJob = null;
    this.readId = require('crypto').randomUUID(); this.matchJobs = new Map(); this.matchCache = new Map(); this.generation = 0;
    this.cacheEnabled = options.cacheEnabled !== false;
    if (this.cacheEnabled && typeof localStorage !== 'undefined') {
      try {
        const entries = JSON.parse(localStorage.getItem('spotify-verified-matches-v3') || '[]');
        for (const [key, entry] of entries) if (entry.at > Date.now() - 7 * 86400000) this.matchCache.set(key, entry);
      } catch { /* Cache failures must not interrupt import. */ }
    }
  }
  cancel() { this.cancelled = true; this.generation++; ipcRenderer.send('collection:cancel-read', this.readId); }
  async pause(ms) { for (let remaining = ms; remaining > 0 && !this.cancelled; remaining -= 100) await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining))); }
  progress(callbacks, payload) { callbacks.onProgress?.(payload); }
  async match(track) {
    const key = `${track.id || ''}|${normalizeMatch(track.title)}|${normalizeMatch(track.artist)}|${track.duration || 0}`;
    const cached = this.matchCache.get(key);
    if (cached && scoreSpotifyCandidate(track, cached.result).accepted) return cached.result;
    const generation = this.generation;
    const jobKey = `${generation}:${key}`;
    if (this.matchJobs.has(jobKey)) return this.matchJobs.get(jobKey);
    const job = this.resolveMatch(track, generation).then(result => {
      if (result && !this.cancelled && generation === this.generation) {
        this.matchCache.set(key, { at: Date.now(), result });
        if (this.matchCache.size > 800) this.matchCache.delete(this.matchCache.keys().next().value);
        if (this.cacheEnabled && typeof localStorage !== 'undefined') {
          try { localStorage.setItem('spotify-verified-matches-v3', JSON.stringify([...this.matchCache])); } catch {}
        }
      }
      return result;
    }).finally(() => this.matchJobs.delete(jobKey));
    this.matchJobs.set(jobKey, job);
    return job;
  }
  async resolveMatch(track, generation = this.generation) {
    const queries = [`${track.title} ${track.artist}`, `${track.artist} ${track.title} audio`];
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !this.cancelled && generation === this.generation; attempt++) {
      try {
        const results = await ipcRenderer.invoke('search-songs', queries[Math.min(attempt, 1)]);
        if (this.cancelled || generation !== this.generation) return null;
        const best = chooseSpotifyCandidate(track, results);
        if (best) return best;
        lastError = new Error('No se encontró una coincidencia suficientemente cercana');
      } catch (error) { lastError = error; }
    }
    if (this.cancelled || generation !== this.generation) return null;
    throw lastError || new Error('Sin coincidencias');
  }
  async transfer(collection, callbacks = {}, playlistId = null) {
    this.cancelled = false;
    this.generation++;
    const name = `${collection.provider}: ${collection.name}`;
    if (!playlistId) {
      const playlists = await ipcRenderer.invoke('get-playlists');
      playlistId = playlists.find(item => item.name === name)?.id;
      if (!playlistId) playlistId = (await ipcRenderer.invoke('create-playlist', name)).id;
    }
    const existingTracks = await ipcRenderer.invoke('get-playlist-songs', playlistId);
    const existing = new Set(existingTracks.map(track => String(track.video_id || track.id)));
    const report = { playlistName: name, playlistId, total: collection.tracks.length, expected: collection.expected,
      sourceIncomplete: !!collection.sourceIncomplete, completenessUnknown: !!collection.completenessUnknown,
      imported: [], skipped: [], existingCount: 0, cancelled: false, sourceUrl: collection.url };
    const total = collection.tracks.length;
    // Resolve a bounded lookahead in parallel, but commit songs sequentially
    // to preserve playlist order and avoid duplicate check/write races.
    const prepared = new Map();
    const prepare = index => {
      if (this.cancelled || index >= total || prepared.has(index) || collection.provider !== 'Spotify') return;
      prepared.set(index, this.match(collection.tracks[index]).then(value => ({ value }), error => ({ error })));
    };
    for (let index = 0; index < Math.min(3, total); index++) prepare(index);
    for (let index = 0; index < total; index++) {
      if (this.cancelled) break;
      const track = collection.tracks[index];
      this.progress(callbacks, { step: 'processing', percent: 15 + Math.round(index / total * 80),
        message: `${index + 1} de ${total} · ${track.title}`, total, imported: report.imported.length, failed: report.skipped.length, existing: report.existingCount });
      try {
        let best = track;
        if (collection.provider === 'Spotify') {
          const resolved = await prepared.get(index);
          prepared.delete(index);
          prepare(index + 3);
          if (resolved?.error) throw resolved.error;
          best = resolved?.value;
        }
        if (this.cancelled) break;
        if (!best?.id || best.unavailable) throw new Error('La canción no está disponible');
        const id = String(best.id);
        if (existing.has(id)) { report.existingCount++; continue; }
        const song = { ...best, id, video_id: id, title: collection.provider === 'Spotify' ? track.title : best.title || track.title,
          artist: collection.provider === 'Spotify' ? track.artist : best.artist || track.artist, thumbnail: best.thumbnail || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${id}`, duration: best.duration || 0 };
        // Main's add-to-playlist already upserts the library entry. Avoid
        // doing the same SQLite write and IPC round trip twice per song.
        await ipcRenderer.invoke('add-to-playlist', playlistId, song);
        existing.add(id); report.imported.push(song);
      } catch (error) { report.skipped.push({ ...track, reason: error.message || 'No se pudo guardar' }); }
      await this.pause(this.delay);
    }
    report.cancelled = this.cancelled;
    report.importedCount = report.imported.length;
    report.skippedCount = report.skipped.length;
    report.remainingCount = Math.max(0, total - report.importedCount - report.skippedCount - report.existingCount);
    this.lastJob = { collection, report };
    this.progress(callbacks, { step: report.cancelled ? 'cancelled' : 'complete', percent: report.cancelled ? Math.round((total - report.remainingCount) / total * 100) : 100,
      message: report.cancelled ? 'Importación detenida. Se conservaron las canciones guardadas.' : 'Revisión terminada', ...report });
    return report;
  }
  async retryFailed(callbacks = {}) {
    if (!this.lastJob) throw new Error('No hay una importación para reintentar');
    const { collection, report } = this.lastJob;
    const pending = [...report.skipped, ...collection.tracks.slice(collection.tracks.length - report.remainingCount)];
    return this.transfer({ ...collection, tracks: pending, expected: pending.length, sourceIncomplete: false, completenessUnknown: false }, callbacks, report.playlistId);
  }
}
class SpotifyImporter extends PlaylistTransfer {
  static isSpotifyPlaylistUrl(value) { return spotifyUrl(value).includes('/playlist/'); }
  static isSpotifyAlbumUrl(value) { return spotifyUrl(value).includes('/album/'); }
  static isSpotifySongUrl(value) { return spotifyUrl(value).includes('/track/'); }
  static normalizePlaylistUrl(value) { return this.isSpotifyPlaylistUrl(value) ? spotifyUrl(value) : ''; }
  static normalizeAlbumUrl(value) { return this.isSpotifyAlbumUrl(value) ? spotifyUrl(value) : ''; }
  static normalizeSongUrl(value) { return this.isSpotifySongUrl(value) ? spotifyUrl(value) : ''; }
  async importUrl(value, callbacks = {}) {
    const url = spotifyUrl(value);
    if (!url) throw new Error('Usa una URL pública de playlist, álbum o canción de Spotify.');
    this.progress(callbacks, { percent: 4, message: 'Leyendo la colección pública de Spotify…' });
    let pages;
    try { pages = await ipcRenderer.invoke('spotify:read-collection', url, this.readId); }
    catch (error) { if (!this.cancelled) throw error; }
    if (this.cancelled) return { cancelled: true, importedCount: 0, skippedCount: 0, remainingCount: 0, imported: [], skipped: [] };
    const collection = parseSpotifyPages(pages);
    if (!collection.tracks.length) throw new Error('Spotify no expuso las canciones de esta colección. Puedes importar su lista desde un CSV.');
    return this.transfer({ ...collection, url, provider: 'Spotify' }, callbacks);
  }
  importPlaylist(url, callbacks) { return this.importUrl(url, callbacks); }
  importAlbum(url, callbacks) { return this.importUrl(url, callbacks); }
  importTrack(url, callbacks) { return this.importUrl(url, callbacks); }
  importCsv(text, name, callbacks = {}) {
    const tracks = parseTrackCsv(text);
    if (!tracks.length) throw new Error('El CSV no contiene canciones');
    return this.transfer({ name, tracks, expected: tracks.length, provider: 'Spotify', completenessUnknown: false }, callbacks);
  }
}
class YouTubeImporter extends PlaylistTransfer {
  static normalizePlaylistUrl(value) {
    try { const url = new URL(String(value).trim());
      const list = url.searchParams.get('list');
      return ['www.youtube.com', 'youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)
        && url.protocol === 'https:' && /^[A-Za-z0-9_-]+$/.test(list || '') ? `https://www.youtube.com/playlist?list=${list}` : '';
    } catch { return ''; }
  }
  static isYouTubePlaylistUrl(value) { return !!this.normalizePlaylistUrl(value); }
  async importPlaylist(value, callbacks = {}) {
    const url = YouTubeImporter.normalizePlaylistUrl(value);
    if (!url) throw new Error('Usa una URL válida de playlist pública de YouTube');
    this.progress(callbacks, { percent: 4, message: 'Leyendo todas las páginas de la playlist de YouTube…' });
    let result;
    try { result = await ipcRenderer.invoke('youtube:read-collection', url, this.readId); }
    catch (error) { if (!this.cancelled) throw error; }
    if (this.cancelled) return { cancelled: true, importedCount: 0, skippedCount: 0, remainingCount: 0, imported: [], skipped: [] };
    if (!result.tracks.length) throw new Error('No hay videos disponibles para importar');
    return this.transfer({ ...result, provider: 'YouTube', url }, callbacks);
  }
}
module.exports = { SpotifyImporter, YouTubeImporter, parseSpotifyPages, parseTrackCsv, spotifyUrl, PlaylistTransfer };
