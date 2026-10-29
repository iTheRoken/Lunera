const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('luneraOverlay', {
  ready: () => ipcRenderer.invoke('game-overlay:ready'),
  control: (action, value) => ipcRenderer.send('game-overlay:control', action, value),
  search: query => ipcRenderer.invoke('game-overlay:search', query),
  play: id => ipcRenderer.invoke('game-overlay:play', id),
  onState: callback => ipcRenderer.on('game-overlay:state', (_event, state) => callback(state)),
  onVisible: callback => ipcRenderer.on('game-overlay:visible', (_event, visible) => callback(visible))
});
