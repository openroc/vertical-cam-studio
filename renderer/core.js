/**
 * 主进程与渲染进程共用的纯函数。
 *
 * 为什么放在 renderer/ 目录里：
 * 渲染层是 classic script（<script src>），而页面通过 file:// 加载，
 * CSP 的 script-src 'self' 在 file:// 下只放行**同目录**的脚本，
 * 放在项目根目录的 shared/ 里会被 CSP 拦掉。
 * 因此把唯一的实现放在这里，主进程用 require('../renderer/core.js') 复用同一份。
 *
 * 这里只放**无副作用**的纯函数，方便用 node --test 直接单测。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WhCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 文件名相关（主进程） ---------------- */

  function pad(n, width = 2) {
    return String(n).padStart(width, '0');
  }

  function stamp(date = new Date()) {
    return {
      timestamp: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
      date: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
      time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    };
  }

  // Win32 保留设备名，不能直接当文件名
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

  function sanitizeName(name) {
    let out = String(name)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      // Win32 不允许文件名以「点」或「空格」结尾
      .replace(/[. ]+$/g, '')
      .slice(0, 120);
    if (!out) out = 'shot';
    if (WINDOWS_RESERVED.test(out)) out = `_${out}`;
    return out;
  }

  /**
   * 渲染文件名模板。支持 {prefix} {timestamp} {date} {time} {n}。
   * 注意：{n} 是**会话内**计数器，重启归零；唯一性靠保存时追加的 -1/-2 后缀。
   */
  function renderTemplate(template, prefix, counter) {
    const s = stamp();
    return sanitizeName(
      String(template || '{prefix}_{timestamp}')
        .replace(/\{prefix\}/g, prefix)
        .replace(/\{timestamp\}/g, s.timestamp)
        .replace(/\{date\}/g, s.date)
        .replace(/\{time\}/g, s.time)
        .replace(/\{n\}/g, String(counter))
    );
  }

  /* ---------------- 图像处理（渲染进程） ---------------- */

  /** Otsu 阈值：自动求灰度直方图的最大类间方差分割点 */
  function otsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;

    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * hist[i];

    let sumB = 0;
    let wB = 0;
    let maxVar = -1;
    let threshold = 128;

    for (let t = 0; t < 256; t += 1) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) {
        maxVar = between;
        threshold = t;
      }
    }
    return threshold;
  }

  /**
   * 导出放大倍率：
   *   'auto' —— 按裁剪块长边自动补到约 1200px（1~3×），小裁剪块是识别出错的高发区
   *   1/2/3  —— 手动指定
   */
  function resolveExportScale(width, height, setting) {
    const mode = setting === undefined || setting === null ? 'auto' : setting;
    if (mode === 'auto') {
      const long = Math.max(width, height);
      if (!long || long >= 1200) return 1;
      return Math.min(3, Math.max(1, Math.round(1200 / long)));
    }
    const k = Number(mode) || 1;
    return Math.min(3, Math.max(1, k));
  }

  /* ---------------- UI 使用统计（主进程） ---------------- */

  const STAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
  // 这些标识虽然匹配 STAT_ID，但都是 Object.prototype 上的键：
  // 直接拿 usage.items[id] 做 truthy 判断会命中原型链，导致原型污染 + handler 抛错。
  const BLOCKED_STAT_IDS = new Set([
    '__proto__', 'constructor', 'prototype', 'toString', 'valueOf',
    'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'
  ]);

  /** 只接受稳定的 ASCII 标识符，并排除会命中原型链的保留键 */
  function normalizeStatId(id) {
    const s = String(id === undefined || id === null ? '' : id).trim();
    return STAT_ID.test(s) && !BLOCKED_STAT_IDS.has(s) ? s : null;
  }

  /** 统计按自然日聚合，格式 YYYYMMDD（与 stamp().date 一致） */
  function dayKey(date = new Date()) {
    return stamp(date).date;
  }

  /** 只保留最近 keep 天，避免统计文件随时间无限膨胀 */
  function pruneDays(days, keep = 90) {
    const keys = Object.keys(days || {}).sort();
    if (keys.length <= keep) return days || {};
    const out = {};
    for (const key of keys.slice(keys.length - keep)) out[key] = days[key];
    return out;
  }

  /** 空统计结构：days/items 用无原型对象，杜绝原型键命中 */
  function createUsageData() {
    return { version: 1, total: 0, days: Object.create(null), items: Object.create(null) };
  }

  /** 把天数映射规范化：只保留 YYYYMMDD 键与非负整数值 */
  function normalizeDayCounts(days) {
    const out = Object.create(null);
    if (!days || typeof days !== 'object') return out;
    for (const key of Object.keys(days)) {
      if (!/^\d{8}$/.test(key)) continue;
      const n = Number(days[key]);
      if (Number.isFinite(n) && n > 0) out[key] = Math.floor(n);
    }
    return out;
  }

  /**
   * 读取磁盘上的统计文件时逐项规范化：
   * 手工编辑、旧版本残留或半截写入造成的坏字段不能带病运行，
   * 否则 stats:button 里 item.days[day] 会抛 TypeError。
   */
  function normalizeUsageData(raw) {
    const out = createUsageData();
    if (!raw || raw.version !== 1 || !raw.items || typeof raw.items !== 'object') return out;

    if (Number.isFinite(raw.total) && raw.total >= 0) out.total = Math.floor(raw.total);
    out.days = pruneDays(normalizeDayCounts(raw.days), 90);

    for (const key of Object.keys(raw.items)) {
      const id = normalizeStatId(key);
      if (!id) continue;
      const item = raw.items[key];
      if (!item || typeof item !== 'object') continue;
      const days = normalizeDayCounts(item.days);
      const count = Number.isFinite(item.count) && item.count > 0
        ? Math.floor(item.count)
        : Object.keys(days).reduce((sum, d) => sum + days[d], 0);
      if (!count) continue;
      out.items[id] = {
        count,
        first: typeof item.first === 'string' ? item.first : null,
        last: typeof item.last === 'string' ? item.last : null,
        days
      };
    }
    return out;
  }

  /**
   * 纯函数：把一次按钮点击计入统计（就地修改 usage，返回本次结果）。
   * 所有校验/重建都在这里完成，主进程 handler 只负责 IO。
   */
  function applyButtonStat(usage, id, date = new Date()) {
    if (!usage || typeof usage !== 'object') return null;
    const safeId = normalizeStatId(id);
    if (!safeId) return null;

    const iso = date.toISOString();
    const day = dayKey(date);

    usage.total = (Number.isFinite(usage.total) ? usage.total : 0) + 1;
    usage.days = pruneDays(
      Object.assign(Object.create(null), usage.days, { [day]: (usage.days && usage.days[day] || 0) + 1 }),
      90
    );

    // hasOwnProperty 而非 truthy 判断：即使调用方传入普通对象也不会命中原型链
    const existing = Object.prototype.hasOwnProperty.call(usage.items, safeId) ? usage.items[safeId] : null;
    const item = (existing && typeof existing === 'object') ? existing
      : { count: 0, first: iso, last: iso, days: Object.create(null) };
    item.count = (Number.isFinite(item.count) ? item.count : 0) + 1;
    item.last = iso;
    if (!item.first) item.first = iso;
    item.days = pruneDays(
      Object.assign(Object.create(null), item.days, {
        [day]: (item.days && item.days[day] || 0) + 1
      }),
      90
    );
    usage.items[safeId] = item;
    return { id: safeId, iso, day, item };
  }

  return {
    pad,
    stamp,
    sanitizeName,
    renderTemplate,
    otsuThreshold,
    resolveExportScale,
    normalizeStatId,
    dayKey,
    pruneDays,
    createUsageData,
    normalizeUsageData,
    applyButtonStat
  };
}));
