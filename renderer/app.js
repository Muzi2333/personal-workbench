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
      updates: {
        check: async () => ({ ok: false, error: '预览模式不支持自动更新' }),
        download: async () => ({ ok: false, error: '预览模式不支持自动更新' }),
        install: async () => ({ ok: false, error: '预览模式不支持自动更新' }),
        onState: () => {},
      },
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
  const updatesApi = api.updates || fallbackApi().updates;

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
    sidebarShortcutListening: null, // 正在录制快捷键的侧边栏项 id（null = 未在录制）
    lastTap: { item: '', t: 0 },
    searchPage: null, // 搜索结果临时页（不落盘）
    settingsOpen: false, // 设置页（分页工具条齿轮进入，不落盘）
    browserOpen: false,  // 内嵌浏览器视图（侧边栏「浏览器」进入，不落盘）
    telegramOpen: false, // Telegram 网页版视图（侧边栏「Telegram」进入，不落盘）
    proxyOpen: false,    // 代理管理视图（侧边栏「代理」进入，不落盘）
    proxyTab: 'overview', // 代理页当前功能区：overview / proxies / subs / settings
    settingsTab: 'general', // 设置页当前标签：general / rest / app
    settingsQuery: '', // 设置页搜索词（不落盘）
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

  /* ----------------------------- 侧边栏导航项 ----------------------------- */
  // 侧边栏所有可配置项的元数据（id 对应 HTML 中 btn-{id}）
  const SIDEBAR_ITEMS = [
    { id: 'quickstart', name: '快速启动' },
    { id: 'proxy',      name: '代理' },
    { id: 'browser',    name: '浏览器' },
    { id: 'telegram',   name: 'Telegram' },
    { id: 'settings',   name: '设置' },
  ];
  // 侧边栏默认配置：顺序 / 置顶或置底 / 是否显示 / 快捷键
  const DEFAULT_SIDEBAR_NAV = [
    { id: 'quickstart', order: 1, position: 'top',    visible: true, shortcut: 'F1' },
    { id: 'proxy',      order: 2, position: 'top',    visible: true, shortcut: 'F2' },
    { id: 'browser',    order: 3, position: 'top',    visible: true, shortcut: 'F3' },
    { id: 'telegram',   order: 4, position: 'top',    visible: true, shortcut: 'F4' },
    { id: 'settings',   order: 5, position: 'bottom', visible: true, shortcut: 'F5' },
  ];
  // 把用户保存的侧边栏配置补齐为完整结构（不丢用户自定义）
  function normalizeSidebarNav(raw) {
    const map = {};
    (raw || []).forEach((x) => { if (x && x.id) map[x.id] = x; });
    return SIDEBAR_ITEMS.map((def) => {
      const u = map[def.id] || {};
      return {
        id: def.id,
        order: typeof u.order === 'number' ? u.order : DEFAULT_SIDEBAR_NAV.find((d) => d.id === def.id).order,
        position: u.position === 'bottom' ? 'bottom' : 'top',
        visible: u.visible === false ? false : true,
        shortcut: typeof u.shortcut === 'string' ? u.shortcut : DEFAULT_SIDEBAR_NAV.find((d) => d.id === def.id).shortcut,
      };
    });
  }
  function getSidebarNav() {
    return normalizeSidebarNav(state && state.settings && state.settings.sidebarNav);
  }
  // 侧边栏显示顺序：置顶组在前、置底组在后，组内按 order 升序（设置列表与真实侧栏共用）
  function sortSidebarNav(nav) {
    return nav.slice().sort((a, b) => {
      if (a.position !== b.position) return a.position === 'top' ? -1 : 1;
      return a.order - b.order;
    });
  }

  // 单元格统一样式（全局默认）：分深色 / 浅色两套；每个单元格可单独覆盖（留空则继承）
  const DEFAULT_CELL_STYLE = {
    dark:  { bg: '#262829', border: '#2b2e30', radius: 12 },
    light: { bg: '#ffffff', border: '#e4e7ed', radius: 12 },
  };

  // 内嵌浏览器默认配置
  const DEFAULT_BROWSER = {
    enabled: true,            // 是否启用内嵌浏览器（关闭后侧边栏隐藏入口）
    startup: 'newtab',        // 启动时：newtab 打开新标签页 / continue 继续上次 / custom 自定义网址
    startupUrl: '',           // startup=custom 时的网址
    homeButton: true,         // 工具栏是否显示「主页」按钮
    homeAction: 'newtab',     // 主页按钮行为：newtab 新标签页 / custom 自定义网址
    homeUrl: '',              // homeAction=custom 时的网址
    newTab: 'homepage',       // 新建标签页打开：homepage 首页 / custom 自定义 / blank 空白页
    newTabUrl: '',            // newTab=custom 时的网址
    openLinksInApp: true,     // 网址快捷方式默认用内嵌浏览器打开（否则走系统默认浏览器）
    theme: 'system',          // 浏览器外观主题：system 跟随工作台 / light 浅色 / dark 深色
    showFavBar: false,        // 是否在工具栏下方显示收藏夹栏
    hideFavButtons: false,    // 是否隐藏工具栏上的收藏夹按钮
    savePasswords: true,      // 是否启用密码保存（密码管理器总开关）
    passwords: [],            // 已保存的密码：[{ id, site, username, password, note, addedAt }]
    // 收藏夹树形结构：根节点为文件夹，children 可嵌套文件夹或书签
    bookmarks: [
      { id: 'fav-bar', type: 'folder', title: '收藏夹栏', children: [] },
      { id: 'fav-other', type: 'folder', title: '其他书签', children: [] },
    ],
  };

  // Telegram 配置（内嵌 Telegram 网页版相关）
  const DEFAULT_TELEGRAM = {
    enabled: true,        // 自动保存媒体到本地（主开关）
    saveMediaPath: '',    // 空 = 系统下载目录下的 Telegram 子目录；否则使用自定义绝对路径
  };
  function telegramConfig() {
    const t = state && state.settings && state.settings.telegram;
    return Object.assign({}, DEFAULT_TELEGRAM, t || {});
  }

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
      settings: { iconSize: 54, showLabels: true, launch: 'double', sidebar: true, undoLimit: 100, locked: false, theme: 'system', headStyle: 'solid', gap: 10, headRadius: 8, edgeSnap: false, autoUpdate: false, shortcuts: Object.assign({}, SHORTCUT_DEFAULTS), sidebarNav: JSON.parse(JSON.stringify(DEFAULT_SIDEBAR_NAV)), cellStyle: Object.assign({}, DEFAULT_CELL_STYLE), browser: Object.assign({}, DEFAULT_BROWSER), telegram: Object.assign({}, DEFAULT_TELEGRAM) },
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

    data.settings = Object.assign({ iconSize: 54, showLabels: true, launch: 'double', sidebar: true, undoLimit: 100, locked: false, theme: 'system', headStyle: 'solid', gap: 10, headRadius: 8, edgeSnap: false, autoUpdate: false }, data.settings || {});
    // 快捷键：补齐缺失项（新增的快捷键自动用默认值），不覆盖用户已自定义的
    data.settings.shortcuts = Object.assign({}, SHORTCUT_DEFAULTS, data.settings.shortcuts || {});
    // 侧边栏导航配置：补齐顺序 / 位置 / 可见性 / 快捷键
    data.settings.sidebarNav = normalizeSidebarNav(data.settings.sidebarNav);
    // 单元格统一样式：补齐深浅色两套，各自再内部补齐字段
    const cs = data.settings.cellStyle || {};
    cs.dark = Object.assign({}, DEFAULT_CELL_STYLE.dark, cs.dark || {});
    cs.light = Object.assign({}, DEFAULT_CELL_STYLE.light, cs.light || {});
    data.settings.cellStyle = cs;
    // 内嵌浏览器：补齐默认配置（旧数据无此字段时自动启用）
    data.settings.browser = Object.assign({}, DEFAULT_BROWSER, data.settings.browser || {});
    // Telegram：补齐默认配置（旧数据无此字段时自动启用）
    data.settings.telegram = Object.assign({}, DEFAULT_TELEGRAM, data.settings.telegram || {});
    // 收藏夹数据迁移：旧版为扁平数组 [{id,title,url,folder}]，新版为树形结构
    const bm = data.settings.browser.bookmarks;
    if (Array.isArray(bm) && bm.length && bm[0] && bm[0].type !== 'folder') {
      const bar = { id: 'fav-bar', type: 'folder', title: '收藏夹栏', children: [] };
      const other = { id: 'fav-other', type: 'folder', title: '其他书签', children: [] };
      bm.forEach((x) => {
        const node = { id: x.id, type: 'url', title: x.title || x.url, url: x.url, addedAt: x.addedAt || Date.now() };
        if (x.folder && x.folder !== '未分类' && x.folder !== 'Edge 导入') {
          bar.children.push(node);
        } else {
          other.children.push(node);
        }
      });
      data.settings.browser.bookmarks = [bar, other];
    }
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
    ui.hoverStruct = null;
    applyBrowserTheme();
    // 浏览器视图：覆盖宫格区域，隐藏分页工具条与画布
    if (ui.browserOpen) {
      if (el.canvas) el.canvas.classList.add('hidden');
      if (el.pageBar) el.pageBar.classList.add('hidden');
      if (el.telegram) el.telegram.classList.add('hidden');
      if (el.browser) el.browser.classList.remove('hidden');
      renderBookmarkBar();
      renderSidebar();
      return;
    }
    // Telegram 视图：独立 webview 覆盖宫格区域
    if (ui.telegramOpen) {
      if (el.canvas) el.canvas.classList.add('hidden');
      if (el.pageBar) el.pageBar.classList.add('hidden');
      if (el.browser) el.browser.classList.add('hidden');
      if (el.telegram) el.telegram.classList.remove('hidden');
      renderSidebar();
      return;
    }
    if (el.telegram) el.telegram.classList.add('hidden');
    if (el.browser) el.browser.classList.add('hidden');
    if (el.canvas) el.canvas.classList.remove('hidden');
    const canvas = el.canvas;
    const sx = canvas.scrollLeft;
    const sy = canvas.scrollTop;
    if (ui.settingsOpen) renderSettingsPage();
    else if (ui.proxyOpen) renderProxyPage();
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
    if (ui.proxyOpen) closeProxy();
    if (ui.telegramOpen) closeTelegram();
    const s = $('search');
    if (s) s.value = '';
    el.tbSearch.classList.add('hidden');
    $('btn-search').classList.remove('hidden');
    if (tab) ui.settingsTab = tab;
    ui.settingsOpen = true;
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
    ui.settingsQuery = '';
    render();
  }

  /* ------------------------------ 内嵌浏览器 ------------------------------ */

  const BROWSER_HOME = 'https://cn.bing.com';

  // 上次浏览的页面 URL（同一会话内「继续上次页面」用；不持久化到配置）
  let lastBrowserUrl = '';

  // 标签页运行时状态（不持久化；每个标签对应一个独立 <webview>）
  let browserTabs = [];       // [{ id, title, url, loading }]
  let activeTabId = null;
  let tabIdSeq = 0;

  function activeTab() { return browserTabs.find((t) => t.id === activeTabId) || null; }
  function activeWebview() {
    const t = activeTab();
    return t ? $('br-wv-' + t.id) : null;
  }

  // 根据浏览器设置计算各类网址
  function browserConfig() { return (state && state.settings && state.settings.browser) || DEFAULT_BROWSER; }

  function getHomeUrl() {
    const b = browserConfig();
    if (b.homeAction === 'custom') return trim(b.homeUrl) || BROWSER_HOME;
    return BROWSER_HOME; // newtab → 首页
  }

  function getNewTabUrl() {
    const b = browserConfig();
    if (b.newTab === 'custom') return trim(b.newTabUrl) || BROWSER_HOME;
    if (b.newTab === 'blank') return 'about:blank';
    return BROWSER_HOME; // homepage → 首页
  }

  function getStartupUrl() {
    const b = browserConfig();
    if (b.startup === 'custom') return trim(b.startupUrl) || BROWSER_HOME;
    if (b.startup === 'continue') return lastBrowserUrl || getNewTabUrl();
    return getNewTabUrl(); // newtab → 新标签页
  }

  function openBrowser(url) {
    // 未启用内嵌浏览器时不响应
    const b = browserConfig();
    if (b.enabled === false) return;
    cancelReuseIcon(true);
    exitSearch(true);
    const s = $('search');
    if (s) s.value = '';
    el.tbSearch.classList.add('hidden');
    const sb = $('btn-search');
    if (sb) sb.classList.remove('hidden');
    if (ui.proxyOpen) closeProxy();
    if (ui.telegramOpen) closeTelegram();
    ui.settingsOpen = false;
    ui.browserOpen = true;
    render();
    // 没有标签则新建；指定了 URL 则新开标签加载；否则激活已有标签
    if (browserTabs.length === 0) {
      newTab(url || getStartupUrl(), true);
    } else if (url) {
      newTab(url, true);
    } else {
      switchTab(activeTabId);
    }
  }

  function closeBrowser() {
    if (!ui.browserOpen) return;
    ui.browserOpen = false;
    render();
  }

  /* ------------------------------ Telegram（官方网页版 Web K） ------------------------------ */
  // 独立 webview + 独立持久化 partition（persist:telegram）：登录态与内置浏览器互不影响；
  // 走自身代理由主进程 applySessionProxy 对该 partition 单独 setProxy 生效。

  const TG_URL = 'https://web.telegram.org/k/';
  let tgWebview = null;

  function ensureTelegramWebview() {
    if (tgWebview) return;
    const host = $('tg-views');
    if (!host) return;
    const wv = document.createElement('webview');
    wv.id = 'tg-wv';
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('partition', 'persist:telegram');
    wv.setAttribute('nodeintegration', '');
    wv.setAttribute('contextisolation', 'false');
    tgWebview = wv;

    // 注入媒体拦截脚本：preload 必须在首次导航前设置好，所以先拿路径再设 src 并挂载
    const tgApi = api.telegram;
    const mount = () => { if (tgWebview === wv && !wv.parentNode) { wv.src = TG_URL; host.appendChild(wv); } };
    if (tgApi && tgApi.preloadPath) {
      tgApi.preloadPath().then((p) => {
        try {
          if (tgWebview === wv && p) wv.setAttribute('preload', encodeURI('file:///' + String(p).replace(/\\/g, '/')));
        } catch (_) {}
        mount();
      }).catch(mount);
      wv.addEventListener('ipc-message', (e) => {
        if (e.channel === 'tg-media' && e.args && e.args[0]) {
          tgApi.saveMedia(e.args[0]).then((r) => { if (r && r.ok) tgSavedToast(); }).catch(() => {});
        }
      });
      // 把 webview/preload 的控制台日志转发到主窗口，方便排查
      wv.addEventListener('console-message', (e) => {
        console.log('[tg-webview]', e.message);
      });
    } else {
      mount();
    }
  }

  // 自动保存提示合并：短时间内大量媒体时只弹一次汇总
  let tgSavedCount = 0;
  let tgSavedTimer = null;
  function tgSavedToast() {
    tgSavedCount++;
    clearTimeout(tgSavedTimer);
    tgSavedTimer = setTimeout(() => {
      toast('已自动保存 ' + tgSavedCount + ' 个媒体到「下载\\Telegram」', 'ok');
      tgSavedCount = 0;
    }, 1500);
  }

  function openTelegram() {
    cancelReuseIcon(true);
    exitSearch(true);
    const s = $('search');
    if (s) s.value = '';
    el.tbSearch.classList.add('hidden');
    $('btn-search').classList.remove('hidden');
    if (ui.proxyOpen) closeProxy();
    if (ui.browserOpen) closeBrowser();
    ui.settingsOpen = false;
    ui.telegramOpen = true;
    render();
    ensureTelegramWebview();
  }

  function closeTelegram() {
    if (!ui.telegramOpen) return;
    ui.telegramOpen = false;
    render();
  }

  // 刷新：重新加载页面（保留登录态与缓存）
  function reloadTelegram() {
    if (!ui.telegramOpen) { openTelegram(); return; }
    if (tgWebview) { try { tgWebview.reload(); } catch (_) {} }
  }

  // 重启：销毁 webview 重建（清掉运行时状态；partition 持久化，登录态仍在）
  function restartTelegram() {
    if (tgWebview) { try { tgWebview.remove(); } catch (_) {} tgWebview = null; }
    if (ui.telegramOpen) ensureTelegramWebview();
    else openTelegram();
  }

  function openTelegramMenu(x, y) {
    openMenu(x, y, [
      { label: '刷新', action: reloadTelegram },
      { label: '重启', action: restartTelegram },
    ]);
  }

  /* ------------------------------ 代理管理页面 ------------------------------ */

  const proxyApi = api.proxy || null;

  // 代理页运行时状态（不持久化；持久化状态在主进程 proxy-state.json）
  const px = {
    state: null,
    proxies: null,
    traffic: { up: 0, down: 0, count: 0 },
    lastTraffic: null,
    speed: { up: 0, down: 0 },
    pollTimer: null,
    downloading: false,
    dlMessage: '',
    activeGroup: '',
    testingGroup: false,
    testingMode: '',    // 'direct' | 'proxy' — 正在测速的类型
    lastRunning: false,
    autoTesting: false,
    ipLoading: false,
    ipInfo: null,       // { ip, country, region, city, org, isp }
    testResults: {},    // { url: delayMs } — 网站测速结果缓存
    _resolvedNow: null,
  };

  function pxEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 关键字数组 → 输入框显示文本（只接受非空字符串，Number/NaN/null 一律丢弃）
  function kwText(arr) {
    if (!Array.isArray(arr)) return '';
    return arr
      .filter((v) => typeof v === 'string' && v.trim() && v !== 'NaN' && v !== 'undefined' && v !== 'null')
      .map((v) => v.trim())
      .join(', ');
  }

  // 输入框文本 → 关键字数组
  function kwSplit(text) {
    return String(text == null ? '' : text)
      .split(/[,，、;；\s\n\r]+/)
      .map((s) => s.trim())
      .filter((s) => s && s !== 'NaN' && s !== 'undefined' && s !== 'null');
  }

  function pxFmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return Math.round(n) + ' B';
  }

  function pxDelayText(d) { return d ? d + 'ms' : '超时'; }
  function pxDelayClass(d) {
    if (!d) return 'bad';
    if (d < 300) return 'good';
    if (d < 800) return 'mid';
    return 'bad';
  }

  function openProxy() {
    if (ui.proxyOpen) return;
    cancelReuseIcon(true);
    exitSearch(true);
    stopRestStatusTimer();
    const s = $('search');
    if (s) s.value = '';
    el.tbSearch.classList.add('hidden');
    const sb = $('btn-search');
    if (sb) sb.classList.remove('hidden');
    ui.settingsOpen = false;
    ui.browserOpen = false;
    ui.telegramOpen = false;
    if (el.telegram) el.telegram.classList.add('hidden');
    if (el.browser) el.browser.classList.add('hidden');
    ui.proxyOpen = true;
    ui.proxyTab = 'overview';
    render();
    refreshProxyState(true);
    startProxyPoll();
  }

  function closeProxy() {
    if (!ui.proxyOpen) return;
    stopProxyPoll();
    ui.proxyOpen = false;
    render();
  }

  // 通过代理查询出口 IP（ipinfo.io），用多个 API 做 fallback
  async function fetchProxyIp() {
    if (!proxyApi || !px.state || !px.state.running || px.ipLoading) return;
    px.ipLoading = true;
    // 不立即 render，等结果回来再触发；避免事件监听器被重建
    try {
      const sources = [
        'https://ipinfo.io/json',
        'https://api.ipify.org?format=json',
        'https://ipapi.co/json/',
        'http://ip-api.com/json/?lang=zh-CN',
      ];
      // 用主进程代理 fetch（通过 IPC）
      if (proxyApi.fetchIpInfo) {
        const r = await proxyApi.fetchIpInfo();
        if (r && r.ok && r.data) {
          px.ipInfo = r.data;
          px.ipLoading = false;
          if (ui.proxyOpen) render();
          return;
        }
      }
      px.ipInfo = null;
    } catch (_) {
      px.ipInfo = null;
    } finally {
      px.ipLoading = false;
      if (ui.proxyOpen) render();
    }
  }

  async function refreshProxyState(withProxies) {
    if (!proxyApi) return;
    try {
      px.state = await proxyApi.getState();
      const running = !!(px.state && px.state.running);
      if (withProxies && running) {
        const r = await proxyApi.getProxies();
        px.proxies = r && r.ok ? r : null;
        // 内核刚启动（false -> true）时自动测速并按延迟排序
        if (!px.lastRunning && !px.autoTesting) {
          px.autoTesting = true;
          testActiveGroupAndSort('proxy').finally(() => { px.autoTesting = false; });
        }
      } else if (!running) {
        px.proxies = null;
      }
      px.lastRunning = running;
    } catch (_) {}
    // 右下角代理胶囊随状态同步刷新
    paintProxyPill($('tb-rest'));
    if (ui.proxyOpen) render();
  }

  // 测试当前组全部节点延迟，并按延迟升序重排
  // mode: 'direct' 直连测速（TCP 握手，不走代理）| 'proxy' 代理测速（mihomo /delay）
  async function testActiveGroupAndSort(mode) {
    if (!proxyApi) return { ok: false, error: '代理功能不可用' };
    if (!px.activeGroup) return { ok: false, error: '请先选择节点分组' };
    if (px.testingGroup) return { ok: false, error: '正在测速中…' };
    const m = mode === 'direct' ? 'direct' : 'proxy';
    px.testingGroup = true;
    px.testingMode = m;
    if (ui.proxyOpen) render();
    let r = null;
    try {
      r = await proxyApi.testGroup(px.activeGroup, m);
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err) };
    }
    px.testingGroup = false;
    px.testingMode = '';
    if (r && r.ok) {
      const delays = r.delays || {};
      let hit = 0;
      if (px.proxies && px.proxies.nodes) {
        Object.keys(delays).forEach((name) => {
          if (px.proxies.nodes[name]) { px.proxies.nodes[name].delay = delays[name]; hit++; }
        });
      }
      r.hit = hit;
    }
    // 无论成功失败都要重建，保证按钮从"测速中…"恢复、结果立即出现
    if (ui.proxyOpen) render();
    return r;
  }

  function startProxyPoll() {
    stopProxyPoll();
    px.pollTimer = setInterval(pollProxyTraffic, 2000);
    pollProxyTraffic();
  }

  function stopProxyPoll() {
    if (px.pollTimer) { clearInterval(px.pollTimer); px.pollTimer = null; }
  }

  async function pollProxyTraffic() {
    if (!proxyApi || !ui.proxyOpen) return;
    let t = null;
    try { t = await proxyApi.getTraffic(); } catch (_) { return; }
    if (!t) return;
    const now = Date.now();
    if (px.lastTraffic && t.running) {
      const dt = Math.max(0.5, (now - px.lastTraffic.t) / 1000);
      px.speed = {
        up: Math.max(0, (t.up - px.lastTraffic.up) / dt),
        down: Math.max(0, (t.down - px.lastTraffic.down) / dt),
      };
    } else {
      px.speed = { up: 0, down: 0 };
    }
    px.lastTraffic = { t: now, up: t.up, down: t.down };
    px.traffic = { up: t.up, down: t.down, count: t.count };
    paintProxyTraffic();
  }

  // 流量统计原地刷新（不重建整页，避免打断输入/滚动）
  function paintProxyTraffic() {
    if (!ui.proxyOpen) return;
    const running = !!(px.state && px.state.running);
    const up = $('px-t-up');
    const down = $('px-t-down');
    const cnt = $('px-t-count');
    const sup = $('px-s-up');
    const sdown = $('px-s-down');
    if (up) up.textContent = running ? pxFmtBytes(px.traffic.up) : '—';
    if (down) down.textContent = running ? pxFmtBytes(px.traffic.down) : '—';
    if (cnt) cnt.textContent = running ? String(px.traffic.count) : '—';
    if (sup) sup.textContent = running ? '↑ ' + pxFmtBytes(px.speed.up) + '/s' : '';
    if (sdown) sdown.textContent = running ? '↓ ' + pxFmtBytes(px.speed.down) + '/s' : '';
    // 侧边栏底部速度显示
    const supFoot = $('px-s-up-foot');
    const sdownFoot = $('px-s-down-foot');
    if (supFoot) supFoot.textContent = running ? pxFmtBytes(px.speed.up) + '/s' : '—';
    if (sdownFoot) sdownFoot.textContent = running ? pxFmtBytes(px.speed.down) + '/s' : '—';
  }

  function renderProxyPage() {
    stopRestStatusTimer();
    el.grid.style.display = 'block';
    const oldNodesScroll = el.grid.querySelector('.px-nodes');
    const savedNodesScrollTop = oldNodesScroll ? oldNodesScroll.scrollTop : 0;

    if (!proxyApi) {
      el.grid.innerHTML = '<div class="proxy-page"><div class="set-group"><div class="set-group-title">代理</div>'
        + '<div class="set-row"><div class="set-label">浏览器预览模式不支持代理功能</div></div></div></div>';
      return;
    }

    const st = px.state;
    const installed = !!(st && st.coreInstalled);
    const running = !!(st && st.running);
    const port = (st && st.port) || 7890;
    const subs = (st && st.subscriptions) || [];
    const curTab = ui.proxyTab || 'overview';

    /* 侧边栏导航项（移除设置，新增测试） */
    const pxCoreNav = [
      ['overview', '概览', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="2" y="6" width="5" height="8" rx="1"/><rect x="9" y="3" width="5" height="11" rx="1"/><path d="M2 14h12"/></svg>'],
      ['proxies', '代理', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M2.5 8h11M8 2.3c1.8 1.6 2.8 3.7 2.8 5.7S9.8 12.1 8 13.7C6.2 12.1 5.2 10 5.2 8s1-4.1 2.8-5.7z"/></svg>'],
      ['subs', '订阅', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2" width="11" height="12" rx="1.5"/><path d="M5 5.5h6M5 8h6M5 10.5h3"/></svg>'],
      ['test', '测试', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 1.5"/></svg>'],
    ];
    const navNames = { overview: '概览', proxies: '代理', subs: '订阅', test: '测试' };
    const coreDesc = !installed ? '未安装'
      : running ? ('运行中 · 端口 ' + port)
      : ('已安装 · 未运行');

    /* IP 信息卡片 */
    let ipCard = '';
    if (!installed) {
      ipCard = '<div class="px-ip"><div class="px-ip-empty">安装内核后显示出口 IP</div></div>';
    } else if (!running) {
      ipCard = '<div class="px-ip"><div class="px-ip-empty">内核未运行</div></div>';
    } else if (px.ipLoading) {
      ipCard = '<div class="px-ip"><div class="px-ip-empty">查询中…</div></div>';
    } else if (px.ipInfo) {
      const info = px.ipInfo;
      ipCard = '<div class="px-ip">'
        + '<button class="px-ip-refresh-icon" id="px-ip-refresh" title="刷新 IP">↻</button>'
        + '<div class="px-ip-row"><span>IP</span><b>' + pxEsc(info.ip || '—') + '</b></div>'
        + '<div class="px-ip-row"><span>地区</span><b>' + pxEsc([info.country, info.region, info.city].filter(Boolean).join(' · ') || '—') + '</b></div>'
        + '<div class="px-ip-row"><span>运营商</span><b>' + pxEsc(info.org || info.isp || '—') + '</b></div>'
        + '</div>';
    } else {
      ipCard = '<div class="px-ip"><div class="px-ip-empty">点击刷新获取出口 IP</div>'
        + '<button class="btn ghost px-ip-refresh" id="px-ip-refresh">刷新 IP</button></div>';
    }

    /* 订阅卡片 */
    const subsHtml = subs.length
      ? subs.map((sub) => {
          const cur = st.currentSub === sub.id;
          const info = sub.info || null;
          let infoHtml = '';
          if (info && info.total) {
            const used = (info.upload || 0) + (info.download || 0);
            const pctUsed = Math.min(100, Math.round(used / info.total * 100));
            infoHtml = '<div class="px-sub-usage"><div class="px-sub-bar"><i style="width:' + pctUsed + '%"></i></div>'
              + '<span>已用 ' + pxFmtBytes(used) + ' / ' + pxFmtBytes(info.total) + '</span></div>';
          }
          let updatedText = '—';
          const d = sub.updatedAt ? new Date(sub.updatedAt) : null;
          if (d && !isNaN(d)) {
            updatedText = (d.getMonth() + 1) + '月' + d.getDate() + '日 '
              + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
          }
          const expireText = info && info.expire ? ' · ' + new Date(info.expire * 1000).getFullYear() + '年到期' : '';
          return '<div class="px-sub' + (cur ? ' on' : '') + '" data-id="' + pxEsc(sub.id) + '">'
            + '<div class="px-sub-main" data-act="use">'
            +   '<div class="px-sub-name">' + pxEsc(sub.name) + (cur ? '<em class="px-sub-tag">使用中</em>' : '') + '</div>'
            +   '<div class="px-sub-url">' + pxEsc(sub.url) + '</div>'
            +   '<div class="px-sub-meta">更新于 ' + updatedText + pxEsc(expireText) + '</div>'
            +   infoHtml
            + '</div>'
            + '<div class="px-sub-actions">'
            +   '<button class="px-sub-btn" data-act="refresh" title="更新">↻</button>'
            +   '<button class="px-sub-btn danger" data-act="del" title="删除">×</button>'
            + '</div>'
            + '</div>';
        }).join('')
      : '<div class="px-empty">还没有订阅</div>';

    /* 当前节点 — 使用 resolvedNow / resolvedNode 解决自动选择延迟同步 */
    let currentHtml = '';
    if (!installed) currentHtml = '<div class="px-empty">安装内核并添加订阅后可用</div>';
    else if (!running) currentHtml = '<div class="px-empty">内核未运行</div>';
    else if (!px.proxies) currentHtml = '<div class="px-empty">正在读取节点…</div>';
    else {
      const g = (px.proxies.groups || [])[0];
      if (!g) currentHtml = '<div class="px-empty">暂无代理组</div>';
      else {
        // 解析实际生效节点
        const displayName = g.resolvedNow || g.now || '—';
        const realNode = g.resolvedNode || ((px.proxies.nodes || {})[g.now]) || {};
        const isAutoResolved = g.resolvedNow && g.resolvedNow !== g.now;
        // 再测一次当前节点时也用 resolvedNow
        if (!px._resolvedNow) px._resolvedNow = {};
        px._resolvedNow[g.name] = g.resolvedNow || g.now;
        currentHtml = '<div class="px-current">'
          + '<div class="px-current-info">'
          +   '<div class="px-current-name" title="' + pxEsc(g.now) + '">' + pxEsc(displayName)
          +     (isAutoResolved ? '<span class="px-auto-hint">（' + pxEsc(g.now) + '）</span>' : '') + '</div>'
          +   '<div class="px-current-meta"><span class="px-chip">' + pxEsc(realNode.type || '—') + '</span>'
          +   '<span class="px-delay ' + pxDelayClass(realNode.delay) + '" id="px-current-delay">' + pxDelayText(realNode.delay) + '</span></div>'
          + '</div>'
          + '<button class="btn" id="px-test-current">测速</button>'
          + '</div>';
      }
    }

    /* 节点列表 */
    let groupsHtml = '';
    if (running && px.proxies) {
      const groups = (px.proxies.groups || []).filter((g) => g.all && g.all.length);
      if (groups.length) {
        if (!px.activeGroup || !groups.some((g) => g.name === px.activeGroup)) px.activeGroup = groups[0].name;
        const g = groups.find((x) => x.name === px.activeGroup);
        const nodes = px.proxies.nodes || {};
        const tabs = groups.map((x) => '<button class="px-gtab' + (x.name === g.name ? ' on' : '') + '" data-g="' + pxEsc(x.name) + '" title="' + pxEsc(x.type) + '">' + pxEsc(x.name) + '</button>').join('');
        const sortedNames = g.all.slice().sort((a, b) => {
          const da = (nodes[a] && nodes[a].delay) || 0;
          const db = (nodes[b] && nodes[b].delay) || 0;
          if (!da && !db) return 0; if (!da) return 1; if (!db) return -1; return da - db;
        });
        const rows = sortedNames.map((name) => {
          const n = nodes[name] || {};
          const cur = g.now === name;
          return '<div class="px-node' + (cur ? ' on' : '') + '" data-node="' + pxEsc(name) + '">'
            + '<span class="px-node-name">' + pxEsc(name) + '</span>'
            + '<span class="px-node-type">' + pxEsc(n.type || '') + '</span>'
            + '<span class="px-delay ' + pxDelayClass(n.delay) + '" data-delay="' + pxEsc(name) + '">' + pxDelayText(n.delay) + '</span>'
            + '</div>';
        }).join('');
        const dirTesting = px.testingGroup && px.testingMode === 'direct';
        const pxTesting = px.testingGroup && px.testingMode === 'proxy';
        groupsHtml = '<div id="px-groups-wrap"><div class="px-gtabs">' + tabs
          + '<button class="px-gtest" id="px-test-direct"' + (px.testingGroup ? ' disabled' : '') + ' title="直连测速：对节点服务器做 TCP 握手，不经过代理">' + (dirTesting ? '测速中…' : '直连测速') + '</button>'
          + '<button class="px-gtest" id="px-test-proxy"' + (px.testingGroup ? ' disabled' : '') + ' title="代理测速：通过代理内核实际请求测速 URL">' + (pxTesting ? '测速中…' : '代理测速') + '</button></div>'
          + '<div class="px-nodes">' + rows + '</div></div>';
      }
    }

    /* 模式按钮 */
    const mode = (st && st.mode) || 'rule';
    const modeBtn = (m, label, desc) => '<button data-mode="' + m + '" class="' + (mode === m ? 'on' : '') + '" title="' + desc + '">' + label + '</button>';
    const modeHtml = '<div class="px-modes" id="px-modes">'
      + modeBtn('rule', '规则', '国内直连，国外走代理')
      + modeBtn('global', '全局', '全部流量走代理')
      + modeBtn('direct', '直连', '全部流量直连')
      + '</div>';

    /* 右侧主内容：根据 curTab 选择 */
    let mainHtml = '';
    if (curTab === 'overview') {
      mainHtml = [
        /* 内核横幅（未安装时） */
        !st ? '<div class="set-group"><div class="set-group-title">代理内核</div><div class="set-row"><div class="set-label">正在读取内核状态…</div></div></div>'
          : !installed ? '<div class="set-group"><div class="set-group-title">代理内核</div>'
            + '<div class="set-row"><div class="set-label">首次使用需要安装 mihomo 代理内核<span class="set-desc">下载自开源项目 MetaCubeX/mihomo</span></div></div>'
            + '<div class="set-row btns"><button class="btn" id="px-dl-core"' + (px.downloading ? ' disabled' : '') + '>' + (px.downloading ? '下载中…' : '下载内核') + '</button>'
            + '<button class="btn ghost" id="px-pick-core">选择本地内核文件</button></div>'
            + (px.dlMessage ? '<div class="set-row"><div class="set-label px-dl-msg" id="px-dl-msg">' + pxEsc(px.dlMessage) + '</div></div>' : '')
            + '</div>' : '',
        /* IP 信息 */
        '<div class="set-group">',
        '  <div class="set-group-title">出口 IP</div>',
        '  ' + ipCard,
        '</div>',
        /* 当前节点 */
        '<div class="set-group">',
        '  <div class="set-group-title">当前节点</div>',
        '  <div id="px-current-wrap">' + currentHtml + '</div>',
        '</div>',
        /* 内核控制 */
        '<div class="set-group">',
        '  <div class="set-group-title">内核控制</div>',
        '  <div class="set-row"><div class="set-label">代理内核<span class="set-desc">' + pxEsc(coreDesc) + '</span></div>',
        '    <div class="px-core-actions">',
        '      <button class="btn" id="px-core-toggle"' + (!installed ? ' disabled' : '') + '>' + (running ? '停止' : '启动') + '</button>',
        '      <label class="px-auto-start"><input type="checkbox" id="px-sw-autostart"' + (st && st.autoStart ? ' checked' : '') + ' /><span>自动启动</span></label>',
        '    </div></div>',
        '</div>',
        /* 网络设置 */
        '<div class="set-group">',
        '  <div class="set-group-title">网络设置</div>',
        '  <div class="set-row"><div class="set-label">系统代理<span class="set-desc">指向 127.0.0.1:' + port + '</span></div>',
        '    <button class="switch' + (st && st.sysProxy ? ' on' : '') + '" id="px-sw-sys"></button></div>',
        '  <div class="set-row"><div class="set-label">虚拟网卡<span class="set-desc">TUN 接管整机流量</span></div>',
        '    <button class="switch' + (st && st.tunMode ? ' on' : '') + '" id="px-sw-tun"></button></div>',
        '  <div class="set-row"><div class="set-label">自身代理<span class="set-desc">仅代理本工作台和内置浏览器</span></div>',
        '    <button class="switch' + (st && st.selfProxy ? ' on' : '') + '" id="px-sw-self"></button>',
        '    <label class="px-auto-start" style="margin-left:10px;"><input type="checkbox" id="px-sw-auto-self"' + (st && st.autoSelfProxy ? ' checked' : '') + ' /><span>自动开启</span></label></div>',
        '</div>',
        /* 代理模式 */
        '<div class="set-group">',
        '  <div class="set-group-title">代理模式</div>',
        '  ' + modeHtml,
        '</div>',
        /* 节点筛选（白/黑名单关键字） */
        '<div class="set-group">',
        '  <div class="set-group-title">节点筛选'
        + '<button class="btn ghost" id="px-kw-save" style="float:right;font-size:11.5px;padding:3px 10px;">应用筛选</button>'
        + '</div>',
        '  <div class="set-row"><div class="set-label">黑名单关键字<span class="set-desc">命中任一即过滤，优先级最高（逗号/空格/换行分隔）</span></div></div>',
        '  <textarea id="px-kw-exclude" class="px-kw-input" rows="2" placeholder="例：免费、试用、expired">'
        + pxEsc(kwText(st && st.nodeExcludeKeywords)) + '</textarea>',
        '  <div class="set-row" style="margin-top:8px;"><div class="set-label">白名单关键字<span class="set-desc">留空=不过滤；非空时必须命中至少一个（逗号/空格/换行分隔）</span></div></div>',
        '  <textarea id="px-kw-include" class="px-kw-input" rows="2" placeholder="例：日本、美国、HK">'
        + pxEsc(kwText(st && st.nodeIncludeKeywords)) + '</textarea>',
        '  <div class="px-kw-hint" id="px-kw-hint" style="display:none;"></div>',
        '</div>',
        /* 流量统计 */
        running ? '<div class="set-group"><div class="set-group-title">流量统计</div>'
          + '<div class="px-traffic">'
          + '<div class="px-t-item"><span>总上传</span><b id="px-t-up">—</b><em id="px-s-up"></em></div>'
          + '<div class="px-t-item"><span>总下载</span><b id="px-t-down">—</b><em id="px-s-down"></em></div>'
          + '<div class="px-t-item"><span>连接数</span><b id="px-t-count">—</b><em></em></div>'
          + '</div></div>' : '',
      ].filter(Boolean).join('');
    } else if (curTab === 'proxies') {
      mainHtml = '<div class="set-group"><div class="set-group-title">当前节点</div>' + currentHtml + '</div>'
        + '<div class="set-group"><div class="set-group-title">节点列表</div>' + groupsHtml + '</div>';
    } else if (curTab === 'subs') {
      mainHtml = '<div class="set-group"><div class="set-group-title">订阅列表</div><div class="px-subs" id="px-subs">' + subsHtml + '</div>'
        + '<div class="px-sub-add"><input id="px-sub-url" type="text" placeholder="粘贴 Clash 订阅链接" spellcheck="false" autocomplete="off" />'
        + '<div class="px-sub-add-row"><input id="px-sub-name" type="text" placeholder="名称（可选）" spellcheck="false" autocomplete="off" /><button class="btn" id="px-sub-add">添加订阅</button></div></div></div>';
    } else if (curTab === 'test') {
      // 网站测速页
      const sites = [
        { name: 'Apple', url: 'https://www.apple.com', icon: '🍎' },
        { name: 'GitHub', url: 'https://github.com', icon: '🐙' },
        { name: 'Google', url: 'https://www.google.com', icon: '🔍' },
        { name: 'YouTube', url: 'https://www.youtube.com', icon: '▶️' },
        { name: 'Twitter/X', url: 'https://x.com', icon: '𝕏' },
        { name: 'Wikipedia', url: 'https://www.wikipedia.org', icon: '📖' },
        { name: 'Cloudflare', url: 'https://www.cloudflare.com', icon: '☁️' },
        { name: 'Netflix', url: 'https://www.netflix.com', icon: '🎬' },
        { name: 'Reddit', url: 'https://www.reddit.com', icon: '👽' },
        { name: 'Bilibili', url: 'https://www.bilibili.com', icon: '📺' },
        { name: 'Baidu', url: 'https://www.baidu.com', icon: '🐾' },
        { name: 'JD.com', url: 'https://www.jd.com', icon: '🛒' },
      ];
      const sHtml = sites.map((s) => {
        const cachedDelay = px.testResults[s.url] || 0;
        return '<div class="px-stest" data-url="' + pxEsc(s.url) + '">'
          + '<span class="px-stest-ico">' + s.icon + '</span>'
          + '<span class="px-stest-name">' + pxEsc(s.name) + '</span>'
          + '<span class="px-stest-delay px-delay ' + pxDelayClass(cachedDelay) + '" data-test="' + pxEsc(s.url) + '">' + pxDelayText(cachedDelay) + '</span>'
          + '</div>';
      }).join('');
      mainHtml = '<div class="set-group"><div class="set-group-title">网站延迟测试 '
        + '<button class="btn ghost" id="px-test-all" style="float:right;font-size:12px;padding:4px 10px;">全部测试</button></div>'
        + '<div class="px-stests">' + sHtml + '</div></div>'
        + '<div class="set-group"><div class="set-group-title">自定义测试</div>'
        + '<div class="px-stest-custom"><input id="px-test-url" type="text" placeholder="https://example.com" spellcheck="false" autocomplete="off" />'
        + '<button class="btn" id="px-test-go">测试</button></div></div>';
    } else {
      mainHtml = '';
    }

    /* 组装完整两栏布局 */
    el.grid.innerHTML = '<div class="proxy-page">'
      + '<aside class="proxy-nav">'
      + '  <button class="settings-back" id="px-back">← 返回应用</button>'
      + '  <div class="proxy-status-row"><span class="proxy-status-dot' + (running ? ' on' : '') + '"></span>'
      + '<span class="proxy-status-text">' + (running ? '运行中' : (installed ? '已安装' : '未安装')) + '</span></div>'
      + '  <nav class="set-tabs proxy-tabs" id="px-tabs">'
      + pxCoreNav.map(([key, name, ico]) => '<button data-tab="' + key + '"' + (curTab === key ? ' class="on"' : '') + '>' + ico + '<span>' + name + '</span></button>').join('')
      + '  </nav>'
      + '  <div class="proxy-nav-foot">'
      + '    <div class="proxy-foot-row"><span>↑</span><b id="px-s-up-foot">—</b></div>'
      + '    <div class="proxy-foot-row"><span>↓</span><b id="px-s-down-foot">—</b></div>'
      + '    <div class="proxy-foot-row"><span>⚙</span><b>' + pxEsc(coreDesc.split(' · ')[0]) + '</b></div>'
      + '  </div>'
      + '</aside>'
      + '<section class="proxy-main"><div class="settings-title">' + navNames[curTab] + '</div>' + mainHtml + '</section>'
      + '</div>';

    const q = (sel) => el.grid.querySelector(sel);
    paintProxyTraffic();
    if (savedNodesScrollTop > 0) { const n = el.grid.querySelector('.px-nodes'); if (n) n.scrollTop = savedNodesScrollTop; }

    /* 侧栏切换 */
    q('#px-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b || b.dataset.tab === ui.proxyTab) return;
      ui.proxyTab = b.dataset.tab;
      // 切到测试 tab 时自动开始拉 IP（概览页也要）
      if (running) {
        fetchProxyIp();
      }
      render();
    });
    q('#px-back').addEventListener('click', () => { ui.proxyOpen = false; stopProxyPoll(); render(); });

    /* 内核控制事件（概览页） */
    const dlBtn = q('#px-dl-core');
    if (dlBtn) dlBtn.addEventListener('click', async () => {
      if (px.downloading) return;
      px.downloading = true; px.dlMessage = '准备下载…'; render();
      const r = await proxyApi.downloadCore();
      px.downloading = false;
      if (r && r.ok) { px.dlMessage = ''; toast('内核安装完成', 'ok'); }
      else { px.dlMessage = (r && r.error) || '下载失败'; toast(px.dlMessage, 'err'); }
      await refreshProxyState(true);
    });
    const pickBtn = q('#px-pick-core');
    if (pickBtn) pickBtn.addEventListener('click', async () => {
      const r = await proxyApi.pickCore();
      if (r && r.ok) { toast('内核已就绪', 'ok'); await refreshProxyState(true); }
      else if (r && !r.canceled) toast((r && r.error) || '选择失败', 'err');
    });
    const coreBtn = q('#px-core-toggle');
    if (coreBtn) coreBtn.addEventListener('click', async () => {
      coreBtn.disabled = true; coreBtn.textContent = running ? '停止中…' : '启动中…';
      const r = running ? await proxyApi.stop() : await proxyApi.start();
      if (!r || !r.ok) { toast((r && r.error) || '操作失败', 'err'); px.lastRunning = false; }
      await refreshProxyState(true);
      if (!running && r && r.ok) { fetchProxyIp(); }
    });
    const autoSw = q('#px-sw-autostart');
    if (autoSw) autoSw.addEventListener('change', async () => {
      const r = await proxyApi.setAutoStart(autoSw.checked);
      if (!r || !r.ok) { autoSw.checked = !autoSw.checked; toast((r && r.error) || '设置失败', 'err'); }
      else if (r.state) px.state = r.state;
    });
    const bindSwitch = (id, fn) => {
      const sw = q('#' + id); if (!sw) return;
      sw.addEventListener('click', async () => {
        const on = !sw.classList.contains('on'); sw.classList.toggle('on', on);
        const r = await fn(on);
        if (!r || !r.ok) { sw.classList.toggle('on', !on); toast((r && r.error) || '设置失败', 'err'); }
        else if (r.state) px.state = r.state;
      });
    };
    bindSwitch('px-sw-sys', (on) => proxyApi.setSysProxy(on));
    // TUN：非管理员时 setTun 返回 NEED_ADMIN，改为弹确认框一键以管理员重启并自动开启
    const tunSw = q('#px-sw-tun');
    if (tunSw) tunSw.addEventListener('click', async () => {
      const on = !tunSw.classList.contains('on');
      tunSw.classList.toggle('on', on);
      const r = await proxyApi.setTun(on);
      if (r && r.ok) { if (r.state) px.state = r.state; return; }
      tunSw.classList.toggle('on', !on);
      if (on && r && r.code === 'NEED_ADMIN') {
        confirmDialog('虚拟网卡需要管理员权限',
          '将以管理员身份重启工作台（Windows 会弹 UAC 确认框），重启后自动开启 TUN。开启后整机流量（含 Telegram 等任意软件）都会按规则走代理。',
          '以管理员重启', async () => {
            const rr = await proxyApi.relaunchAdminForTun();
            if (!rr || !rr.ok) toast((rr && rr.error) || '重启失败', 'err');
          });
      } else {
        toast((r && r.error) || '设置失败', 'err');
      }
    });
    bindSwitch('px-sw-self', (on) => proxyApi.setSelfProxy(on));
    const autoSelfCb = q('#px-sw-auto-self');
    if (autoSelfCb) autoSelfCb.addEventListener('change', async () => {
      const r = await proxyApi.setAutoSelfProxy(autoSelfCb.checked);
      if (r && r.ok && r.state) px.state = r.state;
      else autoSelfCb.checked = !autoSelfCb.checked;
    });
    const modesEl = q('#px-modes');
    if (modesEl) modesEl.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b || (px.state && b.dataset.mode === px.state.mode)) return;
      const r = await proxyApi.setMode(b.dataset.mode);
      if (r && r.ok) { if (px.state) px.state.mode = b.dataset.mode; render(); }
      else toast((r && r.error) || '模式切换失败', 'err');
    });

    /* 节点筛选（关键字）保存 */
    const kwSaveBtn = q('#px-kw-save');
    if (kwSaveBtn) kwSaveBtn.addEventListener('click', async () => {
      const exTa = q('#px-kw-exclude');
      const inTa = q('#px-kw-include');
      const exclude = kwSplit(exTa ? exTa.value : '');
      const include = kwSplit(inTa ? inTa.value : '');
      const r = await proxyApi.setNodeKeywords({ include, exclude });
      if (!(r && r.ok)) { toast((r && r.error) || '保存失败', 'err'); return; }

      // 以主进程保存后的结果为准（避免本地猜测）
      const saved = (r.state && Array.isArray(r.state.nodeExcludeKeywords)) ? r.state.nodeExcludeKeywords : exclude;
      const savedIn = (r.state && Array.isArray(r.state.nodeIncludeKeywords)) ? r.state.nodeIncludeKeywords : include;
      if (r.state) px.state = r.state;

      // 直接回写输入框，不依赖整页重渲染
      if (exTa) exTa.value = kwText(saved);
      if (inTa) inTa.value = kwText(savedIn);

      toast('筛选已应用' + (running ? '（内核已重启）' : ''), 'ok');

      await refreshProxyState(true);

      // refresh 会重建 DOM，重新取节点并把提示写回新的 hint 元素
      const hint = q('#px-kw-hint');
      if (hint) {
        const total = (px.proxies && px.proxies.nodes) ? Object.keys(px.proxies.nodes).length : '?';
        hint.textContent = '已保存：黑名单 ' + kwText(saved) + '（' + saved.length + ' 条） · 白名单 '
          + (kwText(savedIn) || '不限') + ' · 当前节点 ' + total + ' 个';
        hint.style.display = 'block';
      }
    });

    /* 订阅事件 */
    const subsEl = q('#px-subs');
    if (subsEl) subsEl.addEventListener('click', async (e) => {
      const card = e.target.closest('.px-sub'); if (!card) return;
      const id = card.dataset.id; const btn = e.target.closest('[data-act]');
      const act = btn ? btn.dataset.act : 'use';
      if (act === 'del') { confirmDialog('删除订阅', '确定删除这个订阅吗？', '删除', async () => {
        const r = await proxyApi.deleteSub(id);
        if (r && r.ok) { toast('已删除', 'ok'); await refreshProxyState(true); }
        else toast((r && r.error) || '失败', 'err'); }); return; }
      if (act === 'refresh') { const r = await proxyApi.refreshSub(id); if (r && r.ok) { toast('已更新', 'ok'); await refreshProxyState(true); } return; }
      const r = await proxyApi.useSub(id);
      if (r && r.ok) { await refreshProxyState(true); fetchProxyIp(); }
    });
    const addBtn = q('#px-sub-add');
    if (addBtn) addBtn.addEventListener('click', async () => {
      const url = trim(q('#px-sub-url').value); const name = trim(q('#px-sub-name').value);
      if (!url) { toast('请输入订阅链接', 'err'); return; }
      addBtn.disabled = true; addBtn.textContent = '添加中…';
      const r = await proxyApi.addSub({ url, name });
      if (r && r.ok) { toast('已添加', 'ok'); await refreshProxyState(true); }
      else toast((r && r.error) || '失败', 'err');
      addBtn.disabled = false; addBtn.textContent = '添加订阅';
    });

    /* 当前节点测速 — 用 resolvedNow */
    const testCur = q('#px-test-current');
    if (testCur) testCur.addEventListener('click', async () => {
      const g = px.proxies && px.proxies.groups && px.proxies.groups[0];
      if (!g) return;
      const testName = g.resolvedNow || g.now;
      testCur.disabled = true; testCur.textContent = '测速中…';
      const r = await proxyApi.testDelay(testName);
      testCur.disabled = false; testCur.textContent = '测速';
      if (r && r.ok) {
        if (px.proxies && px.proxies.nodes && px.proxies.nodes[testName]) px.proxies.nodes[testName].delay = r.delay;
        const dEl = $('px-current-delay');
        if (dEl) { dEl.textContent = pxDelayText(r.delay); dEl.className = 'px-delay ' + pxDelayClass(r.delay); }
        // 同步 resolvedNode 的 delay
        if (g.resolvedNode) g.resolvedNode.delay = r.delay;
      } else toast((r && r.error) || '测速失败', 'err');
    });

    /* 节点列表事件 */
    const groupsWrap = q('#px-groups-wrap');
    if (groupsWrap) groupsWrap.addEventListener('click', async (e) => {
      if (e.target.closest('.px-gtest')) return;
      const tab = e.target.closest('.px-gtab');
      if (tab && tab.dataset.g !== px.activeGroup) { px.activeGroup = tab.dataset.g; render(); return; }
      const row = e.target.closest('.px-node');
      if (row && row.dataset.node) {
        const g = (px.proxies.groups || []).find((x) => x.name === px.activeGroup);
        if (!g || g.now === row.dataset.node) return;
        const r = await proxyApi.select(g.name, row.dataset.node);
        if (r && r.ok) { await refreshProxyState(true); fetchProxyIp(); }
        else toast((r && r.error) || '切换失败', 'err');
      }
    });
    const bindGroupTest = (sel, mode) => {
      const btn = q(sel);
      if (!btn) return;
      btn.addEventListener('click', async () => {
        if (px.testingGroup) return;
        const r = await testActiveGroupAndSort(mode);
        if (!r || !r.ok) { toast((r && r.error) || '测速失败', 'err'); return; }
        if (r.hit) toast('测速完成：' + r.hit + ' 个节点有结果', 'ok');
        else toast('测速完成：所有节点均超时', 'err');
      });
    };
    bindGroupTest('#px-test-direct', 'direct');
    bindGroupTest('#px-test-proxy', 'proxy');

    /* 刷新 IP */
    const ipRefresh = q('#px-ip-refresh');
    if (ipRefresh) ipRefresh.addEventListener('click', fetchProxyIp);

    /* 网站测速事件 */
    const stests = el.grid.querySelectorAll('.px-stest');
    stests.forEach((el) => {
      el.addEventListener('click', async () => {
        const url = el.dataset.url;
        const dEl = el.querySelector('[data-test]');
        if (!dEl) return;
        dEl.textContent = '测试中…'; dEl.className = 'px-delay';
        const r = await proxyApi.testDelayUrl(url);
        if (r && r.ok) {
          dEl.textContent = pxDelayText(r.delay);
          dEl.className = 'px-delay ' + pxDelayClass(r.delay);
          px.testResults[url] = r.delay;  // 缓存结果
        } else {
          dEl.textContent = pxDelayText(0); dEl.className = 'px-delay';
          delete px.testResults[url];
        }
      });
    });
    const testAll = q('#px-test-all');
    if (testAll) testAll.addEventListener('click', async () => {
      testAll.disabled = true; testAll.textContent = '批量测试中…';
      for (const item of stests) {
        item.click();
        await new Promise((r) => setTimeout(r, 100));
      }
      testAll.disabled = false; testAll.textContent = '全部测试';
    });
    const testGo = q('#px-test-go');
    if (testGo) testGo.addEventListener('click', async () => {
      const u = trim(q('#px-test-url').value);
      if (!u) return;
      testGo.disabled = true; testGo.textContent = '测试中…';
      const r = await proxyApi.testDelayUrl(u);
      testGo.disabled = false; testGo.textContent = '测试';
      if (r && r.ok) px.testResults[u] = r.delay;
      toast(r && r.ok ? ('延迟 ' + r.delay + 'ms') : ((r && r.error) || '测试失败'), r && r.ok ? 'ok' : 'err');
    });

    /* 首次进入代理页且内核运行时，拉取出口 IP */
    if (running && !px.ipInfo && !px.ipLoading) fetchProxyIp();
  }

  /* ------------------------------ 标签页管理 ------------------------------ */

  // 新建标签页：url 为空则 about:blank；activate 默认 true
  function newTab(url, activate) {
    const id = ++tabIdSeq;
    browserTabs.push({ id, title: '新标签页', url: url || '', loading: false });
    const wv = document.createElement('webview');
    wv.id = 'br-wv-' + id;
    wv.setAttribute('allowpopups', '');
    // 独立持久化 session（保留 cookie/密码）；自身代理由主进程对该 partition 单独 setProxy
    wv.setAttribute('partition', 'persist:workbench');
    wv.src = url || 'about:blank';
    wv.style.display = 'none';
    const views = $('br-views');
    if (views) views.appendChild(wv);
    bindWebviewEvents(wv, id);
    if (activate !== false || browserTabs.length === 1) switchTab(id);
    else renderTabs();
    return id;
  }

  function switchTab(id) {
    activeTabId = id;
    browserTabs.forEach((t) => {
      const wv = $('br-wv-' + t.id);
      if (wv) wv.style.display = (t.id === id) ? '' : 'none';
    });
    const t = activeTab();
    if (t && el.brAddr) el.brAddr.value = t.url || '';
    updateBrowserNav();
    updateFavStar();
    renderTabs();
  }

  function closeTab(id) {
    const idx = browserTabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const wv = $('br-wv-' + id);
    if (wv) wv.remove();
    browserTabs.splice(idx, 1);
    if (activeTabId === id) {
      if (browserTabs.length === 0) {
        activeTabId = null;
        newTab(getNewTabUrl(), true);
      } else {
        const next = browserTabs[Math.min(idx, browserTabs.length - 1)];
        switchTab(next.id);
      }
    } else {
      renderTabs();
    }
  }

  // 渲染标签页栏
  function renderTabs() {
    const bar = $('br-tabs');
    if (!bar) return;
    const tabsHtml = browserTabs.map((t) => {
      const on = t.id === activeTabId ? ' on' : '';
      const title = String(t.title || '新标签页').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const spin = t.loading ? '<span class="br-tab-spin" title="加载中"></span>' : '';
      return '<div class="br-tab' + on + '" data-id="' + t.id + '">' +
               spin +
               '<span class="br-tab-title">' + title + '</span>' +
               '<button class="br-tab-close" data-close="' + t.id + '" title="关闭标签页">×</button>' +
             '</div>';
    }).join('');
    bar.innerHTML = tabsHtml + '<button class="br-tab-add" id="br-tab-add" title="新建标签页">+</button>';
    bar.querySelectorAll('.br-tab').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('br-tab-close')) return;
        switchTab(Number(el.dataset.id));
      });
    });
    bar.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(Number(btn.dataset.close));
      });
    });
    const addBtn = $('br-tab-add');
    if (addBtn) addBtn.addEventListener('click', () => newTab(getNewTabUrl(), true));
  }

  // 每个 webview 独立绑定导航事件，更新对应标签的 url/title 与（激活时）地址栏
  function bindWebviewEvents(wv, tabId) {
    wv.addEventListener('did-navigate', (e) => {
      const tab = browserTabs.find((t) => t.id === tabId);
      if (!tab) return;
      tab.url = e.url;
      if (e.url && e.url !== 'about:blank') lastBrowserUrl = e.url;
      if (tabId === activeTabId) {
        if (el.brAddr) el.brAddr.value = e.url;
        updateBrowserNav();
        updateFavStar();
      }
    });
    wv.addEventListener('did-navigate-in-page', (e) => {
      const tab = browserTabs.find((t) => t.id === tabId);
      if (tab) tab.url = e.url;
      if (tabId === activeTabId) {
        if (el.brAddr) el.brAddr.value = e.url;
        updateFavStar();
      }
    });
    wv.addEventListener('page-title-updated', (e) => {
      const tab = browserTabs.find((t) => t.id === tabId);
      if (tab && e.title) { tab.title = e.title; renderTabs(); }
    });
    wv.addEventListener('did-start-loading', () => {
      const tab = browserTabs.find((t) => t.id === tabId);
      if (tab) tab.loading = true;
      if (tabId === activeTabId) updateBrowserNav();
      renderTabs();
    });
    wv.addEventListener('did-stop-loading', () => {
      const tab = browserTabs.find((t) => t.id === tabId);
      if (tab) tab.loading = false;
      if (tabId === activeTabId) updateBrowserNav();
      renderTabs();
    });
    wv.addEventListener('did-finish-load', () => { if (tabId === activeTabId) updateBrowserNav(); });
    wv.addEventListener('did-fail-load', () => { if (tabId === activeTabId) updateBrowserNav(); });
    // 拦截 window.open / target=_blank 的链接，改为在当前浏览器内新开标签页
    wv.addEventListener('new-window', (e) => {
      e.preventDefault && e.preventDefault();
      const url = e.url;
      if (!url || url === 'about:blank') return;
      newTab(url, true);
    });
  }

  /* ------------------------------ 加载进度条 ------------------------------ */

  /* ------------------------------ 导航与工具栏 ------------------------------ */

  // 把用户输入变成可访问的 URL；没有协议前缀时默认补 https://，
  // 看起来像域名才当网址，否则当搜索词走 Bing
  function resolveUrl(input) {
    const v = trim(input);
    if (!v) return '';
    if (/^(https?:|file:|chrome:|about:|edge:)/i.test(v)) return v;
    // 像 IP / 域名（含点或 localhost，且没有空格）
    if (/^[^\s]+\.[^\s]+$/.test(v) || /^localhost(\b|[:/])/i.test(v)) return 'https://' + v;
    return 'https://cn.bing.com/search?q=' + encodeURIComponent(v);
  }

  function loadBrowserUrl(input) {
    const url = resolveUrl(input);
    if (!url) return;
    const wv = activeWebview();
    if (wv) {
      try { wv.loadURL(url); } catch (_) { wv.src = url; }
    }
    if (el.brAddr) el.brAddr.value = url;
  }

  function updateBrowserNav() {
    const wv = activeWebview();
    if (!wv) return;
    try {
      if (el.brBack) el.brBack.disabled = !wv.canGoBack();
      if (el.brForward) el.brForward.disabled = !wv.canGoForward();
    } catch (_) {}
    // 刷新按钮：加载中显示叉号（停止），否则显示刷新图标
    const tab = activeTab();
    const reloadBtn = $('br-reload');
    if (reloadBtn) {
      if (tab && tab.loading) {
        reloadBtn.classList.add('loading');
        reloadBtn.title = '停止加载';
      } else {
        reloadBtn.classList.remove('loading');
        reloadBtn.title = '刷新';
      }
    }
  }

  /* ------------------------------ 收藏夹 ------------------------------ */

  // 展开的文件夹 id 集合（运行时，不持久化）
  const expandedFolders = new Set(['fav-bar', 'fav-other']);

  function getBookmarks() {
    const b = browserConfig();
    const tree = Array.isArray(b.bookmarks) ? b.bookmarks : [];
    // 兜底：确保系统根文件夹存在
    let changed = false;
    if (!tree.some((n) => n.id === 'fav-bar')) { tree.push({ id: 'fav-bar', type: 'folder', title: '收藏夹栏', children: [] }); changed = true; }
    if (!tree.some((n) => n.id === 'fav-other')) { tree.push({ id: 'fav-other', type: 'folder', title: '其他书签', children: [] }); changed = true; }
    if (changed) { state.settings.browser.bookmarks = tree; scheduleSave(); }
    return tree;
  }
  function setBookmarks(tree) {
    state.settings.browser.bookmarks = tree;
    scheduleSave();
    renderBookmarkBar();
    updateFavStar();
    // 若收藏夹管理页打开，同步刷新
    const page = $('bm-page');
    if (page && !page.classList.contains('hidden')) renderBmPage();
  }
  function newId() { return Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

  // 在树中按 id 查找节点；parent 返回该节点所在的数组（供 splice 增删）
  function findNode(id, nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.id === id) return { node: n, parent: nodes, index: i };
      if (n.type === 'folder' && n.children) {
        const r = findNode(id, n.children);
        if (r) return r;
      }
    }
    return null;
  }

  // 把树拍平成 url 列表（用于去重判断）
  function flattenUrls(nodes, out) {
    out = out || [];
    for (const n of nodes) {
      if (n.type === 'url') out.push(n.url);
      else if (n.children) flattenUrls(n.children, out);
    }
    return out;
  }

  // 按 URL 查找节点；parent 返回该节点所在的数组（供 splice 增删）
  function findUrlNode(url, nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type === 'url' && n.url === url) return { node: n, parent: nodes, index: i };
      if (n.type === 'folder' && n.children) {
        const r = findUrlNode(url, n.children);
        if (r) return r;
      }
    }
    return null;
  }

  // 域名，用于 favicon
  function faviconUrl(url) {
    try {
      const u = new URL(url);
      return 'https://icons.duckduckgo.com/ip3/' + u.hostname + '.ico';
    } catch (_) { return ''; }
  }

  // 更新工具栏收藏按钮的实心/空心状态（根据当前页 URL 是否已收藏）
  function updateFavStar() {
    const btn = $('br-fav-add');
    if (!btn) return;
    const tab = activeTab();
    const wv = activeWebview();
    const url = (tab && tab.url) || (wv && wv.src) || '';
    if (!url || url === 'about:blank') { btn.classList.remove('on'); return; }
    const tree = getBookmarks();
    btn.classList.toggle('on', flattenUrls(tree).includes(url));
  }

  // 当前激活页加入收藏夹 / 取消收藏（切换）
  function addCurrentBookmark() {
    const tab = activeTab();
    const wv = activeWebview();
    if (!tab) return;
    const url = (tab.url || (wv && wv.src) || '').trim();
    if (!url || url === 'about:blank') { toast('当前页面无法收藏', 'err'); return; }
    const tree = getBookmarks();
    // 检查是否已收藏
    const r = findUrlNode(url, tree);
    if (r) {
      // 已收藏 → 取消收藏
      confirmDialog('取消收藏', '确定从收藏夹中移除「' + (r.node.title || url) + '」？', '移除', () => {
        const tree2 = getBookmarks();
        const r2 = findUrlNode(url, tree2);
        if (r2) {
          r2.parent.splice(r2.index, 1);
          setBookmarks(tree2);
          renderFavPanel();
          updateFavStar();
          toast('已取消收藏', 'ok');
        }
      });
      return;
    }
    // 未收藏 → 添加到「收藏夹栏」
    const bar = tree.find((n) => n.id === 'fav-bar') || tree[0];
    bar.children = bar.children || [];
    bar.children.push({ id: newId(), type: 'url', title: tab.title || url, url, addedAt: Date.now() });
    setBookmarks(tree);
    expandedFolders.add(bar.id);
    renderFavPanel();
    updateFavStar();
    toast('已加入收藏夹', 'ok');
  }

  // 把所有打开的标签页加入收藏夹
  function addAllOpenTabs() {
    const tree = getBookmarks();
    const existing = new Set(flattenUrls(tree));
    const bar = tree.find((n) => n.id === 'fav-bar') || tree[0];
    bar.children = bar.children || [];
    let added = 0;
    for (const t of browserTabs) {
      const url = (t.url || '').trim();
      if (!url || url === 'about:blank' || existing.has(url)) continue;
      bar.children.push({ id: newId(), type: 'url', title: t.title || url, url, addedAt: Date.now() });
      existing.add(url);
      added++;
    }
    if (added > 0) {
      setBookmarks(tree);
      expandedFolders.add(bar.id);
      renderFavPanel();
    }
    toast(added > 0 ? '已收藏 ' + added + ' 个打开的页面' : '没有可收藏的新页面', added > 0 ? 'ok' : 'err');
  }

  // 新建文件夹（放进「收藏夹栏」根）
  function addFolder() {
    inputDialog('新建文件夹', '请输入文件夹名称', '新建文件夹', (name) => {
      const tree = getBookmarks();
      const bar = tree.find((n) => n.id === 'fav-bar') || tree[0];
      bar.children = bar.children || [];
      bar.children.push({ id: newId(), type: 'folder', title: name, children: [] });
      setBookmarks(tree);
      expandedFolders.add(bar.id);
      renderFavPanel();
      toast('已新建文件夹', 'ok');
    });
  }

  // 删除节点（文件夹会连同子内容一起删）
  function removeBookmark(id) {
    // 保护系统根文件夹不被删除
    if (id === 'fav-bar' || id === 'fav-other') {
      toast('默认收藏夹文件夹无法删除', 'err');
      return;
    }
    const r = findNode(id, getBookmarks(), null);
    if (!r) return;
    const isFolder = r.node.type === 'folder';
    const count = isFolder ? flattenUrls(r.node.children || []).length : 1;
    const msg = isFolder
      ? '确定删除文件夹「' + (r.node.title || '') + '」及其下的 ' + count + ' 个书签？'
      : '确定删除书签「' + (r.node.title || r.node.url || '') + '」？';
    confirmDialog('删除确认', msg, '删除', () => {
      const tree = getBookmarks();
      const r2 = findNode(id, tree, null);
      if (r2) {
        r2.parent.splice(r2.index, 1);
        setBookmarks(tree);
        renderFavPanel();
        updateFavStar();
        toast('已删除', 'ok');
      }
    });
  }

  // 展开 / 折叠文件夹
  function toggleFolder(id) {
    if (expandedFolders.has(id)) expandedFolders.delete(id);
    else expandedFolders.add(id);
    renderFavPanel();
  }

  function toggleFavPanel() {
    const panel = $('br-fav-panel');
    if (!panel) return;
    const willShow = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willShow);
    if (willShow) renderFavPanel();
    else hideFavMenu();
  }

  // 渲染工具栏下方的收藏夹栏（书签栏）
  function renderBookmarkBar() {
    const bar = $('br-bookmark-bar');
    if (!bar) return;
    const cfg = browserConfig();
    // 显隐由设置控制
    bar.classList.toggle('hidden', !cfg.showFavBar);
    if (!cfg.showFavBar) return;
    const tree = getBookmarks();
    const favBar = tree.find((n) => n.id === 'fav-bar');
    const items = (favBar && favBar.children) || [];
    if (items.length === 0) {
      bar.innerHTML = '<span style="color:var(--dim-2);font-size:11px;padding:0 4px">收藏夹栏为空，点击 ⭐ 添加</span>';
      return;
    }
    bar.innerHTML = items.map((n) => {
      if (n.type === 'folder') {
        const title = String(n.title || '文件夹').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return '<span class="br-bookmark-item br-bookmark-folder" data-folder="' + n.id + '" title="' + title + '">' +
                 '<svg viewBox="0 0 16 16" width="15" height="15"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-6.5z" fill="currentColor" opacity="0.85"/></svg>' +
                 '<span class="br-bm-title">' + title + '</span>' +
               '</span>';
      }
      const title = String(n.title || n.url).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const url = String(n.url || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const fav = faviconUrl(n.url);
      return '<span class="br-bookmark-item" data-url="' + url + '" title="' + title + '">' +
               (fav ? '<img src="' + fav + '" alt="" onerror="this.style.display=\'none\'" />' : '') +
               '<span class="br-bm-title">' + title + '</span>' +
             '</span>';
    }).join('');
    // 绑定事件
    bar.querySelectorAll('[data-url]').forEach((el) => {
      el.addEventListener('click', () => openBrowser(el.dataset.url));
    });
    bar.querySelectorAll('[data-folder]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        showBookmarkFolderMenu(el, el.dataset.folder);
      });
    });
  }

  // 书签栏文件夹的下拉菜单
  function showBookmarkFolderMenu(anchor, folderId) {
    // 先移除已有菜单
    const old = $('br-bm-folder-menu');
    if (old) old.remove();
    const r = findNode(folderId, getBookmarks(), null);
    if (!r || r.node.type !== 'folder') return;
    const children = r.node.children || [];
    const menu = document.createElement('div');
    menu.id = 'br-bm-folder-menu';
    menu.className = 'br-fav-menu';
    menu.style.position = 'fixed';
    const rect = anchor.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.minWidth = '180px';
    menu.style.maxHeight = '60vh';
    menu.style.overflowY = 'auto';
    if (children.length === 0) {
      menu.innerHTML = '<div class="br-fav-empty" style="padding:12px">文件夹为空</div>';
    } else {
      menu.innerHTML = children.map((n) => {
        if (n.type === 'folder') {
          const t = String(n.title || '文件夹').replace(/&/g, '&amp;').replace(/</g, '&lt;');
          return '<div class="br-fav-menu-item" data-subfolder="' + n.id + '"><span style="color:var(--accent)">📁</span> ' + t + ' ▸</div>';
        }
        const t = String(n.title || n.url).replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const url = String(n.url || '').replace(/"/g, '&quot;');
        const fav = faviconUrl(n.url);
        return '<div class="br-fav-menu-item" data-bmurl="' + url + '">' +
                 (fav ? '<img src="' + fav + '" style="width:14px;height:14px;vertical-align:middle;margin-right:4px" onerror="this.style.display=\'none\'" />' : '') +
                 '<span style="vertical-align:middle">' + t + '</span>' +
               '</div>';
      }).join('');
    }
    document.body.appendChild(menu);
    // 绑定子项
    menu.querySelectorAll('[data-bmurl]').forEach((el) => {
      el.addEventListener('click', () => { openBrowser(el.dataset.bmurl); menu.remove(); });
    });
    menu.querySelectorAll('[data-subfolder]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        showBookmarkFolderMenu(el, el.dataset.subfolder);
      });
    });
    // 点击外部关闭
    setTimeout(() => {
      const close = (e) => {
        if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
          menu.remove();
          document.removeEventListener('click', close, true);
        }
      };
      document.addEventListener('click', close, true);
    }, 0);
  }

  // 递归渲染收藏夹树
  function renderFavTree(nodes, depth) {
    depth = depth || 0;
    const pad = depth * 16;
    return nodes.map((n) => {
      if (n.type === 'folder') {
        const expanded = expandedFolders.has(n.id);
        const hasChildren = (n.children && n.children.length) || true;
        const arrow = hasChildren ? (expanded ? '▾' : '▸') : '·';
        const title = String(n.title || '文件夹').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let html = '<div class="br-fav-item br-fav-folder-node" data-folder="' + n.id + '" style="padding-left:' + (8 + pad) + 'px">' +
                     '<span class="br-fav-arrow" data-folder="' + n.id + '">' + arrow + '</span>' +
                     '<svg class="br-fav-folder-icon" viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-6.5z" fill="currentColor" opacity="0.85"/></svg>' +
                     '<span class="br-fav-title">' + title + '</span>' +
                     '<button class="br-fav-del" data-del="' + n.id + '" title="删除文件夹">×</button>' +
                   '</div>';
        if (expanded && n.children && n.children.length) {
          html += renderFavTree(n.children, depth + 1);
        } else if (expanded && (!n.children || !n.children.length)) {
          html += '<div class="br-fav-empty-sub" style="padding-left:' + (8 + pad + 24) + 'px">（空）</div>';
        }
        return html;
      }
      // url 节点
      const title = String(n.title || n.url).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const url = String(n.url || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const fav = faviconUrl(n.url);
      return '<div class="br-fav-item br-fav-url-node" data-url="' + url + '" style="padding-left:' + (8 + pad + 16) + 'px">' +
               (fav ? '<img class="br-fav-icon" src="' + fav + '" alt="" onerror="this.style.display=\'none\'" />' : '<span class="br-fav-icon-placeholder"></span>') +
               '<div class="br-fav-item-main">' +
                 '<span class="br-fav-title">' + title + '</span>' +
                 '<span class="br-fav-url">' + url + '</span>' +
               '</div>' +
               '<button class="br-fav-del" data-del="' + n.id + '" title="移除收藏">×</button>' +
             '</div>';
    }).join('');
  }

  function renderFavPanel() {
    const body = $('br-fav-list-body');
    if (!body) return;
    const tree = getBookmarks();
    const kw = trim(($('br-fav-search') || {}).value || '').toLowerCase();
    if (kw) {
      // 搜索模式：扁平展示匹配的 url 节点
      const matches = [];
      const walk = (nodes) => {
        for (const n of nodes) {
          if (n.type === 'url') {
            if ((n.title || '').toLowerCase().includes(kw) || (n.url || '').toLowerCase().includes(kw)) matches.push(n);
          } else if (n.children) walk(n.children);
        }
      };
      walk(tree);
      if (matches.length === 0) { body.innerHTML = '<div class="br-fav-empty">没有匹配的收藏</div>'; return; }
      body.innerHTML = matches.map((n) => {
        const title = String(n.title || n.url).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const url = String(n.url || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        const fav = faviconUrl(n.url);
        return '<div class="br-fav-item br-fav-url-node" data-url="' + url + '">' +
                 (fav ? '<img class="br-fav-icon" src="' + fav + '" alt="" onerror="this.style.display=\'none\'" />' : '<span class="br-fav-icon-placeholder"></span>') +
                 '<div class="br-fav-item-main"><span class="br-fav-title">' + title + '</span><span class="br-fav-url">' + url + '</span></div>' +
                 '<button class="br-fav-del" data-del="' + n.id + '" title="移除收藏">×</button>' +
               '</div>';
      }).join('');
    } else {
      const hasUrls = flattenUrls(tree).length > 0;
      const html = renderFavTree(tree, 0);
      body.innerHTML = hasUrls ? html : '<div class="br-fav-empty">还没有收藏，点击工具栏 ⭐ 添加当前页，或从 ··· 菜单导入</div>';
    }
    // 绑定事件
    body.querySelectorAll('[data-folder]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('br-fav-del')) return;
        toggleFolder(el.dataset.folder);
      });
    });
    body.querySelectorAll('.br-fav-url-node').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('br-fav-del')) return;
        openBrowser(el.dataset.url);
      });
    });
    body.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); removeBookmark(btn.dataset.del); });
    });
  }

  // 从 Edge 本地书签文件导入（间接同步 Edge 账号收藏夹）
  async function importEdgeBookmarks() {
    const menuItem = $('br-fav-menu-import');
    if (menuItem) { menuItem.classList.add('is-loading'); menuItem.textContent = '导入中…'; }
    try {
      const res = await (window.workbench && workbench.edge ? workbench.edge.readBookmarks() : Promise.resolve({ ok: false }));
      if (!res || !res.ok) {
        const reason = (res && res.reason) || '';
        toast(reason === 'edge-not-installed' ? '未检测到 Edge 浏览器' : '读取 Edge 书签失败', 'err');
        return;
      }
      const incoming = Array.isArray(res.bookmarks) ? res.bookmarks : [];
      if (incoming.length === 0) { toast('Edge 书签为空', 'ok'); return; }
      const tree = getBookmarks();
      const existing = new Set(flattenUrls(tree));
      // 按文件夹分组导入到「收藏夹栏」下，保持 Edge 的文件夹结构
      const bar = tree.find((n) => n.id === 'fav-bar') || tree[0];
      bar.children = bar.children || [];
      // 建立 Edge 文件夹路径 → 本地文件夹 id 的映射
      const folderMap = {};
      let added = 0;
      for (const item of incoming) {
        if (existing.has(item.url)) continue;
        const folderName = item.folder || 'Edge 导入';
        if (!folderMap[folderName]) {
          const f = { id: newId(), type: 'folder', title: folderName, children: [] };
          bar.children.push(f);
          folderMap[folderName] = f;
        }
        folderMap[folderName].children.push({ id: newId(), type: 'url', title: item.title || item.url, url: item.url, addedAt: Date.now() });
        existing.add(item.url);
        added++;
      }
      setBookmarks(tree);
      expandedFolders.add(bar.id);
      renderFavPanel();
      toast('已从 Edge 导入 ' + added + ' 条书签', 'ok');
    } finally {
      if (menuItem) { menuItem.classList.remove('is-loading'); menuItem.textContent = '导入收藏夹…'; }
    }
  }

  // 导出收藏夹为 HTML 文件（Netscape 格式，可被各浏览器导入）
  function exportBookmarks() {
    const tree = getBookmarks();
    const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>工作台收藏夹</TITLE>', '<H1>工作台收藏夹</H1>', '<DL><p>'];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        const indent = '  '.repeat(depth + 1);
        if (n.type === 'folder') {
          lines.push(indent + '<DT><H3>' + (n.title || '文件夹') + '</H3>');
          lines.push(indent + '<DL><p>');
          walk(n.children || [], depth + 1);
          lines.push(indent + '</DL><p>');
        } else if (n.type === 'url') {
          const ts = n.addedAt ? Math.floor(n.addedAt / 1000) : Math.floor(Date.now() / 1000);
          lines.push(indent + '<DT><A HREF="' + String(n.url || '').replace(/"/g, '&quot;') + '" ADD_DATE="' + ts + '">' + (n.title || n.url) + '</A>');
        }
      }
    };
    walk(tree, 0);
    lines.push('</DL><p>');
    const blob = new Blob([lines.join('\n')], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bookmarks_' + new Date().toISOString().slice(0, 10) + '.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('已导出收藏夹', 'ok');
  }

  // 删除重复的收藏夹（按 url 去重，保留首个）
  function dedupBookmarks() {
    const tree = getBookmarks();
    const seen = new Set();
    let removed = 0;
    const walk = (nodes) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.type === 'folder') {
          walk(n.children || []);
          if (!n.children || n.children.length === 0) { nodes.splice(i, 1); removed++; }
        } else if (n.type === 'url') {
          if (seen.has(n.url)) { nodes.splice(i, 1); removed++; }
          else seen.add(n.url);
        }
      }
    };
    walk(tree);
    setBookmarks(tree);
    renderFavPanel();
    toast(removed > 0 ? '已删除 ' + removed + ' 个重复项' : '没有重复项', removed > 0 ? 'ok' : 'err');
  }

  /* ------------------------------ 更多菜单（···） ------------------------------ */

  // 切换工具栏收藏夹栏（书签栏）的显示
  function toggleFavBarVisible() {
    state.settings.browser.showFavBar = !browserConfig().showFavBar;
    scheduleSave();
    renderBookmarkBar();
    toast(state.settings.browser.showFavBar ? '已显示收藏夹栏' : '已隐藏收藏夹栏', 'ok');
  }

  // 打开收藏夹管理页（全屏视图，参考 edge://favorites）
  function openBookmarksPage() {
    hideFavMenu();
    const page = $('bm-page');
    if (!page) return;
    page.classList.remove('hidden');
    ui.bmSelectedFolder = 'fav-bar';
    renderBmPage();
  }
  function closeBookmarksPage() {
    const page = $('bm-page');
    if (page) page.classList.add('hidden');
  }

  // 渲染收藏夹管理页
  function renderBmPage() {
    const page = $('bm-page');
    if (!page || page.classList.contains('hidden')) return;
    const tree = getBookmarks();
    const sel = ui.bmSelectedFolder || 'fav-bar';
    // 左侧文件夹树
    const side = $('bm-side-list');
    if (side) {
      side.innerHTML = renderBmSideTree(tree, 0);
      side.querySelectorAll('[data-bmfolder]').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          ui.bmSelectedFolder = el.dataset.bmfolder;
          renderBmPage();
        });
      });
    }
    // 右侧：选中文件夹的书签（或搜索结果）
    const r = findNode(sel, tree, null);
    const folder = r ? r.node : tree.find((n) => n.id === 'fav-bar');
    const main = $('bm-main-list');
    const head = $('bm-main-head');
    const kw = trim(($('bm-search') || {}).value || '').toLowerCase();
    let items;
    if (kw) {
      // 搜索模式：在所有书签中查找
      items = [];
      const walk = (nodes) => { for (const n of nodes) { if (n.type === 'url') items.push(n); else if (n.children) walk(n.children); } };
      walk(tree);
      items = items.filter((n) => (n.title || '').toLowerCase().includes(kw) || (n.url || '').toLowerCase().includes(kw));
      if (head) head.textContent = '搜索结果（' + items.length + '）';
    } else {
      items = (folder && folder.children) || [];
      if (head) head.textContent = (folder && folder.title) || '收藏夹';
    }
    if (!main) return;
    if (items.length === 0) {
      main.innerHTML = '<div class="bm-empty">此文件夹为空</div>';
      return;
    }
    main.innerHTML = items.map((n) => {
      const title = String(n.title || (n.type === 'folder' ? '文件夹' : n.url)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (n.type === 'folder') {
        return '<div class="bm-item bm-folder" data-bmfolder="' + n.id + '">' +
                 '<svg class="bm-icon" viewBox="0 0 16 16" width="18" height="18"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-6.5z" fill="currentColor" opacity="0.8"/></svg>' +
                 '<span class="bm-name">' + title + '</span>' +
                 '<div class="bm-actions"><button class="bm-btn" data-bmrename="' + n.id + '">重命名</button><button class="bm-btn bm-danger" data-bmdel="' + n.id + '">删除</button></div>' +
               '</div>';
      }
      const url = String(n.url || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const fav = faviconUrl(n.url);
      return '<div class="bm-item" data-bmurl="' + url + '">' +
               (fav ? '<img class="bm-fav" src="' + fav + '" alt="" onerror="this.style.display=\'none\'" />' : '<span class="bm-fav-placeholder"></span>') +
               '<div class="bm-info"><span class="bm-name">' + title + '</span><span class="bm-url">' + url + '</span></div>' +
               '<div class="bm-actions"><button class="bm-btn" data-bmopen="' + n.id + '">打开</button><button class="bm-btn" data-bmrename="' + n.id + '">编辑</button><button class="bm-btn bm-danger" data-bmdel="' + n.id + '">删除</button></div>' +
             '</div>';
    }).join('');
    // 绑定右侧事件
    main.querySelectorAll('[data-bmfolder]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.bm-actions')) return;
        ui.bmSelectedFolder = el.dataset.bmfolder;
        renderBmPage();
      });
    });
    main.querySelectorAll('[data-bmurl]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.bm-actions')) return;
        openBrowser(el.dataset.bmurl);
      });
    });
    main.querySelectorAll('[data-bmopen]').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); const id = btn.dataset.bmopen; const r2 = findNode(id, getBookmarks(), null); if (r2 && r2.node.url) openBrowser(r2.node.url); });
    });
    main.querySelectorAll('[data-bmrename]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.bmrename;
        const r2 = findNode(id, getBookmarks(), null);
        if (!r2) return;
        inputDialog(r2.node.type === 'folder' ? '重命名文件夹' : '编辑书签', r2.node.type === 'folder' ? '名称' : '标题', r2.node.title || '', (v) => {
          const tree2 = getBookmarks();
          const r3 = findNode(id, tree2, null);
          if (r3) { r3.node.title = v; setBookmarks(tree2); renderBmPage(); renderBookmarkBar(); toast('已保存', 'ok'); }
        });
      });
    });
    main.querySelectorAll('[data-bmdel]').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); removeBookmark(btn.dataset.bmdel); });
    });
  }

  // 管理页左侧文件夹树渲染
  function renderBmSideTree(nodes, depth) {
    depth = depth || 0;
    const sel = ui.bmSelectedFolder || 'fav-bar';
    return nodes.map((n) => {
      if (n.type !== 'folder') return '';
      const isSel = n.id === sel;
      const title = String(n.title || '文件夹').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      let html = '<div class="bm-side-item' + (isSel ? ' bm-side-active' : '') + '" data-bmfolder="' + n.id + '" style="padding-left:' + (8 + depth * 14) + 'px">' +
                   '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-6.5z" fill="currentColor" opacity="0.8"/></svg>' +
                   '<span>' + title + '</span>' +
                 '</div>';
      if (n.children && n.children.some((c) => c.type === 'folder')) {
        html += renderBmSideTree(n.children.filter((c) => c.type === 'folder'), depth + 1);
      }
      return html;
    }).join('');
  }

  const FAV_MENU_ITEMS = [
    { id: 'open-page', label: '打开收藏夹页面', action: openBookmarksPage },
    { id: 'add-current', label: '将此页添加到收藏夹', action: addCurrentBookmark },
    { id: 'add-all-tabs', label: '将打开的页面添加到收藏夹', action: addAllOpenTabs },
    { id: 'add-folder', label: '添加文件夹', action: addFolder },
    { divider: true },
    { id: 'import', label: '导入收藏夹…', action: importEdgeBookmarks },
    { id: 'export', label: '导出收藏夹', action: exportBookmarks },
    { id: 'dedup', label: '删除重复的收藏夹', action: dedupBookmarks },
    { divider: true },
    { id: 'toggle-favbar', label: '显示收藏夹栏', type: 'toggle', checked: () => browserConfig().showFavBar === true, action: toggleFavBarVisible },
  ];

  function showFavMenu(anchor) {
    let menu = $('br-fav-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'br-fav-menu';
      menu.className = 'br-fav-menu';
      const panel = $('br-fav-panel');
      if (panel) panel.appendChild(menu);
    }
    menu.innerHTML = FAV_MENU_ITEMS.map((it) => {
      if (it.divider) return '<div class="br-fav-menu-divider"></div>';
      const check = it.type === 'toggle' && it.checked && it.checked() ? '✓ ' : '';
      return '<div class="br-fav-menu-item' + (it.type === 'toggle' ? ' br-fav-menu-toggle' : '') + '" data-action="' + it.id + '" id="br-fav-menu-' + it.id + '"><span class="br-fav-menu-check">' + check + '</span>' + it.label + '</div>';
    }).join('');
    menu.classList.remove('hidden');
    menu.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', () => {
        const item = FAV_MENU_ITEMS.find((x) => x.id === el.dataset.action);
        // toggle 类型不关闭菜单，便于看到状态变化
        if (!item || item.type !== 'toggle') hideFavMenu();
        if (item) item.action();
        // toggle 类型刷新菜单勾选状态
        if (item && item.type === 'toggle') showFavMenu($('br-fav-more'));
      });
    });
    // 定位到锚点（···按钮）下方
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      const panelRect = ($('br-fav-panel') || {}).getBoundingClientRect ? $('br-fav-panel').getBoundingClientRect() : { left: 0, top: 0 };
      menu.style.right = '8px';
      menu.style.top = '40px';
    }
    // 点击外部关闭
    setTimeout(() => {
      document.addEventListener('click', closeFavMenuOnOut, true);
    }, 0);
  }
  function closeFavMenuOnOut(e) {
    const menu = $('br-fav-menu');
    const moreBtn = $('br-fav-more');
    if (!menu) return;
    if (menu.contains(e.target) || (moreBtn && moreBtn.contains(e.target))) return;
    hideFavMenu();
  }
  function hideFavMenu() {
    const menu = $('br-fav-menu');
    if (menu) menu.classList.add('hidden');
    document.removeEventListener('click', closeFavMenuOnOut, true);
  }

  /* ------------------------------ 密码管理器 ------------------------------ */

  // 展开的网站分组（运行时）
  const expandedSites = new Set();

  function getPasswords() {
    const b = browserConfig();
    return Array.isArray(b.passwords) ? b.passwords : [];
  }
  function setPasswords(list) {
    state.settings.browser.passwords = list;
    scheduleSave();
  }

  function togglePwdPanel() {
    const panel = $('br-pwd-panel');
    if (!panel) return;
    const willShow = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willShow);
    // 关闭收藏夹面板，避免重叠
    if (willShow) { const fp = $('br-fav-panel'); if (fp) fp.classList.add('hidden'); }
    if (willShow) renderPwdPanel();
  }

  // 从 URL 提取网站名（去掉协议和路径）
  function siteFromUrl(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '');
    } catch (_) { return url || ''; }
  }

  function renderPwdPanel() {
    const body = $('br-pwd-list-body');
    if (!body) return;
    const list = getPasswords();
    const kw = trim(($('br-pwd-search') || {}).value || '').toLowerCase();
    // 按 site 分组
    const groups = {};
    for (const p of list) {
      if (kw && !(p.site || '').toLowerCase().includes(kw) && !(p.username || '').toLowerCase().includes(kw) && !(p.note || '').toLowerCase().includes(kw)) continue;
      const s = p.site || '未分类';
      if (!groups[s]) groups[s] = [];
      groups[s].push(p);
    }
    const sites = Object.keys(groups).sort();
    if (sites.length === 0) {
      body.innerHTML = '<div class="br-fav-empty">' + (list.length === 0 ? '还没有保存的密码，点击右上角 + 添加' : '没有匹配的密码') + '</div>';
      return;
    }
    body.innerHTML = sites.map((site) => {
      const items = groups[site];
      const expanded = expandedSites.has(site);
      const arrow = expanded ? '▾' : '▸';
      const fav = 'https://icons.duckduckgo.com/ip3/' + site.replace(/^www\./, '') + '.ico';
      let html = '<div class="br-pwd-site" data-site="' + site.replace(/"/g, '&quot;') + '">' +
                   '<div class="br-pwd-site-head">' +
                     '<span class="br-pwd-arrow">' + arrow + '</span>' +
                     '<img class="br-pwd-fav" src="' + fav + '" alt="" onerror="this.style.display=\'none\'" />' +
                     '<span class="br-pwd-site-name">' + site.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>' +
                     '<span class="br-pwd-count">' + items.length + ' 个账户</span>' +
                   '</div>';
      if (expanded) {
        html += '<div class="br-pwd-items">';
        for (const p of items) {
          const user = String(p.username || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
          html += '<div class="br-pwd-item" data-id="' + p.id + '">' +
                    '<div class="br-pwd-item-row">' +
                      '<span class="br-pwd-label">用户名</span>' +
                      '<span class="br-pwd-value" data-copy="user">' + user + '</span>' +
                      '<button class="br-pwd-copy" data-copy-user="' + p.id + '" title="复制用户名">复制</button>' +
                    '</div>' +
                    '<div class="br-pwd-item-row">' +
                      '<span class="br-pwd-label">密码</span>' +
                      '<span class="br-pwd-value br-pwd-pass" data-pass="' + p.id + '">••••••••</span>' +
                      '<button class="br-pwd-eye-btn" data-eye="' + p.id + '" title="显示/隐藏">👁</button>' +
                      '<button class="br-pwd-copy" data-copy-pass="' + p.id + '" title="复制密码">复制</button>' +
                    '</div>' +
                    '<div class="br-pwd-item-actions">' +
                      '<button class="br-pwd-fill" data-fill="' + p.id + '" title="尝试填充到当前页">填充到当前页</button>' +
                      '<button class="br-pwd-del" data-del="' + p.id + '" title="删除">删除</button>' +
                    '</div>' +
                  '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
      return html;
    }).join('');
    // 绑定事件
    body.querySelectorAll('.br-pwd-site-head').forEach((el) => {
      el.addEventListener('click', () => {
        const site = el.parentElement.dataset.site;
        if (expandedSites.has(site)) expandedSites.delete(site);
        else expandedSites.add(site);
        renderPwdPanel();
      });
    });
    body.querySelectorAll('[data-copy-user]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = getPasswords().find((x) => x.id === btn.dataset.copyUser);
        if (p) copyText(p.username || '');
      });
    });
    body.querySelectorAll('[data-copy-pass]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = getPasswords().find((x) => x.id === btn.dataset.copyPass);
        if (p) copyText(p.password || '');
      });
    });
    body.querySelectorAll('[data-eye]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.eye;
        const passEl = body.querySelector('[data-pass="' + id + '"]');
        const p = getPasswords().find((x) => x.id === id);
        if (!passEl || !p) return;
        if (passEl.dataset.shown === '1') {
          passEl.textContent = '••••••••';
          passEl.dataset.shown = '';
        } else {
          passEl.textContent = p.password || '';
          passEl.dataset.shown = '1';
        }
      });
    });
    body.querySelectorAll('[data-fill]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        fillPasswordToPage(btn.dataset.fill);
      });
    });
    body.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmDialog('删除确认', '确定删除这条密码？', '删除', () => {
          const list = getPasswords().filter((x) => x.id !== btn.dataset.del);
          setPasswords(list);
          renderPwdPanel();
          toast('已删除', 'ok');
        });
      });
    });
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('已复制', 'ok')).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制', 'ok'); } catch (_) { toast('复制失败', 'err'); }
    ta.remove();
  }

  // 尝试把密码填充到当前页（通过 webview 注入 JS 查找常见输入框）
  function fillPasswordToPage(id) {
    const p = getPasswords().find((x) => x.id === id);
    if (!p) return;
    const wv = activeWebview();
    if (!wv) { toast('请先打开浏览器页面', 'err'); return; }
    const user = JSON.stringify(p.username || '');
    const pass = JSON.stringify(p.password || '');
    const script = `
      (function(){
        var u = ${user}, p = ${pass};
        var inputs = document.querySelectorAll('input');
        var userField, passField;
        for (var i = 0; i < inputs.length; i++) {
          var inp = inputs[i], t = (inp.type || '').toLowerCase(), name = (inp.name || inp.id || '').toLowerCase();
          if (t === 'password') { passField = inp; break; }
          if ((t === 'text' || t === 'email' || t === 'tel' || t === '') && /user|name|account|login|email|phone|mobile|account/i.test(name)) { userField = inp; }
        }
        if (userField) { try { userField.focus(); userField.value = u; userField.dispatchEvent(new Event('input', {bubbles:true})); userField.dispatchEvent(new Event('change', {bubbles:true})); } catch(e){} }
        if (passField) { try { passField.focus(); passField.value = p; passField.dispatchEvent(new Event('input', {bubbles:true})); passField.dispatchEvent(new Event('change', {bubbles:true})); } catch(e){} }
      })();
    `;
    try {
      wv.executeJavaScript(script);
      toast('已尝试填充，如未生效请手动复制', 'ok');
    } catch (_) {
      toast('填充失败，请手动复制密码', 'err');
    }
  }

  function showPwdAddForm() {
    const form = $('br-pwd-add-form');
    if (!form) return;
    form.classList.remove('hidden');
    // 预填当前网站
    const tab = activeTab();
    if (tab && tab.url) {
      const site = siteFromUrl(tab.url);
      const inp = $('br-pwd-in-site');
      if (inp && site) inp.value = site;
    }
    const first = $('br-pwd-in-site');
    if (first) first.focus();
  }
  function hidePwdAddForm() {
    const form = $('br-pwd-add-form');
    if (form) form.classList.add('hidden');
    // 清空
    ['br-pwd-in-site', 'br-pwd-in-user', 'br-pwd-in-pass', 'br-pwd-in-note'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
  }

  function savePwd() {
    const site = trim($('br-pwd-in-site').value);
    const username = trim($('br-pwd-in-user').value);
    const password = $('br-pwd-in-pass').value;
    const note = trim($('br-pwd-in-note').value);
    if (!site) { toast('请填写网站', 'err'); return; }
    if (!username && !password) { toast('请填写用户名或密码', 'err'); return; }
    const list = getPasswords().slice();
    list.push({ id: newId(), site, username, password, note, addedAt: Date.now() });
    setPasswords(list);
    expandedSites.add(site);
    hidePwdAddForm();
    renderPwdPanel();
    toast('密码已保存', 'ok');
  }

  function bindBrowserEvents() {
    el.browser = $('browser');
    el.brAddr = $('br-addr');
    el.brBack = $('br-back');
    el.brForward = $('br-forward');

    $('btn-browser').addEventListener('click', () => {
      if (ui.browserOpen) closeBrowser();
      else openBrowser();
    });

    // 工具栏按钮：操作当前激活标签的 webview
    if (el.brBack) el.brBack.addEventListener('click', () => { const wv = activeWebview(); if (wv) { try { wv.goBack(); } catch (_) {} } });
    if (el.brForward) el.brForward.addEventListener('click', () => { const wv = activeWebview(); if (wv) { try { wv.goForward(); } catch (_) {} } });
    const reloadBtn = $('br-reload');
    if (reloadBtn) reloadBtn.addEventListener('click', () => {
      const wv = activeWebview();
      if (!wv) return;
      try {
        const tab = activeTab();
        if (tab && tab.loading) wv.stop();
        else wv.reload();
      } catch (_) {}
    });
    const homeBtn = $('br-home');
    if (homeBtn) homeBtn.addEventListener('click', () => loadBrowserUrl(getHomeUrl()));
    const goBtn = $('br-go');
    if (goBtn) goBtn.addEventListener('click', () => loadBrowserUrl(el.brAddr.value));
    el.brAddr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); loadBrowserUrl(el.brAddr.value); el.brAddr.blur(); }
    });

    // 收藏夹：添加当前页 / 打开收藏夹面板 / 更多菜单
    const favAddBtn = $('br-fav-add');
    if (favAddBtn) favAddBtn.addEventListener('click', addCurrentBookmark);
    const favAddFolderBtn = $('br-fav-add-folder');
    if (favAddFolderBtn) favAddFolderBtn.addEventListener('click', addFolder);
    const favSearchToggle = $('br-fav-search-toggle');
    if (favSearchToggle) favSearchToggle.addEventListener('click', () => {
      const row = $('br-fav-search-row');
      if (row) {
        row.classList.toggle('hidden');
        if (!row.classList.contains('hidden')) {
          const inp = $('br-fav-search');
          if (inp) inp.focus();
        } else {
          const inp = $('br-fav-search');
          if (inp) inp.value = '';
          renderFavPanel();
        }
      }
    });
    const favListBtn = $('br-fav-list');
    if (favListBtn) favListBtn.addEventListener('click', toggleFavPanel);
    const favCloseBtn = $('br-fav-close');
    if (favCloseBtn) favCloseBtn.addEventListener('click', toggleFavPanel);
    const favMoreBtn = $('br-fav-more');
    if (favMoreBtn) favMoreBtn.addEventListener('click', (e) => { e.stopPropagation(); showFavMenu(favMoreBtn); });
    const favSearch = $('br-fav-search');
    if (favSearch) favSearch.addEventListener('input', renderFavPanel);

    // 密码管理器
    const pwdBtn = $('br-pwd');
    if (pwdBtn) pwdBtn.addEventListener('click', togglePwdPanel);
    const pwdCloseBtn = $('br-pwd-close');
    if (pwdCloseBtn) pwdCloseBtn.addEventListener('click', togglePwdPanel);
    const pwdAddBtn = $('br-pwd-add');
    if (pwdAddBtn) pwdAddBtn.addEventListener('click', showPwdAddForm);
    const pwdCancelBtn = $('br-pwd-cancel');
    if (pwdCancelBtn) pwdCancelBtn.addEventListener('click', hidePwdAddForm);
    const pwdSaveBtn = $('br-pwd-save');
    if (pwdSaveBtn) pwdSaveBtn.addEventListener('click', savePwd);
    const pwdSearchToggle = $('br-pwd-search-toggle');
    if (pwdSearchToggle) pwdSearchToggle.addEventListener('click', () => {
      const row = $('br-pwd-search-row');
      if (row) {
        row.classList.toggle('hidden');
        if (!row.classList.contains('hidden')) {
          const inp = $('br-pwd-search');
          if (inp) inp.focus();
        } else {
          const inp = $('br-pwd-search');
          if (inp) inp.value = '';
          renderPwdPanel();
        }
      }
    });
    const pwdSearch = $('br-pwd-search');
    if (pwdSearch) pwdSearch.addEventListener('input', renderPwdPanel);
    const pwdInEye = $('br-pwd-in-eye');
    if (pwdInEye) pwdInEye.addEventListener('click', () => {
      const inp = $('br-pwd-in-pass');
      if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    // 保存密码开关
    const saveToggle = $('br-pwd-save-toggle');
    if (saveToggle) {
      saveToggle.checked = browserConfig().savePasswords !== false;
      saveToggle.addEventListener('change', () => {
        state.settings.browser.savePasswords = saveToggle.checked;
        scheduleSave();
        toast(saveToggle.checked ? '已启用密码保存' : '已关闭密码保存', 'ok');
      });
    }

    // 收藏夹管理页按钮
    const bmClose = $('bm-close');
    if (bmClose) bmClose.addEventListener('click', closeBookmarksPage);
    const bmAddUrl = $('bm-add-url');
    if (bmAddUrl) bmAddUrl.addEventListener('click', () => {
      const sel = ui.bmSelectedFolder || 'fav-bar';
      inputDialog('添加书签', '请输入网址', '', (url) => {
        url = trim(url);
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        inputDialog('书签标题', '请输入标题', url, (title) => {
          const tree = getBookmarks();
          const r = findNode(sel, tree, null);
          const folder = (r && r.node.type === 'folder') ? r.node : (tree.find((n) => n.id === 'fav-bar'));
          folder.children = folder.children || [];
          folder.children.push({ id: newId(), type: 'url', title: title || url, url, addedAt: Date.now() });
          setBookmarks(tree);
          toast('已添加书签', 'ok');
        });
      });
    });
    const bmAddFolder = $('bm-add-folder');
    if (bmAddFolder) bmAddFolder.addEventListener('click', () => {
      const sel = ui.bmSelectedFolder || 'fav-bar';
      inputDialog('新建文件夹', '请输入文件夹名称', '新建文件夹', (name) => {
        const tree = getBookmarks();
        const r = findNode(sel, tree, null);
        const folder = (r && r.node.type === 'folder') ? r.node : (tree.find((n) => n.id === 'fav-bar'));
        folder.children = folder.children || [];
        folder.children.push({ id: newId(), type: 'folder', title: name, children: [] });
        setBookmarks(tree);
        toast('已新建文件夹', 'ok');
      });
    });
    const bmSearch = $('bm-search');
    if (bmSearch) bmSearch.addEventListener('input', () => {
      renderBmPage();
    });

    // 启动时按设置同步主页按钮显隐
    if (homeBtn) homeBtn.classList.toggle('hidden', browserConfig().homeButton === false);

    // 主进程拦截的新窗口请求 → 在内嵌浏览器新开标签页
    if (api.onBrowserNewTab) api.onBrowserNewTab((url) => { if (url) newTab(url, true); });

    // 齿轮按钮 → 跳转到设置页的浏览器分页
    const brSettings = $('br-settings');
    if (brSettings) brSettings.addEventListener('click', () => {
      closeBrowser();
      openSettings('browser');
    });
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
    applyBrowserTheme();
  }

  // 浏览器外观主题：system 跟随工作台（移除 data-theme 继承 html）；light/dark 强制指定
  function applyBrowserTheme() {
    const b = (state && state.settings && state.settings.browser) || DEFAULT_BROWSER;
    const el = $('browser');
    if (!el) return;
    if (b.theme === 'light') el.dataset.theme = 'light';
    else if (b.theme === 'dark') el.dataset.theme = 'dark';
    else el.removeAttribute('data-theme');
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

  // 右下角休息提示 + 代理状态胶囊（水平排列）
  function paintTbRest(st) {
    const tb = $('tb-rest');
    if (!tb) return;
    tb.innerHTML = '';
    // 休息提醒胶囊（与代理胶囊同风格）
    const restSpan = document.createElement('span');
    if (!st || st.enabled === false) {
      tb.className = 'tb-rest';
    } else {
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
      restSpan.className = 'rest-pill rest-state-' + state;
      restSpan.title = '点击打开休息设置';
      const dot = document.createElement('i');
      dot.className = 'rd';
      restSpan.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = text;
      restSpan.appendChild(label);
      tb.className = 'tb-rest rest-state-' + state;
    }
    if (restSpan.className) tb.appendChild(restSpan);
    // 代理胶囊（同一容器右侧，独立子元素）
    paintProxyPill(tb);
  }

  // 右下角代理状态胶囊：代理运行中 + 模式圆点 + 当前节点名 + 上下行速率
  let pillTraffic = { t: 0, up: 0, down: 0, speed: { up: 0, down: 0 } };

  function paintProxyPill(container) {
    const ps = px.state;
    if (!ps || !ps.running) {
      // 代理停止后清掉残留胶囊
      container.querySelectorAll('.proxy-pill').forEach((n) => n.remove());
      return;
    }
    // 结构不变时只更新文字，避免每 2 秒重建 DOM
    let pill = container.querySelector('.proxy-pill');
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'proxy-pill';
      pill.title = '点击进入代理页';
      pill.addEventListener('click', (e) => { e.stopPropagation(); openProxy(); });
      const txt = document.createElement('span');
      txt.className = 'proxy-pill-text';
      txt.textContent = '代理运行中';
      pill.appendChild(txt);
      const dots = document.createElement('span');
      dots.className = 'proxy-pill-dots';
      pill.appendChild(dots);
      const node = document.createElement('span');
      node.className = 'proxy-pill-node';
      pill.appendChild(node);
      const spd = document.createElement('span');
      spd.className = 'proxy-pill-speed';
      pill.appendChild(spd);
      container.appendChild(pill);
    }
    // 彩色圆点：按实际开启的模式，可叠加多个
    const dots = pill.querySelector('.proxy-pill-dots');
    const want = [];
    if (ps.tunMode) want.push(['pd pd-tun', '虚拟网卡模式']);
    if (ps.sysProxy) want.push(['pd pd-sys', '系统代理']);
    if (ps.selfProxy) want.push(['pd pd-self', '自身代理']);
    const cur = dots.getAttribute('data-key') || '';
    const nextKey = want.map((w) => w[0]).join('|');
    if (cur !== nextKey) {
      dots.textContent = '';
      want.forEach((w) => {
        const d = document.createElement('i');
        d.className = w[0];
        d.title = w[1];
        dots.appendChild(d);
      });
      dots.setAttribute('data-key', nextKey);
    }
    updateProxyPillTexts();
  }

  // 只更新节点名与速率文字
  function updateProxyPillTexts() {
    const pill = document.querySelector('#tb-rest .proxy-pill');
    if (!pill) return;
    const nodeEl = pill.querySelector('.proxy-pill-node');
    const spdEl = pill.querySelector('.proxy-pill-speed');
    if (nodeEl) {
      const name = px.pillNode || '';
      nodeEl.textContent = name ? '｜' + name : '';
    }
    if (spdEl) {
      const s = pillTraffic.speed;
      spdEl.textContent = '｜↑' + pxFmtBytes(s.up) + '/s ↓' + pxFmtBytes(s.down) + '/s';
    }
  }

  // 每 2 秒轮询一次轻量状态（不依赖代理页是否打开）
  async function pollProxyPill() {
    if (!proxyApi || typeof proxyApi.liteStatus !== 'function') return;
    const ps = px.state;
    if (!ps || !ps.running) return;
    let r = null;
    try { r = await proxyApi.liteStatus(); } catch (_) { return; }
    if (!r || !r.running) return;
    const now = Date.now();
    if (pillTraffic.t) {
      const dt = Math.max(0.5, (now - pillTraffic.t) / 1000);
      pillTraffic.speed = {
        up: Math.max(0, (r.up - pillTraffic.up) / dt),
        down: Math.max(0, (r.down - pillTraffic.down) / dt),
      };
    }
    pillTraffic.t = now;
    pillTraffic.up = r.up;
    pillTraffic.down = r.down;
    px.pillNode = r.currentNode || px.pillNode || '';
    if (!document.querySelector('#tb-rest .proxy-pill')) {
      const tb = $('tb-rest');
      if (tb) paintProxyPill(tb);
    } else {
      updateProxyPillTexts();
    }
  }

  function startProxyPillPoll() {
    if (startProxyPillPoll._t) return;
    startProxyPillPoll._t = setInterval(pollProxyPill, 2000);
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

  /* ------------------------------ 自动更新状态 ------------------------------ */

  // 最近一次更新状态（主进程 update:state 推送）
  let updateCached = { status: 'idle', message: '', percent: 0, latestVersion: '', currentVersion: '' };

  // 合并更新状态，并同步「设置页更新状态行」与「标题栏更新提示图标」
  function applyUpdateState(patch) {
    updateCached = Object.assign({}, updateCached, patch || {});
    paintUpdateRow();
    paintUpdateBadge();
  }

  // 刷新通用页「更新状态」行（设置页未打开时静默）
  function paintUpdateRow() {
    const desc = $('st-update-desc');
    const act = $('st-update-act');
    if (!desc || !act) return;
    const st = updateCached.status || 'idle';
    desc.textContent = updateCached.message
      || (st === 'idle' ? '尚未检查更新（开启右侧开关：每次启动自动检查更新）' : '');
    if (st === 'downloaded') act.textContent = '重启安装';
    else if (st === 'downloading') act.textContent = '下载中…';
    else if (st === 'checking' || st === 'installing') act.textContent = '处理中…';
    else act.textContent = '检查更新';
    act.disabled = st === 'checking' || st === 'downloading' || st === 'installing';
  }

  // 标题栏「更新提示」图标：发现新版 / 下载中 / 已下载时显示，悬浮展示版本信息
  function paintUpdateBadge() {
    const wrap = $('tb-update');
    if (!wrap) return;
    const st = updateCached.status || 'idle';
    const show = st === 'available' || st === 'downloading' || st === 'downloaded';
    wrap.classList.toggle('hidden', !show);
    if (!show) return;
    wrap.dataset.state = st;
    const title = $('update-tip-title');
    const text = $('update-tip-desc');
    const action = $('update-tip-action');
    const v = updateCached.latestVersion ? ' v' + updateCached.latestVersion : '';
    if (title) title.textContent = st === 'downloaded' ? '新版本已就绪' + v : '发现新版本' + v;
    if (text) {
      text.textContent = st === 'downloading'
        ? '正在下载（优先增量）：' + (updateCached.percent || 0) + '%'
        : st === 'downloaded'
          ? '已下载完成，重启即可完成安装'
          : '当前 v' + (updateCached.currentVersion || '') + ' → 最新 v' + (updateCached.latestVersion || '');
    }
    if (action) action.textContent = st === 'downloading' ? '下载中，请稍候' : '点击执行更新';
    const btn = $('btn-update');
    if (btn) btn.title = (title ? title.textContent : '更新') + '（点击执行更新）';
  }

  // 把更新错误文本转成用户可读、可操作的提示
  function friendlyUpdateError(errText) {
    const t = String(errText || '');
    if (/ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT|ERR_INTERNET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|network|proxy|aborted|timeout/i.test(t)) {
      return 'GitHub 访问失败，建议重试或开启代理后再试';
    }
    if (/\b404\b|not found|no published versions|latest\.yml/i.test(t)) {
      return '没有找到新版本（GitHub 暂无可用发布）';
    }
    return '更新失败：' + (t || '未知错误');
  }

  // 点击标题栏更新图标：未下载则下载，已下载则重启安装
  async function onUpdateBadgeClick() {
    const st = updateCached.status;
    if (st === 'downloaded') {
      const r = await updatesApi.install();
      if (r && !r.ok) toast(r.error || '安装更新失败', 'err');
      return;
    }
    if (st === 'available') {
      applyUpdateState({ status: 'downloading', percent: 0, message: '正在下载更新（优先增量）…' });
      const d = await updatesApi.download();
      if (d && !d.ok) {
        const msg = friendlyUpdateError(d.error);
        applyUpdateState({ status: 'available', message: msg });
        toast(msg, 'err');
      }
      return;
    }
    if (st === 'downloading') toast('正在下载更新，请稍候…', 'ok');
  }

  // 更新检查只负责「检查」，不自动下载；发现新版后由标题栏图标触发下载
  // auto=true 为启动时静默检查（不弹提示，仅更新状态 / 显示标题栏图标）
  async function runUpdateCheck(auto) {
    const st = updateCached.status || 'idle';
    if (st === 'checking' || st === 'downloading' || st === 'installing') return;
    // 立即反馈，避免等待网络期间「点了没反应」
    applyUpdateState({ status: 'checking', percent: 0, message: '正在检查更新…' });
    let r;
    try {
      // 主进程请求可能较慢（GitHub 访问不畅），最多等 20 秒
      r = await Promise.race([
        updatesApi.check(),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, errorKind: 'network', error: '检查超时' }), 20000)),
      ]);
    } catch (err) {
      r = { ok: false, errorKind: 'other', error: String((err && err.message) || err) };
    }

    if (!r || !r.ok) {
      // 按失败原因给出可操作的提示
      const kind = r && r.errorKind;
      const msg = kind === 'network'
        ? 'GitHub 访问失败，建议重试或开启代理后再试'
        : kind === 'notfound'
          ? '没有找到新版本（GitHub 暂无可用发布）'
          : '检查更新失败：' + ((r && r.error) || '未知错误');
      applyUpdateState({ status: 'error', message: msg });
      if (!auto) toast(msg, 'err');
      return;
    }

    if (!r.available) {
      const cur = r.currentVersion || '';
      applyUpdateState({ status: 'idle', message: '没有找到新版本（当前已是最新 v' + cur + '）', latestVersion: r.latestVersion || '', currentVersion: cur, percent: 0 });
      if (!auto) toast('没有找到新版本，当前已是最新 v' + cur, 'ok');
      return;
    }

    // 发现新版本：只显示提示图标，等待用户「点击执行更新」
    applyUpdateState({
      status: 'available',
      latestVersion: r.latestVersion,
      currentVersion: r.currentVersion,
      percent: 0,
      message: '发现新版本 v' + r.latestVersion + '，点击标题栏更新图标执行更新',
    });
    if (!auto) toast('发现新版本 v' + r.latestVersion + '，点击右上角更新图标执行更新', 'ok');
  }

  // 通用设置：侧边栏导航配置（顺序 / 置顶置底 / 快捷键 / 显隐）
  function sidebarNavHtml(s) {
    // 与真实侧边栏保持同一顺序，配置行会跟随上下移动实时重排
    const nav = sortSidebarNav(normalizeSidebarNav(s && s.sidebarNav));
    const rows = nav.map((item) => {
      const def = SIDEBAR_ITEMS.find((d) => d.id === item.id) || item;
      const sc = item.shortcut || '未设置';
      return [
        '  <div class="set-row sb-nav-row" data-sid="' + item.id + '">',
        '    <div class="set-label">' + def.name + '</div>',
        '    <div class="set-inline sb-nav-ctrls">',
        '      <button class="btn slim sb-up" data-sid="' + item.id + '" data-act="up" title="上移">↑</button>',
        '      <button class="btn slim sb-down" data-sid="' + item.id + '" data-act="down" title="下移">↓</button>',
        '      <select class="set-select sb-pos" data-sid="' + item.id + '" title="置顶 / 置底">',
        '        <option value="top"' + (item.position === 'top' ? ' selected' : '') + '>置顶</option>',
        '        <option value="bottom"' + (item.position === 'bottom' ? ' selected' : '') + '>置底</option>',
        '      </select>',
        '      <button class="btn sb-sc' + (ui.sidebarShortcutListening === item.id ? ' is-recording' : '') + '" data-sid="' + item.id + '" data-act="shortcut" title="点击后按下任意键设置快捷键；按 Backspace 清除">' + (ui.sidebarShortcutListening === item.id ? '按下按键…' : formatShortcut(sc)) + '</button>',
        '      <button class="switch sb-vis' + (item.visible ? ' on' : '') + '" data-sid="' + item.id + '" data-act="visible" role="switch" title="在侧边栏显示 / 隐藏"></button>',
        '    </div>',
        '  </div>',
      ].join('');
    }).join('');
    return [
      '<div class="set-group" data-skey="sidebar-nav">',
      '  <div class="set-group-title">侧边栏<span class="set-desc">调整各项的排列顺序、置顶 / 置底、显示与快捷键（F1 ~ F5）</span></div>',
      rows,
      '</div>',
    ].join('');
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
      '  <div class="set-group-title">启动</div>',
      '  <div class="set-row" data-skey="autoLaunch">',
      '    <div class="set-label">开机自动启动<span class="set-desc" id="st-auto-launch-desc">读取中…</span></div>',
      '    <button class="switch" id="st-auto-launch" role="switch" title="登录 Windows 后自动启动工作台"></button>',
      '  </div>',
      '</div>',
      '<div class="set-group">',
      '  <div class="set-group-title">布局</div>',
      '  <div class="set-row btns" data-skey="reset">',
      '    <button class="btn danger" id="st-reset">恢复默认布局</button>',
      '  </div>',
      '</div>',
      sidebarNavHtml(s),
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
      '<div class="set-group">',
      '  <div class="set-group-title">更新</div>',
      '  <div class="set-row" data-skey="update">',
      '    <div class="set-label">更新状态<span class="set-desc" id="st-update-desc">尚未检查更新（开启右侧开关：每次启动自动检查更新）</span></div>',
      '    <div class="set-inline">',
      '      <button class="switch' + (s.autoUpdate ? ' on' : '') + '" id="st-auto-update" role="switch" title="开启后每次启动工作台自动检查更新，发现新版本时在标题栏显示提示图标"></button>',
      '      <button class="btn" id="st-update-act">检查更新</button>',
      '    </div>',
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
    { id: 'sidebar-nav', tab: 'general', name: '侧边栏', desc: '调整各项的排列顺序、置顶 / 置底、显示与快捷键（F1 ~ F5）' },
    { id: 'update', tab: 'general', name: '更新状态 / 自动检查更新', desc: '开启开关后每次启动自动检查；也可手动检查新版本或重启安装已下载的更新' },
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
    { id: 'br-enabled', tab: 'browser', name: '启用内嵌浏览器', desc: '总开关；关闭后侧边栏隐藏「浏览器」入口' },
    { id: 'br-open-links', tab: 'browser', name: '网址快捷方式在内嵌浏览器打开', desc: '点击 http(s) 网址图标时默认在内嵌浏览器打开；关闭则调用系统默认浏览器' },
    { id: 'br-theme', tab: 'browser', name: '浏览器主题', desc: '浏览器工具栏外观：浅色 / 深色 / 系统默认值（跟随工作台主题）' },
    { id: 'br-startup', tab: 'browser', name: '启动时打开', desc: '打开浏览器时的初始页面：新标签页 / 上次页面 / 自定义网址' },
    { id: 'br-startup-url', tab: 'browser', name: '启动网址', desc: '启动方式为「自定义网址」时打开的网址' },
    { id: 'br-home-button', tab: 'browser', name: '显示主页按钮', desc: '在浏览器工具栏显示「主页」按钮' },
    { id: 'br-home-action', tab: 'browser', name: '主页按钮行为', desc: '点击主页按钮时跳转：新标签页 / 自定义网址' },
    { id: 'br-home-url', tab: 'browser', name: '主页网址', desc: '主页按钮行为为「自定义网址」时跳转的网址' },
    { id: 'br-newtab', tab: 'browser', name: '新建标签页打开', desc: '新标签页默认加载：首页 / 自定义网址 / 空白页' },
    { id: 'br-newtab-url', tab: 'browser', name: '新标签页网址', desc: '新标签页为「自定义网址」时加载的网址' },
    { id: 'tg-enabled', tab: 'telegram', name: '自动保存媒体文件', desc: '内嵌 Telegram 网页版浏览媒体时自动静默保存到本地文件夹' },
    { id: 'tg-path', tab: 'telegram', name: '媒体保存路径', desc: '自动保存的媒体文件存放位置；留空则使用系统下载目录下的 Telegram 子文件夹' },
  ];
  const SETTINGS_TAB_NAME = { general: '通用', rest: '休息', app: '应用', shortcut: '快捷键', browser: '浏览器', telegram: 'Telegram' };

  // 复用全局搜索的 matchItem：名称 + 描述合并匹配（包含 / 全拼 / 首拼 / 英文首字母 / 子序列模糊）
  function matchSetting(entry, q, compact) {
    return matchItem({ name: entry.name + ' ' + entry.desc }, q, compact);
  }

  // 跳到某个设置项：切页签、清搜索、滚动定位并闪烁高亮
  function jumpToSetting(id) {
    const entry = SETTINGS_INDEX.find((it) => it.id === id);
    if (!entry) return;
    ui.settingsQuery = '';
    ui.settingsTab = entry.tab;
    updateSettingsPage();
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

  // 浏览器设置页：总开关 / 启动时 / 首页按钮 / 新建标签页
  function browserTabHtml(b) {
    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const segBtn = (val, label, cur) => '<button data-v="' + val + '"' + (cur === val ? ' class="on"' : '') + '>' + label + '</button>';
    return [
      '<div class="set-group">',
      '  <div class="set-group-title">内嵌浏览器</div>',
      '  <div class="set-row" data-skey="br-enabled">',
      '    <div class="set-label">启用内嵌浏览器<span class="set-desc">关闭后侧边栏将隐藏「浏览器」入口，已打开的浏览器视图会被关闭</span></div>',
      '    <button class="switch' + (b.enabled ? ' on' : '') + '" id="st-br-enabled" role="switch" title="开启 / 关闭内嵌浏览器"></button>',
      '  </div>',
      '  <div class="set-row" data-skey="br-open-links">',
      '    <div class="set-label">网址快捷方式在内嵌浏览器打开<span class="set-desc">点击 http(s) 网址图标时，默认在内嵌浏览器打开；关闭则调用系统默认浏览器</span></div>',
      '    <button class="switch' + (b.openLinksInApp ? ' on' : '') + '" id="st-br-open-links" role="switch" title="开启 / 关闭内嵌浏览器打开网址"></button>',
      '  </div>',
      '</div>',
      '<div class="set-group">',
      '  <div class="set-group-title">外观</div>',
      '  <div class="set-row" data-skey="br-theme">',
      '    <div class="set-label">浏览器主题<span class="set-desc">控制浏览器工具栏的深浅色外观；「系统默认值」跟随工作台主题</span></div>',
      '    <div class="seg" id="st-br-theme">',
      segBtn('light', '浅色', b.theme),
      segBtn('dark', '深色', b.theme),
      segBtn('system', '系统默认值', b.theme),
      '    </div>',
      '  </div>',
      '</div>',
      '<div class="set-group">',
      '  <div class="set-group-title">启动时</div>',
      '  <div class="set-row" data-skey="br-startup">',
      '    <div class="set-label">打开浏览器时<span class="set-desc">点击侧边栏「浏览器」进入时的初始页面</span></div>',
      '    <div class="seg" id="st-br-startup">',
      segBtn('newtab', '新标签页', b.startup),
      segBtn('continue', '上次页面', b.startup),
      segBtn('custom', '自定义网址', b.startup),
      '    </div>',
      '  </div>',
      '  <div class="set-row' + (b.startup === 'custom' ? '' : ' hidden') + '" data-skey="br-startup-url" id="st-br-startup-url-row">',
      '    <div class="set-label">启动网址<span class="set-desc">例如 https://www.baidu.com</span></div>',
      '    <input class="input" id="st-br-startup-url" type="text" value="' + esc(b.startupUrl) + '" spellcheck="false" autocomplete="off" placeholder="https://...">',
      '  </div>',
      '</div>',
      '<div class="set-group">',
      '  <div class="set-group-title">首页按钮</div>',
      '  <div class="set-row" data-skey="br-home-button">',
      '    <div class="set-label">显示主页按钮<span class="set-desc">在浏览器工具栏显示「主页」按钮</span></div>',
      '    <button class="switch' + (b.homeButton ? ' on' : '') + '" id="st-br-home-button" role="switch" title="显示 / 隐藏主页按钮"></button>',
      '  </div>',
      '  <div class="set-row" data-skey="br-home-action">',
      '    <div class="set-label">主页按钮打开<span class="set-desc">点击主页按钮时跳转的页面</span></div>',
      '    <div class="seg" id="st-br-home-action">',
      segBtn('newtab', '新标签页', b.homeAction),
      segBtn('custom', '自定义网址', b.homeAction),
      '    </div>',
      '  </div>',
      '  <div class="set-row' + (b.homeAction === 'custom' ? '' : ' hidden') + '" data-skey="br-home-url" id="st-br-home-url-row">',
      '    <div class="set-label">主页网址<span class="set-desc">例如 https://cn.bing.com</span></div>',
      '    <input class="input" id="st-br-home-url" type="text" value="' + esc(b.homeUrl) + '" spellcheck="false" autocomplete="off" placeholder="https://...">',
      '  </div>',
      '</div>',
      '<div class="set-group">',
      '  <div class="set-group-title">新建标签页</div>',
      '  <div class="set-row" data-skey="br-newtab">',
      '    <div class="set-label">新标签页打开<span class="set-desc">新建标签页时默认加载的页面</span></div>',
      '    <div class="seg" id="st-br-newtab">',
      segBtn('homepage', '首页', b.newTab),
      segBtn('custom', '自定义网址', b.newTab),
      segBtn('blank', '空白页', b.newTab),
      '    </div>',
      '  </div>',
      '  <div class="set-row' + (b.newTab === 'custom' ? '' : ' hidden') + '" data-skey="br-newtab-url" id="st-br-newtab-url-row">',
      '    <div class="set-label">新标签页网址<span class="set-desc">例如 https://www.baidu.com</span></div>',
      '    <input class="input" id="st-br-newtab-url" type="text" value="' + esc(b.newTabUrl) + '" spellcheck="false" autocomplete="off" placeholder="https://...">',
      '  </div>',
      '</div>',
    ].join('');
  }

  // 设置页：Telegram 页面
  function telegramTabHtml(t) {
    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const p = trim(t.saveMediaPath);
    const pathHint = p ? p : '（未设置：使用系统下载目录下的 Telegram 子文件夹）';
    return [
      '<div class="set-group">',
      '  <div class="set-group-title">媒体自动保存</div>',
      '  <div class="set-row" data-skey="tg-enabled">',
      '    <div class="set-label">自动保存媒体文件<span class="set-desc">浏览内嵌 Telegram 网页版时，图片、视频、语音等媒体自动静默保存到本地，不弹任何对话框；关闭后不再保存</span></div>',
      '    <button class="switch' + (t.enabled ? ' on' : '') + '" id="st-tg-enabled" role="switch" title="开启 / 关闭 Telegram 媒体自动保存"></button>',
      '  </div>',
      '  <div class="set-row set-row-col" data-skey="tg-path">',
      '    <div class="set-label">媒体保存路径<span class="set-desc">留空则使用系统默认下载目录 + Telegram 子文件夹；也可指定自定义绝对路径，如 D:\\Telegram\\Media</span></div>',
      '    <div class="st-path-row">',
      '      <input class="input st-path-input" id="st-tg-path" type="text" value="' + esc(p) + '" spellcheck="false" autocomplete="off" placeholder="留空使用默认下载目录">',
      '      <button class="btn" id="st-tg-path-pick" type="button">选择…</button>',
      '      <button class="btn" id="st-tg-path-reset" type="button" title="恢复默认（系统下载目录\\Telegram）">默认</button>',
      '    </div>',
      '    <div class="set-subhint" id="st-tg-path-hint">当前保存位置：' + esc(pathHint) + '</div>',
      '  </div>',
      '</div>',
      '<div class="set-group">',
      '  <div class="set-group-title set-collapsible" id="st-tg-help-toggle">使用说明 <span class="set-caret">▼</span></div>',
      '  <div class="set-collapsible-body" id="st-tg-help-body" style="display:none">',
      '    <div class="set-desc-big">',
      '      • 自动保存会在打开内嵌 Telegram 网页版后生效，走你当前开启的代理模式（自身代理 / 系统代理 / TUN）<br>',
      '      • 媒体按 频道 / 群 / 对话 自动分文件夹存放，重名自动加序号，格式保留原始扩展名（jpg / mp4 / ogg 等）<br>',
      '      • 仅对新加载的媒体生效；已缓存的历史内容不会自动追溯落盘<br>',
      '      • 视频如果是流式播放（MSE）无法整体拦截，只有完整加载的视频能保存<br>',
      '      • 右键侧栏 Telegram 入口可「刷新」或「重启」webview，页面卡住时使用',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');
  }

  // 设置页：四大页（通用 / 休息 / 应用 / 快捷键 / 浏览器 / Telegram），渲染进宫格区域
  function renderSettingsPage() {
    stopRestStatusTimer();
    if (!restConfig || typeof restConfig !== 'object') restConfig = Object.assign({}, REST_FALLBACK);

    const s = state.settings;
    const tab = ui.settingsTab || 'general';
    const tabs = [
      ['general', '通用', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.2 4.2h5.6M11.2 4.2h2.6M2.2 11.8h2.6M8.2 11.8h5.6"/><circle cx="9.4" cy="4.2" r="1.5"/><circle cx="6.4" cy="11.8" r="1.5"/></svg>'],
      ['shortcut', '快捷键', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="1.8" y="4" width="12.4" height="8" rx="1.6"/><path d="M4.4 6.6h.1M7 6.6h.1M9.6 6.6h.1M12.2 6.6h.1M4.4 9.2h.1M6.4 9.2h3.2"/></svg>'],
      ['rest', '休息', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="5.6"/><path d="M8 4.6V8l2.4 1.6"/></svg>'],
      ['app', '应用', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.6" y="2.6" width="4.6" height="4.6" rx="1.2"/><rect x="8.8" y="2.6" width="4.6" height="4.6" rx="1.2"/><rect x="2.6" y="8.8" width="4.6" height="4.6" rx="1.2"/><rect x="8.8" y="8.8" width="4.6" height="4.6" rx="1.2"/></svg>'],
      ['proxy', '代理', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2c-2.6 0-4.7 2-4.9 4.5A3 3 0 0 0 4.2 12.4h7.6a2.8 2.8 0 0 0 .6-5.5A4.7 4.7 0 0 0 8 2.2z"/><path d="M5.6 9.4h4.8M8.4 7.7l2 1.7-2 1.7"/></svg>'],
      ['browser', '浏览器', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="5.6"/><path d="M2.6 8h10.8M8 2.4c1.6 1.6 2.4 3.5 2.4 5.6s-.8 4-2.4 5.6c-1.6-1.6-2.4-3.5-2.4-5.6s.8-4 2.4-5.6z"/></svg>'],
      ['telegram', 'Telegram', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 8.4c3.6-2.4 6.2-3.6 7.8-3.6s2.4.6 2 2.4c-.4 1.8-2 5.4-3.8 5.6s-2-1.4-3.2-2.6c-1-1-1.6-1-2.8-.6-.6.2-1-.4-1-1.2z"/><path d="M6 9l4-3"/></svg>'],
    ];

    el.grid.style.display = 'block';
    el.grid.innerHTML = [
      '<div class="settings-page">',
      '  <aside class="settings-nav">',
      '    <button class="settings-back" id="st-back">← 返回应用</button>',
      '    <div class="search tb-search st-search-wrap" id="st-search-wrap">',
      '      <svg viewBox="0 0 16 16" width="14" height="14" class="search-ico"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.6 10.6l3.2 3.2" stroke="currentColor" stroke-width="1.3"/></svg>',
      '      <input class="st-search" id="st-search" type="text" placeholder="搜索设置项" autocomplete="off" spellcheck="false">',
      '    </div>',
      '    <nav class="set-tabs" id="st-tabs">',
      tabs.map(([key, name, ico]) => '      <button data-tab="' + key + '"' + (tab === key ? ' class="on"' : '') + '>' + ico + '<span>' + name + '</span></button>').join(''),
      '    </nav>',
      '  </aside>',
      '  <section class="settings-main">',
      '    <div class="settings-title">' + (tabs.find((t) => t[0] === tab) || tabs[0])[1] + '</div>',
      '    <div class="settings-search-results" id="st-sres" style="display:none"></div>',
      '    <div class="settings-body" id="st-body">',
      tab === 'rest' ? restTabHtml() : tab === 'app' ? appTabHtml(s) : tab === 'shortcut' ? shortcutTabHtml() : tab === 'browser' ? browserTabHtml(s.browser || {}) : tab === 'telegram' ? telegramTabHtml(telegramConfig()) : generalTabHtml(s),
      '    </div>',
      '  </section>',
      '</div>',
    ].join('');

    const q = (sel) => el.grid.querySelector(sel);

    // 左上角「返回应用」：退出设置页回到宫格
    const backBtn = q('#st-back');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        ui.settingsOpen = false;
        ui.settingsQuery = '';
        render();
      });
    }

    q('#st-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      // 「代理」作为独立视图：点击后直接进入代理管理页，不复用设置页内容区
      if (b.dataset.tab === 'proxy') {
        openProxy();
        return;
      }
      if (b.dataset.tab === ui.settingsTab) return;
      ui.settingsTab = b.dataset.tab;
      ui.settingsQuery = ''; // 手动切页签时退出搜索
      updateSettingsPage();
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
    stSearch.value = ui.settingsQuery || '';

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
        // 不冒泡触发「关闭设置页」：有内容先清空，否则仅移出焦点
        e.stopPropagation();
        if (stSearch.value) {
          stSearch.value = '';
          ui.settingsQuery = '';
          paintSettingsSearch();
        } else {
          stSearch.blur();
        }
      }
    });
    q('#st-sres').addEventListener('click', (e) => {
      const row = e.target.closest('.st-hit');
      if (row) jumpToSetting(row.dataset.sid);
    });
    if (ui.settingsQuery) paintSettingsSearch();

    bindSettingsBodyEvents();
  }

  // 设置页右侧内容的控件事件：每次重建 #st-body 后都要重新绑定
  function bindSettingsBodyEvents() {
    const q = (sel) => el.grid.querySelector(sel);
    const tab = ui.settingsTab || 'general';

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

    /* ------------------------------ 侧边栏配置 ------------------------------ */
    // 上移 / 下移：与配置列表中相邻项交换槽位（跨置顶/置底分组时连同分组一起交换），
    // 保证「设置里的行位置」和「真实侧栏按钮位置」始终一致
    function moveSidebarItem(id, dir) {
      const nav = getSidebarNav();
      const ordered = sortSidebarNav(nav);
      const idx = ordered.findIndex((n) => n.id === id);
      if (idx < 0) return;
      const target = ordered[idx + dir];
      if (!target) return; // 已到列表顶端 / 底端
      const cur = ordered[idx];
      // 交换两项的「位置 + 顺序」槽位
      const pos = cur.position; cur.position = target.position; target.position = pos;
      const ord = cur.order; cur.order = target.order; target.order = ord;
      state.settings.sidebarNav = nav;
      scheduleSave();
      renderSidebar();
      updateSettingsPage();
    }
    el.grid.querySelectorAll('.sb-nav-row').forEach((row) => {
      const id = row.dataset.sid;
      const up = row.querySelector('.sb-up');
      const down = row.querySelector('.sb-down');
      const pos = row.querySelector('.sb-pos');
      const sc = row.querySelector('.sb-sc');
      const vis = row.querySelector('.sb-vis');
      if (up) up.addEventListener('click', () => moveSidebarItem(id, -1));
      if (down) down.addEventListener('click', () => moveSidebarItem(id, 1));
      if (pos) pos.addEventListener('change', () => {
        const nav = getSidebarNav();
        const item = nav.find((n) => n.id === id);
        if (item) { item.position = pos.value; state.settings.sidebarNav = nav; scheduleSave(); renderSidebar(); updateSettingsPage(); }
      });
      if (sc) sc.addEventListener('click', () => {
        ui.sidebarShortcutListening = ui.sidebarShortcutListening === id ? null : id;
        ui.shortcutListening = null; // 互斥：不同时录制应用快捷键
        updateSettingsPage();
      });
      if (vis) vis.addEventListener('click', () => {
        const nav = getSidebarNav();
        const item = nav.find((n) => n.id === id);
        if (item) { item.visible = !item.visible; state.settings.sidebarNav = nav; scheduleSave(); renderSidebar(); updateSettingsPage(); }
      });
    });

    // 关于区块：开源地址点击弹出选择（内置浏览器 / 外部浏览器）
    const aboutLink = q('#st-about-link');
    if (aboutLink) {
      aboutLink.addEventListener('click', (e) => {
        e.preventDefault();
        openAboutLinkDialog(REPO_URL);
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

    // 开机自动启动：以主进程真实状态为准（普通=Run 项；管理员启动=计划任务）
    const alSw = q('#st-auto-launch');
    const alDesc = q('#st-auto-launch-desc');
    const paintAutoLaunch = (r) => {
      if (!r) return;
      alSw.classList.toggle('on', !!r.enabled);
      if (!alDesc) return;
      if (r.mechanism === 'task') {
        alDesc.textContent = '已通过「计划任务」在登录时启动（当前程序以管理员身份运行，Windows 会忽略普通的启动项）';
      } else if (r.mechanism === 'run') {
        alDesc.textContent = '已写入 Windows 启动项（HKCU\\Run）';
      } else if (r.elevated) {
        alDesc.textContent = '当前程序以管理员身份运行，普通启动项会被 Windows 忽略；开启后自动改用「计划任务」方式';
      } else {
        alDesc.textContent = '关闭状态：登录 Windows 后不会自动启动';
      }
    };
    if (alSw) {
      api.getAutoLaunch().then(paintAutoLaunch).catch(() => {});
      alSw.addEventListener('click', async () => {
        const next = !alSw.classList.contains('on');
        alSw.classList.toggle('on', next);
        let r = null;
        try { r = await api.setAutoLaunch(next); } catch (_) {}
        if (!r || !r.ok) {
          alSw.classList.toggle('on', !next);
          toast((r && r.error) || '设置开机自启失败', 'err');
          return;
        }
        paintAutoLaunch(r);
        toast(r.enabled ? '已开启开机自动启动' : '已关闭开机自动启动', 'ok');
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

    // 自动更新开关：默认关闭；开启时立即检查一次
    const autoUpSw = q('#st-auto-update');
    if (autoUpSw) {
      autoUpSw.addEventListener('click', () => {
        const next = !autoUpSw.classList.contains('on');
        pushHistory();
        state.settings.autoUpdate = next;
        autoUpSw.classList.toggle('on', next);
        scheduleSave();
        toast(next ? '已开启自动更新' : '已关闭自动更新', 'ok');
        if (next) runUpdateCheck(false);
      });
    }

    // 更新状态行：已下载 → 重启安装；已发现新版 → 开始下载；否则检查更新
    const updateAct = q('#st-update-act');
    if (updateAct) {
      updateAct.addEventListener('click', async () => {
        if (updateCached.status === 'downloaded') {
          const r = await updatesApi.install();
          if (r && !r.ok) toast(r.error || '安装更新失败', 'err');
          return;
        }
        if (updateCached.status === 'available') {
          onUpdateBadgeClick();
          return;
        }
        runUpdateCheck(false);
      });
    }
    paintUpdateRow();
    paintUpdateBadge();

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

    /* -------------------------------- 浏览器页 -------------------------------- */

    // 总开关：关闭时隐藏侧边栏入口并关闭已打开的浏览器视图
    const brEnabledBtn = q('#st-br-enabled');
    if (brEnabledBtn) {
      brEnabledBtn.addEventListener('click', () => {
        const next = !brEnabledBtn.classList.contains('on');
        pushHistory();
        state.settings.browser.enabled = next;
        brEnabledBtn.classList.toggle('on', next);
        scheduleSave();
        // 立即同步侧边栏「浏览器」按钮显隐
        const sb = $('btn-browser');
        if (sb) sb.classList.toggle('hidden', !next);
        if (!next && ui.browserOpen) closeBrowser();
        toast(next ? '已启用内嵌浏览器' : '已关闭内嵌浏览器', 'ok');
      });
    }

    // 网址快捷方式：是否默认在内嵌浏览器打开
    const openLinksBtn = q('#st-br-open-links');
    if (openLinksBtn) {
      openLinksBtn.addEventListener('click', () => {
        const next = !openLinksBtn.classList.contains('on');
        pushHistory();
        state.settings.browser.openLinksInApp = next;
        openLinksBtn.classList.toggle('on', next);
        scheduleSave();
        toast(next ? '网址将在内嵌浏览器中打开' : '网址将用系统默认浏览器打开', 'ok');
      });
    }

    // 分段选择器通用绑定：写入字段 + 切换自定义网址输入行显隐
    const bindBrowserSeg = (segId, field, rowId) => {
      const seg = q('#' + segId);
      if (!seg) return;
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-v]');
        if (!btn || btn.classList.contains('on')) return;
        pushHistory();
        state.settings.browser[field] = btn.dataset.v;
        Array.from(seg.querySelectorAll('button[data-v]')).forEach((x) => {
          x.classList.toggle('on', x === btn);
        });
        // 联动对应自定义网址行的显隐
        if (rowId) {
          const row = q('#' + rowId);
          if (row) row.classList.toggle('hidden', btn.dataset.v !== 'custom');
        }
        // 主题切换立即生效
        if (field === 'theme') applyBrowserTheme();
        scheduleSave();
      });
    };
    bindBrowserSeg('st-br-startup', 'startup', 'st-br-startup-url-row');
    bindBrowserSeg('st-br-home-action', 'homeAction', 'st-br-home-url-row');
    bindBrowserSeg('st-br-newtab', 'newTab', 'st-br-newtab-url-row');
    bindBrowserSeg('st-br-theme', 'theme', null);

    // 自定义网址输入框：防抖保存
    const bindBrowserUrl = (inputId, field) => {
      const inp = q('#' + inputId);
      if (!inp) return;
      let t = null;
      inp.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          state.settings.browser[field] = trim(inp.value);
          scheduleSave();
        }, 400);
      });
      inp.addEventListener('change', () => {
        clearTimeout(t);
        state.settings.browser[field] = trim(inp.value);
        scheduleSave();
      });
    };
    bindBrowserUrl('st-br-startup-url', 'startupUrl');
    bindBrowserUrl('st-br-home-url', 'homeUrl');
    bindBrowserUrl('st-br-newtab-url', 'newTabUrl');

    // 主页按钮显示开关：同步工具栏主页按钮显隐
    const homeBtnSw = q('#st-br-home-button');
    if (homeBtnSw) {
      homeBtnSw.addEventListener('click', () => {
        const next = !homeBtnSw.classList.contains('on');
        pushHistory();
        state.settings.browser.homeButton = next;
        homeBtnSw.classList.toggle('on', next);
        scheduleSave();
        const hb = $('br-home');
        if (hb) hb.classList.toggle('hidden', !next);
        toast(next ? '已显示主页按钮' : '已隐藏主页按钮', 'ok');
      });
    }

    /* -------------------------------- Telegram 页 -------------------------------- */

    // 自动保存开关
    const tgEnabledBtn = q('#st-tg-enabled');
    if (tgEnabledBtn) {
      tgEnabledBtn.addEventListener('click', () => {
        const next = !tgEnabledBtn.classList.contains('on');
        pushHistory();
        state.settings.telegram.enabled = next;
        tgEnabledBtn.classList.toggle('on', next);
        scheduleSave();
        toast(next ? '已开启 Telegram 媒体自动保存' : '已关闭 Telegram 媒体自动保存', 'ok');
      });
    }

    // 保存路径输入框：防抖保存
    const tgPathInp = q('#st-tg-path');
    const tgPathHint = q('#st-tg-path-hint');
    if (tgPathInp) {
      const updateHint = () => {
        const v = trim(tgPathInp.value);
        if (tgPathHint) tgPathHint.textContent = '当前保存位置：' + (v ? v : '（未设置：使用系统下载目录下的 Telegram 子文件夹）');
      };
      let t = null;
      tgPathInp.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          state.settings.telegram.saveMediaPath = trim(tgPathInp.value);
          scheduleSave();
          updateHint();
        }, 400);
        updateHint();
      });
      tgPathInp.addEventListener('change', () => {
        clearTimeout(t);
        state.settings.telegram.saveMediaPath = trim(tgPathInp.value);
        scheduleSave();
        updateHint();
      });
      updateHint();
    }

    // 选择文件夹
    const tgPathPick = q('#st-tg-path-pick');
    if (tgPathPick) {
      tgPathPick.addEventListener('click', async () => {
        if (!isElectron) { toast('浏览器预览模式下无法选择文件夹', 'err'); return; }
        const res = await api.pick({ directory: true, title: '选择 Telegram 媒体保存文件夹' });
        if (res && res.ok && res.path) {
          pushHistory();
          state.settings.telegram.saveMediaPath = res.path;
          scheduleSave();
          if (tgPathInp) { tgPathInp.value = res.path; }
          if (tgPathHint) tgPathHint.textContent = '当前保存位置：' + res.path;
          toast('已设置保存路径', 'ok');
        }
      });
    }

    // 恢复默认
    const tgPathReset = q('#st-tg-path-reset');
    if (tgPathReset) {
      tgPathReset.addEventListener('click', () => {
        pushHistory();
        state.settings.telegram.saveMediaPath = '';
        scheduleSave();
        if (tgPathInp) { tgPathInp.value = ''; tgPathInp.focus(); }
        if (tgPathHint) tgPathHint.textContent = '当前保存位置：（未设置：使用系统下载目录下的 Telegram 子文件夹）';
        toast('已恢复默认保存路径', 'ok');
      });
    }

    // 使用说明折叠/展开
    const tgHelpToggle = q('#st-tg-help-toggle');
    const tgHelpBody = q('#st-tg-help-body');
    if (tgHelpToggle && tgHelpBody) {
      tgHelpToggle.addEventListener('click', () => {
        const open = tgHelpBody.style.display !== 'none';
        tgHelpBody.style.display = open ? 'none' : 'block';
        const caret = tgHelpToggle.querySelector('.set-caret');
        if (caret) caret.textContent = open ? '▼' : '▲';
      });
    }

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

  // 仅刷新标题、选中态与右侧内容：保留左侧导航与搜索框 DOM，避免整页重建造成搜索框闪动
  function updateSettingsPage() {
    stopRestStatusTimer();
    if (!restConfig || typeof restConfig !== 'object') restConfig = Object.assign({}, REST_FALLBACK);
    const page = el.grid.querySelector('.settings-page');
    if (!page) { renderSettingsPage(); return; }
    const s = state.settings;
    const tab = ui.settingsTab || 'general';
    const nameOf = { general: '通用', shortcut: '快捷键', rest: '休息', app: '应用', proxy: '代理', browser: '浏览器', telegram: 'Telegram' };
    page.querySelectorAll('#st-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const title = page.querySelector('.settings-title');
    if (title) title.textContent = nameOf[tab] || '通用';
    const body = page.querySelector('#st-body');
    if (body) {
      body.style.display = '';
      body.innerHTML = tab === 'rest' ? restTabHtml() : tab === 'app' ? appTabHtml(s) : tab === 'shortcut' ? shortcutTabHtml() : tab === 'browser' ? browserTabHtml(s.browser || {}) : tab === 'telegram' ? telegramTabHtml(telegramConfig()) : generalTabHtml(s);
    }
    const res = page.querySelector('#st-sres');
    if (res) { res.style.display = 'none'; res.innerHTML = ''; }
    const inp = page.querySelector('#st-search');
    if (inp) inp.value = ui.settingsQuery || '';
    bindSettingsBodyEvents();
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
    if (ui.proxyOpen) {
      parts = ['代理', '点左侧「快速启动」或按 Esc 回到宫格'];
    } else if (ui.settingsOpen) {
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
    // 网址快捷方式：若开启「默认用内嵌浏览器打开」且浏览器已启用，则在内嵌浏览器中打开
    const target = String(item.target || '');
    const isWebUrl = /^https?:\/\//i.test(target);
    const b = browserConfig();
    if (isWebUrl && b.enabled && b.openLinksInApp) {
      openBrowser(target);
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

  // 是否允许"通过代理启动"（自身代理开启 + 内核运行 + 未同时启用系统代理/TUN）
  function pxCanProxyLaunch() {
    const st = px.state;
    return !!(st && st.running && st.selfProxy && !st.sysProxy && !st.tunMode);
  }

  // 通过代理启动（仅在自身代理+运行中+未开系统代理/TUN 时可用）
  async function launchItemProxied(item) {
    if (!api || !api.launchProxied) { toast('当前环境不支持代理启动', 'err'); return; }
    if (!item || !trim(item.target)) { toast('目标为空', 'err'); return; }
    const pxSt = px.state;
    const ok = !!(pxSt && pxSt.running && pxSt.selfProxy && !pxSt.sysProxy && !pxSt.tunMode);
    if (!ok) {
      toast('代理前置条件未满足：内核运行 + 自身代理已开 + 未开系统代理/TUN', 'err');
      return;
    }
    try {
      const payload = { target: trim(item.target), args: item.args || '', cwd: item.cwd || '' };
      const res = await api.launchProxied(payload);
      if (res && res.ok) {
        toast(res.proxied
          ? ('已通过代理启动（端口 ' + (res.port || pxSt.port || 7890) + '）')
          : '已启动（目标类型不支持代理上下文）', 'ok');
      } else {
        toast((res && res.error) || '启动失败', 'err');
      }
    } catch (_err) {
      toast('启动失败：' + _err.message, 'err');
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
    // 按配置重排侧栏按钮：置顶组在前、置底组在后，组内按 order 升序
    const nav = getSidebarNav();
    const sorted = sortSidebarNav(nav);
    // 第一个置底且可见的项负责「顶开」底部区域（margin-top: auto）
    const firstBottom = sorted.find((i) => i.position === 'bottom' && i.visible);
    const firstBottomId = firstBottom ? firstBottom.id : null;
    sorted.forEach((item) => {
      const btn = $('btn-' + item.id);
      if (!btn) return;
      btn.classList.toggle('side-foot', item.id === firstBottomId);
      el.sidebar.appendChild(btn); // 按排序重新挂到侧栏末尾（移动现有节点，事件监听保留）
    });

    // 侧栏「快速启动」：仅在宫格页（非设置、非浏览器、非代理）高亮
    const btnQuick = $('btn-quickstart');
    if (btnQuick) {
      const q = nav.find((n) => n.id === 'quickstart');
      btnQuick.classList.toggle('hidden', q ? !q.visible : false);
      btnQuick.classList.toggle('active', !ui.settingsOpen && !ui.browserOpen && !ui.telegramOpen && !ui.proxyOpen);
    }

    // 侧栏「浏览器」：浏览器视图打开时高亮；未启用时隐藏
    const btnBrowser = $('btn-browser');
    if (btnBrowser) {
      const b = nav.find((n) => n.id === 'browser');
      const enabled = !(state.settings && state.settings.browser && state.settings.browser.enabled === false);
      btnBrowser.classList.toggle('hidden', (b ? !b.visible : false) || !enabled);
      btnBrowser.classList.toggle('active', ui.browserOpen);
    }

    // 侧栏「代理」：代理页打开时高亮；配置隐藏时不显示
    const btnProxy = $('btn-proxy');
    if (btnProxy) {
      const p = nav.find((n) => n.id === 'proxy');
      btnProxy.classList.toggle('hidden', p ? !p.visible : false);
      btnProxy.classList.toggle('active', ui.proxyOpen);
    }

    // 侧栏「Telegram」：Telegram 视图打开时高亮；配置隐藏时不显示
    const btnTg = $('btn-telegram');
    if (btnTg) {
      const t = nav.find((n) => n.id === 'telegram');
      btnTg.classList.toggle('hidden', t ? !t.visible : false);
      btnTg.classList.toggle('active', ui.telegramOpen);
    }

    // 设置页 / 浏览器 / Telegram / 代理页占用宫格区域时隐藏分页工具条
    if (el.pageBar) el.pageBar.classList.toggle('hidden', ui.settingsOpen || ui.browserOpen || ui.telegramOpen || ui.proxyOpen);

    // 侧栏「设置」：高亮；配置隐藏时不显示
    const btnSettings = $('btn-settings');
    if (btnSettings) {
      const sg = nav.find((n) => n.id === 'settings');
      btnSettings.classList.toggle('hidden', sg ? !sg.visible : false);
      btnSettings.classList.toggle('active', ui.settingsOpen);
    }

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
    const wasProxy = ui.proxyOpen;
    ui.settingsOpen = false;
    if (wasProxy) { ui.proxyOpen = false; stopProxyPoll(); }
    // 从搜索结果页切到真实页：先退出搜索，再切换
    const wasSearch = exitSearch(true);
    if (id === state.activePage) {
      if (wasSearch || wasSettings || wasProxy) render();
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
      pxCanProxyLaunch() && item.target
        ? { label: '通过代理启动', hint: '(需开启自身代理)', action: () => launchItemProxied(item) }
        : { sep: true },
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
      pxCanProxyLaunch() && item.target
        ? { label: '通过代理启动', hint: '(需开启自身代理)', action: () => launchItemProxied(item) }
        : null,
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

  // 通用网址打开选择：内置浏览器 / 外部浏览器
  function openAboutLinkDialog(url) {
    const safeUrl = String(url || '').replace(/[<>"&]/g, (c) => ({'<':'&lt;','>':'&gt;','"':'&quot;','&':'&amp;'}[c]));
    openDialog({
      title: '打开链接',
      body: '<div class="hintline" style="color:var(--text);font-size:13px;margin:4px 0 8px">'
        + '<b style="color:#5b9dff">' + safeUrl + '</b></div>'
        + '<div style="color:var(--dim-2);font-size:12px">选择打开方式</div>',
      buttons: [
        { label: '内置浏览器', primary: true, onClick: () => { openBrowser(url); } },
        { label: '外部浏览器', onClick: () => { api.launch({ target: url }); } },
        { label: '取消', ghost: true },
      ],
    });
  }

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

  // 输入对话框（替代 prompt）
  function inputDialog(title, placeholder, defaultVal, onOk) {
    openDialog({
      title: title || '输入',
      body: '<input class="input" id="dlg-input" type="text" placeholder="' + (placeholder || '') + '" value="' + String(defaultVal || '').replace(/"/g, '&quot;') + '" style="width:100%;box-sizing:border-box" />',
      buttons: [
        { label: '取消', ghost: true },
        { label: '确定', primary: true, onClick: () => {
            const inp = el.dialogBody.querySelector('#dlg-input');
            const v = inp ? trim(inp.value) : '';
            if (!v) { toast('请输入内容', 'err'); return false; }
            onOk(v); return true;
          } },
      ],
    });
    setTimeout(() => {
      const inp = el.dialogBody.querySelector('#dlg-input');
      if (inp) { inp.focus(); inp.select(); }
    }, 50);
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
            pxCanProxyLaunch() && item.target
              ? { label: '通过代理启动', hint: '(需开启自身代理)', action: () => launchItemProxied(item) }
              : null,
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

    // 标题栏更新提示图标：点击执行更新（下载 / 重启安装）
    const btnUpdate = $('btn-update');
    if (btnUpdate) btnUpdate.addEventListener('click', onUpdateBadgeClick);

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
        const apply = (t) => {
          applyThemeDom(t);
          // 设置页内只同步下拉选中值，不重建页面（重建会让左侧搜索框闪动一下）
          if (ui.settingsOpen) {
            const sel = el.grid.querySelector('#st-theme');
            if (sel) sel.value = state.settings.theme || 'system';
            return;
          }
          render();
        };
        if (api.theme) api.theme.set(source).then(apply).catch(() => apply({ source, dark: !dark }));
        else apply({ source, dark: !dark });
      });
    }

    // 侧栏底部「设置」：进入 / 退出设置页
    $('btn-settings').addEventListener('click', () => {
      if (ui.browserOpen) closeBrowser();
      if (ui.telegramOpen) closeTelegram();
      if (ui.proxyOpen) closeProxy();
      if (ui.settingsOpen) closeSettings();
      else openSettings();
    });

    // 侧栏「Telegram」：左键进入 / 退出；右键弹出 刷新 / 重启 菜单
    const btnTgNav = $('btn-telegram');
    if (btnTgNav) {
      btnTgNav.addEventListener('click', () => {
        if (ui.telegramOpen) closeTelegram();
        else openTelegram();
      });
      btnTgNav.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openTelegramMenu(e.clientX, e.clientY);
      });
    }

    // 侧栏「代理」：进入 / 退出代理管理页
    const btnProxyNav = $('btn-proxy');
    if (btnProxyNav) {
      btnProxyNav.addEventListener('click', () => {
        if (ui.proxyOpen) closeProxy();
        else openProxy();
      });
    }

    // 内核下载进度：原地更新提示文字（不重建整页）
    if (proxyApi && proxyApi.onCoreProgress) {
      proxyApi.onCoreProgress((p) => {
        if (!px.downloading) return;
        px.dlMessage = (p && p.message) || '';
        const msgEl = $('px-dl-msg');
        if (msgEl) msgEl.textContent = px.dlMessage;
        const dlB = $('px-dl-core');
        if (dlB && p && p.stage === 'download') dlB.textContent = '下载中 ' + (p.percent || 0) + '%';
      });
    }

    // 侧栏「快速启动」：从设置页 / 浏览器 / 代理页 / 搜索页回到宫格
    const btnQuick = $('btn-quickstart');
    if (btnQuick) {
      btnQuick.addEventListener('click', () => {
        if (ui.browserOpen) { closeBrowser(); return; }
        if (ui.telegramOpen) { closeTelegram(); return; }
        if (ui.proxyOpen) { closeProxy(); return; }
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

      // 设置页 / 代理页：不弹宫格右键菜单
      if (ui.settingsOpen || ui.proxyOpen) return;

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

      // 正在录制侧边栏快捷键：捕获下一次按键
      if (ui.sidebarShortcutListening) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          ui.sidebarShortcutListening = null;
          updateSettingsPage();
          return;
        }
        // 单独按修饰键不录制
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
        const id = ui.sidebarShortcutListening;
        const nav = getSidebarNav();
        const item = nav.find((n) => n.id === id);
        if (!item) { ui.sidebarShortcutListening = null; return; }
        if (e.key === 'Backspace') {
          // 退格清除快捷键
          item.shortcut = '';
          state.settings.sidebarNav = nav;
          scheduleSave();
          ui.sidebarShortcutListening = null;
          toast('已清除快捷键', 'ok');
          updateSettingsPage();
          return;
        }
        // 冲突检查：与应用快捷键及其它侧边栏项冲突
        const conflictApp = Object.keys(shortcuts).find((k) => shortcuts[k] === str);
        const conflictSide = nav.find((n) => n.id !== id && n.shortcut === str);
        if (conflictApp || conflictSide) {
          const cdef = conflictApp ? (SHORTCUT_DEFS.find((d) => d.id === conflictApp) || {}).name : (conflictSide && (SIDEBAR_ITEMS.find((d) => d.id === conflictSide.id) || {}).name);
          toast('该按键已被「' + (cdef || '其它项') + '」占用', 'err');
          return;
        }
        item.shortcut = str;
        state.settings.sidebarNav = nav;
        scheduleSave();
        ui.sidebarShortcutListening = null;
        toast('已设置为 ' + formatShortcut(str), 'ok');
        updateSettingsPage();
        return;
      }

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
        if (ui.settingsOpen) closeSettings();
        if (ui.proxyOpen) { closeProxy(); }
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

      // 侧边栏快捷键（F1~F5 等）：即便在输入框内也生效（F 键不产生文本）
      const sideHit = getSidebarNav().find((n) => n.visible && n.shortcut && n.shortcut === str);
      if (sideHit) {
        e.preventDefault();
        const btn = $('btn-' + sideHit.id);
        if (btn && !btn.classList.contains('hidden')) btn.click();
        return;
      }

      // 以下为可配置的应用级快捷键：输入框内不拦截（交给原生编辑）
      if (typing) return;

      // 删除悬停的应用（宫格 / 文件夹弹窗内均可）
      if (str === shortcuts.delete && !ui.settingsOpen && !ui.searchPage && !ui.proxyOpen) {
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
      if (str === shortcuts.add && el.overlay.classList.contains('hidden') && !ui.settingsOpen && !ui.proxyOpen) {
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
    el.telegram = $('telegram');
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

    // ⚠️ 拖入文件的 dragover 必须在任何 await 之前注册，否则 Electron 会拒绝外部文件拖入（红色禁止图标）
    window.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
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
    async function handleDrop(e) {
      e.preventDefault();
      // 防重入：事件冒泡会先触发 canvas 再触发 window，同一个 drop 只处理一次
      if (e.__workbenchDropHandled) return;
      e.__workbenchDropHandled = true;
      if (ui.settingsOpen || ui.proxyOpen || ui.browserOpen || ui.telegramOpen) return;
      if (ui.searchPage) { toast('搜索结果页不能添加图标，按 Esc 退出搜索后再拖入', 'err'); return; }
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      const cell = e.target.closest && e.target.closest('.cell');
      const key = cell ? cell.dataset.key : (ui.activeCell || firstCellKey());
      clearHighlight();
      if (!key) return;
      const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
      if (!paths.length) {
        if (files.length) toast(isElectron ? '没有读取到文件路径' : '浏览器预览模式无法读取本地文件路径', 'err');
        return;
      }
      const targetCell = cellOf(key, true);
      pushHistory();
      const resolved = await Promise.all(paths.map(async (p) => {
        let target = p;
        if (api.resolveShortcut) {
          try { const info = await api.resolveShortcut(p); if (info && info.target) target = info.target; } catch (_) {}
        }
        return { name: baseName(p), target };
      }));
      resolved.forEach((r) => {
        targetCell.items.push({ id: Grid.newId('i'), name: r.name, target: r.target, args: '', cwd: '', icon: { type: 'auto', value: '' } });
      });
      scheduleSave();
      render();
      requestIcons();
      toast('已添加 ' + resolved.length + ' 个快捷方式', 'ok');
    }
    el.canvas.addEventListener('drop', handleDrop);
    window.addEventListener('drop', handleDrop);

    const saved = await api.loadData();
    state = normalize(saved) || defaults();
    ui.activeCell = firstCellKey();
    el.sidebar.classList.toggle('collapsed', state.settings.sidebar === false);
    const sbBtn = $('btn-sidebar');
    if (sbBtn) sbBtn.title = state.settings.sidebar === false ? '展开侧边栏' : '折叠侧边栏（只显示图标）';

    bindEvents();
    bindBrowserEvents();
    render();
    requestIcons();

    // 贴边自动收起：启动时把设置同步到主进程（主进程 initEdgeSnap 只在 Electron 下生效）
    if (api.edgeSnap && isElectron) api.edgeSnap.set(!!state.settings.edgeSnap).catch(() => {});

    // 标题栏居中展示休息提醒状态（订阅 + 首帧轮询）
    restApi.getStatus().then(paintTbRest).catch(() => {});
    restApi.onStatus(paintTbRest);

    // 代理状态：启动后主动拉一次（autoStart 会在主进程 init() 里异步 startCore，
    // 前端必须显式 getState 才能拿到 running=true，胶囊才会出现）
    refreshProxyState(false);
    // 胶囊需要持续显示当前节点与实时速率：启动常驻轮询（代理未运行时会自动跳过）
    startProxyPillPoll();
    // 同时订阅主进程广播：任何状态变化（autoStart ready、切模式等）都实时刷新
    try {
      api.proxyApi.onState((s) => {
        px.state = s;
        paintProxyPill($('tb-rest'));
        if (ui.proxyOpen) refreshProxyState(false);
      });
    } catch (_) {}

    // 自动更新：订阅主进程状态推送；开关开启时启动后静默检查（发现新版本自动下载）
    if (updatesApi.onState) {
      updatesApi.onState((s) => {
        applyUpdateState(s || {});
        if (s && s.status === 'downloaded') toast('新版本 v' + (s.latestVersion || '') + ' 已下载，重启后安装', 'ok');
      });
    }
    if (state.settings.autoUpdate) runUpdateCheck(true);

    // 主题：读当前配置并订阅系统变化
    applyCurrentTheme();
    if (api.theme) api.theme.onChange((t) => { applyThemeDom(t); if (!ui.settingsOpen) render(); });
    if (api.theme) api.theme.get().then((t) => { applyThemeDom(t); if (!ui.settingsOpen) render(); }).catch(() => {});
    else applyThemeDom({ source: state.settings.theme || 'system', dark: true });

    if (!isElectron) {
      toast('浏览器预览模式：可以体验排版，启动本地程序需用 Electron 运行', 'err');
    }
  }

  boot();
})();

