const { autoUpdater } = require('electron-updater');

function startAppUpdater({ app, dialog, getWindow, isNetworkEnabled, updater = autoUpdater }) {
  if (!app.isPackaged || process.platform !== 'win32') return;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  let checking = false;
  let stopped = false;
  const logError = (error) => console.error('[updates]', error.message || error);

  updater.on('error', logError);
  updater.on('update-downloaded', async (info) => {
    if (stopped) return;
    try {
      const window = getWindow();
      const options = {
        type: 'info',
        title: 'Actualización disponible',
        message: `Lunera ${info.version} está lista para instalar.`,
        detail: 'Puedes reiniciar ahora o seguir escuchando música. Se instalará al cerrar la aplicación.',
        buttons: ['Reiniciar e instalar', 'Más tarde'],
        defaultId: 1,
        cancelId: 1
      };
      const result = window && !window.isDestroyed()
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      if (!stopped && result.response === 0) updater.quitAndInstall(false, true);
    } catch (error) { logError(error); }
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
}

module.exports = { startAppUpdater };
