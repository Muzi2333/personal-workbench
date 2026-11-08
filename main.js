const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, screen, net, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { createRestManager } = require('./rest');

// 任务管理器 / 任务栏分组名（打包后进程名由 exe 文件名决定，这里设置内部名）
app.setName('工作台');
app.setAppUserModelId('com.muzi.workbench');

let win = null;
let tray = null;
let restManager = null;

// 贴边自动收起（QQ 式吸边）
const EDGE_SNAP = {
  enabled: false,
  threshold: 8,        // 窗口边缘离屏幕边缘 ≤ 8px → 触发贴边
  strip: 4,            // 收起后露出的窄条（2-6px）
  rehideDelay: 900,    // 鼠标移开窗口后多少 ms 重新收起
  pollInterval: 120,   // 鼠标位置轮询间隔
  snapTimer: null,     // 窗口停止移动的防抖计时器
  rehideTimer: null,   // 重新收起延迟计时器
  pollTimer: null,     // 鼠标位置轮询
  saved: null,         // 收起前 bounds {x,y,width,height}
  edge: null,          // 'left' | 'right' | 'top' | null
  snapBySys: false,    // true = 本次移动是吸边管理器自己做的（跳过触发检测）
};

function initEdgeSnap() {
  // 读一次数据文件里的 edgeSnap 设置（跟 data:load 无关，启动时尽早恢复）
  try {
    if (fs.existsSync(dataFile())) {
      const raw = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
      EDGE_SNAP.enabled = !!(raw && raw.settings && raw.settings.edgeSnap);
    }
  } catch (_) {}
}

function getWorkAreaForBounds(bounds) {
  try {
    const d = screen.getDisplayMatching(bounds || win.getBounds());
    return d.workArea;
  } catch (_) {
    return screen.getPrimaryDisplay().workArea;
  }
}

// 检测窗口是否贴近屏幕某条边缘，返回边名或 null
function detectEdge(bounds) {
  const work = getWorkAreaForBounds(bounds);
  if (bounds.x - work.x <= EDGE_SNAP.threshold) return 'left';
  if ((work.x + work.width) - (bounds.x + bounds.width) <= EDGE_SNAP.threshold) return 'right';
  if (bounds.y - work.y <= EDGE_SNAP.threshold) return 'top';
  // 下边任务栏太常用，默认不吸（避免和任务栏图标冲突）
  return null;
}

function snapToEdge() {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isMinimized()) return;
  if (EDGE_SNAP.edge) return; // 已经是收起态了

  const bounds = win.getBounds();
  const edge = detectEdge(bounds);
  if (!edge) return;

  EDGE_SNAP.saved = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  EDGE_SNAP.edge = edge;

  const work = getWorkAreaForBounds(bounds);
  let nx = bounds.x, ny = bounds.y;
  if (edge === 'left')      nx = work.x - (bounds.width - EDGE_SNAP.strip);
  else if (edge === 'right') nx = (work.x + work.width) - EDGE_SNAP.strip;
  else if (edge === 'top')   ny = work.y - (bounds.height - EDGE_SNAP.strip);

  EDGE_SNAP.snapBySys = true;
  win.setBounds({ x: nx, y: ny, width: bounds.width, height: bounds.height });
  setTimeout(() => { EDGE_SNAP.snapBySys = false; }, 200);

  startEdgeSnapPolling();
}

function unsnapToShow() {
  if (!EDGE_SNAP.edge || !EDGE_SNAP.saved) return;
  clearTimeout(EDGE_SNAP.rehideTimer);
  const s = EDGE_SNAP.saved;
  EDGE_SNAP.saved = null;
  EDGE_SNAP.edge = null;
  EDGE_SNAP.snapBySys = true;
  win.setBounds({ x: s.x, y: s.y, width: s.width, height: s.height });
  win.show();
  win.focus();
  setTimeout(() => { EDGE_SNAP.snapBySys = false; }, 200);
}

function scheduleResnap() {
  if (!EDGE_SNAP.edge) return;
  clearTimeout(EDGE_SNAP.rehideTimer);
  EDGE_SNAP.rehideTimer = setTimeout(() => {
    // 用户在延迟期可能又移动了窗口 → 重新判断
    if (!EDGE_SNAP.edge || !EDGE_SNAP.saved) return;
    if (!win || win.isDestroyed() || win.isMaximized() || win.isMinimized()) return;
    // 还原到 saved，再按当前屏幕位置重新判断边缘
    const s = EDGE_SNAP.saved;
    EDGE_SNAP.edge = null;
    EDGE_SNAP.saved = null;
    EDGE_SNAP.snapBySys = true;
    win.setBounds({ x: s.x, y: s.y, width: s.width, height: s.height });
    setTimeout(() => {
      EDGE_SNAP.snapBySys = false;
      if (EDGE_SNAP.enabled) snapToEdge();
    }, 220);
  }, EDGE_SNAP.rehideDelay);
}

function startEdgeSnapPolling() {
  if (EDGE_SNAP.pollTimer) return;
  EDGE_SNAP.pollTimer = setInterval(() => {
    if (!EDGE_SNAP.enabled || !EDGE_SNAP.edge) return;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (win.isMaximized() || win.isMinimized()) return;

    const cursor = screen.getCursorScreenPoint();
    const saved = EDGE_SNAP.saved;
    const work = getWorkAreaForBounds(saved);

    // 1) 鼠标在完整窗口区域内 → 立即展开
    if (cursor.x >= saved.x && cursor.x <= saved.x + saved.width
        && cursor.y >= saved.y && cursor.y <= saved.y + saved.height) {
      unsnapToShow();
      return;
    }

    // 2) 鼠标在细条区域内 → 立即展开（给 60px 纵向/横向余量，方便碰到）
    const m = 60;
    let inStrip = false;
    if (EDGE_SNAP.edge === 'left') {
      inStrip = cursor.x >= work.x - 4 && cursor.x <= work.x + EDGE_SNAP.strip + 4
                && cursor.y >= saved.y - m && cursor.y <= saved.y + saved.height + m;
    } else if (EDGE_SNAP.edge === 'right') {
      const rx = work.x + work.width;
      inStrip = cursor.x >= rx - EDGE_SNAP.strip - 4 && cursor.x <= rx + 4
                && cursor.y >= saved.y - m && cursor.y <= saved.y + saved.height + m;
    } else if (EDGE_SNAP.edge === 'top') {
      inStrip = cursor.y >= work.y - 4 && cursor.y <= work.y + EDGE_SNAP.strip + 4
                && cursor.x >= saved.x - m && cursor.x <= saved.x + saved.width + m;
    }
    if (inStrip) { unsnapToShow(); return; }

    // 3) 鼠标在外面 → 保持收起（resnap 定时器在 unsnap 时会清）
  }, EDGE_SNAP.pollInterval);
}

function stopEdgeSnapPolling() {
  if (EDGE_SNAP.pollTimer) { clearInterval(EDGE_SNAP.pollTimer); EDGE_SNAP.pollTimer = null; }
}

function setEdgeSnapEnabled(enabled) {
  EDGE_SNAP.enabled = !!enabled;
  if (!enabled) {
    // 关闭贴边时立即还原当前收起的窗口
    if (EDGE_SNAP.edge && EDGE_SNAP.saved) unsnapToShow();
    stopEdgeSnapPolling();
    clearTimeout(EDGE_SNAP.snapTimer);
    clearTimeout(EDGE_SNAP.rehideTimer);
  } else if (!EDGE_SNAP.pollTimer) {
    startEdgeSnapPolling();
  }
}

// 监听窗口停止移动 → 判断是否吸边（debounce）
function wireEdgeSnapWindowEvents() {
  if (!win) return;
  const onMoved = () => {
    if (!EDGE_SNAP.enabled) return;
    if (EDGE_SNAP.snapBySys) return;
    if (win.isMaximized() || win.isMinimized()) return;
    clearTimeout(EDGE_SNAP.snapTimer);
    EDGE_SNAP.snapTimer = setTimeout(() => {
      const bounds = win.getBounds();
      // 如果已经在收起态，说明是从吸边位置被用户拖出来的 → 还原 saved 边界然后检测新边
      if (EDGE_SNAP.edge && EDGE_SNAP.saved) {
        const saved = EDGE_SNAP.saved;
        EDGE_SNAP.edge = null;
        EDGE_SNAP.saved = null;
        // 若当前位置已经远离所有边缘，就不再吸
        if (!detectEdge(bounds)) return;
        EDGE_SNAP.snapBySys = true;
        win.setBounds({ x: saved.x, y: saved.y, width: saved.width, height: saved.height });
        setTimeout(() => { EDGE_SNAP.snapBySys = false; snapToEdge(); }, 220);
        return;
      }
      snapToEdge();
    }, 260);
  };
  win.on('moved', onMoved);
  win.on('closed', () => { stopEdgeSnapPolling(); clearTimeout(EDGE_SNAP.snapTimer); clearTimeout(EDGE_SNAP.rehideTimer); });
  win.on('maximize', () => {
    if (EDGE_SNAP.edge && EDGE_SNAP.saved) unsnapToShow();
  });
  win.on('minimize', () => {
    clearTimeout(EDGE_SNAP.snapTimer);
    clearTimeout(EDGE_SNAP.rehideTimer);
  });
}

const dataFile = () => path.join(app.getPath('userData'), 'data.json');
const backupFile = () => path.join(app.getPath('userData'), 'data.backup.json');

function showMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

// 登录项：写入与读取必须用同一组 path/args，否则命令行比对不一致，永远读回 false
const loginItemOpts = () => ({ path: process.execPath, args: [app.getAppPath()] });

function getAutoLaunch() {
  try { return app.getLoginItemSettings(loginItemOpts()).openAtLogin; } catch (_) { return false; }
}

function setAutoLaunch(enabled) {
  app.setLoginItemSettings(Object.assign({ openAtLogin: !!enabled }, loginItemOpts()));
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: showMainWindow },
    { label: '开机自动启动', type: 'checkbox', checked: getAutoLaunch(), click: (item) => {
      try { setAutoLaunch(item.checked); } catch (_) {}
      rebuildTrayMenu(); // 以真实状态重建，失败时复选框自动回弹
    } },
    { type: 'separator' },
    { label: '立即提醒休息', click: () => restManager && restManager.remindNow() },
    { label: '立即强制休息', click: () => restManager && restManager.forceNow() },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('工作台');
  rebuildTrayMenu();
  tray.on('click', showMainWindow);
}

// 倒计时统一文案：>60 秒显示「X分」（向上取整），≤60 秒显示「X秒」
function fmtRemain(sec) {
  const s = Math.max(0, Math.ceil(Number(sec) || 0));
  return s > 60 ? Math.ceil(s / 60) + '分' : s + '秒';
}

// 托盘悬浮提示：实时显示休息状态与倒计时
function updateTrayTip(status) {
  if (!tray) return;
  if (!status || !status.enabled) { tray.setToolTip('工作台'); return; }
  let line = '';
  if (status.state === 'idle') line = '空闲中';
  else if (status.state === 'working') {
    const remain = Math.max(0, (Number(status.workSecondsTotal) || 0) - (Number(status.usedSeconds) || 0));
    line = fmtRemain(remain) + '后提醒休息';
  } else if (status.state === 'reminding') line = '休息倒计时 ' + fmtRemain(status.countdownSeconds);
  else if (status.state === 'resting') {
    line = status.mode === 'mode2'
      ? '强制休息中 · 锁屏中'
      : '强制休息还剩 ' + fmtRemain(status.restSeconds);
  }
  tray.setToolTip('工作台 · ' + line);
}

function createWindow() {
  // 目标最小/默认尺寸按物理像素思考，换算成 DIP：高缩放屏幕上 DIP 偏小才能缩到预期大小
  initEdgeSnap();
  const sf = (screen.getPrimaryDisplay() && screen.getPrimaryDisplay().scaleFactor) || 1;
  const work = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(Math.round(1400 / Math.max(sf, 1)), work.width),
    height: Math.min(Math.round(920 / Math.max(sf, 1)), work.height),
    minWidth: Math.round(800 / sf),
    minHeight: Math.round(600 / sf),
    frame: false,
    show: false,
    backgroundColor: '#1a1b1c',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 关闭按钮 = 隐藏到托盘，只有托盘右键「退出」才真正结束进程
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  const pushState = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('window:state', { maximized: win.isMaximized() });
    }
  };
  win.on('maximize', pushState);
  win.on('unmaximize', pushState);

  wireEdgeSnapWindowEvents();
}

// 单实例：已运行时再次启动只唤起现有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  // 主题：dark / light / system（Electron nativeTheme）
  function applyThemeSource(source) {
    if (source === 'light' || source === 'dark' || source === 'system') {
      nativeTheme.themeSource = source;
    } else {
      nativeTheme.themeSource = 'system';
    }
  }
  function broadcastTheme() {
    const payload = {
      source: nativeTheme.themeSource,
      dark: nativeTheme.shouldUseDarkColors,
    };
    try {
      // 发给所有 BrowserWindow（主窗口 + rest.js 的 countdown/reminder/force/password 子窗口）
      const { BrowserWindow } = require('electron');
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) w.webContents.send('theme:changed', payload);
      });
    } catch (_) {}
  }
  function loadAndApplyTheme() {
    let source = 'system';
    try {
      if (fs.existsSync(dataFile())) {
        const raw = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
        if (raw && raw.settings && raw.settings.theme) source = raw.settings.theme;
      }
    } catch (_) {}
    applyThemeSource(source);
  }

  app.whenReady().then(() => {
    loadAndApplyTheme();
    nativeTheme.on('updated', broadcastTheme);
    createWindow();
    createTray();
    restManager = createRestManager({ getMainWindow: () => win, onStatus: updateTrayTip });
    updateTrayTip(restManager.getStatus());
    broadcastTheme();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 退出时必须停止休息模块的定时器与系统事件监听，避免后台残留逻辑
  app.on('before-quit', () => {
    app.isQuitting = true;
    if (restManager) {
      restManager.destroy();
      restManager = null;
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/* ---------------------------------- 数据 ---------------------------------- */

ipcMain.handle('data:load', async () => {
  try {
    if (!fs.existsSync(dataFile())) return null;
    const raw = fs.readFileSync(dataFile(), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[data:load]', err);
    return null;
  }
});

ipcMain.handle('data:save', async (_e, data) => {
  try {
    const file = dataFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, backupFile()); } catch (_) {}
      fs.rmSync(file, { force: true });
    }
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    console.error('[data:save]', err);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('data:export', async (_e, data) => {
  const res = await dialog.showSaveDialog(win, {
    title: '导出配置',
    defaultPath: 'workbench-config.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('data:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '导入配置',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  try {
    const data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: '文件不是有效的配置文件' };
  }
});

ipcMain.handle('app:open-data-dir', async () => {
  shell.openPath(app.getPath('userData'));
  return { ok: true };
});

/* -------------------------------- 开机自启动 -------------------------------- */
// 开关在托盘右键菜单（checkbox）。保留 IPC 供冒烟测试与未来渲染层使用。

ipcMain.handle('app:get-auto-launch', async () => ({ ok: true, enabled: getAutoLaunch() }));

ipcMain.handle('app:set-auto-launch', async (_e, enabled) => {
  try {
    setAutoLaunch(enabled);
    rebuildTrayMenu();
    return { ok: true, enabled: !!enabled };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

/* ------------------------------- 启动本地程序 ------------------------------- */

function splitArgs(str) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of String(str || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const SHELL_EXTS = ['.bat', '.cmd', '.ps1'];
const SPAWN_EXTS = ['.exe', '.com'];

async function launchTarget({ target, args, cwd } = {}) {
  const raw = String(target || '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) return { ok: false, error: '启动目标为空' };

  // 1. 协议链接：http(s)、mailto、ms-settings: 等
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):(.*)$/i);
  const isDrive = /^[A-Za-z]:\\/.test(raw) || /^[A-Za-z]:$/.test(raw);
  if (scheme && !isDrive && (/^(https|http|mailto|file)$/i.test(scheme[1]) || raw.endsWith(':'))) {
    try {
      await shell.openExternal(raw);
      return { ok: true, mode: 'uri' };
    } catch (err) {
      return { ok: false, error: '无法打开链接：' + raw };
    }
  }

  const exists = fs.existsSync(raw);

  // 应用列表里的应用（UWP 包标识 / 无路径的应用 id）：交给 explorer 走 AppsFolder
  const appItemId = appsFolderIdOf(raw) || aumidOf(raw);
  if (appItemId) {
    try {
      const child = spawn('explorer.exe', ['shell:AppsFolder\\' + appItemId], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => console.error('[launch-uwp]', err));
      child.unref();
      return { ok: true, mode: 'uwp' };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  // 本地路径不存在：明确返回 NOT_FOUND 让上层决定是否弹提示
  // （URL 在上面 scheme 分支已经 return，能走到这儿的全是本地路径）
  if (!exists) {
    return { ok: false, code: 'NOT_FOUND', error: '找不到目标文件', target: raw };
  }

  // 2. 目录：交给系统打开
  if (exists) {
    let stat = null;
    try { stat = fs.statSync(raw); } catch (_) {}
    if (stat && stat.isDirectory()) {
      const err = await shell.openPath(raw);
      return err ? { ok: false, error: err } : { ok: true, mode: 'folder' };
    }
  }

  const ext = path.extname(raw).toLowerCase();
  const argList = splitArgs(args);
  const workDir = cwd && fs.existsSync(cwd) ? cwd : undefined;

  // 3. 需要带参数/工作目录的 exe，或者脚本 → 用 spawn
  if (exists && SPAWN_EXTS.includes(ext) && (argList.length || workDir)) {
    try {
      const child = spawn(raw, argList, { detached: true, stdio: 'ignore', cwd: workDir });
      child.on('error', (err) => console.error('[launch]', err));
      child.unref();
      return { ok: true, mode: 'spawn' };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  if (exists && SHELL_EXTS.includes(ext)) {
    try {
      const child = spawn(`"${raw}"`, argList, { detached: true, stdio: 'ignore', shell: true, cwd: workDir });
      child.on('error', (err) => console.error('[launch]', err));
      child.unref();
      return { ok: true, mode: 'script' };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  // 4. 普通文件 / 快捷方式 / 其他：交给系统（可正常弹 UAC）
  if (exists) {
    const err = await shell.openPath(raw);
    return err ? { ok: false, error: err } : { ok: true, mode: 'open' };
  }

  // 5. 不在绝对路径里（如 calc.exe、wt.exe），走 shell 让 PATH 解析
  try {
    const cmd = argList.length ? `"${raw}" ${args}` : `"${raw}"`;
    const child = spawn(cmd, [], { detached: true, stdio: 'ignore', shell: true, cwd: workDir });
    child.on('error', (err) => console.error('[launch]', err));
    child.unref();
    return { ok: true, mode: 'shell' };
  } catch (err) {
    return { ok: false, error: '找不到目标：' + raw };
  }
}

ipcMain.handle('target:launch', async (_e, payload) => {
  try {
    return await launchTarget(payload);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('theme:get', async () => ({
  source: nativeTheme.themeSource,
  dark: nativeTheme.shouldUseDarkColors,
}));

ipcMain.handle('theme:set', async (_e, source) => {
  applyThemeSource(source);
  broadcastTheme();
  return { ok: true, source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors };
});

// 高清图标：调 PowerShell + SHDefExtractIcon 取 256px（与桌面图标同源），失败回退 getFileIcon
// 打包后 tools/icon-extract.ps1 在 app.asar 内，PowerShell（外部进程）读不了，
// 启动时把脚本解到临时目录再调用（Electron 主进程可读 asar，写入的是原始字节，保留 BOM）
let ps1Path = null;
function ensureIconScript() {
  if (ps1Path) return ps1Path;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'tools', 'icon-extract.ps1'));
    ps1Path = path.join(os.tmpdir(), 'wb-icon-extract-' + process.pid + '.ps1');
    fs.writeFileSync(ps1Path, raw);
  } catch (_) {
    ps1Path = path.join(__dirname, 'tools', 'icon-extract.ps1'); // 开发模式兜底
  }
  return ps1Path;
}

function extractIconHD(iconSource) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), 'wb-icon-' + process.pid + '-' + Date.now() + '.png');
    execFile('powershell.exe', [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', ensureIconScript(),
      '-Path', iconSource, '-Out', out,
    ], { timeout: 20000 }, (err) => {
      try {
        if (!err && fs.existsSync(out) && fs.statSync(out).size > 0) {
          const data = 'data:image/png;base64,' + fs.readFileSync(out).toString('base64');
          fs.rmSync(out, { force: true });
          resolve(data);
          return;
        }
      } catch (_) {}
      resolve(null);
    });
  });
}

// 系统 Shell 里的图标（UWP 应用图标常打进 resources.pri，没有独立文件可读）
let shellPs1 = '';
function ensureShellIconScript() {
  if (shellPs1) return shellPs1;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'tools', 'icon-shell.ps1'));
    shellPs1 = path.join(os.tmpdir(), 'wb-icon-shell-' + process.pid + '.ps1');
    fs.writeFileSync(shellPs1, raw);
  } catch (_) {
    shellPs1 = path.join(__dirname, 'tools', 'icon-shell.ps1'); // 开发模式兜底
  }
  return shellPs1;
}

function shellItemIcon(shellPath) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), 'wb-icon-sh-' + process.pid + '-' + Date.now() + Math.random().toString(36).slice(2, 5) + '.png');
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', ensureShellIconScript(),
      '-Path', shellPath, '-Out', out,
    ], { timeout: 20000, windowsHide: true }, (err) => {
      try {
        if (!err && fs.existsSync(out) && fs.statSync(out).size > 0) {
          const data = 'data:image/png;base64,' + fs.readFileSync(out).toString('base64');
          fs.rmSync(out, { force: true });
          resolve(data);
          return;
        }
      } catch (_) {}
      resolve(null);
    });
  });
}

// 文件夹兜底图标（系统图标取不到时使用），保证文件夹 / 文件夹快捷方式有默认文件夹图标
const FOLDER_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
  + '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
  + '<stop offset="0" stop-color="#ffd66b"/><stop offset="1" stop-color="#f0ac16"/></linearGradient></defs>'
  + '<path d="M6 18a4 4 0 0 1 4-4h14l5 6h25a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="#dfa019"/>'
  + '<path d="M6 25h52v21a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="url(#g)"/>'
  + '</svg>'
);

/* --------------------------- UWP / 应用商店程序 --------------------------- */
// 应用商店（MSIX/UWP）程序的桌面快捷方式没有文件目标，只有包标识 AUMID，
// 形如 <PackageFamilyName>!<AppId>，例如 OpenAI.Codex_2p2nqsd0c76g0!App。
// 启动要走 shell:AppsFolder，图标要去包安装目录的 assets 里取。

const AUMID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*_[a-z0-9]{13}![A-Za-z0-9._-]+$/;

// 从 .lnk 二进制里读出 UWP 应用的包标识（快捷方式把它按 UTF-16LE 存着）
function aumidFromLnk(filePath) {
  try {
    const txt = fs.readFileSync(filePath).toString('utf16le');
    const m = txt.match(/[A-Za-z0-9][A-Za-z0-9._-]*_[a-z0-9]{13}![A-Za-z0-9._-]+/);
    return m ? m[0] : '';
  } catch (_) {
    return '';
  }
}

// 目标是否就是包标识（兼容 shell:AppsFolder\ 前缀）
function aumidOf(target) {
  const s = String(target || '').trim().replace(/^shell:AppsFolder\\/i, '');
  return AUMID_RE.test(s) ? s : '';
}

// 是否指向「应用列表」里的应用项（shell:AppsFolder\<id>，id 可能不带 !AppId）
function appsFolderIdOf(target) {
  const m = String(target || '').trim().match(/^shell:AppsFolder\\(.+)$/i);
  return m ? m[1].trim() : '';
}

// 是否是 AppsFolder 里的应用 id（如 VisualStudio.54cd7441、Pkg_hash!App）
function looksLikeAppId(s) {
  const v = String(s || '').trim();
  if (!v || /[\\/:*?"<>|]/.test(v)) return false;
  if (!/^[A-Za-z0-9]/.test(v)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) || AUMID_RE.test(v);
}

// 让系统 Shell 解析快捷方式目标（处理 IDList 型 / 链式快捷方式）
let lnkPs1 = '';
function ensureLnkScript() {
  if (lnkPs1) return lnkPs1;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'tools', 'lnk-target.ps1'));
    lnkPs1 = path.join(os.tmpdir(), 'wb-lnk-target-' + process.pid + '.ps1');
    fs.writeFileSync(lnkPs1, raw);
  } catch (_) {
    lnkPs1 = path.join(__dirname, 'tools', 'lnk-target.ps1');
  }
  return lnkPs1;
}

function shellResolveLnk(lnkPath) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), 'wb-lnk-' + process.pid + '-' + Date.now() + '.txt');
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', ensureLnkScript(),
      '-Path', lnkPath, '-Out', out,
    ], { timeout: 20000, windowsHide: true }, () => {
      try {
        const txt = fs.readFileSync(out, 'utf8');
        fs.rmSync(out, { force: true });
        const [parsing = '', target = ''] = txt.split('\t');
        resolve({ parsing: parsing.trim(), target: target.trim() });
      } catch (_) {
        resolve({ parsing: '', target: '' });
      }
    });
  });
}

// 部分快捷方式用 IDList 存目标，readShortcutLink 读不出路径，从二进制里捞绝对路径
function pathFromLnk(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const scan = (txt) => {
      const re = /[A-Za-z]:\\[^\u0000-\u001f<>|"?*]{2,300}?\.(?:exe|bat|cmd|com|msc|ps1)/gi;
      let m;
      while ((m = re.exec(txt))) {
        if (fs.existsSync(m[0])) return m[0];
      }
      return '';
    };
    return scan(buf.toString('utf16le')) || scan(buf.toString('latin1'));
  } catch (_) {
    return '';
  }
}

// 包家族名 → 安装目录（一次查询全部包，缓存 5 分钟）
let pkgMap = null;
let pkgMapAt = 0;
function listAppxPackages() {
  return new Promise((resolve) => {
    if (pkgMap && Date.now() - pkgMapAt < 5 * 60 * 1000) return resolve(pkgMap);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-AppxPackage | ForEach-Object { $_.PackageFamilyName + '|' + $_.InstallLocation }",
    ], { timeout: 20000 }, (err, stdout) => {
      const map = {};
      if (!err && stdout) {
        stdout.split(/\r?\n/).forEach((line) => {
          const i = line.indexOf('|');
          if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        });
      }
      // 查询失败也缓存（避免每次图标请求都卡一遍），30 秒后允许重试
      pkgMap = map;
      pkgMapAt = Date.now() - (err || !Object.keys(map).length ? 5 * 60 * 1000 - 30000 : 0);
      resolve(map);
    });
  });
}

// 解析 AUMID → { 安装目录, 图标文件, 可执行文件 }
async function uwpAppInfo(aumid) {
  const [family, appId = ''] = aumid.split('!');
  const map = await listAppxPackages();
  const loc = map[family];
  if (!loc) return null;

  let xml = '';
  try {
    xml = fs.readFileSync(path.join(loc, 'AppxManifest.xml'), 'utf8');
  } catch (_) {
    return { loc, logo: '', exe: '' };
  }

  // 在 <Application .../> 里找对应的那一项（找不到就用第一个）
  const chunks = xml.split(/<application\b/i).slice(1);
  const esc = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mine = chunks.find((s) => new RegExp('Id\\s*=\\s*"' + esc + '"', 'i').test(s)) || chunks[0] || '';
  const logoM = mine.match(/Square44x44Logo\s*=\s*"([^"]+)"/i)
    || mine.match(/Square150x150Logo\s*=\s*"([^"]+)"/i)
    || mine.match(/\sLogo\s*=\s*"([^"]+)"/i);
  const exeM = mine.match(/Executable\s*=\s*"([^"]+)"/i);

  return {
    loc,
    logo: logoM ? logoM[1].replace(/\//g, '\\') : '',
    exe: exeM ? path.join(loc, exeM[1].replace(/\//g, '\\')) : '',
  };
}

// 在 assets 目录里挑一张最大的（优先无留白的 unplated 版本）
function bestUwpLogo(full) {
  const dir = path.dirname(full);
  const ext = path.extname(full);
  const base = path.basename(full, ext);
  let best = '';
  let bestScore = -1;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) {}
  names.forEach((name) => {
    if (!name.startsWith(base)) return;
    if (path.extname(name).toLowerCase() !== ext.toLowerCase()) return;
    let size = 44;
    const ts = name.match(/targetsize-(\d+)/i);
    const sc = name.match(/scale-(\d+)/i);
    if (ts) size = Number(ts[1]);
    else if (sc) size = Math.round(44 * Number(sc[1]) / 100);
    if (size > 256) size = 256 - (size - 256) / 10; // 256 已经足够，太大的稍微降权
    const score = size + (/unplated/i.test(name) ? 6 : 0) - (/lightunplated/i.test(name) ? 3 : 0);
    if (score > bestScore) { bestScore = score; best = name; }
  });
  if (!best) return fs.existsSync(full) ? full : '';
  return path.join(dir, best);
}

async function uwpIcon(target) {
  const aumid = aumidOf(target);
  if (!aumid) return null;
  const info = await uwpAppInfo(aumid);
  if (!info) return null;

  if (info.logo) {
    const file = bestUwpLogo(path.join(info.loc, info.logo));
    if (file) {
      try {
        const buf = fs.readFileSync(file);
        const mime = imageMimeOf(buf);
        if (mime) return 'data:' + mime + ';base64,' + buf.toString('base64');
      } catch (_) {}
    }
  }
  // 兜底：从包里的主程序 exe 提取图标
  if (info.exe && fs.existsSync(info.exe)) {
    const hd = await extractIconHD(info.exe);
    if (hd) return hd;
  }
  return null;
}

// UWP 应用完整取图标：包内资源 → 包内 exe → 让系统 Shell 给（图标可能在 resources.pri 里）
async function uwpIconFull(target) {
  const aumid = aumidOf(target);
  if (!aumid) return null;
  const fromPkg = await uwpIcon(target);
  if (fromPkg) return fromPkg;
  return shellItemIcon('shell:AppsFolder\\' + aumid);
}

ipcMain.handle('target:icon', async (_e, filePath) => {
  try {
    if (!filePath) return null;
    // 应用列表里的应用项（UWP 包标识 / 无路径的应用 id）：让系统 Shell 给图标
    const afId = appsFolderIdOf(filePath) || aumidOf(filePath);
    if (afId) {
      const fromPkg = await uwpIconFull('shell:AppsFolder\\' + afId);
      if (fromPkg) return fromPkg;
      return shellItemIcon('shell:AppsFolder\\' + afId);
    }
    let iconSource = filePath;
    // 快捷方式：解析出自定义图标或真实目标，否则只能拿到通用快捷方式图标
    if (/\.lnk$/i.test(filePath) && fs.existsSync(filePath)) {
      let link = null;
      try { link = shell.readShortcutLink(filePath); } catch (_) {}
      // UWP 快捷方式：没有文件目标，只存了包标识
      const aumid = aumidFromLnk(filePath);
      if (aumid && !(link && link.target)) {
        const img = (await uwpIconFull('shell:AppsFolder\\' + aumid)) || (await shellItemIcon(filePath));
        if (img) return img;
      }
      if (link && link.icon && fs.existsSync(link.icon)) iconSource = link.icon;
      else if (link && link.target && fs.existsSync(link.target)) iconSource = link.target;
      else {
        // IDList 型 / 链式快捷方式：目标路径从二进制里取，取不到就问系统要图标
        const real = pathFromLnk(filePath);
        if (real) iconSource = real;
        else {
          const img = await shellItemIcon(filePath);
          return img || null;
        }
      }
    }
    // 目标不是普通文件（虚拟项）时交给系统 Shell
    if (!fs.existsSync(iconSource)) {
      if (/^[A-Za-z]:\\/i.test(String(iconSource))) return null;
      return shellItemIcon(String(iconSource));
    }
    // 文件夹（包括指向文件夹的快捷方式）：不管 SHDefExtractIcon 能否提取，统一给文件夹图标
    let isDir = false;
    try { isDir = fs.statSync(iconSource).isDirectory(); } catch (_) {}
    if (isDir) {
      const img = await app.getFileIcon(iconSource, { size: 'large' });
      if (img && !img.isEmpty()) return img.toDataURL();
      return FOLDER_ICON;
    }
    const hd = await extractIconHD(iconSource);
    if (hd) return hd;
    // SHDefExtractIcon 取不到（个别程序图标不放在常规图标资源里）→ 向 Shell 要 256px
    const sh = await shellItemIcon(iconSource);
    if (sh) return sh;
    const img = await app.getFileIcon(iconSource, { size: 'large' });
    if (!img || img.isEmpty()) return null;
    return img.toDataURL();
  } catch (err) {
    return null;
  }
});

ipcMain.handle('target:pick', async (_e, options = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: options.title || '选择目标',
    properties: options.directory ? ['openDirectory'] : ['openFile'],
    filters: options.filters || [{ name: '程序', extensions: ['exe', 'lnk', 'bat', 'cmd'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, path: res.filePaths[0] };
});

// 解析 .lnk 快捷方式：返回它真实指向的目标（用于「添加快捷应用」时绑定源程序而非 .lnk 本身）
// 非 .lnk 文件直接原样返回 target = filePath
// 应用商店（UWP）程序 / 应用列表项没有文件目标，改返回 shell:AppsFolder\<id>
async function resolveLnkPath(filePath, depth) {
  const d = depth || 0;
  if (!filePath || d > 3) return null;
  if (!/\.lnk$/i.test(filePath) || !fs.existsSync(filePath)) {
    return { target: filePath, args: '', cwd: '', icon: '' };
  }

  let link = null;
  try { link = shell.readShortcutLink(filePath); } catch (_) {}

  if (link && link.target && fs.existsSync(link.target)) {
    // 目标本身还是快捷方式：继续往里找
    if (/\.lnk$/i.test(link.target)) {
      const inner = await resolveLnkPath(link.target, d + 1);
      if (inner) return inner;
    }
    return { target: link.target, args: link.args || '', cwd: link.cwd || '', icon: link.icon || '' };
  }

  const aumid = aumidFromLnk(filePath);
  if (aumid) {
    return { target: 'shell:AppsFolder\\' + aumid, uwp: true, aumid, args: '', cwd: '', icon: '' };
  }

  // IDList 型快捷方式（如 Visual Studio）：目标路径没写进标准字段，从二进制里取
  const real = pathFromLnk(filePath);
  if (real) {
    if (/\.lnk$/i.test(real)) {
      const inner = await resolveLnkPath(real, d + 1);
      if (inner) return inner;
    }
    return { target: real, args: '', cwd: '', icon: '' };
  }

  // 再问系统 Shell：可能是一个应用项（shell:AppsFolder\<id>）
  const info = await shellResolveLnk(filePath);
  const cand = info.parsing || info.target || '';
  if (cand) {
    if (/\.lnk$/i.test(cand) && fs.existsSync(cand)) {
      const inner = await resolveLnkPath(cand, d + 1);
      if (inner) return inner;
    }
    if (looksLikeAppId(cand)) {
      return { target: 'shell:AppsFolder\\' + cand, uwp: AUMID_RE.test(cand), aumid: cand, args: '', cwd: '', icon: '' };
    }
    if (fs.existsSync(cand)) {
      return { target: cand, args: '', cwd: '', icon: '' };
    }
  }

  // 实在解析不出：保留 .lnk 本身（启动仍可用）
  return {
    target: filePath,
    args: (link && link.args) || '',
    cwd: (link && link.cwd) || '',
    icon: (link && link.icon) || '',
  };
}

ipcMain.handle('target:resolve', async (_e, filePath) => {
  try {
    if (!filePath) return { target: filePath };
    const res = await resolveLnkPath(filePath, 0);
    return res || { target: filePath };
  } catch (_) {
    return { target: filePath };
  }
});

ipcMain.handle('target:reveal', async (_e, filePath) => {
  try {
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
});

/* ------------------------------ 网址图标本地化 ------------------------------ */
// 主进程下载 favicon（不受浏览器 CORS 限制），转成 data URL 存进配置，
// 之后启动直接读本地数据，不再每次联网抓取。

function imageMimeOf(buf, contentType) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) return 'image/x-icon';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  const head = buf.slice(0, 300).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml') || head.includes('<svg')) return 'image/svg+xml';
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  return /^image\//.test(ct) ? ct : null;
}

ipcMain.handle('icon:fetch-favicon', async (_e, url) => {
  const target = String(url || '').trim();
  if (!/^https?:/i.test(target)) return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await net.fetch(target, { signal: controller.signal, redirect: 'follow' });
    if (!res || !res.ok) return { ok: false };
    const buf = Buffer.from(await res.arrayBuffer());
    // 过滤空响应与超大响应（有些站点会返回整页 HTML）
    if (buf.length < 32 || buf.length > 512 * 1024) return { ok: false };
    const mime = imageMimeOf(buf, res.headers.get('content-type'));
    if (!mime) return { ok: false };
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
  } catch (_) {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
});

// 从页面 HTML 解析 <link rel="icon"> / apple-touch-icon 再下载。
// 兜底场景：站点没有 /favicon.ico，且 Google / DuckDuckGo 图标服务不可达（被墙），
// 但页面自己声明了图标地址（绝对或相对路径均可）。
ipcMain.handle('icon:favicon-from-page', async (_e, pageUrl) => {
  const target = String(pageUrl || '').trim();
  if (!/^https?:/i.test(target)) return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await net.fetch(target, { signal: controller.signal, redirect: 'follow' });
    if (!res || !res.ok) return { ok: false };
    const html = await res.text();
    if (!html || html.length > 1024 * 1024) return { ok: false };

    // 收集声明的图标地址：apple-touch-icon 一般尺寸更大，优先尝试
    const plain = [];
    const touch = [];
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
      const rel = (tag.match(/rel\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
      if (!/icon/i.test(rel)) continue;
      const href = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!href) continue;
      (/apple-touch/i.test(rel) ? touch : plain).push(href);
    }
    const hrefs = touch.concat(plain).slice(0, 5);
    if (!hrefs.length) return { ok: false };

    for (const href of hrefs) {
      let abs;
      try { abs = new URL(href, res.url || target).href; } catch (_) { continue; }
      if (!/^https?:/i.test(abs)) continue;
      try {
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 6000);
        const r2 = await net.fetch(abs, { signal: c2.signal, redirect: 'follow' });
        clearTimeout(t2);
        if (!r2 || !r2.ok) continue;
        const buf = Buffer.from(await r2.arrayBuffer());
        if (buf.length < 32 || buf.length > 512 * 1024) continue;
        const mime = imageMimeOf(buf, r2.headers.get('content-type'));
        if (!mime || /html/.test(mime)) continue;
        return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
      } catch (_) {}
    }
    return { ok: false };
  } catch (_) {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
});

ipcMain.handle('app:version', async () => app.getVersion());

/* --------------------------------- 窗口控制 -------------------------------- */

ipcMain.on('window:minimize', () => win && win.minimize());
ipcMain.on('window:toggle-max', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', () => win && win.close());

/* --------------------------------- 贴边自动收起 -------------------------------- */

ipcMain.handle('edge-snap:set', async (_e, enabled) => {
  setEdgeSnapEnabled(!!enabled);
  return { ok: true, enabled: !!enabled };
});

ipcMain.handle('edge-snap:get', async () => ({ ok: true, enabled: EDGE_SNAP.enabled }));

// 窗口被用户拖出收起态后可以显式调用：从当前位置重新判断是否要吸边
ipcMain.on('edge-snap:reevaluate', () => { snapToEdge(); });
