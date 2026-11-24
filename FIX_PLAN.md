# 复审结论与修复计划 · VerticalCam Studio

> 复审对象：[CODE_REVIEW.md](CODE_REVIEW.md)（47 条）。
> 方法：逐条对照当前源码复核（报告写于本次会话最近一轮改动之前，其中若干条已过时）。
> 复审日期：2026-11-20

---


## 一、复审结论速览

| 判定 | 条目 | 说明 |
| --- | --- | --- |
| ✅ 成立且影响大 | #8 #13 #24 #28 #37 | 均是**当前代码里的真实缺陷**，其中 #8 会让"连续拍两张同场景照片"直接废掉裁剪器 |
| ✅ 成立 | #1 #2 #3 #4 #5 #6 #12 #14 #15 #16 #17 #20 #21 #22 #23 #25 #26 #30 #33 #41 #42 #44 #45 | 照做即可 |
| ⚠️ 表述有误，结论仍成立 | #9 #10 #14 #18 #19 #22 #26 #43 | 见下方逐条 |
| ❌ 不成立 / 已过时 | #7 #17 #29 #35 #40 #43 #46 #47 | 详见下方 |
| 🆕 报告未覆盖（新发现） | N1–N4 | 本轮改动引入或遗漏的 |

### 逐条复核要点（只列有争议或有价值的）

| # | 原报告说法 | 复审结论 |
| --- | --- | --- |
| **#8** | 相同 dataURL 二次载入 `onload` 不触发 | **成立且是当前最严重的功能缺陷。** `cropImage.src = dataUrl`（app.js:320）赋同样的字符串不会重新触发 `load` → `onload` 永不执行 → `state.cropper` 一直是 `null` → 之后保存报"没有可保存的画面"。摄像头画面静止时两次拍照的 JPEG 字节完全相同，**必然命中**。修法：`cropImage.removeAttribute('src')` 后再赋值（或用 `cropImage.decode()`）。 |
| **#9** | "JPEG 被编码两次" | **表述有误**：主进程收到的是 dataURL，直接 `Buffer.from(...,'base64')` 落盘，**并没有二次编码**。真实问题是 `payload.quality` 是**死参数**（main.js:239 解构后从未使用），应删除或改为主进程单次编码。 |
| **#10** | DOM 而非 `state.settings` 为真相源 | 成立但影响小。真实差异：质量滑块 `input` 只更新显示、不写 settings，只有 `change` 才写 —— 用户拖动后不松手直接保存，输出正确但持久化值滞后。 |
| **#13** | 软阈值 lo/hi 未钳位 | **成立，是我本轮引入的**。`lo = t - 48` 当 `t < 48` 时为负 → 纯黑像素被映射成 `(0-lo)/(hi-lo)*255 > 0`，最深的墨迹被提亮。修：`lo = max(0, t-soft)`、`hi = min(255, t+soft)`。 |
| **#14** | TOCTOU 竞态 | 成立但本场景（单机单用户）危害极小；`async` 未 `await` 与过时的 eslint 注释属实。修法（`'wx'` 独占创建）成本低，值得做。 |
| **#17** | `toast()` 覆盖 className | **基本不成立**：styles.css 里 `.toast` 没有第二个基础类，不存在"抹掉 toast-top"的问题。可顺手改成 classList，但优先级低。 |
| **#18** | 空格触发两次拍照 | **部分不成立**：`keydown` 里已经 `e.preventDefault()`，原生的按钮激活被抑制，不会双触发。真实副作用是：按钮聚焦时按空格变成"再拍一张"而不是激活按钮 —— 建议焦点在 button 上时空格不触发拍照。 |
| **#19** | `e.key` 在非 QWERTY/IME 下失效 | 部分成立：Ctrl 组合键不受输入法干扰，`e.key` 实际可靠。改 `e.code` 更稳妥但非必须。 |
| **#22** | `runSmokeTest` 用 `process.cwd()` | **成立**（main.js:942，与其它三个 `app.getAppPath()` 不一致）→ 自检产物散落在启动目录。 |
| **#23** | 打包后写 `app.asar` 内失败 | 成立，且 `--audit/--abtest/--shapes/--smoke` 应由 `IS_DEV` 把关。 |
| **#26** | "cropper 暴露 `ready` 事件，应 await 一次" | **建议不可用**：cropperjs **1.6.2 没有实例 `.on()`**（只有 `ready` 选项回调）。正确做法是保留 `ready:` 选项（已在用），把 `cropperToDataUrl` 里的 12×150ms 轮询降级为"一次性兜底重试"。 |
| **#28** | 载入新图未重置 `pan.ctrlDown` / `selection.active` | **成立**（本轮新增的框选手势放大了影响）：拖动中途按空格拍照，新图载入后 `selection.active` 仍为 true，下一次 pointermove 会去改刚初始化的选区。 |
| **#30** | `navigator.mediaDevices` 可能 undefined | 成立但 Electron file:// 下必然存在，加守卫成本极低。 |
| **#33** | audit 的 fetch 无超时 | 成立，`AbortSignal.timeout(30_000)` 一行解决。 |
| **#37** | 放大后画布可能超 8192 | **成立**：裁剪画布上限 8192，放大 3× 后可达 24576×24576（约 6 亿像素）→ 内存爆炸。需钳位。 |
| **#39** | 探针移入 `renderer/dev/probes.js` | 方向正确但有前提：`app.js` 是 classic script，`import()` 动态引入需要 CSP `script-src 'self'` 允许（当前允许），可行但属于大重构。 |
| **#43** | 打包需排除 abtest/smoke/log | **不成立**：`build.files` 已限定 `electron/**` + `renderer/**`，根目录的 `abtest/`、`smoke/`、`*.log` 本来就进不了包。 |
| **#46** | `.gitignore` 缺失、需 `git rm --cached` | **不成立**：`.gitignore` 已存在，且**本项目当前不是 git 仓库**（CODE_REVIEW 文末也承认了）。真正该做的是清理根目录的临时产物（`*.log`、`abtest_models.json`）。 |
| **#47** | README 第 115 行仍介绍 M 快捷键 | 行号已变（现在 115 行），该行是删除线标注"已移除"，确实该删掉。 |

### 🆕 报告未覆盖的新发现

| # | 问题 | 位置 |
| --- | --- | --- |
| **N1** | `updateSelect` 临时改写 `cropper.cropBoxData.min*/max*` 为 `Infinity`/0，若期间抛异常会污染状态（已用 try/finally 兜住，但 `renderCropBox` 内部可能重算这些值） | app.js `updateSelect` |
| **N2** | 精确锁定 cropperjs 版本：**本轮 Ctrl 平移与框选对齐修复共依赖 4 个私有字段**（`limited`、`cropBoxData.min*/max*`、`action`、`pointers`），`^1.6.2` 的浮动范围是真实风险 | package.json |
| **N3** | `resolveExportScale` 的 auto 阈值在长边 1199/1200 处会在 1×/2× 之间跳变，边界体验突兀 | app.js |
| **N4** | 根目录堆积了 8 个调试日志（`audit*.log`/`ocr-*.log`/`smoke*.log`）与 `abtest_models.json`，属临时产物 | 项目根 |

---


## 二、修复计划（按批次执行，每批独立可验收）

### 批次 A —— 功能阻断修复（最高优先，全部是当前真实缺陷）

| # | 改动 | 文件 |
| --- | --- | --- |
| A1 | 载入前 `cropImage.removeAttribute('src')`，保证相同 dataURL 也会重新触发 `load`；并优先用 `cropImage.decode()` | renderer/app.js `loadImageIntoCropper` |
| A2 | `onerror` 分支改为 `reject(err)`，调用方统一 toast；`destroyCropper` 后同步复位 `state.hasImage` | renderer/app.js |
| A3 | 新图载入完成后复位 `pan.ctrlDown` / `pan.dragging` / `selection.active` | renderer/app.js |
| A4 | 软阈值 `lo/hi` 钳到 `[0,255]` | renderer/app.js `applyWhiteboard` |
| A5 | 放大后画布尺寸钳到 8192（与 `getCroppedCanvas` 上限一致） | renderer/app.js `cropperToDataUrl` |
| A6 | `cropperjs` 精确锁 `1.6.2`；启动时断言私有字段存在，缺失则提示"需重新对接补丁" | package.json / renderer/app.js |

**验收**：新增 `--smoke` 用例 `reloadProbe` —— 连续两次载入**同一张图**，断言第二次 `state.cropper` 非空且 `getCroppedCanvas` 有输出。

### 批次 B —— 保存链路正确性

| # | 改动 | 文件 |
| --- | --- | --- |
| B1 | 删除 `payload.quality` 死参数（渲染层已编码完毕） | electron/main.js `image:save` |
| B2 | `format`/`quality` 统一读 `state.settings`；质量滑块 `input` 即写 settings | renderer/app.js |
| B3 | `uniqueFilePath` 改用 `fs.open(candidate,'wx')` 独占创建 | electron/main.js |
| B4 | `sanitizeName` 追加 `.replace(/[. ]+$/,'')`（Win32 非法名） | electron/main.js |
| B5 | `settings:patch` 逐键校验：`outputDir` 必须绝对路径、`format∈{jpeg,png}`、`quality∈[0.5,1]`、`rotation∈{0,90,180,270}`、`whiteboardContrast∈[1,3.2]`、`exportScale∈{auto,1,2,3}`、模板长度上限 | electron/main.js |
| B6 | README 说明 `{n}` 语义（会话内计数器，真正的去重靠 `-1/-2` 后缀） | README.md |

### 批次 C —— 安全加固（单个 PR，改动面小）

| # | 改动 | 文件 |
| --- | --- | --- |
| C1 | `setWindowOpenHandler` 只放行 `http:`/`https:` | electron/main.js |
| C2 | `shell:openPath` / `showItemInFolder` 限制在 `settings.outputDir` 子路径内，拒绝 `.exe/.lnk/.url/.bat/.cmd/.ps1` | electron/main.js |
| C3 | 权限处理器校验 `details.securityOrigin === 'file://'` | electron/main.js |
| C4 | CSP 收紧为 `style-src 'self'`（已确认 index.html 无 `style=""` 属性，JS 的 `el.style.x=` 不受 CSP 限制） | renderer/index.html |
| C5 | `sandbox: true`（preload 只用 contextBridge/ipcRenderer，沙箱可用） | electron/main.js |

### 批次 D —— 交互与健壮性

| # | 改动 |
| --- | --- |
| D1 | 焦点在 `<button>` 上时空格不触发拍照（#18） |
| D2 | `e.key` → `e.code`（`KeyS`/`KeyO`）（#19） |
| D3 | `startStream` 首次失败记录 `err` 并在最终提示里带上（#20） |
| D4 | `screen:capture` 改用统一缩放因子 `k`，避免竖屏被裁成方图（#12） |
| D5 | 所有 `api.patchSettings(...)` 加 `.catch`（#25） |
| D6 | `endPan(null)` 不再派发 `(0,0)` 合成 pointerup（#27） |
| D7 | `cropperToDataUrl` 的轮询降级为一次性兜底（#26） |
| D8 | `mediaDevices` 守卫、`activate` 逻辑、`ResizeObserver` disconnect、清理未用 import（#30 #31 #29 #32） |
| D9 | audit 的 VLM fetch 加 30s 超时（#33） |
| D10 | 开发工具 flag 由 `IS_DEV` 把关，打包版不响应（#7 #23）；`runSmokeTest` 统一用 `app.getAppPath()`（#22） |

### 批次 E —— 结构与工程化（可延后，不影响功能）

| # | 改动 |
| --- | --- |
| E1 | 拆分 `electron/main.js`：生产 IPC 与开发工具分离（#38） |
| E2 | 探针移入 `renderer/dev/probes.js`，主进程用 `import()` 调用（#39） |
| E3 | `window.__wb = { applyWhiteboard }` 显式声明开发工具契约（#41） |
| E4 | `cropperjs` 移入 devDependencies（#42） |
| E5 | ESLint flat config（#44） |
| E6 | 抽出纯函数模块 + `node --test` 单元测试：`otsuThreshold`、`renderTemplate`、`sanitizeName`、`resolveExportScale`（#45） |
| E7 | 清理根目录临时产物、README 删 M 快捷键行（#46 #47） |

---


## 三、验收方式

1. 每个批次结束后跑 `--smoke`：`exit=0` 且 `report.json` 中 `fileOk / panOk / selectOk / panSelectOk / whiteboardOk / reloadOk` 全为 true。
2. 批次 A 额外用**真实图片**回归：静止画面连拍两张 → 第二次仍能裁剪保存。
3. 批次 C 完成后人工核对：摄像头可打开、屏幕截图可用、外链被拒、`file://` 权限正常。
4. 批次 E 的单元测试：`npm test` 全绿。

---


## 四、执行记录（2026-11-20）

### 已完成

| 批次 | 状态 | 落地内容 |
| --- | --- | --- |
| **A** 功能阻断 | ✅ 完成 | `loadImageIntoCropper` 赋值前先 `removeAttribute('src')`；`onerror` 改为 reject；新图载入前复位 `pan`/`selection` 手势态；软阈值 `lo/hi` 钳到 `[0,255]`；放大后画布边长钳到 8192；cropperjs 精确锁 `1.6.2` 并新增 `assertCropperCompat()` 运行时自检 |
| **B** 保存链路 | ✅ 完成 | 删除 `payload.quality` 死参数；格式/质量改以 `state.settings` 为真相源（质量滑块 input 即更新内存、防抖落盘）；`uniqueFilePath` 改用 `'wx'` 独占创建；`sanitizeName` 去尾部点/空格并规避 Win32 保留名；`settings:patch` 与配置文件载入均逐键校验；README 补 `{n}` 语义 |
| **C** 安全加固 | ✅ 完成 | 外部链接只放行 http/https；`shell:openPath`/`showItemInFolder` 限制在输出目录内且限制文件类型；权限处理器校验 `file://` 来源；CSP 去掉 `style-src 'unsafe-inline'` 并加 `connect-src 'self'`；`sandbox: true` |
| **D** 交互健壮性 | ✅ 完成 | 空格在按钮聚焦时不抢触发拍照；快捷键改用 `e.code`；getUserMedia 两次失败都落日志；屏幕截图改等比缩放（不再把 16:9 截成 4:3）；`patchSettings` 统一兜错；`devicechange` 加存在性守卫；`ResizeObserver` 卸载时 disconnect；开发工具 flag 由 `!app.isPackaged` 把关；`--smoke` 产物目录统一到 `app.getAppPath()`；audit 的 VLM 请求加 120s 超时 |
| **E** 工程化 | 🟡 部分完成 | 抽出 `renderer/core.js`（主/渲染共用纯函数，UMD 形式）并新增 `test/core.test.js`（19 个用例）；cropperjs 移入 devDependencies；`window.__wb` 显式声明开发工具契约；根目录临时日志归入 `logs/`；README 更新（删 M 快捷键行、{n} 语义、安全边界表、依赖锁定说明） |

### 未做（有意保留）

| 项 | 原因 |
| --- | --- |
| E1 拆分 `electron/main.js` | 纯结构重构、无功能收益，当前改动面已经不小，另起一轮更稳妥 |
| E2 探针移入 `renderer/dev/probes.js` | 需要把内联 `executeJavaScript` 改成动态 import，改动大且会削弱自检的可读性 |
| E5 ESLint flat config | 需要联网安装 eslint 依赖，当前环境不稳定；`npm test` 已覆盖纯函数 |
| #26 把轮询降级为一次性兜底 | 现有 12×150ms 轮询无害且更稳，保留 |
| #31 macOS `activate` 逻辑 | 仅 macOS 触发，当前目标平台用不到 |

### 验收结果

| 检查项 | 结果 |
| --- | --- |
| `npm test`（node --test） | **19/19 通过** |
| `--smoke` 自检 | **exit 0**，`cropperLoaded / fileOk / panOk / selectOk / panSelectOk / whiteboardOk / reloadOk` 全 true |
| 新增回归探针 `reloadProbe` | **通过** —— 同一 dataURL 连续载入两次，第二次 cropper 与裁剪结果均正常（修复前必然失败） |
| `--shapes` 开发管线 | 正常出图，exit 0 |
| `--audit`（真实图片 + 本地 Qwen3-VL-4B） | 正常出图，exit 0；原图读数 `|-|`，白板图仍读成 `[-]`（与修复前一致，属对比度增强的固有副作用，靠 2× 放大规避） |
| **新增 `apporder_x2*` 变体**（放大 → 对比度 → JPEG，即程序真实顺序） | 两项均读出 `-|-11|` ✅ —— 说明**当前版本管线本身在原图上就是正确的**，此前 `-[-11]` 出现在 `111.jpg` 上是更早版本管线的产物（羽化灰阶 203，对比度被叠加过），不是现版本的回归 |

### 复审中自我修正的两处

1. `assertCropperCompat()` 初版在 `new Cropper()` 之后立刻检查，报出「私有字段全部缺失」的假警 ——
   cropperjs 的 `cropBoxData` / `canvasData` / `containerData` / `limited` 是在 `ready` 回调之前才初始化的，
   检查必须放到 `ready` 里；`action` 字段更是**首次拖动时**才创建，属于正常现象，已从检查项移除。
2. 共享模块最初放在项目根 `shared/`，但渲染层是 classic script 且页面走 `file://`，
   CSP `script-src 'self'` 在 file:// 下只放行同目录脚本，会被拦掉 —— 因此实现落在 `renderer/core.js`，
   主进程用 `require('../renderer/core.js')` 复用同一份。

---


## 五、第二轮复审与修复（2026-11-20，基线 `CODE_REVIEW_R2.md`）

### 逐条判定

| 编号 | R2 的说法 | 判定 | 处理 |
| --- | --- | --- | --- |
| **R2-1** | `window.__wb` 定义了却没被使用 | ✅ **成立** | 主进程 27 处探针全部改走契约（`window.__wb.applyWhiteboard` / `.loadImageIntoCropper` / `.cropperToDataUrl` / `.getCropper()`）；契约扩充 `getCropper` / `getSettings` / `patchSettings` |
| **R2-2** | `toast()` 整体覆盖 className | ✅ 成立（轻） | 改用 `classList.remove/add`，不再抹掉基础类 |
| **R2-3** | `patchSettings` 丢弃主进程权威 settings | ✅ **成立**（P1 遗留） | 只回写**本次提交的键**的权威值（避免整体覆盖其它字段）；新增 `settingsProbe` 回归用例 |
| **R2-4** | `assertCropperCompat` 可能被静默跳过 | ⚠️ **结论不成立，但采纳加固** | cropperjs 的 `ready` 是 DOM 事件、由图片**异步**解码后 `build()` 触发，不会在构造函数里同步触发；上一轮把检查移进 `ready` 后它确实跑到了（报告「字段齐备」）。仍按建议加固：`ready` 用闭包实例 + 构造后若已 `ready` 再补一次 |
| **R2-5** | `.gitignore` 缺 `abtest/` | ✅ 成立 | 补 `abtest/` 与 `logs/` |
| **R2-6** | 保存路径的轮询已冗余 | ✅ 成立（nit） | 保留（防御性兜底），补注释说明 |
| **R2-7** | main.js 仍 1500+ 行、内联 JS 未拆 | ⚠️ 成立但属结构优化 | **延后**，记入待办；本轮先把探针收口到契约，为拆分铺路 |
| **R2-8** | smoke 会持久化改写用户 outputDir | ✅ **成立，是真隐患** | `image:save` 支持 `outputDir` 覆盖（仅接受**应用目录内**的路径），smoke 不再 `patchSettings` 改用户设置；已做对照实验验证 |
| **R2-9** | `whiteboardRange` 与 `qualityRange` 处理不一致 | ✅ 成立 | 对齐：`input` 即更新 `state.settings` + 刷新预览滤镜 + 防抖落盘 |

### 复审时额外发现并已修复

| 问题 | 说明 |
| --- | --- |
| **开发任务会被「关窗口」静默中断** | 关掉窗口 → `window-all-closed` → `app.quit()` → 整批 `--audit` 停在第 8~14 个变体、退出码 0、无任何报错。改为：`--audit/--abtest/--shapes` **隐藏窗口**（不抢桌面），且开发任务进行中拒绝关闭请求；四种开发模式改为互斥 `else-if` |
| main.js 一处 UTF-8 乱码注释 | 已修正为「对照组：程序实际产出的那张（白板图）」 |

### 本轮验收

| 检查项 | 结果 |
| --- | --- |
| `npm test` | **19/19 通过** |
| `--smoke` | **exit 0**，八项探针全 true（新增 `settingsProbe`：主进程把 `exportScale:'2'` 规范化为数字 `2` 并回写到渲染层） |
| `--audit`（真实图片 + 本地 Qwen3-VL-4B） | **26 个变体全部跑完**（此前因窗口被关中途夭折），`变体图已写入` 正常输出 |
| `--shapes` | 隐藏窗口模式下正常出图，exit 0 |
| 用户 `settings.json` | 复测前后完全一致（`outputDir` / `exportScale` 等均未被自检污染） |

---

## 六、第三轮复审与修复（2026-11-20，基线 `CODE_REVIEW_R3.md`）

### 逐条判定

| 编号 | R3 的说法 | 判定 | 处理 |
| --- | --- | --- | --- |
| **R3-1** | 回写 state 但控件未同步，被拒值仍显示在 UI | ✅ **成立（P1）** | 主进程 `settings:patch` 改为返回 `{ settings, rejected }`；渲染层对**被拒键**精准回滚对应控件（只动那一个，不刷掉用户正在编辑的其它输入框）；新增 `rejectProbe` 回归用例 |
| **R3-2** | `assertCropperCompat` 缺空值防护 | ✅ 成立 | 加 `if (!cropper) return false;` |
| **R3-3** | main.js 探针与运行时混排 | ⚠️ 成立，属结构重构 | **延后**，记入待办 |
| **R3-4** | 良性规范化被记成「漂移/拒绝」日志噪声 | ✅ 成立 | 同值异型（`exportScale '2' → 2`）不再告警；只有真正被改写/被拒才记录 |
| **R3-5** | preload.js JSDoc 缩进错位 | ✅ 成立（nit） | 已对齐 |
| **R3-6** | `pan.prevMode` 惰性残留 | ✅ 成立（nit） | 已删除 |

### 本轮设计取舍（与 R3 建议略有不同）

R3-1 建议在检测到差异时整体调用 `syncControlsFromSettings()`。本轮**没有照搬**，因为那样会带来两个副作用：

1. **滑块回弹**：快速拖动质量/白板强度时，先发的请求可能后返回，
   整体同步会把正在拖的滑块拽回旧值，手感很差。
2. **打断编辑**：用户在编辑模板输入框时，另一个字段被拒触发的整体同步
   会把用户正在输入的内容刷掉。

改为：**主进程显式返回 `rejected` 列表**，渲染层只回滚被拒的那一个控件。
「良性规范化」与「被拒绝」由此被彻底区分开——前者静默通过，后者才回滚。

### 本轮验收

| 检查项 | 结果 |
| --- | --- |
| `npm test` | **19/19 通过** |
| `--smoke` | **exit 0**，九项探针全 true（新增 `rejectProbe`：提交 200 字符前缀 → 主进程拒绝 → state 保留旧值、**界面回滚到权威值**、坏值消失） |
| 日志噪声 | 手动选倍率不再刷「被主进程改写」告警；只有真实拒绝才记录 |
| 用户 `settings.json` | 复测前后完全一致（探针会临时改 `prefix`/`exportScale`，均已还原） |

---
