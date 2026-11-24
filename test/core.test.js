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
