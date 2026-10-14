const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function setup(packaged = true, online = true, response = 1) {
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
  context.module.exports.startAppUpdater({ app, updater,
    dialog: { showMessageBox: async () => ({ response }) },
    getWindow: () => null, isNetworkEnabled: () => online });
  return { updater, app, timers, cleared, checks: () => checks, installs: () => installs };
}

test('development does not start update checks', () => {
  assert.equal(setup(false).timers.length, 0);
});
test('offline mode skips checks', async () => {
  const state = setup(true, false);
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
test('restart happens only when selected', async () => {
  for (const response of [0, 1]) {
    const state = setup(true, true, response);
    state.updater.emit('update-downloaded', { version: '1.3.0' });
    await new Promise(setImmediate);
    assert.equal(state.installs(), response === 0 ? 1 : 0);
  }
});
test('download/check errors do not crash the application', async () => {
  const state = setup();
  state.updater.checkForUpdates = async () => { throw new Error('network unavailable'); };
  await state.timers[0]();
  state.updater.emit('error', new Error('download unavailable'));
});
