'use strict';

const $ = (selector) => document.querySelector(selector);

/** 控件 id → 设置键，用于主进程广播时只刷新真正变化的控件 */
const CONTROL_KEYS = {
  formatSelect: 'format',
  qualityRange: 'quality',
  prefixInput: 'prefix',
  templateInput: 'filenameTemplate',
  autoSaveCheck: 'autoSaveAfterCapture',
  whiteboardCheck: 'whiteboard',
  whiteboardRange: 'whiteboardContrast',
  binarizeCheck: 'binarize',
  whiteboardSoftCheck: 'whiteboardSoft',
  exportScaleSelect: 'exportScale'
};

let settings = {};
let statusTimer = null;
let qualityTimer = null;
let contrastTimer = null;

function setStatus(text, kind) {
  const el = $('#saveStatus');
  el.textContent = text;
  el.classList.remove('live', 'err');
  if (kind) el.classList.add(kind);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.textContent = '修改后自动保存';
    el.classList.remove('live', 'err');
  }, 2200);
}

/**
 * 用权威值回填控件。
 * @param {string[]} [only] 只回填这些设置键
 * @param {boolean} [skipFocused] 跳过用户正在编辑的控件，避免打字被打断
 */
function fillControls(only, skipFocused = false) {
  const want = (key, id) => {
    if (only && only.indexOf(key) < 0) return false;
    if (skipFocused && document.activeElement && document.activeElement.id === id) return false;
    return true;
  };

  if (want('format', 'formatSelect')) {
    $('#formatSelect').value = settings.format === 'png' ? 'png' : 'jpeg';
  }
  if (want('quality', 'qualityRange')) {
    $('#qualityRange').value = Math.round((settings.quality ?? 0.92) * 100);
    $('#qualityValue').textContent = $('#qualityRange').value;
  }
  if (want('prefix', 'prefixInput')) $('#prefixInput').value = settings.prefix || 'shot';
  if (want('filenameTemplate', 'templateInput')) {
    $('#templateInput').value = settings.filenameTemplate || '{prefix}_{timestamp}';
  }
  if (want('autoSaveAfterCapture', 'autoSaveCheck')) {
    $('#autoSaveCheck').checked = !!settings.autoSaveAfterCapture;
  }
  if (want('whiteboard', 'whiteboardCheck')) {
    $('#whiteboardCheck').checked = !!settings.whiteboard;
  }
  if (want('whiteboardContrast', 'whiteboardRange')) {
    $('#whiteboardRange').value = Math.round((settings.whiteboardContrast ?? 1.8) * 100);
    $('#whiteboardValue').textContent = (Number($('#whiteboardRange').value) / 100).toFixed(2);
  }
  if (want('binarize', 'binarizeCheck')) $('#binarizeCheck').checked = !!settings.binarize;
  if (want('whiteboardSoft', 'whiteboardSoftCheck')) {
    $('#whiteboardSoftCheck').checked = settings.whiteboardSoft !== false;
  }
  if (want('exportScale', 'exportScaleSelect')) {
    $('#exportScaleSelect').value = String(settings.exportScale ?? 'auto');
  }
}

/** 写回设置；以主进程返回的权威值为准，被拒绝的键立刻把控件拉回原值 */
function patch(patchObj) {
  return api.patchSettings(patchObj)
    .then((res) => {
      const next = res && res.settings ? res.settings : res;
      const rejected = res && Array.isArray(res.rejected) ? res.rejected : [];
      if (next) settings = Object.assign({}, next);
      if (rejected.length) {
        fillControls(rejected);
        setStatus('部分设置被拒绝，已恢复原值', 'err');
        console.warn('[settings] 被拒绝:', rejected.join(', '));
      } else {
        setStatus('已保存', 'live');
      }
      return next;
    })
    .catch((err) => {
      setStatus(`保存失败：${err.message || err}`, 'err');
      console.error('[settings] 写回失败:', err);
      return null;
    });
}

function bindEvents() {
  $('#formatSelect').addEventListener('change', (e) => {
    patch({ format: e.target.value === 'png' ? 'png' : 'jpeg' });
  });

  // 拖动时防抖落盘，松手时立即写一次，避免一次拖动写十几次磁盘
  $('#qualityRange').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    $('#qualityValue').textContent = e.target.value;
    clearTimeout(qualityTimer);
    qualityTimer = setTimeout(() => patch({ quality: v }), 400);
  });
  $('#qualityRange').addEventListener('change', (e) => {
    clearTimeout(qualityTimer);
    patch({ quality: Number(e.target.value) / 100 });
  });

  $('#prefixInput').addEventListener('change', (e) => patch({ prefix: e.target.value }));
  $('#templateInput').addEventListener('change', (e) => patch({ filenameTemplate: e.target.value }));
  $('#autoSaveCheck').addEventListener('change', (e) => patch({ autoSaveAfterCapture: e.target.checked }));
  $('#whiteboardCheck').addEventListener('change', (e) => patch({ whiteboard: e.target.checked }));

  $('#whiteboardRange').addEventListener('input', (e) => {
    const contrast = Number(e.target.value) / 100;
    $('#whiteboardValue').textContent = contrast.toFixed(2);
    clearTimeout(contrastTimer);
    contrastTimer = setTimeout(() => patch({ whiteboardContrast: contrast }), 400);
  });
  $('#whiteboardRange').addEventListener('change', (e) => {
    clearTimeout(contrastTimer);
    patch({ whiteboardContrast: Number(e.target.value) / 100 });
  });

  $('#binarizeCheck').addEventListener('change', (e) => patch({ binarize: e.target.checked }));
  $('#whiteboardSoftCheck').addEventListener('change', (e) => patch({ whiteboardSoft: e.target.checked }));
  $('#exportScaleSelect').addEventListener('change', (e) => patch({ exportScale: e.target.value }));

  $('#btnCloseSettings').addEventListener('click', () => window.close());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.close();
  });

  // 与主界面一致：所有按钮点击计入本地使用统计
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, [data-stat]');
    if (!el) return;
    const id = el.dataset.stat || el.id;
    if (id) api.trackButton(id);
  });
}

async function init() {
  try {
    const saved = await api.getSettings();
    settings = Object.assign({}, saved || {});
    fillControls();
  } catch (err) {
    setStatus(`读取设置失败：${err.message || err}`, 'err');
  }

  // 主界面（或其它设置窗口）改动设置后同步过来；跳过正在编辑的控件
  api.onSettingsChanged((next) => {
    if (!next) return;
    const changed = [];
    for (const key of new Set(Object.values(CONTROL_KEYS))) {
      if (String(settings[key]) !== String(next[key])) changed.push(key);
    }
    settings = Object.assign({}, next);
    if (changed.length) fillControls(changed, true);
  });

  bindEvents();
}

document.addEventListener('DOMContentLoaded', init);
