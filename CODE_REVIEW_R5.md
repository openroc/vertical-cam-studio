# 代码审查 · 第五轮深度审查（R5）

> 范围：白板拍照裁剪工具（Electron 38 + cropperjs 1.6.2）全部第一方源码。
> 逐文件重读：`electron/main.js`(1777 行)、`electron/preload.js`(27)、`renderer/app.js`(1368)、`renderer/core.js`(148)、`renderer/index.html`(186)、`renderer/styles.css`(281)、`scripts/*.mjs`(5 个)、`test/core.test.js`(162)、`package.json`、`.gitignore`、`start.cmd`/`start.ps1`/`audit.cmd`、`README.md`。
> 基线：对第四轮（CODE_REVIEW_R4.md）遗留项做回归，并覆盖第四轮之后新增的「菜单移除 / DevTools 门控 / UI 使用统计」三块代码。
> 验证：`node --test` → **tests 23 / pass 23 / fail 0**；`node --check` 三个核心 JS 通过；完整 Electron `--smoke` → **`allOk: true`**（含新增 `usageOk`）。
> 本轮所有「已确认」结论均来自源码抽取 + 真实执行，非静态推断。

---

## 一、R4 遗留项回归

| 项 | 主题 | 状态 | 说明 |
|---|---|---|---|
| R4-7 | 兜底对话框无 `mainWindow` 空值防护 | ❌ 仍未修 | `main.js` L397 `dialog:selectFolder`、L432 `image:save` 仍直接把 `mainWindow` 作为父窗口参数传入；R4「建议顺序」漏列导致第 3 批未覆盖 |
| R3-3 | main.js 探针模块化 | ❌ 未做且持续恶化 | 由 R4 时 1613 行增至 **1777 行**（+164，主要来自 UI 统计落盘 + smoke 统计探针 + 菜单/DevTools 配置）；`--abtest/--shapes/--audit/--smoke` 四类探针模板仍与运行时代码混排（约 L522–1157、L1163–1777） |

R4 其余 13 项（R4-1~6、R4-8~14）经重读确认均已落地，无回退。

---

## 二、本轮新发现

### R5-1 [P2] UI 统计标识白名单未排除 JS 原型键 → 原型污染 + handler 抛错 🆕

**位置**：`renderer/core.js` L115-121（`normalizeStatId`）、`electron/main.js` L319-340（`stats:button`）

```js
const STAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
```

`__proto__`、`constructor`、`prototype`、`toString`、`valueOf` 全部匹配该正则。命中后：

```js
const item = usage.items[id] || (usage.items[id] = { count: 0, ... });
item.count += 1;          // 给 Object.prototype / 函数对象挂属性
item.last = iso;          // 原型被污染
item.days = pruneDays(... item.days[day] ...);  // undefined → TypeError
```

**真实执行证据**（从 main.js 抽取真实 handler + 真实 core.js）：

```json
{
  "normalizeStatId('__proto__')": "__proto__",
  "thrown": "Cannot read properties of undefined (reading '20261124')",
  "Object.prototype.last": "2026-11-23T23:52:20.101Z",
  "Object.prototype.count": NaN,
  "appended": [],
  "usage.total": 1
}
```

即：`Object.prototype` 被写入两个属性，handler 随后抛异常，**明细日志一条没写**（`appended: []`），但聚合 `total` 已 +1 → 两份统计从此不一致。同理 `constructor` / `toString` 等键会让 `item` 指向函数对象，行为同样异常。

**影响面**：当前 UI 的按钮 id 与 `data-stat` 都是普通英文标识，正常点击不会触发；但白名单本身的契约被破坏——`data-stat` 来自 HTML 属性，将来加按钮若标识撞上原型键就会中招；且 `ipcMain.on` 里的未捕获异常会污染主进程全局状态。这是 R5 新增统计功能自带的回归。

**建议（两层都做最稳）**：
1. `normalizeStatId` 增加保留字黑名单：`const BLOCKED = new Set(['__proto__','constructor','prototype','toString','valueOf','hasOwnProperty'])`；
2. `loadUsage` / handler 用 `Object.create(null)` 承载 `items` 与 `days`，并用 `Object.prototype.hasOwnProperty.call(usage.items, id)` 判断存在性，不再依赖原型链 truthy 判断。

---

### R5-2 [P3] 统计文件单个 item 结构损坏时 handler 抛 TypeError 🆕（已确认）

**位置**：`main.js` L103-111 `loadUsage` + L331-334 `stats:button`

`loadUsage` 只校验 `raw.version === 1` 且 `raw.items` 是 object，不校验每个 item 的字段。若 `ui-usage.json` 被手工编辑、旧版本写入或半途截断成 `items: { btnShot: { count: 3 } }`：

```js
item.days = pruneDays(..., { [day]: (item.days[day] || 0) + 1 });
//                            ^^^^ TypeError: Cannot read properties of undefined
```

**真实执行证据**（抽取 handler + 构造三种 item）：

| item 形态 | 结果 |
|---|---|
| `{count:3, first, last, days:{}}` | 正常（需注入 `usageTimer`） |
| `{count:3, first, last}`（缺 days） | `TypeError: Cannot read properties of undefined` |
| `{count:3, days:null}` | `TypeError: Cannot read properties of null` |

后果同 R5-1：明细日志丢失、聚合已递增、两者不一致。单测只覆盖了 `pruneDays` 纯函数，未覆盖这条路径。

**建议**：在 `loadUsage` 里逐项规范化（缺 `days` 补 `{}`、缺 `count` 补 0、字段类型不对则丢弃该项），或 handler 内先判断 `item && typeof item === 'object' && item.days && typeof item.days === 'object'`，不满足就重建 item。

---

### R5-3 [P3] `sanitizeName` 截断后可能重新产生尾点/尾空格 🆕（已确认）

**位置**：`renderer/core.js` L35-46

清洗顺序是 `.replace(/[. ]+$/g, '')` → `.slice(0, 120)`：先去尾部点/空格，再截断。当第 120 个字符恰好是空格或点时会重新制造 Win32 非法结尾。

**真实执行证据**：

```js
core.sanitizeName('a' + 'x'.repeat(118) + ' ' + 'b')
  // → 'a' + 118×'x' + ' '，长度 120，以空格结尾
core.sanitizeName('a' + 'x'.repeat(117) + ' .' + 'b')
  // → 长度 120，以 '.' 结尾
```

用户把 `{n}` / `{timestamp}` 与较长前缀组合时有可能踩到；Windows 下这类文件名会被系统静默改名或直接写失败（现有 15 个单测的用例都短于 120，故未暴露）。

**建议**：把 `.slice(0, 120)` 提前到 `.replace(/[. ]+$/g, '')` 之前，或截断后再做一次 `.replace(/[. ]+$/g, '')`，并补两条单测。

---

### R5-4 [P3] `saveCurrent` 无并发保护，快速连按会让 `{n}` 重复 🆕

**位置**：`renderer/app.js` L1001-1038

R4-5 把计数器改成「成功后再递增」（正确修复了取消跳号），但 `const counter = state.saveCounter + 1` 到 `state.saveCounter = counter` 之间跨越了 `await cropperToDataUrl()` 和 `await api.saveImage()`。两次并发保存（快速连按 Ctrl+S，或自动保存与手动保存重叠）会拿到同一个 counter。

文件本身不会覆盖（`writeUniqueFile` 的 `-1/-2` 后缀兜底，R4-2 已验证），但 `{n}` 的可读性语义被破坏。

**建议**：加一个模块级 `saveInFlight` 布尔锁，第二次调用直接返回 `false` 或在第一次结束后串行执行；若不想加锁，至少用「先自增、失败回滚」的方式保证 counter 唯一，并在取消时回滚（需同时保留 R4-5 的跳号修复）。

---

### R5-5 [P3] `dialog:selectFolder` 绕过设置校验白名单 🆕

**位置**：`main.js` L396-406

```js
settings.outputDir = res.filePaths[0];   // 未过 SETTINGS_VALIDATORS.outputDir
persistSettings();
```

`settings:patch` 对 `outputDir` 要求 `typeof string && trim && path.isAbsolute`，但用户选目录这条路径直接赋值并落盘，与「主进程是权威值源、逐键校验」的既定约定不一致。原生 dialog 返回的通常是绝对路径，实际风险很低；但后续若把返回值替换为其他来源（如拖拽路径）就会绕过约束。

**建议**：复用 validator：`const v = SETTINGS_VALIDATORS.outputDir(res.filePaths[0]); if (!v) return null; settings.outputDir = v;`

---

### R5-6 [P3] 明细日志同步写盘未防抖，与聚合文件策略不对称 🆕

**位置**：`main.js` L133-146、L319-340

聚合文件有 800ms 防抖；明细日志每次点击都 `appendFileSync`，超过 512KB 时还会 `readFileSync` 全文件 + `writeFileSync` 重写。高频点击（连续拍照/框选）会在主进程事件循环里做同步磁盘 IO，且 `ipcMain.on` 是同步处理路径。功能无错，属于性能与一致性瑕疵。

**建议**：把明细也改成批量缓冲（与聚合共用同一个 timer，flush 时一次 append 多行）；或至少把 512KB 裁剪改成流式/异步任务。

---

### R5-7 [P3] 兜底对话框仍无 `mainWindow` 空值防护（R4-7 延续）

**位置**：`main.js` L397、L432

窗口已关闭而 IPC 仍在排队时，`dialog.showOpenDialog(mainWindow, ...)` / `showSaveDialog(mainWindow, ...)` 传 `null` 给父窗口参数在 Electron 中通常可接受，但 `mainWindow` 若为 `null` 时某些版本的 dialog API 会抛 TypeError。防护成本两行：`mainWindow ?? undefined`。

---

### R5-8 [P3] 屏幕截图 fallback 可能截错屏（R4-6 延续，硬件未验证）

**位置**：`main.js` L463

```js
const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
```

当 `display_id` 与 `display.id` 在某个 Electron/驱动组合下对不上时，静默回落到 `sources[0]`（通常主屏），用户以为截了副屏实际截了主屏。本机只有单显示器，无法实测。建议 fallback 时在返回值里带 `matched: false`，让渲染层 toast 提示「未精确匹配到目标显示器」。

---

### R5-9 [P3] UI 统计缺少 handler 级单测，smoke 只覆盖 happy path 🆕

**位置**：`test/core.test.js`（4 个新单测）、`main.js` L1710-1728（usageProbe）

新增统计功能的单测只覆盖 `normalizeStatId` / `dayKey` / `pruneDays` 三个纯函数；R5-1 / R5-2 / R5-3 这类问题单测完全测不到。smoke 只验证「send → count +1 → 两文件存在」。

**建议**：把 `stats:button` 的纯逻辑（计数更新 + item 重建）抽成 core.js 里的 `applyButtonStat(usage, id, now)` 纯函数并补 4 类单测：正常 / 原型键 / item 缺字段 / 90 天裁剪边界；handler 只负责 IO。

---

### R5-10 [nit] `close` / `closed` 处理器整体未缩进 🆕

**位置**：`main.js` L209-221

两个处理器从行首开始（`:1` 缩进），与全文件其余代码的 2 格风格不一致，是 R4-1 修复时只处理了重复 handler、未统一缩进的残留。纯样式。

### R5-11 [nit] README 目录结构与安全表已漂移 🆕

`README.md` L92-109 只列了 `scripts/copy-vendor.mjs` 一个脚本（实际有 5 个），未列 `renderer/core.js`、`test/`、`CODE_REVIEW*.md`、`start.ps1` 等；L116 的 CSP 表仍写 `default-src 'self'; style-src 'self'; script-src 'self'`，未反映 R4-13 新增的 `base-uri 'self'; object-src 'none'` 及 img/media 白名单。

### R5-12 [nit] 统计文档「只留 90 天」表述易误解 🆕

`README.md` L134 写「每个按钮的 count / first / last / days（只留最近 90 天）」。实际只有 `days` 映射做 `pruneDays(90)`，`total` 与 `items[id].count` 是永久累计。建议改成「`days` 只留最近 90 天，count/total 为累计值」。

---

## 三、正确性与安全抽查（本轮已核对通过）

- **R4 修复回归**：重复 close handler 已合并；`writeUniqueFile` 单步 `wx` 独占写入；设备兜底回写 UI 与 `lastDeviceId`；`{n}` 取消不跳号；截图取鼠标所在屏；`__wb` 仅开发构建挂载；CSP 加 `base-uri/object-src`；`settings:patch` 无变化不落盘——逐项重读确认无回退。
- **新增配置**：`Menu.setApplicationMenu(null)` 已在 `whenReady` 开头调用；`IS_DEV = !app.isPackaged && --dev`、`devTools: !app.isPackaged` 两层保证打包后 DevTools 不可用；`IS_DEV_TOOLS` 四类探针打包后整体失效。
- **手势状态机**：`loadImageIntoCropper` 进入前复位 `pan/selection`（L377-382）；`window blur` / `pointercancel` / Ctrl keyup 三路收尾（L752-767、L831-838）；`updateSelect` 临时关钳位有 `try/finally`（L631-639）。
- **旋转与镜像**：`layoutPreview` quarter 分支 `w = min(availH, availW·aspect)`；canvas `translate→rotate→scale` 与 CSS `rotate(θ) scaleX(-1)` 叠加顺序一致，预览与出图不漂移。
- **白板管线**：软阈值 `lo/hi` 钳到 `[0,255]`（L891-892）；二值化用 `>` 防最深笔画被判白（L900）；放大后画布钳 8192（L973-986）。
- **保存链路**：格式/质量以 `state.settings` 为唯一真相源；主进程不二次编码；`writeUniqueFile` 的并发独占已由 R4 专项验证。
- **安全七项**：`sandbox: true` + `contextIsolation` + `nodeIntegration: false`；CSP 无内联；权限处理器仅放行 file:// 页面的 media/display-capture；`setWindowOpenHandler` 仅 http(s)；`shell:openPath/showItemInFolder` 双重限制（outputDir 内 + 扩展名白名单）；`image:save` 的 outputDir 覆盖仅限 app 目录内；`SETTINGS_VALIDATORS` 逐键白名单——均复核无误（唯一缺口是 R5-5 的 dialog 路径绕过）。
- **测试基线**：23/23 通过；`--smoke` 十项探针全绿，其中 `usageProbe` 为 `{"before":1,"after":2,"bumped":true,"usageFilesOk":true}`。

---

## 四、总体评价

本轮未发现 P1 级功能阻断。**最重要的发现是 R5-1**：上一轮新增的 UI 统计功能，其标识白名单正则漏掉了 JS 原型键，`__proto__` 能顺利通过并在真实执行中污染 `Object.prototype`、使 handler 抛错、导致明细日志与聚合统计不一致。虽然当前 UI 不会主动上报这些标识，但这是白名单契约本身的破口，建议优先修。

其余新发现集中在**新增统计功能的健壮性与文档同步**（R5-2/3/5/6/9/11/12）、**并发边界**（R5-4）与**R4/R3 遗留**（R5-7/8、R3-3）。核心链路（拍照→裁剪→白板→保存）的正确性与安全约束依然稳固，且有 smoke 回归护航。

`main.js` 已达 1777 行，探针模块化（R3-3）连续两轮被列为唯一持续恶化的结构债，建议在下一个维护窗口优先执行拆分。

## 五、建议处理顺序

1. **R5-1 + R5-2 + R5-9**：统计标识黑名单 + `Object.create(null)` + item 结构规范化，并把计数逻辑抽成纯函数补单测（同一处代码，一次改完）。
2. **R5-3**：修正 `sanitizeName` 截断顺序，补 2 条单测。
3. **R5-7 + R5-5 + R5-4**：dialog 空值防护、outputDir 复用 validator、保存并发锁。
4. **R5-6 + R5-8 + R5-10~12**：明细日志防抖、截图 fallback 提示、缩进/文档清理。
5. **R3-3**：main.js 探针模块化（择期重构，唯一持续恶化项）。
