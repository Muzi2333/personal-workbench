// 生成软件主图标：沿用托盘图标的设计（蓝色圆角方块 + 2x2 白色宫格）
// 输出 assets/icon.png（1024×1024）与 assets/icon.ico（多尺寸，供安装包/任务栏使用）
// 纯 Node 实现，无外部依赖：4×4 超采样抗锯齿 + 手写 PNG / ICO 编码
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
const SS = 4; // 超采样倍数

// 设计稿坐标（以 32 为单位，与 tools/gen-tray-icon.js 完全一致）
const UNIT = 32;
const BG = [0x4c, 0x8d, 0xff];
const CELLS = [
  [7, 7],
  [17, 7],
  [7, 17],
  [17, 17],
];

function inRoundRect(px, py, x0, y0, w, h, rad) {
  if (px < x0 || px >= x0 + w || py < y0 || py >= y0 + h) return false;
  const cx = px < x0 + rad ? x0 + rad : px > x0 + w - rad ? x0 + w - rad : px;
  const cy = py < y0 + rad ? y0 + rad : py > y0 + h - rad ? y0 + h - rad : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= rad * rad;
}

// 返回某点在设计稿坐标系里的颜色（null = 透明）
function sample(px, py) {
  if (!inRoundRect(px, py, 1, 1, UNIT - 2, UNIT - 2, 8)) return null;
  for (const [cx, cy] of CELLS) {
    if (inRoundRect(px, py, cx, cy, 8, 8, 2)) return [255, 255, 255];
  }
  return BG;
}

// 渲染 size×size 的 RGBA 图像（SS 倍超采样后盒式降采样）
function render(size) {
  const out = Buffer.alloc(size * size * 4, 0);
  const k = UNIT / (size * SS); // 像素 → 设计单位
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x * SS + sx + 0.5) * k;
          const py = (y * SS + sy + 0.5) * k;
          const c = sample(px, py);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a === 0) continue;
      const cov = a / 255;
      out[i] = Math.round(r / cov);
      out[i + 1] = Math.round(g / cov);
      out[i + 2] = Math.round(b / cov);
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* ------------------------------ PNG 编码 ------------------------------ */

function crc32(b) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ ICO 编码 ------------------------------ */
// 256 用 PNG 压缩；其余用经典 32 位 DIB（兼容性最好）

function toDib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight（XOR + AND）
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = (size - 1 - y) * size * 4; // 底向上
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  const maskRow = Math.ceil(size / 32) * 4; // 4 字节对齐
  const mask = Buffer.alloc(maskRow * size, 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = rgba[(y * size + x) * 4 + 3];
      if (a === 0) mask[(size - 1 - y) * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  return Buffer.concat([header, xor, mask]);
}

function toIco(images) {
  const count = images.length;
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type = icon
  head.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  images.forEach((img, i) => {
    const o = i * 16;
    dir[o] = img.size >= 256 ? 0 : img.size; // 256 用 0 表示
    dir[o + 1] = img.size >= 256 ? 0 : img.size;
    dir[o + 2] = 0; // color count
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bit count
    dir.writeUInt32LE(img.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += img.data.length;
  });

  return Buffer.concat([head, dir, ...images.map((i) => i.data)]);
}

/* -------------------------------- 输出 -------------------------------- */

fs.mkdirSync(ASSETS, { recursive: true });

const main = toPng(1024, render(1024));
fs.writeFileSync(path.join(ASSETS, 'icon.png'), main);
console.log('assets/icon.png', main.length, 'bytes (1024×1024)');

const sizes = [256, 128, 64, 48, 32, 24, 16];
const images = sizes.map((size) => ({
  size,
  data: size >= 256 ? toPng(size, render(size)) : toDib(size, render(size)),
}));
const ico = toIco(images);
fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);
console.log('assets/icon.ico', ico.length, 'bytes (' + sizes.join('/') + ')');
