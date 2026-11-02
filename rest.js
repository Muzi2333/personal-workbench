'use strict';

/**
 * 电脑休息提醒模块（主进程）
 *
 * 状态机： idle(空闲) → working(正常计时) → reminding(提醒/倒计时) → resting(强制休息)
 * 计时统一使用「秒」；配置文件里的分钟在此处 ×60 转换，绝不把分钟当秒用。
 */

const { app, BrowserWindow, ipcMain, powerMonitor, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const DEFAULTS = {
  enabled: true,
  free_minutes: 5,
  work_minutes: 45,
  countdown_minutes: 10,
  force_rest_minutes: 5,
  screen_saver_mode: 'mode1',
  exit_password: '123',
};

// [最小值, 最大值]（分钟）。允许小数，便于调试与快速验证；设置页仍按整数步进。
const NUMBER_RULES = {
  free_minutes: [0.1, 120],
  work_minutes: [0.1, 480],
  countdown_minutes: [0.1, 120],
  force_rest_minutes: [0.1, 120],
};

function toNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n * 100) / 100;
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = {};
  cfg.enabled = src.enabled === undefined ? DEFAULTS.enabled : !!src.enabled;
  Object.keys(NUMBER_RULES).forEach((key) => {
    const [min, max] = NUMBER_RULES[key];
    cfg[key] = Math.min(max, Math.max(min, toNumber(src[key], DEFAULTS[key])));
  });
  cfg.screen_saver_mode = src.screen_saver_mode === 'mode2' ? 'mode2' : 'mode1';
  cfg.exit_password = typeof src.exit_password === 'string' && src.exit_password
    ? src.exit_password
    : DEFAULTS.exit_password;
  return cfg;
}

function createRestManager({ getMainWindow, onStatus } = {}) {
  const configFile = () => path.join(app.getPath('userData'), 'rest-config.json');
  const windowPreload = () => path.join(__dirname, 'preload.js');
  const pageFile = (...parts) => path.join(__dirname, 'renderer', 'rest', ...parts);

  let config = normalizeConfig(readConfigFile());

  // 运行状态
  let state = 'idle';
  let usedSeconds = 0;       // 本轮连续使用秒数
  let countdownSeconds = 0;  // 提醒阶段剩余秒数
  let restSeconds = 0;       // mode1 强制休息剩余秒数
  let tickTimer = null;
  let lastTick = Date.now();
  let suppressUntil = 0;     // 手动重置后的短暂保护窗口，禁止旧回调直接跳强制休息
  let countdownHidden = false; // 用户主动隐藏倒计时窗口（关闭按钮 / Alt+F4），但倒计时继续后台跑
  let lockedAt = 0;          // mode2 发起锁屏的时间，用于忽略过早的 unlock 事件

  // 窗口
  let countdownWin = null;
  let reminderWin = null;
  let forceWin = null;
  let passwordWin = null;
  let suppressCountdownClose = false;
  let suppressForceClose = false;
  let clamping = false;

  const handlers = [];

  /* ------------------------------- 配置读写 ------------------------------- */

  function readConfigFile() {
    try {
      const file = configFile();
      if (!fs.existsSync(file)) return DEFAULTS;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return DEFAULTS;
    }
  }

  function saveConfigFile() {
    try {
      const file = configFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('[rest:save-config]', err);
    }
  }

  function getConfig() {
    return Object.assign({}, config);
  }

  function setConfig(patch) {
    config = normalizeConfig(Object.assign({}, config, patch || {}));
    saveConfigFile();

    if (!config.enabled) {
      // 总开关关闭：立即退出一切休息流程，回到空闲
      closeAllWindows();
      state = 'idle';
      usedSeconds = 0;
      countdownSeconds = 0;
      restSeconds = 0;
    } else if (state === 'idle') {
      // 从关闭切回开启：从零开始正常计时
      usedSeconds = 0;
      lastTick = Date.now();
    }

    notifyStatus();
    return { ok: true, config: getConfig() };
  }

  /* ------------------------------- 状态与广播 ------------------------------- */

  function getStatus() {
    return {
      enabled: !!config.enabled,
      state,
      usedSeconds: Math.max(0, Math.floor(usedSeconds)),
      workSecondsTotal: Math.max(0, Math.round(config.work_minutes * 60)),
      countdownSeconds: state === 'reminding' ? Math.max(0, Math.ceil(countdownSeconds)) : 0,
      countdownTotalSeconds: Math.max(0, Math.round(config.countdown_minutes * 60)),
      restSeconds: state === 'resting' ? Math.max(0, Math.ceil(restSeconds)) : 0,
      restTotalSeconds: Math.max(0, Math.round(config.force_rest_minutes * 60)),
      mode: config.screen_saver_mode,
    };
  }

  function sendStatus(target) {
    if (!target || target.isDestroyed()) return;
    try {
      target.webContents.send('rest:status', getStatus());
    } catch (_) {}
  }

  function notifyStatus() {
    sendStatus(getMainWindow && getMainWindow());
    sendStatus(countdownWin);
    sendStatus(forceWin);
    sendStatus(passwordWin);
    sendStatus(reminderWin);
    // 外部（如托盘悬浮提示）订阅状态变化
    if (typeof onStatus === 'function') {
      try { onStatus(getStatus()); } catch (_) {}
    }
  }

  /* -------------------------------- 状态迁移 -------------------------------- */

  function resetToIdle() {
    state = 'idle';
    usedSeconds = 0;
    countdownSeconds = 0;
    countdownHidden = false;
    restSeconds = 0;
    closeReminderWindow();
    closeCountdownWindow();
    notifyStatus();
  }

  function enterReminding(showPopup) {
    state = 'reminding';
    countdownHidden = false;
    countdownSeconds = Math.round(config.countdown_minutes * 60);
    showCountdownWindow();
    if (showPopup) showReminderWindow();
    notifyStatus();
  }

  function startForceRest() {
    if (state === 'resting') return;

    state = 'resting';
    countdownSeconds = 0;
    closeReminderWindow();
    closeCountdownWindow();

    if (config.screen_saver_mode === 'mode2') {
      // 系统锁屏：忽略 force_rest_minutes，不做内部计时，等解锁事件
      restSeconds = 0;
      lockedAt = Date.now();
      lockWorkstation();
      notifyStatus();
      return;
    }

    restSeconds = Math.round(config.force_rest_minutes * 60);
    if (restSeconds <= 0) {
      endRest();
      return;
    }
    showForceWindow();
    notifyStatus();
  }

  function endRest() {
    state = 'working';
    usedSeconds = 0; // 休息结束从零累计，避免立刻再次触发提醒
    countdownSeconds = 0;
    restSeconds = 0;
    lastTick = Date.now();
    suppressUntil = Date.now() + 500;
    closePasswordWindow();
    closeForceWindow();
    closeCountdownWindow();
    closeReminderWindow();
    notifyStatus();
  }

  function lockWorkstation() {
    try {
      execFile('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true }, () => {});
    } catch (err) {
      console.error('[rest:lock]', err);
    }
  }

  function onUnlockScreen() {
    if (state !== 'resting' || config.screen_saver_mode !== 'mode2') return;
    // 忽略刚发起锁屏时的历史 unlock 事件
    if (Date.now() - lockedAt < 1500) return;
    endRest();
  }

  /* -------------------------------- 每秒计时 -------------------------------- */

  function systemIdleSeconds() {
    try {
      const n = Number(powerMonitor.getSystemIdleTime());
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch (_) {
      return 0;
    }
  }

  function tick() {
    const now = Date.now();
    const delta = Math.max(0, Math.min(10, Math.round((now - lastTick) / 1000)));
    lastTick = now;

    if (!config.enabled) {
      if (state !== 'idle') resetToIdle();
      return;
    }

    // 强制休息中：mode1 内部倒计时；mode2 等解锁事件
    if (state === 'resting') {
      if (config.screen_saver_mode === 'mode1') {
        restSeconds = Math.max(0, restSeconds - delta);
        if (restSeconds <= 0) endRest();
        else notifyStatus();
      }
      return;
    }

    const idleSeconds = systemIdleSeconds();
    const freeSeconds = config.free_minutes * 60;

    // 空闲达到阈值：全部计时重置，回到空闲，空闲时间不计入使用时长
    if (idleSeconds >= freeSeconds) {
      if (state !== 'idle') resetToIdle();
      return;
    }

    // 从空闲恢复：重新开始累计
    if (state === 'idle') {
      state = 'working';
      usedSeconds = 0;
      notifyStatus();
      return;
    }

    if (state === 'working') {
      usedSeconds += delta;
      if (usedSeconds >= config.work_minutes * 60) enterReminding(true);
      else notifyStatus();
      return;
    }

    if (state === 'reminding') {
      countdownSeconds = Math.max(0, countdownSeconds - delta);
      // 用户手动隐藏后，最后一分钟自动重新弹出倒计时窗口
      if (countdownHidden && countdownSeconds <= 60 && countdownSeconds > 0) {
        countdownHidden = false;
        showCountdownWindow();
      }
      if (countdownSeconds <= 0) {
        // 手动重置后的保护期内不自动跳强制休息
        if (Date.now() > suppressUntil) startForceRest();
        else notifyStatus();
      } else {
        notifyStatus();
      }
    }
  }

  /* ------------------------------ 外部接口 A / B ------------------------------ */

  // 接口A：立即提醒休息；倒计时中则重置倒计时；否则开启一轮新提醒 + 倒计时
  function remindNow() {
    if (!config.enabled) return { ok: false, error: '电脑休息提醒已关闭' };
    if (state === 'resting') return { ok: false, error: '正在强制休息中，无法立即提醒' };

    suppressUntil = Date.now() + 500; // 旧的回调不允许直接跳强制休息

    if (state === 'reminding') {
      countdownSeconds = Math.round(config.countdown_minutes * 60);
      showCountdownWindow();
      showReminderWindow();
      notifyStatus();
      return { ok: true, reset: true };
    }

    enterReminding(true);
    return { ok: true, reset: false };
  }

  // 接口B：跳过倒计时，立即强制休息
  function forceNow() {
    if (!config.enabled) return { ok: false, error: '电脑休息提醒已关闭' };
    if (state === 'resting') return { ok: true, already: true };
    closeReminderWindow();
    closeCountdownWindow();
    startForceRest();
    return { ok: true };
  }

  // 隐藏倒计时窗口（关闭按钮 / Alt+F4）：倒计时继续后台跑，最后一分钟会自动重新弹出
  function hideCountdown() {
    if (state !== 'reminding') return { ok: false };
    countdownHidden = true;
    if (countdownWin && !countdownWin.isDestroyed()) countdownWin.hide();
    notifyStatus();
    return { ok: true };
  }

  /* -------------------------------- 窗口管理 -------------------------------- */

  function countdownBounds() {
    const wa = screen.getPrimaryDisplay().workArea;
    const width = 200;
    const height = 72;
    return {
      width,
      height,
      x: wa.x + wa.width - width - 24,
      y: wa.y + 24,
    };
  }

  // 记录倒计时窗口的原始尺寸，拖拽时 clamp 始终用这个值，防止 Windows 透明边框累积变大
  let countdownSize = null;

  function clampWindowIntoWorkArea(target) {
    if (!target || target.isDestroyed() || clamping) return;
    const b = target.getBounds();
    const display = screen.getDisplayMatching(b);
    const wa = display.workArea;
    // 固定使用创建时的原始尺寸，不跟着拖拽过程中 getBounds 返回的含透明边的尺寸漂移
    const w = countdownSize ? countdownSize.w : b.width;
    const h = countdownSize ? countdownSize.h : b.height;
    const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - w));
    const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - h));
    // 四舍五入到整数，避免小数像素累积
    const nx = Math.round(x);
    const ny = Math.round(y);
    if (nx !== Math.round(b.x) || ny !== Math.round(b.y) || w !== b.width || h !== b.height) {
      clamping = true;
      try { target.setBounds({ x: nx, y: ny, width: Math.round(w), height: Math.round(h) }); } catch (_) {}
      clamping = false;
    }
  }

  function showCountdownWindow() {
    if (countdownWin && !countdownWin.isDestroyed()) {
      if (!countdownWin.isVisible()) countdownWin.show();
      return;
    }
    const bounds = countdownBounds();
    countdownSize = { w: bounds.width, h: bounds.height };
    countdownWin = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: windowPreload(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    countdownWin.setAlwaysOnTop(true, 'screen-saver');
    countdownWin.on('move', () => clampWindowIntoWorkArea(countdownWin));
    countdownWin.on('moved', () => clampWindowIntoWorkArea(countdownWin));
    countdownWin.on('close', (e) => {
      if (suppressCountdownClose) return;
      // 手动关闭（Alt+F4 等）：隐藏窗口但倒计时继续后台跑
      e.preventDefault();
      setImmediate(() => hideCountdown());
    });
    countdownWin.on('closed', () => { countdownWin = null; suppressCountdownClose = false; });
    countdownWin.webContents.on('did-finish-load', () => sendStatus(countdownWin));
    countdownWin.once('ready-to-show', () => {
      if (!countdownWin || countdownWin.isDestroyed()) return;
      countdownWin.show();
      countdownWin.setAlwaysOnTop(true, 'screen-saver');
      sendStatus(countdownWin);
    });
    countdownWin.loadFile(pageFile('countdown.html'));
  }

  function closeCountdownWindow() {
    if (countdownWin && !countdownWin.isDestroyed()) {
      suppressCountdownClose = true;
      countdownWin.close();
    }
    countdownWin = null;
  }

  function showReminderWindow() {
    if (reminderWin && !reminderWin.isDestroyed()) {
      if (!reminderWin.isVisible()) reminderWin.show();
      return;
    }
    const wa = screen.getPrimaryDisplay().workArea;
    const width = 420;
    const height = 214;
    reminderWin = new BrowserWindow({
      width,
      height,
      x: Math.round(wa.x + (wa.width - width) / 2),
      y: Math.round(wa.y + (wa.height - height) / 2),
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: windowPreload(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    reminderWin.setAlwaysOnTop(true, 'screen-saver');
    reminderWin.on('closed', () => { reminderWin = null; });
    reminderWin.webContents.on('did-finish-load', () => sendStatus(reminderWin));
    reminderWin.once('ready-to-show', () => {
      if (!reminderWin || reminderWin.isDestroyed()) return;
      reminderWin.show();
      sendStatus(reminderWin);
    });
    reminderWin.loadFile(pageFile('reminder.html'));
  }

  function closeReminderWindow() {
    if (reminderWin && !reminderWin.isDestroyed()) reminderWin.close();
    reminderWin = null;
  }

  function showForceWindow() {
    if (forceWin && !forceWin.isDestroyed()) {
      if (!forceWin.isVisible()) forceWin.show();
      forceWin.focus();
      return;
    }
    const display = screen.getPrimaryDisplay();
    const bounds = display.bounds; // 含任务栏的整屏区域，配合 fullscreen 真正覆盖整个屏幕
    forceWin = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      fullscreen: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#0b0c0e',
      show: false,
      webPreferences: {
        preload: windowPreload(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    forceWin.setAlwaysOnTop(true, 'screen-saver');
    forceWin.on('close', (e) => {
      if (suppressForceClose) return;
      // 全屏界面不允许通过系统关闭按钮/Alt+F4 直接退出
      e.preventDefault();
    });
    forceWin.on('closed', () => { forceWin = null; suppressForceClose = false; });
    // 保持焦点，确保 ESC 能被界面接收；密码窗打开时让出焦点
    forceWin.on('blur', () => {
      if (!passwordWin || passwordWin.isDestroyed()) {
        if (forceWin && !forceWin.isDestroyed()) forceWin.focus();
      }
    });
    forceWin.webContents.on('did-finish-load', () => sendStatus(forceWin));
    forceWin.once('ready-to-show', () => {
      if (!forceWin || forceWin.isDestroyed()) return;
      forceWin.show();
      forceWin.setAlwaysOnTop(true, 'screen-saver');
      forceWin.focus();
      sendStatus(forceWin);
    });
    forceWin.loadFile(pageFile('force.html'));
  }

  function closeForceWindow() {
    if (forceWin && !forceWin.isDestroyed()) {
      suppressForceClose = true;
      forceWin.close();
    }
    forceWin = null;
  }

  function openPassword() {
    if (state !== 'resting' || config.screen_saver_mode !== 'mode1') {
      return { ok: false, error: '当前不在页面强制休息中' };
    }
    if (passwordWin && !passwordWin.isDestroyed()) {
      passwordWin.show();
      passwordWin.focus();
      return { ok: true };
    }
    const display = screen.getPrimaryDisplay();
    const wa = display.workArea;
    const width = 380;
    const height = 232;
    passwordWin = new BrowserWindow({
      width,
      height,
      x: Math.round(wa.x + (wa.width - width) / 2),
      y: Math.round(wa.y + (wa.height - height) / 2),
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      parent: forceWin && !forceWin.isDestroyed() ? forceWin : undefined,
      webPreferences: {
        preload: windowPreload(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    passwordWin.setAlwaysOnTop(true, 'screen-saver');
    passwordWin.on('closed', () => { passwordWin = null; });
    passwordWin.once('ready-to-show', () => {
      if (!passwordWin || passwordWin.isDestroyed()) return;
      passwordWin.show();
      passwordWin.focus();
      passwordWin.setAlwaysOnTop(true, 'screen-saver');
    });
    passwordWin.loadFile(pageFile('password.html'));
    return { ok: true };
  }

  function closePasswordWindow() {
    if (passwordWin && !passwordWin.isDestroyed()) passwordWin.close();
    passwordWin = null;
    if (forceWin && !forceWin.isDestroyed()) forceWin.focus();
  }

  function checkPassword(input) {
    if (state !== 'resting' || config.screen_saver_mode !== 'mode1') {
      return { ok: false, error: '当前不在强制休息中' };
    }
    if (String(input == null ? '' : input) !== String(config.exit_password)) {
      return { ok: false, error: '密码错误' };
    }
    closePasswordWindow();
    endRest();
    return { ok: true };
  }

  function closeAllWindows() {
    closeCountdownWindow();
    closeReminderWindow();
    closePasswordWindow();
    closeForceWindow();
  }

  /* ---------------------------------- 生命周期 ---------------------------------- */

  function start() {
    if (tickTimer) return;
    lastTick = Date.now();
    state = config.enabled ? 'working' : 'idle';
    usedSeconds = 0;
    try { powerMonitor.on('unlock-screen', onUnlockScreen); } catch (_) {}
    tickTimer = setInterval(tick, 1000);
  }

  function destroy() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    try { powerMonitor.removeListener('unlock-screen', onUnlockScreen); } catch (_) {}
    closeAllWindows();
    handlers.forEach((channel) => {
      try { ipcMain.removeHandler(channel); } catch (_) {}
    });
    handlers.length = 0;
  }

  /* ---------------------------------- IPC ---------------------------------- */

  function handle(channel, fn) {
    ipcMain.handle(channel, fn);
    handlers.push(channel);
  }

  handle('rest:get-config', async () => getConfig());
  handle('rest:set-config', async (_e, patch) => {
    try {
      return setConfig(patch);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  handle('rest:get-status', async () => getStatus());
  handle('rest:remind-now', async () => remindNow());
  handle('rest:force-now', async () => forceNow());
  handle('rest:countdown-close', async () => hideCountdown());
  handle('rest:reminder-close', async () => {
    closeReminderWindow();
    return { ok: true };
  });
  handle('rest:force-open-password', async () => openPassword());
  handle('rest:force-password', async (_e, password) => checkPassword(password));
  handle('rest:force-close-password', async () => {
    closePasswordWindow();
    return { ok: true };
  });

  start();

  return {
    getConfig,
    setConfig,
    getStatus,
    remindNow,
    forceNow,
    hideCountdown,
    destroy,
  };
}

module.exports = { createRestManager, DEFAULTS };
