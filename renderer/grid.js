/* 宫格布局引擎：只负责把 state 渲染成 DOM，交互由 app.js 统一处理 */
(function () {
  const EMPTY_PX =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  function newId(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  }

  function cellKey(rowId, colId) {
    return rowId + '|' + colId;
  }

  function getCell(state, key, create) {
    if (!state.cells[key] && create) state.cells[key] = { items: [] };
    return state.cells[key];
  }

  function iconInfo(item, state) {
    const icon = item.icon || {};
    if (icon.type === 'emoji' && icon.value) return { kind: 'emoji', value: icon.value };
    if (icon.type === 'image' && icon.value) return { kind: 'image', value: icon.value };
    if (icon.type === 'file' && icon.value) {
      // 用户指定的图标文件（.ico/.exe/.dll），由主进程提取后走 iconCache
      const fsrc = state.iconCache && state.iconCache[icon.value];
      return { kind: 'file', src: fsrc || null, target: icon.value };
    }
    const src = item.target ? state.iconCache && state.iconCache[item.target] : null;
    return { kind: 'auto', src: src || null, target: item.target || '' };
  }

  // 本地路径 → file:// URL（供 <img> 加载用户自定义图片图标）
  function toFileUrl(p) {
    if (!p) return '';
    if (/^(file:|https?:|data:)/i.test(p)) return p;
    return 'file:///' + String(p).replace(/\\/g, '/');
  }

  // 根据背景色自动选黑色/白色文字，保证可读性
  function contrastColor(hex) {
    const c = (hex || '').replace('#', '');
    if (c.length !== 3 && c.length !== 6) return '#ffffff';
    const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#1a1b1c' : '#ffffff';
  }

  function tile(item, state) {
    const t = document.createElement('div');
    t.className = 'tile';
    const info = iconInfo(item, state);

    if (info.kind === 'emoji') {
      const sp = document.createElement('span');
      sp.className = 'emoji';
      sp.textContent = info.value;
      t.appendChild(sp);
    } else {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.src = info.kind === 'image' ? toFileUrl(info.value) : info.src || EMPTY_PX;
      if (info.target) img.dataset.iconTarget = info.target;
      if (!info.src && (info.kind === 'auto' || info.kind === 'file')) img.classList.add('is-placeholder');
      img.addEventListener('error', () => img.classList.add('is-placeholder'));
      t.appendChild(img);
    }

    if (item.tint) t.style.background = item.tint;
    return t;
  }

  function iconEl(item, state) {
    const el = document.createElement('div');
    el.className = 'icon';
    el.dataset.item = item.id;
    el.appendChild(tile(item, state));

    if (state.settings.showLabels !== false) {
      const lb = document.createElement('span');
      lb.className = 'icon-label';
      lb.textContent = item.name || '';
      el.appendChild(lb);
    }
    return el;
  }

  function folderEl(cell, state) {
    const box = document.createElement('div');
    box.className = 'folder';

    const stack = document.createElement('div');
    stack.className = 'folder-stack';
    const preview = cell.items.slice(0, 4);
    preview.forEach((it) => {
      const mini = document.createElement('div');
      mini.className = 'mini';
      mini.appendChild(tile(it, state));
      stack.appendChild(mini);
    });
    if (cell.items.length < 4) {
      for (let i = cell.items.length; i < 4; i++) {
        const blank = document.createElement('div');
        blank.className = 'mini blank';
        stack.appendChild(blank);
      }
    }

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(cell.items.length);

    box.appendChild(stack);
    box.appendChild(badge);

    const lb = document.createElement('span');
    lb.className = 'folder-label';
    lb.textContent = cell.name || cell.items.length + ' 个应用';
    box.appendChild(lb);
    return box;
  }

  function render(container, page, state) {
    const cols = (page && page.cols) || [];
    const rows = (page && page.rows) || [];
    const gap = (page && page.layout && page.layout.gap) || 10;

    container.innerHTML = '';
    container.style.setProperty('--gap', gap + 'px');
    container.style.setProperty('--icon-size', (state.settings.iconSize || 54) + 'px');

    if (!cols.length || !rows.length) {
      const empty = document.createElement('div');
      empty.className = 'grid-empty';
      empty.textContent = '至少需要一行一列：右键画布空白处，或点右上角「⋯」菜单添加';
      container.style.display = 'block';
      container.appendChild(empty);
      return;
    }
    container.style.display = 'grid';

    const colTpl = cols.map((c) => Math.max(96, c.width || 150) + 'px').join(' ');
    const rowTpl = rows.map((r) => Math.max(96, r.height || 150) + 'px').join(' ');
    container.style.gridTemplateColumns = `var(--head-w) ${colTpl}`;
    container.style.gridTemplateRows = `var(--head-h) ${rowTpl}`;

    // 左上角
    const corner = document.createElement('div');
    corner.className = 'corner';
    corner.style.gridColumn = '1';
    corner.style.gridRow = '1';
    container.appendChild(corner);

    // 列头
    cols.forEach((col, i) => {
      const h = document.createElement('div');
      h.className = 'col-head';
      h.dataset.axis = 'col';
      h.dataset.id = col.id;
      h.style.gridColumn = String(i + 2);
      h.style.gridRow = '1';
      const bg = col.color || '#5b6b7c';
      h.style.background = bg;
      h.style.color = contrastColor(bg);

      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.dataset.grip = 'col';
      grip.title = '拖动调整列顺序';

      const name = document.createElement('span');
      name.className = 'hname';
      name.textContent = col.name || '未命名';

      h.append(grip, name);
      container.appendChild(h);
    });

    // 行头 + 单元格
    rows.forEach((row, j) => {
      const rh = document.createElement('div');
      rh.className = 'row-head';
      rh.dataset.axis = 'row';
      rh.dataset.id = row.id;
      rh.style.gridColumn = '1';
      rh.style.gridRow = String(j + 2);
      const bg = row.color || '#5b6b7c';
      rh.style.background = bg;
      rh.style.color = contrastColor(bg);

      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.dataset.grip = 'row';
      grip.title = '拖动调整行顺序';

      const name = document.createElement('span');
      name.className = 'hname';
      name.textContent = row.name || '未命名';

      rh.append(grip, name);
      container.appendChild(rh);

      cols.forEach((col, i) => {
        const key = cellKey(row.id, col.id);
        const cell = getCell(page, key, false) || { items: [] };
        const c = document.createElement('div');
        c.className = 'cell';
        c.dataset.key = key;
        c.dataset.row = row.id;
        c.dataset.col = col.id;
        c.style.gridColumn = String(i + 2);
        c.style.gridRow = String(j + 2);

        const st = cell.style || {};
        if (st.bg) c.style.background = st.bg;
        if (st.border) c.style.borderColor = st.border;
        if (st.radius != null && st.radius !== '') c.style.borderRadius = Number(st.radius) + 'px';

        const items = cell.items || [];
        if (!items.length) {
          c.classList.add('is-empty');
          const mark = document.createElement('div');
          mark.className = 'empty-mark';
          mark.textContent = cell.name || '+';
          c.appendChild(mark);
        } else if (items.length === 1) {
          c.appendChild(iconEl(items[0], state));
        } else {
          c.appendChild(folderEl(cell, state));
        }

        container.appendChild(c);
      });
    });

    // 标题文字自适应：先缩小字体（最小10px），仍溢出则换行
    requestAnimationFrame(() => {
      container.querySelectorAll('.hname').forEach((el) => {
        el.style.fontSize = '';
        el.style.whiteSpace = 'nowrap';
        el.style.wordBreak = 'normal';
        const parent = el.parentElement;
        const avail = parent ? parent.clientWidth - 16 : el.clientWidth;
        if (avail <= 0) return;
        let fs = 14;
        while (fs > 10 && el.scrollWidth > avail) {
          fs -= 1;
          el.style.fontSize = fs + 'px';
        }
        if (fs <= 10 && el.scrollWidth > avail) {
          el.style.whiteSpace = 'normal';
          el.style.wordBreak = 'break-word';
          el.style.lineHeight = '1.2';
        }
      });
    });
  }

  function cellAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('.cell') : null;
  }

  window.Grid = { newId, cellKey, getCell, render, cellAt, iconInfo, tile, toFileUrl };
})();
