'use strict';

/* ------------------------------------------------------------------ */
/* 全局状态                                                            */
/* ------------------------------------------------------------------ */

const state = {
  settings: {
    outputDir: '',
    format: 'jpeg',
    quality: 0.92,
    filenameTemplate: '{prefix}_{timestamp}',
    prefix: 'shot',
    rotation: 0,
    mirror: false,
    autoSaveAfterCapture: false,
    whiteboard: false, // 白板模式：灰度 + 对比度增强
    whiteboardContrast: 1.8,
    binarize: false, // Otsu 自动阈值二值化
    whiteboardSoft: true, // 二值化时保留抗锯齿边缘（更适合 OCR）
    exportScale: 'auto', // 导出放大倍率：auto | 1 | 2 | 3
    lastDeviceId: ''
  },
  stream: null,
  cropper: null,
  hasImage: false,
  saveCounter: 0,
  toastTimer: null
};

/** 右键/中键拖动画布（pan）的临时状态 */
const pan = {
  dragging: false,
  synthetic: false,
  ctrlDown: false
};

/** 框选（画新选区）的临时状态 */
const selection = {
  active: false,
  startX: 0,
  startY: 0
};

const $ = (sel) => document.querySelector(sel);
const video = $('#video');
const cropImage = $('#cropImage');
const previewStage = $('#previewStage');
const previewRot = $('#previewRot');

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  // 用 classList 而不是整体覆盖 className：以后新增基础类（如 toast-top）不会被抹掉
  el.classList.remove('ok', 'err');
  if (kind) el.classList.add(kind);
  el.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/**
 * 写回设置。失败（磁盘不可写、设置被校验拒绝）时不应该让整个交互流程崩掉，
 * 因此统一在这里兜住错误并提示。
 *
 * 主进程会**校验并规范化**入参（例如 exportScale:'2' → 数字 2），
 * 非法值则直接拒绝并保留旧值，并返回一份 rejected 列表。
 * 这里据此做两件事：
 *   1) 把主进程的权威值回写到 state.settings，消除渲染层与磁盘之间的漂移；
 *   2) 对**被拒绝**的键，把对应控件拉回权威值 —— 否则界面会显示一个
 *      根本没生效的值，用户会误以为「已保存」。
 * 只动被拒绝的那一个控件，避免把用户正在编辑的其它输入框一起刷掉。
 */
function patchSettings(patch) {
  return api.patchSettings(patch)
    .then((res) => {
      // 主进程返回 { settings, rejected }；兼容直接返回 settings 的旧格式
      const next = res && res.settings ? res.settings : res;
      const rejected = res && Array.isArray(res.rejected) ? res.rejected : [];
      if (!next) return next;

      for (const key of Object.keys(patch)) {
        if (!Object.prototype.hasOwnProperty.call(next, key)) continue;
        const before = patch[key];
        const after = next[key];
        // 同值异型（如 exportScale '2' → 2）属于预期的类型归一，不是异常，别刷警告
        const benign = String(before) === String(after);
        if (!benign && rejected.indexOf(key) < 0) {
          console.warn(`[settings] ${key} 被主进程改写:`, before, '→', after);
        }
        state.settings[key] = after;
      }

      // 被拒绝的键：控件必须显示权威值
      if (rejected.length) {
        console.warn('[settings] 以下设置被拒绝，已回滚界面:', rejected.join(', '));
        syncControlsFromSettings(rejected);
      }
      return next;
    })
    .catch((err) => {
      console.error('[settings] 写回失败:', err);
      toast(`设置保存失败：${err.message || err}`, 'err');
      return null;
    });
}

function setStatus(text, kind = '') {
  const el = $('#camStatus');
  el.textContent = text;
  el.className = `status-chip ${kind}`;
}

function setFooter(text) {
  $('#statusText').textContent = text;
}

function pad(n) { return String(n).padStart(2, '0'); }

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/* ------------------------------------------------------------------ */
/* 摄像头                                                              */
/* ------------------------------------------------------------------ */

async function listDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

async function refreshDevices(preserve = true) {
  const select = $('#deviceSelect');
  const devices = await listDevices();
  const current = preserve ? (state.settings.lastDeviceId || select.value) : '';

  select.innerHTML = '';
  if (!devices.length) {
    const opt = document.createElement('option');
    opt.textContent = '（未检测到摄像头）';
    opt.value = '';
    select.appendChild(opt);
    setStatus('无设备', 'err');
    return;
  }

  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `摄像头 ${i + 1}`;
    select.appendChild(opt);
  });

  const target = devices.some((d) => d.deviceId === current) ? current : devices[0].deviceId;
  select.value = target;
  await startStream(target);
}

async function startStream(deviceId) {
  stopStream();
  if (!deviceId) return;

  const constraints = {
    audio: false,
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    }
  };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = state.stream;
    await video.play();
    $('#previewPlaceholder').style.display = 'none';
    setStatus('已连接', 'live');
    setFooter(`分辨率 ${video.videoWidth}×${video.videoHeight}`);
    state.settings.lastDeviceId = deviceId;
    patchSettings({ lastDeviceId: deviceId });
    layoutPreview();
    requestAnimationFrame(() => layoutPreview());
    setTimeout(layoutPreview, 200);
    await refreshDeviceLabels();
  } catch (err) {
    // 退回到默认设备（部分驱动不接受 exact 匹配）
    console.error('[camera] 指定设备打开失败，改用默认设备:', err);
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      video.srcObject = state.stream;
      await video.play();
      $('#previewPlaceholder').style.display = 'none';
      setStatus('已连接', 'live');

      // 兜底成功后，下拉框与持久化值必须指向**实际生效**的设备：
      // 否则界面还停在那个打不开的 deviceId，下次启动又会重试失败→兜底。
      const track = state.stream.getVideoTracks()[0];
      const actualId = track && typeof track.getSettings === 'function'
        ? track.getSettings().deviceId : null;
      const select = $('#deviceSelect');
      const matched = actualId && [...select.options].some((opt) => opt.value === actualId);
      if (matched) {
        select.value = actualId;
        state.settings.lastDeviceId = actualId;
        patchSettings({ lastDeviceId: actualId });
      } else {
        // 浏览器未暴露实际 id（或不在枚举列表中）：清空选择，下次启动取第一个可用设备
        select.selectedIndex = -1;
        state.settings.lastDeviceId = '';
        patchSettings({ lastDeviceId: '' });
      }

      setFooter(`分辨率 ${video.videoWidth}×${video.videoHeight}（已改用默认设备：${err.message}）`);
      layoutPreview();
      requestAnimationFrame(() => layoutPreview());
      setTimeout(layoutPreview, 200);
      await refreshDeviceLabels();
    } catch (err2) {
      console.error('[camera] 默认设备也打不开:', err2);
      setStatus('打开失败', 'err');
      setFooter(`摄像头打开失败：${err2.message}`);
      toast(`摄像头打开失败：${err2.message}`, 'err');
    }
  }
}

async function refreshDeviceLabels() {
  const devices = await listDevices();
  const select = $('#deviceSelect');
  [...select.options].forEach((opt, i) => {
    const d = devices[i];
    if (d && d.label) opt.textContent = d.label;
  });
}

function stopStream() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  video.srcObject = null;
}

/**
 * 根据旋转角度计算 video 的显示尺寸，避免旋转后被裁掉。
 * 0/180 时按容器宽高适配；90/270 时按旋转后的外接框适配。
 *
 * 注意：窗口尚未显示/布局未就绪时容器尺寸为 0，此时直接跳过，
 * 交给 ResizeObserver 在布局就绪后重算（否则会按兜底值缩成 80px 的小图）。
 */
function layoutPreview() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  const box = previewStage.getBoundingClientRect();
  if (box.width < 40 || box.height < 40) return; // 布局未就绪

  const availW = box.width - 8;
  const availH = box.height - 8;
  const aspect = vw / vh;
  const rot = Number(state.settings.rotation) || 0;
  const quarter = rot === 90 || rot === 270;

  let w;
  let h;
  if (quarter) {
    w = Math.min(availH, availW * aspect);
    h = w / aspect;
  } else {
    h = Math.min(availH, availW / aspect);
    w = h * aspect;
  }

  video.style.width = `${Math.round(w)}px`;
  video.style.height = `${Math.round(h)}px`;
  previewRot.style.transform = `rotate(${rot}deg) scaleX(${state.settings.mirror ? -1 : 1})`;
}

/** 布局变化（窗口显示、缩放、面板尺寸变化）后重算预览尺寸 */
let previewResizeObserver = null;
function observePreviewSize() {
  if (typeof ResizeObserver === 'undefined') {
    window.addEventListener('resize', () => layoutPreview());
    return;
  }
  previewResizeObserver = new ResizeObserver(() => layoutPreview());
  previewResizeObserver.observe(previewStage);
}

/* ------------------------------------------------------------------ */
/* 拍照（把旋转/镜像校正烘焙进位图）                                   */
/* ------------------------------------------------------------------ */

function captureCanvas() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) throw new Error('摄像头画面不可用');

  const rot = Number(state.settings.rotation) || 0;
  const canvas = document.createElement('canvas');
  if (rot === 90 || rot === 270) {
    canvas.width = vh;
    canvas.height = vw;
  } else {
    canvas.width = vw;
    canvas.height = vh;
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  if (state.settings.mirror) ctx.scale(-1, 1);
  ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
  ctx.restore();
  return canvas;
}

/* ------------------------------------------------------------------ */
/* cropperjs                                                           */
/* ------------------------------------------------------------------ */

function destroyCropper() {
  if (state.cropper) {
    state.cropper.destroy();
    state.cropper = null;
  }
  state.hasImage = false;
}

/**
 * 校验 cropperjs 私有字段是否齐备。
 *
 * 「Ctrl 拖动平移」和「左键框选对齐」这两套手势都依赖 cropperjs 的
 * 非公开字段（limited / cropBoxData.min*|max* / action / pointers），
 * 一旦上游版本变化就会静默失效，所以这里做一次显式自检。
 */
function assertCropperCompat(cropper) {
  if (!cropper) return false;
  const missing = [];
  if (typeof cropper.limited !== 'boolean') missing.push('limited');
  // 注意：cropperjs 的 action 字段是**首次拖动时**才创建的（不在构造函数里），
  // 所以这里不检查它的存在性，只检查能否正常赋值。
  if (!cropper.pointers || typeof cropper.pointers !== 'object') missing.push('pointers');
  const cb = cropper.cropBoxData || {};
  for (const k of ['minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'minLeft', 'maxLeft']) {
    if (typeof cb[k] !== 'number') missing.push(`cropBoxData.${k}`);
  }
  if (!cropper.canvasData || typeof cropper.canvasData.left !== 'number') missing.push('canvasData');
  if (!cropper.containerData || typeof cropper.containerData.width !== 'number') missing.push('containerData');
  if (missing.length) {
    console.error('[cropper] 私有字段缺失，Ctrl 平移/框选对齐可能失效:', missing.join(', '));
    toast('cropperjs 版本不兼容，Ctrl 平移可能异常', 'err');
  }
  return missing.length === 0;
}

/**
 * 把一张图片载入裁剪器。
 *
 * 关键点：给 img.src 赋一个与当前完全相同的字符串时，浏览器**不会**重新
 * 触发 load 事件。摄像头静止时连续拍照得到的是逐字节相同的 dataURL，
 * 于是 onload 永不执行、cropper 永远不会被创建，表现为「拍第二张就没法裁剪」。
 * 所以赋值前必须先清掉旧 src。
 */
function loadImageIntoCropper(dataUrl, aspectHint) {
  destroyCropper();

  // 新图进来前复位手势状态，避免上一次的拖动/框选残留作用到新选区
  pan.dragging = false;
  pan.ctrlDown = false;
  selection.active = false;
  document.body.classList.remove('panning', 'selecting');
  setInteractionMode('select');

  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    cropImage.onload = () => {
      $('#cropEmpty').style.display = 'none';
      state.hasImage = true;

      let instance = null;
      try {
        instance = new Cropper(cropImage, {
          viewMode: 1,
          dragMode: 'crop',
          aspectRatio: aspectHint || NaN,
          autoCropArea: 0.46, // 初始选区 = 图像尺寸的 46%（原 92% 的一半）
          responsive: true,
          background: false,
          movable: true,
          scalable: true,
          zoomable: true,
          rotatable: true,
          rotatableSnap: false,
          toggleDragModeOnDblclick: false,
          restore: false,
          // ready 之后 cropperjs 才初始化 cropBoxData / canvasData /
          // containerData / limited 这些内部字段，兼容性自检必须放在这里
          ready: () => {
            assertCropperCompat(instance || state.cropper);
            succeed();
          }
        });
      } catch (err) {
        console.error('[cropper] 初始化失败:', err);
        fail(`裁剪器初始化失败：${err.message}`);
        return;
      }
      state.cropper = instance;

      // 兜底：万一某条路径下 ready 在构造函数内同步触发（那时 state.cropper 还没赋值），
      // 这里再补一次自检，保证它不会被静默跳过。
      if (instance.ready) assertCropperCompat(instance);

      // ready 回调万一不触发时的兜底
      setTimeout(succeed, 3000);

      // 选区绘制走自研手势，cropper 保持裁剪模式
      try {
        state.cropper.setDragMode('crop');
      } catch (err) {
        console.error('[cropper] 设置拖拽模式失败:', err);
      }
    };

    cropImage.onerror = () => {
      state.hasImage = false;
      fail('图像加载失败');
    };

    // 同一张图也要能重新触发 load —— 先摘掉旧 src
    cropImage.removeAttribute('src');
    cropImage.src = dataUrl;
  });
}

function setAspect(value) {
  if (!state.cropper) return;
  if (value === 'original') {
    const w = cropImage.naturalWidth || 1;
    const h = cropImage.naturalHeight || 1;
    state.cropper.setAspectRatio(w / h);
    return;
  }
  if (value === 'free') {
    state.cropper.setAspectRatio(NaN);
    return;
  }
  const [a, b] = value.split(':').map(Number);
  state.cropper.setAspectRatio(a / b);
}

/* ------------------------------------------------------------------ */
/* 拖动画面（pan）                                                     */
/*                                                                    */
/* cropperjs 1.6.x 监听的是 PointerEvent（pointerdown/pointermove/     */
/* pointerup），且 cropStart 遇到 button !== 0 或 ctrlKey 会直接      */
/* return，所以「Ctrl + 拖动」需要我们把事件「翻译」成普通左键：       */
/*   1) 临时切到 move 拖拽模式（此时拖动 = 平移画布）                  */
/*   2) 在 cropper 的 drag-box 上派发一个合成的左键 pointerdown         */
/*   3) 拖动期间把真实指针位移翻译成 pointermove 派发给 cropper        */
/*   4) 松开时派发 pointerup，并还原拖拽模式                           */
/* ------------------------------------------------------------------ */

const PAN_POINTER_ID = 1;

function setDragMode(mode) {
  if (!state.cropper) return;
  state.cropper.setDragMode(mode);
  $('#cropStage').classList.toggle('move-mode', mode === 'move');
}

function dispatchPointer(type, target, opts) {
  const init = Object.assign({
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: PAN_POINTER_ID,
    pointerType: 'mouse',
    isPrimary: true,
    view: window
  }, opts);
  const Ctor = window.PointerEvent || window.MouseEvent;
  target.dispatchEvent(new Ctor(type, init));
}

function beginPan(e) {
  const cropper = state.cropper;
  if (!cropper || !cropper.ready) return;

  cropper.setDragMode('move');
  pan.dragging = true;
  document.body.classList.add('panning');

  // 一定要派发在 drag-box 上：只有它带 data-action="move"
  const target = cropper.dragBox || cropper.face || e.target;
  pan.synthetic = true;
  try {
    dispatchPointer('pointerdown', target, {
      clientX: e.clientX,
      clientY: e.clientY,
      button: 0,
      buttons: 1
    });
  } catch (err) {
    console.error('[pan] 派发 pointerdown 失败:', err);
  } finally {
    pan.synthetic = false;
  }
}

function movePan(e) {
  if (!pan.dragging) return;
  pan.synthetic = true;
  try {
    dispatchPointer('pointermove', document, {
      clientX: e.clientX,
      clientY: e.clientY,
      button: 0,
      buttons: 1
    });
  } catch (err) {
    console.error('[pan] 派发 pointermove 失败:', err);
  } finally {
    pan.synthetic = false;
  }
}

function endPan(e) {
  if (!pan.dragging) return;
  pan.dragging = false;
  document.body.classList.remove('panning');

  const cropper = state.cropper;
  pan.synthetic = true;
  try {
    dispatchPointer('pointerup', document, {
      clientX: e ? e.clientX : 0,
      clientY: e ? e.clientY : 0,
      button: 0,
      buttons: 0
    });
  } catch (err) {
    console.error('[pan] 派发 pointerup 失败:', err);
  } finally {
    pan.synthetic = false;
  }

  // 清理 cropper 内部的拖拽残留状态，避免下一次拖动被旧指针干扰
  if (cropper) {
    cropper.action = '';
    cropper.pointers = {};
  }

  // 还原成裁剪模式（Ctrl 松开后即为截取模式）
  setDragMode('crop');
}

/* ------------------------------------------------------------------ */
/* 框选：左键拖拽画出一个新的裁剪选区                                  */
/*                                                                    */
/* 为什么需要：cropperjs 里裁剪框拉满后，内部拖拽会被钳位成无效移动， */
/* 而新建选区只能在裁剪框之外的区域发起——框占满后就无处可拖。        */
/* 这里自己实现「拖拽画框」，用 setCropBoxData 直接写入选区坐标。      */
/* ------------------------------------------------------------------ */

/** 屏幕坐标 → 裁剪框坐标系（相对 cropper 容器） */
function toCropSpace(e) {
  const cropper = state.cropper;
  const rect = cropper.container.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

function beginSelect(e) {
  const p = toCropSpace(e);
  selection.active = true;
  selection.startX = p.x;
  selection.startY = p.y;
  document.body.classList.add('selecting');
}

function updateSelect(e) {
  const cropper = state.cropper;
  if (!cropper || !selection.active) return;
  const p = toCropSpace(e);
  const left = Math.min(selection.startX, p.x);
  const top = Math.min(selection.startY, p.y);
  const width = Math.abs(p.x - selection.startX);
  const height = Math.abs(p.y - selection.startY);

  // 画面被 Ctrl 拖动后，cropperjs 会把裁剪框钳到「图片范围内」
  // （limitCropBox: minLeft = max(0, canvasData.left)）。
  // 我们写进去的坐标会被二次挪走 → 框和鼠标错位。
  // 这里临时关掉钳位（位置 + 尺寸），让框严格跟随鼠标；松手时再收敛回可见区域。
  const cropBoxData = cropper.cropBoxData;
  const prev = {
    limited: cropper.limited,
    minWidth: cropBoxData.minWidth,
    minHeight: cropBoxData.minHeight,
    maxWidth: cropBoxData.maxWidth,
    maxHeight: cropBoxData.maxHeight
  };
  cropper.limited = false;
  cropBoxData.minWidth = 0;
  cropBoxData.minHeight = 0;
  cropBoxData.maxWidth = Infinity;
  cropBoxData.maxHeight = Infinity;
  try {
    cropper.setCropBoxData({ left, top, width, height });
  } finally {
    cropper.limited = prev.limited;
    cropBoxData.minWidth = prev.minWidth;
    cropBoxData.minHeight = prev.minHeight;
    cropBoxData.maxWidth = prev.maxWidth;
    cropBoxData.maxHeight = prev.maxHeight;
  }
}

/** 图片在容器坐标系里的可见区域（图片 ∩ 容器） */
function visibleImageRect(cropper) {
  const c = cropper.canvasData;
  const cw = cropper.containerData.width;
  const ch = cropper.containerData.height;
  return {
    x0: Math.max(0, c.left),
    y0: Math.max(0, c.top),
    x1: Math.min(cw, c.left + c.width),
    y1: Math.min(ch, c.top + c.height)
  };
}

function endSelect(e) {
  if (!selection.active) return;
  selection.active = false;
  document.body.classList.remove('selecting');

  const cropper = state.cropper;
  const box = cropper ? cropper.getCropBoxData() : null;

  // 选区太小或为 0 时给一个可用的默认框，避免"抓不住"的死状态
  if (!box || box.width < 8 || box.height < 8) {
    resetCropBox();
    toast('选区太小，已重置为默认区域', 'ok');
    return;
  }

  // 选区超出画面可见部分时，收敛回可见区域（否则裁出来的图会带空白边）
  const vis = visibleImageRect(cropper);
  const nx0 = Math.max(box.left, vis.x0);
  const ny0 = Math.max(box.top, vis.y0);
  const nx1 = Math.min(box.left + box.width, vis.x1);
  const ny1 = Math.min(box.top + box.height, vis.y1);

  if (nx1 - nx0 < 8 || ny1 - ny0 < 8) {
    resetCropBox();
    toast('选区不在画面内，已重置为默认区域', 'ok');
    return;
  }

  let nw = nx1 - nx0;
  let nh = ny1 - ny0;

  // 锁定了宽高比时，收敛后的选区仍要满足比例
  const ratio = Number(cropper.options.aspectRatio) || 0;
  if (ratio > 0) {
    nh = nw / ratio;
    if (ny0 + nh > vis.y1) {
      nh = vis.y1 - ny0;
      nw = nh * ratio;
    }
  }

  if (
    Math.abs(nx0 - box.left) > 0.5 ||
    Math.abs(ny0 - box.top) > 0.5 ||
    Math.abs(nw - box.width) > 0.5 ||
    Math.abs(nh - box.height) > 0.5
  ) {
    cropper.setCropBoxData({ left: nx0, top: ny0, width: nw, height: nh });
    toast('选区超出画面，已收敛到可见区域', 'ok');
    return;
  }

  toast(`已框选 ${Math.round(box.width)}×${Math.round(box.height)}`, 'ok');
}

/** 把选区复位成居中的默认大小（内部兜底：选区过小或完全落在画面外时使用） */
function resetCropBox() {
  const cropper = state.cropper;
  if (!cropper) return;
  const vis = visibleImageRect(cropper);
  const w = Math.max(Math.round((vis.x1 - vis.x0) * 0.35), 40);
  const h = Math.max(Math.round((vis.y1 - vis.y0) * 0.35), 40);
  cropper.setCropBoxData({
    left: Math.round((vis.x0 + vis.x1) / 2 - w / 2),
    top: Math.round((vis.y0 + vis.y1) / 2 - h / 2),
    width: w,
    height: h
  });
}

/* ------------------------------------------------------------------ */
/* 模式提示：按住 Ctrl = 拖动画面；松开 Ctrl = 拉选取框                 */
/* ------------------------------------------------------------------ */

function setInteractionMode(mode) {
  const badge = $('#modeBadge');
  if (!badge) return;
  const panMode = mode === 'pan';
  badge.textContent = panMode ? '✋ 拖动模式' : '✂ 截取模式';
  badge.className = `mode-badge ${panMode ? 'pan' : 'select'}`;
  $('#cropStage').classList.toggle('pan-hint', panMode);
  $('#cropStage').classList.toggle('select-mode', !panMode);
}

function bindModeIndicator() {
  setInteractionMode('select');

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control' || e.ctrlKey) {
      if (!pan.ctrlDown) {
        pan.ctrlDown = true;
        setInteractionMode('pan');
      }
      // 松开 Ctrl 时如果正在平移，立即收尾，避免模式与实际状态不一致
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control' || !e.ctrlKey) {
      if (pan.ctrlDown) {
        pan.ctrlDown = false;
        setInteractionMode('select');
        if (pan.dragging) endPan(e);
      }
    }
  });

  window.addEventListener('blur', () => {
    if (pan.ctrlDown) {
      pan.ctrlDown = false;
      setInteractionMode('select');
    }
  });
}

/** 判断落点是否是裁剪框的控制点（这些要交给 cropper 原生缩放） */
function isCropHandle(target) {
  if (!target || !target.closest) return false;
  return !!target.closest('.cropper-point, .cropper-line');
}

function bindStageInteractions() {
  const stage = $('#cropStage');

  // 屏蔽系统右键菜单
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // 按下左键：
  //   Ctrl + 拖动  → 平移画面
  //   普通拖动     → 拉选新的截取框（落在控制点上时交给 cropper 原生缩放）
  stage.addEventListener('pointerdown', (e) => {
    if (pan.synthetic) return;
    if (e.button !== 0) return;
    if (!state.cropper) return;

    if (e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      beginPan(e);
      return;
    }

    if (isCropHandle(e.target)) return; // 控制点：原生缩放

    e.preventDefault();
    e.stopPropagation();
    beginSelect(e);
  }, true);

  // 框选过程中的移动
  stage.addEventListener('pointermove', (e) => {
    if (!selection.active) return;
    e.preventDefault();
    e.stopPropagation();
    updateSelect(e);
  }, true);

  // 拖动过程：把位移翻译给 cropper
  window.addEventListener('pointermove', (e) => {
    if (pan.synthetic) return; // 忽略自己派发的事件，避免递归
    if (pan.dragging) movePan(e);
  }, true);

  // 松开 → 结束平移 / 结束框选
  window.addEventListener('pointerup', (e) => {
    if (pan.synthetic) return;
    if (selection.active) {
      e.preventDefault();
      e.stopPropagation();
      endSelect(e);
      return;
    }
    if (pan.dragging) endPan(e);
  }, true);

  // 失焦 / 切出窗口也要收尾，避免卡在平移状态
  window.addEventListener('blur', () => {
    if (selection.active) endSelect(null);
    endPan(null);
  });
  document.addEventListener('pointercancel', () => {
    if (selection.active) endSelect(null);
    endPan(null);
  });
}

/* ------------------------------------------------------------------ */
/* 白板模式：灰度 + 对比度增强（可选 Otsu 自动阈值二值化）            */
/* ------------------------------------------------------------------ */

/** Otsu 阈值（实现在 core.js，与主进程共用，可单测） */
function otsuThreshold(gray) {
  return WhCore.otsuThreshold(gray);
}

/**
 * 就地把画布转成高对比度黑白。
 * @param {HTMLCanvasElement} canvas
 * @param {{contrast?: number, binarize?: boolean}} options
 */
function applyWhiteboard(canvas, options) {
  const contrast = Number(options.contrast) || 1;
  const binarize = !!options.binarize;
  const softEdge = !!options.softEdge;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const count = data.length / 4;

  // 1) 灰度化（Rec.601 亮度）
  const gray = new Uint8ClampedArray(count);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  // 2) 对比度增强（以 128 为中心做线性拉伸）
  if (contrast !== 1) {
    for (let p = 0; p < count; p += 1) {
      const v = (gray[p] - 128) * contrast + 128;
      gray[p] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  // 3) 二值化（自动阈值）
  if (binarize) {
    const t = otsuThreshold(gray);
    // 注意用 ">" 而不是 ">="：Otsu 阈值常落在暗类的边缘（如 t=32），
    // 用 >= 会把最深的笔画判成白色，整张图全白、笔画丢失。
    //
    // softEdge 模式：不做硬切，阈值两侧留一段灰阶过渡。
    // 硬切会把笔画边缘的抗锯齿像素直接判成纯黑/纯白，
    // 竖线两端的柔和"笔锋"被抹平后，视觉上更容易被读成带横帽的方括号 "[]"。
    const soft = softEdge ? 48 : 0;
    // lo/hi 必须钳到 [0,255]：否则 t 很小时 lo 为负，
    // 最深的墨迹（gray=0）会落到 ((0-lo)/(hi-lo))*255 > 0 的灰阶上被提亮。
    const lo = Math.max(0, t - soft);
    const hi = Math.min(255, t + soft);
    for (let p = 0; p < count; p += 1) {
      if (soft > 0) {
        const g = gray[p];
        if (g <= lo) gray[p] = 0;
        else if (g >= hi) gray[p] = 255;
        else gray[p] = ((g - lo) / (hi - lo)) * 255;
      } else {
        gray[p] = gray[p] > t ? 255 : 0;
      }
    }
  }

  // 4) 写回（R=G=B）
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    data[i] = gray[p];
    data[i + 1] = gray[p];
    data[i + 2] = gray[p];
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** 裁剪区预览滤镜：与保存效果一致，方便边选边看 */
function updatePreviewFilter() {
  const on = !!state.settings.whiteboard;
  const contrast = Number(state.settings.whiteboardContrast) || 1;
  if (!on) {
    cropImage.style.filter = '';
    return;
  }
  cropImage.style.filter = `grayscale(1) contrast(${contrast})`;
}

/* ------------------------------------------------------------------ */
/* 保存                                                                */
/* ------------------------------------------------------------------ */

function currentFilenameTemplate() {
  return $('#templateInput').value.trim() || state.settings.filenameTemplate || '{prefix}_{timestamp}';
}

function currentPrefix() {
  return ($('#prefixInput').value.trim() || state.settings.prefix || 'shot');
}

/**
 * 导出放大倍率（实现在 core.js，与主进程共用，可单测）：
 *   'auto' —— 按裁剪块长边自动补到约 1200px（1~3×），小裁剪块是识别出错的高发区
 *   1/2/3  —— 手动指定
 */
function resolveExportScale(canvas) {
  return WhCore.resolveExportScale(canvas.width, canvas.height, state.settings.exportScale ?? 'auto');
}

async function cropperToDataUrl() {
  if (!state.cropper) throw new Error('没有可保存的画面');
  // 格式与质量以 settings 为唯一真相源，避免 DOM 与持久化配置不一致
  const format = state.settings.format === 'png' ? 'png' : 'jpeg';
  const quality = Number(state.settings.quality) || 0.92;

  // cropper 未 ready 时 getCroppedCanvas 会返回 null，这里重试等待。
  // 正常路径下 loadImageIntoCropper 已经 await 到 ready，这一轮只是防御性兜底。
  let canvas = null;
  for (let i = 0; i < 12 && !canvas; i += 1) {
    canvas = state.cropper.getCroppedCanvas({
      maxWidth: 8192,
      maxHeight: 8192,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high'
    });
    if (!canvas) await new Promise((r) => setTimeout(r, 150));
  }
  if (!canvas || !canvas.width || !canvas.height) throw new Error('裁剪结果为空');

  // OCR 放大：小裁剪块里的细笔画（2~3px 宽）经模型内部重采样后会糊成一团，
  // 导致 "-|" 被连读成 "["。实测放大 2× 后 Qwen3-VL-4B 的整页识别全部正确。
  const scale = resolveExportScale(canvas);
  if (scale > 1) {
    // 放大后仍要守住 8192 的边长上限：8192×3 = 24576 像素的画布
    // 光位图就要 2.4GB，直接把渲染进程拖垮。
    const MAX_EDGE = 8192;
    const targetW = Math.round(canvas.width * scale);
    const targetH = Math.round(canvas.height * scale);
    const fit = Math.min(1, MAX_EDGE / Math.max(targetW, targetH));
    const outW = Math.max(1, Math.round(targetW * fit));
    const outH = Math.max(1, Math.round(targetH * fit));
    const big = document.createElement('canvas');
    big.width = outW;
    big.height = outH;
    const bx = big.getContext('2d');
    bx.imageSmoothingEnabled = true;
    bx.imageSmoothingQuality = 'high';
    bx.drawImage(canvas, 0, 0, outW, outH);
    canvas = big;
  }

  // 白板模式：灰度 + 对比度增强（可选二值化）
  if (state.settings.whiteboard) {
    applyWhiteboard(canvas, {
      contrast: Number(state.settings.whiteboardContrast) || 1,
      binarize: !!state.settings.binarize,
      softEdge: state.settings.whiteboardSoft !== false
    });
  }

  return { dataUrl: canvas.toDataURL(`image/${format}`, quality), format, scale };
}

// 保存期间锁住入口：快速连按 Ctrl+S / 自动保存与手动保存重叠时，
// 两次调用会拿到同一个 {n}（R5-4）。文件本身有 -1/-2 后缀兜底不会覆盖，
// 但计数器语义会重复，这里直接串行化。
let saveInFlight = false;

async function saveCurrent({ silent = false } = {}) {
  if (saveInFlight) {
    setFooter('上一次保存尚未完成，请稍候');
    return false;
  }
  saveInFlight = true;
  try {
    const { dataUrl, format, scale } = await cropperToDataUrl();
    // {n} 只在保存真正成功后消耗：取消对话框不应造成编号跳号
    const counter = state.saveCounter + 1;

    const result = await api.saveImage({
      dataUrl,
      format,
      filenameTemplate: currentFilenameTemplate(),
      prefix: currentPrefix(),
      counter
    });

    if (!result || result.ok === false) {
      if (result && result.canceled) {
        setFooter('已取消保存');
        return false;
      }
      throw new Error(result && result.error ? result.error : '保存失败');
    }

    state.saveCounter = counter;

    setFooter(`已保存：${result.path}`);
    if (!silent) {
      toast(
        scale > 1 ? `已保存到 ${result.path}（已放大 ${scale}× 提升识别率）` : `已保存到 ${result.path}`,
        'ok'
      );
    }
    return true;
  } catch (err) {
    setFooter(`保存失败：${err.message}`);
    toast(`保存失败：${err.message}`, 'err');
    return false;
  } finally {
    saveInFlight = false;
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  // UI 使用统计：统一事件委托，所有按钮（含 data-stat 的 label）自动埋点。
  // 用稳定的 id / data-stat / data-rot 做键，避免用按钮文字（改名会断统计）。
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, [data-stat]');
    if (!el) return;
    const key = el.dataset.stat || el.id || (el.dataset.rot ? `rot${el.dataset.rot}` : '');
    if (key && api.trackButton) api.trackButton(key);
  });

  // 设备
  $('#btnRefreshDevices').addEventListener('click', () => refreshDevices(true));
  $('#deviceSelect').addEventListener('change', (e) => startStream(e.target.value));

  // 旋转校正
  document.querySelectorAll('.btn.rot').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.rotation = Number(btn.dataset.rot);
      syncRotationButtons();
      layoutPreview();
      patchSettings({ rotation: state.settings.rotation });
    });
  });

  $('#btnMirror').addEventListener('click', () => {
    state.settings.mirror = !state.settings.mirror;
    $('#btnMirror').classList.toggle('active', state.settings.mirror);
    layoutPreview();
    patchSettings({ mirror: state.settings.mirror });
  });

  // 拍照 / 截图 / 导入
  $('#btnShot').addEventListener('click', doCapture);
  $('#btnScreenShot').addEventListener('click', doScreenCapture);
  $('#fileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      loadImageIntoCropper(reader.result, NaN)
        .then(() => setFooter(`已导入 ${file.name}`))
        .catch((err) => toast(`导入失败：${err.message}`, 'err'));
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  // 裁剪工具
  $('#btnZoomIn').addEventListener('click', () => state.cropper && state.cropper.zoom(0.1));
  $('#btnZoomOut').addEventListener('click', () => state.cropper && state.cropper.zoom(-0.1));
  $('#btnZoomReset').addEventListener('click', () => {
    if (!state.cropper) return;
    state.cropper.reset();
    setDragMode('crop');
  });
  $('#btnRotL').addEventListener('click', () => state.cropper && state.cropper.rotate(-90));
  $('#btnRotR').addEventListener('click', () => state.cropper && state.cropper.rotate(90));
  $('#btnFlipH').addEventListener('click', () => state.cropper && state.cropper.scaleX(-state.cropper.getData().scaleX));
  $('#aspectSelect').addEventListener('change', (e) => setAspect(e.target.value));

  // 输出目录
  $('#btnPickFolder').addEventListener('click', async () => {
    const dir = await api.selectFolder();
    if (dir) {
      state.settings.outputDir = dir;
      renderOutputDir();
      setFooter(`输出目录已设为 ${dir}`);
      toast('输出目录已更新', 'ok');
    }
  });
  $('#btnOpenFolder').addEventListener('click', () => {
    if (state.settings.outputDir) api.openPath(state.settings.outputDir);
    else toast('尚未选择输出目录', 'err');
  });

  // 保存设置
  $('#formatSelect').addEventListener('change', (e) => {
    state.settings.format = e.target.value === 'png' ? 'png' : 'jpeg';
    patchSettings({ format: state.settings.format });
  });
  // 拖动时先更新内存里的值（保存立即生效），落盘做防抖，避免一次拖动写十几次磁盘
  let qualityPersistTimer = null;
  $('#qualityRange').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    state.settings.quality = v;
    $('#qualityValue').textContent = e.target.value;
    clearTimeout(qualityPersistTimer);
    qualityPersistTimer = setTimeout(() => patchSettings({ quality: v }), 400);
  });
  $('#qualityRange').addEventListener('change', (e) => {
    const v = Number(e.target.value) / 100;
    state.settings.quality = v;
    clearTimeout(qualityPersistTimer);
    patchSettings({ quality: v });
  });
  $('#prefixInput').addEventListener('change', (e) => patchSettings({ prefix: e.target.value }));
  $('#templateInput').addEventListener('change', (e) => patchSettings({ filenameTemplate: e.target.value }));
  $('#autoSaveCheck').addEventListener('change', (e) => patchSettings({ autoSaveAfterCapture: e.target.checked }));

  // 白板模式
  $('#whiteboardCheck').addEventListener('change', (e) => {
    state.settings.whiteboard = e.target.checked;
    patchSettings({ whiteboard: e.target.checked });
    updatePreviewFilter();
  });
  // 与质量滑块保持一致：拖动过程中就更新内存值并刷新预览滤镜，
  // 否则拖到一半时预览还是旧强度，松手前保存也会用旧值。
  let contrastPersistTimer = null;
  $('#whiteboardRange').addEventListener('input', (e) => {
    const contrast = Number(e.target.value) / 100;
    state.settings.whiteboardContrast = contrast;
    $('#whiteboardValue').textContent = contrast.toFixed(2);
    updatePreviewFilter();
    clearTimeout(contrastPersistTimer);
    contrastPersistTimer = setTimeout(() => patchSettings({ whiteboardContrast: contrast }), 400);
  });
  $('#whiteboardRange').addEventListener('change', (e) => {
    const contrast = Number(e.target.value) / 100;
    state.settings.whiteboardContrast = contrast;
    clearTimeout(contrastPersistTimer);
    patchSettings({ whiteboardContrast: contrast });
    updatePreviewFilter();
  });
  $('#binarizeCheck').addEventListener('change', (e) => {
    state.settings.binarize = e.target.checked;
    patchSettings({ binarize: e.target.checked });
    updatePreviewFilter();
  });
  $('#whiteboardSoftCheck').addEventListener('change', (e) => {
    state.settings.whiteboardSoft = e.target.checked;
    patchSettings({ whiteboardSoft: e.target.checked });
  });
  $('#exportScaleSelect').addEventListener('change', (e) => {
    state.settings.exportScale = e.target.value;
    patchSettings({ exportScale: e.target.value });
  });

  // 保存 / 重拍
  $('#btnSave').addEventListener('click', () => saveCurrent());
  $('#btnRecapture').addEventListener('click', () => {
    destroyCropper();
    state.hasImage = false;
    $('#cropEmpty').style.display = 'flex';
    cropImage.removeAttribute('src');
    setFooter('已清空裁剪区');
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (e.code === 'Space') {
      // 焦点落在按钮上时，空格应当用来「激活这个按钮」，
      // 而不是抢过来再拍一张照片（否则点完按钮按空格会连拍）。
      const active = document.activeElement;
      if (active && active.tagName === 'BUTTON') return;
      e.preventDefault();
      if (api.trackButton) api.trackButton('btnShot'); // 快捷键与按钮合并统计
      doCapture();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
      e.preventDefault();
      if (api.trackButton) api.trackButton('btnSave');
      saveCurrent();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyO') {
      e.preventDefault();
      $('#btnPickFolder').click();
    }
  });

  bindStageInteractions();
  bindModeIndicator();

  window.addEventListener('resize', () => layoutPreview());
  window.addEventListener('beforeunload', () => {
    stopStream();
    if (previewResizeObserver) previewResizeObserver.disconnect();
  });
}

/* ------------------------------------------------------------------ */
/* 拍照流程                                                            */
/* ------------------------------------------------------------------ */

async function doCapture() {
  try {
    const canvas = captureCanvas();
    const dataUrl = canvas.toDataURL('image/png');
    await loadImageIntoCropper(dataUrl, NaN);
    setFooter(`已拍摄 ${canvas.width}×${canvas.height}`);

    if (state.settings.autoSaveAfterCapture) {
      await saveCurrent({ silent: true });
    }
  } catch (err) {
    toast(`拍照失败：${err.message}`, 'err');
  }
}

async function doScreenCapture() {
  try {
    const res = await api.captureScreen();
    if (!res || !res.ok) {
      toast(res && res.error ? res.error : '屏幕截图失败', 'err');
      return;
    }
    await loadImageIntoCropper(res.dataUrl, NaN);
    setFooter(`已截取屏幕：${res.name}`);
  } catch (err) {
    toast(`屏幕截图失败：${err.message}`, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

function syncRotationButtons() {
  document.querySelectorAll('.btn.rot').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.rot) === Number(state.settings.rotation));
  });
}

/**
 * 用 state.settings 回填界面控件。
 * state.settings 是唯一真相源（主进程校验后的权威值），界面只是它的投影。
 *
 * @param {string[]} [only] 只同步这几个设置键；省略则全部同步。
 *        用于「某个键被主进程拒绝」时精准回滚那一个控件，
 *        不去动用户可能正在编辑的其它输入框。
 */
function syncControlsFromSettings(only) {
  const want = (key) => !only || only.indexOf(key) >= 0;

  if (want('format')) $('#formatSelect').value = state.settings.format === 'png' ? 'png' : 'jpeg';
  if (want('quality')) {
    $('#qualityRange').value = Math.round((state.settings.quality ?? 0.92) * 100);
    $('#qualityValue').textContent = $('#qualityRange').value;
  }
  if (want('prefix')) $('#prefixInput').value = state.settings.prefix || 'shot';
  if (want('filenameTemplate')) $('#templateInput').value = state.settings.filenameTemplate || '{prefix}_{timestamp}';
  if (want('autoSaveAfterCapture')) $('#autoSaveCheck').checked = !!state.settings.autoSaveAfterCapture;
  if (want('whiteboard')) $('#whiteboardCheck').checked = !!state.settings.whiteboard;
  if (want('whiteboardContrast')) {
    $('#whiteboardRange').value = Math.round((state.settings.whiteboardContrast ?? 1.8) * 100);
    $('#whiteboardValue').textContent = (Number($('#whiteboardRange').value) / 100).toFixed(2);
  }
  if (want('binarize')) $('#binarizeCheck').checked = !!state.settings.binarize;
  if (want('whiteboardSoft')) $('#whiteboardSoftCheck').checked = state.settings.whiteboardSoft !== false;
  if (want('exportScale')) $('#exportScaleSelect').value = String(state.settings.exportScale ?? 'auto');
  if (want('mirror')) $('#btnMirror').classList.toggle('active', !!state.settings.mirror);
  if (want('rotation')) syncRotationButtons();
  if (want('outputDir')) renderOutputDir();
  if (want('whiteboard') || want('whiteboardContrast')) updatePreviewFilter();
}

function renderOutputDir() {
  $('#outputDir').textContent = state.settings.outputDir || '（未设置）';
  $('#outputDir').title = state.settings.outputDir || '';
}

async function init() {
  if (typeof Cropper === 'undefined') {
    toast('cropperjs 未加载，请先执行 npm install（会触发 postinstall 复制 vendor 文件）', 'err');
  }
  if (typeof WhCore === 'undefined') {
    toast('core.js 未加载，纯函数不可用', 'err');
  }

  const saved = await api.getSettings();
  state.settings = Object.assign(state.settings, saved || {});

  // syncControlsFromSettings() 里已经包含 renderOutputDir() 与 updatePreviewFilter()
  syncControlsFromSettings();

  const info = await api.appInfo();
  $('#appInfo').textContent = `v${info.version} · ${info.platform} · 配置目录 ${info.userData}`;

  bindEvents();
  observePreviewSize();

  // 视频元数据就绪（拿到真实分辨率）后重算显示尺寸
  video.addEventListener('loadedmetadata', () => layoutPreview());
  video.addEventListener('resize', () => layoutPreview());

  try {
    await refreshDevices(true);
  } catch (err) {
    setStatus('设备枚举失败', 'err');
    setFooter(`枚举摄像头失败：${err.message}`);
  }

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      refreshDevices(true).catch((err) => console.error('[camera] 设备列表刷新失败:', err));
    });
  }
}

document.addEventListener('DOMContentLoaded', init);

/**
 * 开发工具契约（--audit / --abtest / --shapes / --smoke 由主进程用 executeJavaScript 调用）。
 *
 * 显式挂出来，而不是让主进程依赖渲染层的隐式全局名：
 * 一旦 app.js 改成 ES module 或被压缩/改名，这些探针会静默失效。
 *
 * 只在未打包的开发模式挂载：主进程通过 loadFile({ query: { vcsdev: '1' } })
 * 给页面打标记，生产构建不带该参数，因而不暴露探针入口。
 */
if (new URLSearchParams(location.search).has('vcsdev')) {
  window.__wb = {
    applyWhiteboard,
    loadImageIntoCropper,
    cropperToDataUrl,
    otsuThreshold,
    resolveExportScale,
    /** 设置写回（包装了主进程权威值的回写） */
    patchSettings,
    /** 当前裁剪器实例（探针需要在换图之后重新取） */
    getCropper: () => state.cropper,
    /** 只读设置副本 */
    getSettings: () => Object.assign({}, state.settings)
  };
}
