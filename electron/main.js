'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, desktopCapturer, screen, session, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

// 打包后即使误传 --dev 也不打开 DevTools：--dev 只在未打包源码运行时有效
const IS_DEV = !app.isPackaged && process.argv.includes('--dev');
// 开发工具（--smoke / --abtest / --shapes / --audit）只在「未打包」时可用：
// 打包后这些模式会把产物写进 app.asar 内部，既没意义也会写失败。
const IS_DEV_TOOLS = !app.isPackaged;
const IS_SMOKE = IS_DEV_TOOLS && process.argv.includes('--smoke');
const IS_ABTEST = IS_DEV_TOOLS && process.argv.includes('--abtest');
const IS_SHAPES = IS_DEV_TOOLS && process.argv.includes('--shapes');
const AUDIT_FILE = (() => {
  const i = process.argv.indexOf('--audit');
  if (i < 0 || !IS_DEV_TOOLS) return null;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : null;
})();
const AUDIT_COMPARE = (() => {
  const i = process.argv.indexOf('--compare');
  if (i < 0 || !IS_DEV_TOOLS) return null;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : null;
})();

let mainWindow = null;
let settingsWindow = null;
let settings = null;
// 开发任务进行中时不允许关窗口：否则 window-all-closed 会让整批任务静默中断
let devJobRunning = false;

/** 不需要可见窗口的开发任务（跑批时不该抢用户桌面） */
const HEADLESS_DEV = IS_ABTEST || IS_SHAPES || !!AUDIT_FILE;

/* ------------------------------------------------------------------ */
/* 设置持久化                                                          */
/* ------------------------------------------------------------------ */

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaultSettings() {
  return {
    outputDir: path.join(app.getPath('pictures'), 'VerticalCamStudio'),
    format: 'jpeg', // jpeg | png
    quality: 0.92, // jpeg 质量 0~1
    filenameTemplate: '{prefix}_{timestamp}', // 支持 {prefix} {timestamp} {date} {time} {n}
    prefix: 'shot',
    rotation: 0, // 预览/出图的物理旋转校正：0 | 90 | 180 | 270
    mirror: false,
    autoSaveAfterCapture: false,
    whiteboard: false,
    whiteboardContrast: 1.8,
    binarize: false,
    whiteboardSoft: true,
    exportScale: 'auto',
    lastDeviceId: ''
  };
}

function loadSettings() {
  const base = defaultSettings();
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    // 配置文件同样过一遍校验：手工改坏或旧版本残留的字段不该带病运行
    const clean = Object.assign({}, base);
    for (const key of Object.keys(SETTINGS_VALIDATORS)) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
      const value = SETTINGS_VALIDATORS[key](parsed[key]);
      if (value !== null && value !== undefined) clean[key] = value;
    }
    return clean;
  } catch {
    return base;
  }
}

function persistSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] 写入失败:', err);
  }
}

/* ------------------------------------------------------------------ */
/* UI 使用统计（纯本地，不联网）                                        */
/* ------------------------------------------------------------------ */

function usageFile() {
  return path.join(app.getPath('userData'), 'ui-usage.json');
}

function usageLogFile() {
  return path.join(app.getPath('userData'), 'ui-usage.log');
}

function loadUsage() {
  try {
    const raw = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
    return normalizeUsageData(raw);
  } catch {
    return createUsageData();
  }
}

let usage = null;
let usageTimer = null;
// 明细日志与聚合共用同一个防抖窗口：高频点击时一次写多行，
// 避免每条点击都在主进程事件循环里做同步磁盘 IO（R5-6）
let pendingLogLines = [];

function flushUsage() {
  if (usageTimer) {
    clearTimeout(usageTimer);
    usageTimer = null;
  }
  if (usage) {
    try {
      const file = usageFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(usage, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn('[usage] 聚合统计写入失败:', err.message);
    }
  }
  if (pendingLogLines.length) {
    const file = usageLogFile();
    const lines = pendingLogLines;
    pendingLogLines = [];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
      if (fs.statSync(file).size > 512 * 1024) {
        const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-2000);
        fs.writeFileSync(file, `${kept.join('\n')}\n`, 'utf8');
      }
    } catch (err) {
      console.warn('[usage] 明细日志写入失败:', err.message);
      pendingLogLines = lines.concat(pendingLogLines); // 写失败留到下次 flush 重试
    }
  }
}

/** 明细日志入队，真正落盘由 flushUsage() 统一完成 */
function appendUsageLog(t, id) {
  pendingLogLines.push(JSON.stringify({ t, id }));
}

/* ------------------------------------------------------------------ */
/* 开发工具探针（实现见 dev/probes.js，生产构建不会执行）              */
/* ------------------------------------------------------------------ */

const probes = require('./dev/probes.js').createProbes({
  app,
  BrowserWindow,
  fs,
  path,
  getMainWindow: () => mainWindow,
  flushUsage,
  usageFile,
  usageLogFile
});

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

/** 把主窗口的最大化状态广播给渲染层，同步自定义窗口按钮图标 */
function notifyWindowState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window:state-changed', { maximized: mainWindow.isMaximized() });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    // 去掉系统标题栏（含原生最小化/最大化/关闭），改用顶栏自定义按钮
    frame: false,
    backgroundColor: '#12141a',
    title: '垂直摄像头工作室',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 打包后彻底禁用 DevTools（含 F12 / Ctrl+Shift+I 快捷键）
      devTools: !app.isPackaged,
      spellcheck: false
    }
  });

  // 只在未打包的开发模式给页面加标记，渲染层据此挂载 __wb 探针契约；
  // 生产构建不暴露该契约（最小权限原则）。
  mainWindow.loadFile(
    path.join(__dirname, '..', 'renderer', 'index.html'),
    IS_DEV_TOOLS ? { query: { vcsdev: '1' } } : {}
  );

  // 双击顶栏等路径也会改变最大化状态，统一广播给渲染层
  mainWindow.on('maximize', notifyWindowState);
  mainWindow.on('unmaximize', notifyWindowState);

  // 把渲染层日志转发到主进程 stdout，便于 --smoke 自检时排查
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] 进程崩溃:', JSON.stringify(details));
  });

  mainWindow.once('ready-to-show', () => {
    // --audit/--abtest/--shapes 是批处理任务，隐藏窗口即可，
    // 免得弹出窗口打断正在干活的用户，也免得被误关导致任务中断。
    if (!HEADLESS_DEV) mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

    // 四种开发模式互斥，一次只跑一种（实现已拆到 electron/dev/probes.js）
    if (IS_SMOKE) {
      devJobRunning = true;
      probes.runSmokeTest();
    } else if (IS_ABTEST) {
      devJobRunning = true;
      probes.runAbTest();
    } else if (IS_SHAPES) {
      devJobRunning = true;
      probes.runShapeTest();
    } else if (AUDIT_FILE) {
      devJobRunning = true;
      probes.runAudit(AUDIT_FILE, AUDIT_COMPARE);
    }
  });

  mainWindow.on('close', (e) => {
    if (devJobRunning) {
      e.preventDefault();
      console.log('[window] 开发任务进行中，忽略关闭请求');
      return;
    }
    console.log('[window] close');
  });

  mainWindow.on('closed', () => {
    console.log('[window] closed');
    // 主窗口关闭时一并关掉设置窗口，避免留下孤儿窗口让应用无法退出
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    settingsWindow = null;
    mainWindow = null;
  });

  // 外部链接一律走系统浏览器，但只放行 http/https
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(parsed.toString());
      } else {
        console.warn('[shell] 拒绝打开非 http(s) 链接:', url);
      }
    } catch (err) {
      console.warn('[shell] 非法链接:', url, err.message);
    }
    return { action: 'deny' };
  });
}

/** 打开（或聚焦）独立的设置窗口；设置页与主界面通过 settings:changed 广播保持一致 */
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return { ok: true, created: false };
  }

  settingsWindow = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 480,
    minHeight: 520,
    parent: mainWindow || undefined,
    backgroundColor: '#12141a',
    title: '设置 · 垂直摄像头工作室',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      spellcheck: false
    }
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(
    path.join(__dirname, '..', 'renderer', 'settings.html'),
    IS_DEV_TOOLS ? { query: { vcsdev: '1' } } : {}
  );
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  return { ok: true, created: true };
}

/** 设置变更后通知所有页面，保证主界面与设置窗口的状态不漂移 */
function broadcastSettings() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('settings:changed', settings);
  }
}

app.whenReady().then(() => {
  // 去掉 Electron 默认的 File/Edit/View 菜单栏（Windows/Linux 默认会显示）
  Menu.setApplicationMenu(null);

  settings = loadSettings();
  usage = loadUsage();

  // 允许摄像头权限（渲染层用 getUserMedia），但只对本应用自己的 file:// 页面放行
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const origin = wc && typeof wc.getURL === 'function' ? wc.getURL() : '';
    if (!origin.startsWith('file://')) {
      console.warn('[permission] 拒绝非本地页面的权限请求:', origin, permission);
      callback(false);
      return;
    }
    callback(permission === 'media' || permission === 'display-capture');
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  console.log('[window] all-closed');
  flushUsage();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', flushUsage);

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

// 与渲染层共用同一份纯函数实现（可被 node --test 直接单测）
const {
  sanitizeName,
  renderTemplate,
  normalizeStatId,
  createUsageData,
  normalizeUsageData,
  applyButtonStat
} = require('../renderer/core.js');

function dataUrlToBuffer(dataUrl) {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) throw new Error('非法的图片数据');
  return Buffer.from(match[2], 'base64');
}

/**
 * 独占写入：同名文件自动加 -1 / -2 后缀。
 * 一步 writeFile({ flag: 'wx' }) 完成「占位 + 写入」，避免：
 *   1) existsSync + writeFile 之间的竞态（同名的两次保存）；
 *   2) 先 open('wx') 占位再单独 writeFile 时，写入失败遗留 0 字节文件；
 *   3) close 与 writeFile 之间另一个进程对占位文件的普通写入。
 */
async function writeUniqueFile(dir, baseName, ext, buffer) {
  let candidate = path.join(dir, `${baseName}.${ext}`);
  let i = 1;
  for (;;) {
    try {
      await fsp.writeFile(candidate, buffer, { flag: 'wx' });
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      candidate = path.join(dir, `${baseName}-${i}.${ext}`);
      i += 1;
    }
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:open', () => openSettingsWindow());

/* 自定义标题栏的窗口控制：只能操作主窗口，且只允许这几个固定动作 */
ipcMain.handle('window:state', () => ({
  ok: true,
  maximized: !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized())
}));
ipcMain.handle('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  return { ok: true };
});
ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, maximized: false };
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { ok: true, maximized: mainWindow.isMaximized() };
});
ipcMain.handle('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  return { ok: true };
});

/** UI 按钮埋点：渲染层 fire-and-forget，主进程校验 identifier 后本地落盘 */
ipcMain.on('stats:button', (_e, rawId) => {
  // 计数逻辑全部在 core.js 的纯函数里完成（含原型键排除与坏字段重建），
  // handler 只负责把结果落盘；这样同一套规则可被单测直接覆盖。
  const hit = applyButtonStat(usage, rawId);
  if (!hit) return;

  appendUsageLog(hit.iso, hit.id);

  // 聚合文件 800ms 防抖落盘；退出时 flushUsage() 保证不丢尾部数据
  if (!usageTimer) usageTimer = setTimeout(flushUsage, 800);
});

/** 读取统计快照（供后续做可视化/自检；仅本地 IPC） */
ipcMain.handle('stats:usage', () => JSON.parse(JSON.stringify(usage || createUsageData())));

/**
 * 逐键校验设置值。
 * 渲染层是不可信输入源，任何键都要先过白名单/范围检查，
 * 否则一个坏的 outputDir 就能让保存写到任意位置。
 * 返回 null 表示该值非法（保持原值不变）。
 */
const SETTINGS_VALIDATORS = {
  outputDir: (v) => (typeof v === 'string' && v.trim() && path.isAbsolute(v) ? v : null),
  format: (v) => (v === 'png' || v === 'jpeg' ? v : null),
  quality: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 1 ? v : null),
  filenameTemplate: (v) => (typeof v === 'string' && v.length <= 120 ? v : null),
  prefix: (v) => (typeof v === 'string' && v.length <= 60 ? v : null),
  rotation: (v) => ([0, 90, 180, 270].includes(Number(v)) ? Number(v) : null),
  mirror: (v) => (typeof v === 'boolean' ? v : null),
  autoSaveAfterCapture: (v) => (typeof v === 'boolean' ? v : null),
  whiteboard: (v) => (typeof v === 'boolean' ? v : null),
  whiteboardContrast: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 3.2 ? v : null),
  binarize: (v) => (typeof v === 'boolean' ? v : null),
  whiteboardSoft: (v) => (typeof v === 'boolean' ? v : null),
  exportScale: (v) => {
    if (v === 'auto') return 'auto';
    const n = Number(v);
    return [1, 2, 3].includes(n) ? n : null;
  },
  lastDeviceId: (v) => (typeof v === 'string' && v.length <= 256 ? v : null)
};

ipcMain.handle('settings:patch', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return { settings, rejected: [] };
  const rejected = [];
  let changed = false;
  for (const key of Object.keys(SETTINGS_VALIDATORS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = SETTINGS_VALIDATORS[key](patch[key]);
    if (value === null || value === undefined) {
      // 保留旧值，并明确告诉渲染层「这个键被拒绝了」——
      // 渲染层需要据此把控件拉回权威值，否则界面显示的是没生效的值。
      rejected.push(key);
      continue;
    }
    if (settings[key] !== value) {
      settings[key] = value;
      changed = true;
    }
  }
  if (rejected.length) console.warn('[settings] 拒绝非法取值:', rejected.join(', '));
  // 全被拒绝或提交的就是当前值时不落盘，避免无谓的磁盘写入
  if (changed) {
    persistSettings();
    broadcastSettings();
  }
  return { settings, rejected };
});

ipcMain.handle('dialog:selectFolder', async () => {
  // 窗口已关闭而 IPC 仍在排队时 mainWindow 为 null，显式转 undefined 避免个别版本抛错
  const res = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: '选择保存文件夹',
    defaultPath: settings.outputDir || app.getPath('pictures'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  // 与 settings:patch 共用同一份校验，避免这条路径绕过 outputDir 白名单
  const dir = SETTINGS_VALIDATORS.outputDir(res.filePaths[0]);
  if (!dir) {
    console.warn('[settings] 拒绝非法输出目录:', res.filePaths[0]);
    return null;
  }
  settings.outputDir = dir;
  persistSettings();
  return settings.outputDir;
});

ipcMain.handle('image:save', async (_e, payload) => {
  // 注意：不再接收 quality —— 图片在渲染层已经按质量编码成 dataURL，
  // 这里再按 quality 编码一次只会引入二次压缩损失。
  const { dataUrl, format, filenameTemplate, prefix, counter } = payload || {};

  // 可选的输出目录覆盖：只允许指向**应用自身目录内**的路径。
  // 自检（--smoke）用它把产物写到 smoke/shots，而不必改写用户的 outputDir 设置。
  const override = payload && payload.outputDir;
  const canOverride = typeof override === 'string' && override && isInsideDir(override, app.getAppPath());
  if (override && !canOverride) {
    console.warn('[save] 拒绝使用应用目录之外的输出目录覆盖:', override);
  }
  const ext = format === 'png' ? 'png' : 'jpg';
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  const buffer = dataUrlToBuffer(dataUrl);

  let dir = canOverride ? path.resolve(override) : settings.outputDir;
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {
    dir = null;
  }

  if (!dir) {
    const res = await dialog.showSaveDialog(mainWindow ?? undefined, {
      title: '保存图片',
      defaultPath: path.join(app.getPath('pictures'), `${renderTemplate(filenameTemplate, prefix, counter)}.${ext}`),
      filters: [{ name: '图片', extensions: [ext] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    await fsp.writeFile(res.filePath, buffer);
    return { ok: true, path: res.filePath, dir: path.dirname(res.filePath) };
  }

  const baseName = renderTemplate(filenameTemplate, prefix, counter);
  const filePath = await writeUniqueFile(dir, baseName, ext, buffer);
  return { ok: true, path: filePath, dir, bytes: buffer.length, mime };
});

/** 屏幕截图：返回鼠标所在显示器画面（dataURL），渲染层再交给 cropperjs 裁剪 */
ipcMain.handle('screen:capture', async () => {
  // 多显示器时，把鼠标移到目标屏幕再点「屏幕截图」即可切换，无需额外 UI
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = display.size;
  // 等比缩放：宽高各自取 min 会把 16:9 的屏幕截成 4:3。
  const k = Math.min(1, 3840 / width, 2160 / height);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.round(width * k)),
      height: Math.max(1, Math.round(height * k))
    }
  });
  if (!sources.length) return { ok: false, error: '没有找到可截取的屏幕' };

  const matched = sources.find((s) => String(s.display_id) === String(display.id));
  // 对不上时回落到第一个源（通常主屏），但明确告诉渲染层，
  // 免得用户以为截到了副屏实际上截错屏（R5-8）
  const source = matched || sources[0];
  return {
    ok: true,
    name: source.name,
    matched: !!matched,
    dataUrl: source.thumbnail.toDataURL('image/png')
  };
});

/** 允许「打开」的文件类型：只放图片和常见文档，挡掉可执行文件 */
const OPENABLE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff',
  '.pdf', '.txt', '.csv', '.md', '.log'
]);

/** target 是否位于 dir 之内（含 dir 自身） */
function isInsideDir(target, dir) {
  if (!target || !dir) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

ipcMain.handle('shell:openPath', async (_e, target) => {
  if (!target || typeof target !== 'string') return '';
  const dir = settings.outputDir;
  if (!isInsideDir(target, dir)) {
    console.warn('[shell] 拒绝打开输出目录之外的路径:', target);
    return '';
  }
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    console.warn('[shell] 路径不存在:', resolved);
    return '';
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext && !OPENABLE_EXT.has(ext)) {
    console.warn('[shell] 拒绝打开该类型的文件:', ext);
    return '';
  }
  return shell.openPath(resolved);
});

ipcMain.handle('shell:showItemInFolder', (_e, target) => {
  if (!target || typeof target !== 'string') return;
  if (!isInsideDir(target, settings.outputDir)) {
    console.warn('[shell] 拒绝在资源管理器中显示输出目录之外的文件:', target);
    return;
  }
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return;
  shell.showItemInFolder(resolved);
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  userData: app.getPath('userData'),
  defaultOutputDir: path.join(app.getPath('pictures'), 'VerticalCamStudio')
}));
