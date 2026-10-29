'use strict';
const https = require('https');

function fetchSpotifyPage(rawUrl, redirects = 0, signal) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.username || url.password || url.port) {
    return Promise.reject(new Error('URL de Spotify no permitida'));
  }
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'es,en;q=0.8' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 3 || !response.headers.location) return reject(new Error('Demasiadas redirecciones de Spotify'));
        fetchSpotifyPage(new URL(response.headers.location, url).href, redirects + 1, signal).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error(`Spotify respondió ${response.statusCode}`)); }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) request.destroy(new Error('La página de Spotify es demasiado grande'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Spotify interrumpió la respuesta')));
    });
    request.setTimeout(20000, () => request.destroy(new Error('Spotify tardó demasiado en responder')));
    request.on('error', reject);
  });
}
module.exports = { fetchSpotifyPage };
