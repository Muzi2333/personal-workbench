(function () {
  'use strict';

  /* ----------------------------- API（含浏览器兜底） ----------------------------- */

  const FALLBACK_KEY = 'workbench-data-v1';

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
      pathForFile: () => '',
      win: { minimize() {}, toggleMax() {}, close() {} },
      onWindowState() {},
    };
  }

  const api = window.workbench || fallbackApi();
  const isElectron = !!window.workbench;

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

  // 新增行列/页时随机一个标记色（取色板，避免过浅/过暗）
  const COLOR_PALETTE = ['#5b9dff', '#a78bfa', '#4fc08d', '#e3b341', '#f7786b', '#5ec8e0', '#ec7db8', '#7c8aff', '#5ad1a0', '#f59e0b'];
  function randomColor() { return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)]; }

  /* ---------------------------------- 状态 ---------------------------------- */

  let state = null;

  const ui = {
    q: '',
    activeCell: null,
    lastTap: { item: '', t: 0 },
    searchPage: null, // 搜索结果临时页（不落盘）
    settingsOpen: false, // 设置页（侧栏齿轮进入，不落盘）
  };

  const el = {};

  let saveTimer = null;
  let toastTimer = null;

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { api.saveData(state); }, 260);
  }

  /* ---------- 撤销历史（Ctrl+Z） ---------- */
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
      settings: { iconSize: 54, showLabels: true, launch: 'double', sidebar: true, undoLimit: 100, locked: false },
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

    data.settings = Object.assign({ iconSize: 54, showLabels: true, launch: 'double', sidebar: true, undoLimit: 100, locked: false }, data.settings || {});
    data.iconCache = data.iconCache || {};
    // 图标缓存版本：修复打包版 256px 提取脚本缺失（此前一直落 48px 模糊兜底），清缓存重取
    if (data.cacheVer !== 6) {
      data.iconCache = {};
      data.cacheVer = 6;
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
    if (ui.settingsOpen) renderSettingsPage();
    else Grid.render(el.grid, viewPage(), state);
    canvas.scrollLeft = sx;
    canvas.scrollTop = sy;
    updateStatusHint();
    renderSidebar();
  }

  /* --------------------------------- 设置页 --------------------------------- */

  function openSettings() {
    exitSearch(true);
    const s = $('search');
    if (s) s.value = '';
    el.tbSearch.classList.add('hidden');
    $('btn-search').classList.remove('hidden');
    ui.settingsOpen = true;
    render();
  }

  function closeSettings() {
    if (!ui.settingsOpen) return;
    ui.settingsOpen = false;
    render();
  }

  // 设置页：渲染进宫格区域，包含原设置菜单内容（不含 4 个添加按钮）
  function renderSettingsPage() {
    const s = state.settings;
    el.grid.style.display = 'block';
    el.grid.innerHTML = [
      '<div class="settings-page">',
      '  <div class="settings-head">',
      '    <button class="btn" id="st-back">‹ 返回</button>',
      '    <span class="settings-title">设置</span>',
      '  </div>',
      '  <div class="set-group">',
      '    <div class="set-row">',
      '      <div class="set-label">启动方式<span class="set-desc">点击图标时的启动方式</span></div>',
      '      <div class="seg" id="st-launch">',
      '        <button data-v="single"' + (s.launch !== 'double' ? ' class="on"' : '') + '>单击</button>',
      '        <button data-v="double"' + (s.launch === 'double' ? ' class="on"' : '') + '>双击</button>',
      '      </div>',
      '    </div>',
      '    <div class="set-row">',
      '      <div class="set-label">图标名称<span class="set-desc">在图标下方显示名称</span></div>',
      '      <button class="switch' + (s.showLabels ? ' on' : '') + '" id="st-labels" role="switch" title="显示 / 隐藏图标名称"></button>',
      '    </div>',
      '    <div class="set-row">',
      '      <div class="set-label">撤销历史上限<span class="set-desc">最多保留多少条操作记录，0 = 关闭撤销</span></div>',
      '      <input class="input set-num" id="st-undo" type="number" min="0" max="1000" value="' + (s.undoLimit || 0) + '">',
      '    </div>',
      '  </div>',
      '  <div class="set-group">',
      '    <div class="set-group-title">数据</div>',
      '    <div class="set-row btns">',
      '      <button class="btn" id="st-import">导入配置…</button>',
      '      <button class="btn" id="st-export">导出配置…</button>',
      '      <button class="btn" id="st-datadir">打开数据目录</button>',
      '    </div>',
      '  </div>',
      '  <div class="set-group">',
      '    <div class="set-group-title">布局</div>',
      '    <div class="set-row btns">',
      '      <button class="btn danger" id="st-reset">恢复默认布局</button>',
      '    </div>',
      '  </div>',
      '  <div class="set-group">',
      '    <div class="set-group-title">关于</div>',
      '    <div class="about-top">',
      '      <img class="about-ico" src="../assets/icon.png" alt="" />',
      '      <div>',
      '        <div class="about-name">工作台</div>',
      '        <div class="about-desc">Win11 风格的桌面快捷方式宫格</div>',
      '      </div>',
      '    </div>',
      '    <div class="about-rows">',
      '      <div class="about-row"><span>作者</span><b>Muzi_xy</b></div>',
      '      <div class="about-row"><span>版本</span><b id="st-about-ver">—</b></div>',
      '      <div class="about-row"><span>开源地址</span><a href="' + REPO_URL + '" id="st-about-link">github.com/Muzi2333/personal-workbench</a></div>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');

    el.grid.querySelector('#st-back').addEventListener('click', closeSettings);

    el.grid.querySelector('#st-launch').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || b.classList.contains('on')) return;
      pushHistory();
      state.settings.launch = b.dataset.v;
      scheduleSave();
      render();
    });

    el.grid.querySelector('#st-labels').addEventListener('click', () => {
      pushHistory();
      state.settings.showLabels = !state.settings.showLabels;
      scheduleSave();
      render();
    });

    // 撤销上限输入框：宽度跟随内容长度变化（ch 计字符 + 固定 16px 内边距）
    const undoInput = el.grid.querySelector('#st-undo');
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

    el.grid.querySelector('#st-import').addEventListener('click', async () => {
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

    el.grid.querySelector('#st-export').addEventListener('click', async () => {
      const res = await api.exportData(state);
      if (res && res.ok) toast('已导出到 ' + res.path, 'ok');
      else if (res && res.error) toast(res.error, 'err');
    });

    el.grid.querySelector('#st-datadir').addEventListener('click', () => api.openDataDir());

    el.grid.querySelector('#st-reset').addEventListener('click', () => {
      confirmDialog('恢复默认布局？', '当前配置会被替换，可 Ctrl+Z 撤销。', '恢复', () => {
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

    // 关于区块：开源地址点击走系统浏览器；版本号从主进程取
    const aboutLink = el.grid.querySelector('#st-about-link');
    if (aboutLink) {
      aboutLink.addEventListener('click', (e) => {
        e.preventDefault();
        api.launch({ target: REPO_URL });
      });
    }
    const aboutVer = el.grid.querySelector('#st-about-ver');
    if (aboutVer) {
      Promise.resolve(api.appVersion()).then((v) => {
        if (v) aboutVer.textContent = 'v' + v;
      }).catch(() => {});
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
      parts = ['设置', '点左上角「‹ 返回」或按 Esc 回到宫格'];
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
        state.settings.locked ? '布局已锁定，点顶栏锁按钮解锁' : '拖动图标到别的格子即可成组',
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
    if (!res || !res.ok) toast((res && res.error) || '启动失败', 'err');
  }

  function handleIconTap(item) {
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

  // 跨页拖拽：拖拽物悬停到侧边栏页项上时切换到该页，随后可落在该页目标格
  function dragHoverPage(x, y) {
    const node = document.elementFromPoint(x, y);
    const item = node && node.closest ? node.closest('.page-item') : null;
    document.querySelectorAll('.page-item.drop-hover').forEach((n) => {
      if (n !== item) n.classList.remove('drop-hover');
    });
    if (!item || !item.dataset.id) return;
    item.classList.add('drop-hover');
    if (item.dataset.id !== state.activePage) switchPage(item.dataset.id);
  }

  function clearPageHover() {
    document.querySelectorAll('.page-item.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
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
        if (state.settings.locked) { blocked = true; toast('布局已锁定，点顶栏锁按钮解锁后再拖动', 'err'); return; }
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
        if (state.settings.locked) { blocked = true; toast('布局已锁定，点顶栏锁按钮解锁后再拖动', 'err'); return; }
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
    if (!el.pageList) return;
    el.pageList.innerHTML = '';

    // 搜索时在顶部插入一个临时的「搜索结果」页项（不是真实页）
    if (ui.searchPage) {
      const b = document.createElement('button');
      b.className = 'page-item search-item active';
      b.title = '搜索结果：继续在搜索框里输入';
      const name = document.createElement('span');
      name.className = 'page-name';
      name.textContent = '搜索结果 (' + ui.searchPage.hitCount + ')';
      b.appendChild(name);
      b.addEventListener('click', () => { const s = $('search'); if (s) s.focus(); });
      el.pageList.appendChild(b);
    }

    // 设置页打开时：齿轮高亮，页项都不高亮
    const btnSettings = $('btn-settings');
    if (btnSettings) btnSettings.classList.toggle('active', ui.settingsOpen);

    state.pages.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'page-item' + (p.id === state.activePage && !ui.searchPage && !ui.settingsOpen ? ' active' : '');
      b.dataset.id = p.id;
      const name = document.createElement('span');
      name.className = 'page-name';
      name.textContent = p.name;
      b.appendChild(name);
      b.addEventListener('click', () => {
        if (ui.suppressPageClick) { ui.suppressPageClick = false; return; }
        switchPage(p.id);
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openPageMenu(p.id, e.clientX, e.clientY);
      });
      b.addEventListener('pointerdown', (e) => startPageDrag(e, p.id, b));
      el.pageList.appendChild(b);
    });
  }

  function switchPage(id) {
    // 切换页面时退出设置页 / 搜索页
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
      { label: '删除这一页', danger: true, action: () => {
        confirmDialog('删除这一页？', '其中的图标会一起移除。', '删除', () => removePage(id));
      } },
    ]);
  }

  // 页拖拽排序
  function startPageDrag(ev, id, node) {
    if (ev.button !== 0) return;
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
      const nodes = Array.from(el.pageList.querySelectorAll('.page-item'));
      const rects = nodes.map((n) => n.getBoundingClientRect());
      let insert = 0;
      rects.forEach((r) => { if (e.clientY > r.top + r.height / 2) insert++; });
      to = insert;
      const first = rects[0];
      const last = rects[rects.length - 1];
      if (first) {
        const y = insert < rects.length ? rects[insert].top - 4 : last.bottom + 4;
        line.style.cssText = 'display:block;left:' + first.left + 'px;top:' + y + 'px;width:' + first.width + 'px;height:2px;';
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
      item.target && (item.target.indexOf('\\') >= 0 || item.target.indexOf('/') >= 0)
        ? { label: '在资源管理器中显示', action: () => api.reveal(item.target) }
        : { sep: true },
      {
        label: '从这个格子移除',
        danger: true,
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
      item.target && (item.target.indexOf('\\') >= 0 || item.target.indexOf('/') >= 0)
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
        action: () => {
          if (list.length <= 1) { toast('至少保留一' + unit, 'err'); return; }
          confirmDialog('删除这一' + unit + '？', '其中的图标会一起移除。', '删除', () => {
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
        fTarget.value = res.path;
        if (!trim(fName.value)) fName.value = baseName(res.path);
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
    const st = cell.style || {};

    const body = openDialog({
      title: '格子样式',
      body: [
        '<div class="field"><label>格子名称（多图标分组时显示）</label>',
        '<input class="input" id="c-name" placeholder="例如：常用工具" spellcheck="false"></div>',
        '<div class="row-2">',
        '<div class="field"><label>背景色</label><div class="color-field">',
        '<input type="color" id="c-bg-pick" value="' + (hexOrEmpty(st.bg) || '#262829') + '" style="width:34px;height:32px;padding:0;border:1px solid rgba(255,255,255,.1);border-radius:7px;background:transparent;cursor:pointer">',
        '<input class="input" id="c-bg" placeholder="留空为默认" spellcheck="false"></div></div>',
        '<div class="field"><label>边框色</label><div class="color-field">',
        '<input type="color" id="c-border-pick" value="' + (hexOrEmpty(st.border) || '#2b2e30') + '" style="width:34px;height:32px;padding:0;border:1px solid rgba(255,255,255,.1);border-radius:7px;background:transparent;cursor:pointer">',
        '<input class="input" id="c-border" placeholder="留空为默认" spellcheck="false"></div></div>',
        '</div>',
        '<div class="field"><label>圆角（px）</label>',
        '<input class="input" id="c-radius" type="number" min="0" max="40" placeholder="12" spellcheck="false"></div>',
      ].join(''),
      buttons: [
        { label: '取消', ghost: true },
        { label: '保存', primary: true, onClick: () => {
          pushHistory();
          const name = trim(body.querySelector('#c-name').value);
          const bg = hexOrEmpty(body.querySelector('#c-bg').value);
          const border = hexOrEmpty(body.querySelector('#c-border').value);
          const radiusRaw = trim(body.querySelector('#c-radius').value);
          const style = {};
          if (bg) style.bg = bg;
          if (border) style.border = border;
          if (radiusRaw !== '') style.radius = Number(radiusRaw);
          cell.name = name;
          cell.style = style;
          scheduleSave();
          render();
          return true;
        } },
      ],
    });

    body.querySelector('#c-name').value = cell.name || '';
    body.querySelector('#c-bg').value = hexOrEmpty(st.bg) || '';
    body.querySelector('#c-border').value = hexOrEmpty(st.border) || '';
    body.querySelector('#c-radius').value = st.radius != null ? String(st.radius) : '';
    bindColorPair('#c-bg', '#c-bg-pick');
    bindColorPair('#c-border', '#c-border-pick');
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
          if (state.settings.locked) { blocked = true; toast('布局已锁定，点顶栏锁按钮解锁后再拖动', 'err'); return; }
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
        if (!mode) { launchItem(item); return; }

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

        node.addEventListener('pointerdown', (e) => startPopupDrag(e, item, node, grid));
        node.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY, [
            { label: '打开', action: () => launchItem(item) },
            { label: '编辑', action: () => { closeDialog(); openItemDialog(key, item); } },
            { label: '移到其他格子…', action: () => {
              closeDialog();
              toast('拖动这个图标到目标格子即可移动', 'ok');
            } },
            { sep: true },
            { label: '删除', danger: true, action: () => {
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
        if (btn) btn.title = s && s.maximized ? '还原' : '最大化';
      });
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

    // 侧栏底部齿轮：进入 / 退出设置页
    $('btn-settings').addEventListener('click', () => {
      if (ui.settingsOpen) closeSettings();
      else openSettings();
    });

    // 侧边栏：点击持久显隐；隐藏状态下悬停按钮可临时弹出使用
    const btnSidebar = $('btn-sidebar');
    btnSidebar.addEventListener('click', () => {
      const show = state.settings.sidebar === false;
      state.settings.sidebar = show;
      el.sidebar.classList.toggle('hidden', !show);
      ui.tempSidebar = false;
      ui.noTempUntilLeave = !show; // 刚主动隐藏，需移开鼠标再悬停才临时弹出
      scheduleSave();
    });
    btnSidebar.addEventListener('mouseenter', () => {
      if (state.settings.sidebar !== false || ui.noTempUntilLeave) return;
      clearTimeout(ui.tempTimer);
      if (el.sidebar.classList.contains('hidden')) {
        el.sidebar.classList.remove('hidden');
        ui.tempSidebar = true;
      }
    });
    btnSidebar.addEventListener('mouseleave', () => {
      ui.noTempUntilLeave = false;
      scheduleTempHide();
    });
    el.sidebar.addEventListener('mouseenter', () => clearTimeout(ui.tempTimer));
    el.sidebar.addEventListener('mouseleave', scheduleTempHide);

    // 侧边栏空白处右键：增加一页应用（页项自己的右键菜单优先）
    el.sidebar.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.page-item')) return;
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: '增加一页应用', action: () => addPage() },
      ]);
    });

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

    el.grid.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;

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
    el.canvas.addEventListener('drop', (e) => {
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
      paths.forEach((p) => {
        targetCell.items.push({
          id: Grid.newId('i'),
          name: baseName(p),
          target: p,
          args: '',
          cwd: '',
          icon: { type: 'auto', value: '' },
        });
      });
      scheduleSave();
      render();
      requestIcons();
      toast('已添加 ' + paths.length + ' 个快捷方式', 'ok');
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
      if (e.key === 'Escape') {
        closeMenu();
        if (!el.overlay.classList.contains('hidden')) closeDialog();
        // 设置页：Esc 返回宫格
        if (ui.settingsOpen) closeSettings();
        // 搜索框内 Esc 或正处于搜索结果页：清空并退出搜索
        if (document.activeElement === search || ui.searchPage) {
          toggleSearch(false);
          search.blur();
        }
      }
      // 回车确认弹窗：点第一个非「取消」按钮（添加 / 保存 / 确定等）
      if (e.key === 'Enter' && !e.isComposing && !el.overlay.classList.contains('hidden')) {
        // 焦点已经在弹窗底部按钮上时交给原生点击，避免触发两次
        const ae = document.activeElement;
        if (ae && ae.tagName === 'BUTTON' && el.dialogFoot.contains(ae)) return;
        const btn = Array.from(el.dialogFoot.querySelectorAll('.btn')).find((b) => !b.classList.contains('ghost'));
        if (btn) {
          e.preventDefault();
          btn.click();
        }
        return;
      }
      if (e.key === '/' && document.activeElement !== search && el.overlay.classList.contains('hidden') && !ui.settingsOpen) {
        e.preventDefault();
        toggleSearch(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        if (el.overlay.classList.contains('hidden')) {
          e.preventDefault();
          if (ui.settingsOpen) return;
          if (ui.searchPage) { toast('搜索结果页不能添加图标，按 Esc 退出搜索后再试', 'err'); return; }
          openItemDialog(ui.activeCell || firstCellKey(), null);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && e.altKey) return; // 留給系統
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
    });
  }

  // 侧边栏临时显示的延迟收回
  function scheduleTempHide() {
    if (!ui.tempSidebar) return;
    clearTimeout(ui.tempTimer);
    ui.tempTimer = setTimeout(() => {
      if (ui.tempSidebar && !el.sidebar.matches(':hover') && !$('btn-sidebar').matches(':hover')) {
        el.sidebar.classList.add('hidden');
        ui.tempSidebar = false;
      }
    }, 300);
  }

  // 标题栏搜索：搜索按钮展开成输入框；收起时退出搜索并恢复真实页
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
    el.pageList = $('page-list');
    el.tbSearch = $('tb-search');

    const saved = await api.loadData();
    state = normalize(saved) || defaults();
    ui.activeCell = firstCellKey();
    el.sidebar.classList.toggle('hidden', state.settings.sidebar === false);

    bindEvents();
    render();
    requestIcons();

    if (!isElectron) {
      toast('浏览器预览模式：可以体验排版，启动本地程序需用 Electron 运行', 'err');
    }
  }

  boot();
})();
