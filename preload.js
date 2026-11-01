const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('workbench', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  exportData: (data) => ipcRenderer.invoke('data:export', data),
  importData: () => ipcRenderer.invoke('data:import'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  getAutoLaunch: () => ipcRenderer.invoke('app:get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('app:set-auto-launch', enabled),

  launch: (payload) => ipcRenderer.invoke('target:launch', payload),
  icon: (filePath) => ipcRenderer.invoke('target:icon', filePath),
  fetchFavicon: (url) => ipcRenderer.invoke('icon:fetch-favicon', url),
  faviconFromPage: (url) => ipcRenderer.invoke('icon:favicon-from-page', url),
  appVersion: () => ipcRenderer.invoke('app:version'),
  pick: (options) => ipcRenderer.invoke('target:pick', options),
  reveal: (filePath) => ipcRenderer.invoke('target:reveal', filePath),

  pathForFile: (file) => {
    try {
      if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file);
    } catch (_) {}
    return (file && file.path) || '';
  },

  win: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMax: () => ipcRenderer.send('window:toggle-max'),
    close: () => ipcRenderer.send('window:close'),
  },

  onWindowState: (cb) => ipcRenderer.on('window:state', (_e, s) => cb(s)),
});
