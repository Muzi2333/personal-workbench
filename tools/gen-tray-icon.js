// 生成 assets/tray.png：32x32 圆角蓝底 + 2x2 白色宫格（无外部依赖，手写 PNG 编码）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 32;
const buf = Buffer.alloc(SIZE * SIZE * 4, 0);

function setPx(x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}

// 圆角矩形判定
function inRoundRect(x, y, x0, y0, w, h, rad) {
  if (x < x0 || x >= x0 + w || y < y0 || y >= y0 + h) return false;
  const cx = x < x0 + rad ? x0 + rad - 1 : x >= x0 + w - rad ? x0 + w - rad : x;
  const cy = y < y0 + rad ? y0 + rad - 1 : y >= y0 + h - rad ? y0 + h - rad : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!inRoundRect(x, y, 1, 1, SIZE - 2, SIZE - 2, 8)) continue; // 透明背景
    // 2x2 白色格子：中心对称，格子 9px，间隙 4px
    const inCell =
      inRoundRect(x, y, 7, 7, 8, 8, 2) || inRoundRect(x, y, 17, 7, 8, 8, 2) ||
      inRoundRect(x, y, 7, 17, 8, 8, 2) || inRoundRect(x, y, 17, 17, 8, 8, 2);
    if (inCell) setPx(x, y, 255, 255, 255, 255);
    else setPx(x, y, 0x4c, 0x8d, 0xff, 255);
  }
}

// PNG 编码
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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets', 'tray.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('written', out, png.length, 'bytes');
