'use strict';

const test = require('node:test');
const assert = require('node:assert');
const core = require('../renderer/core.js');

/* ------------------------------------------------------------------ */
/* sanitizeName                                                        */
/* ------------------------------------------------------------------ */

test('sanitizeName: 替换 Windows 非法字符', () => {
  assert.strictEqual(core.sanitizeName('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('sanitizeName: 去掉结尾的点与空格（Win32 不允许）', () => {
  assert.strictEqual(core.sanitizeName('shot.'), 'shot');
  assert.strictEqual(core.sanitizeName('shot   '), 'shot');
  assert.strictEqual(core.sanitizeName('shot. . '), 'shot');
});

test('sanitizeName: 保留中间的点', () => {
  assert.strictEqual(core.sanitizeName('a.b.c'), 'a.b.c');
});

test('sanitizeName: 空输入回落到 shot', () => {
  assert.strictEqual(core.sanitizeName(''), 'shot');
  assert.strictEqual(core.sanitizeName('   '), 'shot');
  assert.strictEqual(core.sanitizeName('...'), 'shot');
});

test('sanitizeName: 规避 Win32 保留设备名', () => {
  assert.strictEqual(core.sanitizeName('CON'), '_CON');
  assert.strictEqual(core.sanitizeName('nul.jpg'), '_nul.jpg');
  assert.strictEqual(core.sanitizeName('com1.txt'), '_com1.txt');
  assert.strictEqual(core.sanitizeName('console'), 'console');
});

test('sanitizeName: 长度上限 120', () => {
  assert.strictEqual(core.sanitizeName('x'.repeat(300)).length, 120);
});

test('sanitizeName: 120 字符边界不会重新产生尾点/尾空格（R5-3）', () => {
  const withSpace = core.sanitizeName('a' + 'x'.repeat(118) + ' ' + 'b');
  const withDot = core.sanitizeName('a' + 'x'.repeat(117) + ' .' + 'b');
  assert.ok(withSpace.length <= 120);
  assert.ok(withDot.length <= 120);
  assert.doesNotMatch(withSpace, /[. ]$/);
  assert.doesNotMatch(withDot, /[. ]$/);
  assert.ok(withSpace.startsWith('a'));
  assert.ok(withDot.startsWith('a'));
});

/* ------------------------------------------------------------------ */
/* renderTemplate                                                      */
/* ------------------------------------------------------------------ */

test('renderTemplate: 替换 {prefix} 与 {n}', () => {
  const out = core.renderTemplate('{prefix}_{n}', 'board', 7);
  assert.strictEqual(out, 'board_7');
});

test('renderTemplate: 空模板使用默认', () => {
  const out = core.renderTemplate('', 'shot', 1);
  assert.match(out, /^shot_\d{8}-\d{6}$/);
});

test('renderTemplate: {timestamp} {date} {time} 都被替换掉', () => {
  const out = core.renderTemplate('{timestamp}-{date}-{time}-{n}', 'p', 3);
  assert.doesNotMatch(out, /[{}]/);
  assert.match(out, /-\d+$/);
});

test('renderTemplate: 模板里的非法字符会被清洗', () => {
  const out = core.renderTemplate('{prefix}', 'a/b:c', 1);
  assert.strictEqual(out, 'a_b_c');
});

/* ------------------------------------------------------------------ */
/* otsuThreshold                                                       */
/* ------------------------------------------------------------------ */

test('otsuThreshold: 双峰直方图把阈值落在两峰之间', () => {
  const gray = [];
  for (let i = 0; i < 100; i += 1) gray.push(30);
  for (let i = 0; i < 100; i += 1) gray.push(200);
  const t = core.otsuThreshold(gray);
  assert.ok(t >= 30 && t < 200, `阈值 ${t} 应落在 [30,200)`);
});

test('otsuThreshold: 全黑图不崩溃且给出合法阈值', () => {
  const gray = new Array(256).fill(0);
  const t = core.otsuThreshold(gray);
  assert.ok(Number.isInteger(t) && t >= 0 && t <= 255);
});

test('otsuThreshold: 空数组不崩溃', () => {
  assert.doesNotThrow(() => core.otsuThreshold([]));
});

/* ------------------------------------------------------------------ */
/* resolveExportScale                                                  */
/* ------------------------------------------------------------------ */

test('resolveExportScale: auto 下大图保持 1×', () => {
  assert.strictEqual(core.resolveExportScale(1920, 1080, 'auto'), 1);
  assert.strictEqual(core.resolveExportScale(1200, 900, 'auto'), 1);
});

test('resolveExportScale: auto 下小图放大到约 1200px', () => {
  assert.strictEqual(core.resolveExportScale(600, 400, 'auto'), 2);
  assert.strictEqual(core.resolveExportScale(1200 / 3, 400, 'auto'), 3);
});

test('resolveExportScale: 手动倍率原样生效', () => {
  assert.strictEqual(core.resolveExportScale(100, 100, 1), 1);
  assert.strictEqual(core.resolveExportScale(100, 100, '2'), 2);
  assert.strictEqual(core.resolveExportScale(100, 100, 3), 3);
});

test('resolveExportScale: 手动倍率被夹到 1~3', () => {
  assert.strictEqual(core.resolveExportScale(100, 100, 0), 1);
  assert.strictEqual(core.resolveExportScale(100, 100, 9), 3);
});

test('resolveExportScale: 缺省即 auto', () => {
  assert.strictEqual(core.resolveExportScale(1920, 1080), 1);
});

/* ------------------------------------------------------------------ */
/* stamp                                                               */
/* ------------------------------------------------------------------ */

test('stamp: 输出格式固定', () => {
  const s = core.stamp(new Date(2026, 0, 2, 3, 4, 5));
  assert.strictEqual(s.date, '20260102');
  assert.strictEqual(s.time, '030405');
  assert.strictEqual(s.timestamp, '20260102-030405');
});

/* ------------------------------------------------------------------ */
/* UI 使用统计辅助函数                                                  */
/* ------------------------------------------------------------------ */

test('normalizeStatId: 接受稳定 ASCII 标识', () => {
  assert.strictEqual(core.normalizeStatId('btnShot'), 'btnShot');
  assert.strictEqual(core.normalizeStatId(' rot90 '), 'rot90');
  assert.strictEqual(core.normalizeStatId('import-image_1'), 'import-image_1');
});

test('normalizeStatId: 拒绝空值/空格/非法字符/超长', () => {
  assert.strictEqual(core.normalizeStatId(null), null);
  assert.strictEqual(core.normalizeStatId('  '), null);
  assert.strictEqual(core.normalizeStatId('按钮'), null);
  assert.strictEqual(core.normalizeStatId('a/b'), null);
  assert.strictEqual(core.normalizeStatId('x'.repeat(65)), null);
});

test('dayKey: 与 stamp().date 同格式', () => {
  const d = new Date(2026, 10, 24, 7, 30);
  assert.strictEqual(core.dayKey(d), core.stamp(d).date);
  assert.strictEqual(core.dayKey(d), '20261124');
});

test('pruneDays: 未超限原样返回，超限只留最近 90 天', () => {
  const days = {};
  for (let i = 1; i <= 100; i += 1) days[String(20260101 + i).padStart(8, '0')] = i;
  assert.strictEqual(Object.keys(core.pruneDays(days)).length, 90);
  const kept = core.pruneDays(days);
  assert.ok(!('20260102' in kept));
  assert.ok('20260201' in kept);
  const small = { 20260101: 1 };
  assert.strictEqual(core.pruneDays(small), small);
});

test('normalizeStatId: 排除会命中原型链的保留键', () => {
  for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.strictEqual(core.normalizeStatId(key), null, `${key} 必须被拒绝`);
  }
  assert.strictEqual(core.normalizeStatId('btnShot'), 'btnShot');
});

test('applyButtonStat: 正常计数且返回本次命中信息', () => {
  const usage = core.createUsageData();
  const d = new Date(2026, 10, 24, 8, 0, 0);
  const r1 = core.applyButtonStat(usage, 'btnShot', d);
  const r2 = core.applyButtonStat(usage, 'btnShot', d);
  assert.strictEqual(r2.id, 'btnShot');
  assert.strictEqual(r2.day, '20261124');
  assert.strictEqual(usage.total, 2);
  assert.strictEqual(usage.items.btnShot.count, 2);
  assert.strictEqual(usage.days['20261124'], 2);
  assert.strictEqual(usage.items.btnShot.days['20261124'], 2);
  assert.ok(usage.items.btnShot.first);
  assert.ok(usage.items.btnShot.last >= usage.items.btnShot.first);
});

test('applyButtonStat: 原型键不污染 Object.prototype、不计数', () => {
  const usage = core.createUsageData();
  assert.strictEqual(core.applyButtonStat(usage, '__proto__'), null);
  assert.strictEqual(core.applyButtonStat(usage, 'constructor'), null);
  assert.strictEqual(usage.total, 0);
  assert.strictEqual(Object.prototype.count, undefined);
  assert.strictEqual(Object.prototype.last, undefined);
  assert.strictEqual(Object.prototype.days, undefined);
});

test('applyButtonStat: item 缺 days / days 为 null 时不抛错', () => {
  const usage = { version: 1, total: 3, days: {}, items: { btnShot: { count: 2, first: 'old' } } };
  assert.doesNotThrow(() => core.applyButtonStat(usage, 'btnShot'));
  assert.strictEqual(usage.items.btnShot.count, 3);
  assert.strictEqual(usage.items.btnShot.first, 'old');
  assert.ok(usage.items.btnShot.days && typeof usage.items.btnShot.days === 'object');

  usage.items.btnSave = { count: 5, days: null };
  assert.doesNotThrow(() => core.applyButtonStat(usage, 'btnSave'));
  assert.strictEqual(usage.items.btnSave.count, 6);
});

test('normalizeUsageData: 过滤坏键与坏字段，保留合法统计', () => {
  const raw = {
    version: 1,
    total: 9,
    days: { 20261124: 3, bad: 5, 20261123: -1 },
    items: {
      btnShot: { count: 3, first: 'a', last: 'b', days: { 20261124: 2, bad: 7 } },
      btnSave: { count: 2, days: null },
      __proto__: { count: 100 },
      constructor: { count: 100 },
      broken: null
    }
  };
  const u = core.normalizeUsageData(raw);
  assert.strictEqual(u.total, 9);
  assert.strictEqual(u.days['20261124'], 3);
  assert.strictEqual(u.days.bad, undefined);
  assert.strictEqual(u.days['20261123'], undefined);
  assert.strictEqual(u.items.btnShot.count, 3);
  assert.strictEqual(u.items.btnShot.days['20261124'], 2);
  assert.strictEqual(u.items.btnShot.days.bad, undefined);
  // days 为 null → 由 count 兜底，仍保留该项
  assert.strictEqual(u.items.btnSave.count, 2);
  assert.deepStrictEqual(Object.keys(u.items.btnSave.days), []);
  assert.strictEqual(Object.keys(u.items).length, 2);
  assert.strictEqual(Object.getPrototypeOf(u.items), null);
  assert.strictEqual(Object.getPrototypeOf(u.days), null);
});

test('normalizeUsageData: 文件损坏或非 v1 时返回空结构', () => {
  for (const raw of [null, {}, { version: 2, items: {} }, { version: 1, items: null }]) {
    const u = core.normalizeUsageData(raw);
    assert.strictEqual(u.version, 1);
    assert.strictEqual(u.total, 0);
    assert.deepStrictEqual(Object.keys(u.items), []);
  }
});
