// 构建后校验：防止「安装包被截断 / 空文件 / 未真正打包」这类静默失败。
// 历史上踩过的坑：
//   1. 对 NSIS 产物跑 rcedit，90MB 安装包被截断成 51KB；
//   2. release 目录残留旧文件，误把几 KB 的残片当成品分发；
//   3. 构建中途失败，但脚本继续返回 0。
// 用法：node scripts/verify-installer.mjs [输出目录，默认 release]
import { statSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = resolve(process.argv[2] || join(root, 'release'));

const MB = 1024 * 1024;
const errors = [];
const notes = [];

function sizeOf(p) {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}

function sumFiles(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile()) total += Math.max(0, sizeOf(full));
    else if (entry.isDirectory()) total += sumFiles(full);
  }
  return total;
}

// ---------- 1. 检查 NSIS 源脚本本身 ----------
// 手写备用脚本正常在 3~8KB；过小说明被清空/截断，过大说明被误写入二进制。
// 注意：不能放回 build/installer.nsi —— electron-builder 会自动把它当成自定义安装脚本。
const nsiPath = join(root, 'build', 'installer-manual.nsi');
const nsiSize = sizeOf(nsiPath);
if (nsiSize < 0) {
  notes.push('未找到 build/installer-manual.nsi（仅用 electron-builder 标准模板时属正常）');
} else if (nsiSize < 1024) {
  errors.push(`build/installer-manual.nsi 仅 ${nsiSize} 字节，疑似被清空或截断`);
} else if (nsiSize > 200 * 1024) {
  errors.push(`build/installer-manual.nsi 达 ${(nsiSize / 1024).toFixed(0)}KB，疑似被写入二进制内容`);
} else {
  notes.push(`build/installer-manual.nsi 正常：${nsiSize} 字节`);
}

// ---------- 2. 检查安装包 / 便携版产物 ----------
if (!existsSync(outDir)) {
  errors.push(`输出目录不存在：${outDir}`);
} else {
  const exes = readdirSync(outDir)
    .filter((n) => n.toLowerCase().endsWith('.exe'))
    .map((n) => join(outDir, n));

  if (exes.length === 0) {
    errors.push(`输出目录没有 .exe 产物：${outDir}`);
  }

  const unpackedDir = join(outDir, 'win-unpacked');
  const unpackedBytes = sumFiles(unpackedDir);

  for (const exe of exes) {
    const name = basename(exe);
    const size = sizeOf(exe);
    const sizeMB = size / MB;

    if (size < 1 * MB) {
      errors.push(`${name} 仅 ${(Math.max(0, size) / 1024).toFixed(0)}KB，明显被截断`);
      continue;
    }

    // NSIS 产物前 64KB 必然含 Nullsoft stub 标识
    let isNsis = false;
    try {
      const head = readFileSync(exe).subarray(0, 64 * 1024);
      isNsis = head.includes(Buffer.from('Nullsoft'));
    } catch {
      /* 读取失败在下面统一报错 */
    }
    if (!isNsis) {
      errors.push(`${name} 未检测到 NSIS stub 标识，可能不是有效安装包`);
    }

    if (unpackedBytes > 0 && size < unpackedBytes * 0.15) {
      errors.push(
        `${name} 仅 ${sizeMB.toFixed(1)}MB，不足 win-unpacked（${(unpackedBytes / MB).toFixed(0)}MB）的 15%，疑似未打入应用数据`,
      );
    } else {
      notes.push(`${name} 正常：${sizeMB.toFixed(1)}MB（NSIS=${isNsis ? '是' : '否'}）`);
    }
  }

  // ---------- 3. 检查主程序是否随包发布 ----------
  const mainExe = ['垂直摄像头工作室.exe', 'Vertical Cam Studio.exe']
    .map((n) => join(unpackedDir, n))
    .find((p) => existsSync(p));
  if (mainExe) {
    notes.push(`主程序存在：${basename(mainExe)} ${(sizeOf(mainExe) / MB).toFixed(1)}MB`);
  } else {
    notes.push('未找到 win-unpacked 主程序（仅构建安装包时属正常）');
  }
}

if (errors.length > 0) {
  console.error('\n[verify-installer] 构建产物校验失败：');
  for (const e of errors) console.error(`  ✗ ${e}`);
  for (const n of notes) console.error(`  · ${n}`);
  process.exit(1);
}

console.log('[verify-installer] 校验通过');
for (const n of notes) console.log(`  · ${n}`);
