// PNG 解码 + 字符画渲染：用来肉眼"看"白板截图里的笔画结构
//
//   node scripts/png-ascii.mjs <png> [x y w h] [--step N] [--thr N]
//
// 例：node scripts/png-ascii.mjs abtest/audit_raw.png 0 0 400 120 --step 2

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export function decodePng(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error('只支持 8bit，got ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持隔行扫描');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的 colorType ' + colorType);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  let rp = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp];
    rp += 1;
    const row = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }

  // 转灰度
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    if (channels >= 3) {
      gray[i] = 0.299 * out[i * channels] + 0.587 * out[i * channels + 1] + 0.114 * out[i * channels + 2];
    } else {
      gray[i] = out[i * channels];
    }
  }
  return { width, height, gray };
}

/** 找出"墨"（暗像素）的行区间，用来定位文字行 */
export function inkRows(img, thr = 170) {
  const rows = [];
  for (let y = 0; y < img.height; y += 1) {
    let n = 0;
    for (let x = 0; x < img.width; x += 1) if (img.gray[y * img.width + x] < thr) n += 1;
    rows.push(n);
  }
  const bands = [];
  let start = -1;
  for (let y = 0; y < rows.length; y += 1) {
    if (rows[y] > 0) { if (start < 0) start = y; }
    else if (start >= 0) { bands.push({ from: start, to: y - 1 }); start = -1; }
  }
  if (start >= 0) bands.push({ from: start, to: img.height - 1 });
  return { rows, bands };
}

export function asciiArt(img, x0, y0, w, h, { step = 1, thr = 170 } = {}) {
  const lines = [];
  for (let y = y0; y < Math.min(img.height, y0 + h); y += step) {
    let s = '';
    for (let x = x0; x < Math.min(img.width, x0 + w); x += step) {
      const g = img.gray[y * img.width + x];
      s += g < thr * 0.6 ? '#' : g < thr ? '+' : g < thr * 1.25 ? '.' : ' ';
    }
    lines.push(s);
  }
  return lines;
}

if (process.argv[1] && process.argv[1].endsWith('png-ascii.mjs')) {
  const file = process.argv[2];
  const x = Number(process.argv[3] || 0);
  const y = Number(process.argv[4] || 0);
  const w = Number(process.argv[5] || 300);
  const h = Number(process.argv[6] || 80);
  const stepArg = process.argv.indexOf('--step');
  const step = stepArg > 0 ? Number(process.argv[stepArg + 1]) : 1;
  const thrArg = process.argv.indexOf('--thr');
  const thr = thrArg > 0 ? Number(process.argv[thrArg + 1]) : 170;

  const img = decodePng(file);
  console.log('尺寸', img.width + 'x' + img.height);
  const { bands } = inkRows(img);
  console.log('文字行区间:', bands.map((b) => b.from + '-' + b.to).join(' | '));
  console.log();
  const art = asciiArt(img, x, y, w, h, { step, thr });
  art.forEach((l, i) => console.log(String(y + i * step).padStart(4) + ' ' + l));
}
