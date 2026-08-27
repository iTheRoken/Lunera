const electron = (typeof require === 'function' ? require('electron') : (typeof window !== 'undefined' && window.require ? window.require('electron') : null));
const ipcRenderer = electron?.ipcRenderer;

if (!ipcRenderer) {
  throw new Error('ipcRenderer no está disponible en el módulo SpotifyImporter');
}

class SpotifyImporter {
  constructor(options = {}) {
    this.cacheEnabled = options.cacheEnabled ?? true;
    this.requestDelayMs = options.requestDelayMs ?? 250;
    this.maxYouTubeResults = options.maxYouTubeResults ?? 8;
    this.cancelled = false;
  }

  static get SPOTIFY_PLAYLIST_REGEX() {
    return /https?:\/\/open\.spotify\.com\/playlist\/[a-zA-Z0-9]+|spotify:playlist:[a-zA-Z0-9]+/i;
  }

  static get SPOTIFY_SONG_REGEX() {
    return /https?:\/\/open\.spotify\.com\/track\/[a-zA-Z0-9]+|spotify:track:[a-zA-Z0-9]+/i;
  }

  static get SPOTIFY_ALBUM_REGEX() {
    return /https?:\/\/open\.spotify\.com\/album\/[a-zA-Z0-9]+|spotify:album:[a-zA-Z0-9]+/i;
  }

  static isSpotifyPlaylistUrl(value) {
    if (!value || typeof value !== 'string') return false;
    return SpotifyImporter.SPOTIFY_PLAYLIST_REGEX.test(value.trim());
  }

  static isSpotifySongUrl(value) {
    if (!value || typeof value !== 'string') return false;
    return SpotifyImporter.SPOTIFY_SONG_REGEX.test(value.trim());
  }

  static isSpotifyAlbumUrl(value) {
    if (!value || typeof value !== 'string') return false;
    return SpotifyImporter.SPOTIFY_ALBUM_REGEX.test(value.trim());
  }

  static normalizePlaylistUrl(value) {
    if (!value || typeof value !== 'string') return '';
    const trimmed = value.trim();
    const match = trimmed.match(SpotifyImporter.SPOTIFY_PLAYLIST_REGEX);
    if (!match) return '';
    const url = match[0];
    if (url.startsWith('spotify:playlist:')) {
      return `https://open.spotify.com/playlist/${url.split(':').pop()}`;
    }
    return url.split('?')[0];
  }

  static normalizeSongUrl(value) {
    if (!value || typeof value !== 'string') return '';
    const trimmed = value.trim();
    const match = trimmed.match(SpotifyImporter.SPOTIFY_SONG_REGEX);
    if (!match) return '';
    const url = match[0];
    if (url.startsWith('spotify:track:')) {
      return `https://open.spotify.com/track/${url.split(':').pop()}`;
    }
    return url.split('?')[0];
  }

  static normalizeAlbumUrl(value) {
    if (!value || typeof value !== 'string') return '';
    const trimmed = value.trim();
    const match = trimmed.match(SpotifyImporter.SPOTIFY_ALBUM_REGEX);
    if (!match) return '';
    const url = match[0];
    if (url.startsWith('spotify:album:')) {
      return `https://open.spotify.com/album/${url.split(':').pop()}`;
    }
    return url.split('?')[0];
  }

  cancel() {
    this.cancelled = true;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _notifyProgress(callbacks, payload) {
    if (callbacks && typeof callbacks.onProgress === 'function') {
      callbacks.onProgress(payload);
    }
  }

  _decodeHtmlEntities(value) {
    if (typeof value !== 'string') return value;
    return value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  _normalizeText(value) {
    if (!value || typeof value !== 'string') return '';
    return this._decodeHtmlEntities(value).trim();
  }

  async _fetchPlaylistHtml(url) {
    const response = await ipcRenderer.invoke('fetch-spotify-playlist-html', url);
    if (!response || typeof response !== 'string') {
      throw new Error('No se pudo obtener el HTML de Spotify');
    }
    return response;
  }

  _parsePlaylistInfo(html, url) {
    const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const json = JSON.parse(jsonLdMatch[1]);
        if (json?.name) {
          return {
            name: this._normalizeText(json.name),
            description: this._normalizeText(json.description || ''),
            url: json.url || url
          };
        }
      } catch (error) {
        // ignore invalid JSON and continue parsing with fallback
      }
    }

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    return {
      name: this._normalizeText(titleMatch?.[1] || '' ) || 'Playlist de Spotify',
      description: '',
      url
    };
  }

  _parseTrackInfo(html, url) {
    const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const json = JSON.parse(jsonLdMatch[1]);
        if (json?.name) {
          const title = this._normalizeText(json.name);
          const artist = this._normalizeText(json.byArtist?.name || json.author?.name || 'Desconocido');
          return { title: title || 'Canción de Spotify', artist, url };
        }
      } catch (error) {
        // ignore invalid JSON and continue parsing with fallback
      }
    }

    const titleMatch = html.match(/<meta property=["']og:title["'] content=["']([^"']+)["']\/?\s*>/i) || html.match(/<title>([^<]+)<\/title>/i);
    const artistMatch = html.match(/<meta property=["']og:description["'] content=["']([^"']+)["']\/?\s*>/i) || html.match(/<span[^>]*class="[^"]*artist-name[^"]*"[^>]*>([^<]+)<\/span>/i);
    const title = this._normalizeText(titleMatch?.[1] || 'Canción de Spotify');
    const artist = this._normalizeText(artistMatch?.[1] || 'Desconocido');
    return { title, artist, url };
  }

  _parseTracks(html) {
    const trackRows = [];
    const rowRegex = /data-testid="track-row"([\s\S]*?)(?=data-testid="track-row"|<script|<meta|<\/body>)/gi;
    let match = null;

    while ((match = rowRegex.exec(html)) !== null) {
      const rowHtml = match[1];
      const idMatch = rowHtml.match(/href="\/track\/([A-Za-z0-9]+)"/i) || rowHtml.match(/spotify:track:([A-Za-z0-9]+)/i);
      const titleMatch = rowHtml.match(/<p[^>]*id="listrow-title-track-[^"]*"[^>]*>.*?<span[^>]*>([^<]+)<\/span>/is) || rowHtml.match(/aria-label="([^"]+)"/i);
      const artistMatch = rowHtml.match(/href="\/artist\/[A-Za-z0-9]+"[^>]*>([^<]+)<\/a>/i);

      if (!idMatch || !titleMatch) {
        continue;
      }

      const trackId = idMatch[1];
      const title = this._normalizeText(titleMatch[1]);
      const artist = this._normalizeText(artistMatch?.[1] || 'Desconocido');

      if (!trackId || !title) {
        continue;
      }

      trackRows.push({
        id: trackId,
        title,
        artist,
        spotifyUrl: `https://open.spotify.com/track/${trackId}`
      });
    }

    return trackRows;
  }

  async _searchYouTube(query) {
    const normalizedQuery = this._normalizeText(query);
    if (!normalizedQuery) return [];
    try {
      const results = await ipcRenderer.invoke('search-songs', normalizedQuery);
      return Array.isArray(results) ? results.slice(0, this.maxYouTubeResults) : [];
    } catch (error) {
      return [];
    }
  }

  async chooseBestResult(results) {
    if (!Array.isArray(results) || results.length === 0) return null;
    return results[0];
  }

  _loadCache(key) {
    if (!this.cacheEnabled || typeof window === 'undefined' || !window.localStorage) return null;
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  _saveCache(key, value) {
    if (!this.cacheEnabled || typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // ignore cache failures
    }
  }

  async importPlaylist(playlistUrl, callbacks = {}) {
    const normalizedUrl = SpotifyImporter.normalizePlaylistUrl(playlistUrl);
    if (!normalizedUrl) {
      throw new Error('URL de playlist de Spotify inválida');
    }

    this._notifyProgress(callbacks, { step: 'validating', percent: 5, message: 'Validando URL de Spotify' });
    await this._sleep(this.requestDelayMs);

    const cacheKey = `spotify-import-cache:${normalizedUrl}`;
    let cached = this._loadCache(cacheKey);
    if (cached && cached.playlistName && Array.isArray(cached.tracks) && cached.tracks.length > 0) {
      this._notifyProgress(callbacks, { step: 'cached', percent: 15, message: 'Usando caché local de importación' });
      await this._sleep(this.requestDelayMs);
    }

    this._notifyProgress(callbacks, { step: 'fetching', percent: 20, message: 'Obteniendo datos de Spotify' });
    const html = cached?.html || await this._fetchPlaylistHtml(normalizedUrl);
    const playlistInfo = this._parsePlaylistInfo(html, normalizedUrl);
    const spotifyTracks = this._parseTracks(html);

    if (!spotifyTracks || spotifyTracks.length === 0) {
      throw new Error('No se encontraron canciones en la playlist de Spotify');
    }

    const playlistName = playlistInfo.name || `Playlist de Spotify ${Date.now()}`;
    const playlistDisplayName = `Spotify: ${playlistName}`;
    const playlistCreate = await ipcRenderer.invoke('get-playlists');
    let playlist = Array.isArray(playlistCreate) ? playlistCreate.find(item => item.name === playlistDisplayName) : null;
    if (!playlist) {
      playlist = await ipcRenderer.invoke('create-playlist', playlistDisplayName);
    }

    const imported = [];
    const skipped = [];
    const total = spotifyTracks.length;

    for (let index = 0; index < spotifyTracks.length; index++) {
      if (this.cancelled) {
        this._notifyProgress(callbacks, { step: 'cancelled', percent: Math.round((index / total) * 100), message: 'Importación cancelada' });
        break;
      }

      const track = spotifyTracks[index];
      const percentBase = 20 + Math.round((index / total) * 70);
      this._notifyProgress(callbacks, { step: 'searching', percent: percentBase, message: `Buscando canción ${index + 1}/${total}: ${track.title}` });

      const results = await this._searchYouTube(`${track.title} ${track.artist}`);
      const best = await this.chooseBestResult(results);
      if (!best) {
        skipped.push(track);
        this._notifyProgress(callbacks, { step: 'skipped', percent: percentBase + 5, message: `No se encontró resultado para ${track.title}` });
        await this._sleep(this.requestDelayMs);
        continue;
      }

      const song = {
        id: best.id,
        video_id: best.id,
        title: best.title || track.title,
        artist: best.artist || track.artist || 'Desconocido',
        thumbnail: best.thumbnail || `https://i.ytimg.com/vi/${best.id}/mqdefault.jpg`,
        duration: best.duration || 0,
        url: best.url || `https://www.youtube.com/watch?v=${best.id}`
      };

      try {
        await ipcRenderer.invoke('add-to-library', song);
        await ipcRenderer.invoke('add-to-playlist', playlist.id, song);
        imported.push(song);
      } catch (error) {
        skipped.push(track);
      }

      this._notifyProgress(callbacks, {
        step: 'imported',
        percent: Math.min(95, percentBase + 10),
        message: `Importada ${index + 1}/${total}: ${song.title}`
      });
      await this._sleep(this.requestDelayMs);
    }

    if (!cached) {
      this._saveCache(cacheKey, {
        importedAt: new Date().toISOString(),
        playlistName,
        url: normalizedUrl,
        html,
        tracks: spotifyTracks
      });
    }

    this._notifyProgress(callbacks, { step: 'finalizing', percent: 100, message: `Importación finalizada. ${imported.length} canciones importadas.` });

    return {
      playlistName: playlistDisplayName,
      playlistId: playlist.id,
      total,
      importedCount: imported.length,
      skippedCount: skipped.length,
      imported,
      skipped,
      sourceUrl: normalizedUrl,
      cached: Boolean(cached)
    };
  }

  async importAlbum(albumUrl, callbacks = {}) {
    const normalizedUrl = SpotifyImporter.normalizeAlbumUrl(albumUrl);
    if (!normalizedUrl) {
      throw new Error('URL de álbum de Spotify inválida');
    }

    this._notifyProgress(callbacks, { step: 'validating', percent: 5, message: 'Validando URL de álbum de Spotify' });
    await this._sleep(this.requestDelayMs);

    const cacheKey = `spotify-import-cache:${normalizedUrl}`;
    let cached = this._loadCache(cacheKey);
    if (cached && cached.tracks && cached.tracks.length > 0) {
      this._notifyProgress(callbacks, { step: 'cached', percent: 15, message: 'Usando caché local de importación' });
      await this._sleep(this.requestDelayMs);
    }

    this._notifyProgress(callbacks, { step: 'fetching', percent: 20, message: 'Obteniendo datos del álbum de Spotify' });
    const html = cached?.html || await this._fetchPlaylistHtml(normalizedUrl);
    const albumInfo = this._parsePlaylistInfo(html, normalizedUrl);
    const spotifyTracks = this._parseTracks(html);

    if (!spotifyTracks || spotifyTracks.length === 0) {
      throw new Error('No se encontraron canciones en el álbum de Spotify');
    }

    const playlistName = albumInfo.name || `Álbum de Spotify ${Date.now()}`;
    const playlistDisplayName = `Spotify: ${playlistName}`;
    const playlistCreate = await ipcRenderer.invoke('get-playlists');
    let playlist = Array.isArray(playlistCreate) ? playlistCreate.find(item => item.name === playlistDisplayName) : null;
    if (!playlist) {
      playlist = await ipcRenderer.invoke('create-playlist', playlistDisplayName);
    }

    const imported = [];
    const skipped = [];
    const total = spotifyTracks.length;
    for (let index = 0; index < spotifyTracks.length; index++) {
      if (this.cancelled) {
        this._notifyProgress(callbacks, { step: 'cancelled', percent: Math.round((index / total) * 100), message: 'Importación cancelada' });
        break;
      }

      const track = spotifyTracks[index];
      const percentBase = 20 + Math.round((index / total) * 70);
      this._notifyProgress(callbacks, { step: 'searching', percent: percentBase, message: `Buscando canción ${index + 1}/${total}: ${track.title}` });

      const results = await this._searchYouTube(`${track.title} ${track.artist}`);
      const best = await this.chooseBestResult(results);
      if (!best) {
        skipped.push(track);
        this._notifyProgress(callbacks, { step: 'skipped', percent: percentBase + 5, message: `No se encontró resultado para ${track.title}` });
        await this._sleep(this.requestDelayMs);
        continue;
      }

      const song = {
        id: best.id,
        video_id: best.id,
        title: best.title || track.title,
        artist: best.artist || track.artist || 'Desconocido',
        thumbnail: best.thumbnail || `https://i.ytimg.com/vi/${best.id}/mqdefault.jpg`,
        duration: best.duration || 0,
        url: best.url || `https://www.youtube.com/watch?v=${best.id}`
      };

      try {
        await ipcRenderer.invoke('add-to-library', song);
        await ipcRenderer.invoke('add-to-playlist', playlist.id, song);
        imported.push(song);
      } catch (error) {
        skipped.push(track);
      }

      this._notifyProgress(callbacks, {
        step: 'imported',
        percent: Math.min(95, percentBase + 10),
        message: `Importada ${index + 1}/${total}: ${song.title}`
      });
      await this._sleep(this.requestDelayMs);
    }

    if (!cached) {
      this._saveCache(cacheKey, {
        importedAt: new Date().toISOString(),
        playlistName,
        url: normalizedUrl,
        html,
        tracks: spotifyTracks
      });
    }

    this._notifyProgress(callbacks, { step: 'finalizing', percent: 100, message: `Importación finalizada. ${imported.length} canciones importadas.` });

    return {
      playlistName: playlistDisplayName,
      playlistId: playlist.id,
      total,
      importedCount: imported.length,
      skippedCount: skipped.length,
      imported,
      skipped,
      sourceUrl: normalizedUrl,
      cached: Boolean(cached)
    };
  }

  async importTrack(trackUrl, callbacks = {}) {
    const normalizedUrl = SpotifyImporter.normalizeSongUrl(trackUrl);
    if (!normalizedUrl) {
      throw new Error('URL de pista de Spotify inválida');
    }

    this._notifyProgress(callbacks, { step: 'validating', percent: 5, message: 'Validando URL de pista de Spotify' });
    await this._sleep(this.requestDelayMs);

    const cacheKey = `spotify-import-cache:${normalizedUrl}`;
    let cached = this._loadCache(cacheKey);
    if (cached && cached.track) {
      this._notifyProgress(callbacks, { step: 'cached', percent: 15, message: 'Usando caché local de importación' });
      await this._sleep(this.requestDelayMs);
    }

    this._notifyProgress(callbacks, { step: 'fetching', percent: 20, message: 'Obteniendo datos de la pista de Spotify' });
    const html = cached?.html || await this._fetchPlaylistHtml(normalizedUrl);
    const trackInfo = this._parseTrackInfo(html, normalizedUrl);
    const total = 1;

    this._notifyProgress(callbacks, { step: 'searching', percent: 35, message: `Buscando pista: ${trackInfo.title}` });
    const results = await this._searchYouTube(`${trackInfo.title} ${trackInfo.artist}`);
    const best = await this.chooseBestResult(results);
    if (!best) {
      throw new Error(`No se encontró resultado de YouTube para ${trackInfo.title}`);
    }

    const song = {
      id: best.id,
      video_id: best.id,
      title: best.title || trackInfo.title,
      artist: best.artist || trackInfo.artist || 'Desconocido',
      thumbnail: best.thumbnail || `https://i.ytimg.com/vi/${best.id}/mqdefault.jpg`,
      duration: best.duration || 0,
      url: best.url || `https://www.youtube.com/watch?v=${best.id}`
    };

    await ipcRenderer.invoke('add-to-library', song);

    if (!cached) {
      this._saveCache(cacheKey, {
        importedAt: new Date().toISOString(),
        track: trackInfo,
        url: normalizedUrl,
        html,
        song
      });
    }

    this._notifyProgress(callbacks, { step: 'finalizing', percent: 100, message: `Pista importada: ${song.title}` });

    return {
      playlistName: null,
      playlistId: null,
      total,
      importedCount: 1,
      skippedCount: 0,
      imported: [song],
      skipped: [],
      sourceUrl: normalizedUrl,
      cached: Boolean(cached)
    };
  }

  async importUrl(spotifyUrl, callbacks = {}) {
    const url = String(spotifyUrl || '').trim();

    if (SpotifyImporter.isSpotifySongUrl(url)) {
      return this.importTrack(url, callbacks);
    }
    if (SpotifyImporter.isSpotifyAlbumUrl(url)) {
      return this.importAlbum(url, callbacks);
    }
    if (SpotifyImporter.isSpotifyPlaylistUrl(url)) {
      return this.importPlaylist(url, callbacks);
    }

    throw new Error('URL de Spotify no válida. Usa una playlist, álbum o pista pública.');
  }
}

module.exports = { SpotifyImporter };
