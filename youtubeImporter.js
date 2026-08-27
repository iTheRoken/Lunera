const electron = (typeof require === 'function' ? require('electron') : (typeof window !== 'undefined' && window.require ? window.require('electron') : null));
const ipcRenderer = electron?.ipcRenderer;

if (!ipcRenderer) {
  throw new Error('ipcRenderer no está disponible en el módulo YouTubeImporter');
}

class YouTubeImporter {
  constructor(options = {}) {
    this.cacheEnabled = options.cacheEnabled ?? true;
    this.requestDelayMs = options.requestDelayMs ?? 200;
    this.cancelled = false;
  }

  static get YT_PLAYLIST_REGEX() {
    return /(?:[?&]list=)([A-Za-z0-9_-]+)/i;
  }

  static isYouTubePlaylistUrl(value) {
    if (!value || typeof value !== 'string') return false;
    return YouTubeImporter.YT_PLAYLIST_REGEX.test(value.trim());
  }

  static normalizePlaylistUrl(value) {
    if (!value || typeof value !== 'string') return '';
    try {
      const trimmed = value.trim();
      const url = new URL(trimmed, 'https://www.youtube.com');
      const list = url.searchParams.get('list');
      if (list) return `https://www.youtube.com/playlist?list=${list}`;
    } catch (e) {
      const m = String(value).match(YouTubeImporter.YT_PLAYLIST_REGEX);
      if (m) return `https://www.youtube.com/playlist?list=${m[1]}`;
    }
    return '';
  }

  cancel() { this.cancelled = true; }

  _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  _notifyProgress(callbacks, payload) {
    if (callbacks && typeof callbacks.onProgress === 'function') callbacks.onProgress(payload);
  }

  _decodeHtmlEntities(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  }

  _normalizeText(value) {
    if (!value || typeof value !== 'string') return '';
    return this._decodeHtmlEntities(value).trim();
  }

  async _fetchPlaylistHtml(url) {
    const response = await ipcRenderer.invoke('fetch-youtube-playlist-html', url);
    if (!response || typeof response !== 'string') throw new Error('No se pudo obtener el HTML de YouTube');
    return response;
  }

  _parsePlaylistInfo(html, url) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const name = this._normalizeText(titleMatch?.[1] || '') || 'Playlist de YouTube';
    return { name, description: '', url };
  }

  async _parseTracks(html) {
    const tracks = [];

    // Helper: extract a balanced JSON object starting at the first '{' after a match index
    const extractBalancedObject = (source, startIndex) => {
      let i = source.indexOf('{', startIndex);
      if (i === -1) return null;
      let depth = 0;
      let inString = false;
      let stringChar = null;
      let escaped = false;
      for (let j = i; j < source.length; j++) {
        const ch = source[j];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === stringChar) {
            inString = false;
            stringChar = null;
          }
        } else {
          if (ch === '"' || ch === "'") {
            inString = true;
            stringChar = ch;
          } else if (ch === '{') {
            depth++;
          } else if (ch === '}') {
            depth--;
            if (depth === 0) {
              return source.slice(i, j + 1);
            }
          }
        }
      }
      return null;
    };

    // Try to locate ytInitialData in several common patterns
    let initIndex = html.search(/ytInitialData\s*=\s*\{/i);
    if (initIndex === -1) initIndex = html.search(/window\[\"ytInitialData\"\]\s*=\s*\{/i);
    if (initIndex === -1) initIndex = html.search(/var\s+ytInitialData\s*=\s*\{/i);

    let parsed = null;
    if (initIndex !== -1) {
      const jsonText = extractBalancedObject(html, initIndex);
      if (jsonText) {
        try {
          parsed = JSON.parse(jsonText);
        } catch (e) {
          // ignore parse error
          parsed = null;
        }
      }
    }

    const pushFromRenderer = (renderer) => {
      if (!renderer) return;
      const id = renderer.videoId || (renderer.playlistVideoRenderer && renderer.playlistVideoRenderer.videoId) || null;
      let title = '';
      let byline = '';
      const r = renderer.playlistVideoRenderer || renderer.videoRenderer || renderer;
      if (r && r.title) {
        if (r.title.runs && r.title.runs[0] && r.title.runs[0].text) title = r.title.runs[0].text;
        else if (typeof r.title.simpleText === 'string') title = r.title.simpleText;
      }
      if (r && r.shortBylineText && r.shortBylineText.runs && r.shortBylineText.runs[0] && r.shortBylineText.runs[0].text) byline = r.shortBylineText.runs[0].text;
      if (!id && r && r.videoId) {
        // already handled
      }
      if (id) {
        tracks.push({ id, title: this._normalizeText(title || (`Video ${id}`)), artist: this._normalizeText(byline || 'YouTube'), url: `https://www.youtube.com/watch?v=${id}` });
      }
    };

    // Recursive search for playlistVideoRenderer or videoRenderer nodes
    const traverse = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.playlistVideoRenderer) {
        const pv = obj.playlistVideoRenderer;
        const id = pv.videoId || pv.videoId === 0 ? pv.videoId : null;
        let title = '';
        if (pv.title) {
          if (pv.title.runs && pv.title.runs[0] && pv.title.runs[0].text) title = pv.title.runs[0].text;
          else if (typeof pv.title.simpleText === 'string') title = pv.title.simpleText;
        }
        const byline = pv.shortBylineText && pv.shortBylineText.runs && pv.shortBylineText.runs[0] && pv.shortBylineText.runs[0].text ? pv.shortBylineText.runs[0].text : '';
        if (id) tracks.push({ id, title: this._normalizeText(title || (`Video ${id}`)), artist: this._normalizeText(byline || 'YouTube'), url: `https://www.youtube.com/watch?v=${id}` });
      }
      if (obj.videoRenderer) {
        const vr = obj.videoRenderer;
        const id = vr.videoId || null;
        let title = '';
        if (vr.title) {
          if (vr.title.runs && vr.title.runs[0] && vr.title.runs[0].text) title = vr.title.runs[0].text;
          else if (typeof vr.title.simpleText === 'string') title = vr.title.simpleText;
        }
        const byline = vr.shortBylineText && vr.shortBylineText.runs && vr.shortBylineText.runs[0] && vr.shortBylineText.runs[0].text ? vr.shortBylineText.runs[0].text : '';
        if (id) tracks.push({ id, title: this._normalizeText(title || (`Video ${id}`)), artist: this._normalizeText(byline || 'YouTube'), url: `https://www.youtube.com/watch?v=${id}` });
      }
      for (const k of Object.keys(obj)) {
        try { traverse(obj[k]); } catch (e) { /* ignore */ }
      }
    };

    if (parsed) {
      traverse(parsed);
    }

    // Deduplicate by id preserving order (initialize before fallback uses it)
    const seen = new Set();
    const unique = [];
    for (const t of tracks) {
      if (!t || !t.id) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      unique.push(t);
    }

    // If parsing failed to find entries, try extracting playlistVideoRenderer/videoRenderer fragments directly from the HTML
    if (unique.length === 0) {
      try {
        const fragmentRegexes = [ /"playlistVideoRenderer"\s*:\s*\{/g, /"videoRenderer"\s*:\s*\{/g ];
        for (const fragRegex of fragmentRegexes) {
          let fm;
          while ((fm = fragRegex.exec(html)) !== null) {
            const start = fm.index + fm[0].lastIndexOf('{');
            const fragment = extractBalancedObject(html, start);
            if (!fragment) continue;
            try {
              const obj = JSON.parse(fragment);
              // If this is a nested renderer wrap it as expected
              const candidate = obj.playlistVideoRenderer ? obj.playlistVideoRenderer : (obj.videoRenderer ? obj.videoRenderer : obj);
              if (!candidate) continue;
              const id = candidate.videoId || null;
              let title = '';
              if (candidate.title) {
                if (candidate.title.runs && candidate.title.runs[0] && candidate.title.runs[0].text) title = candidate.title.runs[0].text;
                else if (typeof candidate.title.simpleText === 'string') title = candidate.title.simpleText;
              }
              const byline = candidate.shortBylineText && candidate.shortBylineText.runs && candidate.shortBylineText.runs[0] && candidate.shortBylineText.runs[0].text ? candidate.shortBylineText.runs[0].text : '';
              if (id) {
                if (!seen.has(id)) {
                  seen.add(id);
                  unique.push({ id, title: this._normalizeText(title || (`Video ${id}`)), artist: this._normalizeText(byline || 'YouTube'), url: `https://www.youtube.com/watch?v=${id}` });
                }
              }
            } catch (e) {
              continue;
            }
          }
        }
      } catch (e) {
        // ignore fallback errors
      }
    }

    

    // Fallback: if still empty, try simple id regex and return basic entries
    if (unique.length === 0) {
      const idRegex = /"videoId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g;
      let match;
      const ids = [];
      const idSet = new Set();
      while ((match = idRegex.exec(html)) !== null) {
        if (!idSet.has(match[1])) { idSet.add(match[1]); ids.push(match[1]); }
      }
      for (const id of ids) {
        unique.push({ id, title: `Video ${id}`, artist: 'YouTube', url: `https://www.youtube.com/watch?v=${id}` });
      }
    }

    // If some titles are generic (Video <id>) or empty, try to fill them using YouTube oEmbed endpoint
    for (let i = 0; i < unique.length; i++) {
      if (this.cancelled) break;
      const item = unique[i];
      const needFetch = !item.title || /^Video\s+[A-Za-z0-9_-]+$/i.test(item.title);
      if (!needFetch) continue;
      try {
        const meta = await ipcRenderer.invoke('fetch-youtube-oembed', item.id);
        if (meta && meta.title) {
          item.title = this._normalizeText(meta.title);
        }
        if (meta && meta.author_name) {
          item.artist = this._normalizeText(meta.author_name);
        }
        // small delay to be polite
        await this._sleep(80);
      } catch (e) {
        // ignore individual failures
      }
    }

    return unique;
  }

  _loadCache(key) {
    if (!this.cacheEnabled || typeof window === 'undefined' || !window.localStorage) return null;
    try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }

  _saveCache(key, value) {
    if (!this.cacheEnabled || typeof window === 'undefined' || !window.localStorage) return;
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { }
  }

  async importPlaylist(playlistUrl, callbacks = {}) {
    const normalizedUrl = YouTubeImporter.normalizePlaylistUrl(playlistUrl);
    if (!normalizedUrl) throw new Error('URL de playlist de YouTube inválida');

    this._notifyProgress(callbacks, { step: 'validating', percent: 5, message: 'Validando URL de YouTube' });
    await this._sleep(this.requestDelayMs);

    const cacheKey = `youtube-import-cache:${normalizedUrl}`;
    let cached = this._loadCache(cacheKey);
    if (cached && Array.isArray(cached.tracks) && cached.tracks.length > 0) {
      this._notifyProgress(callbacks, { step: 'cached', percent: 15, message: 'Usando caché local de importación' });
      await this._sleep(this.requestDelayMs);
    }

    this._notifyProgress(callbacks, { step: 'fetching', percent: 20, message: 'Obteniendo datos de YouTube' });
    const html = cached?.html || await this._fetchPlaylistHtml(normalizedUrl);
    const playlistInfo = this._parsePlaylistInfo(html, normalizedUrl);
    const ytTracks = await this._parseTracks(html);

    if (!ytTracks || ytTracks.length === 0) {
      throw new Error('No se encontraron videos en la playlist de YouTube');
    }

    const playlistName = playlistInfo.name || `Playlist de YouTube ${Date.now()}`;
    const playlistDisplayName = `YouTube: ${playlistName}`;
    const playlistCreate = await ipcRenderer.invoke('get-playlists');
    let playlist = Array.isArray(playlistCreate) ? playlistCreate.find(item => item.name === playlistDisplayName) : null;
    if (!playlist) {
      playlist = await ipcRenderer.invoke('create-playlist', playlistDisplayName);
    }

    const imported = [];
    const skipped = [];
    const total = ytTracks.length;

    for (let index = 0; index < ytTracks.length; index++) {
      if (this.cancelled) {
        this._notifyProgress(callbacks, { step: 'cancelled', percent: Math.round((index / total) * 100), message: 'Importación cancelada' });
        break;
      }

      const track = ytTracks[index];
      const percentBase = 20 + Math.round((index / total) * 70);
      this._notifyProgress(callbacks, { step: 'processing', percent: percentBase, message: `Procesando ${index + 1}/${total}: ${track.title}` });

      const song = {
        id: track.id,
        video_id: track.id,
        title: track.title || `Video ${track.id}`,
        artist: track.artist || 'YouTube',
        thumbnail: `https://i.ytimg.com/vi/${track.id}/mqdefault.jpg`,
        duration: 0,
        url: track.url || `https://www.youtube.com/watch?v=${track.id}`
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
        tracks: ytTracks
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
}

module.exports = { YouTubeImporter };