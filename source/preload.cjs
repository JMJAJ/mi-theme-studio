const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('themeStudio', {
  openTheme: () => ipcRenderer.invoke('theme:open'),
  pickAssets: (multiple = true) => ipcRenderer.invoke('theme:pick-assets', multiple),
  saveTheme: (name, data) => ipcRenderer.invoke('theme:save', name, data)
});
