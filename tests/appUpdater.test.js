const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function createMainWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      send: (...args) => sent.push(args)
    }
  };
}

function setup({ packaged = true, online = true, window = createMainWindow() } = {}) {
  const updater = new EventEmitter();
  let checks = 0;
  let installs = 0;
  updater.checkForUpdates = async () => { checks++; };
  updater.quitAndInstall = () => { installs++; };
  const timers = [];
  const cleared = [];
  const context = {
    require: () => ({ autoUpdater: updater }), module: { exports: {} },
    process: { platform: 'win32' }, console,
    setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
    setInterval: (fn) => { timers.push(fn); return { unref() {} }; },
    clearTimeout: (timer) => cleared.push(timer), clearInterval: (timer) => cleared.push(timer)
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../services/appUpdater'), 'utf8'), context);
  const app = new EventEmitter();
  app.isPackaged = packaged;
  const controller = context.module.exports.startAppUpdater({
    app,
    updater,
    getWindow: () => window,
    isNetworkEnabled: () => online
  });
  return {
    updater,
    app,
    controller,
    sent: window.sent,
    timers,
    cleared,
    checks: () => checks,
    installs: () => installs
  };
}

test('development does not start update checks', () => {
  const state = setup({ packaged: false });
  assert.equal(state.timers.length, 0);
  assert.equal(state.controller.getStatus(), null);
  assert.equal(state.controller.install(), false);
});
test('offline mode skips checks', async () => {
  const state = setup({ online: false });
  await state.timers[0]();
  assert.equal(state.checks(), 0);
});
test('checks automatically and clears timers on quit', async () => {
  const state = setup();
  await state.timers[0]();
  assert.equal(state.checks(), 1);
  assert.equal(state.updater.autoDownload, true);
  assert.equal(state.updater.autoInstallOnAppQuit, true);
  state.app.emit('before-quit');
  await state.timers[1]();
  assert.equal(state.checks(), 1);
  assert.equal(state.cleared.length, 2);
});
test('downloaded update notifies the main window and installs only on request', async () => {
  const state = setup();

  assert.equal(state.controller.install(), false);
  assert.equal(state.installs(), 0);

  state.updater.emit('update-downloaded', {
    version: '1.3.0',
    releaseName: 'Novedades de Lunera',
    releaseNotes: [{ note: 'Mejoras de estabilidad y rendimiento.' }]
  });
  await new Promise(setImmediate);

  const status = state.controller.getStatus();
  assert.equal(status.version, '1.3.0');
  assert.equal(status.releaseName, 'Novedades de Lunera');
  assert.equal(status.releaseNotes, 'Mejoras de estabilidad y rendimiento.');
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0][0], 'app-update:ready');
  assert.equal(state.sent[0][1].version, '1.3.0');
  assert.equal(state.installs(), 0);

  assert.equal(state.controller.install(), true);
  assert.equal(state.installs(), 1);
  assert.equal(state.controller.install(), false);
  assert.equal(state.installs(), 1);
});
test('download/check errors do not crash the application', async () => {
  const state = setup();
  state.updater.checkForUpdates = async () => { throw new Error('network unavailable'); };
  await state.timers[0]();
  state.updater.emit('error', new Error('download unavailable'));
});
