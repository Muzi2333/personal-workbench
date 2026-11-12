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
  launchProxied: (payload) => ipcRenderer.invoke('target:launch-proxy', payload),
  icon: (filePath) => ipcRenderer.invoke('target:icon', filePath),
  fetchFavicon: (url) => ipcRenderer.invoke('icon:fetch-favicon', url),
  faviconFromPage: (url) => ipcRenderer.invoke('icon:favicon-from-page', url),
  appVersion: () => ipcRenderer.invoke('app:version'),
  pick: (options) => ipcRenderer.invoke('target:pick', options),
  reveal: (filePath) => ipcRenderer.invoke('target:reveal', filePath),
  resolveShortcut: (filePath) => ipcRenderer.invoke('target:resolve', filePath),

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

  // 电脑休息提醒（主进程 rest.js）
  rest: {
    getConfig: () => ipcRenderer.invoke('rest:get-config'),
    setConfig: (patch) => ipcRenderer.invoke('rest:set-config', patch),
    getStatus: () => ipcRenderer.invoke('rest:get-status'),
    remindNow: () => ipcRenderer.invoke('rest:remind-now'),
    forceNow: () => ipcRenderer.invoke('rest:force-now'),
    closeCountdown: () => ipcRenderer.invoke('rest:countdown-close'),
    closeReminder: () => ipcRenderer.invoke('rest:reminder-close'),
    openPassword: () => ipcRenderer.invoke('rest:force-open-password'),
    verifyPassword: (password) => ipcRenderer.invoke('rest:force-password', password),
    closePassword: () => ipcRenderer.invoke('rest:force-close-password'),
    onStatus: (cb) => ipcRenderer.on('rest:status', (_e, s) => cb(s)),
  },

  // 主题：dark / light / system
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    set: (source) => ipcRenderer.invoke('theme:set', source),
    onChange: (cb) => ipcRenderer.on('theme:changed', (_e, t) => cb(t)),
  },

  // 贴边自动收起（QQ 式吸边）
  edgeSnap: {
    set: (enabled) => ipcRenderer.invoke('edge-snap:set', enabled),
    get: () => ipcRenderer.invoke('edge-snap:get'),
  },

  // 自动更新（GitHub Releases）
  updates: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (cb) => ipcRenderer.on('update:state', (_e, s) => cb(s)),
  },

  // Edge 浏览器书签读取（用于收藏夹导入 / 同步）
  edge: {
    readBookmarks: () => ipcRenderer.invoke('edge:read-bookmarks'),
  },

  // 主进程拦截的新窗口请求 → 通知渲染进程在内嵌浏览器新开标签页
  onBrowserNewTab: (cb) => ipcRenderer.on('browser:new-tab', (e, url) => cb(url)),

  // 代理管理（mihomo 内核）
  proxy: {
    getState: () => ipcRenderer.invoke('proxy:get-state'),
    downloadCore: () => ipcRenderer.invoke('proxy:download-core'),
    pickCore: () => ipcRenderer.invoke('proxy:pick-core'),
    start: () => ipcRenderer.invoke('proxy:start'),
    stop: () => ipcRenderer.invoke('proxy:stop'),
    addSub: (payload) => ipcRenderer.invoke('proxy:add-sub', payload),
    refreshSub: (id) => ipcRenderer.invoke('proxy:refresh-sub', id),
    deleteSub: (id) => ipcRenderer.invoke('proxy:delete-sub', id),
    useSub: (id) => ipcRenderer.invoke('proxy:use-sub', id),
    setSysProxy: (on) => ipcRenderer.invoke('proxy:set-sysproxy', on),
    setSelfProxy: (on) => ipcRenderer.invoke('proxy:set-selfproxy', on),
    setAutoStart: (on) => ipcRenderer.invoke('proxy:set-auto-start', on),
    setAutoSelfProxy: (on) => ipcRenderer.invoke('proxy:set-auto-self', on),
    setTun: (on) => ipcRenderer.invoke('proxy:set-tun', on),
    relaunchAdminForTun: () => ipcRenderer.invoke('proxy:relaunch-admin-tun'),
    setMode: (mode) => ipcRenderer.invoke('proxy:set-mode', mode),
    setNodeKeywords: (payload) => ipcRenderer.invoke('proxy:set-node-keywords', payload),
    getProxies: () => ipcRenderer.invoke('proxy:get-proxies'),
    select: (group, node) => ipcRenderer.invoke('proxy:select', group, node),
    testDelay: (name, mode) => ipcRenderer.invoke('proxy:test-delay', name, mode),
    testGroup: (group, mode) => ipcRenderer.invoke('proxy:test-group', group, mode),
    testDelayUrl: (url) => ipcRenderer.invoke('proxy:test-delay-url', url),
    fetchIpInfo: () => ipcRenderer.invoke('proxy:fetch-ip'),
    getTraffic: () => ipcRenderer.invoke('proxy:get-traffic'),
    liteStatus: () => ipcRenderer.invoke('proxy:lite-status'),
    onCoreProgress: (cb) => ipcRenderer.on('proxy:core-progress', (_e, s) => cb(s)),
    onState: (cb) => ipcRenderer.on('proxy:state', (_e, s) => cb(s)),
  },

  // Telegram：webview 注入脚本路径 + 媒体静默保存
  telegram: {
    preloadPath: () => ipcRenderer.invoke('app:tg-preload-path'),
    saveMedia: (payload) => ipcRenderer.invoke('tg:save-media', payload),
  },
});
