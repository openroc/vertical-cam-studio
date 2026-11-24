# 代码审查 · 第四轮深度回归（R4）

> 范围：白板拍照裁剪工具（Electron 38 + cropperjs 1.6.2）全部第一方源码。
> 逐文件核对：`electron/main.js`(1613 行)、`electron/preload.js`、`renderer/app.js`(1329 行)、`renderer/core.js`、`renderer/index.html`、`scripts/*.mjs`(5 个)、`test/core.test.js`、`start.ps1`/`start.cmd`/`audit.cmd`、`package.json`、`.gitignore`。
> 基线：对第三轮（CODE_REVIEW_R3.md）遗留项做回归，并做本轮全量深审。
> 验证：`node --test` → **tests 19 / pass 19 / fail 0**。

---

## 一、R3 遗留项回归

| R3 项 | 主题 | 状态 | 说明 |
|---|---|---|---|
| R3-1 | `patchSettings` 回写后同步 UI 控件 | ✅ 已修 | app.js L99-102：`rejected.length` 时调 `syncControlsFromSettings(rejected)`，且只动被拒键对应的控件；smoke `rejectProbe` 有回归覆盖 |
| R3-2 | `assertCropperCompat` 空值防护 | ✅ 已修 | app.js L328：`if (!cropper) return false;` |
| R3-3 | main.js 探针模块化 | ❌ 未做 | main.js 现 1613 行（较 R3 又增 ~30 行），四类探针模板仍与运行时混排。延续建议：拆到 `electron/dev/probes/*.js`，择期重构 |
| R3-4 | 良性规范化日志降噪 | ✅ 已修 | app.js L90-94：`String(before) === String(after)` 豁免「同值异型」（exportScale `'2'` → `2`），不再刷 warn |
| R3-5 | preload.js JSDoc 缩进 | ⚠️ 基本修 | 块注释已对齐正文，`*` 仍比 `/**` 多缩 1 格，纯样式（见 R4-12） |
| R3-6 | `pan.prevMode` 惰性字段 | ✅ 已修 | pan 现为 `{ dragging, synthetic, ctrlDown }`，无残留 |

**结论：R3 的 6 项中 4 项完全落地，唯一实质问题 R3-1 已修复并有 smoke 回归探针护航。**

---

## 二、本轮新发现

### R4-1 [P2] `close` 事件处理器重复注册（合并残留）✅ 已修 2026-11-24
**位置**：`electron/main.js` L144-155

```js
mainWindow.on('close', (e) => {
  if (devJobRunning) { e.preventDefault(); ... }   // 第一个
});
mainWindow.on('close', () => {
  console.log('[window] close');                    // 第二个（重复）
});
```

同一个窗口注册了两个 `close` 监听器，功能上无害（第二个只打日志），但：

1. 关闭一次会打两遍 `[window] close`（两个 handler 都执行）；
2. 第二个 handler 的缩进明显错乱（L153-155），是合并/编辑残留，会误导后续维护者以为有两套关闭逻辑。

**建议**：删除第二个 handler，仅保留第一个（并把 `console.log('[window] close')` 并入第一个）。

### R4-2 [P2] `uniqueFilePath` 预创建后用普通写入，失败会遗留 0 字节文件 ✅ 已修 2026-11-24
**位置**：`electron/main.js` L224-238

当前实现：`fsp.open(candidate, 'wx')` → `close()` → 返回路径 → 调用方 `fsp.writeFile(filePath, buffer)`（不带 `wx`）。

两个小问题：

1. **失败残留**：`open` 成功后（文件已创建为 0 字节）如果磁盘满/写入抛错，目录里会永久留下一个 0 字节的占位文件，下次保存自动跳到 `-1` 后缀；
2. **微竞态**：`close` 与 `writeFile` 之间，另一个写入者可以对同一个路径做普通写入（`writeFile` 无 `wx` 不受独占保护）。

**建议**：把「占位 + 写入」合成一步，循环里直接：

```js
for (;;) {
  try {
    await fsp.writeFile(candidate, buffer, { flag: 'wx' });
    return candidate;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    candidate = path.join(dir, `${baseName}-${i++}.${ext}`);
  }
}
```

即把 buffer 传入 `uniqueFilePath`（改名 `writeUnique`），一次原子完成。

### R4-3 [P3] `startStream` 兜底成功后，设备下拉框与 `lastDeviceId` 不一致 ✅ 已修 2026-11-24
**位置**：`renderer/app.js` L166-213

指定 `deviceId: { exact }` 打开失败 → 回退默认设备成功后：

- `#deviceSelect` 仍显示**失败的**那个设备（下拉框值没改）；
- `state.settings.lastDeviceId` 未更新为实际生效的设备 → 下次启动仍优先尝试失败设备，每次都走一遍失败→兜底路径。

**建议**：兜底分支里同步 `select.value = ''`（或实际 deviceId）、`patchSettings({ lastDeviceId: '' })`（空 = 下次启动取第一个可用设备），并把首次失败原因并入 footer 提示（原 D3 项）。

### R4-4 [P3] `scripts/vlm-ocr.mjs` 的 fetch 没有超时 ✅ 已修 2026-11-24
**位置**：`scripts/vlm-ocr.mjs` `ocr()` 函数

主进程版 `runAudit` 已加了 `signal: AbortSignal.timeout(120000)`（main.js L1023），但脚本版的 `fetch` 没有。本地推理卡住时脚本会永久挂起，与 audit 的既有修复不一致。

**建议**：补一行 `signal: AbortSignal.timeout(120000)`。

### R4-5 [P3] 取消保存仍递增 `{n}` 计数器 → 文件名跳号 ✅ 已修 2026-11-24
**位置**：`renderer/app.js` L985（`saveCurrent`）

`state.saveCounter += 1` 在 `api.saveImage` **之前**执行；用户在兜底保存对话框点「取消」时计数器已消耗。`{n}` 本就注明「唯一性靠 -1/-2 后缀」，跳号无功能影响，但连续编号会断档。

**建议**：把 `+= 1` 挪到 `result.ok` 之后。

### R4-6 [P3] 屏幕截图只取主显示器 ✅ 已修 2026-11-24（改为鼠标所在显示器）
**位置**：`electron/main.js` `screen:capture`（L345-365）

`screen.getPrimaryDisplay()` 固定取主屏。多显示器用户想截副屏（演示/资料常见场景）无入口。属于功能缺口而非缺陷：

**建议**：`screen.getAllDisplays()` + 简单选择（或在 toast 里提示仅支持主屏，管理预期）。

### R4-7 [P3] 兜底对话框直接引用 `mainWindow`，无空值防护
**位置**：`electron/main.js` L293（`dialog:selectFolder`）、L328（`image:save` 兜底保存对话框）

窗口已关闭而 IPC 仍在排队时，`dialog.showOpenDialog(null, ...)` 会抛 TypeError（IPC 直接 reject）。当前流程下窗口关闭后渲染层不会再发起调用，概率极低，但防护成本一行：

**建议**：`mainWindow ?? undefined` 传父窗口参数，或前置 `if (!mainWindow) return null;`。

### R4-8 [P3] 开发探针依赖固定 `delay(3000~4000ms)`，慢机/冷启动易 flaky ✅ 已修 2026-11-24
**位置**：`electron/main.js` L427 / L757 / L908 / L1071

`--abtest/--shapes/--audit/--smoke` 全部用固定毫秒等待后直接 `executeJavaScript`。机器慢（杀毒扫描、冷启动）时页面可能尚未就绪，探针偶发 `window.__wb is not defined`。

**建议**：等待循环改为轮询 `webContents.executeJavaScript('!!window.__wb')` 直到 true（上限 ~15s），替换固定 delay。属开发工具健壮性，不影响产品。

### R4-9 [nit] main.js L749 注释 mojibake ✅ 已修 2026-11-24
`--shapes` 段注释「竖线两端长出横向帽��」尾部有乱码字符，编码残留，顺手修。

### R4-10 [nit] `window.__wb` 开发契约未按 `IS_DEV_TOOLS` 门控 ✅ 已修 2026-11-24
**位置**：`renderer/app.js` L1317-1329

探针契约在打包后的生产构建里同样挂载。因渲染层是本应用自己的 file:// 页面且 `contextIsolation` 开启，风险极低；但按最小暴露原则，可在 app.js 里判断 `location.search` 或让主进程注入标志后再挂。非必改。

### R4-11 [nit] `#saveHint` 是死元素 ✅ 已修 2026-11-24
`index.html` L171 的 `<span id="saveHint">` 从未被任何代码写入（保存提示走 `#statusText` + toast）。删除或接线二选一。

### R4-12 [nit] 样式残留 ✅ 已核对 2026-11-24（app.js 已拆行；preload 属误报未改）
- `preload.js` L11-14：块注释 `*` 比 `/**` 多缩 1 格（R3-5 残余）；
- `app.js` L1286：`const info = await api.appInfo();  $('#appInfo')...` 两语句同行，可读性差。

### R4-13 [nit] CSP 可再收紧 ✅ 已修 2026-11-24
`index.html` L5-6：可追加 `object-src 'none'; base-uri 'self'`（当前靠 `default-src 'self'` 兜底，属于锦上添花）。

### R4-14 [nit] `settings:patch` 在仅有 rejected 键时也落盘一次 ✅ 已修 2026-11-24
`electron/main.js` L288：即使没有任何键被实际修改也 `persistSettings()`。幂等无害，仅磁盘写放大；可在 `rejected.length === patch 键数` 时跳过。

---

## 三、正确性与安全抽查（本轮已核对通过）

- **手势状态机**：`loadImageIntoCropper` 进入前复位 `pan/selection`（L359-363）；`window blur` / `pointercancel` 双路收尾（L812-819）；Ctrl keyup 立即 `endPan`（L733-741）。上轮 N1 提到的 `updateSelect` 钳位改写已有 `try/finally` 保护 ✅
- **旋转布局公式**：`layoutPreview` 的 quarter 分支 `w = min(availH, availW·aspect)`（L255-261）——已按「元素框先定尺寸、CSS 旋转后外接框互换」复核，公式正确，竖屏 1080×1920 不会裁边 ✅
- **镜像与旋转的叠加顺序**：canvas 端 `translate→rotate→scale` 与 CSS `rotate(θ) scaleX(-1)`（右到左生效 = 先镜像后旋转）一致，预览与出图不漂移 ✅
- **白板管线**：软阈值 `lo/hi` 已钳到 `[0,255]`（L872-873）；二值化用 `>` 防「最深笔画被判白」（L881）；放大后画布钳 8192（L954-959）✅
- **同图重载**：`removeAttribute('src')` 后再赋值，`reloadProbe` 有回归 ✅
- **保存链路**：格式/质量以 `state.settings` 为唯一真相源（L931-932）；主进程不再二次编码 ✅
- **安全**：`sandbox: true` + `contextIsolation` + `nodeIntegration: false`；CSP 无内联；权限处理器仅放行 file:// 页面的 media/display-capture；`setWindowOpenHandler` 仅 http(s)；`shell:openPath/showItemInFolder` 双重限制（outputDir 内 + 扩展名白名单）；`image:save` 的 `outputDir` 覆盖仅限 `app.getAppPath()` 内（smoke 专用）；`SETTINGS_VALIDATORS` 逐键白名单 ✅
- **文件名**：`sanitizeName` 覆盖 Win32 非法字符/尾点尾空格/保留设备名，单测 15 例覆盖 ✅
- **打包**：`build.files` 仅 `electron/**` + `renderer/**`（vendor 由 postinstall 复制进 renderer），abtest/smoke/logs 不会进包 ✅
- **启动器**：`start.ps1` 的 `ELECTRON_RUN_AS_NODE` 清理 + 健康检查 + %TEMP% 镜像兜底逻辑闭环 ✅

---

## 四、总体评价

R3 之后代码质量继续收敛：**本轮未发现 P1 级功能阻断或安全问题**，核心链路（拍照→裁剪→白板→保存）的正确性约束都有 smoke 回归探针护航。新发现集中在两类：

1. **两处值得近期修的合并/实现残留**（R4-1 重复 close handler、R4-2 uniqueFilePath 占位文件），改动都在 10 行以内；
2. **开发工具与边缘 UX**（探针固定 delay、vlm-ocr 无超时、副屏截图缺失），不影响产品功能。

main.js 体量继续增长，探针模块化（R3-3）建议在下个维护窗口优先执行——它是当前唯一持续恶化的结构债。

## 五、建议处理顺序

1. **R4-1 / R4-2**：删重复 close handler；`uniqueFilePath` 改为单步 `writeFile({flag:'wx'})`。
2. **R4-4 / R4-8**：vlm-ocr 补超时；探针改 `__wb` 就绪轮询（提升 CI/慢机稳定性）。
3. **R4-3 / R4-5 / R4-6**：设备兜底回写 UI 与 lastDeviceId；计数器后置；副屏截图（可挂起待需求）。
4. **R4-9 ~ R4-14**：注释/样式/CSP 清理。
5. **R3-3**：main.js 探针模块化（择期重构，唯一持续恶化项）。

---

## 六、修复记录

### 2026-11-24 · 处理顺序第 1 批（R4-1 + R4-2）

| 项 | 改动 | 文件 |
|---|---|---|
| R4-1 | 删除重复的 `mainWindow.on('close')` 处理器，日志合并进唯一处理器；`closed` 处理器缩进一并对齐 | `electron/main.js` L144-156 |
| R4-2 | `uniqueFilePath` → `writeUniqueFile(dir, baseName, ext, buffer)`，改为单步 `fsp.writeFile(candidate, buffer, { flag: 'wx' })`，EEXIST 时递增后缀重试；调用方去掉二次 `writeFile` | `electron/main.js` L220-236、L333-337 |

**验证（真实执行，非推断）：**

- `node --check electron/main.js`：通过；`node --test`：**19/19 全绿**。
- `electron . --smoke`（经 %TEMP%\elec-run 镜像启动，规避本机项目盘 electron.exe 启动失败）：
  `allOk: true`，保存结果 `ok: true, bytes: 21915`，新函数写入的 JPEG 落盘且非空。
- 并发同名写入专项：从 main.js 源码直接抽取 `writeUniqueFile` 函数体执行，`Promise.all` 两次同名保存到同一目录 → `dup.jpg`(14B) / `dup-1.jpg`(13B)，内容各自完整、无 0 字节残留、无相互覆盖。

### 2026-11-24 · 处理顺序第 2、3 批（R4-4 / R4-8 / R4-3 / R4-5 / R4-6）

| 项 | 改动 | 文件 |
|---|---|---|
| R4-4 | `fetch` 加 `signal: AbortSignal.timeout(120000)`，与主进程 audit 一致 | `scripts/vlm-ocr.mjs` |
| R4-8 | 新增 `waitForDevReady({requireCamera, timeoutMs})`：轮询 `window.__wb` + `document.readyState`；smoke 额外等首帧（超时只告警不中断）。四个探针的固定 `delay(3000/3500/4000)` 全部替换 | `electron/main.js` |
| R4-3 | 设备兜底成功后从视频轨 `getSettings().deviceId` 取实际设备：能匹配选项则回写 UI 与 `lastDeviceId`，否则清空选择并置空持久化值；footer 带上首次失败原因 | `renderer/app.js` `startStream` |
| R4-5 | `{n}` 改为成功保存后才消耗：`const counter = state.saveCounter + 1` 用于本次保存，`result.ok` 后才 `state.saveCounter = counter` | `renderer/app.js` `saveCurrent` |
| R4-6 | 截图改取 `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`（鼠标所在屏）；按钮 tooltip 与 README 两处说明同步更新 | `electron/main.js`、`renderer/index.html`、`README.md` |

**验证（真实执行，非推断）：**

- `node --check` 覆盖 `electron/main.js` / `renderer/app.js` / `scripts/vlm-ocr.mjs` 全部通过；`node --test` **19/19 全绿**。
- 完整 Electron smoke（`--smoke`）：`allOk: true`（cropperLoaded / fileOk / panOk / selectOk / panSelectOk / whiteboardOk / reloadOk / settingsOk / rejectOk 全部 true），`waitForDevReady` 正常就绪，保存 `bytes: 21915`。
- 从 main.js 源码抽取 `screen:capture` handler + mock 双屏：鼠标在 (2200,300) → 命中 display 2 → 返回 `Secondary` 源，不再固定取主屏。
- 从 app.js 源码抽取 `startStream` + mock 摄像头失败：`actualId='CAM2'` 时下拉框与 `lastDeviceId` 均回写 CAM2；`actualId=null` 时 `selectedIndex=-1` 且持久化置空；footer 均含「已改用默认设备」及原因。
- 从 app.js 源码抽取 `saveCurrent` + mock：`result.canceled` 时 `saveCounter` 仍 0，成功后才为 1，两次发送的 `{n}` 均为 1。

**未覆盖**：真实多显示器/失效摄像头硬件本机不可用，R4-3/R4-6 以源码抽取 + mock 方式验证逻辑分支；硬件行为需在目标机器上确认。

### 2026-11-24 · 处理顺序第 4 批（R4-9 ~ R4-14）

| 项 | 改动 | 文件 |
|---|---|---|
| R4-9 | `--shapes` 注释中的 mojibake 字符清除 | `electron/main.js` |
| R4-10 | 主进程在 `loadFile` 时只对未打包构建传 `{ query: { vcsdev: '1' } }`；渲染层仅在页面带该参数时挂载 `window.__wb`，生产构建不暴露探针入口 | `electron/main.js`、`renderer/app.js` |
| R4-11 | 删除从未被写入的 `#saveHint` 空元素 | `renderer/index.html` |
| R4-12 | `app.js` 的 `appInfo` 两语句拆行；**preload.js 部分经核对为误报**——`*` 比 `/**` 多缩 1 格正是标准 JSDoc 对齐（星号在 `/` 右侧一列），保持不变 | `renderer/app.js` |
| R4-13 | CSP 显式追加 `base-uri 'self'; object-src 'none'` | `renderer/index.html` |
| R4-14 | `settings:patch` 增加 `changed` 标记，值相同或全被拒绝时不再 `persistSettings()` | `electron/main.js` |

**验证（真实执行，非推断）：**

- `node --check` 三文件通过；`node --test` **19/19 全绿**；`grep` 确认 mojibake 与 `#saveHint` 均已清零。
- 完整 Electron `--smoke`：**`allOk: true`** —— 证明 `__wb` 门控在开发模式正确挂载，CSP 收紧未破坏任何脚本/媒体/样式加载，设置回写与拒绝回滚探针仍全过。
- 从 app.js 源码抽取 `__wb` 门控块 + mock：`?vcsdev=1` → 挂载；空 query → 不挂载。
- 从 main.js 源码抽取真实 validator + `settings:patch` handler：提交相同值 0 次落盘、全被拒绝 0 次落盘、实际变更 1 次落盘。

**顺序复核提醒**：R4-7（`dialog` 无 `mainWindow` 空值防护）是 P3 项，但原「五、建议处理顺序」漏列，至今未处理；如继续清理建议把它补进下一批。
