# 代码审查 · 第三轮回归（R3）

> 范围：白板拍照裁剪工具（Electron 38 + cropperjs 1.6.2）自身源码。
> 方式：逐文件源码核对（项目非 git 仓库，无法做 diff 审查）。
> 基线：对第二轮（CODE_REVIEW_R2.md）遗留项做回归，并排查本轮新引入问题。
> 验证：`node --test` → **tests 19 / pass 19 / fail 0**。

---

## 一、第二轮遗留项跟踪

| R2 项 | 主题 | 状态 | 说明 |
|---|---|---|---|
| R2-1 | 开发探针接线 `window.__wb` | ✅ 已修 | main.js 全部 `applyWhiteboard(...)` 探针已改为 `window.__wb.applyWhiteboard(...)`；app.js 显式导出 `__wb` 契约 |
| R2-2 | 拆分 main.js（S16） | ❌ 未做 | main.js 现 1584 行（较 R2 反而增长），探针模板仍与运行时混排 → 见 R3-3 |
| R2-3 | `patchSettings` 回写权威值 | ⚠️ 部分 | state 漂移已消除；但**控件未同步**，被拒绝值仍显示在 UI → 见 R3-1 |
| R2-4 | `toast` 用 classList | ✅ 已修 | `classList.remove('ok','err')` + `add(kind)`，不再整体覆盖 className |
| R2-5 | `.gitignore` 增 `abtest/` | ✅ 已修 | 已加入；另见 `logs/`、`captures/` |
| R2-6 | 白板强度滑块区间钳位 | ✅ 已修 | HTML `min=100 max=320`，`Number(v)/100` 恒 ≥1.0，原「低于 min 被夹回 1.8」问题不再可能 |
| R2-7 | `assertCropperCompat` 字段校验 | ✅ 已修 | 去除对惰性创建的 `action` 的存在性检查，改查 `limited/pointers/cropBoxData.*/canvasData/containerData` |
| R2-8 | `cropperToDataUrl` 轮询兜底 | ⚠️ 保留（可接受） | 12×150ms 轮询作为防御性兜底保留并加了注释；正常路径已 await ready，属冗余但无害 |
| R2-9 | smoke 输出目录 | ✅ 已修 | `image:save` 支持 `outputDir` 覆盖，且经 `isInsideDir(override, app.getAppPath())` 校验，越界回退用户目录 |

---

## 二、本轮新发现

### R3-1 [P1] `patchSettings` 回写了 state，却没有同步 UI 控件
**位置**：`renderer/app.js` L76-94；`electron/main.js` L273-288

主进程 `settings:patch` 对非法/超限值**保持旧值**并返回权威 `settings`；渲染层 `patchSettings` 据此把 `state.settings[key]` 还原为旧值（正确）。**但对应控件仍显示用户刚提交的、被拒绝的值**：

- `#prefixInput` / `#templateInput`：超长被拒后，输入框停留在坏值，`state` 已还原 → 保存实际用的是旧值，界面显示的是坏值，用户误判"已生效"。
- `#formatSelect` / `#exportScaleSelect` / 各复选框同理。

**建议**：当检测到规范化/拒绝（`next[key] !== patch[key]`）时，把控件也拉回权威值。最小改动：

```js
patchSettings(patch).then((next) => {
  if (!next) return next;
  let reverted = false;
  for (const key of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) continue;
    if (next[key] !== patch[key]) {
      console.warn(`[settings] 主进程规范化/拒绝了 ${key}:`, patch[key], '→', next[key]);
      reverted = true;
    }
    state.settings[key] = next[key];
  }
  if (reverted) syncControlsFromSettings(); // 让 UI 与权威 state 重新对齐
  return next;
});
```
> 注意：良性规范化（见 R3-4）也会触发，配合 R3-4 降噪后再用。

### R3-2 [P3] `assertCropperCompat` 缺少入参空值防护
**位置**：`renderer/app.js` L311、L384

`ready` 回调里 `assertCropperCompat(instance || state.cropper)`：在 `new Cropper(...)` 构造返回前，`instance` 仍为 `null`，且 `state.cropper` 要到 L393 才赋值。若某条路径下 `ready` 在构造函数内**同步触发**，则 `null || null → null` 传入，`typeof cropper.limited` 立刻抛错。cropperjs 实际异步触发 `ready`，概率极低，但应廉价加固：

```js
function assertCropperCompat(cropper) {
  if (!cropper) return false; // 新增
  const missing = [];
  ...
}
```

### R3-3 [P3] 结构：main.js 探针与运行时混排（R2-2/S16 未完）
`--abtest/--shapes/--audit/--smoke` 的大量 `executeJavaScript` 模板字符串（L480-1000+）与主进程生命周期、IPC handler 同处一文件。虽已用 `IS_DEV_TOOLS` 门控，但可读性/可维护性差。**建议**把四类探针模板拆到 `electron/dev/probes/*.mjs`（导出纯字符串/函数），main.js 仅 `require` + 门控调用。属重构、非缺陷，可在下个维护窗口做。

### R3-4 [P3] 良性规范化被记为"漂移/拒绝"日志噪声
`exportScale` 手动选择时，`<select>` 提交字符串 `'2'`，validator 规范化为数字 `2`；R3-1/R2-3 的 `next[key] !== patch[key]` 判定为"漂移"并 `console.warn`。这是**预期的类型归一**，不是错误。**建议**在告警前对"同值异型"（`String(a) === String(b)`）做豁免，或让 `exportScaleSelect` 直接提交数字，避免每次选手动倍率都刷日志。

### R3-5 [nit] preload.js JSDoc 缩进错位
`electron/preload.js` L11-14 块注释内 `* payload ...` 顶格、与上下文缩进不一致，纯样式，顺手对齐即可。

### R3-6 [nit] app.js 惰性残留字段
`pan.prevMode`（L35）自 pan 逻辑改写后不再被引用，可删除以免误导。

---

## 三、正确性抽查（本轮均已核对通过）

- **image:save 覆盖目录**：`isInsideDir(override, app.getAppPath())`，越界仅 `warn` 并回退用户 `outputDir`，未削弱 R2 的目录约束 ✅
- **screen:capture 等比缩放**：`k = Math.min(1, 3840/width, 2160/height)`，不再把 16:9 截成 4:3 ✅
- **sanitizeName**：尾点/空格 `replace(/[. ]+$/g,'')` + 保留设备名前缀 `_`，单测覆盖 ✅
- **SETTINGS_VALIDATORS**：逐键白名单/范围，非法返回 `null` 保旧值，`settings:patch` 返回完整权威 settings ✅
- **CSP**：`index.html` 无 `style=` / `onclick=` 内联（grep 0 命中），与 `script-src 'self'` 收紧一致 ✅
- **`__wb` 契约**：app.js 显式导出 `applyWhiteboard/loadImageIntoCropper/cropperToDataUrl/patchSettings/getCropper/getSettings` 等，探针不再依赖隐式全局名 ✅

---

## 四、总体评价

R2 的 9 项中 7 项完全落地、2 项为可接受保留/延后重构；核心数据一致性（`patchSettings` 回写、`image:save` 目录校验、探针接线）显著收紧，测试全绿。**唯一值得本轮就修的实质问题是 R3-1（回写后 UI 未同步）**，其余为健壮性小项与结构重构。代码已进入"低风险维护"阶段。

## 五、建议处理顺序

1. **R3-1**：`patchSettings` 回写后在值被还原时调用 `syncControlsFromSettings()`（配合 R3-4 降噪）。
2. **R3-2**：`assertCropperCompat` 加 `if (!cropper) return false;`。
3. **R3-4 / R3-5 / R3-6**：日志与样式清理。
4. **R3-3**：main.js 探针模块化（择期重构）。
