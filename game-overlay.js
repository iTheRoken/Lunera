(() => {
  'use strict';
  const api = window.luneraOverlay;
  const $ = id => document.getElementById(id);
  let current = {};
  let seeking = false;
  let queryVersion = 0;
  let shown = false;
  const time = value => {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const render = state => {
    current = state || {};
    $('title').textContent = current.title || 'Elige tu próxima canción';
    $('artist').textContent = current.artist || 'Busca algo para acompañar la partida';
    $('status').textContent = current.playerUiState === 'loading' ? 'PREPARANDO TU CANCIÓN…' : current.playerUiState === 'error' ? 'NO SE PUDO REPRODUCIR' : current.isPlaying ? 'SONANDO AHORA' : current.title ? 'EN PAUSA' : 'TU MÚSICA, SIEMPRE CERCA';
    document.body.classList.toggle('is-playing', !!current.isPlaying);
    $('toggle').textContent = current.isPlaying ? 'Ⅱ' : '▶';
    $('toggle').setAttribute('aria-label', current.isPlaying ? 'Pausar' : 'Reproducir');
    const src = typeof current.thumbnail === 'string' && /^https:\/\//i.test(current.thumbnail) ? current.thumbnail : '';
    if ($('artwork').getAttribute('src') !== src) {
      $('artwork').hidden = !src;
      if (src) $('artwork').src = src;
      else $('artwork').removeAttribute('src');
    }
    $('seek').disabled = !(Number(current.duration) > 0);
    if (!seeking) { $('seek').max = Math.max(1, Number(current.duration) || 1); $('seek').value = Number(current.currentTime) || 0; $('time').textContent = time(current.currentTime); }
    $('duration').textContent = time(current.duration);
    if (document.activeElement !== $('volume')) $('volume').value = current.volume ?? 1;
    $('volumeValue').textContent = `${Math.round((current.muted ? 0 : current.volume ?? 1) * 100)}%`;
  };
  $('artwork').addEventListener('error', () => { $('artwork').hidden = true; });
  $('close').addEventListener('click', () => api.control('close'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); api.control('close'); }
    if (event.code === 'Space' && !['INPUT', 'BUTTON'].includes(event.target.tagName)) { event.preventDefault(); api.control('toggle'); }
  });
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => api.control(button.dataset.action)));
  document.querySelectorAll('[data-skip]').forEach(button => button.addEventListener('click', () => api.control('skip', Number(button.dataset.skip))));
  $('seek').addEventListener('input', () => { seeking = true; $('time').textContent = time($('seek').value); });
  $('seek').addEventListener('change', () => { api.control('seek', Number($('seek').value)); seeking = false; });
  $('seek').addEventListener('blur', () => { seeking = false; });
  $('volume').addEventListener('input', () => { api.control('volume', Number($('volume').value)); $('volumeValue').textContent = `${Math.round(Number($('volume').value) * 100)}%`; });
  $('query').addEventListener('input', () => { queryVersion += 1; $('searchStatus').textContent = 'Pulsa Enter para buscar.'; });
  $('searchForm').addEventListener('submit', async event => {
    event.preventDefault();
    const query = $('query').value.trim();
    if (query.length < 2) return;
    const version = ++queryVersion;
    $('searchButton').disabled = true;
    $('searchStatus').textContent = 'Buscando tu próxima canción…';
    try {
      const tracks = await api.search(query);
      if (version !== queryVersion || !shown) return;
      $('results').replaceChildren();
      for (const track of tracks) {
        const button = document.createElement('button'); button.className = 'result'; button.type = 'button';
        const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.src = track.thumbnail;
        const copy = document.createElement('div'); const title = document.createElement('strong'); title.textContent = track.title;
        const artist = document.createElement('small'); artist.textContent = track.artist;
        const play = document.createElement('span'); play.textContent = '▶';
        copy.append(title, artist); button.append(img, copy, play);
        button.addEventListener('click', async () => {
          try { await api.play(track.id); $('searchStatus').textContent = 'Preparando la canción en Lunera…'; }
          catch (error) { $('searchStatus').textContent = error.message || 'No se pudo reproducir'; }
        });
        $('results').append(button);
      }
      $('searchStatus').textContent = tracks.length ? `${tracks.length} canciones · elige una para reproducir` : 'No encontramos canciones. Prueba otra búsqueda.';
    } catch (error) { if (version === queryVersion) $('searchStatus').textContent = error.message || 'No se pudo buscar'; }
    finally { $('searchButton').disabled = false; }
  });
  api.onState(render);
  api.onVisible(visible => {
    shown = visible;
    if (!visible) { queryVersion += 1; seeking = false; }
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.toggle('is-open', visible)));
  });
  api.ready().then(render).catch(() => { $('status').textContent = 'NO SE PUDO CONECTAR CON LUNERA'; });
})();
