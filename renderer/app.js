(function () {
  'use strict';

  /* ----------------------------- API（含浏览器兜底） ----------------------------- */

  const FALLBACK_KEY = 'workbench-data-v1';

  // 休息配置默认值（仅浏览器预览兜底；Electron 下以主进程配置为准）
  const REST_FALLBACK = {
    enabled: true,
    free_minutes: 5,
    work_minutes: 45,
    countdown_minutes: 10,
    force_rest_minutes: 5,
    screen_saver_mode: 'mode1',
    exit_password: '123',
  };
  const FALLBACK_REST_KEY = 'workbench-rest-config-v1';

  function fallbackApi() {
    return {
      preview: true,
      loadData: async () => {
        try { return JSON.parse(localStorage.getItem(FALLBACK_KEY) || 'null'); } catch (_) { return null; }
      },
      saveData: async (d) => { try { localStorage.setItem(FALLBACK_KEY, JSON.stringify(d)); } catch (_) {} return { ok: true }; },
      exportData: async () => ({ ok: false, error: '预览模式不支持导出' }),
      importData: async () => ({ ok: false }),
      openDataDir: async () => {},
      getAutoLaunch: async () => ({ ok: false }),
      setAutoLaunch: async () => ({ ok: false, error: '预览模式不支持开机自启' }),
      launch: async ({ target }) => {
        if (/^https?:/i.test(target || '')) { window.open(target, '_blank'); return { ok: true }; }
        return { ok: false, error: '浏览器预览模式无法启动本地程序，请用 Electron 运行（npm start）' };
      },
      icon: async () => null,
      fetchFavicon: async () => ({ ok: false }),
      faviconFromPage: async () => ({ ok: false }),
      appVersion: async () => '',
      pick: async () => ({ ok: false, error: '预览模式无法调用文件选择器' }),
      reveal: async () => ({ ok: false }),
      resolveShortcut: async (p) => ({ target: p }),
      pathForFile: () => '',
      win: { minimize() {}, toggleMax() {}, close() {} },
      onWindowState() {},
      rest: {
        getConfig: async () => {
          try { return Object.assign({}, REST_FALLBACK, JSON.parse(localStorage.getItem(FALLBACK_REST_KEY) || '{}')); } catch (_) { return Object.assign({}, REST_FALLBACK); }
        },
        setConfig: async (patch) => {
          try {
            const next = Object.assign({}, await fallbackApi().rest.getConfig(), patch || {});
            localStorage.setItem(FALLBACK_REST_KEY, JSON.stringify(next));
            return { ok: true, config: next };
          } catch (_) {
            return { ok: false, error: '预览模式保存失败' };
          }
        },
        getStatus: async () => ({ enabled: true, state: 'idle', usedSeconds: 0, countdownSeconds: 0, restSeconds: 0, mode: 'mode1' }),
        remindNow: async () => ({ ok: false, error: '预览模式不支持休息提醒' }),
        forceNow: async () => ({ ok: false, error: '预览模式不支持强制休息' }),
        closeCountdown: async () => ({ ok: false }),
        closeReminder: async () => ({ ok: false }),
        openPassword: async () => ({ ok: false }),
        verifyPassword: async () => ({ ok: false }),
        closePassword: async () => ({ ok: false }),
        onStatus: () => {},
      },
    };
  }

  const api = window.workbench || fallbackApi();
  const isElectron = !!window.workbench;
  // 兼容旧版 preload（没有 rest 命名空间）与浏览器预览
  const restApi = api.rest || fallbackApi().rest;

  /* --------------------------------- 工具函数 --------------------------------- */

  const $ = (id) => document.getElementById(id);

  function trim(s) { return String(s == null ? '' : s).trim(); }

  function baseName(p) {
    const s = String(p || '').replace(/\\/g, '/');
    const n = s.split('/').pop() || s;
    return n.replace(/\.[^.]+$/, '') || n;
  }

  function hexOrEmpty(v) {
    const s = trim(v);
    return /^#[0-9a-f]{3,8}$/i.test(s) ? s : '';
  }

  // 是否是本地路径（用于「在资源管理器中显示」；网址等协议地址不算）
  function isLocalTarget(t) {
    const s = trim(t);
    if (!s) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;
    return s.indexOf('\\') >= 0 || s.indexOf('/') >= 0;
  }

  // 新增行列/页时随机一个标记色（取色板，避免过浅/过暗）
  const COLOR_PALETTE = ['#5b9dff', '#a78bfa', '#4fc08d', '#e3b341', '#f7786b', '#5ec8e0', '#ec7db8', '#7c8aff', '#5ad1a0', '#f59e0b'];
  function randomColor() { return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)]; }

  /* ---------------------------------- 状态 ---------------------------------- */

  let state = null;

  const ui = {
    q: '',
    activeCell: null,
    hoverItem: null, // 鼠标当前悬停的图标 { itemId, cellKey }（Delete 键删除用）
    hoverStruct: null, // 鼠标当前悬停的结构 { kind:'page'|'row'|'col'|'cell', id, key }（Delete 键删除用）
    reuseIcon: null, // 「复用其他图标」：{ itemId } = 等待换图标的那个应用（右键菜单里的目标应用）
    folderDialogKey: null, // 当前打开的文件夹弹窗所在格子 key（用于文件夹内 Delete 删除）
    shortcutListening: null, // 正在录制快捷键的 action id（null = 未在录制）
    lastTap: { item: '', t: 0 },
    searchPage: null, // 搜索结果临时页（不落盘）
    settingsOpen: false, // 设置页（分页工具条齿轮进入，不落盘）
    settingsTab: 'general', // 设置页当前标签：general / rest / app
    settingsQuery: '', // 设置页搜索词（不落盘）
    settingsSearchOpen: false, // 设置页搜索框是否展开（点击图标展开）
    restShowPassword: false, // 设置页「显示密码」勾选状态
  };

  // 电脑休息提醒：配置缓存与状态（设置页打开时每秒刷新）
  let restConfig = Object.assign({}, REST_FALLBACK);
  let restStatus = { state: 'idle', usedSeconds: 0, countdownSeconds: 0, restSeconds: 0 };
  let restStatusTimer = null;

  const el = {};

  let saveTimer = null;
  let toastTimer = null;

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { api.saveData(state); }, 260);
  }

  /* ---------- 快捷键（可配置） ---------- */
  // fixed=true 表示系统固定键（Enter / Esc），只展示不允许修改
  const SHORTCUT_DEFS = [
    { id: 'delete', name: '删除（悬停目标）', desc: '删除悬停的应用 / 页签 / 整行 / 整列，或清空悬停的格子（均弹确认框）', def: 'Delete' },
    { id: 'add', name: '添加应用', desc: '在当前格子添加快捷方式', def: 'Ctrl+N' },
    { id: 'search', name: '打开搜索', desc: '聚焦搜索框', def: '/' },
    { id: 'undo', name: '撤销', desc: '撤销上一步操作', def: 'Ctrl+Z' },
    { id: 'confirm', name: '确认弹窗', desc: '确认当前弹窗的主按钮', def: 'Enter', fixed: true },
    { id: 'cancel', name: '关闭 / 取消', desc: '关闭弹窗、菜单、搜索或退出设置', def: 'Esc', fixed: true },
  ];
  const SHORTCUT_DEFAULTS = SHORTCUT_DEFS.reduce((o, s) => { o[s.id] = s.def; return o; }, {});

  // 单元格统一样式（全局默认）：分深色 / 浅色两套；每个单元格可单独覆盖（留空则继承）
  const DEFAULT_CELL_STYLE = {
    dark:  { bg: '#262829', border: '#2b2e30', radius: 12 },
    light: { bg: '#ffffff', border: '#e4e7ed', radius: 12 },
  };

  function getShortcuts() {
    const s = (state && state.settings && state.settings.shortcuts) || {};
    return Object.assign({}, SHORTCUT_DEFAULTS, s);
  }
  function getShortcut(id) {
    return getShortcuts()[id] || SHORTCUT_DEFAULTS[id];
  }
  // 把 keydown 事件规范化成可比较的字符串（修饰键顺序：Ctrl+Alt+Shift+Meta）
  function eventToShortcutStr(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Meta');
    let k = e.key;
    if (k && k.length === 1) k = k.toUpperCase();
    if (k === ' ') k = 'Space';
    if (k === 'Escape') k = 'Esc';
    return mods.length ? mods.join('+') + '+' + k : k;
  }
  // 展示用：Delete→Del、Escape→Esc
  function formatShortcut(str) {
    if (!str) return '未设置';
    return String(str).replace(/\bDelete\b/g, 'Del').replace(/\bEscape\b/g, 'Esc');
  }
  function shortcutHint(id) {
    return formatShortcut(getShortcut(id));
  }

  /* ---------- 撤销历史 ---------- */
  const history = [];

  // 快照：排除 iconCache（图标是派生数据，不参与撤销，体积也大）
  function snapshot() {
    const { iconCache, ...rest } = state;
    return JSON.parse(JSON.stringify(rest));
  }

  // 在每次会修改 state 的动作开始前调用；连续手势里已记过则跳过
  function pushHistory() {
    const limit = Math.max(0, Number(state.settings && state.settings.undoLimit) || 100);
    if (limit <= 0) return;
    try {
      history.push(snapshot());
      while (history.length > limit) history.shift();
    } catch (_) {}
  }

  function undo() {
    if (!history.length) { toast('没有可撤销的操作', 'err'); return; }
    const snap = history.pop();
    const iconCache = state.iconCache;
    Object.assign(state, snap);
    state.iconCache = iconCache;
    ui.activeCell = firstCellKey();
    scheduleSave();
    render();
    requestIcons();
    toast('已撤销', 'ok');
  }

  function defaults() {
    const mkItem = (name, target, icon, extra) => Object.assign({
      id: Grid.newId('i'),
      name,
      target,
      args: '',
      cwd: '',
      icon: icon ? { type: 'emoji', value: icon } : { type: 'auto', value: '' },
    }, extra || {});

    const item = (name, target, icon, extra) => mkItem(name, target, icon, extra);

    const rows = [
      { id: 'r1', name: '工作', color: '#5b9dff', height: 80 },
      { id: 'r2', name: '开发', color: '#a78bfa', height: 80 },
      { id: 'r3', name: '其他', color: '#4fc08d', height: 80 },
    ];
    const cols = [
      { id: 'c1', name: '常用', color: '#5b9dff', width: 80 },
      { id: 'c2', name: '工具', color: '#e3b341', width: 80 },
      { id: 'c3', name: '随手', color: '#f7786b', width: 80 },
    ];

    const cells = {};
    const put = (key, items, extra) => { cells[key] = Object.assign({ items }, extra || {}); };

    put('r1|c1', [item('记事本', 'C:\\Windows\\System32\\notepad.exe')]);
    put('r1|c2', [item('计算器', 'C:\\Windows\\System32\\calc.exe')]);
    put('r1|c3', [item('画图', 'C:\\Windows\\System32\\mspaint.exe')]);

    put('r2|c1', [item('终端', 'C:\\Windows\\System32\\cmd.exe', '⌨️')]);
    put('r2|c2', [item('资源管理器', 'C:\\Windows\\explorer.exe')]);
    put('r2|c3', [item('任务管理器', 'C:\\Windows\\System32\\taskmgr.exe')]);

    put('r3|c1', [
      item('文档', 'C:\\Users', '📁'),
      item('下载', 'C:\\Users', '📥'),
      item('百度', 'https://www.baidu.com', '🌐'),
      item('设置', 'ms-settings:', '⚙️'),
    ], { name: '常用堆' });
    put('r3|c2', [item('截图', 'C:\\Windows\\System32\\SnippingTool.exe', '✂️')]);
    put('r3|c3', [item('B 站', 'https://www.bilibili.com', '🎬')]);

    return {
      version: 3,
      pages: [{ id: 'p1', name: '主页', rows, cols, cells, layout: { gap: 10 } }],
      activePage: 'p1',
      settings: { iconSize: 54, showLabels: true, launch: 'double', sidebar: true, undoLimit: 100, locked: false, theme: 'system', headStyle: 'solid', gap: 10, headRadius: 8, edgeSnap: false, shortcuts: Object.assign({}, SHORTCUT_DEFAULTS), cellStyle: Object.assign({}, DEFAULT_CELL_STYLE) },
      iconCache: {},
    };
  }

  function normalize(data) {
    if (!data || typeof data !== 'object') return null;

    // v2 → v3：单页结构包装为 pages 数组
    if (!Array.isArray(data.pages)) {
      if (!Array.isArray(data.rows) || !Array.isArray(data.cols)) return null;
      data.pages = [{
        id: 'p1',
        name: '主页',
        rows: data.rows,
        cols: data.cols,
        cells: data.cells || {},
        layout: data.layout || { gap: 10 },
      }];
      delete data.rows;
      delete data.cols;
      delete data.cells;
      delete data.layout;
      data.activePage = 'p1';
    }
    if (!data.pages.length) return null;

    data.pages.forEach((p, pi) => {
      p.id = p.id || 'p' + (pi + 1);
      p.name = p.name || '第 ' + (pi + 1) + ' 页';
      p.rows = (Array.isArray(p.rows) ? p.rows : []).map((r, i) => ({
        id: r.id || 'r' + (i + 1),
        name: r.name || '行 ' + (i + 1),
        color: r.color || '#5b6b7c',
        height: Math.max(40, Number(r.height) || 80),
      }));
      p.cols = (Array.isArray(p.cols) ? p.cols : []).map((c, i) => ({
        id: c.id || 'c' + (i + 1),
        name: c.name || '列 ' + (i + 1),
        color: c.color || '#5b6b7c',
        width: Math.max(40, Number(c.width) || 80),
      }));
      p.cells = p.cells && typeof p.cells === 'object' ? p.cells : {};
      Object.keys(p.cells).forEach((k) => {
        const c = p.cells[k] || {};
        c.items = Array.isArray(c.items) ? c.items : [];
        // 旧版 cell.style 是扁平 { bg, border, radius }，升级为双主题格式
        const st = c.style;
        if (st && typeof st === 'object' && !('dark' in st) && !('light' in st)) {
          const flat = { bg: st.bg, border: st.border, radius: st.radius };
          c.style = { dark: flat, light: {} };
        }
        p.cells[k] = c;
      });
      p.layout = Object.assign({ gap: 10 }, p.layout || {});
    });

    // v5：单元格默认尺寸改为 行高80 / 列宽80（最小60）
    if (!data.version || data.version < 5) {
      data.pages.forEach((p) => {
        p.rows.forEach((r) => { r.height = 80; });
        p.cols.forEach((c) => { c.width = 80; });
      });
    }
    data.version = 5;

    if (!data.pages.some((p) => p.id === data.activePage)) data.activePage = data.pages[0].id;

    data.settings = Object.assign({ iconSize: 54, showLabels: true, launch: 'double', sidebar: true, undoLimit: 100, locked: false, theme: 'system', headStyle: 'solid', gap: 10, headRadius: 8, edgeSnap: false }, data.settings || {});
    // 快捷键：补齐缺失项（新增的快捷键自动用默认值），不覆盖用户已自定义的
    data.settings.shortcuts = Object.assign({}, SHORTCUT_DEFAULTS, data.settings.shortcuts || {});
    // 单元格统一样式：补齐深浅色两套，各自再内部补齐字段
    const cs = data.settings.cellStyle || {};
    cs.dark = Object.assign({}, DEFAULT_CELL_STYLE.dark, cs.dark || {});
    cs.light = Object.assign({}, DEFAULT_CELL_STYLE.light, cs.light || {});
    data.settings.cellStyle = cs;
    data.iconCache = data.iconCache || {};
    // 图标缓存版本：修复打包版 256px 提取脚本缺失（此前一直落 48px 模糊兜底），清缓存重取
    // v7：文件夹 / 文件夹快捷方式统一改用文件夹图标，清掉历史缓存让它们重新提取
    // v8：Shell 提取的图标改为保留透明通道（不再有黑色底色），清缓存重取
    // v9：修复 icon-extract.ps1 被双重 BOM 写坏导致 exe 图标退化成小图 / 通用图标，清缓存重取
    // v10：修复老式掩码图标（如 PuTTY）透明背景变黑底，清缓存重取
    if (data.cacheVer !== 10) {
      data.iconCache = {};
      data.cacheVer = 10;
    }
    return data;
  }

  // 当前页：所有行列/格子操作的入口
  function curPage() {
    return state.pages.find((p) => p.id === state.activePage) || state.pages[0];
  }

  function cellOf(key, create) {
    return Grid.getCell(curPage(), key, create);
  }

  function cleanupCell(key) {
    const cells = curPage().cells;
    const c = cells[key];
    if (c && (!c.items || !c.items.length)) delete cells[key];
  }

  function firstCellKey() {
    const p = curPage();
    if (!p.rows.length || !p.cols.length) return null;
    return Grid.cellKey(p.rows[0].id, p.cols[0].id);
  }

  /* --------------------------------- 渲染 --------------------------------- */

  // 当前展示的页：搜索时是临时合成的搜索结果页（只读），否则是真实页
  function viewPage() {
    return ui.searchPage || curPage();
  }

  function render() {
    const canvas = el.canvas;
    const sx = canvas.scrollLeft;
    const sy = canvas.scrollTop;
    // 重渲染会销毁旧节点，悬停记录必须先清掉，否则 Delete 会作用到已经不存在的目标
    ui.hoverStruct = null;
    if (ui.settingsOpen) renderSettingsPage();
    else Grid.render(el.grid, viewPage(), state);
    canvas.scrollLeft = sx;
    canvas.scrollTop = sy;
    updateStatusHint();
    renderSidebar();
  }

  /* --------------------------------- 设置页 --------------------------------- */

  function openSettings(tab) {
    cancelReuseIcon(true);
    exitSearch(true);
    const s = $('search');
    if (s) s.value = '';
    el.tbSearch.classList.add('hidden');
    $('btn-search').classList.remove('hidden');
    if (tab) ui.settingsTab = tab;
    ui.settingsOpen = true;
    ui.settingsSearchOpen = false;
    ui.settingsQuery = '';
    render();
    // 配置从主进程读取；读回后刷新当前设置页（失败则保留默认缓存）
    Promise.resolve(restApi.getConfig()).then((cfg) => {
      if (cfg) restConfig = Object.assign({}, REST_FALLBACK, cfg);
      if (ui.settingsOpen) render();
    }).catch(() => {});
  }

  function closeSettings() {
    if (!ui.settingsOpen) return;
    stopRestStatusTimer();
    ui.settingsOpen = false;
    ui.settingsSearchOpen = false;
    ui.settingsQuery = '';
    render();
  }

  function stopRestStatusTimer() {
    if (restStatusTimer) {
      clearInterval(restStatusTimer);
      restStatusTimer = null;
    }
  }

  const REST_STATE_TEXT = {
    idle: '空闲',
    working: '正常计时',
    reminding: '倒计时提醒中',
    resting: '强制休息中',
  };

  // 倒计时统一文案：>60 秒显示「X分」（向上取整），≤60 秒显示「X秒」
  // ---- 主题 ----
  function applyThemeDom(t) {
    const html = document.documentElement;
    // t: {source:'dark'|'light'|'system', dark: boolean}
    if (t && t.source === 'light') html.setAttribute('data-theme', 'light');
    else if (t && t.source === 'dark') html.setAttribute('data-theme', 'dark');
    else html.setAttribute('data-theme', (t && t.dark) ? 'dark' : 'light');
    paintThemeBtn();
  }

  // 标题栏主题按钮：图标由 CSS 按 data-theme 切换（浅色=太阳 / 深色=月亮），这里只更新提示文案
  function paintThemeBtn() {
    const btn = document.getElementById('btn-theme');
    if (!btn) return;
    const dark = (document.documentElement.dataset.theme || 'dark') === 'dark';
    btn.title = dark ? '切换为浅色模式' : '切换为深色模式';
  }
  function applyCurrentTheme() {
    const source = (state && state.settings && state.settings.theme) || 'system';
    if (api && api.theme) {
      api.theme.set(source).then((t) => applyThemeDom(t)).catch(() => {});
    } else {
      // 浏览器预览：默认深色
      applyThemeDom({ source, dark: true });
    }
  }

  function fmtRemain(seconds) {
    const s = Math.max(0, Math.ceil(Number(seconds) || 0));
    return s > 60 ? Math.ceil(s / 60) + '分' : s + '秒';
  }

  // 标题栏居中的休息状态：空闲中 / X分后提醒休息 / 休息倒计时 X分 / 强制休息还剩 X分
  function paintTbRest(st) {
    const tb = $('tb-rest');
    if (!tb) return;
    if (!st || st.enabled === false) {
      tb.textContent = '';
      tb.className = 'tb-rest';
      return;
    }
    const state = st.state || 'idle';
    let text = '空闲中';
    if (state === 'working') {
      const remain = Math.max(0, (Number(st.workSecondsTotal) || 0) - (Number(st.usedSeconds) || 0));
      text = fmtRemain(remain) + '后提醒休息';
    } else if (state === 'reminding') {
      text = '休息倒计时 ' + fmtRemain(st.countdownSeconds);
    } else if (state === 'resting') {
      text = st.mode === 'mode2' ? '强制休息中 · 锁屏中' : '强制休息还剩 ' + fmtRemain(st.restSeconds);
    }
    tb.textContent = text;
    tb.className = 'tb-rest rest-state-' + state;
  }

  // 保存休息配置：修改后立即写入主进程配置文件
  function saveRestConfig(patch, silent) {
    restConfig = Object.assign({}, restConfig, patch || {});
    Promise.resolve(restApi.setConfig(patch)).then((res) => {
      if (res && res.ok && res.config) {
        restConfig = Object.assign({}, REST_FALLBACK, res.config);
      } else if (res && res.error && !silent) {
        toast(res.error, 'err');
      }
      refreshRestStatus();
    }).catch(() => {
      if (!silent) toast('休息设置保存失败', 'err');
    });
  }

  async function refreshRestStatus() {
    if (!ui.settingsOpen || ui.settingsTab !== 'rest') return;
    try {
      const st = await restApi.getStatus();
      if (st) {
        restStatus = st;
        paintRestStatus(st);
        paintTbRest(st); // 顺手同步标题栏
      }
    } catch (_) {}
  }

  function paintRestStatus(st) {
    if (!el.grid) return;
    const dot = el.grid.querySelector('#st-rest-dot');
    const stateEl = el.grid.querySelector('#st-rest-state');
    if (!dot || !stateEl) return;

    const state = (st && st.state) || 'idle';
    stateEl.textContent = REST_STATE_TEXT[state] || '空闲';
    dot.className = 'rest-dot state-' + state;

    const used = el.grid.querySelector('#st-rest-used');
    if (used) {
      if (state === 'working') {
        const remain = Math.max(0, (Number(st.workSecondsTotal) || 0) - (Number(st.usedSeconds) || 0));
        used.textContent = fmtRemain(remain);
      } else used.textContent = '—';
    }

    const left = el.grid.querySelector('#st-rest-left');
    if (left) {
      if (state === 'reminding') left.textContent = fmtRemain(st.countdownSeconds);
      else if (state === 'resting') {
        left.textContent = st.mode === 'mode2' ? '等待解锁' : fmtRemain(st.restSeconds);
      } else left.textContent = '—';
    }

    const modeEl = el.grid.querySelector('#st-rest-mode-label');
    if (modeEl) modeEl.textContent = (restConfig.screen_saver_mode === 'mode2') ? '系统锁屏' : '自绘全屏';

    const note = el.grid.querySelector('#st-rest-note');
    if (note) {
      if (!restConfig.enabled || !st || st.enabled === false) note.textContent = '总开关已关闭，休息提醒不会触发。';
      else if (state === 'idle') note.textContent = '电脑处于空闲状态，空闲时间不计入使用时长。';
      else if (state === 'working') note.textContent = '正在累计连续使用时长，达到阈值后弹出休息提醒。';
      else if (state === 'reminding') note.textContent = '提醒弹窗与倒计时已启动，关闭提醒弹窗不会中止倒计时。';
      else if (state === 'resting') note.textContent = restConfig.screen_saver_mode === 'mode2'
        ? '系统已锁定，解锁登录后自动结束强制休息。'
        : '全屏强制休息中，可按 ESC 输入密码提前结束。';
    }
  }

  function generalTabHtml(s) {
    return [
      '<div class="set-group">',
      '  <div class="set-group-title">数据</div>',
      '  <div class="set-row btns" data-skey="import">',
      '    <button class="btn" id="st-import">导入配置…</button>',
      '    <button class="btn" id="st-export">导出配置…</button>',
      '    <button class="btn" id="st-datadir">打开数据目录</button>',
      '  </div>',
      '</div>',
      '<div class="set-group">',
      '  <div class="set-group-title">布局</div>',
      '  <div class="set-row btns" data-skey="reset">',
      '    <button class="btn danger" id="st-reset">恢复默认布局</button>',
      '  </div>',
      '</div>',
      '<div class="set-group">',
      '  <div class="set-group-title">外观</div>',
      '  <div class="set-row" data-skey="theme">',
      '    <div class="set-label">外观主题<span class="set-desc">深色 / 浅色 / 跟随系统</span></div>',
      '    <select class="set-select" id="st-theme">',
      '      <option value="system">跟随系统</option>',
      '      <option value="dark">深色</option>',
      '      <option value="light">浅色</option>',
      '    </select>',
      '  </div>',
      '  <div class="set-row" data-skey="edgeSnap">',
      '    <div class="set-label">贴边自动收起<span class="set-desc">拖到屏幕上 / 左 / 右边缘自动隐藏，只留一条 4px 窄条；鼠标碰到窄条或窗口展开区域立即弹出（不支持下边）</span></div>',
      '    <button class="switch' + (s.edgeSnap ? ' on' : '') + '" id="st-edge-snap"></button>',
      '  </div>',
      '</div>',
      '<div class="set-group" data-skey="about">',
      '  <div class="set-group-title">关于</div>',
      '  <div class="about-top">',
      '    <img class="about-ico" src="../assets/icon.png" alt="" />',
      '    <div>',
      '      <div class="about-name">工作台</div>',
      '      <div class="about-desc">Win11 风格的桌面快捷方式宫格</div>',
      '    </div>',
      '  </div>',
      '  <div class="about-rows">',
      '    <div class="about-row"><span>作者</span><b>Muzi_xy</b></div>',
      '    <div class="about-row"><span>版本</span><b id="st-about-ver">—</b></div>',
      '    <div class="about-row"><span>开源地址</span><a href="' + REPO_URL + '" id="st-about-link">github.com/Muzi2333/personal-workbench</a></div>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function restTabHtml() {
    const c = restConfig;
    return [
      '<div class="set-group">',
      '  <div class="set-group-title">运行状态（每秒刷新）</div>',
      '  <div class="rest-status">',
      '    <div class="rest-status-head">',
      '      <span class="rest-dot state-idle" id="st-rest-dot"></span>',
      '      <b id="st-rest-state">空闲</b>',
      '      <span class="rest-status-mode" id="st-rest-mode-label">自绘全屏</span>',
      '    </div>',
      '    <div class="rest-status-cols">',
      '      <div class="rest-status-item"><span>距提醒休息</span><b id="st-rest-used">—</b></div>',
      '      <div class="rest-status-item"><span>剩余倒计时</span><b id="st-rest-left">—</b></div>',
      '    </div>',
      '  </div>',
      '  <div class="rest-status-note" id="st-rest-note">电脑处于空闲状态，空闲时间不计入使用时长。</div>',
      '</div>',
      '<div class="set-group">',
      '  <div class="set-group-title">休息提醒</div>',
      '  <div class="set-row" data-skey="rest-enabled">',
      '    <div class="set-label">电脑休息提醒<span class="set-desc">总开关，关闭后不检测、不提醒</span></div>',
      '    <button class="switch' + (c.enabled ? ' on' : '') + '" id="st-rest-enabled" role="switch" title="开启 / 关闭电脑休息提醒"></button>',
      '  </div>',
      '  <div class="set-row" data-skey="rest-free">',
      '    <div class="set-label">空闲判断时间<span class="set-desc">无鼠标键盘操作达到该时长后重置计时，单位分钟</span></div>',
      '    <input class="input set-num" id="st-rest-free" type="number" min="1" max="120" step="1" value="' + c.free_minutes + '">',
      '  </div>',
      '  <div class="set-row" data-skey="rest-work">',
      '    <div class="set-label">连续使用时长<span class="set-desc">连续使用达到该时长后弹出休息提醒，单位分钟</span></div>',
      '    <input class="input set-num" id="st-rest-work" type="number" min="1" max="480" step="1" value="' + c.work_minutes + '">',
      '  </div>',
      '  <div class="set-row" data-skey="rest-countdown">',
      '    <div class="set-label">倒计时时长<span class="set-desc">提醒后到进入强制休息的倒计时，单位分钟</span></div>',
      '    <input class="input set-num" id="st-rest-countdown" type="number" min="1" max="120" step="1" value="' + c.countdown_minutes + '">',
      '  </div>',
      '  <div class="set-row" data-skey="rest-force">',
      '    <div class="set-label">强制休息时长<span class="set-desc">自绘全屏模式的持续时长；系统锁屏模式忽略此项</span></div>',
      '    <input class="input set-num" id="st-rest-force" type="number" min="1" max="120" step="1" value="' + c.force_rest_minutes + '">',
      '  </div>',
      '  <div class="set-row" data-skey="rest-mode">',
      '    <div class="set-label">强制休息方式<span class="set-desc">模式1：自绘全屏界面；模式2：调用系统锁屏</span></div>',
      '    <div class="seg" id="st-rest-mode">',
      '      <button data-v="mode1"' + (c.screen_saver_mode !== 'mode2' ? ' class="on"' : '') + '>自绘全屏</button>',
      '      <button data-v="mode2"' + (c.screen_saver_mode === 'mode2' ? ' class="on"' : '') + '>系统锁屏</button>',
      '    </div>',
      '  </div>',
      '  <div class="set-row" data-skey="rest-password">',
      '    <div class="set-label">退出密码<span class="set-desc">mode1 全屏界面提前退出时使用</span></div>',
      '    <div class="pw-wrap">',
      '      <input class="input set-pass" id="st-rest-password" type="' + (ui.restShowPassword ? 'text' : 'password') + '" value="' + String(c.exit_password || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '" autocomplete="off" spellcheck="false">',
      '      <button type="button" class="pw-eye' + (ui.restShowPassword ? ' on' : '') + '" id="st-rest-pw-eye" title="' + (ui.restShowPassword ? '隐藏密码' : '显示密码') + '" aria-label="显示或隐藏密码">',
      '        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>',
      '      </button>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');
  }

  // 设置项搜索索引：id 对应行上的 data-skey，点击结果跳到所属页签并高亮
  const SETTINGS_INDEX = [
    { id: 'import', tab: 'general', name: '导入配置 / 导出配置 / 打开数据目录', desc: '数据备份、迁移与数据文件位置' },
    { id: 'reset', tab: 'general', name: '恢复默认布局', desc: '清空当前布局，回到初始三行三列' },
    { id: 'about', tab: 'general', name: '关于', desc: '应用图标、作者、版本号、开源地址' },
    { id: 'rest-enabled', tab: 'rest', name: '电脑休息提醒（总开关）', desc: '关闭后不检测、不提醒' },
    { id: 'rest-free', tab: 'rest', name: '空闲判断时间', desc: '无鼠标键盘操作达到该时长后重置计时，单位分钟' },
    { id: 'rest-work', tab: 'rest', name: '连续使用时长', desc: '连续使用达到该时长后弹出休息提醒，单位分钟' },
    { id: 'rest-countdown', tab: 'rest', name: '倒计时时长', desc: '提醒后到进入强制休息的倒计时，单位分钟' },
    { id: 'rest-force', tab: 'rest', name: '强制休息时长', desc: '自绘全屏模式的持续时长；系统锁屏模式忽略此项' },
    { id: 'rest-mode', tab: 'rest', name: '强制休息方式', desc: '模式1：自绘全屏界面；模式2：调用系统锁屏' },
    { id: 'rest-password', tab: 'rest', name: '退出密码', desc: 'mode1 全屏界面提前退出时使用；输入框右侧眼睛按钮可切换明文' },
    { id: 'app-launch', tab: 'app', name: '启动方式', desc: '点击图标时单击 / 双击启动' },
    { id: 'app-labels', tab: 'app', name: '图标名称', desc: '在图标下方显示名称' },
    { id: 'app-headstyle', tab: 'app', name: '行列标题样式', desc: '实心纯色框 / 空心线条框 / 仅字体' },
    { id: 'app-gap', tab: 'app', name: '行列间距', desc: '单元格之间横竖间距，单位 px，对所有页面生效' },
    { id: 'app-headradius', tab: 'app', name: '标题圆角', desc: '行列标题背景的圆角大小，单位 px' },
    { id: 'app-undo', tab: 'app', name: '撤销历史上限', desc: '最多保留多少条操作记录，0 = 关闭撤销' },
    { id: 'sc-delete', tab: 'shortcut', name: '快捷键：删除（悬停目标）', desc: '删除悬停的应用 / 页签 / 整行 / 整列，或清空悬停的格子（均弹确认框）' },
    { id: 'sc-add', tab: 'shortcut', name: '快捷键：添加应用', desc: '在当前格子添加快捷方式' },
    { id: 'sc-search', tab: 'shortcut', name: '快捷键：打开搜索', desc: '聚焦搜索框' },
    { id: 'sc-undo', tab: 'shortcut', name: '快捷键：撤销', desc: '撤销上一步操作' },
    { id: 'sc-confirm', tab: 'shortcut', name: '快捷键：确认弹窗', desc: '确认当前弹窗的主按钮（系统固定）' },
    { id: 'sc-cancel', tab: 'shortcut', name: '快捷键：关闭 / 取消', desc: '关闭弹窗、菜单、搜索或退出设置（系统固定）' },
  ];
  const SETTINGS_TAB_NAME = { general: '通用', rest: '休息', app: '应用', shortcut: '快捷键' };

  // 复用全局搜索的 matchItem：名称 + 描述合并匹配（包含 / 全拼 / 首拼 / 英文首字母 / 子序列模糊）
  function matchSetting(entry, q, compact) {
    return matchItem({ name: entry.name + ' ' + entry.desc }, q, compact);
  }

  // 跳到某个设置项：切页签、清搜索、滚动定位并闪烁高亮
  function jumpToSetting(id) {
    const entry = SETTINGS_INDEX.find((it) => it.id === id);
    if (!entry) return;
    ui.settingsQuery = '';
    ui.settingsSearchOpen = false;
    ui.settingsTab = entry.tab;
    render();
    requestAnimationFrame(() => {
      const row = el.grid.querySelector('[data-skey="' + id + '"]');
      if (!row) return;
      if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
      row.classList.remove('flash');
      void row.offsetWidth;
      row.classList.add('flash');
    });
  }

  function appTabHtml(s) {
    return [
      '<div class="set-group">',
      '  <div class="set-row" data-skey="app-launch">',
      '    <div class="set-label">启动方式<span class="set-desc">点击图标时的启动方式</span></div>',
      '    <div class="seg" id="st-launch">',
      '      <button data-v="single"' + (s.launch !== 'double' ? ' class="on"' : '') + '>单击</button>',
      '      <button data-v="double"' + (s.launch === 'double' ? ' class="on"' : '') + '>双击</button>',
      '    </div>',
      '  </div>',
      '  <div class="set-row" data-skey="app-labels">',
      '    <div class="set-label">图标名称<span class="set-desc">在图标下方显示名称</span></div>',
      '    <button class="switch' + (s.showLabels ? ' on' : '') + '" id="st-labels" role="switch" title="显示 / 隐藏图标名称"></button>',
      '  </div>',
      '  <div class="set-row" data-skey="app-headstyle">',
      '    <div class="set-label">行列标题样式<span class="set-desc">实心纯色框 / 空心线条框 / 仅字体（颜色应用到文字）</span></div>',
      '    <div class="seg" id="st-headstyle">',
      '      <button data-v="solid"' + (s.headStyle !== 'outline' && s.headStyle !== 'text' ? ' class="on"' : '') + '>实心框</button>',
      '      <button data-v="outline"' + (s.headStyle === 'outline' ? ' class="on"' : '') + '>线条框</button>',
      '      <button data-v="text"' + (s.headStyle === 'text' ? ' class="on"' : '') + '>仅字体</button>',
      '    </div>',
      '  </div>',
      '  <div class="set-row" data-skey="app-gap">',
      '    <div class="set-label">行列间距<span class="set-desc">单元格之间横竖间距（px），对所有页面生效</span></div>',
      '    <input class="input set-num" id="st-gap" type="number" min="0" max="40" value="' + (s.gap != null ? s.gap : 10) + '">',
      '  </div>',
      '  <div class="set-row" data-skey="app-headradius">',
      '    <div class="set-label">标题圆角<span class="set-desc">行列标题背景的圆角（px）</span></div>',
      '    <input class="input set-num" id="st-headradius" type="number" min="0" max="30" value="' + (s.headRadius != null ? s.headRadius : 8) + '">',
      '  </div>',
      '  <div class="set-row" data-skey="app-undo">',
      '    <div class="set-label">撤销历史上限<span class="set-desc">最多保留多少条操作记录，0 = 关闭撤销</span></div>',
      '    <input class="input set-num" id="st-undo" type="number" min="0" max="1000" value="' + (s.undoLimit || 0) + '">',
      '  </div>',
      '</div>',
      '<div class="set-group">',
      '  <div class="set-group-title">单元格外观<span class="set-desc" style="display:inline">所有格子的默认外观；每个单元格可单独覆盖（右键格子 →「样式」），留空表示继承此处</span></div>',
      '  <div class="cell-style-pair">',
      '    <div class="cell-style-col" data-theme="dark">',
      '      <div class="cell-style-head"><span class="cs-ico">🌙</span>深色模式</div>',
      '      <div class="cs-field"><label>背景色</label><div class="color-field">',
      '        <input type="color" id="cs-dark-bg-pick" value="' + (hexOrEmpty(s.cellStyle.dark.bg) || DEFAULT_CELL_STYLE.dark.bg) + '" class="cs-pick" style="width:30px;height:28px;padding:0;border:1px solid var(--line);border-radius:6px;background:transparent;cursor:pointer">',
      '        <input class="input cs-input" id="cs-dark-bg" value="' + (hexOrEmpty(s.cellStyle.dark.bg) || '') + '" spellcheck="false"></div></div>',
      '      <div class="cs-field"><label>边框色</label><div class="color-field">',
      '        <input type="color" id="cs-dark-border-pick" value="' + (hexOrEmpty(s.cellStyle.dark.border) || DEFAULT_CELL_STYLE.dark.border) + '" class="cs-pick" style="width:30px;height:28px;padding:0;border:1px solid var(--line);border-radius:6px;background:transparent;cursor:pointer">',
      '        <input class="input cs-input" id="cs-dark-border" value="' + (hexOrEmpty(s.cellStyle.dark.border) || '') + '" spellcheck="false"></div></div>',
      '      <div class="cs-field"><label>圆角</label>',
      '        <input class="input cs-input cs-radius" id="cs-dark-radius" type="number" min="0" max="40" value="' + (s.cellStyle.dark.radius != null ? s.cellStyle.dark.radius : DEFAULT_CELL_STYLE.dark.radius) + '"></div>',
      '    </div>',
      '    <div class="cell-style-col" data-theme="light">',
      '      <div class="cell-style-head"><span class="cs-ico">☀️</span>浅色模式</div>',
      '      <div class="cs-field"><label>背景色</label><div class="color-field">',
      '        <input type="color" id="cs-light-bg-pick" value="' + (hexOrEmpty(s.cellStyle.light.bg) || DEFAULT_CELL_STYLE.light.bg) + '" class="cs-pick" style="width:30px;height:28px;padding:0;border:1px solid var(--line);border-radius:6px;background:transparent;cursor:pointer">',
      '        <input class="input cs-input" id="cs-light-bg" value="' + (hexOrEmpty(s.cellStyle.light.bg) || '') + '" spellcheck="false"></div></div>',
      '      <div class="cs-field"><label>边框色</label><div class="color-field">',
      '        <input type="color" id="cs-light-border-pick" value="' + (hexOrEmpty(s.cellStyle.light.border) || DEFAULT_CELL_STYLE.light.border) + '" class="cs-pick" style="width:30px;height:28px;padding:0;border:1px solid var(--line);border-radius:6px;background:transparent;cursor:pointer">',
      '        <input class="input cs-input" id="cs-light-border" value="' + (hexOrEmpty(s.cellStyle.light.border) || '') + '" spellcheck="false"></div></div>',
      '      <div class="cs-field"><label>圆角</label>',
      '        <input class="input cs-input cs-radius" id="cs-light-radius" type="number" min="0" max="40" value="' + (s.cellStyle.light.radius != null ? s.cellStyle.light.radius : DEFAULT_CELL_STYLE.light.radius) + '"></div>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');
  }

  // 快捷键页：列出所有快捷键，可点击录制新按键（Esc 取消，Backspace 恢复默认）
  function shortcutTabHtml() {
    const rows = SHORTCUT_DEFS.map((d) => {
      const cur = formatShortcut(getShortcut(d.id));
      const listening = ui.shortcutListening === d.id;
      const cell = d.id.replace(/^/, 'sc-'); // 用于搜索定位的 data-skey
      return [
        '  <div class="set-row sc-row" data-skey="' + cell + '">',
        '    <div class="set-label">' + d.name + '<span class="set-desc">' + d.desc + '</span></div>',
        '    <div class="sc-right">',
        d.fixed
          ? '<span class="sc-key sc-fixed">' + cur + '</span><span class="sc-tag">系统固定</span>'
          : '<button class="sc-key' + (listening ? ' listening' : '') + '" data-sc="' + d.id + '">'
              + (listening ? '请按下按键…' : cur) + '</button>'
              + '<button class="sc-reset" data-sc-reset="' + d.id + '" title="恢复默认">↺</button>',
        '    </div>',
        '  </div>',
      ].join('');
    }).join('');
    return [
      '<div class="set-group">',
      '  <div class="set-group-title">应用快捷键</div>',
      rows,
      '  <div class="set-row sc-tip"><div class="set-label" style="color:var(--dim-2);font-size:11.5px">点击按键进入录制，按任意组合键保存；<b>Esc</b> 取消，<b>Backspace</b> 恢复默认</div></div>',
      '</div>',
    ].join('');
  }

  // 设置页：三大页（通用 / 休息 / 应用 / 快捷键），渲染进宫格区域
  function renderSettingsPage() {
    stopRestStatusTimer();
    if (!restConfig || typeof restConfig !== 'object') restConfig = Object.assign({}, REST_FALLBACK);

    const s = state.settings;
    const tab = ui.settingsTab || 'general';
    const tabs = [['general', '通用'], ['rest', '休息'], ['app', '应用'], ['shortcut', '快捷键']];

    el.grid.style.display = 'block';
    el.grid.innerHTML = [
      '<div class="settings-page">',
      '  <div class="settings-bar">',
      '    <div class="set-tabs" id="st-tabs">',
      tabs.map(([key, name]) => '      <button data-tab="' + key + '"' + (tab === key ? ' class="on"' : '') + '>' + name + '</button>').join(''),
      '    </div>',
      '    <div class="page-tools">',
      '      <button class="tb-btn slim' + (ui.settingsSearchOpen ? ' hidden' : '') + '" id="st-search-btn" title="搜索设置项">',
      '        <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.6 10.6l3.2 3.2" stroke="currentColor" stroke-width="1.3"/></svg>',
      '      </button>',
      '      <div class="search tb-search st-search-wrap' + (ui.settingsSearchOpen ? '' : ' hidden') + '" id="st-search-wrap">',
      '        <svg viewBox="0 0 16 16" width="14" height="14" class="search-ico"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.6 10.6l3.2 3.2" stroke="currentColor" stroke-width="1.3"/></svg>',
      '        <input class="st-search" id="st-search" type="text" placeholder="搜索设置项…" autocomplete="off" spellcheck="false">',
      '        <span class="kbd">esc</span>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <div class="settings-search-results" id="st-sres" style="display:none"></div>',
      '  <div class="settings-body" id="st-body">',
      tab === 'rest' ? restTabHtml() : tab === 'app' ? appTabHtml(s) : tab === 'shortcut' ? shortcutTabHtml() : generalTabHtml(s),
      '  </div>',
      '</div>',
    ].join('');

    const q = (sel) => el.grid.querySelector(sel);

    q('#st-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b || b.dataset.tab === ui.settingsTab) return;
      ui.settingsTab = b.dataset.tab;
      ui.settingsQuery = ''; // 手动切页签时退出搜索
      ui.settingsSearchOpen = false;
      render();
      if (el.canvas) el.canvas.scrollTop = 0;
    });

    /* ------------------------------ 设置项搜索 ------------------------------ */

    // 有搜索词时用结果列表替换页签内容；支持包含 / 全拼 / 首拼 / 英文首字母 / 子序列模糊
    const paintSettingsSearch = () => {
      const res = q('#st-sres');
      const body = q('#st-body');
      if (!res || !body) return;
      const query = trim(ui.settingsQuery).toLowerCase();
      if (!query) {
        res.style.display = 'none';
        body.style.display = '';
        return;
      }
      const compact = compactQuery(query);
      const hits = SETTINGS_INDEX.filter((it) => matchSetting(it, query, compact));
      body.style.display = 'none';
      res.style.display = '';
      res.innerHTML = hits.length
        ? '<div class="set-group">' + hits.map((h) =>
            '<div class="set-row st-hit" data-sid="' + h.id + '">' +
            '  <div class="set-label">' + h.name + '<span class="set-desc">' + h.desc + '</span></div>' +
            '  <span class="st-hit-tab">' + SETTINGS_TAB_NAME[h.tab] + '</span>' +
            '</div>').join('') + '</div>'
        : '<div class="set-group"><div class="set-row"><div class="set-label" style="color:var(--dim-2)">没有匹配的设置项</div></div></div>';
    };

    const stSearch = q('#st-search');
    const stWrap = q('#st-search-wrap');
    const stBtn = q('#st-search-btn');
    stSearch.value = ui.settingsQuery || '';

    // 搜索图标点击展开输入框（与快速启动的搜索同款）；Esc 收起，有内容时先清空
    const setSearchOpen = (open, focus) => {
      ui.settingsSearchOpen = !!open;
      if (stWrap) stWrap.classList.toggle('hidden', !open);
      if (stBtn) stBtn.classList.toggle('hidden', !!open);
      if (open) {
        if (focus) setTimeout(() => stSearch.focus(), 20);
      } else {
        stSearch.value = '';
        ui.settingsQuery = '';
        paintSettingsSearch();
      }
    };
    if (stBtn) stBtn.addEventListener('click', () => setSearchOpen(true, true));

    stSearch.addEventListener('input', () => {
      ui.settingsQuery = stSearch.value;
      paintSettingsSearch();
    });
    stSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        const first = el.grid.querySelector('#st-sres .st-hit');
        if (first) jumpToSetting(first.dataset.sid);
      } else if (e.key === 'Escape') {
        // 不冒泡触发「关闭设置页」：有内容先清空，否则收起搜索框
        e.stopPropagation();
        if (stSearch.value) {
          stSearch.value = '';
          ui.settingsQuery = '';
          paintSettingsSearch();
        } else {
          setSearchOpen(false);
        }
      }
    });
    q('#st-sres').addEventListener('click', (e) => {
      const row = e.target.closest('.st-hit');
      if (row) jumpToSetting(row.dataset.sid);
    });
    if (ui.settingsQuery) paintSettingsSearch();

    /* -------------------------------- 通用页 -------------------------------- */

    const importBtn = q('#st-import');
    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        const res = await api.importData();
        if (!res || !res.ok) {
          if (res && res.error) toast(res.error, 'err');
          return;
        }
        const next = normalize(res.data);
        if (!next) { toast('配置文件格式不正确', 'err'); return; }
        state = next;
        ui.activeCell = firstCellKey();
        updateLockBtn();
        scheduleSave();
        render();
        requestIcons();
        toast('配置已导入', 'ok');
      });
    }

    const exportBtn = q('#st-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        const res = await api.exportData(state);
        if (res && res.ok) toast('已导出到 ' + res.path, 'ok');
        else if (res && res.error) toast(res.error, 'err');
      });
    }

    const dirBtn = q('#st-datadir');
    if (dirBtn) dirBtn.addEventListener('click', () => api.openDataDir());

    const resetBtn = q('#st-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        confirmDialog('恢复默认布局？', '当前布局配置会被替换，可 Ctrl+Z 撤销。休息提醒配置不受影响。', '恢复', () => {
          pushHistory();
          state = defaults();
          ui.activeCell = firstCellKey();
          ui.settingsOpen = false;
          updateLockBtn();
          scheduleSave();
          render();
          requestIcons();
        });
      });
    }

    // 关于区块：开源地址点击走系统浏览器；版本号从主进程取
    const aboutLink = q('#st-about-link');
    if (aboutLink) {
      aboutLink.addEventListener('click', (e) => {
        e.preventDefault();
        api.launch({ target: REPO_URL });
      });
    }
    const aboutVer = q('#st-about-ver');
    if (aboutVer) {
      Promise.resolve(api.appVersion()).then((v) => {
        if (v) aboutVer.textContent = 'v' + v;
      }).catch(() => {});
    }

    // 主题下拉：初始化选中值 + change 即时生效
    const themeSel = q('#st-theme');
    if (themeSel) {
      const v = state.settings.theme || 'system';
      if ([...themeSel.options].some((o) => o.value === v)) themeSel.value = v;
      themeSel.addEventListener('change', () => {
        const source = themeSel.value;
        pushHistory();
        state.settings.theme = source;
        scheduleSave();
        if (api.theme) {
          api.theme.set(source).then((t) => applyThemeDom(t)).catch(() => {});
        } else {
          applyThemeDom({ source, dark: source === 'dark' });
        }
      });
    }

    // 贴边自动收起开关：立即通知主进程启用 / 停用
    const esSnap = q('#st-edge-snap');
    if (esSnap) {
      esSnap.addEventListener('click', () => {
        const next = !esSnap.classList.contains('on');
        pushHistory();
        state.settings.edgeSnap = next;
        esSnap.classList.toggle('on', next);
        scheduleSave();
        if (api.edgeSnap) api.edgeSnap.set(next).catch(() => {});
      });
    }

    /* -------------------------------- 应用页 -------------------------------- */

    const launchSeg = q('#st-launch');
    if (launchSeg) {
      launchSeg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]');
        if (!b || b.classList.contains('on')) return;
        pushHistory();
        state.settings.launch = b.dataset.v;
        scheduleSave();
        render();
      });
    }

    const labelsBtn = q('#st-labels');
    if (labelsBtn) {
      labelsBtn.addEventListener('click', () => {
        pushHistory();
        state.settings.showLabels = !state.settings.showLabels;
        scheduleSave();
        render();
      });
    }

    const headSeg = q('#st-headstyle');
    if (headSeg) {
      headSeg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]');
        if (!b || b.classList.contains('on')) return;
        pushHistory();
        state.settings.headStyle = b.dataset.v;
        scheduleSave();
        render();
        toast('行列标题已切换为「' + b.textContent + '」', 'ok');
      });
    }

    // 撤销上限输入框：宽度跟随内容长度变化（ch 计字符 + 固定 16px 内边距）
    const undoInput = q('#st-undo');
    if (undoInput) {
      const fitUndo = (inp) => {
        const n = Math.max(2, String(inp.value).length + 2);
        inp.style.width = 'calc(' + n + 'ch + 16px)';
      };
      fitUndo(undoInput);
      undoInput.addEventListener('input', () => fitUndo(undoInput));
      undoInput.addEventListener('change', (e) => {
        const v = Math.max(0, Math.min(1000, Number(e.target.value) || 0));
        e.target.value = String(v);
        fitUndo(e.target);
        if (v === state.settings.undoLimit) return;
        pushHistory();
        state.settings.undoLimit = v;
        while (history.length > v) history.shift();
        scheduleSave();
        toast('撤销上限已设为 ' + v + ' 条', 'ok');
      });
    }

    // 行列间距 / 标题圆角：即时生效，change 时记一条历史
    const bindNum = (id, key, min, max) => {
      const inp = q('#' + id);
      if (!inp) return;
      const fit = () => { inp.style.width = 'calc(' + Math.max(2, String(inp.value).length + 2) + 'ch + 16px)'; };
      fit();
      inp.addEventListener('input', fit);
      inp.addEventListener('change', () => {
        const v = Math.max(min, Math.min(max, Number(inp.value) || 0));
        inp.value = String(v);
        fit();
        if (v === (state.settings[key] != null ? state.settings[key] : 0)) return;
        pushHistory();
        state.settings[key] = v;
        scheduleSave();
        render();
      });
    };
    bindNum('st-gap', 'gap', 0, 40);
    bindNum('st-headradius', 'headRadius', 0, 30);

    /* -------------------------------- 单元格统一样式 -------------------------------- */

    // 单元格外观：深浅色两套 bg/border/radius，改一个字段立即生效
    ['dark', 'light'].forEach((theme) => {
      const cs = state.settings.cellStyle[theme];
      // input 时即时预览 + 防抖保存；change 时才记一条历史
      const preview = (field, val) => {
        if (val == null || val === '') delete cs[field];
        else cs[field] = (field === 'radius') ? Number(val) : val;
        scheduleSave();
        render();
      };
      ['bg', 'border'].forEach((f) => {
        const inp = q('#cs-' + theme + '-' + f);
        const pick = q('#cs-' + theme + '-' + f + '-pick');
        if (inp && pick) {
          let lastPushedVal = null;
          const doInput = () => {
            const v = hexOrEmpty(inp.value);
            if (v) pick.value = v;
            preview(f, v);
          };
          const doChange = () => {
            const v = hexOrEmpty(inp.value);
            const key = f + '=' + (v || '');
            if (key !== lastPushedVal) { pushHistory(); lastPushedVal = key; }
            preview(f, v);
          };
          inp.addEventListener('input', doInput);
          inp.addEventListener('change', doChange);
          pick.addEventListener('input', () => { inp.value = pick.value; doInput(); });
          pick.addEventListener('change', () => { inp.value = pick.value; doChange(); });
          bindColorPair('#cs-' + theme + '-' + f, '#cs-' + theme + '-' + f + '-pick');
        }
      });
      const rad = q('#cs-' + theme + '-radius');
      if (rad) {
        let lastPushedRad = null;
        rad.addEventListener('input', () => {
          const v = trim(rad.value);
          if (v === '') { preview('radius', null); return; }
          preview('radius', Number(v) || 0);
        });
        rad.addEventListener('change', () => {
          const v = trim(rad.value);
          if (v === '') {
            if (lastPushedRad !== '') { pushHistory(); lastPushedRad = ''; }
            preview('radius', null); rad.value = '';
            return;
          }
          const n = Math.max(0, Math.min(40, Number(v) || 0));
          rad.value = String(n);
          if (n !== lastPushedRad) { pushHistory(); lastPushedRad = n; }
          preview('radius', n);
        });
      }
    });

    /* -------------------------------- 快捷键页 -------------------------------- */

    // 点击按键按钮进入录制；点击恢复默认则直接设为默认值
    el.grid.querySelectorAll('.sc-key[data-sc]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.sc;
        ui.shortcutListening = (ui.shortcutListening === id) ? null : id;
        render();
        if (ui.shortcutListening === id) {
          // 录制时把焦点从按钮移开，避免空格触发再次点击
          btn.blur();
        }
      });
    });
    el.grid.querySelectorAll('.sc-reset[data-sc-reset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.scReset;
        const def = SHORTCUT_DEFAULTS[id];
        state.settings.shortcuts[id] = def;
        scheduleSave();
        ui.shortcutListening = null;
        toast('已恢复默认：' + formatShortcut(def), 'ok');
        render();
      });
    });

    /* -------------------------------- 休息页 -------------------------------- */

    if (tab !== 'rest') return;

    paintRestStatus(restStatus);
    refreshRestStatus();
    restStatusTimer = setInterval(refreshRestStatus, 1000);

    const enabledBtn = q('#st-rest-enabled');
    enabledBtn.addEventListener('click', () => {
      const next = !restConfig.enabled;
      restConfig.enabled = next;
      enabledBtn.classList.toggle('on', next);
      saveRestConfig({ enabled: next }, true);
      toast(next ? '已开启电脑休息提醒' : '已关闭电脑休息提醒', 'ok');
    });

    const fitNum = (inp) => {
      const n = Math.max(2, String(inp.value).length + 2);
      inp.style.width = 'calc(' + n + 'ch + 16px)';
    };

    const bindRestNumber = (selector, key, min, max) => {
      const inp = q(selector);
      if (!inp) return;
      fitNum(inp);
      inp.addEventListener('input', () => fitNum(inp));
      inp.addEventListener('change', () => {
        const v = Math.max(min, Math.min(max, Math.round(Number(inp.value) || REST_FALLBACK[key])));
        inp.value = String(v);
        fitNum(inp);
        if (Number(restConfig[key]) === v) return;
        saveRestConfig({ [key]: v }, true);
      });
    };

    bindRestNumber('#st-rest-free', 'free_minutes', 1, 120);
    bindRestNumber('#st-rest-work', 'work_minutes', 1, 480);
    bindRestNumber('#st-rest-countdown', 'countdown_minutes', 1, 120);
    bindRestNumber('#st-rest-force', 'force_rest_minutes', 1, 120);

    const modeSeg = q('#st-rest-mode');
    modeSeg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || b.classList.contains('on')) return;
      restConfig.screen_saver_mode = b.dataset.v;
      Array.from(modeSeg.querySelectorAll('button[data-v]')).forEach((btn) => {
        btn.classList.toggle('on', btn === b);
      });
      saveRestConfig({ screen_saver_mode: b.dataset.v }, true);
      paintRestStatus(restStatus);
      toast(b.dataset.v === 'mode2' ? '已切换为系统锁屏模式' : '已切换为自绘全屏模式', 'ok');
    });

    const pwInput = q('#st-rest-password');
    // 宽度跟随内容（同撤销上限）：密码字符与明文都按 ch 估算，留足 letter-spacing 与内边距
    const fitPw = () => {
      const n = Math.min(26, Math.max(6, String(pwInput.value || '').length + 3));
      pwInput.style.width = 'calc(' + n + 'ch + 24px)';
    };
    fitPw();
    let pwTimer = null;
    const persistPassword = () => {
      const v = String(pwInput.value || '');
      if (!v) {
        pwInput.value = String(restConfig.exit_password || '');
        fitPw();
        toast('退出密码不能为空', 'err');
        return;
      }
      if (v === restConfig.exit_password) return;
      saveRestConfig({ exit_password: v }, true);
    };
    pwInput.addEventListener('input', () => {
      fitPw();
      clearTimeout(pwTimer);
      pwTimer = setTimeout(persistPassword, 600);
    });
    pwInput.addEventListener('change', () => {
      clearTimeout(pwTimer);
      persistPassword();
    });

    const eye = q('#st-rest-pw-eye');
    if (eye) {
      eye.addEventListener('click', () => {
        ui.restShowPassword = !ui.restShowPassword;
        pwInput.type = ui.restShowPassword ? 'text' : 'password';
        eye.classList.toggle('on', ui.restShowPassword);
        eye.title = ui.restShowPassword ? '隐藏密码' : '显示密码';
        fitPw();
      });
    }
  }

  /* -------------------------------- 全局搜索 -------------------------------- */
  // 匹配规则：直接包含 / 全拼音 / 首字母（首拼）/ 英文单词首字母 / 子序列模糊
  const PY = window.pinyinPro || null;
  const pyCache = new Map();

  function pinyinOf(name) {
    const key = String(name || '');
    const cached = pyCache.get(key);
    if (cached) return cached;
    let full = key.toLowerCase();
    let initials = key.toLowerCase();
    if (PY && key) {
      try {
        full = PY.pinyin(key, { toneType: 'none', type: 'array' }).join('').toLowerCase();
        initials = PY.pinyin(key, { pattern: 'first', type: 'array' }).join('').toLowerCase();
      } catch (_) {}
    }
    // 英文单词首字母：Visual Studio Code → vsc
    const words = (key.toLowerCase().match(/[a-z0-9]+/g) || []).map((w) => w[0]).join('');
    const info = { full, initials, words };
    if (pyCache.size > 4000) pyCache.clear();
    pyCache.set(key, info);
    return info;
  }

  // q 是否为 text 的子序列（模糊搜索，如 wxe → weixin）
  function isSubsequence(q, text) {
    let i = 0;
    for (let j = 0; j < text.length && i < q.length; j++) {
      if (text[j] === q[i]) i++;
    }
    return i === q.length;
  }

  function compactQuery(q) {
    return String(q || '').replace(/[^0-9a-z\u4e00-\u9fa5]/gi, '').toLowerCase();
  }

  function matchItem(item, q, compact) {
    const name = String(item.name || '').toLowerCase();
    if (name.includes(q)) return true;
    const noSpace = name.replace(/\s+/g, '');
    if (compact && noSpace.includes(compact)) return true;

    const { full, initials, words } = pinyinOf(item.name);
    if (compact) {
      if (full.includes(compact) || initials.includes(compact)) return true;
      if (words && words.includes(compact)) return true;
      if (compact.length >= 2) {
        if (isSubsequence(compact, full.replace(/[^a-z0-9]/g, ''))) return true;
        if (isSubsequence(compact, initials)) return true;
      }
    }

    // 启动目标（路径 / 网址）也参与匹配，方便按文件名查找
    const target = String(item.target || '').toLowerCase();
    if (!target) return false;
    return target.includes(q) || (!!compact && target.includes(compact));
  }

  const SEARCH_PAGE_ID = '__search__';

  // 搜索结果页：把所有页里命中的图标拼成一页（无行列标题，不写入配置文件）
  function buildSearchPage(q) {
    const query = trim(q).toLowerCase();
    if (!query) return null;
    const compact = compactQuery(query);
    const hits = [];
    state.pages.forEach((p) => {
      Object.keys(p.cells).forEach((key) => {
        (p.cells[key].items || []).forEach((it) => {
          if (matchItem(it, query, compact)) {
            hits.push({ item: it, from: p.name || '', pageId: p.id, key });
          }
        });
      });
    });

    const base = {
      id: SEARCH_PAGE_ID,
      name: '搜索结果',
      hideHeads: true,
      layout: { gap: 10 },
      hitCount: hits.length,
      pageCount: new Set(hits.map((h) => h.pageId)).size,
      hits,
    };

    if (!hits.length) {
      return Object.assign(base, { rows: [], cols: [], cells: {}, emptyText: '没有匹配的快捷方式' });
    }

    // 依据窗口宽度自动排布成宫格，避免出现横向滚动
    const gap = 10;
    const cellW = 96;
    const avail = Math.max(320, (el.canvas ? el.canvas.clientWidth : 900) - 24);
    const perRow = Math.max(1, Math.floor((avail + gap) / (cellW + gap)));
    const rowCount = Math.ceil(hits.length / perRow);

    const cols = Array.from({ length: perRow }, (_, i) => ({ id: 'sc' + i, name: '', color: '#5b6b7c', width: cellW }));
    const rows = Array.from({ length: rowCount }, (_, i) => ({ id: 'sr' + i, name: '', color: '#5b6b7c', height: 80 }));

    const cells = {};
    hits.forEach((h, i) => {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      cells[Grid.cellKey('sr' + r, 'sc' + c)] = { items: [h.item], from: h.from };
    });

    return Object.assign(base, { rows, cols, cells });
  }

  function runSearch() {
    const q = trim(ui.q);
    ui.searchPage = q ? buildSearchPage(q) : null;
    if (ui.searchPage) ui.activeCell = null;
    render();
    if (ui.searchPage && el.canvas) {
      el.canvas.scrollTop = 0;
      el.canvas.scrollLeft = 0;
    }
  }

  // 退出搜索并回到真实页；clearInput 控制是否同时清空输入框文字
  function exitSearch(clearInput) {
    const was = !!ui.searchPage;
    ui.searchPage = null;
    ui.q = '';
    if (clearInput) {
      const s = $('search');
      if (s) s.value = '';
    }
    return was;
  }

  function findSearchHit(itemId) {
    const sp = ui.searchPage;
    if (!sp) return null;
    return (sp.hits || []).find((h) => h.item.id === itemId) || null;
  }

  function updateStatusHint() {
    el.hint.innerHTML = '';
    let parts;
    if (ui.settingsOpen) {
      parts = ['设置', '点左侧「快速启动」或按 Esc 回到宫格'];
    } else if (ui.searchPage) {
      const sp = ui.searchPage;
      parts = [
        sp.hitCount
          ? '「' + trim(ui.q) + '」命中 ' + sp.hitCount + ' 个图标 · 来自 ' + sp.pageCount + ' 个页面'
          : '「' + trim(ui.q) + '」没有找到匹配的快捷方式',
        '双击启动 · 右键可打开所在页面',
        '按 Esc 或清空输入退出搜索',
      ];
    } else {
      const p = curPage();
      const total = Object.keys(p.cells).reduce((n, k) => n + ((p.cells[k].items || []).length), 0);
      parts = [
        p.rows.length + ' 行 · ' + p.cols.length + ' 列 · ' + total + ' 个图标',
        state.settings.launch === 'double' ? '双击启动' : '单击启动',
        state.settings.locked ? '布局已锁定，点上方锁按钮解锁' : '拖动图标到别的格子即可成组',
        '拖动表头可整行/整列移动',
      ];
    }
    parts.forEach((txt, i) => {
      if (i) {
        const dot = document.createElement('i');
        el.hint.appendChild(dot);
      }
      const span = document.createElement('span');
      span.textContent = txt;
      el.hint.appendChild(span);
    });
  }

  // 网址快捷方式：异步抓取网站 favicon（多个源兜底，第一个成功就用）
  // Electron 下由主进程下载并转成 data URL，存进配置 → 下次启动直接读本地，不再联网
  function faviconCandidates(origin, host) {
    // 站点自己的 favicon 最快最可靠（保留原协议与端口，兼容内网服务），公共图标服务作为兜底
    return [
      origin + '/favicon.ico',
      'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64',
      'https://icons.duckduckgo.com/ip3/' + encodeURIComponent(host) + '.ico',
    ];
  }

  async function fetchFavicon(url) {
    let u = null;
    try { u = new URL(url); } catch (_) { return null; }
    const host = u.hostname;
    if (!host) return null;
    const candidates = faviconCandidates(u.origin, host);

    if (isElectron) {
      // 并行尝试几个源，谁先下载成功就用谁；页面解析兜底（站点无 favicon.ico 且公共服务被墙时仍可取到）
      return new Promise((resolve) => {
        let done = false;
        let pending = candidates.length + 1;
        const finish = (d) => { if (done) return; done = true; resolve(d || null); };
        candidates.forEach((src) => {
          Promise.resolve(api.fetchFavicon(src)).then((res) => {
            if (res && res.ok && res.dataUrl) return finish(res.dataUrl);
            if (--pending === 0) finish(null);
          }).catch(() => { if (--pending === 0) finish(null); });
        });
        Promise.resolve(api.faviconFromPage(url)).then((res) => {
          if (res && res.ok && res.dataUrl) return finish(res.dataUrl);
          if (--pending === 0) finish(null);
        }).catch(() => { if (--pending === 0) finish(null); });
        setTimeout(() => finish(null), 9000);
      });
    }

    // 浏览器预览兜底：Image 探测可用源
    return new Promise((resolve) => {
      let done = false;
      const finish = (src) => { if (done) return; done = true; resolve(src); };
      candidates.forEach((src) => {
        const img = new Image();
        img.onload = () => finish(src);
        img.onerror = () => {};
        img.src = src;
      });
      setTimeout(() => finish(null), 6000);
    });
  }

  async function requestIcons() {
    const targets = new Set();
    const urlTargets = [];
    // 扫描所有页：切到其他页之前也先把图标缓存到本地
    state.pages.forEach((page) => {
      Object.keys(page.cells).forEach((key) => {
        (page.cells[key].items || []).forEach((it) => {
          const type = it.icon && it.icon.type ? it.icon.type : 'auto';
          if (type === 'file') {
            if (it.icon.value && !state.iconCache[it.icon.value]) targets.add(it.icon.value);
            return;
          }
          if (type !== 'auto' || !it.target) return;
          const isUrl = /^https?:/i.test(it.target);
          const cached = state.iconCache[it.target];
          // 已有本地图标（data:/file:）直接复用；只有缺失或仍是历史遗留的远程地址才重新抓取
          if (cached && !(isUrl && /^https?:/i.test(cached))) return;
          if (isUrl) urlTargets.push(it.target);
          else targets.add(it.target);
        });
      });
    });

    // 网址：并行抓 favicon（成功即存为本地 data URL）
    const urlJobs = urlTargets.map(async (t) => {
      const src = await fetchFavicon(t);
      if (src) { state.iconCache[t] = src; return true; }
      return false;
    });
    const urlResults = await Promise.all(urlJobs);

    // 本地程序：主进程提取高清图标
    let localChanged = false;
    for (const t of targets) {
      const src = await api.icon(t);
      if (src) { state.iconCache[t] = src; localChanged = true; }
    }

    const changed = localChanged || urlResults.some(Boolean);
    if (!changed) return;

    document.querySelectorAll('img[data-icon-target]').forEach((img) => {
      const src = state.iconCache[img.dataset.iconTarget];
      if (src) {
        img.src = src;
        img.classList.remove('is-placeholder');
      }
    });
    scheduleSave();
  }

  /* ------------------------------- 启动与操作 ------------------------------- */

  async function launchItem(item) {
    if (!item || !item.target) {
      toast('这个图标还没有设置启动目标', 'err');
      return;
    }
    const res = await api.launch({ target: item.target, args: item.args || '', cwd: item.cwd || '' });
    if (!res || !res.ok) {
      // 目标文件不存在：弹窗让用户选择重新编辑 / 删除 / 取消
      if (res && res.code === 'NOT_FOUND') {
        const key = findCellKeyOfItem(item.id);
        openDialog({
          title: '目标已不存在',
          body: '<div class="hintline" style="color:var(--text);font-size:13px;margin:2px 0 4px">'
            + '「' + (item.name || '未命名') + '」的目标文件已移动或删除。</div>'
            + '<div class="hintline" style="margin-top:8px;color:var(--dim-2);font-size:11.5px">'
            + (item.target || '') + '</div>',
          buttons: [
            { label: '取消', ghost: true },
            {
              label: '删除图标',
              danger: true,
              onClick: () => {
                // 从所有格子中移除 + 清理
                state.pages.forEach((p) => {
                  Object.keys(p.cells || {}).forEach((k) => {
                    const items = p.cells[k].items || [];
                    const idx = items.findIndex((i) => i.id === item.id);
                    if (idx >= 0) {
                      items.splice(idx, 1);
                      cleanupCell(k);
                    }
                  });
                });
                scheduleSave();
                render();
                toast('已删除该图标', 'ok');
              },
            },
            key ? {
              label: '重新编辑',
              primary: true,
              onClick: () => { openItemDialog(key, item); return false; }, // return false 保持弹窗
            } : null,
          ].filter(Boolean),
        });
        return;
      }
      toast((res && res.error) || '启动失败', 'err');
    }
  }

  // 辅助：遍历所有页面找到包含某个 itemId 的第一个 cellKey
  function findCellKeyOfItem(itemId) {
    for (const p of state.pages) {
      for (const k of Object.keys(p.cells || {})) {
        const items = (p.cells[k] && p.cells[k].items) || [];
        if (items.some((i) => i.id === itemId)) return k;
      }
    }
    return null;
  }

  // 按 id 找到应用所在页 / 格子 / 条目（复用图标可跨页）
  function findItemEverywhere(itemId) {
    if (!itemId) return null;
    for (const p of state.pages) {
      for (const k of Object.keys(p.cells || {})) {
        const items = (p.cells[k] && p.cells[k].items) || [];
        const it = items.find((i) => i.id === itemId);
        if (it) return { page: p, key: k, item: it };
      }
    }
    return null;
  }

  // 统计整页 / 整行 / 整列里的应用数量（确认框里提示"会删掉几个"）
  function pageItemCount(page) {
    let n = 0;
    Object.keys((page && page.cells) || {}).forEach((k) => {
      n += (((page.cells[k] && page.cells[k].items) || []).length);
    });
    return n;
  }

  function rowItemCount(page, rowId) {
    let n = 0;
    ((page && page.cols) || []).forEach((c) => {
      const cell = page.cells && page.cells[Grid.cellKey(rowId, c.id)];
      n += ((cell && cell.items) || []).length;
    });
    return n;
  }

  function colItemCount(page, colId) {
    let n = 0;
    ((page && page.rows) || []).forEach((r) => {
      const cell = page.cells && page.cells[Grid.cellKey(r.id, colId)];
      n += ((cell && cell.items) || []).length;
    });
    return n;
  }

  // 「里面 N 个应用」/「里面没有应用」的文案
  function countText(n) {
    return n > 0 ? '里面的 ' + n + ' 个应用会一起移除' : '里面没有应用';
  }

  // 按 id 删除应用（所有页面里的同一条目都会移除），用于悬停按 Delete
  function removeItemById(itemId) {
    let removed = false;
    pushHistory();
    state.pages.forEach((p) => {
      Object.keys(p.cells || {}).forEach((k) => {
        const cell = p.cells[k];
        const items = (cell && cell.items) || [];
        const idx = items.findIndex((i) => i.id === itemId);
        if (idx >= 0) {
          items.splice(idx, 1);
          if (!items.length) delete p.cells[k];
          removed = true;
        }
      });
    });
    if (!removed) history.pop(); // 没删到东西就不留历史
    return removed;
  }

  // 悬停应用 + Delete：弹确认框（回车或点「删除」确认）
  // 文件夹弹窗内删除时，确认后重新打开文件夹（或空了就关闭）；取消也重新打开文件夹
  function confirmDeleteHovered() {
    const hover = ui.hoverItem;
    if (!hover || !hover.itemId) return false;
    const inFolder = !!ui.folderDialogKey;
    const key = hover.cellKey || findCellKeyOfItem(hover.itemId);
    const cell = key ? cellOf(key, false) : null;
    const item = cell && (cell.items || []).find((i) => i.id === hover.itemId);
    if (!item) return false;
    const name = String(item.name || '未命名').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const reopenOrClose = () => {
      const c = cellOf(key, false);
      if (c && (c.items || []).length) openFolder(key);
      else closeDialog();
    };

    if (inFolder) {
      // 文件夹内：取消也要回到文件夹视图，不能直接关掉
      openDialog({
        title: '删除应用？',
        body: '<div class="hintline" style="color:var(--text);font-size:13px;margin:2px 0 4px">确定删除「' + name + '」？删除后可用 ' + shortcutHint('undo') + ' 撤销。</div>',
        buttons: [
          { label: '取消', ghost: true, onClick: () => { openFolder(key); return false; } },
          { label: '删除', danger: true, onClick: () => {
            if (removeItemById(item.id)) {
              scheduleSave();
              render();
              toast('已删除「' + (item.name || '未命名') + '」', 'ok');
            }
            reopenOrClose();
            return false;
          } },
        ],
      });
      return true;
    }

    confirmDialog('删除应用？', '确定删除「' + name + '」？删除后可用 ' + shortcutHint('undo') + ' 撤销。', '删除', () => {
      if (removeItemById(item.id)) {
        scheduleSave();
        render();
        toast('已删除「' + (item.name || '未命名') + '」', 'ok');
      }
    });
    return true;
  }

  // 复用图标：进入 / 退出拾取模式，以及把源图标的图标复制到目标图标
  function startReuseIcon(itemId) {
    ui.reuseIcon = { itemId };
    document.body.classList.add('reuse-icon-mode');
    toast('请点击另一个应用图标，把它的图标复制到这个应用（按 Esc 取消）', 'ok');
  }

  function cancelReuseIcon(silent) {
    if (!ui.reuseIcon) return;
    ui.reuseIcon = null;
    document.body.classList.remove('reuse-icon-mode');
    if (!silent) toast('已取消复用图标');
  }

  // 解析一个应用「实际显示」的图标：emoji / 自定义图片 / 指定图标文件 / 自动提取
  // 自动提取的也要落到具体图片（data URL 或本地图标文件路径），保证复制后长得一模一样
  async function resolveIconOf(item) {
    const ic = item && item.icon;
    if (ic && ic.type === 'emoji' && ic.value) return { type: 'emoji', value: ic.value };
    if (ic && (ic.type === 'image' || ic.type === 'file') && ic.value) {
      return { type: ic.type, value: ic.value };
    }

    // 剩下的都是 auto（含 { type:'auto', value:'' } 这种历史数据）
    if (!item || !item.target) return null;
    let cached = state.iconCache[item.target];
    if (!cached && /^https?:/i.test(item.target)) {
      try { cached = await fetchFavicon(item.target); } catch (_) {}
    }
    if (!cached && api.icon) {
      try { cached = await api.icon(item.target); } catch (_) {}
    }
    if (!cached) return null;
    state.iconCache[item.target] = cached;
    return { type: 'image', value: cached };
  }

  // 复用图标：把 fromItem（被点击的应用）的图标复制给 toItemId（右键菜单里的应用）
  async function applyReuseIcon(fromItem, toItemId) {
    cancelReuseIcon(true);
    const found = findItemEverywhere(toItemId);
    if (!found || !fromItem) return;
    const dst = found.item;

    const copied = await resolveIconOf(fromItem);
    if (!copied) {
      toast('没取到这个应用的图标，稍后再试', 'err');
      return;
    }

    pushHistory();
    dst.icon = copied;
    scheduleSave();
    // 在文件夹弹窗里完成的复用：关掉弹窗，回到宫格看结果
    if (ui.folderDialogKey !== null) closeDialog();
    render();
    requestIcons();
    toast('已把「' + (fromItem.name || '未命名') + '」的图标复制过来', 'ok');
  }

  // 悬停页签 / 行标题 / 列标题 / 格子 + Delete：删除整页、整行、整列或清空格子（都带确认）
  function confirmDeleteHoveredStruct() {
    const h = ui.hoverStruct;
    if (!h) return false;

    if (h.kind === 'page') {
      const page = state.pages.find((p) => p.id === h.id);
      if (!page) return false;
      if (state.pages.length <= 1) { toast('至少保留一页', 'err'); return true; }
      confirmDialog('删除这一页？', '「' + (page.name || '未命名') + '」' + countText(pageItemCount(page)) + '，可用 ' + shortcutHint('undo') + ' 撤销。', '删除', () => removePage(page.id));
      return true;
    }

    if (h.kind === 'row' || h.kind === 'col') {
      const list = h.kind === 'row' ? curPage().rows : curPage().cols;
      const obj = (list || []).find((x) => x.id === h.id);
      if (!obj) return false;
      const unit = h.kind === 'row' ? '行' : '列';
      const label = (obj.name || '未命名').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const count = h.kind === 'row' ? rowItemCount(curPage(), obj.id) : colItemCount(curPage(), obj.id);
      confirmDialog('删除这一' + unit + '？', '「' + label + '」' + countText(count) + '，可用 ' + shortcutHint('undo') + ' 撤销。', '删除', () => {
        if (h.kind === 'row') removeRow(h.id);
        else removeCol(h.id);
      });
      return true;
    }

    if (h.kind === 'cell') {
      const cell = h.key ? cellOf(h.key, false) : null;
      const count = cell && (cell.items || []).length;
      if (!count) return false;
      confirmDialog('清空这个格子？', '其中的 ' + count + ' 个图标会被移除，可用 ' + shortcutHint('undo') + ' 撤销。', '清空', () => {
        pushHistory();
        delete curPage().cells[h.key];
        scheduleSave();
        render();
        toast('已清空格子', 'ok');
      });
      return true;
    }

    return false;
  }

  function handleIconTap(item) {
    // 复用图标模式：这次点击只是「取图标」，把被点应用的图标复制给右键的那个应用，绝不启动
    if (ui.reuseIcon) {
      if (ui.reuseIcon.itemId === item.id) {
        toast('请点击另一个应用图标', 'err');
        return;
      }
      applyReuseIcon(item, ui.reuseIcon.itemId);
      return;
    }

    if (state.settings.launch === 'single') {
      launchItem(item);
      return;
    }
    const now = Date.now();
    if (ui.lastTap.item === item.id && now - ui.lastTap.t < 400) {
      ui.lastTap = { item: '', t: 0 };
      launchItem(item);
    } else {
      ui.lastTap = { item: item.id, t: now };
    }
  }

  function pageOf(id) {
    return state.pages.find((p) => p.id === id) || curPage();
  }

  function moveItem(fromKey, itemId, toKey, copy, fromPageId) {
    const srcPage = fromPageId ? pageOf(fromPageId) : curPage();
    const src = Grid.getCell(srcPage, fromKey, false);
    if (!src || !src.items) return;
    const idx = src.items.findIndex((i) => i.id === itemId);
    if (idx < 0) return;
    pushHistory();

    const dst = cellOf(toKey, true); // 目标格永远在当前页
    const item = src.items[idx];

    if (copy) {
      dst.items.push(Object.assign({}, item, { id: Grid.newId('i') }));
    } else {
      src.items.splice(idx, 1);
      dst.items.push(item);
      if (!src.items.length) delete srcPage.cells[fromKey];
    }

    scheduleSave();
    render();
    requestIcons();
  }

  // 互换：把图标与目标格的单个图标交换位置（安卓桌面式）
  function swapItems(fromKey, itemId, toKey, fromPageId) {
    const srcPage = fromPageId ? pageOf(fromPageId) : curPage();
    const src = Grid.getCell(srcPage, fromKey, false);
    const dst = cellOf(toKey, false);
    if (!src || !dst || !dst.items || dst.items.length !== 1) {
      moveItem(fromKey, itemId, toKey, false, fromPageId);
      return;
    }
    const idx = (src.items || []).findIndex((i) => i.id === itemId);
    if (idx < 0) return;
    pushHistory();
    const moved = src.items[idx];
    const other = dst.items[0];
    src.items.splice(idx, 1, other);
    dst.items[0] = moved;
    scheduleSave();
    render();
    requestIcons();
  }

  // 整格搬运：把 fromKey 格子的全部图标移到 toKey（合并成分组）
  function moveCellContents(fromKey, toKey, copy, fromPageId) {
    const srcPage = fromPageId ? pageOf(fromPageId) : curPage();
    const src = Grid.getCell(srcPage, fromKey, false);
    if (!src || !src.items || !src.items.length) return;
    pushHistory();
    const dst = cellOf(toKey, true);

    if (copy) {
      src.items.forEach((it) => dst.items.push(Object.assign({}, it, { id: Grid.newId('i') })));
    } else {
      const wasEmpty = !dst.items.length;
      src.items.forEach((it) => dst.items.push(it));
      // 目标格子原本是空的：分组名和格子样式一起搬过去
      if (wasEmpty) {
        if (src.name) dst.name = src.name;
        if (src.style) dst.style = src.style;
      }
      delete srcPage.cells[fromKey];
    }

    scheduleSave();
    render();
    requestIcons();
  }

  /* -------------------------------- 拖拽交互 -------------------------------- */

  function makeGhost(node) {
    const g = document.createElement('div');
    g.className = 'drag-ghost';
    // 分组优先取整个缩略堆叠，单个图标取 tile
    const src = node ? node.querySelector('.folder-stack') || node.querySelector('.tile') : null;
    if (src) {
      const clone = src.cloneNode(true);
      g.appendChild(clone);
      const w = src.getBoundingClientRect().width || 54;
      g.dataset.size = String(w);
    } else {
      g.dataset.size = '54';
    }
    document.body.appendChild(g);
    return g;
  }

  function highlightCell(x, y, fromKey) {
    document.querySelectorAll('.cell.drop-hover').forEach((c) => c.classList.remove('drop-hover'));
    const cell = Grid.cellAt(x, y);
    if (cell && cell.dataset.key !== fromKey) cell.classList.add('drop-hover');
  }

  function clearHighlight() {
    document.querySelectorAll('.cell.drop-hover').forEach((c) => c.classList.remove('drop-hover'));
  }

  // 跨页拖拽：拖拽物悬停到分页工具条的页签上时切换到该页，随后可落在该页目标格
  function dragHoverPage(x, y) {
    const node = document.elementFromPoint(x, y);
    const item = node && node.closest ? node.closest('.page-tab') : null;
    document.querySelectorAll('.page-tab.drop-hover').forEach((n) => {
      if (n !== item) n.classList.remove('drop-hover');
    });
    if (!item || !item.dataset.id) return;
    item.classList.add('drop-hover');
    if (item.dataset.id !== state.activePage) switchPage(item.dataset.id);
  }

  function clearPageHover() {
    document.querySelectorAll('.page-tab.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
  }

  function clearMergePreview() {
    document.querySelectorAll('.cell.merge-hover').forEach((c) => c.classList.remove('merge-hover'));
  }

  // 安卓式悬停合并：拖拽物在单图标格上驻足 ~700ms 进入合并预览，此时松手才合并成文件夹；
  // 驻足前松手 = 互换。用 setTimeout 驱动，无需持续移动指针也能触发动画
  function makeDwellMerge(canArm) {
    let key = null;
    let armedKey = null;
    let timer = null;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    return {
      track(x, y) {
        const cell = Grid.cellAt(x, y);
        const k = cell ? cell.dataset.key : null;
        if (k === key) return; // 指针仍停在同一格，不动
        // 换到新格：重置计时器与预览
        key = k;
        armedKey = null;
        clearTimer();
        clearMergePreview();
        if (k && canArm(k)) {
          timer = setTimeout(() => {
            if (key !== k) return; // 期间移走了则放弃
            armedKey = k;
            const el = document.querySelector('.cell[data-key="' + k + '"]');
            if (el) el.classList.add('merge-hover');
          }, 700);
        }
      },
      armed: () => armedKey,
      reset() {
        clearTimer();
        key = null;
        armedKey = null;
        clearMergePreview();
      },
    };
  }

  function startIconDrag(ev, cellKey, itemId) {
    const cell = cellOf(cellKey, false);
    if (!cell) return;
    const item = (cell.items || []).find((i) => i.id === itemId);
    if (!item) return;

    const srcPageId = curPage().id; // 源页：跨页拖拽时从这里搬走
    const node = ev.target.closest('.icon');
    const startX = ev.clientX;
    const startY = ev.clientY;
    let moved = false;
    let blocked = false; // 锁定状态下的拖动尝试
    let ghost = null;
    // 驻足合并：目标格只有 1 个图标且不是源格时，悬停 700ms 武装合并
    const dwell = makeDwellMerge((k) => {
      if (k === cellKey && state.activePage === srcPageId) return false;
      const c = cellOf(k, false);
      return !!(c && (c.items || []).length === 1);
    });

    const onMove = (e) => {
      if (!moved) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 7) return;
        if (state.settings.locked) { blocked = true; toast('布局已锁定，点上方锁按钮解锁后再拖动', 'err'); return; }
        moved = true;
        ghost = makeGhost(node);
        if (node) node.classList.add('is-dragging');
      }
      if (blocked) return;
      const size = Number(ghost.dataset.size) || 54;
      ghost.style.transform = 'translate(' + (e.clientX - size / 2) + 'px,' + (e.clientY - size / 2) + 'px)';
      highlightCell(e.clientX, e.clientY, cellKey);
      dragHoverPage(e.clientX, e.clientY);
      dwell.track(e.clientX, e.clientY);
    };

    const onUp = (e) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (ghost) ghost.remove();
      if (node) node.classList.remove('is-dragging');
      clearHighlight();
      clearPageHover();
      const mergeKey = dwell.armed();
      dwell.reset();

      if (blocked) return; // 锁定下的拖动尝试：不启动也不移动
      if (!moved) {
        handleIconTap(item);
        return;
      }

      const target = Grid.cellAt(e.clientX, e.clientY);
      if (!target) { render(); return; }
      const toKey = target.dataset.key;
      if (toKey === cellKey && state.activePage === srcPageId) return;
      const copy = e.ctrlKey || e.metaKey;
      if (copy) {
        moveItem(cellKey, itemId, toKey, true, srcPageId);
        return;
      }
      if (mergeKey === toKey) {
        // 驻足后松手：合并成文件夹
        moveItem(cellKey, itemId, toKey, false, srcPageId);
        return;
      }
      const dst = cellOf(toKey, false);
      if (dst && (dst.items || []).length === 1) {
        // 目标格已有单个图标：互换（安卓式）
        swapItems(cellKey, itemId, toKey, srcPageId);
        return;
      }
      // 空格或已是文件夹：直接并入
      moveItem(cellKey, itemId, toKey, false, srcPageId);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // 整组拖动：点按 = 展开分组，拖动 = 整格搬运（Ctrl 拖动 = 复制整组）
  function startFolderDrag(ev, cellKey) {
    const cell = cellOf(cellKey, false);
    if (!cell || !cell.items || !cell.items.length) return;

    const srcPageId = curPage().id;
    const node = ev.target.closest('.folder');
    const startX = ev.clientX;
    const startY = ev.clientY;
    let moved = false;
    let blocked = false;
    let ghost = null;

    const onMove = (e) => {
      if (!moved) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 7) return;
        if (state.settings.locked) { blocked = true; toast('布局已锁定，点上方锁按钮解锁后再拖动', 'err'); return; }
        moved = true;
        ghost = makeGhost(node);
        if (node) node.classList.add('is-dragging');
      }
      if (blocked) return;
      const size = Number(ghost.dataset.size) || 54;
      ghost.style.transform = 'translate(' + (e.clientX - size / 2) + 'px,' + (e.clientY - size / 2) + 'px)';
      highlightCell(e.clientX, e.clientY, cellKey);
      dragHoverPage(e.clientX, e.clientY);
    };

    const onUp = (e) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (ghost) ghost.remove();
      if (node) node.classList.remove('is-dragging');
      clearHighlight();
      clearPageHover();

      if (blocked) return;
      if (!moved) {
        openFolder(cellKey);
        return;
      }

      const target = Grid.cellAt(e.clientX, e.clientY);
      if (!target) return;
      const toKey = target.dataset.key;
      if (toKey === cellKey && state.activePage === srcPageId) return;
      moveCellContents(cellKey, toKey, e.ctrlKey || e.metaKey, srcPageId);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function startHeaderDrag(ev, axis, headEl) {
    ev.stopPropagation();
    // 注意：不调用 preventDefault，这样未产生位移时点击 / 双击仍可正常触发

    const id = headEl.dataset.id;
    const page = curPage();
    const list = axis === 'row' ? page.rows : page.cols;
    const from = list.findIndex((x) => x.id === id);
    if (from < 0) return;

    const startX = ev.clientX;
    const startY = ev.clientY;
    const heads = Array.from(el.grid.querySelectorAll(axis === 'row' ? '.row-head' : '.col-head'));
    let line = null;
    let to = from;
    let dragging = false;

    const beginDrag = () => {
      dragging = true;
      line = document.createElement('div');
      line.className = 'drop-line';
      document.body.appendChild(line);
      headEl.classList.add('is-dragging');
    };

    const onMove = (e) => {
      if (!dragging) {
        // 移动不足 7px 视为点击，不进入拖拽
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 7) return;
        beginDrag();
      }
      const rects = heads.map((h) => h.getBoundingClientRect());
      const pos = axis === 'row' ? e.clientY : e.clientX;
      let insert = 0;
      rects.forEach((r) => {
        const mid = axis === 'row' ? r.top + r.height / 2 : r.left + r.width / 2;
        if (pos > mid) insert++;
      });
      to = insert;

      const first = rects[0];
      const last = rects[rects.length - 1];
      if (!first) return;
      if (axis === 'row') {
        const y = insert < rects.length ? rects[insert].top - 5 : last.bottom + 5;
        line.style.cssText = 'display:block;left:' + first.left + 'px;top:' + y + 'px;width:' + (last.right - first.left) + 'px;height:2px;';
      } else {
        const x = insert < rects.length ? rects[insert].left - 5 : last.right + 5;
        line.style.cssText = 'display:block;left:' + x + 'px;top:' + first.top + 'px;width:2px;height:' + (last.bottom - first.top) + 'px;';
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!dragging) return; // 未移动：当作普通点击，不重排行列
      line.remove();
      headEl.classList.remove('is-dragging');

      if (to !== from && to !== from + 1) {
        pushHistory();
        const target = to > from ? to - 1 : to;
        const moved = list.splice(from, 1)[0];
        list.splice(target, 0, moved);
        scheduleSave();
        render();
        toast(axis === 'row' ? '已调整行顺序' : '已调整列顺序', 'ok');
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /* --------------------------------- 行列编辑 -------------------------------- */

  function insertRow(atIndex) {
    pushHistory();
    const page = curPage();
    const idx = Math.max(0, Math.min(atIndex, page.rows.length));
    page.rows.splice(idx, 0, {
      id: Grid.newId('r'),
      name: '行 ' + (idx + 1),
      color: randomColor(),
      height: 80,
    });
    scheduleSave();
    render();
  }

  function insertCol(atIndex) {
    pushHistory();
    const page = curPage();
    const idx = Math.max(0, Math.min(atIndex, page.cols.length));
    page.cols.splice(idx, 0, {
      id: Grid.newId('c'),
      name: '列 ' + (idx + 1),
      color: randomColor(),
      width: 80,
    });
    scheduleSave();
    render();
  }

  // 行列转置：行 ↔ 列互换，行列标题与单元格一起变换（类似 Excel 的转置）
  function transposePage() {
    const page = curPage();
    if (!page.rows.length || !page.cols.length) {
      toast('当前页没有行列可转置', 'err');
      return;
    }
    pushHistory();
    const oldRows = page.rows.slice();
    const oldCols = page.cols.slice();
    // 原列 → 新行（高度沿用原列宽）；原行 → 新列（宽度沿用原行高）
    page.rows = oldCols.map((c) => ({ id: c.id, name: c.name, color: c.color, height: c.width || 150 }));
    page.cols = oldRows.map((r) => ({ id: r.id, name: r.name, color: r.color, width: r.height || 150 }));
    // 单元格 key 是「行id|列id」，转置后交换两段
    const cells = {};
    Object.keys(page.cells || {}).forEach((k) => {
      const parts = k.split('|');
      if (parts.length !== 2) return;
      cells[parts[1] + '|' + parts[0]] = page.cells[k];
    });
    page.cells = cells;
    ui.activeCell = null;
    ui.hoverItem = null;
    scheduleSave();
    render();
    toast('已转置：行 ↔ 列，可用 ' + shortcutHint('undo') + ' 撤销', 'ok');
  }

  // 列倒序：最后一列放最前，最前一列放最后（单元格跟着列走）
  function reverseCols() {
    const page = curPage();
    if (!page || page.cols.length < 2) { toast('列数不足，无需倒序', 'err'); return; }
    pushHistory();
    page.cols.reverse();
    scheduleSave();
    render();
    toast('已倒序列顺序，可用 ' + shortcutHint('undo') + ' 撤销', 'ok');
  }

  // 行倒序：最后一行放最前，最前一行放最后（单元格跟着行走）
  function reverseRows() {
    const page = curPage();
    if (!page || page.rows.length < 2) { toast('行数不足，无需倒序', 'err'); return; }
    pushHistory();
    page.rows.reverse();
    scheduleSave();
    render();
    toast('已倒序行顺序，可用 ' + shortcutHint('undo') + ' 撤销', 'ok');
  }

  // 清空整页：移除本页所有应用，行列与页面本身保留
  function clearPageItems() {
    const page = curPage();
    if (!page) return;
    const n = pageItemCount(page);
    if (!n) { toast('本页没有应用可清空', 'err'); return; }
    pushHistory();
    Object.keys(page.cells || {}).forEach((k) => {
      if (page.cells[k]) page.cells[k].items = [];
    });
    ui.activeCell = null;
    ui.hoverItem = null;
    scheduleSave();
    render();
    toast('已清空本页 ' + n + ' 个应用，可用 ' + shortcutHint('undo') + ' 撤销', 'ok');
  }

  function removeRow(id) {
    const page = curPage();
    const idx = page.rows.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    pushHistory();
    page.rows.splice(idx, 1);
    Object.keys(page.cells).forEach((k) => { if (k.startsWith(id + '|')) delete page.cells[k]; });
    scheduleSave();
    render();
    return true;
  }

  function removeCol(id) {
    const page = curPage();
    const idx = page.cols.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    pushHistory();
    page.cols.splice(idx, 1);
    Object.keys(page.cells).forEach((k) => { if (k.endsWith('|' + id)) delete page.cells[k]; });
    scheduleSave();
    render();
    return true;
  }

  /* --------------------------------- 页管理 --------------------------------- */

  function renderSidebar() {
    // 侧栏只有一个「快速启动」入口：设置页打开时不高亮
    const btnQuick = $('btn-quickstart');
    if (btnQuick) btnQuick.classList.toggle('active', !ui.settingsOpen);

    // 设置页占用宫格区域时隐藏分页工具条（设置页自带「‹ 返回」）
    if (el.pageBar) el.pageBar.classList.toggle('hidden', ui.settingsOpen);

    // 侧栏底部「设置」与「快速启动」二选一高亮
    const btnSettings = $('btn-settings');
    if (btnSettings) btnSettings.classList.toggle('active', ui.settingsOpen);

    if (!el.pageTabs) return;
    el.pageTabs.innerHTML = '';

    // 搜索时在最前面插入一个临时的「搜索结果」页签（不是真实页）
    if (ui.searchPage) {
      const b = document.createElement('button');
      b.className = 'page-tab search-item on';
      b.title = '搜索结果：继续在搜索框里输入';
      b.textContent = '搜索结果 (' + ui.searchPage.hitCount + ')';
      b.addEventListener('click', () => { const s = $('search'); if (s) s.focus(); });
      el.pageTabs.appendChild(b);
    }

    state.pages.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'page-tab' + (p.id === state.activePage && !ui.searchPage && !ui.settingsOpen ? ' on' : '');
      b.dataset.id = p.id;
      b.title = p.name;
      b.textContent = p.name;
      b.addEventListener('click', () => {
        if (ui.suppressPageClick) { ui.suppressPageClick = false; return; }
        switchPage(p.id);
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openPageMenu(p.id, e.clientX, e.clientY);
      });
      b.addEventListener('dblclick', (e) => {
        e.preventDefault();
        openPageDialog(p.id);
      });
      b.addEventListener('pointerdown', (e) => startPageDrag(e, p.id, b));
      el.pageTabs.appendChild(b);
    });

    // 「+」：增加一页应用
    const add = document.createElement('button');
    add.className = 'page-add';
    add.title = '增加一页应用';
    add.textContent = '+';
    add.addEventListener('click', () => addPage());
    el.pageTabs.appendChild(add);
  }

  function switchPage(id) {
    // 切换页面时退出设置页 / 搜索页（复用图标模式保留，允许跨页复用）

    const wasSettings = ui.settingsOpen;
    ui.settingsOpen = false;
    // 从搜索结果页切到真实页：先退出搜索，再切换
    const wasSearch = exitSearch(true);
    if (id === state.activePage) {
      if (wasSearch || wasSettings) render();
      return;
    }
    state.activePage = id;
    ui.activeCell = firstCellKey();
    scheduleSave();
    render();
    requestIcons();
  }

  function addPage(atIndex) {
    pushHistory();
    const idx = atIndex == null ? state.pages.length : Math.max(0, Math.min(atIndex, state.pages.length));
    const mkAxis = (prefix, name, size) => [1, 2, 3].map((n) => ({
      id: Grid.newId(prefix),
      name: name + ' ' + n,
      color: randomColor(),
      [size]: 80,
    }));
    const page = {
      id: Grid.newId('p'),
      name: '第 ' + (state.pages.length + 1) + ' 页',
      rows: mkAxis('r', '行', 'height'),
      cols: mkAxis('c', '列', 'width'),
      cells: {},
      layout: { gap: 10 },
    };
    state.pages.splice(idx, 0, page);
    switchPage(page.id);
    toast('已添加一页', 'ok');
  }

  function removePage(id) {
    if (state.pages.length <= 1) { toast('至少保留一页', 'err'); return; }
    const idx = state.pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    pushHistory();
    state.pages.splice(idx, 1);
    if (state.activePage === id) state.activePage = state.pages[Math.max(0, idx - 1)].id;
    ui.activeCell = firstCellKey();
    scheduleSave();
    render();
    requestIcons();
    toast('已删除这一页', 'ok');
  }

  function openPageDialog(id) {
    const page = state.pages.find((p) => p.id === id);
    if (!page) return;
    const body = openDialog({
      title: '页设置',
      body: '<div class="field"><label>页名称</label><input class="input" id="pg-name" spellcheck="false"></div>',
      buttons: [
        { label: '取消', ghost: true },
        { label: '保存', primary: true, onClick: () => {
          pushHistory();
          page.name = trim(body.querySelector('#pg-name').value) || page.name;
          scheduleSave();
          renderSidebar();
          return true;
        } },
      ],
    });
    body.querySelector('#pg-name').value = page.name || '';
  }

  function openPageMenu(id, x, y) {
    const idx = state.pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    openMenu(x, y, [
      { label: '重命名', action: () => openPageDialog(id) },
      { label: '在前面插入一页', action: () => addPage(idx) },
      { label: '在后面插入一页', action: () => addPage(idx + 1) },
      { sep: true },
      { label: '删除这一页', danger: true, hint: shortcutHint('delete'), action: () => {
        const page = state.pages[idx];
        confirmDialog('删除这一页？', '「' + (page.name || '未命名') + '」' + countText(pageItemCount(page)) + '。', '删除', () => removePage(id));
      } },
    ]);
  }

  // 页签拖拽排序（水平方向）
  function startPageDrag(ev, id, node) {
    if (ev.button !== 0 || ui.searchPage) return;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const from = state.pages.findIndex((p) => p.id === id);
    if (from < 0) return;

    let dragging = false;
    let to = from;
    let line = null;

    const onMove = (e) => {
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
        dragging = true;
        line = document.createElement('div');
        line.className = 'drop-line';
        document.body.appendChild(line);
        node.classList.add('is-dragging');
      }
      const nodes = Array.from(el.pageTabs.querySelectorAll('.page-tab'));
      const rects = nodes.map((n) => n.getBoundingClientRect());
      let insert = 0;
      rects.forEach((r) => { if (e.clientX > r.left + r.width / 2) insert++; });
      to = insert;
      const first = rects[0];
      const last = rects[rects.length - 1];
      if (first) {
        const x = insert < rects.length ? rects[insert].left - 4 : last.right + 4;
        line.style.cssText = 'display:block;left:' + x + 'px;top:' + first.top + 'px;width:2px;height:' + first.height + 'px;';
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (line) line.remove();
      node.classList.remove('is-dragging');
      if (dragging) {
        ui.suppressPageClick = true;
        if (to !== from && to !== from + 1) {
          pushHistory();
          const target = to > from ? to - 1 : to;
          const moved = state.pages.splice(from, 1)[0];
          state.pages.splice(target, 0, moved);
          scheduleSave();
          renderSidebar();
          toast('已调整页顺序', 'ok');
        }
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /* ---------------------------------- 菜单 ---------------------------------- */

  function openMenu(x, y, entries) {
    const menu = el.menu;
    menu.innerHTML = '';
    entries.forEach((entry) => {
      if (entry.sep) {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        menu.appendChild(sep);
        return;
      }
      const item = document.createElement('div');
      item.className = 'menu-item' + (entry.danger ? ' danger' : '');
      const label = document.createElement('span');
      label.textContent = entry.label;
      item.appendChild(label);
      if (entry.hint) {
        const hint = document.createElement('span');
        hint.className = 'menu-hint';
        hint.textContent = entry.hint;
        item.appendChild(hint);
      }
      if (entry.sub) {
        const sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = entry.sub;
        item.appendChild(sub);
      }
      item.addEventListener('click', () => {
        closeMenu();
        if (entry.action) entry.action();
      });
      menu.appendChild(item);
    });

    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(6, left) + 'px';
    menu.style.top = Math.max(6, top) + 'px';
  }

  function closeMenu() {
    el.menu.classList.add('hidden');
  }

  function openCellMenu(key, x, y) {
    const page = curPage();
    const cell = cellOf(key, false) || { items: [] };
    const count = (cell.items || []).length;
    openMenu(x, y, [
      { label: '添加快捷方式', sub: '＋', action: () => openItemDialog(key, null) },
      { label: '编辑格子样式', action: () => openCellDialog(key) },
      count ? { label: '清空这个格子', danger: true, action: () => { delete page.cells[key]; scheduleSave(); render(); } } : { sep: true },
      { label: '插入一行（下方）', action: () => {
        const r = page.rows.findIndex((row) => row.id === key.split('|')[0]);
        insertRow(r + 1);
      } },
      { label: '插入一列（右侧）', action: () => {
        const c = page.cols.findIndex((col) => col.id === key.split('|')[1]);
        insertCol(c + 1);
      } },
    ]);
  }

  function openIconMenu(cellKey, itemId, x, y) {
    const cell = cellOf(cellKey, false);
    if (!cell) return;
    const item = (cell.items || []).find((i) => i.id === itemId);
    if (!item) return;

    openMenu(x, y, [
      { label: '打开', action: () => launchItem(item) },
      { label: '编辑', action: () => openItemDialog(cellKey, item) },
      { label: '复用其他图标', sub: '↗', action: () => startReuseIcon(itemId) },
      item.target && isLocalTarget(item.target)
        ? { label: '在资源管理器中显示', action: () => api.reveal(item.target) }
        : { sep: true },
      {
        label: '从这个格子移除',
        danger: true,
        hint: shortcutHint('delete'),
        action: () => {
          const idx = cell.items.findIndex((i) => i.id === itemId);
          if (idx >= 0) cell.items.splice(idx, 1);
          cleanupCell(cellKey);
          scheduleSave();
          render();
        },
      },
    ]);
  }

  // 搜索结果里的图标右键：可打开、回到所在页面编辑
  function openSearchItemMenu(itemId, x, y) {
    const hit = findSearchHit(itemId);
    if (!hit) return;
    const item = hit.item;
    openMenu(x, y, [
      { label: '打开', action: () => launchItem(item) },
      { label: '打开所在页面', action: () => switchPage(hit.pageId) },
      { sep: true },
      { label: '编辑', action: () => { switchPage(hit.pageId); openItemDialog(hit.key, item); } },
      item.target && isLocalTarget(item.target)
        ? { label: '在资源管理器中显示', action: () => api.reveal(item.target) }
        : { sep: true },
    ]);
  }

  function openHeaderMenu(axis, id, x, y) {
    const page = curPage();
    const list = axis === 'row' ? page.rows : page.cols;
    const idx = list.findIndex((v) => v.id === id);
    if (idx < 0) return;
    const unit = axis === 'row' ? '行' : '列';

    openMenu(x, y, [
      { label: '在前面插入' + unit, action: () => (axis === 'row' ? insertRow(idx) : insertCol(idx)) },
      { label: '在后面插入' + unit, action: () => (axis === 'row' ? insertRow(idx + 1) : insertCol(idx + 1)) },
      { sep: true },
      { label: '重命名与外观', action: () => openHeaderDialog(axis, id) },
      {
        label: '删除这一' + unit,
        danger: true,
        hint: shortcutHint('delete'),
        action: () => {
          if (list.length <= 1) { toast('至少保留一' + unit, 'err'); return; }
          const count = axis === 'row' ? rowItemCount(curPage(), id) : colItemCount(curPage(), id);
          const obj2 = list.find((x) => x.id === id) || {};
          confirmDialog('删除这一' + unit + '？', '「' + (obj2.name || '未命名') + '」' + countText(count) + '。', '删除', () => {
            if (axis === 'row') removeRow(id);
            else removeCol(id);
          });
        },
      },
    ]);
  }

  /* --------------------------------- 布局锁定 --------------------------------- */

  // 锁定后禁止拖动图标（点击启动不受影响），防止误触挪动
  function updateLockBtn() {
    const btn = $('btn-lock');
    if (!btn) return;
    const locked = !!state.settings.locked;
    btn.classList.toggle('locked', locked);
    btn.title = locked ? '已锁定：禁止拖动图标，点击解锁' : '锁定布局：禁止拖动图标';
  }

  function toggleLock() {
    state.settings.locked = !state.settings.locked;
    updateLockBtn();
    scheduleSave();
    updateStatusHint();
    toast(state.settings.locked ? '已锁定布局，图标不能拖动了' : '已解锁，可以拖动图标', 'ok');
  }

  const REPO_URL = 'https://github.com/Muzi2333/personal-workbench';

  /* ---------------------------------- 弹窗 ---------------------------------- */

  // 应用内确认框（Electron 不支持原生 window.confirm）
  function confirmDialog(title, message, okLabel, onOk) {
    openDialog({
      title: title || '确认',
      body: '<div class="hintline" style="color:var(--text);font-size:13px;margin:2px 0 4px">' + message + '</div>',
      buttons: [
        { label: '取消', ghost: true },
        { label: okLabel || '确定', danger: true, onClick: () => { onOk(); return true; } },
      ],
    });
  }

  function openDialog(options) {
    el.dialogTitle.textContent = options.title || '';
    el.dialogTitle.classList.remove('editable-title');
    el.dialogTitle.title = '';
    el.dialogTitle.ondblclick = null;
    el.dialogBody.innerHTML = options.body || '';
    el.dialogFoot.innerHTML = '';

    (options.buttons || []).forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '') + (b.ghost ? ' ghost' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        const keep = b.onClick ? b.onClick() : undefined;
        if (keep === false) return;
        closeDialog();
      });
      el.dialogFoot.appendChild(btn);
    });

    el.overlay.classList.remove('hidden');
    const firstInput = el.dialogBody.querySelector('input, .input');
    if (firstInput) setTimeout(() => firstInput.focus(), 30);
    return el.dialogBody;
  }

  function closeDialog() {
    el.overlay.classList.add('hidden');
    el.dialogTitle.classList.remove('editable-title');
    el.dialogTitle.ondblclick = null;
    el.dialogBody.innerHTML = '';
    el.dialogFoot.innerHTML = '';
    ui.folderDialogKey = null;
    ui.hoverItem = null;
    ui.shortcutListening = null;
  }

  function bindColorPair(hexId, pickerId) {
    const hex = document.querySelector(hexId);
    const picker = document.querySelector(pickerId);
    if (!hex || !picker) return;
    // 颜色选择器（<input type="color">）在不同环境下可能触发 input 或 change，
    // 两个事件都监听，确保选好颜色后 HEX 输入框同步更新
    const syncFromPicker = () => { hex.value = picker.value; };
    picker.addEventListener('input', syncFromPicker);
    picker.addEventListener('change', syncFromPicker);
    hex.addEventListener('input', () => {
      const v = hexOrEmpty(hex.value);
      if (v) picker.value = v;
    });
  }

  function openItemDialog(cellKey, item) {
    const key = cellKey || firstCellKey();
    if (!key) { toast('请先添加一行一列', 'err'); return; }
    const editing = !!item;
    const it = item || { name: '', target: '', args: '', cwd: '', icon: { type: 'auto', value: '' } };
    const emojiValue = it.icon && it.icon.type === 'emoji' ? it.icon.value : '';
    // 用户自定义图标：图片走 image，.ico/.exe/.dll 走 file（主进程提取）
    let customIcon = it.icon && (it.icon.type === 'image' || it.icon.type === 'file')
      ? { type: it.icon.type, value: it.icon.value }
      : null;

    const body = openDialog({
      title: editing ? '编辑快捷方式' : '添加快捷方式',
      body: [
        '<div class="field"><label>名称</label>',
        '<input class="input" id="f-name" placeholder="显示在图标下方" spellcheck="false"></div>',
        '<div class="field"><label>目标（程序 / 文件 / 文件夹 / 网址）</label>',
        '<div style="display:flex;gap:8px">',
        '<input class="input" id="f-target" placeholder="C:\\Windows\\notepad.exe 或 https://…" spellcheck="false">',
        '<button class="btn" id="f-browse" style="flex:0 0 auto">浏览</button>',
        '</div>',
        '<div class="hintline">也可直接把 .exe / 快捷方式 / 文件拖进格子。</div></div>',
        '<div class="row-2">',
        '<div class="field"><label>启动参数</label><input class="input" id="f-args" placeholder="可留空" spellcheck="false"></div>',
        '<div class="field"><label>工作目录</label><input class="input" id="f-cwd" placeholder="可留空" spellcheck="false"></div>',
        '</div>',
        '<div class="field"><label>图标（留空则自动读取程序图标）</label>',
        '<input class="input" id="f-emoji" placeholder="填一个 emoji，例如 📝" spellcheck="false">',
        '<div class="emoji-row" id="f-emoji-row"></div>',
        '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">',
        '<button class="btn" id="f-icon-browse" style="flex:0 0 auto">浏览图标…</button>',
        '<span class="hintline" id="f-icon-path" style="margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>',
        '<button class="btn ghost" id="f-icon-clear" style="flex:0 0 auto;display:none">清除</button>',
        '</div></div>',
      ].join(''),
      buttons: [
        { label: '取消', ghost: true },
        {
          label: editing ? '保存' : '添加',
          primary: true,
          onClick: () => save(),
        },
      ],
    });

    const fName = body.querySelector('#f-name');
    const fTarget = body.querySelector('#f-target');
    const fArgs = body.querySelector('#f-args');
    const fCwd = body.querySelector('#f-cwd');
    const fEmoji = body.querySelector('#f-emoji');
    const row = body.querySelector('#f-emoji-row');

    fName.value = it.name || '';
    fTarget.value = it.target || '';
    fArgs.value = it.args || '';
    fCwd.value = it.cwd || '';
    fEmoji.value = emojiValue;

    const presets = ['📝', '📁', '🌐', '⚙️', '🧮', '🎨', '⌨️', '📊', '🎵', '📷', '✂️', '💬', '📦', '🚀', '🔧', '🖥️', '📥', '🗂️'];
    presets.forEach((p) => {
      const b = document.createElement('button');
      b.textContent = p;
      b.addEventListener('click', () => { fEmoji.value = p; });
      row.appendChild(b);
    });

    body.querySelector('#f-browse').addEventListener('click', async () => {
      const res = await api.pick({ title: '选择要启动的程序或文件' });
      if (res && res.ok) {
        let path = res.path;
        const name = baseName(path);
        // .lnk 快捷方式：名字用快捷方式文件名，目标用它真实指向的程序
        if (api.resolveShortcut) {
          const info = await api.resolveShortcut(path);
          if (info && info.target) path = info.target;
        }
        fTarget.value = path;
        if (!trim(fName.value)) fName.value = name;
      } else if (res && res.error) {
        toast(res.error, 'err');
      }
    });

    // 自定义图标：类似 Windows 快捷方式的「更改图标」
    const fIconPath = body.querySelector('#f-icon-path');
    const fIconClear = body.querySelector('#f-icon-clear');
    const refreshIconHint = () => {
      fIconPath.textContent = customIcon ? '自定义：' + customIcon.value : '';
      fIconPath.title = customIcon ? customIcon.value : '';
      fIconClear.style.display = customIcon ? '' : 'none';
    };
    refreshIconHint();

    body.querySelector('#f-icon-browse').addEventListener('click', async () => {
      const res = await api.pick({
        title: '选择图标文件',
        filters: [
          { name: '图标', extensions: ['ico', 'exe', 'dll', 'png', 'jpg', 'jpeg', 'bmp', 'webp'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (res && res.ok) {
        customIcon = /\.(png|jpe?g|bmp|webp|gif)$/i.test(res.path)
          ? { type: 'image', value: res.path }
          : { type: 'file', value: res.path };
        fEmoji.value = ''; // 选了自定义图标就清掉 emoji，否则保存时 emoji 优先
        refreshIconHint();
      } else if (res && res.error && !res.canceled) {
        toast(res.error, 'err');
      }
    });
    fIconClear.addEventListener('click', () => { customIcon = null; refreshIconHint(); });

    function save() {
      const target = trim(fTarget.value);
      if (!target) { toast('请填写启动目标', 'err'); return false; }
      pushHistory();
      const name = trim(fName.value) || baseName(target.split('?')[0]);
      const emoji = trim(fEmoji.value);
      const icon = emoji ? { type: 'emoji', value: emoji } : (customIcon || { type: 'auto', value: '' });

      if (editing) {
        it.name = name;
        it.target = target;
        it.args = trim(fArgs.value);
        it.cwd = trim(fCwd.value);
        it.icon = icon;
      } else {
        const cell = cellOf(key, true);
        cell.items.push({
          id: Grid.newId('i'),
          name,
          target,
          args: trim(fArgs.value),
          cwd: trim(fCwd.value),
          icon,
        });
      }
      scheduleSave();
      render();
      requestIcons();
      toast(editing ? '已保存' : '已添加快捷方式', 'ok');
      return true;
    }
  }

  function openCellDialog(key) {
    const cell = cellOf(key, true);
    const st = cell.style || (cell.style = {});
    st.dark = st.dark || {};
    st.light = st.light || {};

    const themeBlock = (theme, label, ico, def) => {
      const t = st[theme];
      const pickStyle = 'width:34px;height:32px;padding:0;border:1px solid var(--line);border-radius:7px;background:transparent;cursor:pointer';
      return [
        '<div class="cell-style-col" data-theme="' + theme + '">',
        '  <div class="cell-style-head"><span class="cs-ico">' + ico + '</span>' + label + '</div>',
        '  <div class="field"><label>背景色（留空=继承默认）</label><div class="color-field">',
        '    <input type="color" id="cd-' + theme + '-bg-pick" value="' + (hexOrEmpty(t.bg) || def.bg) + '" style="' + pickStyle + '">',
        '    <input class="input" id="cd-' + theme + '-bg" placeholder="留空=默认" spellcheck="false"></div></div>',
        '  <div class="field"><label>边框色（留空=继承默认）</label><div class="color-field">',
        '    <input type="color" id="cd-' + theme + '-border-pick" value="' + (hexOrEmpty(t.border) || def.border) + '" style="' + pickStyle + '">',
        '    <input class="input" id="cd-' + theme + '-border" placeholder="留空=默认" spellcheck="false"></div></div>',
        '  <div class="field"><label>圆角（px，留空=继承默认）</label>',
        '    <input class="input" id="cd-' + theme + '-radius" type="number" min="0" max="40" placeholder="默认 ' + def.radius + '"></div>',
        '</div>',
      ].join('');
    };

    const body = openDialog({
      title: '格子样式',
      body: [
        '<div class="field"><label>格子名称（多图标分组时显示）</label>',
        '<input class="input" id="c-name" placeholder="例如：常用工具" spellcheck="false"></div>',
        '<div class="cell-style-pair">',
        themeBlock('dark', '深色模式', '🌙', DEFAULT_CELL_STYLE.dark),
        themeBlock('light', '浅色模式', '☀️', DEFAULT_CELL_STYLE.light),
        '</div>',
      ].join(''),
      buttons: [
        { label: '取消', ghost: true },
        { label: '保存', primary: true, onClick: () => {
          pushHistory();
          cell.name = trim(body.querySelector('#c-name').value);
          ['dark', 'light'].forEach((theme) => {
            const t = {};
            const bg = hexOrEmpty(body.querySelector('#cd-' + theme + '-bg').value);
            const border = hexOrEmpty(body.querySelector('#cd-' + theme + '-border').value);
            const radiusRaw = trim(body.querySelector('#cd-' + theme + '-radius').value);
            if (bg) t.bg = bg;
            if (border) t.border = border;
            if (radiusRaw !== '') t.radius = Number(radiusRaw);
            st[theme] = t;
          });
          scheduleSave();
          render();
          return true;
        } },
      ],
    });

    body.querySelector('#c-name').value = cell.name || '';
    ['dark', 'light'].forEach((theme) => {
      body.querySelector('#cd-' + theme + '-bg').value = hexOrEmpty(st[theme].bg) || '';
      body.querySelector('#cd-' + theme + '-border').value = hexOrEmpty(st[theme].border) || '';
      body.querySelector('#cd-' + theme + '-radius').value = st[theme].radius != null ? String(st[theme].radius) : '';
      bindColorPair('#cd-' + theme + '-bg', '#cd-' + theme + '-bg-pick');
      bindColorPair('#cd-' + theme + '-border', '#cd-' + theme + '-border-pick');
    });
  }

  function openHeaderDialog(axis, id) {
    const page = curPage();
    const list = axis === 'row' ? page.rows : page.cols;
    const target = list.find((v) => v.id === id);
    if (!target) return;
    const isRow = axis === 'row';
    const sizeLabel = isRow ? '行高（px）' : '列宽（px）';
    const sizeValue = isRow ? target.height : target.width;

    const body = openDialog({
      title: (isRow ? '行' : '列') + '设置',
      body: [
        '<div class="field"><label>显示名称</label>',
        '<input class="input" id="h-name" placeholder="表头显示的名字" spellcheck="false"></div>',
        '<div class="row-2">',
        '<div class="field"><label>标记颜色</label><div class="color-field">',
        '<input type="color" id="h-color-pick" value="' + (hexOrEmpty(target.color) || '#5b6b7c') + '" style="width:34px;height:32px;padding:0;border:1px solid rgba(255,255,255,.1);border-radius:7px;background:transparent;cursor:pointer">',
        '<input class="input" id="h-color" placeholder="#5b6b7c" spellcheck="false"></div></div>',
        '<div class="field"><label>' + sizeLabel + '</label>',
        '<input class="input" id="h-size" type="number" min="40" max="600" spellcheck="false"></div>',
        '</div>',
      ].join(''),
      buttons: [
        { label: '取消', ghost: true },
        { label: '保存', primary: true, onClick: () => {
          pushHistory();
          target.name = trim(body.querySelector('#h-name').value) || target.name;
          target.color = hexOrEmpty(body.querySelector('#h-color').value) || target.color;
          const size = Number(body.querySelector('#h-size').value);
          if (size > 0) {
            if (isRow) target.height = Math.max(40, size);
            else target.width = Math.max(40, size);
          }
          scheduleSave();
          render();
          return true;
        } },
      ],
    });

    body.querySelector('#h-name').value = target.name || '';
    body.querySelector('#h-color').value = hexOrEmpty(target.color) || '';
    body.querySelector('#h-size').value = String(sizeValue || '');
    bindColorPair('#h-color', '#h-color-pick');
  }

  function openFolder(key) {
    const cell = cellOf(key, false);
    if (!cell || !cell.items || cell.items.length === 0) return;

    let body = null;

    // 弹层图标拖拽：层内拖动 = 排序，拖出弹层 = 移到主宫格（Ctrl 拖动 = 复制）
    const startPopupDrag = (ev, item, node, grid) => {
      if (ev.button !== 0) return;
      ev.preventDefault();

      const srcPageId = curPage().id; // 源页：跨页拖拽时从这里搬走
      const startX = ev.clientX;
      const startY = ev.clientY;
      const dialogBox = node.closest('.dialog');
      let mode = null; // 'reorder' | 'out'
      let blocked = false;
      let ghost = null;
      let insertAt = -1;
      // 驻足合并：目标格只有 1 个图标且不是源格时，悬停 700ms 武装合并
      const dwell = makeDwellMerge((k) => {
        if (k === key && state.activePage === srcPageId) return false;
        const c = cellOf(k, false);
        return !!(c && (c.items || []).length === 1);
      });

      const clearMarks = () => {
        grid.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
      };

      const onMove = (e) => {
        if (!mode) {
          if (Math.hypot(e.clientX - startX, e.clientY - startY) < 7) return;
          if (state.settings.locked) { blocked = true; toast('布局已锁定，点上方锁按钮解锁后再拖动', 'err'); return; }
          mode = 'reorder';
          ghost = makeGhost(node);
          node.classList.add('is-dragging');
        }
        if (blocked) return;
        const size = Number(ghost.dataset.size) || 54;
        ghost.style.transform = 'translate(' + (e.clientX - size / 2) + 'px,' + (e.clientY - size / 2) + 'px)';

        if (mode === 'reorder') {
          const r = dialogBox.getBoundingClientRect();
          const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
          if (outside) {
            // 拖出弹层：关闭弹层，露出主宫格继续拖
            mode = 'out';
            clearMarks();
            node.classList.remove('is-dragging');
            closeDialog();
          }
        }

        if (mode === 'reorder') {
          const icons = Array.from(grid.querySelectorAll('.icon'));
          insertAt = icons.length;
          for (let i = 0; i < icons.length; i++) {
            const r2 = icons[i].getBoundingClientRect();
            if (e.clientY > r2.bottom) continue;
            if (e.clientY < r2.top || e.clientX < r2.left + r2.width / 2) { insertAt = i; break; }
          }
          clearMarks();
          if (insertAt < icons.length) icons[insertAt].classList.add('drop-before');
          else if (icons.length) icons[icons.length - 1].classList.add('drop-after');
        } else {
          highlightCell(e.clientX, e.clientY, key);
          dragHoverPage(e.clientX, e.clientY);
          dwell.track(e.clientX, e.clientY);
        }
      };

      const onUp = (e) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (ghost) ghost.remove();
        clearHighlight();
        clearPageHover();
        clearMarks();
        const mergeKey = dwell.armed();
        dwell.reset();

        if (blocked) return; // 锁定下的拖动尝试：不启动也不移动
        if (!mode) {
          // 复用图标模式：点文件夹里的图标 = 取它的图标给右键的那个应用，不启动
          if (ui.reuseIcon) { applyReuseIcon(item, ui.reuseIcon.itemId); return; }
          launchItem(item);
          return;
        }

        if (mode === 'reorder') {
          node.classList.remove('is-dragging');
          const cur = cellOf(key, false);
          if (!cur) return;
          const from = cur.items.findIndex((i) => i.id === item.id);
          if (from < 0 || insertAt < 0 || insertAt === from || insertAt === from + 1) return;
          const it = cur.items.splice(from, 1)[0];
          cur.items.splice(insertAt > from ? insertAt - 1 : insertAt, 0, it);
          scheduleSave();
          render();
          rebuild();
          return;
        }

        // mode === 'out'：落到主宫格（与 startIconDrag 同一套落点决策）
        const target = Grid.cellAt(e.clientX, e.clientY);
        if (!target) { render(); return; }
        const toKey = target.dataset.key;
        if (toKey === key && state.activePage === srcPageId) { render(); return; }
        const copy = e.ctrlKey || e.metaKey;
        if (copy) {
          moveItem(key, item.id, toKey, true, srcPageId);
          return;
        }
        if (mergeKey === toKey) {
          // 驻足后松手：合并成文件夹
          moveItem(key, item.id, toKey, false, srcPageId);
          return;
        }
        const dst = cellOf(toKey, false);
        if (dst && (dst.items || []).length === 1) {
          // 目标格已有单个图标：互换（安卓式）
          swapItems(key, item.id, toKey, srcPageId);
          return;
        }
        // 空格或已是文件夹：直接并入
        moveItem(key, item.id, toKey, false, srcPageId);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    const rebuild = () => {
      const cur = cellOf(key, false);
      if (!cur || !cur.items.length) { closeDialog(); return; }
      const c2 = cur;
      body.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'folder-grid';
      c2.items.forEach((item) => {
        const node = document.createElement('div');
        node.className = 'icon';
        node.dataset.item = item.id;

        node.appendChild(Grid.tile(item, state));

        const lb = document.createElement('span');
        lb.className = 'icon-label';
        lb.textContent = item.name || '';
        node.appendChild(lb);

        node.addEventListener('pointerover', () => { ui.hoverItem = { itemId: item.id, cellKey: key }; });
        node.addEventListener('pointerleave', () => { if (ui.hoverItem && ui.hoverItem.itemId === item.id) ui.hoverItem = null; });
        node.addEventListener('pointerdown', (e) => startPopupDrag(e, item, node, grid));
        node.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY, [
            { label: '打开', action: () => launchItem(item) },
            { label: '编辑', action: () => { closeDialog(); openItemDialog(key, item); } },
            item.target && isLocalTarget(item.target)
              ? { label: '在资源管理器中显示', action: () => api.reveal(item.target) }
              : { sep: true },
            { label: '删除', danger: true, hint: shortcutHint('delete'), action: () => {
              const cur2 = cellOf(key, false);
              if (!cur2) return;
              cur2.items = cur2.items.filter((i) => i.id !== item.id);
              cleanupCell(key);
              scheduleSave();
              render();
              rebuild();
            } },
          ]);
        });
        grid.appendChild(node);
      });
      body.appendChild(grid);
    };

    body = openDialog({
      title: cell.name || cell.items.length + ' 个应用',
      body: '<div class="hintline">单击启动，右键可编辑或删除。双击标题可修改文件夹名称与样式。</div>',
      buttons: [
        // 注意：返回 false 表示「保持当前弹窗」，否则 openDialog 会在打开添加界面后
        // 又把它关掉，看起来就像点了没反应
        { label: '添加快捷方式', ghost: true, onClick: () => { openItemDialog(key, null); return false; } },
        { label: '关闭', primary: true },
      ],
    });
    ui.folderDialogKey = key;
    ui.hoverItem = null;
    el.dialogTitle.classList.add('editable-title');
    el.dialogTitle.title = '双击修改文件夹名称与样式';
    el.dialogTitle.ondblclick = () => { closeDialog(); openCellDialog(key); };
    rebuild();
    requestIcons();
  }

  /* ---------------------------------- Toast ---------------------------------- */

  function toast(msg, type) {
    el.toast.textContent = msg;
    el.toast.className = 'toast' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
  }

  /* --------------------------------- 事件绑定 -------------------------------- */

  function bindEvents() {
    // 窗口控制
    $('btn-min').addEventListener('click', () => api.win.minimize());
    $('btn-max').addEventListener('click', () => api.win.toggleMax());
    $('btn-close').addEventListener('click', () => api.win.close());

    if (api.onWindowState) {
      api.onWindowState((s) => {
        const btn = $('btn-max');
        if (!btn) return;
        const max = !!(s && s.maximized);
        btn.classList.toggle('maximized', max);
        btn.title = max ? '还原' : '最大化';
      });
    }

    // 右下角休息状态：点击进入设置页的「休息」页签
    const tbRest = $('tb-rest');
    if (tbRest) {
      tbRest.addEventListener('click', () => openSettings('rest'));
      tbRest.title = '点击进入休息设置';
    }

    // 搜索：全局搜索所有页，结果渲染成一个独立的临时「搜索结果」页
    const search = $('search');
    search.addEventListener('input', () => {
      ui.q = search.value;
      runSearch();
    });

    // 工具栏：图标大小（行高列宽按基准 54px↔80×80 等比联动）
    const size = $('icon-size');
    size.value = String(state.settings.iconSize || 54);

    // 应用图标大小：滑块和 Ctrl+滚轮共用
    let sizeTipTimer = null;
    function showSizeTip(v) {
      const tip = $('size-tip');
      if (!tip) return;
      tip.textContent = v + 'px';
      tip.classList.add('show');
      clearTimeout(sizeTipTimer);
      sizeTipTimer = setTimeout(() => tip.classList.remove('show'), 900);
    }
    function applyIconSize(raw) {
      const v = Math.min(76, Math.max(36, Math.round(raw)));
      state.settings.iconSize = v;
      if (String(size.value) !== String(v)) size.value = String(v);
      el.grid.style.setProperty('--icon-size', v + 'px');
      const side = Math.max(40, Math.round(80 * v / 54));
      state.pages.forEach((p) => {
        p.rows.forEach((r) => { r.height = side; });
        p.cols.forEach((c) => { c.width = side; });
      });
      showSizeTip(v);
      scheduleSave();
      render();
    }

    size.addEventListener('pointerdown', () => pushHistory()); // 一次拖动只记一条历史
    size.addEventListener('input', () => applyIconSize(Number(size.value)));

    // Ctrl + 滚轮调节图标大小（一次连续滚动只记一条撤销历史）
    let wheelHistoryOpen = false;
    let wheelEndTimer = null;
    el.canvas.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault(); // 阻止 Chromium 缩放整个界面
      if (!wheelHistoryOpen) { pushHistory(); wheelHistoryOpen = true; }
      clearTimeout(wheelEndTimer);
      wheelEndTimer = setTimeout(() => { wheelHistoryOpen = false; }, 500);
      // deltaY 向下滚为放大 / 向上滚为缩小（2px 一档，与滑块一致）
      const step = e.deltaY < 0 ? 2 : -2;
      applyIconSize((Number(state.settings.iconSize) || 54) + step);
    }, { passive: false });

    // 锁定布局：禁止拖动图标
    $('btn-lock').addEventListener('click', toggleLock);
    updateLockBtn();

    // 标题栏左侧按钮：展开 / 折叠侧边栏（折叠后只显示图标）
    const btnSidebar = $('btn-sidebar');
    if (btnSidebar) {
      btnSidebar.addEventListener('click', () => {
        const show = state.settings.sidebar === false;
        state.settings.sidebar = show;
        el.sidebar.classList.toggle('collapsed', !show);
        btnSidebar.title = show ? '折叠侧边栏（只显示图标）' : '展开侧边栏';
        scheduleSave();
      });
    }

    // 标题栏主题切换：太阳 / 月亮，点击直接在浅色与深色之间切换（不再跟随系统）
    const btnTheme = $('btn-theme');
    if (btnTheme) {
      btnTheme.addEventListener('click', () => {
        const dark = (document.documentElement.dataset.theme || 'dark') === 'dark';
        const source = dark ? 'light' : 'dark';
        pushHistory();
        state.settings.theme = source;
        scheduleSave();
        // 先应用主题再重渲染：格子样式是按当前主题取的，顺序反了就会用旧配色
        const apply = (t) => { applyThemeDom(t); render(); };
        if (api.theme) api.theme.set(source).then(apply).catch(() => apply({ source, dark: !dark }));
        else apply({ source, dark: !dark });
      });
    }

    // 侧栏底部「设置」：进入 / 退出设置页
    $('btn-settings').addEventListener('click', () => {
      if (ui.settingsOpen) closeSettings();
      else openSettings();
    });

    // 侧栏「快速启动」：从设置页或搜索页回到宫格
    const btnQuick = $('btn-quickstart');
    if (btnQuick) {
      btnQuick.addEventListener('click', () => {
        if (ui.searchPage) { toggleSearch(false); return; }
        if (ui.settingsOpen) { closeSettings(); return; }
        render();
      });
    }

    // 鼠标滚轮在分页按钮上滚动：上下滚 → 左右滚（页签超出宽度时横向翻动）
    if (el.pageTabs) {
      el.pageTabs.addEventListener('wheel', (e) => {
        const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (!delta || el.pageTabs.scrollWidth <= el.pageTabs.clientWidth) return;
        e.preventDefault();
        el.pageTabs.scrollLeft += delta;
      }, { passive: false });
    }

    // 分页工具条空白处右键：增加一页应用（页签自己的右键菜单优先）
    if (el.pageTabs) {
      el.pageTabs.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.page-tab') || e.target.closest('.page-add')) return;
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: '增加一页应用', action: () => addPage() },
        ]);
      });
    }

    // 搜索按钮：点击展开为搜索框 / 再点收起
    $('btn-search').addEventListener('click', () => toggleSearch());
    search.addEventListener('blur', () => { if (!search.value) toggleSearch(false); });

    // 宫格事件（委托，重渲染后依然有效）
    // 双击行/列标题：重命名与外观
    el.grid.addEventListener('dblclick', (e) => {
      const head = e.target.closest('[data-axis]');
      if (!head) return;
      openHeaderDialog(head.dataset.axis, head.dataset.id);
    });

    if (el.pageTabs) {
      // 悬停页签 → Delete 删除整页（用委托，页签会被频繁重建）
      el.pageTabs.addEventListener('pointerover', (e) => {
        const tab = e.target.closest('.page-tab');
        if (tab && tab.dataset.id && !ui.searchPage && !ui.settingsOpen) {
          ui.hoverStruct = { kind: 'page', id: tab.dataset.id };
        }
      });
      el.pageTabs.addEventListener('pointerleave', () => {
        if (ui.hoverStruct && ui.hoverStruct.kind === 'page') ui.hoverStruct = null;
      });
    }

    // 记录鼠标当前悬停的图标（供 Delete 键删除）
    el.grid.addEventListener('pointerover', (e) => {
      const iconNode = e.target.closest('.icon');
      const target = e.target;
      // 结构目标：行标题 / 列标题 / 格子（Delete 键删除整行整列、清空格子）
      const headNode = target.closest('[data-axis]');
      const cellNode = target.closest('.cell');
      if (headNode) {
        ui.hoverStruct = { kind: headNode.dataset.axis, id: headNode.dataset.id };
      } else if (cellNode) {
        ui.hoverStruct = { kind: 'cell', key: cellNode.dataset.key };
      } else {
        ui.hoverStruct = null;
      }

      // 离开图标就必须清空，否则鼠标移到行列标题 / 格子上按 Delete 会删掉最后碰过的图标
      if (!iconNode) { ui.hoverItem = null; return; }
      const cellOfIcon = iconNode.closest('.cell');
      ui.hoverItem = {
        itemId: iconNode.dataset.item || '',
        cellKey: cellOfIcon ? cellOfIcon.dataset.key : null,
      };
    });
    el.grid.addEventListener('pointerleave', () => { ui.hoverItem = null; ui.hoverStruct = null; });

    // 左上角四宫格工具（搜索页为只读合成页，不参与）
    el.grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.corner-btn');
      if (!btn) return;
      if (ui.searchPage || !el.overlay.classList.contains('hidden')) return;
      const action = btn.dataset.action;
      if (action === 'transpose') { transposePage(); return; }
      if (action === 'rev-cols') { reverseCols(); return; }
      if (action === 'rev-rows') { reverseRows(); return; }
      if (action === 'clear-page') {
        const page = curPage();
        if (!page) return;
        const n = pageItemCount(page);
        if (!n) { toast('本页没有应用可清空', 'err'); return; }
        confirmDialog('清空整页应用？', '「' + (page.name || '未命名') + '」' + countText(n) + '，行列与页面会保留，可用 ' + shortcutHint('undo') + ' 撤销。', '清空', () => clearPageItems());
      }
    });

    el.grid.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;

      // 复用图标模式下点到空白处：退出拾取模式（点图标/文件夹继续走复制逻辑）
      if (ui.reuseIcon && !e.target.closest('.icon') && !e.target.closest('.folder')) cancelReuseIcon();

      // 搜索结果页是只读的：只允许点按启动，不能拖拽 / 添加
      if (ui.searchPage) {
        const iconNode = e.target.closest('.icon');
        if (iconNode) {
          const hit = findSearchHit(iconNode.dataset.item);
          if (hit) handleIconTap(hit.item);
        }
        return;
      }

      // 整个表头都可以拖拽（不再依赖小把手），移动超过阈值才算拖拽，否则保留点击/双击行为
      const head = e.target.closest('[data-axis]');
      if (head) {
        startHeaderDrag(e, head.dataset.axis, head);
        return;
      }

      const cell = e.target.closest('.cell');
      if (!cell) return;
      ui.activeCell = cell.dataset.key;

      const iconNode = e.target.closest('.icon');
      if (iconNode) {
        startIconDrag(e, cell.dataset.key, iconNode.dataset.item);
        return;
      }

      const folder = e.target.closest('.folder');
      if (folder) {
        startFolderDrag(e, cell.dataset.key);
        return;
      }

      // 空白格单击 = 添加图标
      if (cell.classList.contains('is-empty')) {
        const key = cell.dataset.key;
        const x = e.clientX;
        const y = e.clientY;
        const onUp = (ev) => {
          window.removeEventListener('pointerup', onUp);
          if (Math.hypot(ev.clientX - x, ev.clientY - y) < 7) openItemDialog(key, null);
        };
        window.addEventListener('pointerup', onUp);
      }
    });

    el.grid.addEventListener('contextmenu', (e) => {
      e.preventDefault();

      // 设置页：不弹任何右键菜单
      if (ui.settingsOpen) return;

      // 搜索结果页：右键打开所在页面
      if (ui.searchPage) {
        const iconNode = e.target.closest('.icon');
        if (iconNode) openSearchItemMenu(iconNode.dataset.item, e.clientX, e.clientY);
        return;
      }

      const head = e.target.closest('[data-axis]');
      if (head) {
        openHeaderMenu(head.dataset.axis, head.dataset.id, e.clientX, e.clientY);
        return;
      }
      const cell = e.target.closest('.cell');
      if (!cell) {
        openMenu(e.clientX, e.clientY, [
          { label: '添加一行', action: () => insertRow(curPage().rows.length) },
          { label: '添加一列', action: () => insertCol(curPage().cols.length) },
        ]);
        return;
      }
      ui.activeCell = cell.dataset.key;
      const iconNode = e.target.closest('.icon');
      if (iconNode) {
        openIconMenu(cell.dataset.key, iconNode.dataset.item, e.clientX, e.clientY);
        return;
      }
      const folder = e.target.closest('.folder');
      if (folder) {
        openMenu(e.clientX, e.clientY, [
          { label: '展开分组', action: () => openFolder(cell.dataset.key) },
          { label: '编辑格子样式', action: () => openCellDialog(cell.dataset.key) },
          { label: '清空这个格子', danger: true, action: () => { delete curPage().cells[cell.dataset.key]; scheduleSave(); render(); } },
        ]);
        return;
      }
      openCellMenu(cell.dataset.key, e.clientX, e.clientY);
    });

    // 拖入文件：落在格子上进该格，落在画布空白处进当前格（桌面拖来也能接住）
    window.addEventListener('dragover', (e) => e.preventDefault());
    el.canvas.addEventListener('dragover', (e) => {
      if (!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (ui.searchPage || ui.settingsOpen) return;
      const cell = e.target.closest('.cell');
      if (cell) cell.classList.add('drop-hover');
    });
    el.canvas.addEventListener('dragleave', (e) => {
      const cell = e.target.closest('.cell');
      if (cell) cell.classList.remove('drop-hover');
    });
    el.canvas.addEventListener('drop', async (e) => {
      e.preventDefault();
      // 设置页 / 搜索结果页只读：不允许把文件加进去
      if (ui.settingsOpen) return;
      if (ui.searchPage) {
        toast('搜索结果页不能添加图标，按 Esc 退出搜索后再拖入', 'err');
        return;
      }
      const cell = e.target.closest('.cell');
      const key = cell ? cell.dataset.key : (ui.activeCell || firstCellKey());
      clearHighlight();
      if (!key) return;
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
      if (!paths.length) {
        if (files.length) toast(isElectron ? '没有读取到文件路径' : '浏览器预览模式无法读取本地文件路径', 'err');
        return;
      }
      const targetCell = cellOf(key, true);
      pushHistory();
      // .lnk 快捷方式：名字用 .lnk 文件名，目标指向它真实指向的程序
      const resolved = await Promise.all(paths.map(async (p) => {
        let target = p;
        if (api.resolveShortcut) {
          try {
            const info = await api.resolveShortcut(p);
            if (info && info.target) target = info.target;
          } catch (_) {}
        }
        return { name: baseName(p), target };
      }));
      resolved.forEach((r) => {
        targetCell.items.push({
          id: Grid.newId('i'),
          name: r.name,
          target: r.target,
          args: '',
          cwd: '',
          icon: { type: 'auto', value: '' },
        });
      });
      scheduleSave();
      render();
      requestIcons();
      toast('已添加 ' + resolved.length + ' 个快捷方式', 'ok');
    });

    // 全局关闭菜单 / 弹窗
    document.addEventListener('pointerdown', (e) => {
      if (!el.menu.classList.contains('hidden') && !e.target.closest('.menu')) closeMenu();
    }, true);

    el.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === el.overlay) closeDialog();
    });
    $('dialog-x').addEventListener('click', closeDialog);

    document.addEventListener('keydown', (e) => {
      const str = eventToShortcutStr(e);
      const shortcuts = getShortcuts();
      const typing = (() => {
        const ae = document.activeElement;
        return !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable));
      })();

      // 正在录制快捷键：捕获下一次按键
      if (ui.shortcutListening) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          ui.shortcutListening = null;
          render();
          return;
        }
        if (e.key === 'Backspace') {
          // 退格恢复默认
          const id = ui.shortcutListening;
          const def = SHORTCUT_DEFAULTS[id];
          state.settings.shortcuts[id] = def;
          scheduleSave();
          ui.shortcutListening = null;
          toast('已恢复默认：' + formatShortcut(def), 'ok');
          render();
          return;
        }
        // 单独按修饰键不录制
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
        const id = ui.shortcutListening;
        // 检查是否与其它快捷键冲突（包括系统固定的 Enter / Esc）
        const conflict = Object.keys(shortcuts).find((k) => k !== id && shortcuts[k] === str);
        if (conflict) {
          const cdef = SHORTCUT_DEFS.find((d) => d.id === conflict);
          toast('该按键已被「' + (cdef ? cdef.name : conflict) + '」占用', 'err');
          return;
        }
        state.settings.shortcuts[id] = str;
        scheduleSave();
        ui.shortcutListening = null;
        toast('已设置为 ' + formatShortcut(str), 'ok');
        render();
        return;
      }

      // 关闭 / 取消（Esc）：全局生效
      if (str === shortcuts.cancel) {
        if (ui.reuseIcon) { cancelReuseIcon(); return; }
        closeMenu();
        if (!el.overlay.classList.contains('hidden')) closeDialog();
        if (ui.settingsOpen) {
          // 设置页搜索展开时，Esc 先收起搜索框；再按才退出设置页
          if (ui.settingsSearchOpen) {
            ui.settingsSearchOpen = false;
            ui.settingsQuery = '';
            render();
          } else {
            closeSettings();
          }
        }
        if (document.activeElement === search || ui.searchPage) {
          toggleSearch(false);
          search.blur();
        }
        return;
      }

      // 确认弹窗（Enter）：仅在弹窗打开时
      if (str === shortcuts.confirm && !el.overlay.classList.contains('hidden') && !e.isComposing) {
        const ae = document.activeElement;
        if (ae && ae.tagName === 'BUTTON' && el.dialogFoot.contains(ae)) return;
        const btn = Array.from(el.dialogFoot.querySelectorAll('.btn')).find((b) => !b.classList.contains('ghost'));
        if (btn) {
          e.preventDefault();
          btn.click();
        }
        return;
      }

      // 以下为可配置的应用级快捷键：输入框内不拦截（交给原生编辑）
      if (typing) return;

      // 删除悬停的应用（宫格 / 文件夹弹窗内均可）
      if (str === shortcuts.delete && !ui.settingsOpen && !ui.searchPage) {
        const overlayHidden = el.overlay.classList.contains('hidden');
        if (overlayHidden || ui.folderDialogKey !== null) {
          // 先删悬停的图标；没有图标时，按悬停的页签 / 行标题 / 列标题 / 格子分别删除
          if (confirmDeleteHovered()) { e.preventDefault(); return; }
          if (overlayHidden && confirmDeleteHoveredStruct()) { e.preventDefault(); return; }
          return;
        }
      }

      // 打开搜索
      if (str === shortcuts.search && document.activeElement !== search && el.overlay.classList.contains('hidden') && !ui.settingsOpen) {
        e.preventDefault();
        toggleSearch(true);
        return;
      }

      // 添加应用
      if (str === shortcuts.add && el.overlay.classList.contains('hidden') && !ui.settingsOpen) {
        e.preventDefault();
        if (ui.searchPage) { toast('搜索结果页不能添加图标，按 Esc 退出搜索后再试', 'err'); return; }
        openItemDialog(ui.activeCell || firstCellKey(), null);
        return;
      }

      // 撤销（Ctrl+Alt+Z / Ctrl+Shift+Z 留给系统）
      if (str === shortcuts.undo && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        undo();
        return;
      }
    });
  }

  // 搜索：搜索按钮展开成输入框；收起时退出搜索并恢复真实页
  function toggleSearch(force) {
    const show = force === true ? true : force === false ? false : el.tbSearch.classList.contains('hidden');
    el.tbSearch.classList.toggle('hidden', !show);
    $('btn-search').classList.toggle('hidden', show);
    const search = $('search');
    if (show) {
      setTimeout(() => search.focus(), 20);
    } else {
      search.value = '';
      const was = exitSearch(false);
      if (was) render();
    }
  }

  /* ---------------------------------- 启动 ---------------------------------- */

  async function boot() {
    el.canvas = $('canvas');
    el.grid = $('grid');
    el.menu = $('menu');
    el.toast = $('toast');
    el.overlay = $('overlay');
    el.dialogTitle = $('dialog-title');
    el.dialogBody = $('dialog-body');
    el.dialogFoot = $('dialog-foot');
    el.hint = $('hint');
    el.sidebar = $('sidebar');
    el.pageBar = $('page-bar');
    el.pageTabs = $('page-tabs');
    el.tbSearch = $('tb-search');

    const saved = await api.loadData();
    state = normalize(saved) || defaults();
    ui.activeCell = firstCellKey();
    el.sidebar.classList.toggle('collapsed', state.settings.sidebar === false);
    const sbBtn = $('btn-sidebar');
    if (sbBtn) sbBtn.title = state.settings.sidebar === false ? '展开侧边栏' : '折叠侧边栏（只显示图标）';

    bindEvents();
    render();
    requestIcons();

    // 贴边自动收起：启动时把设置同步到主进程（主进程 initEdgeSnap 只在 Electron 下生效）
    if (api.edgeSnap && isElectron) api.edgeSnap.set(!!state.settings.edgeSnap).catch(() => {});

    // 标题栏居中展示休息提醒状态（订阅 + 首帧轮询）
    restApi.getStatus().then(paintTbRest).catch(() => {});
    restApi.onStatus(paintTbRest);

    // 主题：读当前配置并订阅系统变化
    applyCurrentTheme();
    if (api.theme) api.theme.onChange((t) => { applyThemeDom(t); render(); });
    if (api.theme) api.theme.get().then((t) => { applyThemeDom(t); render(); }).catch(() => {});
    else applyThemeDom({ source: state.settings.theme || 'system', dark: true });

    if (!isElectron) {
      toast('浏览器预览模式：可以体验排版，启动本地程序需用 Electron 运行', 'err');
    }
  }

  boot();
})();

