const { autoUpdater } = require('electron-updater');

function getReleaseNotes(releaseNotes) {
  if (typeof releaseNotes === 'string') return releaseNotes.trim().slice(0, 12000);
  if (!Array.isArray(releaseNotes)) return '';

  return releaseNotes
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!entry || typeof entry !== 'object') return '';
      const note = entry.note || entry.text;
      return typeof note === 'string' ? note : '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
    .slice(0, 12000);
}

function createUpdateStatus(info = {}) {
  return {
    version: String(info.version || '').trim() || 'Nueva versión',
    releaseName: String(info.releaseName || '').trim(),
    releaseNotes: getReleaseNotes(info.releaseNotes),
    releaseDate: String(info.releaseDate || '').trim()
  };
}

function startAppUpdater({
  app,
  getWindow = () => null,
  isNetworkEnabled = () => true,
  updater = autoUpdater
}) {
  let downloadedUpdate = null;
  let installRequested = false;
  let checking = false;
  let stopped = false;
  const logError = (error) => console.error('[updates]', error.message || error);

  const getStatus = () => downloadedUpdate ? { ...downloadedUpdate } : null;
  const install = () => {
    if (!downloadedUpdate || installRequested) return false;

    installRequested = true;
    try {
      updater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      installRequested = false;
      logError(error);
      return false;
    }
  };

  const controller = { getStatus, install };
  if (!app?.isPackaged || process.platform !== 'win32') return controller;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;

  updater.on('error', logError);
  updater.on('update-downloaded', (info) => {
    if (stopped) return;
    downloadedUpdate = createUpdateStatus(info);

    try {
      const window = typeof getWindow === 'function' ? getWindow() : null;
      const webContents = window && !window.isDestroyed?.() ? window.webContents : null;
      if (webContents && !webContents.isDestroyed?.()) {
        webContents.send('app-update:ready', getStatus());
      }
    } catch (error) {
      logError(error);
    }
  });

  const check = async () => {
    if (stopped || checking || !isNetworkEnabled()) return;
    checking = true;
    try { await updater.checkForUpdates(); }
    catch (error) { logError(error); }
    finally { checking = false; }
  };
  const initialTimer = setTimeout(check, 15000);
  const interval = setInterval(check, 6 * 60 * 60 * 1000);
  initialTimer.unref();
  interval.unref();
  app.once('before-quit', () => {
    stopped = true;
    clearTimeout(initialTimer);
    clearInterval(interval);
  });

  return controller;
}

module.exports = { startAppUpdater };
