const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', () => fn()),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
});
