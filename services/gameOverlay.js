'use strict';

const { BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');

function createGameOverlay(options) {
  let window = null;
  let ready = false;
  let visible = false;
  let hideTimer = null;
  let disposed = false;
  let searchPending = false;
  let lastSearchAt = 0;
  let searchGeneration = 0;
  const results = new Map();
  const shortcut = 'Control+L';
  const trusted = event => window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame;
  const send = (channel, payload) => {
    if (ready && window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };
  const bounds = () => {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const height = Math.min(740, area.height - 24);
    return { x: area.x + 12, y: area.y + Math.round((area.height - height) / 2), width: Math.min(440, area.width - 24), height };
  };
  const present = () => {
    if (!ready || !visible || disposed) return;
    window.setBounds(bounds());
    window.setIgnoreMouseEvents(false);
    window.setAlwaysOnTop(true, 'screen-saver');
    window.show();
    window.focus();
    send('game-overlay:state', options.getState());
    send('game-overlay:visible', true);
  };
  const ensureWindow = () => {
    if (window && !window.isDestroyed()) return;
    window = new BrowserWindow({
      ...bounds(), show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      autoHideMenuBar: true, roundedCorners: false,
      webPreferences: { preload: path.join(__dirname, '..', 'overlay-preload.js'),
        nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('blur', () => { if (visible) hide(); });
    window.on('closed', () => {
      ready = false; visible = false; window = null;
      clearTimeout(hideTimer);
      options.onVisibility(false);
    });
    window.loadFile(path.join(__dirname, '..', 'game-overlay.html')).catch(error => {
      console.error('[overlay] No se pudo cargar:', error.message);
      visible = false;
      options.onVisibility(false);
      window?.destroy();
    });
  };
  function hide() {
    if (!visible) return;
    visible = false;
    searchGeneration += 1;
    options.onVisibility(false);
    send('game-overlay:visible', false);
    window?.setIgnoreMouseEvents(true);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!visible && window && !window.isDestroyed()) window.hide();
    }, 280);
  }
  function toggle() {
    if (disposed) return;
    if (visible) return hide();
    clearTimeout(hideTimer);
    visible = true;
    ensureWindow();
    options.onVisibility(true);
    present();
  }
  ipcMain.handle('game-overlay:ready', event => {
    if (!trusted(event)) throw new Error('Origen no permitido');
    ready = true;
    present();
    return options.getState();
  });
  const control = (event, action, value) => {
    if (!trusted(event) || !visible) return;
    if (action === 'close') return hide();
    if (['toggle', 'previous', 'next'].includes(action)) return options.onControl(action);
    if (['seek', 'volume', 'skip'].includes(action) && Number.isFinite(value)) {
      if (action === 'volume') value = Math.max(0, Math.min(1, value));
      if (action === 'seek') value = Math.max(0, Math.min(Number(options.getState().duration) || 0, value));
      if (action === 'skip') value = Math.max(-10, Math.min(10, value));
      options.onControl(action, value);
    }
  };
  ipcMain.on('game-overlay:control', control);
  ipcMain.handle('game-overlay:search', async (event, query) => {
    if (!trusted(event) || !visible) throw new Error('Overlay cerrado');
    const text = typeof query === 'string' ? query.trim().slice(0, 160) : '';
    if (text.length < 2) return [];
    if (searchPending || Date.now() - lastSearchAt < 700) throw new Error('Espera un momento antes de volver a buscar');
    searchPending = true; lastSearchAt = Date.now();
    const generation = ++searchGeneration;
    try {
      const tracks = await options.search(text);
      if (disposed || !visible || generation !== searchGeneration) return [];
      results.clear();
      const selected = tracks.slice(0, 12);
      selected.forEach(track => results.set(String(track.id), track));
      return selected;
    } finally { searchPending = false; }
  });
  ipcMain.handle('game-overlay:play', (event, id) => {
    if (!trusted(event) || !visible) throw new Error('Origen no permitido');
    const track = results.get(String(id));
    if (!track) throw new Error('Vuelve a buscar la canción');
    options.onPlay(track);
    return { ok: true };
  });
  const registered = globalShortcut.register(shortcut, toggle);
  if (!registered) console.warn('[overlay] Ctrl+L no disponible: otro programa usa el atajo.');
  return {
    toggle,
    getStatus: () => ({ shortcut: 'Ctrl + L', registered, visible }),
    publish: state => { if (visible) send('game-overlay:state', state); },
    dispose() {
      disposed = true; visible = false;
      clearTimeout(hideTimer);
      if (registered) globalShortcut.unregister(shortcut);
      ipcMain.removeListener('game-overlay:control', control);
      for (const channel of ['ready', 'search', 'play']) ipcMain.removeHandler(`game-overlay:${channel}`);
      options.onVisibility(false);
      window?.destroy(); window = null;
      results.clear();
    }
  };
}
module.exports = { createGameOverlay };
