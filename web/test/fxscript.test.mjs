import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFx, sampleFx, parseTime, parseSpan, lintFx, applyFxFix, suggestFx, classifyFx, graphFx, FX_TEMPLATES } from '../js/fxscript.js';

const TEMPO = { bpm: 120, offset: 0, sig: 4, changes: [] };
const base = { speed: 1, wind: 0.2, windY: 0 };

test('times and spans', () => {
  assert.equal(parseTime('0:12.5').t, 12.5);
  assert.equal(parseTime('1:02').t, 62);
  assert.equal(parseTime('7').t, 7);
  assert.equal(parseTime('@3', TEMPO).t, 4);          // bar 3 at 120 bpm 4/4 = 4 s
  assert.equal(parseTime('@3.3', TEMPO).t, 5);
  assert.equal(parseTime('nope'), null);
  assert.equal(parseSpan('2s', 0, null), 2);
  assert.equal(parseSpan('500ms', 0, null), 0.5);
  assert.equal(parseSpan('1 bar', 0, TEMPO), 2);
  assert.equal(parseSpan('2beats', 0, TEMPO), 1);
  assert.ok(parseSpan('1bar', 0, null).needsTempo);
});

test('every verb compiles to an event', () => {
  const c = compileFx(`// comment
[0:01] gust right 0.8 for 2s
[0:05] wind left 0.4 over 3s
[0:09] calm
[0:10] speed 2 over 1s
[0:11] density 0.5
[0:12] size 1.5
[0:13] turbulence 2
[0:14] glow 2
[0:15] burst 80 at 0.2,0.9 up {spread=0.4 power=1.5}
[0:16] flash red
[0:17] tint blue 0.5 for 3s
[0:20] pulse size 0.5 every 0.5s`);
  assert.deepEqual(c.issues, []);
  assert.deepEqual(c.events.map((e) => e.type), ['gust', 'wind', 'wind', 'speed', 'density', 'size', 'turb', 'glow', 'burst', 'flash', 'tint', 'pulse']);
  const g = c.events[0]; assert.equal(g.dur, 2); assert.equal(g.amp, 0.8); assert.equal(g.dx, 1);
  const b = c.events[8]; assert.equal(b.count, 80); assert.equal(b.ox, 0.2); assert.equal(b.oy, 0.9); assert.equal(b.spread, 0.4); assert.equal(b.power, 1.5); assert.ok(b.ang < 0);
});

test('mistakes are reported, not silently ignored', () => {
  const c = compileFx('gust right\n[0:xx] gust\n[0:02] gsut left\n[0:03] speed\n[0:04] tint\n[@2] gust right\n[0:05] gust right for 1 bar');
  const codes = c.issues.map((i) => i.code);
  for (const k of ['notime', 'badtime', 'badverb', 'nonum', 'nocolor', 'needstempo']) assert.ok(codes.includes(k), k);
  const l = lintFx('[0:02] gsut left', {});
  assert.ok(/gust/.test(l[0].msg));
  assert.equal(applyFxFix('[0:02] gsut left', l[0]), '[0:02] gust left');
});

test('no script means plain time-based motion', () => {
  const c = compileFx('', {});
  const s = sampleFx(c, 5, base, 0);
  assert.equal(s.phase, 5); assert.equal(s.dx, 1); assert.equal(s.lx, 0.2);
  assert.equal(sampleFx(c, 5, { ...base, speed: 2 }, 0).phase, 10);
});

test('a gust pushes particles and the push stays (integrated), shape is smooth', () => {
  const c = compileFx('[0:02] gust right 1 for 2s {attack=0.5 release=1}');
  const at = (t) => sampleFx(c, t, { speed: 1, wind: 0, windY: 0 }, 0);
  assert.ok(Math.abs(at(1).lx) < 1e-9);
  assert.ok(at(2.25).lx > 0.3 && at(2.25).lx < 1);
  assert.ok(Math.abs(at(3).lx - 1) < 1e-6);                   // fully on in the middle
  assert.ok(at(10).lx < 1e-6);                                 // over
  assert.ok(at(10).dx > 2 && at(10).dx < 2.5);               // displaced, and it keeps that displacement
  assert.ok(Math.abs(at(20).dx - at(10).dx) < 1e-3);
  let prev = -1; for (let t = 1; t < 8; t += 0.02) { const dx = at(t).dx; assert.ok(dx >= prev - 1e-6); prev = dx; }     // never goes backwards for a rightward gust
  const left = compileFx('[0:02] gust left 1 for 2s'); assert.ok(sampleFx(left, 10, { speed: 1, wind: 0, windY: 0 }, 0).dx < -2);
});

test('wind sets a steady wind and calm ends it', () => {
  const c = compileFx('[0:05] wind left 0.5 over 1s\n[0:15] calm over 1s');
  const at = (t) => sampleFx(c, t, { speed: 1, wind: 0.3, windY: 0 }, 0).lx;
  assert.ok(Math.abs(at(1) - 0.3) < 1e-9);
  assert.ok(Math.abs(at(8) + 0.5) < 1e-6);
  assert.ok(Math.abs(at(20)) < 1e-6);
});

test('speed, density, size ramp and phase integrates speed', () => {
  const c = compileFx('[0:02] speed 3 over 0.0s\n[0:04] speed 1 over 0.0s\n[0:03] density 0.2 over 1s\n[0:05] size 2');
  const at = (t) => sampleFx(c, t, { speed: 1, wind: 0, windY: 0 }, 0);
  assert.ok(Math.abs(at(2).phase - 2) < 0.05);
  assert.ok(Math.abs(at(4).phase - (2 + 6)) < 0.1);            // two seconds at triple speed
  assert.ok(Math.abs(at(5).phase - 9) < 0.1);
  assert.ok(at(1).density === 1 && Math.abs(at(5).density - 0.2) < 1e-6);
  assert.equal(at(1).size, 1); assert.ok(at(9).size > 1.99);
  const mono = []; for (let t = 0; t < 10; t += 0.05) mono.push(at(t).phase); assert.ok(mono.every((v, i) => !i || v >= mono[i - 1]));
});

test('time range ends the change', () => {
  const c = compileFx('[0:02-0:04] speed 4 over 0.1s');
  const at = (t) => sampleFx(c, t, { speed: 1, wind: 0, windY: 0 }, 0);
  const rate = (t) => (at(t + 0.1).phase - at(t).phase) / 0.1;
  assert.ok(Math.abs(rate(3) - 4) < 0.05); assert.ok(Math.abs(rate(6) - 1) < 0.05); assert.ok(Math.abs(rate(0.5) - 1) < 0.05);
});

test('falling things speed up in a downdraft and rising things slow down', () => {
  const c = compileFx('[0:01] gust down 1 for 4s');
  const fall = sampleFx(c, 4, { speed: 1, wind: 0, windY: 0 }, 1); const rise = sampleFx(c, 4, { speed: 1, wind: 0, windY: 0 }, -1); const none = sampleFx(c, 4, { speed: 1, wind: 0, windY: 0 }, 0);
  assert.ok(fall.phase > none.phase && rise.phase < none.phase);
});

test('bursts, flashes and tints are only active in their window', () => {
  const c = compileFx('[0:02] burst 50 {life=1.5}\n[0:05] flash white\n[0:08] tint blue 0.8 for 2s');
  const at = (t) => sampleFx(c, t, base, 0);
  assert.equal(at(1).bursts.length, 0); assert.equal(at(2.5).bursts.length, 1); assert.equal(at(4).bursts.length, 0);
  assert.equal(at(2.5).bursts[0].count, 50);
  assert.ok(at(4).flash[3] === 0 && at(5.05).flash[3] > 0.3 && at(7).flash[3] < 0.01);
  assert.ok(at(7).tint[3] === 0 && at(8.8).tint[3] > 0.3 && at(11).tint[3] === 0);
});

test('pulse follows the tempo and bar times land on the grid', () => {
  const c = compileFx('[@1] pulse size 1 every beat', { tempo: TEMPO });
  assert.equal(c.issues.length, 0);
  const s = (t) => sampleFx(c, t, base, 0).size;
  assert.ok(s(0.0) > 1.9 && s(0.49) < 1.1 && s(0.5) > 1.9 && s(1.0) > 1.9);   // kick on each beat, decays between
  const no = compileFx('[0:01] pulse size 1 every beat', {});
  assert.ok(no.issues.some((i) => i.code === 'needstempo'));
});

test('sampling is deterministic and order independent (scrub = export)', () => {
  const c = compileFx(FX_TEMPLATES[1].text);
  const a = [3, 27, 12, 40, 12].map((t) => sampleFx(c, t, base, 1));
  assert.deepEqual(a[2], a[4]);
  const c2 = compileFx(FX_TEMPLATES[1].text);
  assert.deepEqual(sampleFx(c2, 12, base, 1), a[2]);
  for (const t of [0, 0.01, 1, 50, 100, 5000]) for (const v of Object.values(sampleFx(c, t, base, 1))) for (const n of [v].flat(3)) if (typeof n === 'number') assert.ok(Number.isFinite(n));
});

test('every template compiles clean (with a tempo) and graphs', () => {
  for (const t of FX_TEMPLATES) { const c = compileFx(t.text, { tempo: TEMPO }); assert.deepEqual(c.issues, [], t.id); assert.ok(c.events.length); assert.equal(graphFx(c, base, 0, 60, 20).length, 20); }
});

test('editor help: suggestions and colours', () => {
  assert.ok(suggestFx('[0:01] gu', 9).items.some((x) => x.insert === 'gust'));
  assert.ok(suggestFx('[0:01] gust ri', 14).items.some((x) => x.insert === 'right'));
  assert.ok(suggestFx('[0:01] flash re', 15).items.some((x) => x.insert === 'red'));
  const cls = classifyFx('[0:01] gust right 0.8');
  assert.equal(cls[0], 'k-time'); assert.equal(cls[8], 'k-dir');
  assert.equal(classifyFx('// hi')[0], 'k-comment');
});

test('garbage never throws', () => {
  const bits = ['[0:01]', '[@2]', 'gust', 'wind', 'burst', 'left', '0.5', 'for', '2s', '{', '}', 'at', '0.5,0.5', '\n', 'pulse', 'every', 'beat', '#ff0000', 'flash', 'tint', '//', '-', '[0:03-0:01]'];
  let seed = 3; const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let n = 0; n < 1500; n++) { let s = ''; for (let i = 0, k = 1 + Math.floor(r() * 14); i < k; i++) s += bits[Math.floor(r() * bits.length)] + ' '; const c = compileFx(s, { tempo: r() < 0.5 ? TEMPO : null }); lintFx(s, { songSec: 30, tempo: null }); sampleFx(c, r() * 60, base, 1); suggestFx(s, Math.floor(r() * s.length)); }
});
