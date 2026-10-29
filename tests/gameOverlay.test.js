const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function fixture() {
  const handlers = new Map();
  const ipc = new EventEmitter();
  ipc.handle = (name, callback) => handlers.set(name, callback);
  ipc.removeHandler = name => handlers.delete(name);
  const windows = [];
  const timers = new Map();
  let timerId = 0;
  let shortcutCallback;
  const registered = [];
  const unregistered = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (...args) => this.messages.push(args);
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    setBounds(bounds) { this.bounds = bounds; }
    setIgnoreMouseEvents(value) { this.ignoresMouse = value; }
    setAlwaysOnTop() {}
    show() { this.shown = true; }
    hide() { this.shown = false; }
    focus() {}
    loadFile() { return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/gameOverlay.js'), 'utf8'), {
    require: name => name === 'electron' ? {
      BrowserWindow: Window, ipcMain: ipc,
      screen: { getCursorScreenPoint: () => ({ x: -500, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }) },
      globalShortcut: { register: (key, callback) => { registered.push(key); shortcutCallback = callback; return true; }, unregister: key => unregistered.push(key) }
    } : require(name),
    __dirname: path.join(__dirname, '../services'), module, console,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  const controls = [], visibility = [], played = [];
  const overlay = module.exports.createGameOverlay({
    getState: () => ({ duration: 180, title: 'Test' }),
    onControl: (...args) => controls.push(args), onVisibility: value => visibility.push(value),
    onPlay: track => played.push(track), search: async () => [{ id: 'test-track', title: 'Track' }]
  });
  const event = () => ({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame });
  return { overlay, controls, visibility, played, windows, handlers, ipc, event, registered, unregistered,
    hotkey: () => shortcutCallback(), flushTimers: () => { for (const callback of timers.values()) callback(); timers.clear(); } };
}

test('overlay Ctrl+L abre a la izquierda del monitor y permite reabrir durante el cierre', () => {
  const f = fixture();
  assert.equal(f.registered[0], 'Control+L');
  f.hotkey();
  f.handlers.get('game-overlay:ready')(f.event());
  const win = f.windows[0];
  assert.equal(win.shown, true);
  assert.equal(win.bounds.x, -1908);
  assert.equal(win.options.skipTaskbar, true);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  f.hotkey();
  assert.equal(win.ignoresMouse, true);
  f.hotkey();
  f.flushTimers();
  assert.equal(win.shown, true);
  assert.equal(win.ignoresMouse, false);
  win.emit('blur'); f.flushTimers();
  assert.equal(win.shown, false);
  f.overlay.dispose();
  assert.equal(f.unregistered[0], 'Control+L');
  assert.equal(f.handlers.size, 0);
});

test('overlay valida origen, controles y límites de volumen y desplazamiento', () => {
  const f = fixture(); f.hotkey(); f.handlers.get('game-overlay:ready')(f.event());
  f.ipc.emit('game-overlay:control', { sender: {} }, 'next');
  assert.equal(f.controls.length, 0);
  f.ipc.emit('game-overlay:control', f.event(), 'volume', 9);
  f.ipc.emit('game-overlay:control', f.event(), 'seek', 9999);
  f.ipc.emit('game-overlay:control', f.event(), 'skip', -999);
  assert.deepEqual(f.controls, [['volume', 1], ['seek', 180], ['skip', -10]]);
  f.hotkey();
  f.ipc.emit('game-overlay:control', f.event(), 'next');
  assert.equal(f.controls.length, 3);
  f.overlay.dispose();
});

test('overlay reproduce sólo resultados buscados y rechaza IPC de otros renderers', async () => {
  const f = fixture(); f.hotkey(); f.handlers.get('game-overlay:ready')(f.event());
  await assert.rejects(f.handlers.get('game-overlay:search')({ sender: {} }, 'test'), /Overlay cerrado/);
  const tracks = await f.handlers.get('game-overlay:search')(f.event(), 'test');
  assert.equal(tracks.length, 1);
  assert.throws(() => f.handlers.get('game-overlay:play')(f.event(), 'injected'), /Vuelve a buscar/);
  f.handlers.get('game-overlay:play')(f.event(), 'test-track');
  assert.equal(f.played[0].id, 'test-track');
  f.overlay.dispose();
});
