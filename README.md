# 垂直摄像头工作室 (VerticalCam Studio)

面向「摄像头物理竖装」场景的 Windows 桌面小工具：**拍照 / 屏幕截图 → 缩放 → 旋转 → 裁剪 → 保存到指定文件夹**。

全链路 **MIT 许可**（Electron + cropperjs），可自由闭源商用与分发，不受 GPL 传染。

---

## 功能对照

| 需求 | 实现 | 说明 |
| --- | --- | --- |
| 垂直摄像头拍照 | `renderer/app.js` `captureCanvas()` | 预览与出图统一应用 0/90/180/270° 物理旋转校正，竖装摄像头选 90° 或 270° 即摆正 |
| **工作区动态切换** | `renderer/app.js` `setWorkspaceMode()` | 默认拍照态：实时预览占主区、裁剪台收成右侧竖栏；拍照/截图/导入图片后自动换为裁剪态：预览收成左侧竖栏、裁剪台展开。点竖栏或「重新拍摄」可切回，裁剪结果保留 |
| 摄像头旋转 | 左侧实时预览下方「物理旋转校正」按钮组 | 旋转/镜像实时作用于预览，拍照时烘焙进位图 |
| 屏幕截图 | `electron/main.js` `screen:capture` | 截取鼠标所在显示器画面并送入裁剪台（多屏时先移动鼠标到目标屏幕） |
| 图片放大缩小 | cropperjs `zoom(±0.1)` / 滚轮 / 双指 | 「＋/－/复位」按钮 |
| 图片旋转 | cropperjs `rotate(±90)` / `scaleX` 翻转 | 「↺90° / ↻90° / 水平翻转」 |
| **模式切换** | **点击「裁剪/缩放/旋转」标题右侧的模式徽标** | 在「✂ 截取」「✋ 拖动」两个固定模式间切换，再点切回；可一直使用同一模式 |
| **临时反向** | **按住 Ctrl** | 临时切到另一种模式，松开回到点击固定的模式 |
| **拖动画面（平移）** | 固定拖动态下直接拖动，或按住 Ctrl 拖动 | 放大后画面超出窗口时用它把背景拖回来 |
| **截取选区** | 固定截取态下直接拖动，或按住 Ctrl 再点一次徽标 | 裁剪框拉满后也能随时重新框选 |
| 裁剪 | cropperjs 拖拽选框 + 比例锁定 | 自由 / 16:9 / 4:3 / 3:4 / 1:1 / 原图 |
| **白板模式** | 灰度化 + 对比度增强（可选 Otsu 二值化） | 保存前对裁剪结果做像素级处理，提升 OCR/识别效率 |
| **导出倍率** | `renderer/app.js` `resolveExportScale()` | 裁剪块太小时按 1~3× 放大再保存，实测可把 `\|\|`→`[]` 的误读率清零 |
| 保存到指定文件夹 | `electron/main.js` `dialog:selectFolder` | 设置页「输出目录」卡片点「选择…」任选目录，配置持久化到 `userData/settings.json`；同名文件自动加 `-1/-2` 后缀。主界面「比例」组右侧的「打开」按钮可快速打开该目录 |

额外：文件名模板（`{prefix}` `{timestamp}` `{date}` `{time}` `{n}`）、JPEG 质量调节、PNG 无损输出、拍照后自动保存、多摄像头切换与热插拔。这些选项都在**独立的「设置…」窗口**中（主界面顶栏右上角入口，修改后自动保存，Esc 或「关闭」退出）。

> 主窗口为**无边框设计**：顶栏空白处可拖动窗口，右上角依次是「设置…」和最小化 / 最大化 / 关闭；双击顶栏空白处也能切换最大化。设置窗口仍保留系统标题栏。

> **`{n}` 的语义**：本次运行（会话）内的保存计数器，从 1 开始递增，重启应用后归零。
> 真正的去重靠保存时自动追加的 `-1` / `-2` 后缀（`shot_20261120-181624.jpg` → `shot_20261120-181624-1.jpg`），
> 所以 `{n}` 只用于让一批文件在名称上可区分，不要依赖它做唯一性保证。

---

## 运行

### 方式一：双击启动（推荐，免敲命令）

双击项目目录下的 **`start.cmd`**。脚本会自动体检 electron 并选择可用的那一份：

- 清除 `ELECTRON_RUN_AS_NODE`（不清会让 electron 退化成纯 Node，启动即崩）
- 依次体检 `node_modules\electron` → `%TEMP%\elec-run` 镜像
- 都不可用时，自动把 `node_modules\electron\dist` 复制到 `%TEMP%\elec-run` 再试

> 本机实测：`node_modules` 里的 electron.exe 从 H: 盘启动会崩（`0x80000003`），同一份二进制换到系统盘 `%TEMP%` 就正常——`start.cmd` 会自动绕过。

### 方式二：npm（换到普通机器/换目录后用）

```bash
cd vertical-cam-studio
npm install        # postinstall 会自动把 cropperjs 的 dist 复制到 renderer/vendor/
npm start
```

### 方式三：命令行直启（排障用）

```powershell
# 正常机器
.\node_modules\electron\dist\electron.exe "H:\tmp\vert-cam-studio"

# 本机（H: 盘 electron 会崩时）
Copy-Item .\node_modules\electron\dist\* "$env:TEMP\elec-run\" -Recurse -Force
& "$env:TEMP\elec-run\electron.exe" "H:\tmp\vert-cam-studio"
```

打包（Windows exe）：

```bash
npm run dist       # 输出到 release/，含 NSIS 安装包与便携版
```

> 首次运行会请求摄像头权限，请点「允许」。若设备列表为空，先插好摄像头再点「刷新」。

### 自动自检（无需人工介入）

```bash
npm run smoke
```

会启动应用 → 探测摄像头状态 → 合成一张测试图走完「cropperjs 裁剪 → 保存落盘」全链路 → 截图并写报告到 `smoke/`（`report.json` + `screenshot.png` + `shots/`），然后自动退出。退出码 `0` 表示全链路通过。

### 国内网络 / 特殊环境的坑（实测踩过）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `npm install` 卡在 electron 下载 | electron 二进制来自 GitHub Releases | `set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/` 后再装 |
| `npm install` 报 `EPERM ... npm-cache` | npm 缓存目录不在可写范围 | 加 `--cache <项目内目录>` |
| `npm` 报管道 `Access to the path '\\.\pipe\...' is denied` | 受限环境下进程 stdout 管道不可用 | 用 `cmd /c "npm install > out.log 2>&1"` |
| electron 启动即崩 `TypeError: Cannot read properties of undefined (reading 'whenReady')` | 环境里设了 `ELECTRON_RUN_AS_NODE=1`，electron 退化成纯 Node | `Remove-Item Env:ELECTRON_RUN_AS_NODE` |
| electron 启动崩 `0x80000003` / `0xC0000005` | ① 特定 electron 版本与本机图形/驱动组合冲突（实测 v32.3.3 崩、v38.3.0 正常）；② 从被监控/overlay 的盘（如某些工作区的 H: 盘）启动会崩，同一份二进制换到 C 盘即正常 | ① 换版本，本项目锁定 `electron@^38.3.0`；② 把 `node_modules\electron\dist` 整目录复制到 C 盘临时目录后再启动 |

---

## 目录结构

```
vertical-cam-studio/
├── electron/
│   ├── main.js          # 窗口、设置持久化、文件夹选择、保存文件、屏幕截图
│   └── preload.js       # contextBridge 暴露的受限 API
├── renderer/
│   ├── index.html       # 主界面（含 CSP）
│   ├── settings.html    # 独立设置窗口页面（含 CSP）
│   ├── styles.css       # 暗色主题
│   ├── app.js           # 预览 / 拍照 / cropperjs / 保存
│   ├── settings.js      # 设置窗口的控件绑定与写回
│   ├── core.js          # 主进程与渲染层共用的纯函数（文件名、Otsu、统计）
│   └── vendor/          # postinstall 自动生成（cropperjs.min.js|css）
├── scripts/
│   ├── copy-vendor.mjs  # 复制 cropperjs dist → renderer/vendor
│   ├── png-ascii.mjs    # PNG → 字符画（白板笔画分析）
│   ├── analyze-line.mjs # 行内笔画切分
│   ├── profile-row.mjs  # 灰阶剖面
│   └── vlm-ocr.mjs      # 本地 VLM 批量 OCR 对照
├── test/
│   └── core.test.js     # 纯函数单测（node --test）
├── CODE_REVIEW*.md      # 五轮代码审查报告
├── start.ps1 / start.cmd / audit.cmd  # 启动与自检脚本
├── package.json
├── logs/                 # 历史调试日志（非必需，可随时删）
└── LICENSE              # MIT
```

### 安全边界（已加固）

| 项 | 做法 |
| --- | --- |
| 渲染进程 | `contextIsolation: true` + `nodeIntegration: false` + **`sandbox: true`**，preload 只暴露 `contextBridge` 白名单 API |
| CSP | `default-src 'self'; base-uri 'self'; object-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'`（无 `unsafe-inline`） |
| 外部链接 | 只放行 `http:` / `https:`，其余协议一律拒绝 |
| 摄像头权限 | 仅对本地 `file://` 页面放行 `media` / `display-capture` |
| 打开文件 | `shell:openPath` / `showItemInFolder` 只允许**输出目录之内**的路径，且文件类型限图片/文档 |
| 设置写入 | `settings:patch` 逐键校验（路径必须绝对、格式/倍率白名单、质量与对比度范围），非法值直接丢弃 |

### 依赖版本

`cropperjs` **精确锁定 `1.6.2`**：本项目的「Ctrl 拖动平移」和「左键框选严格跟随鼠标」依赖 cropperjs 的
若干非公开字段（`limited`、`cropBoxData.min*/max*`、`action`、`pointers`），浮动版本会静默破坏这两处交互。
启动时 `assertCropperCompat()` 会检查这些字段是否还在，缺失会给出告警。

### UI 使用统计（纯本地）

所有按钮点击（含「导入图片」标签、旋转按钮、快捷键 Space / Ctrl+S）都会记一份本地统计，**不联网、不上传**：

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `ui-usage.json` | `app.getPath('userData')` | 聚合数据：`total`、按天总数 `days`、每个按钮的 `count` / `first` / `last` / `days`；其中 **`days` 映射只留最近 90 天，`total` 与 `count` 为累计值** |
| `ui-usage.log` | 同上 | 明细日志：每次点击一行 JSON `{"t":"ISO 时间","id":"按钮标识"}`，800ms 防抖批量写入，超过 512KB 时只保留最近 2000 行 |

按钮标识用元素 `id`（如 `btnShot`），旋转按钮用 `rot0/rot90/rot180/rot270`，导入标签用 `importImage`；
快捷键复用对应按钮的标识，方便按功能合并看使用频率。统计文件可在设置页「存储位置」显示的配置目录下找到。

---

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `空格` | 拍照（焦点在按钮上时空格用于激活按钮，不会触发拍照） |
| `Ctrl + S` | 保存裁剪结果 |
| `Ctrl + O` | 打开设置页（输出目录在其中选择） |
| 鼠标滚轮（裁剪区） | 缩放 |
| **点击模式徽标** | 固定模式在「✂ 截取」/「✋ 拖动」间切换，再点切回 |
| **按住 `Ctrl`（裁剪区）** | 临时切到另一种模式，松开回到固定模式 |
| 拖选区边角控制点 | 微调选区大小（原生 cropperjs 行为） |

> 交互：**点击徽标固定一种模式一直用，Ctrl 临时反向**。裁剪区徽标实时显示当前模式，光标同步变化（十字 ↔ 手型）。默认固定为截取模式。

### 裁剪框拉满后画不出新选区？

这是 cropperjs 的原生行为：裁剪框撑满后，内部拖拽被钳位成"无效移动"，而新建选区只能在裁剪框**之外**发起，框占满就无处可拖。

本项目的交互绕开方式：

1. 默认固定「截取模式」：**直接拖动**拉取新选区，任何位置都能发起，裁剪框拉满也不受影响。
2. 点徽标固定「拖动模式」后：**直接拖动**即平移背景，可一直用同一模式；需要临时框选时按住 Ctrl，松开回到固定拖动。
3. **拖选区边角控制点** = 原生微调选区大小（控制点不会被手势拦截）。

> 早期版本还有一个「选区复位」按钮专门对付"框拉满后卡死"，现在左键随处可画新框，已**移除该按钮**。

> 初始选区大小由 cropperjs 的 `autoCropArea` 控制，当前为 `0.46`（图像尺寸的 46%，居中）。

### Ctrl 拖动之后，裁剪框和鼠标对不齐？

**已修。** 原因是 cropperjs 会把裁剪框**钳位在图片范围内**（`limitCropBox`：`minLeft = max(0, canvasData.left)`、`maxLeft = min(容器宽, canvasLeft + canvasWidth) - 宽`）。图片被 Ctrl 拖动后画布整体位移，这套钳位区间跟着变，于是我们按鼠标写进去的坐标会被**二次挪走**（实测偏移 66.8px），表现为框和鼠标错位。

修法（`renderer/app.js` `updateSelect` / `endSelect`）：

1. **拖动过程中**临时关掉 cropperjs 的位置与尺寸钳位，框**严格跟随鼠标**（偏移 0）；
2. **松手时**把选区收敛回画面可见区域（图片 ∩ 容器），并 toast 提示「选区超出画面，已收敛到可见区域」；完全落在画面外则复位为默认框；
3. 锁定宽高比时，收敛后的选区仍满足比例。

> 自检已加回归用例 `--smoke` 的 `panSelectProbe`：模拟「Ctrl 拖动 → 松开 → 左键框选」，分别校验**拖动中偏移为 0**（起点在图片上 / 在空白区两种情形）与**松手后选区落在画面内**。

### 白板模式（提升识别效率）

独立「设置…」窗口的「白板与识别」分组里新增四个开关：

| 选项 | 效果 |
| --- | --- |
| **白板模式** | 开启后，保存前对裁剪结果做**灰度化 + 对比度增强**（R=G=B），彩色标记/投影仪偏色被消除 |
| **白板强度** | 对比度倍率 1.00× ~ 3.20×，默认 1.80×。以 128 为中心做线性拉伸：越强越"黑白分明"，过高会丢失中间调 |
| **二值化** | 用 **Otsu 自动阈值**把画面压成黑白，适合白板手写、投影幕布等高对比场景 |
| **保留抗锯齿边缘** | 默认开启。二值化时不做硬切，阈值两侧保留一段灰阶过渡 |

处理链路：裁剪结果 → Rec.601 灰度 → 对比度增强 → （可选）Otsu 二值化 → 写回 RGB → 编码保存。

裁剪区预览会同步套用同款 CSS 滤镜（`grayscale + contrast`），方便边选边看效果；二值化是保存时才做的，预览不显示硬阈值效果。

> 二值化阈值判定用的是 `gray > t` 而非 `>= t`：Otsu 阈值常落在暗类边缘（如 t=32），用 `>=` 会把最深的笔画判成白色导致整张图全白、笔画丢失。

> 白板强度 = 1.00× 时仍然会做灰度化（早期版本会直接跳过，等于没开白板模式，已修）。

#### 为什么绝对值 `||` 会被读成 `[]`？

**复现方式**：`audit.cmd "000.jpg" "111.jpg"`（第 1 个参数=原图，第 2 个=程序实际产出）。

从**原图**出发的实测结果（Qwen3-VL-4B，427×571 真实白板题）：

| 变体 | 竖线边缘灰阶 | (1) | (2) | (3) | (4) | (5) |
| --- | --- | --- | --- | --- | --- | --- |
| 原图 / 灰度 / JPEG q92 | 161 | `-|-11|` ✅ | ✅ | ✅ | ✅ | ✅ |
| 对比度 1.4 / 1.6 / 1.8 | 181 | `-|-11|` ✅ | ⚠️ | ✅ | ✅ | ✅ |
| **对比度 3.2** | 237 | `-[-11]` ❌ | ⚠️ | ✅ | ✅ | ✅ |
| **硬二值化** | 255 | `-[-11]` ❌ | ⚠️ | ✅ | ✅ | ✅ |
| **111.jpg（你的实际产出）** | **203** | `-[-11]` ❌ | ⚠️ | ✅ | ✅ | ✅ |
| 软二值化（保留灰阶） | — | `-|-11|` ✅ | ⚠️ | ✅ | ✅ | ✅ |
| **放大 2×（任意管线）** | — | `-|-11|` ✅ | ✅ | ✅ | ✅ | ✅ |
| **应用实际顺序**（放大 2× → 对比度 1.6 → JPEG q92） | — | `-|-11|` ✅ | ✅ | ✅ | ✅ | ✅ |

> 上表最后一行是**程序当前真实走的顺序**（`cropperToDataUrl()`：先放大 → 再白板化 → 再编码），
> 与「先对比度后放大」的变体不是一回事，所以单独做了 `apporder_x2*` 变体验证：
> **现版本管线在原图上实测五题全对**。
> `111.jpg` 的羽化灰阶是 203（介于 1.8× 的 181 和 3.2× 的 237 之间），
> 说明它是**更早版本**的产物、对比度被叠加过；把 111.jpg 本身再放大 2×（`compare_x2.png`）也能读回 `-|-11|` ✅。

**机制**：题面写的是 `-|-11|`，减号紧贴绝对值的左竖线。白板上这根竖线只有 2~3 px 宽，边缘只有 1 px 的抗锯齿羽化（灰阶 161）。**对比度增强把羽化灰阶推向白色**（161 → 181 → 203 → 237 → 255），竖线的有效宽度被压缩到只剩 1 px 核心，视觉编码器无法确认"这是一根竖线"，于是和左边的减号连读成 `[`。放大 2× 后过渡带和核心宽度都翻倍，问题消失。

对策（程序里已落实）：

- **导出倍率 = 自动**（`设置 → 白板与识别 → 导出倍率`）：裁剪块长边不足 1200px 时按 1~3× 放大再保存。**对 111.jpg 本身放大 2× 也能救回**，这是最稳的一招。
- **白板强度 ≤ 1.8**：3.2× 会直接触发误读。
- **开"保留抗锯齿边缘"**（软阈值）：阈值两侧保留灰阶过渡。
- 小字号手写建议**不开二值化**（硬阈值把 `|8-11|` 读成 `i8-11i`、`(-7)` 的圆括号直接丢失）。

> 复现命令：`audit.cmd "原图.jpg" "白板图.jpg"`；`node scripts/png-ascii.mjs <png> x y w h` 看像素字符画、`node scripts/analyze-line.mjs <png> y0 y1` 自动切笔画、`node scripts/profile-row.mjs <png> y x0 x1` 看灰阶剖面。

### `--audit`：用你的真实图片做白板管线 A/B

拿一张实际出问题的截图，直接跑 20 个变体并逐张喂给本地 VLM，打印对照表。

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

变体图会写到 `abtest/audit_*.png`，可直接肉眼比对。VLM 端点可用环境变量 `VLM_ENDPOINT` 覆盖（默认 `http://127.0.0.1:8080`）。

### 画面拖不动的排查顺序

1. 先确认在**右侧裁剪区**操作（左侧是实时预览，不支持裁剪）。
2. 右键按住拖动时，光标应变成 `grabbing`；若没反应，多半是还没加载图片（先拍照/截图）。
3. 画布位移有物理边界：cropperjs 会把画面限制在裁剪框范围内，避免把图拖丢。
4. 如果画面被完全拖出视野，按「复位」回到初始视图。

---

## 快捷旋转不靠软件行不行？

如果这台机器上的**所有**应用都需要摆正画面，别用本工具的旋转功能，改用系统级方案：

- 注册表：`HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}` 下每个设备实例的 `Rotation`（0/90/180/270）
- 或直接用现成开源工具 [tadas-subonis/webcam-settings](https://github.com/tadas-subonis/webcam-settings)（MIT）——它专门做 Windows 摄像头方向设置。

本工具的旋转是**应用内**的，不改系统状态，两者可共存。

---

## 许可

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | MIT | 桌面外壳 |
| [cropperjs](https://github.com/fengyuanchen/cropperjs) | MIT | 裁剪/缩放/旋转核心 |

本项目自身 MIT（见 `LICENSE`）。若后续想换成 C++ 原生实现或 Rust（usbscan 路线，注意其为 GPL-3.0），需重新评估分发义务。

---

## 已知限制

- 屏幕截图当前取鼠标所在显示器整屏（缩放到 3840×2160 内），要精确框选建议后续接 `desktopCapturer` + 区域选择层。
- 摄像头画面走 `getUserMedia`（WebRTC），部分 UVC 设备在 Electron 下拿不到满帧率；追求低延迟可换 [wysaid/CameraCapture](https://github.com/wysaid/CameraCapture)（MIT，DirectShow）作为原生采集源。
- 视频流不进 cropperjs：流程是「先拍照得到静态帧，再裁剪」，符合当前需求；若需要实时取景框裁剪，可参考 [Kaiyuan/usbscan](https://github.com/Kaiyuan/usbscan)（GPL-3.0）的实时裁剪框交互，注意其 copyleft 义务。
