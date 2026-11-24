# 排障与踩坑记录

本文件收录项目在 **构建打包 / 运行环境 / 交互行为 / 白板识别** 四类场景中实际遇到的问题、根因分析与修复方式，用于回溯与回归验证。

README 只保留「功能与用法」，这里是「为什么这么改」的档案。已修的问题保留原始分析，不删历史。

> 记录格式：现象 → 根因 → 处理 → 验证方式。

---

## 1. 构建与打包

### 1.1 安装包启动即报 `NSIS Error: Error writing temporary file`

**现象**：双击 `VerticalCamStudio-Setup-0.1.0.exe` 弹出 NSIS 错误框；便携版同样无法解压；`win-unpacked` 里的 exe 也可能点了没反应。

**根因**：安装包所在目录被本地安全沙箱标记为 **Low 完整性**。本机 `H:\tmp` 带：

```
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
Everyone:(CI)(DENY)(S,DC)
```

NSIS 安装器解压、清理解压临时文件时以普通 Medium 权限访问该目录，被完整性策略拒绝，于是报错退出（exit 2）。**与包内容、压缩算法、文件名中英文、载荷大小均无关。**

**对照实验（已实测）**：

| 位置 | 结果 |
| --- | --- |
| 同一 exe 放 C 盘任意目录 | exit 0，安装正常 |
| 同一 exe 放 H: 根目录新建普通文件夹（`H:\vc-dist`） | exit 0，安装正常 |
| 38KB 最小 NSIS 包放 `H:\tmp` | 同样报 `Error writing temporary file` |
| 普通 `notepad.exe` 放 `H:\tmp` | 正常运行（仅 NSIS 受影响） |

**处理**：

- 永久修复（**2026-11-24 已执行成功**）：管理员 PowerShell 执行 `icacls H:\tmp /setintegritylevel M`，输出 `processed 1 file; Failed processing 0 files`。修复后：
  - `H:\tmp` 的完整性标签变为 `Medium Mandatory Level`；
  - 子目录继承的 `Everyone:(CI)(DENY)(S,DC)` 不再出现，release 等子目录 ACL 干净；
  - 安装包直接放在 `H:\tmp\vert-cam-studio\release` 静默安装 exit=0，装出的应用正常启动；
  - electron-builder 单遍 `npm run dist` 也能直接通过卸载器步骤（见 1.3）。
- 临时方案（修复前的绕过方式）：把安装包复制到普通完整性目录再运行。

**ACL 修复笔记**：

- `icacls H:\tmp /remove:d Everyone` 只能去掉 DENY ACE，**改不动完整性标签**（需要管理员令牌）；
- `icacls H:\tmp /setintegritylevel M` 需要**提升权限的管理员终端**执行，普通终端报"拒绝访问"；
- `/setintegritylevel` 不带 `(OI)(CI)` 时只作用于该文件夹自身，子目录靠继承获得干净的 ACL —— 实测子目录修复后不再带任何 Mandatory Label 与 DENY 项。

---

### 1.2 `Invalid command: "?;"` —— `build/installer.nsi` 被误当自定义脚本

**现象**：用 electron-builder 标准流程构建时，makensis 报 `Invalid command: "?;"  line 78`。

**根因**：electron-builder 会把 `buildResourcesDir`（默认 `build/`）下的 `installer.nsi` 自动识别为**自定义安装脚本**，用它整个替换内置标准模板。我们的手写脚本带 UTF8 BOM，拼接进共享头之后 BOM 变成 `?;`，编译器把它当成一条命令。

**处理**：手写脚本改名为 `build/installer-manual.nsi`，electron-builder 不再自动识别，走标准模板。

---

### 1.3 卸载器生成步骤必然失败 → 两遍构建

**现象**：electron-builder 构建到生成卸载器阶段失败，或卡住不动。

**根因**：electron-builder 生成卸载器的做法是「先产出一个临时安装器，再运行它、取出它释放的 `__uninstaller-*.exe`」。这一步要在输出目录（本机 `release/`，位于 `H:\tmp` 下）执行安装器——正是 1.1 的 Low 完整性问题，必然失败。

**处理**（`scripts/dist-nsis.mjs`，即 `npm run dist:nsis`）：

> **2026-11-24 更新**：`H:\tmp` 完整性修复后，单遍 `npx electron-builder --win nsis` 已实测可直接通过卸载器步骤（日志出现 `signing ... path=release\__uninstaller-*.exe`），本 workaround **不再是必需**，保留作为其他受限环境的后备方案。

1. 第一遍构建，产出携带卸载器的中间安装器（失败可忽略）；
2. 把中间安装器复制到系统 TEMP（C 盘，普通完整性），以 `/S` 静默执行，在 `release/` 下生成 `__uninstaller-*.exe`；
3. 第二遍构建，检测到卸载器已存在即跳过执行，直接产出带卸载器的最终安装包；
4. 自动运行 `scripts/verify-installer.mjs` 校验产物。

脚本对 `node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js` 的临时补丁**自动打上并还原**，不改动依赖的持久状态。

---

### 1.4 点「仍要运行」后无任何反应（asar 完整性校验失配）

**现象**：SmartScreen 放行后程序静默退出，任务管理器里一闪而过，无报错。

**根因**：Electron 38 默认对 `app.asar` 做完整性校验，exe 内写死了 asar 的 SHA256。一旦 exe 与 asar 不是同一次构建产出（中途用 rcedit 改过 exe、或先 `--dir` 再手动 makensis 混用了新旧 asar），hash 失配即静默退出。

**处理**：`package.json` 的 `build` 中设 `"asar": false`，代码以明文 `resources/app/` 目录发布，不进入 asar 校验环节（参考同类可正常运行的 Electron 项目配置）。

**排查**：看 `release/win-unpacked/resources/` 下是 `app/` 目录还是 `app.asar` 文件。若是 `app.asar`，说明 `asar:false` 未生效，需重建。

**重建纪律**：exe 与 app 内容必须来自同一次构建。`--dir` 产出 `win-unpacked` 后，portable / NSIS 会重新打包 `win-unpacked`，所以 makensis 必须在**最后一次** `--dir` / portable 之后执行。

---

### 1.5 不要对已编译的 NSIS 安装包跑 rcedit

**现象**：90MB 的 Setup.exe 变成 51KB，双击无效。

**根因**：rcedit 写版本信息时会重写 PE 头并重排节表，把 NSIS 追加在文件尾部的安装数据整段丢弃，文件被截断。同理，用 rcedit 改中间 exe 也会破坏 asar integrity（见 1.4）。

**处理**：

- 安装包编译完成后不再做任何 PE 改写；
- 版本信息在构建前写入，或直接用 electron-builder 的 `signAndEditExecutable: false` 跳过 rcedit（本机写入版本信息被拒，已关闭）。

---

### 1.6 中文 productName / description 导致 NSIS 模板编译失败

**现象**：`productName: "垂直摄像头工作室"` 时，编译报 `Invalid command: "?;"`，安装界面文字变问号。

**根因**：NSIS 编译器在非 UTF8 代码页下处理 `!define PRODUCT_NAME "中文"`，中文被转成 `?`。

**处理**：构建侧的 `productName`、`description`、`shortcutName`、`artifactName` 全部使用 ASCII（`Vertical Cam Studio`）。应用窗口标题、界面文案仍由渲染层保持中文，不受影响；安装向导界面为英文。

---

### 1.7 首次运行弹出蓝色「Windows 已保护你的电脑」

**现象**：SmartScreen 拦截，提示"未知发布者"。

**根因**：构建未做代码签名（日志 `no signing info identified, signing is skipped`），exe 的 Signature 为 `NotSigned`，Windows 对未签名的新程序默认拦截。

**处理**：点「更多信息」→「仍要运行」。首次放行后 Windows 会记住该文件，一般不再提示。彻底消除需购买 OV/EV 代码签名证书并在打包时配置签名（EV 证书可立即建立 SmartScreen 声誉）。

---

### 1.8 每次构建的产物校验（防截断）

**背景**：曾出现「51KB 截断包」静默通过构建的情况（见 1.5）。

**做法**：`scripts/verify-installer.mjs`，挂接在 `npm run pack` / `npm run dist` / `npm run dist:nsis` 末尾，也可 `npm run verify` 单独执行。检查项：

| # | 检查 | 判定 |
| --- | --- | --- |
| ① | `build/installer-manual.nsi` 源脚本大小 | 1KB ~ 200KB；过小=被清空/截断，过大=误写入二进制 |
| ② | 每个 exe 产物大小 | ≥ 1MB |
| ③ | exe 头部标识 | 前 64KB 含 `Nullsoft` |
| ④ | 与解包目录比例 | 安装包体积 ≥ `win-unpacked` 的 15% |
| ⑤ | 主程序 | `win-unpacked` 内主 exe 存在 |

任一不满足即退出码非 0，中断发布。

---

### 1.9 离线 / 受限环境的备用打包方式

若 `npm run dist` 在下载 Electron 或执行卸载器步骤卡住（无头 / 沙箱环境常见），可复用本地已解压的 Electron 运行时与 NSIS 工具分两步生成：

```bash
# 1) 生成免安装目录（electronDist 指向本地已解压的 electron-v38.3.0-win32-x64）
npx electron-builder --dir --win --x64 -c.electronDist="C:\Users\<user>\AppData\Local\Temp\elec-run"

# 2) 用 NSIS 直接编译（脚本内 PROJECT_DIR 按实际路径调整）
makensis build/installer-manual.nsi
```

> `-c.electronDist` 可绕开 GitHub 下载被拒的问题。

**备用脚本的压缩设置**：`SetCompressor zlib`（非 solid）。早期用 `SetCompressor /SOLID lzma` 时，部分机器运行安装包也弹 `Error writing temporary file`——SOLID 把 300MB+ 载荷压成单一数据流，解压时对临时目录压力与容错要求高；zlib 分块压缩兼容性更好，代价是包体从 87MB 增至 120MB。electron-builder 标准流程（7z/lzma 分块）不受此影响。

---

### 1.10 产物清单（`release/`）

| 文件 | 说明 |
| --- | --- |
| `VerticalCamStudio-Setup-0.1.0.exe` | electron-builder 标准 NSIS 安装包（约 85MB），桌面 / 开始菜单快捷方式，可在「应用和功能」卸载 |
| `VerticalCamStudio-Setup-0.1.0.exe.blockmap` | 增量更新块映射，可忽略 |
| `win-unpacked/` | 免安装程序目录，主 exe 可直接运行 |

> 早期手写脚本产物名为「垂直摄像头工作室 Setup 0.1.0.exe」，已随 ASCII 化改造废弃。

---

## 2. 开发与运行环境

### 2.1 electron 启动即崩：`Cannot read properties of undefined (reading 'whenReady')`

**根因**：环境变量 `ELECTRON_RUN_AS_NODE=1` 存在时，electron 退化成纯 Node，没有 `app` 对象。

**处理**：`Remove-Item Env:ELECTRON_RUN_AS_NODE`（`start.cmd` 已内置清理）。命令行跑测试同理：先清掉 `ELECTRON_RUN_AS_NODE` 与 `NODE_OPTIONS`。

### 2.2 electron 崩溃 `0x80000003` / `0xC0000005`

两种成因：

1. 特定 electron 版本与本机图形/驱动组合冲突（实测 v32.3.3 崩、v38.3.0 正常）→ 项目锁定 `electron@^38.3.0`；
2. 从被监控 / overlay 的盘（如本机工作区 H: 盘）启动会崩，同一份二进制换到 C 盘就正常 → 把 `node_modules\electron\dist` 整目录复制到 `%TEMP%\elec-run` 后再启动（`start.cmd` 自动处理）。

### 2.3 npm 相关（国内网络 / 受限环境）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `npm install` 卡在 electron 下载 | electron 二进制来自 GitHub Releases | `set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/` 后再装 |
| `npm install` 报 `EPERM ... npm-cache` | npm 缓存目录不在可写范围 | 加 `--cache <项目内目录>` |
| `npm` 报管道 `Access to the path '\\.\pipe\...' is denied` | 受限环境下进程 stdout 管道不可用 | `cmd /c "npm install > out.log 2>&1"` |

### 2.4 `start.cmd` 的体检逻辑（为什么需要它）

依次执行：

1. 清除 `ELECTRON_RUN_AS_NODE`；
2. 体检 `node_modules\electron`，不可用则试 `%TEMP%\elec-run` 镜像；
3. 都不可用时把 `node_modules\electron\dist` 复制到 `%TEMP%\elec-run` 再启动。

对应 2.1 / 2.2 两个坑的自动绕过。

---

## 3. 交互行为

### 3.1 裁剪框拉满后画不出新选区

**现象**：裁剪框撑满整个画面后，在框内拖动无法新建选区。

**根因**：cropperjs 原生行为——新建选区只能在裁剪框**之外**发起，框占满后外围没有可拖区域，内部拖拽又被钳位成"无效移动"。

**现行交互绕开方式**：

1. 默认固定「截取模式」：直接拖动即可拉取新选区，任何位置都能发起，框拉满也不受影响；
2. 点徽标固定「拖动模式」后：直接拖动即平移背景，需要临时框选时按住 `Ctrl`；
3. 拖选区边角控制点 = 原生微调（控制点不被手势拦截）。

> 早期版本有「选区复位」按钮专门对付"框拉满卡死"，改为左键随处可画之后已移除。

### 3.2 Ctrl 拖动之后裁剪框与鼠标错位（已修）

**现象**：按住 Ctrl 拖动画面后松开，再框选时选框与实际鼠标位置偏移（实测 66.8px）。

**根因**：cropperjs 会把裁剪框**钳位在图片范围内**（`limitCropBox`：`minLeft = max(0, canvasData.left)`、`maxLeft = min(容器宽, canvasLeft + canvasWidth) - 宽`）。画布被拖动后整体位移，这套钳位区间随之变化，我们按鼠标写入的坐标被**二次挪走**。

**修法**（`renderer/app.js` 的 `updateSelect` / `endSelect`）：

1. 拖动过程中临时关闭 cropperjs 的位置与尺寸钳位，选区**严格跟随鼠标**（偏移 0）；
2. 松手时把选区收敛回「图片 ∩ 容器」可见区域，并 toast 提示「选区超出画面，已收敛到可见区域」；完全落在画面外则复位为默认框；
3. 锁定宽高比时，收敛后的选区仍满足比例。

**回归用例**：`npm run smoke` 的 `panSelectProbe` 模拟「Ctrl 拖动 → 松开 → 左键框选」，校验拖动中偏移为 0（起点在图片上 / 在空白区两种情形）以及松手后选区落在画面内。

### 3.3 画面拖不动的排查顺序

1. 确认在**右侧裁剪区**操作（左侧是实时预览，不支持裁剪）；
2. 右键按住拖动时光标应变 `grabbing`；无反应多半是还没加载图片（先拍照 / 截图）；
3. 画布位移有物理边界，cropperjs 会把画面限制在裁剪框范围内，避免拖丢；
4. 画面被完全拖出视野时，按「复位」回到初始视图。

### 3.4 无图状态下裁剪区中心文字重叠（已修）

**根因**：`<img alt="待裁剪画面">` 没有 `src` 时浏览器会渲染 alt 文本，与占位提示文字叠在一起。

**处理**：`.crop-stage img:not([src]) { display: none; }`，同时裁剪态下隐藏整个裁剪台。

---

## 4. 白板 / 识别

### 4.1 为什么绝对值 `||` 会被读成 `[]`？

**复现方式**：`audit.cmd "000.jpg" "111.jpg"`（第 1 个参数=原图，第 2 个=程序实际产出）。

从**原图**出发的实测结果（Qwen3-VL-4B，427×571 真实白板题）：

| 变体 | 竖线边缘灰阶 | (1) | (2) | (3) | (4) | (5) |
| --- | --- | --- | --- | --- | --- | --- |
| 原图 / 灰度 / JPEG q92 | 161 | `-|-11|` ✅ | ✅ | ✅ | ✅ | ✅ |
| 对比度 1.4 / 1.6 / 1.8 | 181 | `-|-11|` ✅ | ⚠️ | ✅ | ✅ | ✅ |
| **对比度 3.2** | 237 | `-[-11]` ❌ | ⚠️ | ✅ | ✅ | ✅ |
| **硬二值化** | 255 | `-[-11]` ❌ | ⚠️ | ✅ | ✅ | ✅ |
| **111.jpg（实际产出）** | **203** | `-[-11]` ❌ | ⚠️ | ✅ | ✅ | ✅ |
| 软二值化（保留灰阶） | — | `-|-11|` ✅ | ⚠️ | ✅ | ✅ | ✅ |
| **放大 2×（任意管线）** | — | `-|-11|` ✅ | ✅ | ✅ | ✅ | ✅ |
| **应用实际顺序**（放大 2× → 对比度 1.6 → JPEG q92） | — | `-|-11|` ✅ | ✅ | ✅ | ✅ | ✅ |

最后一行是**程序当前真实走的顺序**（`cropperToDataUrl()`：先放大 → 再白板化 → 再编码），与「先对比度后放大」的变体不是一回事，所以另做 `apporder_x2*` 变体验证：**现版本管线在原图上实测五题全对**。

`111.jpg` 的羽化灰阶 203（介于 1.8× 的 181 与 3.2× 的 237 之间），说明它是**更早版本**的产物、对比度被叠加过；把 `111.jpg` 本身再放大 2×（`compare_x2.png`）也能读回 `-|-11|` ✅。

**机制**：题面是 `-|-11|`，减号紧贴绝对值左竖线。白板上这根竖线只有 2~3px 宽，边缘仅 1px 抗锯齿羽化（灰阶 161）。对比度增强把羽化灰阶推向白色（161 → 181 → 203 → 237 → 255），竖线有效宽度被压到只剩 1px 核心，视觉编码器无法确认"这是一根竖线"，于是和左边减号连读成 `[`。放大 2× 后过渡带与核心宽度翻倍，问题消失。

### 4.2 对策（已落实在程序里）

- **导出倍率 = 自动**（设置 → 白板与识别）：裁剪块长边不足 1200px 时按 1~3× 放大再保存；对已产出的劣化图放大 2× 也能救回，最稳的一招；
- **白板强度 ≤ 1.8**：3.2× 会直接触发误读；
- **开启「保留抗锯齿边缘」**（软阈值）：阈值两侧保留灰阶过渡；
- 小字号手写建议**不开二值化**（硬阈值会把 `|8-11|` 读成 `i8-11i`、`(-7)` 的圆括号直接丢失）。

### 4.3 `--audit`：用真实图片做白板管线 A/B

拿一张实际出问题的截图，跑 20 个变体并逐张喂给本地 VLM，打印对照表。

**第 1 个参数必须是未处理的原图**（基准），**第 2 个参数是程序实际产出的图**（对照）：

```cmd
REM 本机
audit.cmd "D:\原图\000.jpg" "D:\产出\111.jpg"
```

输出示例：

```
[audit] 原图: D:\原图\000.jpg 尺寸 427x571
[audit] 对照(程序实际产出): D:\产出\111.jpg 尺寸 427x571
[audit] raw.png              | 一、化简：（1）-|-11| ...
[audit] contrast16_q92.jpg   | 一、化简：（1）-|-11| ...
[audit] compare_asis.png     | 一、化简：（1）-[-11] ...   <-- 实际产出翻了
[audit] compare_x2.png       | 一、化简：（1）-|-11| ...   <-- 放大 2× 救回
```

变体图写到 `abtest/audit_*.png`，可直接肉眼比对。VLM 端点可用环境变量 `VLM_ENDPOINT` 覆盖（默认 `http://127.0.0.1:8080`）。

**配套像素分析脚本**：

```bash
node scripts/png-ascii.mjs <png> x y w h     # 区域像素字符画
node scripts/analyze-line.mjs <png> y0 y1    # 自动切分笔画
node scripts/profile-row.mjs <png> y x0 x1   # 灰阶剖面
```

### 4.4 二值化把整张图判成白

**根因**：Otsu 阈值常落在暗类边缘（如 t=32），判定用 `gray > t` 时最深的笔画被判成白色。已改为 `>` 严格比较并配软阈值选项。

### 4.5 白板强度 1.00× 时等于没开白板

早期版本在强度为 1.00× 时直接跳过处理（等于功能失效），已修：现在始终执行灰度化，强度只影响对比度倍率。

---

## 5. 历史文档索引

| 文件 | 内容 |
| --- | --- |
| `docs/CODE_REVIEW.md` | 第 1 轮代码审查 |
| `docs/CODE_REVIEW_R2.md` | 第 2 轮代码审查 |
| `docs/CODE_REVIEW_R3.md` | 第 3 轮代码审查 |
| `docs/CODE_REVIEW_R4.md` | 第 4 轮深度审查 |
| `docs/CODE_REVIEW_R5.md` | 第 5 轮深度审查 |
| `docs/FIX_PLAN.md` | 按审查结论排出的修复计划与完成情况 |
