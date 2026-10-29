'use strict';
const { SpotifyImporter, YouTubeImporter } = require('./playlistTransfer');
let activeDialog = null;

function openImportDialog(provider, options = {}) {
  if (activeDialog) { activeDialog.querySelector('input, button')?.focus(); return; }
  const spotify = provider === 'spotify';
  const brand = spotify ? 'Spotify' : 'YouTube';
  const importer = spotify ? new SpotifyImporter() : new YouTubeImporter();
  const previousFocus = document.activeElement;
  const modal = document.createElement('div');
  activeDialog = modal;
  modal.className = `collection-import ${spotify ? 'is-spotify' : 'is-youtube'}`;
  modal.innerHTML = `
    <div class="collection-backdrop"></div>
    <section class="collection-dialog" role="dialog" aria-modal="true" aria-labelledby="collectionTitle">
      <header><span class="collection-brand"><i class="fab fa-${provider}" aria-hidden="true"></i></span><span class="collection-kicker">DALE UN NUEVO HOGAR A TU MÚSICA</span><button class="collection-close" aria-label="Cerrar">×</button></header>
      <h2 id="collectionTitle">De ${brand}<br><em>a tu universo.</em></h2>
      <p class="collection-description">${spotify ? 'Trae tus playlists, álbumes y canciones. Buscaremos una coincidencia para cada tema.' : 'Tu playlist pública, directamente a Lunera. Leeremos la lista completa antes de guardarla.'}</p>
      <div class="collection-stages" aria-hidden="true"><span class="active">01 · Leer</span><span>02 · Guardar</span><span>03 · Revisar</span></div>
      <form class="collection-form"><label for="collectionUrl">Enlace de ${brand}</label><div class="collection-input"><i class="fas fa-link" aria-hidden="true"></i><input id="collectionUrl" type="url" required placeholder="${spotify ? 'https://open.spotify.com/playlist/…' : 'https://www.youtube.com/playlist?list=…'}" autocomplete="off"></div><p class="collection-hint">${spotify ? 'Playlist, álbum o canción pública. No necesitamos tu contraseña.' : 'Incluye el parámetro list del enlace. Los videos privados o eliminados pueden no estar disponibles.'}</p><button class="collection-primary" type="submit">Traer mi música <i class="fas fa-arrow-right" aria-hidden="true"></i></button>
      ${spotify ? '<label class="collection-csv">¿Spotify muestra sólo una parte? <span>Importar lista CSV</span><input type="file" accept=".csv,text/csv" hidden></label><p class="collection-csv-note">Columnas: Track Name y Artist Name(s), o Title y Artist.</p>' : ''}</form>
      <div class="collection-work" hidden><p class="collection-live" role="status"></p><div class="collection-meter" role="progressbar" aria-label="Progreso de importación" aria-valuemin="0" aria-valuemax="100"><span></span></div><div class="collection-counts"><span data-count="imported">0 guardadas</span><span data-count="existing">0 existentes</span><span data-count="failed">0 pendientes</span></div><button class="collection-stop" type="button">Detener importación</button></div>
      <div class="collection-summary" hidden><h3>Tu colección, revisada.</h3><p class="collection-summary-copy"></p><p class="collection-warning" hidden></p><details hidden><summary>Ver canciones pendientes</summary><ul></ul></details><div class="collection-summary-actions"><button class="collection-retry" type="button">Reintentar pendientes</button><button class="collection-primary collection-done" type="button">Ver mi biblioteca</button></div></div>
      <p class="collection-error" role="alert" hidden></p>
    </section>`;
  document.body.append(modal);
  let running = false, closing = false, saved = 0, existing = 0, originalTotal = 0, originalWarning = '';
  const $ = selector => modal.querySelector(selector);
  const errorMessage = error => { $('.collection-error').hidden = false; $('.collection-error').textContent = error.message || String(error); };
  const close = () => {
    if (running || closing) return;
    closing = true; modal.classList.add('is-closing');
    document.removeEventListener('keydown', keydown);
    setTimeout(() => { modal.remove(); activeDialog = null; previousFocus?.focus?.(); }, 180);
  };
  const keydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); if (running) stop(); else close(); }
    if (event.key === 'Tab') {
      const focusable = [...modal.querySelectorAll('button, input:not([hidden]), summary, [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const stop = () => { if (!running) return; importer.cancel(); $('.collection-stop').disabled = true; $('.collection-live').textContent = 'Deteniendo… Se conservará lo que ya se guardó.'; };
  const progress = payload => {
    if (importer.cancelled) return;
    const percent = Math.max(0, Math.min(100, Number(payload.percent) || 0));
    $('.collection-live').textContent = payload.message;
    $('.collection-meter').setAttribute('aria-valuenow', String(percent));
    $('.collection-meter span').style.width = `${percent}%`;
    $('[data-count="imported"]').textContent = `${Number(payload.importedCount ?? (Array.isArray(payload.imported) ? payload.imported.length : payload.imported)) || 0} guardadas`;
    $('[data-count="existing"]').textContent = `${Number(payload.existingCount ?? payload.existing) || 0} existentes`;
    $('[data-count="failed"]').textContent = `${Number(payload.skippedCount ?? payload.failed) || 0} pendientes`;
    modal.querySelectorAll('.collection-stages span').forEach((el, index) => el.classList.toggle('active', index === (percent < 15 ? 0 : percent < 100 ? 1 : 2)));
  };
  const run = async operation => {
    if (running) return;
    running = true; $('.collection-form').hidden = true; $('.collection-summary').hidden = true;
    $('.collection-work').hidden = false; $('.collection-error').hidden = true;
    $('.collection-close').disabled = true; $('.collection-stop').disabled = false;
    $('.collection-stop').focus();
    try {
      const report = await operation({ onProgress: progress });
      saved += report.importedCount || 0; existing += report.existingCount || 0;
      originalTotal ||= report.total || 0;
      if (report.sourceIncomplete) originalWarning = `${report.expected} canciones anunciadas, ${report.total} visibles. Spotify o YouTube no expuso la colección completa; no la marcamos como completa.${spotify ? ' Puedes traer la lista completa mediante CSV.' : ''}`;
      else if (report.completenessUnknown && !originalWarning) originalWarning = 'El proveedor no indicó el total de la colección. Sólo podemos confirmar las canciones leídas.';
      $('.collection-work').hidden = true; $('.collection-summary').hidden = false;
      $('.collection-summary h3').textContent = report.cancelled ? 'Importación detenida.' : 'Tu colección, revisada.';
      const pending = (report.skippedCount || 0) + (report.remainingCount || 0);
      $('.collection-summary-copy').textContent = `${saved} guardadas · ${existing} ya estaban · ${pending} pendientes. ${originalTotal} canciones leídas en la lista.`;
      $('.collection-warning').hidden = !originalWarning; $('.collection-warning').textContent = originalWarning;
      const details = $('details'); details.hidden = !report.skipped?.length;
      const list = $('details ul'); list.replaceChildren();
      (report.skipped || []).forEach(track => { const item = document.createElement('li'); item.textContent = `${track.title} — ${track.reason}`; list.append(item); });
      $('.collection-retry').hidden = !pending;
      $('.collection-done').disabled = !report.playlistId;
      modal.querySelectorAll('.collection-stages span').forEach((el, index) => el.classList.toggle('active', index === 2));
      try { await options.onImported?.(report); }
      catch { errorMessage(new Error('Las canciones se guardaron, pero no se pudo refrescar la biblioteca. Vuelve a abrirla.')); }
      $('.collection-retry').hidden ? $('.collection-done').focus() : $('.collection-retry').focus();
    } catch (error) {
      $('.collection-work').hidden = true;
      $('.collection-form').hidden = false;
      errorMessage(error);
      $('#collectionUrl').focus();
    } finally { running = false; $('.collection-close').disabled = false; }
  };
  $('.collection-form').addEventListener('submit', event => {
    event.preventDefault();
    const url = $('#collectionUrl').value.trim();
    const valid = spotify ? !!require('./playlistTransfer').spotifyUrl(url) : YouTubeImporter.isYouTubePlaylistUrl(url);
    if (!valid) { errorMessage(new Error(`Comprueba el enlace de ${brand}.`)); return; }
    void run(callbacks => spotify ? importer.importUrl(url, callbacks) : importer.importPlaylist(url, callbacks));
  });
  $('.collection-csv input')?.addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 8 * 1024 * 1024) { errorMessage(new Error('El CSV supera los 8 MB.')); return; }
    try { const text = await file.text(); if (modal.isConnected && !closing) void run(callbacks => importer.importCsv(text, file.name.replace(/\.csv$/i, ''), callbacks)); }
    catch (error) { errorMessage(error); }
  });
  const csvControl = $('.collection-csv');
  if (csvControl) {
    csvControl.tabIndex = 0;
    csvControl.setAttribute('role', 'button');
    csvControl.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); csvControl.querySelector('input').click(); }
    });
  }
  $('.collection-stop').addEventListener('click', stop);
  $('.collection-close').addEventListener('click', close);
  $('.collection-backdrop').addEventListener('click', close);
  $('.collection-retry').addEventListener('click', () => void run(callbacks => importer.retryFailed(callbacks)));
  $('.collection-done').addEventListener('click', () => { close(); options.onLibrary?.(); });
  document.addEventListener('keydown', keydown);
  $('#collectionUrl').focus();
}
module.exports = { openImportDialog };
