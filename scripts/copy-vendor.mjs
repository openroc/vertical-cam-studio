// 把 cropperjs 的浏览器端 dist 复制到 renderer/vendor/
// 目的：渲染层禁用 nodeIntegration，无法 require npm 包；用本地 vendor 目录可离线运行，
// 也避免运行时依赖 CDN。
import { mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = join(root, 'node_modules', 'cropperjs', 'dist');
const dest = join(root, 'renderer', 'vendor');

if (!existsSync(src)) {
  console.error('[vendor] 找不到 node_modules/cropperjs/dist，请先执行 npm install');
  process.exit(1);
}

mkdirSync(dest, { recursive: true });

const wanted = ['cropper.min.css', 'cropper.css', 'cropper.min.js', 'cropper.js'];
const files = readdirSync(src);
let copied = 0;

for (const name of wanted) {
  if (files.includes(name)) {
    copyFileSync(join(src, name), join(dest, name));
    copied += 1;
  }
}

if (copied === 0) {
  console.error('[vendor] cropperjs dist 目录里没有可复制的文件：', files.join(', '));
  process.exit(1);
}

console.log(`[vendor] 已复制 ${copied} 个文件到 renderer/vendor/`);
