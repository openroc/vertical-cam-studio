# 代码审查报告 · VerticalCam Studio

> 审查对象：`electron/main.js`、`electron/preload.js`、`renderer/app.js`、`renderer/index.html`、`renderer/styles.css`、`scripts/*.mjs`、`package.json`、`start.cmd` / `start.ps1` / `audit.cmd`。
> 按严重程度分级：P0（安全/加固）→ P1（真实缺陷）→ P2（健壮性/API）→ P3（结构/可维护性）。

---

## P0 — 安全与加固

### 1. `shell.openExternal(url)` 对任意 URL 放行
`createWindow` 的 `setWindowOpenHandler` 直接把 `url` 交给系统 shell。渲染层一旦被攻破或存在 `target=_blank` 的恶意链接，可触发任意协议调用（`file:`、自定义 URI、`ms-msdt:` 等）。

**修复**：仅白名单 `http:` / `https:`。

```js
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.toString());
  } catch { /* ignore */ }
  return { action: 'deny' };
});
```

### 2. `sandbox: false` 关闭了渲染进程沙箱
`webPreferences` 中显式关闭 Chromium 沙箱。在已启用 `contextIsolation: true` + `nodeIntegration: false` 的情况下没有功能理由关闭。改为 `sandbox: true`，所有能力通过 `preload.js` 暴露。

### 3. `shell:openPath` / `shell:showItemInFolder` IPC 无任何校验
`ipcMain.handle('shell:openPath')` 会对任意字符串调用 `openPath(target)`。渲染层被攻破即可启动任意可执行文件（`.exe` / `.lnk` / `.url`）。至少应将 `target` 限制在 `settings.outputDir` 子路径内，并拒绝危险扩展名。

### 4. `settings:patch` 写入未校验的值并立即持久化
`settings:patch` 允许渲染层把 `outputDir`、`filenameTemplate` 等键设为任意值，随后流入 `fs.mkdir(dir, {recursive:true})` + `fsp.writeFile(filePath, …)`。应增加逐键校验器（字符串长度、绝对路径、扩展名白名单、`rotation ∈ {0,90,180,270}`、`quality ∈ [0.5,1]` 等）。

### 5. CSP 允许 `style-src 'unsafe-inline'`
`index.html` 的 CSP 中 `style-src 'unsafe-inline'`。仅因代码用内联 `style.*` 才需要；配合 `script-src 'self'` 实际 XSS 风险较低，但建议把动态样式改用 `:root` 上的 CSS 自定义属性。

### 6. 权限处理器不校验请求来源
`setPermissionRequestHandler` 对所有 `media` / `display-capture` 一律放行。应加 `details.securityOrigin === 'file://'` 判定，确保只有本应用来源可用（当前 `media` 会匹配任意 frame）。

### 7. `runAudit` 从 argv 读取任意文件路径并 base64 回传
属于开发工具；确保 `--audit` 这类 flag 在打包版本中被剥离（见 P3 打包章节）。

---

## P1 — 真实缺陷

### 8. 相同 dataURL 二次载入时 `onload` 不触发
`loadImageIntoCropper`：若 `cropImage.src` 被赋成与上次完全相同的 dataURL，浏览器不再触发 `load`，Promise 只能靠 3 秒 `setTimeout(finish, 3000)` 兜底解析。会命中 `--smoke`（复用图片）与“同帧重复截图”流程。

**修复**：先清空 src 或用 `HTMLImageElement.decode()`。

```js
cropImage.removeAttribute('src');
cropImage.src = dataUrl;
```

### 9. JPEG 被编码两次
`cropperToDataUrl` 已用 `canvas.toDataURL('image/jpeg', quality)` 编码；随后 `payload.quality` 又传给 `image:save`，但主进程把 `quality` 解构后**从未使用**。要么从 payload 去掉，要么（更好）通过 IPC 传原始 RGBA、在主进程单次编码。

### 10. `cropperToDataUrl` / `saveCurrent` 直接读 DOM 而非 `state.settings`
`$('#formatSelect').value`、`$('#qualityRange').value` 是真相源之外的旁路。`change` 才写回 settings、`input` 不写；smoke 测试完全绕过 DOM。应统一从 `state.settings` 读取，并让滑块在 `input` 时就写入 `state.settings`。

### 11. `updateSelect` / `endPan` 篡改 cropperjs 私有字段
`cropper.limited`、`cropper.cropBoxData.min*/max*`、`cropper.action`、`cropper.pointers` 均为非公开内部属性。`package.json` 里 `cropperjs: ^1.6.2` 的 `^` 意味着任何补丁版本升级都可能重命名内部字段、静默打断 Ctrl-平移修复。**将 cropperjs 精确锁定为 `1.6.2`**，并加运行时断言（如 `if (!('cropBoxData' in cropper))` 提示需重新对接补丁）。

### 12. `screen:capture` 宽高独立钳位导致比例失真
`Math.min(width, 3840)` 与 `Math.min(height, 2160)` 分别钳位：超宽屏 5120×1440 → 3840×1440（尚可），但竖屏 2160×3840 → 2160×2160（被裁）。应统一缩放因子：

```js
const k = Math.min(1, 3840/width, 2160/height);
thumbnailSize: { width: Math.round(width*k), height: Math.round(height*k) }
```

### 13. `applyWhiteboard` 软阈值带未钳位到 `[0,255]`
若 `t < 48`，则 `lo < 0`，纯黑像素（g=0）被映射为 `(0-lo)/(hi-lo)*255 > 0` —— 最深的墨迹被提亮；`t > 207` 时同理。**修复**：`const lo = Math.max(0, t - soft), hi = Math.min(255, t + soft);`

### 14. `uniqueFilePath` 存在 TOCTOU 竞态
先 `fs.existsSync` 再写入，同秒两次保存可能撞名。应改用独占创建循环：

```js
try { const h = await fsp.open(candidate, 'wx'); await h.close(); return candidate; }
catch (e) { if (e.code !== 'EEXIST') throw; i += 1; }
```

另注：`uniqueFilePath` 标了 `async` 却不 `await`，`eslint-disable no-await-in-loop` 注释已过时。

### 15. `sanitizeName` 允许结尾的点/空格
`"foo."`、`"foo "` 在 Win32 是非法名（`CreateFile` 会截断）。追加 `.replace(/[. ]+$/,'')`。

### 16. `{n}` 计数器仅存在于单次会话
`state.saveCounter` 每次启动归零，`{n}` 只是该计数器；真正去重靠 `uniqueFilePath`。README 把 `{n}` 当作模板占位符介绍 —— 应说明该语义或把计数器持久化到 settings。

### 17. `toast()` 无条件覆盖 `el.className`
`el.className = 'toast ' + kind` 会抹掉后续新增的基础类（如 `toast-top`）。改用 `classList` 增删。

### 18. 按钮聚焦时按空格触发两次拍照
`bindEvents` 的 keydown 仅在 `input/textarea/select` 提前 return。当 `#btnShot` 聚焦时，空格既激活原生 click 又走 keydown 的 `doCapture()`。增加 `if (tag === 'button' || e.target.closest('button')) return;`，或更早 preventDefault。

### 19. `e.key.toLowerCase() === 's' / 'o'` 在非 QWERTY / IME / CapsLock 下失效
改用 `e.code === 'KeyS'` / `'KeyO'`。

### 20. `startStream` 吞掉首次错误后重试
首次 `exact deviceId` 失败被静默重试为 `{video:true}`；成功则看不到真因，两次都失败时只展示 `err2.message`（通用“找不到设备”），丢失 `err` 里的权限/DOM 错误。无论如何都应记录 `err`。

### 21. `state.settings` 在主/渲染进程间漂移
渲染层持有完整副本，`btnPickFolder` 手动同步。主进程改变设置（如 `dialog:selectFolder` 返回新目录）时没有推送事件，多窗口或未来 IPC 变更会失同步。建议在 `persistSettings()` 里广播 `settings:changed`，渲染层订阅。

### 22. `runSmokeTest` 用 `process.cwd()`，`runAudit`/`runAbTest` 用 `app.getAppPath()`
输出目录因启动方式（repo 根 `npm run smoke` vs 双击）而异。统一为 `app.getAppPath()`。

### 23. 打包版本下 `app.getAppPath()` 位于 `app.asar` 内 → `fs.mkdirSync(outDir)` 失败
`runAudit` / `runAbTest` / `runShapeTest` 均写到该路径。虽属开发工具，但 `--audit`/`--abtest` flag 应由 `IS_DEV` 把关，避免终端用户触发。

### 24. `loadImageIntoCropper` 永远 resolve（即使出错）
出错分支也 `resolve()`，导致 `doCapture` / `doScreenCapture` 继续调用 `cropperToDataUrl` 抛“no cropper”。改为 `reject(err)`，由调用方统一 toast。

---

## P2 — 健壮性 / API 卫生

### 25. `bindEvents` 中大量 `api.patchSettings(...)` 是 fire-and-forget
均返回 Promise，未 await 的 rejection 被吞掉。加 `.catch((e) => console.error('[settings]', e))`。

### 26. `cropperToDataUrl` 的“轮询直到 ready”循环是权宜之计
12 × 150 ms ≈ 1.8 s。cropper 暴露 `ready` 事件，应在 `loadImageIntoCropper` 阶段 await 一次。

### 27. `endPan(null)` 派发坐标为 `(0, 0)` 的合成 pointerup
cropper 的 `cropEnd` 只读 `pointers[pointerId]`，坐标无所谓，但代码具误导性。直接走内部清理即可。

### 28. 载入新图时未重置 `pan.ctrlDown` / `selection.active`
用户拖动途中按空格拍照时，`selection.active` 仍为 true，下一次 pointermove 会去改动刚初始化的 cropper 选区。在 `loadImageIntoCropper` 完成回调里重置两者。

### 29. `observePreviewSize` 的 ResizeObserver 从不 disconnect
单页应用问题不大，但热重载/dev-tools 重初始化会泄漏。保存句柄并在 `beforeunload` disconnect。

### 30. `init()` 中 `navigator.mediaDevices.addEventListener('devicechange', …)` 缺防护
若 `enumerateDevices` 抛错（权限被硬拒），`navigator.mediaDevices` 可能 undefined → init 崩溃。加 `if (navigator.mediaDevices) …`。

### 31. `app.on('activate')` 逻辑
若窗口存在但隐藏，不应 `createWindow`；应 `mainWindow.show()/focus()`。

### 32. `main.js` 顶部 `session` 导入除 `session.defaultSession` 外未使用
ESLint 层面标记，非功能性。

### 33. `runAudit` 的 VLM fetch 无超时/重试/熔断
llama.cpp 卡死会永久阻塞审计。用 `AbortSignal.timeout(30_000)` 包裹，连续 N 次失败后中断循环。

### 34. `delay` 函数在声明之前被使用
`runAbTest`（第 311 行）早于 `delay` 定义（第 937 行）。因函数声明提升可用，但可读性差，建议移到 `pad`/`stamp` 附近。

### 35. `runAbTest` 的 `console.log` 假设 `p.raw`/`p.binary`/`p.binHalf` 恒存在
目前成立，记录备查。

### 36. `resolveExportScale` 用 `Number(setting) || 1`
`'0'` 会被强制成 1；若未来允许手动输入 0 会被 UI 隐藏。建议显式范围校验。

### 37. `cropperToDataUrl` 放大上限 3× 与 `maxWidth/maxHeight: 8192`
极端尺寸下 `big.width` 可能超 8192。对 `big.width/height` 加 `Math.min(..., 8192)`。

---

## P3 — 结构 / 可维护性

### 38. `electron/main.js` ~1400 行混杂生产 IPC 与开发测试工具
拆分为 `electron/main.js`、`electron/ipc/*.js`、`electron/dev/{smoke,abtest,audit,shapes}.js`；开发态 handler 仅在 `IS_DEV || IS_SMOKE || …` 下注册。

### 39. `executeJavaScript(\`(async () => { … })()\`)` 字符串块超过 500 行
无法 lint、无法类型检查、无 source map。把各探针移入渲染层模块（如 `renderer/dev/probes.js`）导出普通函数，主进程通过 `webContents.executeJavaScript('import("./dev/probes.js").then(m => m.panSelectProbe())')` 调用。

### 40. `pad()` 在 `main.js` 与 `app.js` 重复
若想要共享可抽公共 util；否则成本很低，可保留。

### 41. `applyWhiteboard` 被 main.js 通过 `executeJavaScript` 以全局函数引用
仅因 `app.js` 是 classic script 才生效；一旦改成 `type="module"` 全部开发工具失效。在 `app.js` 末尾加 `window.__wb = { applyWhiteboard }` 显式声明契约。

### 42. `cropperjs` 放在 `dependencies`，但运行时只用 `renderer/vendor/cropper.min.js`
移到 `devDependencies`，避免被打进发布包。

### 43. 打包 `files` 未排除 `.log` / `smoke/` / `abtest/` / `scripts/`
虽 `build.files` 限定了 `electron/**` + `renderer/**`，仍建议用 `npm run pack` 后检查 `release/win-unpacked/resources/app.asar`，并显式追加 `"!**/abtest/**"`、`"!**/smoke/**"`、`"!**/*.log"`。

### 44. 缺少 ESLint / Prettier / TypeScript
鉴于大量触碰 cropperjs 内部与 IPC 面，轻量 ESLint flat config（`no-unused-vars`、`no-await-in-loop`、`eqeqeq`）本可提前拦住多条问题。

### 45. 测试
`--smoke` 实为集成测试，但 `applyWhiteboard`、`otsuThreshold`、`resolveExportScale`、`renderTemplate`、`sanitizeName` 等纯函数无单元测试。建议抽到 `renderer/processing.js`（`app.js` 与 node 脚本共用）并补 Node 测试。

### 46. 仓库卫生
- `abtest/`（~85 张图 + `profiles.json`）未进 `.gitignore`，应与 `smoke/` 一起加入。
- `smoke/shots/*.jpg`、`smoke/screenshot.png` 虽 `smoke/` 已 ignore 却仍在树中（早于 ignore 规则）—— 用 `git rm -r --cached smoke` 清理。
- 缺 `.editorconfig`、`.prettierrc`。

### 47. README
第 115 行仍介绍已移除的 `M` 快捷键，删除该行。

---

## 做得好的地方

- CSP 存在且相对收紧（`default-src 'self'`、`script-src 'self'`）。
- `contextIsolation: true`、`nodeIntegration: false`，`preload` 只暴露窄接口。
- 文件名净化、扩展名白名单、`dataUrlToBuffer` 的 MIME 校验形状正确。
- `applyWhiteboard` 链路注释写清了“为什么”（`gray > t` vs `>= t` 的取舍、对比度把羽化灰阶推向白色的机制）—— 难得且有价值。
- `--smoke` 是真正带 pass/fail 退出码 + `report.json` 落盘的端到端自检。
- README 的“国内网络 / 特殊环境的坑”表正是应当沉淀在仓库里的组织知识。
- `start.cmd` / `start.ps1` 针对 `ELECTRON_RUN_AS_NODE` 与 H: 盘崩溃做了自愈，防御到位且有文档。

---

## 建议的后续修复顺序

1. **P0** #1、#2、#3、#4 —— 单个 PR，改动面小。
2. **P1** #8、#9、#10、#11、#13、#14、#18 —— 保存链路 + 键盘正确性 + 版本锁定。
3. **P3** #38、#39 —— 在新增更多开发工具之前先拆分 `main.js`。
4. **P3** #42、#46 —— 打包 / 仓库清理。

---

*本报告基于对源码的直接阅读；该项目当前不是 git 仓库，故未做基于 diff 的审查。*
