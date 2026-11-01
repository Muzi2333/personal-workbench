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
      settings: { iconSize: 54, showLabels: true, launch: 'double', sidebar: true, undoLimit: 100 },
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
        height: Math.max(60, Number(r.height) || 80),
      }));
      p.cols = (Array.isArray(p.cols) ? p.cols : []).map((c, i) => ({
        id: c.id || 'c' + (i + 1),
        name: c.name || '列 ' + (i + 1),
        color: c.color || '#5b6b7c',
        width: Math.max(60, Number(c.width) || 80),
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

    data.settings = Object.assign({ iconSize: 54, showLabels: true, launch: 'double', sidebar: true, undoLimit: 100 }, data.settings || {});
    data.iconCache = data.iconCache || {};
    // 图标缓存版本：图标升级为 256px 高清提取，清掉全部旧缓存强制重取
    if (data.cacheVer !== 3) {
      data.iconCache = {};
      data.cacheVer = 3;
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

  function render() {
    const canvas = el.canvas;
    const sx = canvas.scrollLeft;
    const sy = canvas.scrollTop;
    Grid.render(el.grid, curPage(), state);
    canvas.scrollLeft = sx;
    canvas.scrollTop = sy;
    applyFilter();
    updateStatusHint();
    renderSidebar();
  }

  function applyFilter() {
    const q = ui.q.trim().toLowerCase();
    const pageCells = curPage().cells;
    const cells = el.grid.querySelectorAll('.cell');
    cells.forEach((cell) => {
      const key = cell.dataset.key;
      const items = (pageCells[key] && pageCells[key].items) || [];
      if (!q) {
        cell.classList.remove('dim');
        cell.querySelectorAll('.icon, .folder').forEach((n) => { n.style.display = ''; });
        return;
      }
      const hit = items.some((it) => String(it.name || '').toLowerCase().includes(q));
      cell.classList.toggle('dim', !hit);
      if (items.length === 1) {
        const node = cell.querySelector('.icon');
        if (node) node.style.display = hit ? '' : 'none';
      }
    });
  }

  function updateStatusHint() {
    const p = curPage();
    const total = Object.keys(p.cells).reduce((n, k) => n + ((p.cells[k].items || []).length), 0);
    const rows = p.rows.length;
    const cols = p.cols.length;
    el.hint.innerHTML = '';
    [
      rows + ' 行 · ' + cols + ' 列 · ' + total + ' 个图标',
      state.settings.launch === 'double' ? '双击启动' : '单击启动',
      '拖动图标到别的格子即可成组',
      '拖动表头把手可整行/整列移动',
    ].forEach((txt, i) => {
      if (i) {
        const dot = document.createElement('i');
        el.hint.appendChild(dot);
      }
      const span = document.createElement('span');
      span.textContent = txt;
      el.hint.appendChild(span);
    });
  }

  // 网址快捷方式：异步抓取网站 favicon（多个源兜底，第一个加载成功就用）
  function fetchFavicon(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch (_) { return Promise.resolve(null); }
    if (!host) return Promise.resolve(null);
    const candidates = [
      'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64',
      'https://icons.duckduckgo.com/ip3/' + encodeURIComponent(host) + '.ico',
      'https://' + host + '/favicon.ico',
    ];
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
    const pageCells = curPage().cells;
    const urlTargets = [];
    Object.keys(pageCells).forEach((key) => {
      (pageCells[key].items || []).forEach((it) => {
        const type = it.icon && it.icon.type ? it.icon.type : 'auto';
        if (type === 'file') {
          if (it.icon.value && !state.iconCache[it.icon.value]) targets.add(it.icon.value);
          return;
        }
        if (type !== 'auto' || !it.target) return;
        if (state.iconCache[it.target]) return;
        if (/^https?:/i.test(it.target)) urlTargets.push(it.target);
        else targets.add(it.target);
      });
    });

    // 网址：并行抓 favicon
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
    g.className = 'ghost';
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
        moved = true;
        ghost = makeGhost(node);
        if (node) node.classList.add('is-dragging');
      }
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
    let ghost = null;

    const onMove = (e) => {
      if (!moved) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 7) return;
        moved = true;
        ghost = makeGhost(node);
        if (node) node.classList.add('is-dragging');
      }
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
    ev.preventDefault();
    ev.stopPropagation();

    const id = headEl.dataset.id;
    const page = curPage();
    const list = axis === 'row' ? page.rows : page.cols;
    const from = list.findIndex((x) => x.id === id);
    if (from < 0) return;

    const heads = Array.from(el.grid.querySelectorAll(axis === 'row' ? '.row-head' : '.col-head'));
    const line = document.createElement('div');
    line.className = 'drop-line';
    document.body.appendChild(line);
    headEl.classList.add('is-dragging');

    let to = from;

    const onMove = (e) => {
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

    onMove({ clientX: ev.clientX, clientY: ev.clientY });
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
    state.pages.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'page-item' + (p.id === state.activePage ? ' active' : '');
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
    if (id === state.activePage) return;
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

  function openToolbarMenu(x, y) {
    openMenu(x, y, [
      { label: '添加快捷方式', action: () => openItemDialog(ui.activeCell || firstCellKey(), null) },
      { label: '添加一行', action: () => insertRow(curPage().rows.length) },
      { label: '添加一列', action: () => insertCol(curPage().cols.length) },
      { label: '增加一页应用', action: () => addPage() },
      { sep: true },
      { label: state.settings.launch === 'double' ? '启动方式：双击 → 改为单击' : '启动方式：单击 → 改为双击', action: () => {
        pushHistory();
        state.settings.launch = state.settings.launch === 'double' ? 'single' : 'double';
        scheduleSave();
        updateStatusHint();
      } },
      { label: state.settings.showLabels ? '隐藏图标名称' : '显示图标名称', action: () => {
        pushHistory();
        state.settings.showLabels = !state.settings.showLabels;
        scheduleSave();
        render();
      } },
      { label: '撤销历史上限：' + (state.settings.undoLimit || 100) + ' 条', action: () => {
        const body = openDialog({
          title: '撤销历史上限',
          body: '<div class="field"><label>最多保留多少条操作记录（0=关闭撤销）</label><input class="input" id="undo-limit" type="number" min="0" max="1000" spellcheck="false"></div>',
          buttons: [
            { label: '取消', ghost: true },
            { label: '保存', primary: true, onClick: () => {
              const v = Math.max(0, Math.min(1000, Number(body.querySelector('#undo-limit').value) || 0));
              state.settings.undoLimit = v;
              // 裁剪到新上限
              while (history.length > v) history.shift();
              scheduleSave();
              toast('撤销上限已设为 ' + v + ' 条', 'ok');
              return true;
            } },
          ],
        });
        body.querySelector('#undo-limit').value = String(state.settings.undoLimit || 100);
      } },
      { sep: true },
      { label: '导入配置…', action: async () => {
        const res = await api.importData();
        if (!res || !res.ok) {
          if (res && res.error) toast(res.error, 'err');
          return;
        }
        const next = normalize(res.data);
        if (!next) { toast('配置文件格式不正确', 'err'); return; }
        state = next;
        ui.activeCell = firstCellKey();
        scheduleSave();
        render();
        requestIcons();
        toast('配置已导入', 'ok');
      } },
      { label: '导出配置…', action: async () => {
        const res = await api.exportData(state);
        if (res && res.ok) toast('已导出到 ' + res.path, 'ok');
        else if (res && res.error) toast(res.error, 'err');
      } },
      { label: '打开数据目录', action: () => api.openDataDir() },
      { sep: true },
      { label: '恢复默认布局', danger: true, action: () => {
        confirmDialog('恢复默认布局？', '当前配置会被替换，可 Ctrl+Z 撤销。', '恢复', () => {
          pushHistory();
          state = defaults();
          ui.activeCell = firstCellKey();
          scheduleSave();
          render();
          requestIcons();
        });
      } },
    ]);
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

  function openDialog(options) {
    el.dialogTitle.textContent = options.title || '';
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
    el.dialogBody.innerHTML = '';
    el.dialogFoot.innerHTML = '';
  }

  function bindColorPair(hexId, pickerId) {
    const hex = $(hexId);
    const picker = $(pickerId);
    if (!hex || !picker) return;
    picker.addEventListener('input', () => { hex.value = picker.value; });
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
        '<input class="input" id="h-size" type="number" min="60" max="600" spellcheck="false"></div>',
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
            if (isRow) target.height = Math.max(60, size);
            else target.width = Math.max(60, size);
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
          mode = 'reorder';
          ghost = makeGhost(node);
          node.classList.add('is-dragging');
        }
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
      body: '<div class="hintline">单击启动，右键可编辑或删除。</div>',
      buttons: [
        { label: '添加快捷方式', ghost: true, onClick: () => { closeDialog(); openItemDialog(key, null); } },
        { label: '关闭', primary: true },
      ],
    });
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

    // 搜索
    const search = $('search');
    search.addEventListener('input', () => {
      ui.q = search.value;
      applyFilter();
    });

    // 工具栏：图标大小（行高列宽按基准 54px↔80×80 等比联动）
    const size = $('icon-size');
    size.value = String(state.settings.iconSize || 54);
    size.addEventListener('pointerdown', () => pushHistory()); // 一次拖动只记一条历史
    size.addEventListener('input', () => {
      const v = Number(size.value);
      state.settings.iconSize = v;
      el.grid.style.setProperty('--icon-size', v + 'px');
      const rowH = Math.max(60, Math.round(80 * v / 54));
      const colW = Math.max(60, Math.round(80 * v / 54));
      state.pages.forEach((p) => {
        p.rows.forEach((r) => { r.height = rowH; });
        p.cols.forEach((c) => { c.width = colW; });
      });
      scheduleSave();
      render();
    });

    $('btn-menu').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      openToolbarMenu(rect.right - 190, rect.bottom + 6);
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

      const grip = e.target.closest('.grip');
      if (grip) {
        const head = grip.closest('[data-axis]');
        if (head) startHeaderDrag(e, head.dataset.axis, head);
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
      const cell = e.target.closest('.cell');
      if (cell) cell.classList.add('drop-hover');
    });
    el.canvas.addEventListener('dragleave', (e) => {
      const cell = e.target.closest('.cell');
      if (cell) cell.classList.remove('drop-hover');
    });
    el.canvas.addEventListener('drop', (e) => {
      e.preventDefault();
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
        // 搜索框内 Esc：清空并收起为按钮
        if (document.activeElement === search) {
          toggleSearch(false);
          search.blur();
        }
      }
      if (e.key === '/' && document.activeElement !== search && el.overlay.classList.contains('hidden')) {
        e.preventDefault();
        toggleSearch(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        if (el.overlay.classList.contains('hidden')) {
          e.preventDefault();
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

  // 标题栏搜索：搜索按钮展开成输入框，收起时清空过滤
  function toggleSearch(force) {
    const show = force === true ? true : force === false ? false : el.tbSearch.classList.contains('hidden');
    el.tbSearch.classList.toggle('hidden', !show);
    $('btn-search').classList.toggle('hidden', show);
    const search = $('search');
    if (show) {
      setTimeout(() => search.focus(), 20);
    } else if (search.value) {
      search.value = '';
      ui.q = '';
      applyFilter();
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
