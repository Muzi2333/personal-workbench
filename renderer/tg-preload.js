// Telegram Web K 页面内注入（webview preload）：
// 拦截页面加载的图片/视频/音频，把原始二进制转发给主进程静默保存到下载目录。
// 关键点：
//   1) hook 必须注入「页面主世界」，preload 默认跑在隔离世界，直接改 window 对页面无效；
//   2) Telegram 组装媒体 Blob 时通常不带 MIME 类型，因此靠「嗅探文件头」判断格式；
//   3) 图片按原始尺寸过滤缩略图；视频分两条路：
//      - 普通 blob:/http(s) 直链 → fetch 取字节
//      - MSE（MediaSource）流式播放 → 汇总 appendBuffer 的分片（init + media segments）
(function () {
  'use strict';

  const { ipcRenderer, webFrame } = require('electron');
  console.log('[tg-preload] loaded, interception active (v3)');

  const EXT_BY_MIME = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
    'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav',
  };

  const MIN_SIZE = 10240;   // 过滤头像/贴纸/表情
  const MIN_DIM = 500;      // 图片短边小于该值视为缩略图，不保存

  const seen = new Set(); // 去重：同格式同大小只保存一次
  let savedCount = 0;

  function chatTitle() {
    try {
      const el = document.querySelector('.chat-info .peer-title, .topbar .peer-title, .peer-title');
      return el ? String(el.textContent || '').trim() : '';
    } catch (_) { return ''; }
  }

  // 按文件头判断真实格式（Telegram 的 Blob 常无 type）
  function sniffMime(buf) {
    const b = new Uint8Array(buf);
    if (b.length < 12) return '';
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video/mp4';
    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'video/webm';
    if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg';
    if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'audio/mpeg';
    return '';
  }

  // 统一保存：优先用声明类型，无效则嗅探
  function saveBuffer(buf, declaredMime, sizeHint) {
    try {
      if (!buf) return;
      const size = sizeHint || (buf.byteLength || 0);
      if (size < MIN_SIZE) return;
      const dm = String(declaredMime || '').split(';')[0].trim().toLowerCase();
      let mime = EXT_BY_MIME[dm] ? dm : '';
      if (!mime) mime = sniffMime(buf);
      if (!mime) return;
      const key = mime + ':' + size;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 5000) seen.clear();
      const chat = chatTitle();
      savedCount++;
      console.log('[tg-preload] saving media #' + savedCount, mime, size, 'chat=' + chat);
      ipcRenderer.sendToHost('tg-media', {
        chat: chat,
        ext: EXT_BY_MIME[mime],
        mime: mime,
        size: size,
        data: buf,
      });
    } catch (e) {
      console.log('[tg-preload] saveBuffer error', e && e.message);
    }
  }

  // ── 主世界 → preload 的媒体字节通道 ──
  window.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d || d.__tgMedia !== 1 || !d.data) return;
    console.log('[tg-preload] got media from page, mime="' + (d.mime || '') + '" size=' + d.size);
    saveBuffer(d.data, d.mime, d.size);
  });

  // ── 注入页面主世界：只有主世界里的 hook 才能看到页面的 createObjectURL / img.src ──
  function mainWorldSource() {
    return '(' + function () {
      if (window.__tgMediaHookV3) return;
      window.__tgMediaHookV3 = 1;
      var MIN = 10240;
      var MIN_DIM = 500;      // 短边小于该值的图片 = 缩略图，跳过
      var seen = {};
      var seenCount = 0;

      function post(mime, size, buf) {
        try {
          var key = (mime || '?') + ':' + size;
          if (seen[key]) return;
          seen[key] = 1;
          if (++seenCount > 5000) { seen = {}; seenCount = 0; }
          window.postMessage({ __tgMedia: 1, mime: mime || '', size: size, data: buf }, '*', [buf]);
        } catch (e) {}
      }
      function grab(url, mimeHint) {
        try {
          fetch(url).then(function (r) {
            var ct = ((r.headers.get('content-type') || '').split(';')[0] || '').trim().toLowerCase();
            return r.blob().then(function (b) {
              if (!b || b.size < MIN) return null;
              return b.arrayBuffer().then(function (ab) { post(ct || b.type || mimeHint || '', b.size, ab); });
            });
          }).catch(function () {});
        } catch (e) {}
      }
      function srcOf(el) {
        try { return (el && (el.currentSrc || el.getAttribute('src'))) || ''; } catch (e) { return ''; }
      }

      // 图片：加载完再按尺寸过滤缩略图
      function maybeGrabImage(el) {
        try {
          var url = srcOf(el);
          if (!/^(blob:|https?:)/i.test(url)) return;
          if (el.__tgImgUrl === url) return;
          el.__tgImgUrl = url;
          var check = function () {
            var w = el.naturalWidth || 0, h = el.naturalHeight || 0;
            if (w >= MIN_DIM && h >= MIN_DIM) grab(url);
            else console.log('[tg-preload] skip thumbnail ' + w + 'x' + h);
          };
          if (el.complete && el.naturalWidth) check();
          else el.addEventListener('load', check, { once: true });
        } catch (e) {}
      }
      // 视频：blob / 直链可直接取；MSE 的 blob 取不到，交给下面的分片汇总
      function maybeGrabVideo(el) {
        try {
          var url = srcOf(el);
          if (!/^(blob:|https?:)/i.test(url)) return;
          if (el.__tgVidUrl === url) return;
          el.__tgVidUrl = url;
          var check = function () {
            var w = el.videoWidth || 0, h = el.videoHeight || 0;
            if (w && w < 320 && h < 320) { console.log('[tg-preload] skip small video ' + w + 'x' + h); return; }
            grab(url, 'video/mp4');
          };
          if (el.videoWidth) check();
          else el.addEventListener('loadedmetadata', check, { once: true });
        } catch (e) {}
      }
      function maybeGrabAudio(el) {
        try {
          var url = srcOf(el);
          if (!/^(blob:|https?:)/i.test(url)) return;
          if (el.__tgAudUrl === url) return;
          el.__tgAudUrl = url;
          grab(url, 'audio/mpeg');
        } catch (e) {}
      }
      function attach(el, tag) {
        if (!el) return;
        if (tag === 'img') maybeGrabImage(el);
        else if (tag === 'video') maybeGrabVideo(el);
        else if (tag === 'audio') maybeGrabAudio(el);
      }

      // 1. createObjectURL 创建的 Blob（页面主线程）
      try {
        var oc = URL.createObjectURL;
        URL.createObjectURL = function (obj) {
          try {
            if (obj && typeof obj.size === 'number' && obj.size >= MIN && typeof obj.arrayBuffer === 'function') {
              obj.arrayBuffer().then(function (ab) { post(obj.type || '', obj.size, ab); }).catch(function () {});
            }
          } catch (e) {}
          return oc.apply(URL, arguments);
        };
      } catch (e) {}

      // 2. 媒体元素 .src 赋值
      [['HTMLImageElement', 'img'], ['HTMLVideoElement', 'video'], ['HTMLAudioElement', 'audio']].forEach(function (pair) {
        try {
          var C = window[pair[0]];
          if (!C || !C.prototype) return;
          var d = Object.getOwnPropertyDescriptor(C.prototype, 'src');
          if (!d || !d.set) return;
          Object.defineProperty(C.prototype, 'src', {
            configurable: true,
            enumerable: d.enumerable,
            get: d.get,
            set: function (v) {
              var ret = d.set.call(this, v);
              try { attach(this, pair[1]); } catch (e) {}
              return ret;
            },
          });
        } catch (e) {}
      });

      // 3. setAttribute('src', ...)
      try {
        var sa = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (n, v) {
          var ret = sa.apply(this, arguments);
          try {
            if (String(n).toLowerCase() === 'src') {
              var tag = this && this.tagName ? String(this.tagName).toLowerCase() : '';
              if (tag === 'img' || tag === 'video' || tag === 'audio') attach(this, tag);
            }
          } catch (e) {}
          return ret;
        };
      } catch (e) {}

      // 4. MSE（MediaSource）流式视频：汇总 appendBuffer 的分片
      var msRecs = [];
      function concatChunks(chunks, total) {
        var out = new Uint8Array(total), off = 0;
        for (var i = 0; i < chunks.length; i++) {
          var c = new Uint8Array(chunks[i]);
          out.set(c, off);
          off += c.byteLength;
        }
        return out.buffer;
      }
      function flushRecs() {
        var now = Date.now();
        for (var i = 0; i < msRecs.length; i++) {
          var r = msRecs[i];
          if (r.flushed || r.bytes < 200 * 1024) continue;
          if (now - r.last < 1500) continue;   // 还在持续追加，等它停一会
          r.flushed = 1;
          var mime = String(r.mime || '').split(';')[0].trim().toLowerCase() || 'video/mp4';
          var buf = concatChunks(r.chunks, r.bytes);
          r.chunks = [];
          console.log('[tg-preload] MSE media flushed ' + mime + ' size=' + buf.byteLength);
          post(mime, buf.byteLength, buf);
        }
      }
      setInterval(flushRecs, 1000);

      try {
        var addSB = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (mime) {
          var sb = addSB.apply(this, arguments);
          try {
            var rec = { mime: String(mime || ''), chunks: [], bytes: 0, last: Date.now(), flushed: 0 };
            msRecs.push(rec);
            var ab = sb.appendBuffer;
            sb.appendBuffer = function (data) {
              try {
                var copy = null;
                if (data instanceof ArrayBuffer) copy = data.slice(0);
                else if (ArrayBuffer.isView(data)) copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                if (copy && copy.byteLength) {
                  rec.chunks.push(copy);
                  rec.bytes += copy.byteLength;
                  rec.last = Date.now();
                }
              } catch (e) {}
              return ab.apply(sb, arguments);
            };
            sb.addEventListener('updateend', function () { rec.last = Date.now(); });
          } catch (e) {}
          return sb;
        };
      } catch (e) {}

      console.log('[tg-preload] main-world hooks installed (v3)');
    }.toString() + ')();';
  }

  let injected = false;
  function injectMainWorld() {
    if (injected) return;
    try {
      const p = webFrame.executeJavaScript(mainWorldSource());
      injected = true;
      if (p && typeof p.then === 'function') {
        p.then(() => console.log('[tg-preload] main-world injection ok'))
          .catch((e) => console.log('[tg-preload] main-world injection failed', e && e.message));
      } else {
        console.log('[tg-preload] main-world injection ok (sync)');
      }
    } catch (e) {
      console.log('[tg-preload] main-world injection threw', e && e.message);
    }
  }
  injectMainWorld();
  // 页面导航/重载后再注入一次（部分场景 executeJavaScript 早于文档创建）
  window.addEventListener('DOMContentLoaded', injectMainWorld);
  window.addEventListener('load', injectMainWorld);
  setTimeout(injectMainWorld, 1500);

  // ── 兜底：DOM 扫描（preload 世界同样能读 DOM，覆盖 setAttribute/innerHTML 场景） ──
  const scannedUrls = new Set();
  function scanMedia() {
    try {
      const list = document.querySelectorAll('img[src], video[src], audio[src]');
      for (let i = 0; i < list.length; i++) {
        const node = list[i];
        const tag = String(node.tagName || '').toLowerCase();
        const src = node.src || '';
        if (!src || scannedUrls.has(src)) continue;
        if (!/^(blob:|https?:)/i.test(src)) continue;
        // 缩略图 / 小视频直接跳过
        if (tag === 'img' && (node.naturalWidth < MIN_DIM || node.naturalHeight < MIN_DIM)) continue;
        if (tag === 'video' && node.videoWidth && node.videoWidth < 320) continue;
        scannedUrls.add(src);
        fetch(src).then((r) => {
          const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          return r.blob().then((b) => {
            if (!b || b.size < MIN_SIZE) return;
            return b.arrayBuffer().then((ab) => saveBuffer(ab, ct || b.type || '', b.size));
          });
        }).catch(() => {});
      }
      if (scannedUrls.size > 3000) scannedUrls.clear();
    } catch (_) {}
  }
  setTimeout(scanMedia, 1200);
  setInterval(scanMedia, 3000);
  console.log('[tg-preload] scan timer started');
})();
