// 从 AI 生成的 1024x1024 源图制作应用图标（scripts/make-icon.mjs）：
//   1) 清除右下角 "AI生成" 水印：定位右下角亮色文字，用同行左侧背景色逐行填充
//   2) 箱型采样缩放到 256/128/64/48/32/16
//   3) png-to-ico 拼装 build/icon.ico（BMP 条目，NSIS/makensis 兼容）
//   4) 另存 build/icon.png 与 renderer/icon.png（256px 窗口图标）
// 用法: node scripts/make-icon.mjs <source.png>
// NOTE: 本文件保持 ASCII（ lessons learned: PowerShell 5.1 读 UTF-8 无 BOM 脚本会乱码）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pngToIco from 'png-to-ico';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const srcArg = process.argv[2];
if (!srcArg) {
  console.error('[icon] usage: node scripts/make-icon.mjs <source.png>');
  process.exit(1);
}
const srcPath = resolve(root, srcArg);
if (!existsSync(srcPath)) {
  console.error('[icon] source not found:', srcPath);
  process.exit(1);
}

const bmp = PNG.sync.read(readFileSync(srcPath));
const W = bmp.width, H = bmp.height;
console.log(`[icon] source: ${srcPath} (${W}x${H})`);
const data = bmp.data;

const lum = (i) => data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;

// ---------- 1. remove watermark in the bottom-right corner ----------
// 水印是白色/浅色文字，位于圆角方块 tile 之外的背景区域。
// 扫描窗口避开 tile（tile 右缘约 0.91W、下缘约 0.94H）。
const scanX0 = Math.floor(W * 0.80), scanY0 = Math.floor(H * 0.935);
console.log(`[icon] scan window: x>=${scanX0}, y>=${scanY0}`);
let x0 = W, y0 = H, x1 = -1, y1 = -1;
for (let y = scanY0; y < H; y++) {
  for (let x = scanX0; x < W; x++) {
    const i = (W * y + x) << 2;
    if (lum(i) > 140) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
}

if (x1 < 0) {
  console.log('[icon] no watermark detected, skip cleanup');
} else {
  const pad = 8;
  const fx0 = Math.max(0, x0 - pad), fy0 = Math.max(0, y0 - pad);
  console.log(`[icon] watermark bbox: (${x0},${y0})-(${x1},${y1}), fill from x>=${fx0}, y>=${fy0}`);
  for (let y = fy0; y < H; y++) {
    // 参考色：该行水印左侧最近的背景像素
    const ri = (W * y + Math.max(0, fx0 - 12)) << 2;
    for (let x = fx0; x < W; x++) {
      const i = (W * y + x) << 2;
      data[i] = data[ri]; data[i + 1] = data[ri + 1]; data[i + 2] = data[ri + 2]; data[i + 3] = 255;
    }
  }
}

// ---------- 2. box-sampling resize ----------
function resize(size) {
  const dst = new PNG({ width: size, height: size });
  const sx = W / size, sy = H / size;
  for (let dy = 0; dy < size; dy++) {
    const yy0 = Math.floor(dy * sy), yy1 = Math.min(H, Math.ceil((dy + 1) * sy));
    for (let dx = 0; dx < size; dx++) {
      const xx0 = Math.floor(dx * sx), xx1 = Math.min(W, Math.ceil((dx + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = yy0; y < yy1; y++) {
        for (let x = xx0; x < xx1; x++) {
          const i = (W * y + x) << 2;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++;
        }
      }
      const di = (size * dy + dx) << 2; // 注意：pngjs 的 pos 是 undefined，必须自行按下标写入
      dst.data[di] = r / n; dst.data[di + 1] = g / n; dst.data[di + 2] = b / n; dst.data[di + 3] = a / n;
    }
  }
  return dst;
}

const sizes = [256, 128, 64, 48, 32, 16];
const buffers = sizes.map((s) => PNG.sync.write(resize(s)));

// ---------- 3. pack .ico (BMP entries via png-to-ico) ----------
mkdirSync(join(root, 'build'), { recursive: true });
const icoBuf = await pngToIco(buffers);
writeFileSync(join(root, 'build', 'icon.ico'), icoBuf);
console.log(`[icon] wrote build/icon.ico (${icoBuf.length} bytes, ${sizes.length} sizes)`);

// ---------- 4. 256px window icon ----------
writeFileSync(join(root, 'build', 'icon.png'), buffers[0]);
writeFileSync(join(root, 'renderer', 'icon.png'), buffers[0]);
console.log('[icon] wrote build/icon.png and renderer/icon.png (256px)');
console.log('[icon] done');
