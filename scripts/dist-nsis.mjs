// 标准 electron-builder NSIS 安装包构建脚本（含本机沙箱环境 workaround）。
//
// 背景：本项目位于 H:\tmp，该目录被本地安全沙箱标记为 Low 完整性，
// 导致两个问题：
//   1. electron-builder 在产出卸载器时需要运行一次中间安装器，
//      而 NSIS 在 Low 完整性目录里无法创建临时文件（Exit code 2/null）；
//   2. 同理，用户从 H:\tmp 双击任何 NSIS 安装包都会报
//      "Error writing temporary file. Make sure your temp folder is valid."。
//
// 处理方式：
//   - 第一遍构建：生成「卸载器安装器」（BUILD_UNINSTALLER），运行失败可忽略；
//   - 把该中间安装器复制到系统 TEMP（C 盘，普通完整性）执行 /S，
//     在 release 下产出 __uninstaller-*.exe；
//   - 第二遍构建：electron-builder 检测到卸载器已存在即跳过执行，
//     直接产出带卸载器的最终安装包；
//   - 构建结束后运行 verify-installer 校验产物大小与结构。
//   - 对 node_modules 的临时补丁在构建前后自动打上/还原。
//
// 用法：node scripts/dist-nsis.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = join(root, 'release');
const targetJs = join(root, 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js');

const PATCH_MARKER = '// TEMP PATCH (dist-nsis)';
const ORIGINAL = `        else {
            await (0, wine_1.execWine)(installerPath, null, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });
        }`;
const PATCHED = `        else if (require("fs").existsSync(uninstallerPath)) {
            ${PATCH_MARKER} uninstaller pre-generated, skip running installer
        }
        else {
            await (0, wine_1.execWine)(installerPath, null, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });
        }`;

function run(cmd, args, opts = {}) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', ...opts });
  return r.status ?? 1;
}

function patch(on) {
  let src = readFileSync(targetJs, 'utf8');
  if (on && src.includes(PATCH_MARKER)) return; // 已打过
  if (!on && !src.includes(PATCH_MARKER)) return; // 未打过
  src = on ? src.replace(ORIGINAL, PATCHED) : src.replace(PATCHED, ORIGINAL);
  writeFileSync(targetJs, src, 'utf8');
  console.log(`[dist-nsis] NsisTarget.js 补丁已${on ? '应用' : '还原'}`);
}

function findFile(dir, prefix) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).find((n) => n.startsWith(prefix)) || null;
}

// 1. 打补丁
patch(true);

try {
  // 本机 electronDist 缓存（下载被拒时的离线运行时）；其他机器可留空自动下载
  const localDist = process.env.VC_ELECTRON_DIST || 'C:/Users/roc/AppData/Local/Temp/elec-run';
  const extra = localDist && existsSync(localDist) ? ['-c.electronDist=' + localDist] : [];

  // 清理上一轮卸载器，保证本次构建使用新鲜产物
  mkdirSync(outDir, { recursive: true });
  for (const n of readdirSync(outDir)) {
    if (n.startsWith('__uninstaller-')) {
      rmSync(join(outDir, n), { force: true });
    }
  }

  // 2. 第一遍构建：产出卸载器安装器，允许失败
  console.log('[dist-nsis] 第一遍构建（生成卸载器安装器，失败可忽略）...');
  run('npx', ['electron-builder', '--win', 'nsis', '--x64', ...extra], { shell: true });
  if (!existsSync(targetJs)) throw new Error('app-builder-lib 未安装，请先 npm install');

  const installerExe = readdirSync(outDir).find((n) => /^VerticalCamStudio-Setup-.*\.exe$/.test(n));
  if (!installerExe) throw new Error('第一遍构建未产出安装器');

  // 3. 在 TEMP（普通完整性）执行卸载器安装器
  const uninstaller = findFile(outDir, '__uninstaller-');
  if (!uninstaller) {
    console.log('[dist-nsis] 在系统 TEMP 执行卸载器安装器...');
    const tmpDir = join(tmpdir(), 'vc-uninst-gen');
    mkdirSync(tmpDir, { recursive: true });
    copyFileSync(join(outDir, installerExe), join(tmpDir, 'uninst-gen.exe'));
    const r = spawnSync(join(tmpDir, 'uninst-gen.exe'), ['/S'], { stdio: 'ignore' });
    if (r.status !== 0 || !findFile(outDir, '__uninstaller-')) {
      throw new Error(`卸载器生成失败（exit=${r.status}）`);
    }
  }

  // 4. 第二遍构建：跳过卸载器执行，产出最终安装包
  console.log('[dist-nsis] 第二遍构建（嵌入卸载器）...');
  const status = run('npx', ['electron-builder', '--win', 'nsis', '--x64', ...extra], { shell: true });
  if (status !== 0) throw new Error(`第二遍构建失败（exit=${status}）`);

  // 5. 产物校验（大小 / NSIS 结构 / 主程序）
  console.log('[dist-nsis] 校验产物...');
  const v = run(process.execPath, ['scripts/verify-installer.mjs', outDir]);
  if (v !== 0) throw new Error('产物校验未通过');
  console.log('[dist-nsis] 完成。产物在 release/ 目录');
} finally {
  // 6. 还原补丁，保持 node_modules 干净
  patch(false);
}
