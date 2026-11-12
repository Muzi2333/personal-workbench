/* 代理内核管理（mihomo / clash-meta）
 * 参考 clash-verge-rev：GUI 通过 RESTful API 与内核通信。
 * 本模块负责：内核下载/启动/停止、订阅下载、生成 config.yaml、
 * 系统代理（注册表）、自身代理（Electron session.setProxy）、虚拟网卡（TUN）。
 */
const { app, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const { spawn, execFile } = require('child_process');

const GROUP_NAME = '工作台代理';
const AUTO_GROUP = '自动选择';
const MIXED_PORT = 7890;
const API_PORT = 9090;
const API_BASE = 'http://127.0.0.1:' + API_PORT;
// 测速候选 URL（按优先级排序，第一个超时会 fallback 到下一个）
const DELAY_URLS = [
  'http://www.gstatic.com/generate_204',
  'https://www.gstatic.com/generate_204',
  'http://connectivitycheck.gstatic.com/generate_204',
  'http://cp.cloudflare.com/generate_204',
];
const DELAY_URL = DELAY_URLS[0];

// mihomo 下载源：GitHub API 取最新版，失败时回退到固定版本；镜像用于 GitHub 不可达时兜底
const MIHOMO_REPO = 'https://github.com/MetaCubeX/mihomo';
const MIHOMO_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';
const MIHOMO_FALLBACK_VERSION = 'v1.18.8';
const GH_MIRRORS = ['https://ghproxy.net/', 'https://gh-proxy.com/'];

function createProxyManager(opts) {
  const getMainWindow = (opts && opts.getMainWindow) || (() => null);

  const dir = () => path.join(app.getPath('userData'), 'mihomo');
  const corePath = () => path.join(dir(), 'mihomo.exe');
  const subDir = () => path.join(dir(), 'subscriptions');
  const stateFile = () => path.join(dir(), 'proxy-state.json');
  const configFile = () => path.join(dir(), 'config.yaml');

  let child = null;          // 内核子进程
  let childExited = false;   // 子进程是否已退出（区分未启动与崩溃）

  /* --------------------------------- 状态持久化 --------------------------------- */

  function defaultState() {
    return {
      subscriptions: [],   // [{ id, name, url, file, updatedAt, info:{upload,download,total,expire} }]
      currentSub: '',      // 当前使用的订阅 id
      mode: 'rule',        // rule / global / direct
      sysProxy: false,
      tunMode: false,
      selfProxy: false,
      autoStart: false,      // 启动工作台时自动启动内核
      autoSelfProxy: false,  // 内核启动后自动开启自身代理
      coreVersion: '',
      nodeIncludeKeywords: [],  // 白名单：节点名命中任一关键字才保留（空=不筛选）
      nodeExcludeKeywords: [],  // 黑名单：节点名命中任一关键字就过滤（优先级高于白名单）
    };
  }

  let st = defaultState();

  function loadState() {
    try {
      if (fs.existsSync(stateFile())) {
        const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
        st = Object.assign(defaultState(), raw || {});
        // 兼容修复：关键字字段必须是字符串数组
        st.nodeIncludeKeywords = toKwArray(st.nodeIncludeKeywords);
        st.nodeExcludeKeywords = toKwArray(st.nodeExcludeKeywords);
      }
    } catch (_) {}
  }

  function saveState() {
    try {
      fs.mkdirSync(dir(), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2), 'utf8');
    } catch (_) {}
    // 每次持久化后广播最新状态给渲染进程（胶囊/UI 刷新靠这个）
    broadcastState();
  }

  loadState();

  function publicState() {
    return {
      ok: true,
      coreInstalled: fs.existsSync(corePath()),
      corePath: corePath(),
      running: !!child,
      coreVersion: st.coreVersion || '',
      subscriptions: st.subscriptions,
      currentSub: st.currentSub,
      mode: st.mode,
      sysProxy: st.sysProxy,
      tunMode: st.tunMode,
      selfProxy: st.selfProxy,
      autoStart: !!st.autoStart,
      autoSelfProxy: !!st.autoSelfProxy,
      port: MIXED_PORT,
      nodeIncludeKeywords: toKwArray(st.nodeIncludeKeywords),
      nodeExcludeKeywords: toKwArray(st.nodeExcludeKeywords),
    };
  }

  // 统一把任意输入规整为「非空字符串数组」，杜绝 NaN / null / 数字混入
  function toKwArray(v) {
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => (typeof x === 'string' ? x : (x == null ? '' : String(x))))
      .map((s) => s.trim())
      .filter((s) => s && s !== 'NaN' && s !== 'undefined' && s !== 'null');
  }

  // 节点名是否应该保留（白/黑名单筛选）
  function shouldKeepNode(name) {
    if (!name) return false;
    const low = String(name).toLowerCase();
    // 黑名单优先：命中即过滤
    for (const k of toKwArray(st.nodeExcludeKeywords)) {
      if (low.includes(k.toLowerCase())) return false;
    }
    // 白名单：非空时必须命中至少一个关键字
    const wl = toKwArray(st.nodeIncludeKeywords);
    if (wl.length) {
      for (const k of wl) {
        if (low.includes(k.toLowerCase())) return true;
      }
      return false;  // 白名单非空但没命中 → 过滤
    }
    return true;  // 无白名单 → 默认保留
  }

  function sendProgress(patch) {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('proxy:core-progress', patch || {});
  }

  // 向渲染进程广播最新代理状态（胶囊/UI 刷新用）
  function broadcastState() {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('proxy:state', publicState());
  }

  /* ------------------------------ 直连 HTTP 下载/请求 ------------------------------ */
  // 用 Node https/http（不受 Electron session 代理影响，保证未代理时也能下载内核与订阅）

  function rawRequest(url, opts, redirectsLeft) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const mod = /^https:/i.test(url) ? https : http;
      const headers = Object.assign({ 'User-Agent': 'clash.meta' }, opts.headers || {});
      const req = mod.get(url, { headers, timeout: opts.timeout || 20000 }, (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && (redirectsLeft == null ? 5 : redirectsLeft) > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          rawRequest(next, opts, (redirectsLeft == null ? 5 : redirectsLeft) - 1).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: code, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
    });
  }

  // 下载文件到磁盘，带进度回调
  function rawDownload(url, dest, onProgress, redirectsLeft) {
    return new Promise((resolve, reject) => {
      const mod = /^https:/i.test(url) ? https : http;
      const req = mod.get(url, { headers: { 'User-Agent': 'workbench' }, timeout: 30000 }, (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && (redirectsLeft == null ? 5 : redirectsLeft) > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          rawDownload(next, dest, onProgress, (redirectsLeft == null ? 5 : redirectsLeft) - 1).then(resolve, reject);
          return;
        }
        if (code !== 200) { res.resume(); reject(new Error('HTTP ' + code)); return; }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (onProgress && total) onProgress(Math.min(99, Math.round(got / total * 100)));
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', reject);
    });
  }

  /* --------------------------------- 内核 REST API --------------------------------- */

  function coreApi(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
      const req = http.request(API_BASE + apiPath, {
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
        timeout: 8000,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
          if ((res.statusCode || 500) >= 400) {
            reject(new Error((data && data.message) || ('HTTP ' + res.statusCode)));
          } else {
            resolve(data);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('内核请求超时')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function waitCoreReady(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 6000);
    while (Date.now() < deadline) {
      try { await coreApi('GET', '/version'); return true; } catch (_) {}
      if (childExited) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /* --------------------------------- 内核下载 --------------------------------- */

  async function resolveAssetUrl() {
    try {
      const res = await rawRequest(MIHOMO_API, { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'workbench' }, timeout: 15000 });
      if (res.status === 200) {
        const json = JSON.parse(res.body.toString('utf8'));
        const assets = (json && json.assets) || [];
        // 优先标准 amd64 zip（排除 compatible / go120 等变体）
        const pick = assets.find((a) => /^mihomo-windows-amd64-v[\d.]+\.zip$/i.test(a.name || ''))
          || assets.find((a) => /windows-amd64.*\.zip$/i.test(a.name || '') && !/compatible/i.test(a.name || ''))
          || assets.find((a) => /windows-amd64.*\.zip$/i.test(a.name || ''));
        if (pick && pick.browser_download_url) return { url: pick.browser_download_url, version: json.tag_name || '' };
      }
    } catch (_) {}
    // API 不可达：回退固定版本
    const v = MIHOMO_FALLBACK_VERSION;
    return { url: MIHOMO_REPO + '/releases/download/' + v + '/mihomo-windows-amd64-' + v + '.zip', version: v };
  }

  async function downloadCore() {
    if (fs.existsSync(corePath())) return { ok: true, already: true };
    fs.mkdirSync(dir(), { recursive: true });

    sendProgress({ stage: 'resolve', percent: 0, message: '正在获取内核版本信息…' });
    const { url, version } = await resolveAssetUrl();

    // 候选 URL：GitHub 直连 + 镜像
    const candidates = [url].concat(GH_MIRRORS.map((m) => m + url));
    const zipPath = path.join(dir(), 'mihomo.zip');
    let downloaded = false;
    let lastErr = null;

    for (let i = 0; i < candidates.length && !downloaded; i++) {
      try {
        sendProgress({ stage: 'download', percent: 0, message: (i ? '使用镜像 ' : '') + '下载内核 ' + (version || '') + '…' });
        await rawDownload(candidates[i], zipPath, (pct) => {
          sendProgress({ stage: 'download', percent: pct, message: '下载内核 ' + pct + '%' });
        });
        downloaded = true;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!downloaded) {
      try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
      return { ok: false, error: '内核下载失败：' + String((lastErr && lastErr.message) || lastErr || '网络不可达') + '。可改用「选择本地内核文件」。' };
    }

    // 解压（Windows 10+ 自带 tar 支持 zip）
    sendProgress({ stage: 'extract', percent: 100, message: '正在解压…' });
    try {
      await new Promise((resolve, reject) => {
        execFile('tar', ['-xf', zipPath, '-C', dir()], { windowsHide: true, timeout: 30000 }, (err) => err ? reject(err) : resolve());
      });
    } catch (err) {
      try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
      return { ok: false, error: '内核解压失败：' + String(err && err.message || err) };
    }

    // 找到解压出的 exe 并重命名为 mihomo.exe
    let extracted = '';
    try {
      extracted = fs.readdirSync(dir()).find((f) => /^mihomo.*\.exe$/i.test(f) && f !== 'mihomo.exe');
    } catch (_) {}
    try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
    if (!extracted) return { ok: false, error: '解压后未找到内核可执行文件' };
    try {
      fs.renameSync(path.join(dir(), extracted), corePath());
    } catch (err) {
      return { ok: false, error: '内核文件整理失败：' + String(err && err.message || err) };
    }

    st.coreVersion = version || '';
    saveState();
    sendProgress({ stage: 'done', percent: 100, message: '内核安装完成' });
    return { ok: true, version: st.coreVersion };
  }

  async function pickCore() {
    const w = getMainWindow();
    const res = await dialog.showOpenDialog(w, {
      title: '选择 mihomo / clash-meta 内核文件',
      properties: ['openFile'],
      filters: [{ name: '内核可执行文件', extensions: ['exe'] }],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    try {
      fs.mkdirSync(dir(), { recursive: true });
      fs.copyFileSync(res.filePaths[0], corePath());
      st.coreVersion = '自定义';
      saveState();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: '复制内核文件失败：' + String(err && err.message || err) };
    }
  }

  /* --------------------------------- 订阅与配置生成 --------------------------------- */

  function yamlQuote(s) { return JSON.stringify(String(s)); }

  function unquote(s) {
    let v = String(s || '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.trim();
  }

  // 从订阅 YAML 中提取 proxies 段原文与节点名列表
  function extractProxies(text) {
    const lines = String(text || '').split(/\r?\n/);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^proxies\s*:/.test(lines[i])) { start = i; break; }
    }
    if (start < 0) return null;
    const block = [lines[start]];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\S/.test(l) && !/^\s*#/.test(l)) break; // 下一个顶层键
      block.push(l);
    }
    const names = [];
    for (const l of block) {
      let m = l.match(/^\s*-\s*name\s*:\s*(.+?)\s*$/);
      if (m) { names.push(unquote(m[1])); continue; }
      m = l.match(/^\s*-\s*\{[^}]*?name\s*:\s*['"]?([^'",}]+?)['"]?\s*[,}]/);
      if (m) names.push(m[1].trim());
    }
    // 去重保序
    const seen = new Set();
    const unique = names.filter((n) => n && !seen.has(n) && seen.add(n));
    return { block: block.join('\n'), names: unique };
  }

  // 从订阅内容解析每个节点的 server / port（用于直连 TCP 测速）
  function parseNodeEndpoints(text) {
    const lines = String(text || '').split(/\r?\n/);
    const start = lines.findIndex((l) => /^proxies\s*:/.test(l));
    if (start < 0) return {};
    const out = {};
    let name = '', server = '', port = '';
    const push = () => {
      if (name && server && Number(port) > 0) out[name] = { server, port: Number(port) };
      name = ''; server = ''; port = '';
    };
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\S/.test(l) && !/^\s*#/.test(l)) break;   // 下一个顶层键，结束
      if (/^\s*-\s/.test(l)) push();                   // 新节点条目（含行内 {name: ...}）
      const mn = l.match(/[{,\s]name\s*:\s*(['"]?)([^'",}]+)\1/);
      if (mn && !name) name = mn[2].trim();
      const ms = l.match(/[{,\s]server\s*:\s*(['"]?)([^'",}]+)\1/);
      if (ms && !server) server = ms[2].trim();
      const mp = l.match(/[{,\s]port\s*:\s*(['"]?)(\d+)\1/);
      if (mp && !port) port = mp[2];
    }
    push();
    return out;
  }

  // 取当前订阅里所有节点的 server:port 映射
  function nodeEndpoints() {
    const sub = st.subscriptions.find((s) => s.id === st.currentSub);
    if (!sub) return {};
    const file = path.join(subDir(), sub.file);
    if (!fs.existsSync(file)) return {};
    try { return parseNodeEndpoints(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
  }

  // 直连 TCP 握手延迟（不经过代理），返回毫秒；失败返回 0
  function tcpPing(server, port, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      let done = false;
      const sock = net.connect({ host: server, port: port });
      const finish = (v) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch (_) {}
        resolve(v);
      };
      sock.setTimeout(timeoutMs || 2000);
      sock.once('connect', () => finish(Date.now() - start));
      sock.once('timeout', () => finish(0));
      sock.once('error', () => finish(0));
    });
  }

  // 并发受限的任务执行器
  async function runLimited(items, limit, worker) {
    const queue = items.slice();
    const workers = [];
    const n = Math.max(1, Math.min(limit, queue.length));
    for (let i = 0; i < n; i++) {
      workers.push((async () => {
        while (queue.length) {
          const item = queue.shift();
          try { await worker(item); } catch (_) {}
        }
      })());
    }
    await Promise.all(workers);
  }

  function buildConfigYaml() {
    const sub = st.subscriptions.find((s) => s.id === st.currentSub);
    if (!sub) return null;
    const file = path.join(subDir(), sub.file);
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8');
    const extracted = extractProxies(text);
    if (!extracted || !extracted.names.length) return null;

    // 应用白/黑名单关键字筛选
    const filteredNames = extracted.names.filter(shouldKeepNode);
    if (!filteredNames.length) return null;

    const list = filteredNames.map((n) => '      - ' + yamlQuote(n));
    return [
      '# 由工作台代理模块生成，请勿手动修改',
      'mixed-port: ' + MIXED_PORT,
      'allow-lan: false',
      'mode: ' + (st.mode || 'rule'),
      'log-level: warning',
      'external-controller: 127.0.0.1:' + API_PORT,
      'unified-delay: true',
      'tcp-concurrent: true',
      'dns:',
      '  enable: true',
      '  ipv6: false',
      '  enhanced-mode: redir-host',
      '  respect-rules: true',
      '  default-nameserver:',
      '    - 223.5.5.5',
      '    - 119.29.29.29',
      '  proxy-server-nameserver:',
      '    - https://dns.alidns.com/dns-query',
      '    - https://doh.pub/dns-query',
      '  nameserver:',
      '    - 223.5.5.5',
      '    - 119.29.29.29',
      '    - https://doh.pub/dns-query',
      '  fallback:',
      '    - https://1.1.1.1/dns-query',
      '    - https://dns.google/dns-query',
      'tun:',
      '  enable: ' + (st.tunMode ? 'true' : 'false'),
      '  stack: system',
      '  auto-route: true',
      '  auto-detect-interface: true',
      '  dns-hijack:',
      '    - any:53',
      extracted.block,
      'proxy-groups:',
      '  - name: ' + yamlQuote(GROUP_NAME),
      '    type: select',
      '    proxies:',
      '      - ' + yamlQuote(AUTO_GROUP),
      '      - DIRECT',
    ].concat(list, [
      '  - name: ' + yamlQuote(AUTO_GROUP),
      '    type: url-test',
      '    url: ' + DELAY_URL,
      '    interval: 300',
      '    tolerance: 50',
      '    proxies:',
    ]).concat(list, [
      'rules:',
      '  - GEOIP,LAN,DIRECT,no-resolve',
      '  - GEOIP,CN,DIRECT',
      '  - MATCH,' + GROUP_NAME,
      '',
    ]).join('\n');
  }

  function writeConfig() {
    const yaml = buildConfigYaml();
    if (!yaml) return false;
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(configFile(), yaml, 'utf8');
    return true;
  }

  function parseSubInfo(headers) {
    const raw = headers && (headers['subscription-userinfo'] || headers['Subscription-Userinfo']);
    if (!raw) return null;
    const info = {};
    String(Array.isArray(raw) ? raw[0] : raw).split(';').forEach((kv) => {
      const m = kv.match(/\s*([a-z]+)\s*=\s*(\d+)\s*/i);
      if (m) info[m[1].toLowerCase()] = Number(m[2]);
    });
    return Object.keys(info).length ? info : null;
  }

  async function downloadSubscription(url) {
    const res = await rawRequest(url, { headers: { 'User-Agent': 'clash.meta' }, timeout: 30000 });
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    const text = res.body.toString('utf8');
    if (!/^proxies\s*:/m.test(text) && !/^proxy-providers\s*:/m.test(text)) {
      throw new Error('订阅内容不是 Clash 配置（请使用 Clash 订阅链接）');
    }
    return { text, info: parseSubInfo(res.headers) };
  }

  async function addSubscription(payload) {
    const url = String((payload && payload.url) || '').trim();
    if (!/^https?:/i.test(url)) return { ok: false, error: '请输入有效的订阅链接（http/https）' };
    let dl;
    try {
      dl = await downloadSubscription(url);
    } catch (err) {
      return { ok: false, error: '订阅下载失败：' + String(err && err.message || err) };
    }
    const id = 'sub-' + Date.now().toString(36);
    const name = String((payload && payload.name) || '').trim() || (() => {
      try { return new URL(url).hostname; } catch (_) { return '订阅 ' + (st.subscriptions.length + 1); }
    })();
    fs.mkdirSync(subDir(), { recursive: true });
    const file = id + '.yaml';
    try {
      fs.writeFileSync(path.join(subDir(), file), dl.text, 'utf8');
    } catch (err) {
      return { ok: false, error: '订阅保存失败：' + String(err && err.message || err) };
    }
    st.subscriptions.push({ id, name, url, file, updatedAt: new Date().toISOString(), info: dl.info });
    if (!st.currentSub) st.currentSub = id;
    saveState();
    // 若内核正在运行且该订阅成为当前订阅，重启内核加载
    if (child && st.currentSub === id) await restartCore();
    return { ok: true, state: publicState() };
  }

  async function refreshSubscription(id) {
    const sub = st.subscriptions.find((s) => s.id === id);
    if (!sub) return { ok: false, error: '订阅不存在' };
    let dl;
    try {
      dl = await downloadSubscription(sub.url);
    } catch (err) {
      return { ok: false, error: '订阅更新失败：' + String(err && err.message || err) };
    }
    try {
      fs.writeFileSync(path.join(subDir(), sub.file), dl.text, 'utf8');
      sub.updatedAt = new Date().toISOString();
      if (dl.info) sub.info = dl.info;
      saveState();
    } catch (err) {
      return { ok: false, error: '订阅保存失败：' + String(err && err.message || err) };
    }
    if (child && st.currentSub === id) await restartCore();
    return { ok: true, state: publicState() };
  }

  async function deleteSubscription(id) {
    const idx = st.subscriptions.findIndex((s) => s.id === id);
    if (idx < 0) return { ok: false, error: '订阅不存在' };
    const sub = st.subscriptions[idx];
    st.subscriptions.splice(idx, 1);
    try { fs.rmSync(path.join(subDir(), sub.file), { force: true }); } catch (_) {}
    if (st.currentSub === id) {
      st.currentSub = st.subscriptions.length ? st.subscriptions[0].id : '';
      if (child) {
        if (st.currentSub && writeConfig()) await restartCore();
        else await stopCore();
      }
    }
    saveState();
    return { ok: true, state: publicState() };
  }

  async function useSubscription(id) {
    const sub = st.subscriptions.find((s) => s.id === id);
    if (!sub) return { ok: false, error: '订阅不存在' };
    st.currentSub = id;
    saveState();
    if (child) await restartCore();
    return { ok: true, state: publicState() };
  }

  /* --------------------------------- 内核启动/停止 --------------------------------- */

  async function startCore() {
    if (child) return { ok: true, already: true };
    if (!fs.existsSync(corePath())) return { ok: false, error: '代理内核未安装，请先下载或选择内核文件' };
    if (!st.currentSub) return { ok: false, error: '请先添加并选择一个订阅' };
    if (!writeConfig()) return { ok: false, error: '配置生成失败：当前订阅缺少可用节点' };

    childExited = false;
    let stderrTail = '';
    try {
      child = spawn(corePath(), ['-d', dir(), '-f', configFile()], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      child = null;
      return { ok: false, error: '内核启动失败：' + String(err && err.message || err) };
    }
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-600); });
    child.on('error', () => { child = null; });
    child.on('exit', () => { child = null; childExited = true; });

    const ready = await waitCoreReady(8000);
    if (!ready) {
      const tail = stderrTail.trim().split(/\r?\n/).slice(-2).join('；');
      try { if (child) child.kill(); } catch (_) {}
      child = null;
      const hint = st.tunMode ? '（虚拟网卡模式需要以管理员身份运行工作台）' : '';
      return { ok: false, error: ('内核启动失败' + hint) + (tail ? '：' + tail : '') };
    }

    // 内核起来后同步一次运行模式（配置文件里已写入，双保险）
    try { await coreApi('PATCH', '/configs', { mode: st.mode || 'rule' }); } catch (_) {}
    // 内核起来了，广播一次（running=true）
    broadcastState();
    // 若开启了"自动开启自身代理"，则自动设置 session 代理（含内嵌浏览器的持久化 session）
    if (st.autoSelfProxy) {
      try {
        await applySessionProxy(true);
        st.selfProxy = true;
        saveState();
      } catch (_) {}
    }
    return { ok: true, state: publicState() };
  }

  async function stopCore() {
    if (child) {
      const c = child;
      child = null;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        c.once('exit', finish);
        setTimeout(finish, 3000);
        try { c.kill(); } catch (_) { finish(); }
      });
    }
    broadcastState();
    return { ok: true, state: publicState() };
  }

  async function restartCore() {
    await stopCore();
    return startCore();
  }

  /* --------------------------------- 系统代理 --------------------------------- */

  const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

  function reg(args) {
    return new Promise((resolve, reject) => {
      execFile('reg', args, { windowsHide: true, timeout: 8000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message || err).trim()));
        else resolve();
      });
    });
  }

  async function setSysProxy(on) {
    if (on && !child) return { ok: false, error: '内核未运行，请先启动内核' };
    try {
      if (on) {
        await reg(['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
        await reg(['add', REG_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', '127.0.0.1:' + MIXED_PORT, '/f']);
        await reg(['add', REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>', '/f']);
      } else {
        await reg(['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
      }
      st.sysProxy = !!on;
      saveState();
      return { ok: true, state: publicState() };
    } catch (err) {
      return { ok: false, error: '系统代理设置失败：' + String(err && err.message || err) };
    }
  }

  /* --------------------------------- 自身代理 --------------------------------- */
  // 只代理本工作台。注意：内嵌浏览器的 webview 用 partition="persist:workbench"，
  // 是独立持久化 session（不是 defaultSession），必须单独 setProxy 才生效。
  // proxyRules 值不允许带 scheme（socks=socks5://... 会导致整条规则解析失败 → 直连）。

  const SELF_PROXY_SESSIONS = ['default', 'persist:workbench', 'persist:telegram'];

  async function applySessionProxy(on) {
    for (const key of SELF_PROXY_SESSIONS) {
      const ses = key === 'default' ? session.defaultSession : session.fromPartition(key);
      if (!ses) continue;
      try {
        await ses.setProxy(on ? {
          proxyRules: '127.0.0.1:' + MIXED_PORT,
          proxyBypassRules: 'localhost;127.0.0.1;<local>',
        } : {});
      } catch (_) {}
    }
  }

  async function setSelfProxy(on) {
    if (on && !child) return { ok: false, error: '内核未运行，请先启动内核' };
    try {
      await applySessionProxy(on);
      st.selfProxy = !!on;
      saveState();
      return { ok: true, state: publicState() };
    } catch (err) {
      return { ok: false, error: '自身代理设置失败：' + String(err && err.message || err) };
    }
  }

  /* --------------------------------- 自动启动内核 --------------------------------- */

  function setAutoStart(on) {
    st.autoStart = !!on;
    saveState();
    return { ok: true, state: publicState() };
  }

  /* ------------------------------ 自动开启自身代理 ------------------------------ */

  function setAutoSelfProxy(on) {
    st.autoSelfProxy = !!on;
    saveState();
    return { ok: true, state: publicState() };
  }

  /* --------------------------------- 虚拟网卡（TUN） --------------------------------- */

  function checkAdmin() {
    return new Promise((resolve) => {
      execFile('net', ['session'], { windowsHide: true, timeout: 6000 }, (err) => resolve(!err));
    });
  }

  async function setTun(on) {
    if (on) {
      if (!child) return { ok: false, error: '内核未运行，请先启动内核' };
      const admin = await checkAdmin();
      // NEED_ADMIN：前端弹出确认框，一键以管理员身份重启并自动开 TUN
      if (!admin) return { ok: false, code: 'NEED_ADMIN', error: '虚拟网卡模式需要管理员权限' };
    }
    st.tunMode = !!on;
    saveState();
    if (child) {
      const r = await restartCore();
      if (!r.ok) {
        st.tunMode = false;
        saveState();
        await startCore().catch(() => {});
        return { ok: false, error: r.error || '虚拟网卡模式启动失败' };
      }
    }
    return { ok: true, state: publicState() };
  }

  /* --------------------------------- 代理模式 / 节点 --------------------------------- */

  async function setMode(mode) {
    if (!['rule', 'global', 'direct'].includes(mode)) return { ok: false, error: '无效的代理模式' };
    st.mode = mode;
    saveState();
    if (child) {
      try { await coreApi('PATCH', '/configs', { mode }); } catch (err) {
        return { ok: false, error: '模式切换失败：' + String(err && err.message || err) };
      }
    }
    return { ok: true, state: publicState() };
  }

  // 设置节点白/黑名单关键字（数组，空数组=不筛选）
  async function setNodeKeywords({ include, exclude }) {
    st.nodeIncludeKeywords = toKwArray(include);
    st.nodeExcludeKeywords = toKwArray(exclude);
    saveState();
    // 内核运行中：重新写配置并重启（因为 mihomo 配置里的 proxies 列表已经变了）
    if (child && writeConfig()) {
      try { await restartCore(); } catch (_) {}
    }
    return { ok: true, state: publicState() };
  }

  async function getProxies() {
    if (!child) return { ok: false, error: '内核未运行' };
    let data;
    try {
      data = await coreApi('GET', '/proxies');
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
    const all = (data && data.proxies) || {};
    const groups = [];
    const nodes = {};
    Object.keys(all).forEach((name) => {
      const p = all[name] || {};
      // 过滤掉不在当前配置里的节点（mihomo 只加载了 filteredNames）
      // 但组（URLTest/Selector等 type 不以 proxy 开头的）要保留显示
      if (Array.isArray(p.all)) {
        // 组：保留，但它的 all 列表也要过滤
        const filteredAll = p.all.filter(shouldKeepNode);
        groups.push({ name, type: p.type || '', now: p.now || '', all: filteredAll, udp: !!p.udp });
      } else {
        // 节点
        if (!shouldKeepNode(name)) return;
        const history = Array.isArray(p.history) ? p.history : [];
        const last = history.length ? history[history.length - 1] : null;
        nodes[name] = { type: p.type || '', delay: last && typeof last.delay === 'number' ? last.delay : 0, udp: !!p.udp };
      }
    });
    // 排序：手动选择组在前，自动测速组其次，其余内置组在后
    const order = (g) => g.name === GROUP_NAME ? 0 : g.type === 'URLTest' ? 1 : 2;
    groups.sort((a, b) => order(a) - order(b));
    // 解析组的 now 字段：如果 now 指向另一个组（URLTest/Selector 嵌套），展开到真正的节点
    // 这样前端显示"工作台代理"当前节点时，能拿到 URLTest 选中的实际节点的延迟
    const groupMap = {};
    groups.forEach((g) => { groupMap[g.name] = g; });
    const resolveNow = (group, depth) => {
      if (!group || depth > 3) return null;
      const nowName = group.now;
      if (!nowName) return null;
      // 如果 now 是个节点名
      if (nodes[nowName]) return { resolvedName: nowName, node: nodes[nowName] };
      // 如果 now 是另一个组名
      const sub = groupMap[nowName];
      if (sub) return resolveNow(sub, depth + 1);
      return { resolvedName: nowName, node: null };
    };
    groups.forEach((g) => {
      const r = resolveNow(g, 0);
      if (r) {
        g.resolvedNow = r.resolvedName;
        if (r.node) g.resolvedNode = r.node;
      }
    });
    return { ok: true, groups, nodes };
  }

  async function selectNode(group, node) {
    if (!child) return { ok: false, error: '内核未运行' };
    try {
      await coreApi('PUT', '/proxies/' + encodeURIComponent(group), { name: node });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: '节点切换失败：' + String(err && err.message || err) };
    }
  }

  async function testDelay(name, mode) {
    // 直连测速：直接对节点服务器做 TCP 握手，不经过代理
    if (mode === 'direct') {
      const ep = nodeEndpoints()[name];
      if (!ep) return { ok: false, error: '未找到节点地址' };
      const d = await tcpPing(ep.server, ep.port, 2000);
      if (d > 0) return { ok: true, delay: d, via: 'tcp' };
      return { ok: false, error: '直连超时' };
    }
    if (!child) return { ok: false, error: '内核未运行' };
    // 先尝试 mihomo /delay API，逐个 URL 试
    for (const url of DELAY_URLS) {
      try {
        const r = await coreApi('GET', '/proxies/' + encodeURIComponent(name) + '/delay?timeout=5000&url=' + encodeURIComponent(url));
        if (r && typeof r.delay === 'number' && r.delay > 0) {
          return { ok: true, delay: r.delay, via: 'api' };
        }
      } catch (_) {}
    }
    // /delay API 全部失败（可能是 fake-ip/DNS bug 导致 Vless/Reality 节点无法测速）
    // fallback: 切换到目标节点，通过混合代理端口发实际 HTTP 请求测速
    try {
      // 获取当前选中的节点以便之后恢复
      let savedGroup = '', savedNode = '';
      try {
        const state = await coreApi('GET', '/proxies');
        const pg = state && state.proxies;
        const keys = Object.keys(pg || {}).filter((k) => pg[k] && pg[k].all && Array.isArray(pg[k].all));
        for (const k of keys) {
          if (pg[k].now && pg[k].now !== 'DIRECT' && pg[k].now !== 'REJECT' && pg[k].now !== name) {
            savedGroup = k; savedNode = pg[k].now; break;
          }
        }
      } catch (_) {}

      // 找到 name 所属的 selector 组
      let groupForNode = GROUP_NAME;
      try {
        const state = await coreApi('GET', '/proxies');
        const pg = state && state.proxies;
        const keys = Object.keys(pg || {}).filter((k) => pg[k] && pg[k].all && Array.isArray(pg[k].all));
        for (const k of keys) {
          if (pg[k].all.includes(name)) { groupForNode = k; break; }
        }
      } catch (_) {}

      // 切换到目标节点
      await coreApi('PUT', '/proxies/' + encodeURIComponent(groupForNode), { name });
      await new Promise((r) => setTimeout(r, 800));

      // 通过代理端口发 HTTP GET 测速
      let bestDelay = 0;
      for (const url of DELAY_URLS) {
        try {
          const u = new URL(url);
          const start = Date.now();
          await new Promise((resolve, reject) => {
            const req = http.request({
              host: '127.0.0.1', port: MIXED_PORT, method: 'GET',
              path: url, timeout: 10000,
              headers: { 'Host': u.host },
            }, (res) => {
              res.resume();
              if (res.statusCode === 204 || res.statusCode === 200) resolve();
              else reject(new Error('HTTP ' + res.statusCode));
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.on('error', reject);
            req.end();
          });
          const elapsed = Date.now() - start;
          if (!bestDelay || elapsed < bestDelay) bestDelay = elapsed;
          break; // 第一个成功就用
        } catch (_) {}
      }

      // 恢复原节点
      if (savedGroup && savedNode) {
        try { await coreApi('PUT', '/proxies/' + encodeURIComponent(savedGroup), { name: savedNode }); } catch (_) {}
      }

      if (bestDelay > 0) return { ok: true, delay: bestDelay, via: 'proxy' };
      return { ok: false, error: '节点连接失败' };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  // 通过代理端口测试指定 URL 的访问延迟（ms）
  async function testDelayUrl(url) {
    if (!child) return { ok: false, error: '内核未运行' };
    try {
      const u = new URL(url);
      const start = Date.now();
      await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port: MIXED_PORT, method: 'GET',
          path: url, timeout: 15000,
          headers: { 'Host': u.host, 'User-Agent': 'Mozilla/5.0' },
        }, (res) => {
          res.resume();
          const code = res.statusCode || 0;
          if (code >= 200 && code < 400) resolve();
          else reject(new Error('HTTP ' + code));
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
        req.end();
      });
      return { ok: true, delay: Date.now() - start };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  // 通过代理查询出口 IP 和地理信息（多 API fallback）
  async function fetchIpInfo() {
    if (!child) return { ok: false, error: '内核未运行' };
    const sources = [
      { url: 'https://ipinfo.io/json', parse: (j) => ({ ip: j.ip, country: j.country, region: j.region, city: j.city, org: j.org, isp: j.asn }) },
      { url: 'https://api.ipify.org?format=json', parse: (j) => ({ ip: j.ip }) },
      { url: 'https://ipapi.co/json/', parse: (j) => ({ ip: j.ip, country: j.country_name, region: j.region, city: j.city, org: j.org, isp: j.org }) },
      { url: 'http://ip-api.com/json/?lang=zh-CN', parse: (j) => j.status === 'success' ? { ip: j.query, country: j.country, region: j.regionName, city: j.city, isp: j.isp, org: j.org } : null },
    ];
    for (const s of sources) {
      try {
        const u = new URL(s.url);
        const res = await new Promise((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1', port: MIXED_PORT, method: 'GET',
            path: s.url, timeout: 8000,
            headers: { 'Host': u.host, 'User-Agent': 'Mozilla/5.0' },
          }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          });
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.on('error', reject);
          req.end();
        });
        if (res.status >= 200 && res.status < 400 && res.body) {
          const json = JSON.parse(res.body);
          const data = s.parse(json);
          if (data && data.ip) return { ok: true, data };
        }
      } catch (_) {}
    }
    return { ok: false, error: '所有 IP 查询接口均失败' };
  }

  // 组测速：mode = 'proxy'（走代理，mihomo /delay）| 'direct'（直连 TCP 握手）
  async function testGroup(group, mode) {
    if (mode === 'direct') return testGroupDirect(group);
    return testGroupProxy(group);
  }

  // 直连测速：并行对组内所有节点服务器做 TCP 握手（2 秒超时，不经过代理）
  async function testGroupDirect(group) {
    const eps = nodeEndpoints();
    let names = [];
    if (child) {
      try {
        const s = await coreApi('GET', '/proxies');
        const g = s && s.proxies && s.proxies[group];
        names = (g && Array.isArray(g.all)) ? g.all : [];
      } catch (_) {}
    }
    if (!names.length) names = Object.keys(eps).filter(shouldKeepNode);
    const targets = names.filter((n) => n !== 'DIRECT' && n !== 'REJECT' && eps[n]);
    if (!targets.length) return { ok: false, error: '未获取到节点地址' };
    const delays = {};
    await runLimited(targets, 32, async (n) => {
      const d = await tcpPing(eps[n].server, eps[n].port, 2000);
      if (d > 0) delays[n] = d;
    });
    return { ok: true, delays };
  }

  // 代理测速：mihomo /group/delay 并行测，缺失节点再并行单测（不切换当前节点）
  async function testGroupProxy(group) {
    if (!child) return { ok: false, error: '内核未运行' };
    const delays = {};
    for (const url of DELAY_URLS) {
      try {
        const r = await coreApi('GET', '/group/' + encodeURIComponent(group) + '/delay?url=' + encodeURIComponent(url) + '&timeout=5000');
        Object.keys(r || {}).forEach((k) => {
          if (typeof r[k] === 'number' && r[k] > 0) delays[k] = r[k];
        });
        if (Object.keys(delays).length) break;
      } catch (_) {}
    }
    let all = [];
    try {
      const s = await coreApi('GET', '/proxies');
      const g = s && s.proxies && s.proxies[group];
      all = (g && Array.isArray(g.all)) ? g.all : [];
    } catch (_) {}
    const missing = all.filter((n) => !delays[n] && n !== 'DIRECT' && n !== 'REJECT');
    if (missing.length) {
      await runLimited(missing, 8, async (n) => {
        for (const url of DELAY_URLS) {
          try {
            const r = await coreApi('GET', '/proxies/' + encodeURIComponent(n) + '/delay?timeout=5000&url=' + encodeURIComponent(url));
            if (r && typeof r.delay === 'number' && r.delay > 0) { delays[n] = r.delay; return; }
          } catch (_) {}
        }
      });
    }
    return { ok: true, delays };
  }

  async function getTraffic() {
    if (!child) return { ok: true, running: false, up: 0, down: 0, count: 0 };
    try {
      const r = await coreApi('GET', '/connections');
      return {
        ok: true,
        running: true,
        up: Number(r.uploadTotal) || 0,
        down: Number(r.downloadTotal) || 0,
        count: Array.isArray(r.connections) ? r.connections.length : 0,
      };
    } catch (_) {
      return { ok: true, running: false, up: 0, down: 0, count: 0 };
    }
  }

  // 轻量状态：当前节点 + 累计流量（供右下角胶囊每 2 秒轮询）
  let liteNodeCache = { name: '', t: 0 };
  async function getLiteStatus() {
    if (!child) return { ok: true, running: false, currentNode: '', up: 0, down: 0, count: 0 };
    const now = Date.now();
    let currentNode = liteNodeCache.name;
    // 节点名缓存 5 秒，避免频繁拉 /proxies
    if (now - liteNodeCache.t > 5000) {
      try {
        const data = await coreApi('GET', '/proxies');
        const all = (data && data.proxies) || {};
        const resolve = (name, depth) => {
          const p = all[name];
          if (!p || depth > 4) return name;
          if (Array.isArray(p.all) && p.now) return resolve(p.now, depth + 1);
          return name;
        };
        const g = all[GROUP_NAME];
        if (g && g.now) {
          currentNode = resolve(g.now, 0);
          liteNodeCache = { name: currentNode, t: now };
        }
      } catch (_) {}
    }
    let up = 0, down = 0, count = 0;
    try {
      const r = await coreApi('GET', '/connections');
      up = Number(r.uploadTotal) || 0;
      down = Number(r.downloadTotal) || 0;
      const conns = Array.isArray(r.connections) ? r.connections : [];
      count = conns.length;
      // 有活跃连接时，用真实链路里的节点名修正（比组 now 更准）
      if (conns.length && conns[0] && Array.isArray(conns[0].chains) && conns[0].chains.length) {
        const real = conns[0].chains[0];
        if (real && real !== currentNode) {
          currentNode = real;
          liteNodeCache = { name: real, t: now };
        }
      }
    } catch (_) {}
    return { ok: true, running: true, currentNode, up, down, count };
  }

  /* --------------------------------- 生命周期 --------------------------------- */

  async function init() {
    // 上次异常退出可能残留系统代理：如果记录为开但内核没在跑，启动时由用户手动开启即可，
    // 这里只把自身代理状态恢复为关闭（session 随进程重建，天然无残留）。
    st.selfProxy = false;
    saveState();
    // 自动启动内核：需已安装内核且已选择订阅
    if (st.autoStart && st.currentSub && fs.existsSync(corePath())) {
      startCore().then((r) => { if (r && r.ok) broadcastState(); }).catch(() => {});
    }
    // 初始广播一次（告诉前端"代理状态已就绪"，即使 running=false）
    broadcastState();
  }

  async function shutdown() {
    // 退出时关闭系统代理，避免系统代理指向已停止的内核导致断网
    if (st.sysProxy) {
      try {
        await reg(['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
        st.sysProxy = false;
        saveState();
      } catch (_) {}
    }
    await stopCore();
  }

  return {
    init,
    shutdown,
    getState: () => publicState(),
    downloadCore,
    pickCore,
    startCore,
    stopCore,
    addSubscription,
    refreshSubscription,
    deleteSubscription,
    useSubscription,
    setSysProxy,
    setSelfProxy,
    setAutoStart,
    setAutoSelfProxy,
    setTun,
    setMode,
    setNodeKeywords,
    getProxies,
    selectNode,
    testDelay,
    testGroup,
    testDelayUrl,
    fetchIpInfo,
    getTraffic,
    getLiteStatus,
  };
}

module.exports = { createProxyManager };
