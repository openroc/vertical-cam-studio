// 行内笔画切分：把一行图像按列切成笔画段，判断每段是竖条 / 横条 / 字形
//
//   node scripts/analyze-line.mjs <png> <y0> <y1> [--thr 180]

import { decodePng, inkRows } from './png-ascii.mjs';

const file = process.argv[2];
const y0 = Number(process.argv[3] || 0);
const y1 = Number(process.argv[4] || 100);
const thrArg = process.argv.indexOf('--thr');
const thr = thrArg > 0 ? Number(process.argv[thrArg + 1]) : 180;

const img = decodePng(file);
console.log('图片', file, img.width + 'x' + img.height, '分析行', y0 + '-' + y1);

// 逐列统计墨量
const cols = [];
for (let x = 0; x < img.width; x += 1) {
  let n = 0;
  let top = -1;
  let bottom = -1;
  for (let y = y0; y < y1; y += 1) {
    if (img.gray[y * img.width + x] < thr) {
      n += 1;
      if (top < 0) top = y;
      bottom = y;
    }
  }
  cols.push({ x, n, top, bottom });
}

// 切段：连续有墨的列
const segs = [];
let cur = null;
for (const c of cols) {
  if (c.n > 0) {
    if (!cur) cur = { from: c.x, to: c.x, maxN: 0, top: c.top, bottom: c.bottom };
    cur.to = c.x;
    cur.maxN = Math.max(cur.maxN, c.n);
    cur.top = Math.min(cur.top === -1 ? c.top : cur.top, c.top);
    cur.bottom = Math.max(cur.bottom, c.bottom);
  } else if (cur) {
    segs.push(cur);
    cur = null;
  }
}
if (cur) segs.push(cur);

console.log('\n段  x范围      宽度  高度   形状判定');
for (const s of segs) {
  const w = s.to - s.from + 1;
  const h = s.bottom - s.top + 1;
  const dens = s.maxN / h;
  let kind;
  if (w <= 3 && h >= 12) kind = '竖条 | (满高)';
  else if (h <= 4 && w >= 5) kind = '横条 - (短横)';
  else if (w >= 5 && h >= 8) kind = '字形';
  else kind = '短笔画';
  console.log(
    String(segs.indexOf(s) + 1).padStart(2),
    (s.from + '-' + s.to).padEnd(12),
    String(w).padStart(3),
    String(h).padStart(5),
    '  ' + kind
  );
}

// 竖条的额外检查：顶端/底端是否有"横帽"（bracket 特征）
console.log('\n竖条端点检查（顶端 2 行 / 底端 2 行是否向左右伸出）');
for (const s of segs) {
  const w = s.to - s.from + 1;
  const h = s.bottom - s.top + 1;
  if (!(w <= 3 && h >= 12)) continue;
  const capAt = (row) => {
    let n = 0;
    for (let x = s.from - 3; x < s.from; x += 1) if (img.gray[row * img.width + x] < thr) n += 1;
    for (let x = s.to + 1; x <= s.to + 3; x += 1) if (img.gray[row * img.width + x] < thr) n += 1;
    return n;
  };
  console.log(
    `  x=${s.from}-${s.to}  高${h}  顶帽像素=${capAt(s.top) + capAt(s.top + 1)}  底帽像素=${capAt(s.bottom - 1) + capAt(s.bottom)}`
  );
}
