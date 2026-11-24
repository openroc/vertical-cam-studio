# 代码审查报告 · 第二轮（回归 + 新问题）

> 基线：第一轮 `CODE_REVIEW.md`。本轮针对已修改后的 `electron/main.js`、`renderer/app.js`、`renderer/core.js`、`renderer/index.html`、`package.json`、`test/core.test.js` 复审。
> 验证方式：逐文件源码阅读 + `node --test`（**19 项全部通过**）。

---

## 一、第一轮问题修复核对

| 第一轮编号 | 问题 | 状态 | 说明 |
| --- | --- | --- | --- |
| P0 #1 | openExternal 任意协议 | ✅ 已修 | 仅放行 http/https，其余 `console.warn` |
| P0 #2 | `sandbox:false` | ✅ 已修 | 改为 `sandbox:true`（preload 仅用 contextBridge/ipcRenderer，兼容） |
| P0 #3 | `shell:openPath` 无校验 | ✅ 已修 | `isInsideDir` + `OPENABLE_EXT` 白名单 |
| P0 #4 | settings 未校验 | ✅ 已修 | `SETTINGS_VALIDATORS` 逐键校验；`loadSettings` 也过一遍 |
| P0 #5 | CSP `unsafe-inline` | ✅ 已修 | `style-src 'self'` 并补 `connect-src 'self'` |
| P0 #6 | 权限来源未校验 | ✅ 已修 | 非 `file://` 一律拒绝 |
| P0 #7 / P1 #23 | 开发工具在打包版可用 | ✅ 已修 | 统一 `IS_DEV_TOOLS = !app.isPackaged` 把关 |
| P1 #8 | 同 dataURL 不触发 load | ✅ 已修 | 赋值前 `removeAttribute('src')`，并新增 `reloadProbe` 回归用例 |
| P1 #9 | JPEG 双编码 | ✅ 已修 | `image:save` 不再接收 `quality` |
| P1 #10 | 保存读 DOM | ✅ 已修 | `cropperToDataUrl` 统一读 `state.settings` |
| P1 #11 | 篡改 cropper 私有字段 | ✅ 已修 | cropperjs 锁定 `1.6.2` + `assertCropperCompat` 自检 |
| P1 #12 | 截图比例失真 | ✅ 已修 | 统一缩放因子 `k` |
| P1 #13 | 软阈值未钳位 | ✅ 已修 | `lo/hi` clamp 到 [0,255] |
| P1 #14 | uniqueFilePath TOCTOU | ✅ 已修 | 改 `'wx'` 独占创建 |
| P1 #15 | 文件名尾点/空格 | ✅ 已修 | `sanitizeName` 去尾点 + Win32 保留名规避 |
| P1 #16 | `{n}` 语义 | ✅ 已修 | core.js 注释说明；测试覆盖 |
| P1 #18 | 空格双触发 | ✅ 已修 | `activeElement.tagName==='BUTTON'` 时不抢焦点 |
| P1 #19 | 快捷键 e.key | ✅ 已修 | 改 `e.code === 'KeyS'/'KeyO'` |
| P1 #20 | 摄像头错误被吞 | ✅ 已修 | 两次失败均 `console.error` |
| P1 #22 | 输出目录不一致 | ✅ 已修 | smoke 改用 `app.getAppPath()` |
| P1 #24 | Promise 永 resolve | ✅ 已修 | 改为 `reject`，调用方 catch |
| P2 #25 | patchSettings 未捕获 | ✅ 已修 | 统一 `patchSettings()` 包装 catch |
| P2 #28 | 载入新图未复位手势 | ✅ 已修 | `loadImageIntoCropper` 复位 pan/selection |
| P2 #29 | ResizeObserver 泄漏 | ✅ 已修 | beforeunload disconnect |
| P2 #30 | mediaDevices 未防护 | ✅ 已修 | 加存在性判断 |
| P2 #33 | VLM fetch 无超时 | ✅ 已修 | `AbortSignal.timeout(120000)` |
| P3 #41 | 全局函数隐式耦合 | ⚠️ 部分 | 新增 `window.__wb` 契约，但**主进程未使用**（见 R2-1） |
| P3 #42 | cropperjs 依赖位置 | ✅ 已修 | 移到 devDependencies |
| P3 #45 | 缺单元测试 | ✅ 已修 | `test/core.test.js` 19 例全过 |
| P1 #17 | toast 覆盖 className | ❌ 未修 | 见 R2-2 |
| P1 #21 | 设置主从漂移 | ❌ 未修 | 见 R2-3 |
| P2 #26 | 轮询 ready 循环 | ⚠️ 保留 | 现有 `ready` 回调，重试循环变冗余（见 R2-6） |
| P3 #38/#39 | main.js 拆分 / JS 字符串块 | ❌ 未做 | 仍 1518 行、500+ 行 executeJavaScript（见 R2-7） |
| P3 #46 | abtest/ 未 gitignore | ❌ 未修 | 见 R2-5 |

**结论**：P0 全部修复，P1 绝大多数修复，质量显著提升。以下为第二轮新发现/遗留项。

---

## 二、第二轮新发现与遗留

### R2-1（P3）`window.__wb` 定义了却没被使用
`renderer/app.js` 末尾挂出 `window.__wb = { applyWhiteboard, loadImageIntoCropper, cropperToDataUrl, ... }`，注释称“避免主进程依赖渲染层隐式全局”。但 `electron/main.js` 的 `runAbTest`/`runShapeTest`/`runAudit`/`runSmokeTest` 里的 `executeJavaScript` 字符串**仍直接调用裸全局名** `applyWhiteboard(...)`、`loadImageIntoCropper(...)`、`cropperToDataUrl()`、`state.cropper`（如 main.js L445/593/886/1093/1111 等）。契约形同虚设。

**修复（二选一）**：
- 要么把主进程探针改成走契约：`window.__wb.applyWhiteboard(...)`、`window.__wb.loadImageIntoCropper(...)`；`state.cropper` 也应通过 `window.__wb` 暴露 getter。
- 要么删掉 `window.__wb`（当前是死代码）。

推荐前者，否则一旦 `app.js` 改 `type=module` 或压缩混淆，所有开发工具立刻静默失效。

### R2-2（P2）`toast()` 仍整体覆盖 className
`renderer/app.js` L59：`el.className = \`toast ${kind}\``。目前 `#toast` 基础类只有 `toast`，暂无副作用，但只要以后新增基类（如 `toast-top`）就会被抹掉。建议改 `classList`：
```js
el.classList.remove('ok', 'err');
if (kind) el.classList.add(kind);
```

### R2-3（P2）`patchSettings` 丢弃了主进程返回的权威 settings
第一轮 P1 #21 的“主从漂移”没真正解决：`settings:patch` 现在会**校验并按校验器改写**入参（例如 `exportScale:'2'` → 存成数字 `2`、`rotation:'90'` → 数字 `90`），并 `return settings`。但渲染层 `patchSettings()` 里 `.catch(...)` 之后**没有把返回的 settings 回写 `state.settings`**：
```js
function patchSettings(patch) {
  return api.patchSettings(patch).catch((err) => { ... }); // 忽略了返回值
}
```
后果：当主进程规范化/拒绝某个值时，渲染层本地副本与磁盘真实值不一致（例如越界的 `quality` 被主进程拒绝保留旧值，渲染层却已把旧 DOM 值写进本地 `state.settings`）。**修复**：
```js
function patchSettings(patch) {
  return api.patchSettings(patch)
    .then((next) => { if (next) state.settings = Object.assign(state.settings, next); })
    .catch((err) => { ... });
}
```
另建议主进程在 `persistSettings()` 后向渲染层广播 `settings:changed`，供多窗口/外部改动同步（对应第一轮 #21 原始建议）。

### R2-4（P3）`assertCropperCompat` 在“同步 ready”情形下会被跳过
`loadImageIntoCropper` 的 `ready` 回调里 `if (state.cropper) assertCropperCompat(state.cropper)`。`state.cropper` 是在 `new Cropper(...)` **返回后**才赋值；若 cropperjs 在某条路径下于构造函数内同步触发 `ready`，则此刻 `state.cropper` 仍为 `undefined`，自检被静默跳过（`succeed()` 仍执行，不影响解析）。建议直接用回调上下文实例或把 `ready` 逻辑放到构造函数返回后统一判定，保证自检一定跑到。

### R2-5（P3）`.gitignore` 仍缺 `abtest/`
`smoke/` 已忽略，但 `abtest/`（85+ 张变体图 + `profiles.json`）仍在版本树里，且现在每次 `--audit` 都会新增 `apporder_*` 变体。追加：
```
abtest/
```

### R2-6（P3·nit）`cropperToDataUrl` 的 12×150ms 轮询已成冗余
`loadImageIntoCropper` 现在 `await` 到 `ready` 才 resolve，理论上 resolve 之后 `getCroppedCanvas()` 必非 null。保存路径里的重试循环（L893-901）已无必要，可保留作兜底但建议加注释说明“仅防御”，或改为直接调用 + 单次 null 断言。

### R2-7（P3）main.js 体量与内联 JS 仍未拆分
第二轮新增 `core.js`/测试后，`electron/main.js` 仍 1518 行，其中约 900 行是 `--abtest/--shapes/--audit/--smoke` 的 `executeJavaScript` 模板字符串。无法 lint/类型检查/断点。建议后续拆到 `electron/dev/*.js`，探针脚本移入渲染层模块（配合 R2-1 的 `window.__wb` 契约）。属结构性优化，非阻塞。

### R2-8（观察）smoke 会持久化改写用户 outputDir
`runSmokeTest` 里 `api.patchSettings({ outputDir: shotDir })` 经校验后**写进了真实 settings.json**（smoke 进程随即退出，通常无碍）。但若用户平时用同一份 userData，下次启动 outputDir 会变成 `smoke/shots`。可让 smoke 用一次性 save 覆盖参数、不落盘 outputDir，或跑完还原。

### R2-9（小）`whiteboardRange` 与 `qualityRange` 处理不一致
`qualityRange` 现在在 `input` 时就写 `state.settings`（落盘防抖）；但 `whiteboardRange` 的 `input` 仅更新文字标签，`state.settings.whiteboardContrast` 要到 `change` 才写。导致拖动白板强度时，预览滤镜（`updatePreviewFilter`）与“立即保存”读到的仍是旧值。建议对齐 quality 的做法。

---

## 三、代码正确性抽验（本轮重点复核的改动）

- **`core.js` UMD 包装**：`module.exports` 检测在 Node 生效、浏览器回落到 `self.WhCore`；`index.html` 脚本顺序 `cropper.min.js → core.js → app.js` 正确，`WhCore` 在 `app.js` 使用前已就绪。主进程 `require('../renderer/core.js')` 复用同一份，无重复实现。✅
- **`sanitizeName` 顺序**：非法字符→折叠空白→trim→去尾点/空格→截断 120→保留名前缀 `_`。测试覆盖 `shot. . `→`shot`、`CON`→`_CON`、`console` 不受误伤。边界：先截断再去尾点理论上可能截出以点结尾的名字，但 `{timestamp}` 场景不会触发，可接受。✅
- **`resolveExportScale(width,height,mode)`**：`auto` 且长边≥1200→1；`1200/3`→3；手动夹取 [1,3]；缺省 auto。测试全绿。✅
- **`screen:capture` 缩放**：`k=Math.min(1,3840/w,2160/h)`，再 `Math.max(1, round(...))` 防 0。✅
- **`isInsideDir`**：`path.relative` 判定，空串（同目录）与不以 `..`/绝对 开头视为内部；`btnOpenFolder` 打开目录自身 ext 为空可绕过扩展名检查，符合预期。✅
- **`settings:patch` 校验器**：对 `0`（rotation/quality 边界）用 `!== null && !== undefined` 判空，避免了 falsy 误删；`loadSettings` 同样过校验，旧配置带病字段被丢弃回落默认。✅

---

## 四、总体评价

第一轮 7 项 P0 与绝大多数 P1 已妥善修复，并主动补齐了：单元测试（19 例通过）、cropperjs 兼容自检、同图重载回归探针、审计里“实际应用顺序”变体、CSP 收紧、设置校验。工程完成度明显提高。

剩余项以 P3 结构性优化为主，加上两处应当尽快处理的一致性缺陷：**R2-3（settings 回写，影响真相源一致性）** 与 **R2-1（`__wb` 契约未接入，开发工具仍靠隐式全局）**。

### 建议优先级
1. **R2-3**：`patchSettings` 回写返回的 settings —— 消除主从漂移（对应第一轮遗留）。
2. **R2-1**：主进程探针改用 `window.__wb` 契约，或删死代码。
3. **R2-5**：`.gitignore` 补 `abtest/`。
4. **R2-2 / R2-4 / R2-9**：小而明确的健壮性修正。
5. **R2-6 / R2-7 / R2-8**：择机重构，非阻塞。

---

*本轮为修改后的回归审查；`node --test` 19 项全部通过。项目当前仍非 git 仓库，未做基于 diff 的比对。*
