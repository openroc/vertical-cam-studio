// 打印某一行的灰阶剖面，用来看笔画边缘的抗锯齿过渡
//
//   node scripts/profile-row.mjs <png> <y> <x0> <x1> [<png2> <png3> ...]
//
// 例：node scripts/profile-row.mjs abtest/audit_raw.png 70 95 140 abtest/audit_contrast32.png

import { decodePng } from './png-ascii.mjs';

const file = process.argv[2];
const y = Number(process.argv[3] || 0);
const x0 = Number(process.argv[4] || 0);
const x1 = Number(process.argv[5] || 120);

const files = [];
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] && process.argv[i].endsWith('.png')) files.push(process.argv[i]);
}

const imgs = files.map((f) => ({ f, img: decodePng(f) }));

console.log('row=' + y + '  x=' + x0 + '..' + (x1 - 1));
console.log('x      ' + imgs.map((o) => String(o.f.split(/[\\/]/).pop().replace('.png', '')).slice(-12).padStart(13)).join(''));

for (let x = x0; x < x1; x += 1) {
  let row = String(x).padEnd(7);
  for (const o of imgs) {
    const g = o.img.gray[y * o.img.width + x];
    row += String(g).padStart(13);
  }
  console.log(row);
}
