# 垂直摄像头工作室 (Vertical Cam Studio)

面向「摄像头物理竖装」场景的 Windows 桌面小工具：**拍照 / 屏幕截图 → 缩放 → 旋转 → 裁剪 → 保存到指定文件夹**。

全链路 **MIT 许可**（Electron + cropperjs），可自由闭源商用与分发。

> 遇到安装失败、运行崩溃、识别不准等问题，见 **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**（按构建 / 运行 / 交互 / 识别分类，含根因与修复记录）。

---

## 快速开始

### 安装版（推荐）

双击 `VerticalCamStudio-Setup-0.1.0.exe` → 按向导安装（可改安装目录）→ 桌面 / 开始菜单启动。

- 首次运行 Windows 可能弹「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」（程序未做代码签名，并非损坏，详见排障文档 1.7）。
- 首次启动会请求摄像头权限，点「允许」。设备列表为空时插好摄像头再点「刷新」。
- 安装包**不要放在** `H:\tmp` 这类被安全策略标记为低完整性的目录里运行，否则 NSIS 会报临时文件错误（详见排障文档 1.1）。

### 免安装版

直接运行 `win-unpacked\Vertical Cam Studio.exe`（整个目录一起拷贝到别处即可使用），不写注册表，适合临时使用或无管理员权限的场景。

需要单文件便携版时可在打包机上执行 `npx electron-builder --win portable`，产物为 `VerticalCamStudio-Portable-0.1.0.exe`（首次解压到临时目录，启动略慢）。

### 源码运行

```bash
npm install     # postinstall 会把 cropperjs 的 dist 复制到 renderer/vendor/
npm start
```

也可双击项目目录下的 `start.cmd`：它会自动清理 `ELECTRON_RUN_AS_NODE`、体检 electron 运行时并在必要时复制到 `%TEMP%\elec-run`（应对映射盘启动崩溃），逻辑见排障文档 2.4。

---

## 使用流程

1. **取图**——三种方式任选：点「拍照」抓一帧、点「截图」截取鼠标所在显示器、或「导入图片」选本地文件。
2. **摆正**——左侧实时预览下方「物理旋转校正」按钮组可 0/90/180/270° 旋转与镜像；竖装摄像头选 90° 或 270° 即摆正，拍照时烘焙进位图。
3. **裁剪**——右侧裁剪台用鼠标框选，配合比例锁定、缩放、旋转与翻转；白板场景可开「白板模式」增强对比度。
4. **保存**——按「保存结果」或 `Ctrl + S`，按设置的文件名模板写入输出目录；右下角弹出缩略图预览（点击放大，5 秒后自动消失，悬停暂停）。

**工作区会自动切换**：默认「拍照态」，实时预览占主区、裁剪台收成右侧竖栏；拍照 / 截图 / 导入图片后进入「裁剪态」，预览收成左侧竖栏、裁剪台展开。点竖栏或「重新拍摄」可切回，裁剪结果保留。

---

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 摄像头拍照 | 实时预览 + 一帧抓拍，支持多摄像头切换与热插拔 |
| 物理旋转校正 | 0/90/180/270° 旋转与镜像，实时作用于预览，拍照时烘焙进位图 |
| 屏幕截图 | 截取鼠标所在显示器画面（多屏时先把鼠标移到目标屏） |
| 裁剪 | 拖拽选框 + 比例锁定：自由 / 16:9 / 4:3 / 3:4 / 1:1 / 原图 |
| 缩放 | 「＋ / － / 复位」按钮、滚轮、双指 |
| 旋转与翻转 | 「↺90° / ↻90° / 水平翻转」 |
| 模式切换 | 点裁剪区标题右侧徽标，在「✂ 截取」「✋ 拖动」间固定切换；按住 `Ctrl` 临时反向 |
| 白板模式 | 保存前做灰度化 + 对比度增强，可选 Otsu 二值化，提升 OCR / 识别效率 |
| 导出倍率 | 自动 / 1× / 2× / 3×；裁剪块过小时自动放大再保存，显著降低小字误读 |
| 输出目录 | 设置页任选目录，配置持久化；主界面「打开」按钮直达该目录；同名文件自动加 `-1/-2` 后缀 |
| 保存预览 | 右下浮动缩略图，点击放大、悬停暂停、5 秒自动消失、可手动关闭 |
| 自动保存 | 拍照后按当前设置直接落盘，适合连续采集 |
| 文件命名 | 模板占位符 `{prefix}` `{timestamp}` `{date}` `{time}` `{n}`，另有 JPEG 质量与 PNG 无损输出 |

> `{n}` 是**本次运行（会话）内**的保存计数，从 1 递增，重启归零。真正的去重靠保存时自动追加的 `-1` / `-2` 后缀（`shot_20261120-181624.jpg` → `shot_20261120-181624-1.jpg`），所以 `{n}` 只用于让一批文件在名称上可区分，不要依赖它做唯一性保证。

---

## 界面与交互

主窗口是**无边框设计**：顶栏空白处可拖动窗口，右上角依次是「设置…」和最小化 / 最大化 / 关闭，双击顶栏空白处也能切换最大化。设置窗口保留系统标题栏。

### 两种交互模式

- **点徽标固定**：裁剪区标题右侧徽标显示当前模式（✂ 截取 / ✋ 拖动），点一下切换并**一直保持**，再点切回。
- **按住 `Ctrl` 临时反向**：松开回到固定模式。光标同步变化（十字 ↔ 手型），默认固定为截取模式。

裁剪框拉满整个画面后仍可直接拖动重画（选区可在任意位置发起）；框边角的控制点用于微调尺寸。细节与历史修复见排障文档第 3 节。

---

## 设置

所有选项在独立的「设置…」窗口（顶栏右上角入口），修改即时生效并自动保存，`Esc` 或「关闭」退出。

| 分组 | 选项 |
| --- | --- |
| 存储位置 | 显示配置目录（`ui-usage.json`、`ui-usage.log`、`settings.json` 所在处） |
| 输出目录 | 保存目标文件夹，点「选择…」更换 |
| 文件命名 | 文件名模板、前缀、JPEG 质量、PNG 无损开关 |
| 拍照 | 摄像头设备选择、拍照后自动保存 |
| 白板与识别 | 白板模式、白板强度（1.00×~3.20×）、二值化、保留抗锯齿边缘、导出倍率 |

白板处理链路：裁剪结果 → Rec.601 灰度 → 对比度增强 → （可选）Otsu 二值化 → 写回 RGB → 编码保存。裁剪区预览会同步套用同款 CSS 滤镜，二值化仅在保存时执行。

---

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `空格` | 拍照（焦点在按钮上时空格用于激活按钮，不触发拍照） |
| `Ctrl + S` | 保存裁剪结果 |
| `Ctrl + O` | 打开设置页 |
| `Esc` | 关闭放大的保存预览 |
| 滚轮（裁剪区） | 缩放 |
| 点击模式徽标 | 固定模式在「✂ 截取」/「✋ 拖动」间切换 |
| 按住 `Ctrl`（裁剪区） | 临时切到另一种模式，松开回到固定模式 |
| 拖选区边角控制点 | 微调选区大小 |

---

## 开发

```bash
npm install        # 安装依赖，postinstall 自动生成 renderer/vendor/
npm start          # 启动应用
npm run dev        # 开发模式（开启调试探针）
npm test           # 纯函数单测（node --test）
npm run smoke      # 端到端自检：摄像头 → 裁剪 → 保存落盘，报告写到 smoke/
npm run vendor     # 手动重新复制 cropperjs dist
```

`npm run smoke` 会启动应用、探测摄像头、合成测试图走完「cropperjs 裁剪 → 保存落盘」全链路、截图并写 `smoke/report.json`，退出码 `0` 表示通过。

---

## 打包

```bash
npm run dist:nsis   # 推荐：两遍构建产出 NSIS 安装包，结束后自动校验
```

产物输出到 `release/`：

| 文件 | 说明 |
| --- | --- |
| `VerticalCamStudio-Setup-0.1.0.exe` | NSIS 安装包（约 85MB），含快捷方式与卸载项 |
| `VerticalCamStudio-Setup-0.1.0.exe.blockmap` | 增量更新块映射，可忽略 |
| `win-unpacked/` | 免安装程序目录，主 exe 可直接运行 |

每次构建结束自动运行 `scripts/verify-installer.mjs`：检查 `build/installer-manual.nsi` 源脚本大小（1KB~200KB）、exe ≥1MB 且含 Nullsoft 标识、体积不小于 `win-unpacked` 的 15%、主程序存在；任一不满足即失败。也可单独 `npm run verify`。

构建环境要求、两遍构建的原因、离线打包方式、asar 与 rcedit 的坑，全部记录在 **[docs/TROUBLESHOOTING.md 第 1 节](docs/TROUBLESHOOTING.md)**。

---

## 目录结构

```
vertical-cam-studio/
├── electron/
│   ├── main.js               # 窗口、设置持久化、文件夹选择、保存文件、屏幕截图
│   └── preload.js            # contextBridge 暴露的受限 API
├── renderer/
│   ├── index.html            # 主界面（含 CSP）
│   ├── settings.html         # 独立设置窗口（含 CSP）
│   ├── styles.css            # 暗色主题
│   ├── app.js                # 预览 / 拍照 / cropperjs / 保存
│   ├── settings.js           # 设置窗口控件绑定与写回
│   ├── core.js               # 主进程与渲染层共用的纯函数（文件名、Otsu、统计）
│   └── vendor/               # postinstall 生成（cropperjs.min.js|css），不入库
├── scripts/
│   ├── copy-vendor.mjs       # 复制 cropperjs dist → renderer/vendor
│   ├── dist-nsis.mjs         # 两遍构建 + 自动校验的一键打包
│   ├── verify-installer.mjs  # 产物完整性校验（防截断）
│   ├── png-ascii.mjs         # PNG → 字符画（白板笔画分析）
│   ├── analyze-line.mjs      # 行内笔画切分
│   ├── profile-row.mjs       # 灰阶剖面
│   └── vlm-ocr.mjs           # 本地 VLM 批量 OCR 对照
├── build/
│   └── installer-manual.nsi  # 手写 NSIS 备用脚本（勿命名为 installer.nsi）
├── docs/
│   ├── TROUBLESHOOTING.md    # 排障与踩坑记录
│   ├── CODE_REVIEW*.md       # 五轮代码审查
│   └── FIX_PLAN.md           # 修复计划与完成情况
├── test/
│   └── core.test.js          # 纯函数单测（node --test）
├── start.cmd / start.ps1     # 启动脚本（自动体检 electron）
├── audit.cmd                 # 白板管线 A/B 自检
├── package.json
├── logs/                     # 历史调试日志（可随时删）
└── LICENSE                   # MIT
```

---

## 安全边界

| 项 | 做法 |
| --- | --- |
| 渲染进程 | `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`，preload 只暴露 `contextBridge` 白名单 API |
| CSP | `default-src 'self'; base-uri 'self'; object-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'`（无 `unsafe-inline`） |
| 外部链接 | 只放行 `http:` / `https:`，其余协议拒绝 |
| 摄像头权限 | 仅对本地 `file://` 页面放行 `media` / `display-capture` |
| 打开文件 | `shell:openPath` / `showItemInFolder` 只允许输出目录之内的路径，类型限图片/文档 |
| 设置写入 | `settings:patch` 逐键校验（路径必须绝对、格式/倍率白名单、质量与对比度范围），非法值丢弃 |
| 打包 | 禁用菜单栏；打包后禁用 DevTools |

---

## 依赖与版本

`cropperjs` **精确锁定 `1.6.2`**：项目的「Ctrl 拖动平移」与「左键框选严格跟随鼠标」依赖 cropperjs 的若干非公开字段（`limited`、`cropBoxData.min*/max*`、`action`、`pointers`），浮动版本会静默破坏这两处交互。启动时 `assertCropperCompat()` 会检查这些字段，缺失会告警。

`electron` 锁定 `^38.3.0`（更早版本在本机会崩，见排障文档 2.2）。

打包配置关键项：`asar: false`（避免 Electron 38 的 asar 完整性校验失配导致静默退出）、`signAndEditExecutable: false`（跳过 rcedit）、`productName` 等构建字段为 ASCII（NSIS 模板的代码页限制，界面仍为中文）。

---

## UI 使用统计（纯本地）

所有按钮点击（含导入图片、旋转按钮、快捷键 Space / Ctrl+S）都会记一份本地统计，**不联网、不上传**：

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `ui-usage.json` | `app.getPath('userData')` | 聚合数据：`total`、按天总数 `days`、每个按钮的 `count` / `first` / `last` / `days`；`days` 只保留最近 90 天，`total` 与 `count` 为累计值 |
| `ui-usage.log` | 同上 | 明细日志：每次点击一行 JSON `{"t":"ISO 时间","id":"按钮标识"}`，800ms 防抖批量写入，超过 512KB 只保留最近 2000 行 |

按钮标识用元素 `id`（如 `btnShot`），旋转按钮用 `rot0/rot90/rot180/rot270`，导入标签用 `importImage`；快捷键复用对应按钮标识，便于按功能合并统计。文件位置可在设置页「存储位置」查看。

---

## 已知限制

- 屏幕截图取鼠标所在显示器整屏（缩放到 3840×2160 内），无区域选择层；精确框选请在裁剪台完成。
- 摄像头走 `getUserMedia`（WebRTC），部分 UVC 设备在 Electron 下拿不到满帧率；追求低延迟可换 [wysaid/CameraCapture](https://github.com/wysaid/CameraCapture)（MIT，DirectShow）。
- 视频流不进裁剪器：流程是「先拍照得到静态帧，再裁剪」，不支持实时取景框内裁剪。
- 若这台机器上**所有**应用都需要摆正画面，建议用系统级方案而非本工具的应用内旋转：注册表 `HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}` 下各设备实例的 `Rotation`（0/90/180/270），或开源工具 [tadas-subonis/webcam-settings](https://github.com/tadas-subonis/webcam-settings)（MIT）。两者可与本工具共存。

---

## 许可

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | MIT | 桌面外壳 |
| [cropperjs](https://github.com/fengyuanchen/cropperjs) | MIT | 裁剪 / 缩放 / 旋转核心 |

本项目自身 MIT（见 `LICENSE`）。若后续换成 C++ 原生实现或 Rust（usbscan 路线，注意其为 GPL-3.0），需重新评估分发义务。
