const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, screen, net } = require('electron');
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
}

// 单实例：已运行时再次启动只唤起现有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    createWindow();
    createTray();
    restManager = createRestManager({ getMainWindow: () => win, onStatus: updateTrayTip });
    updateTrayTip(restManager.getStatus());
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

ipcMain.handle('target:icon', async (_e, filePath) => {
  try {
    if (!filePath) return null;
    let iconSource = filePath;
    // 快捷方式：解析出自定义图标或真实目标，否则只能拿到通用快捷方式图标
    if (/\.lnk$/i.test(filePath) && fs.existsSync(filePath)) {
      try {
        const link = shell.readShortcutLink(filePath);
        if (link.icon && fs.existsSync(link.icon)) iconSource = link.icon;
        else if (link.target && fs.existsSync(link.target)) iconSource = link.target;
      } catch (_) {}
    }
    if (!fs.existsSync(iconSource)) return null;
    const hd = await extractIconHD(iconSource);
    if (hd) return hd;
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
