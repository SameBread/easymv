import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, compileScript, frameAt, balanceRows, ensureContrast, contrast, hexToRgb, PACK_IDS, spring, summarize } from '../js/kinetic.js';

const measure = (s, f, w, px) => s.length * px * 0.55;
const SCRIPT = `@pack punchy
# Capital
Who owns the factory?

- Workers make **everything**
- Owners keep the profit

> The history of all society is the history of class struggle.
-- Marx

3 classes

(quiet ending)`;
const mk = (txt, extra = {}) => compileScript(parseScript(txt), { W: 1280, H: 720, measure, ...extra });

test('parse scenes, roles, options', () => {
  const s = parseScript(SCRIPT);
  assert.equal(s.options.pack, 'punchy');
  assert.equal(s.scenes.length, 5);
  assert.equal(s.scenes[1].lines[0].role, 'bullet');
  assert.equal(s.scenes[1].lines[0].words[2].emph, true);
});
test('balanceRows fits', () => {
  const rows = balanceRows([50, 50, 50, 50], 5, 120);
  assert.ok(rows.every(([a, b]) => b > a));
  assert.equal(rows.at(-1)[1], 4);
});
test('contrast ensured', () => {
  const c = ensureContrast(hexToRgb('#777777'), hexToRgb('#808080'), 4.5);
  assert.ok(contrast(c, hexToRgb('#808080')) >= 4.5);
});
test('deterministic compile', () => {
  const a = JSON.stringify(summarize(mk(SCRIPT))); const b = JSON.stringify(summarize(mk(SCRIPT)));
  assert.equal(a, b);
  assert.notEqual(a, JSON.stringify(summarize(mk(SCRIPT, { seed: 9 }))));
});
test('runs stay inside canvas, all packs', () => {
  for (const pack of PACK_IDS) {
    const c = mk(SCRIPT, { pack });
    for (const sc of c.scenes) for (const r of sc.runs) {
      assert.ok(Number.isFinite(r.x + r.y + r.size), pack);
      if (r.deco) continue;
      assert.ok(r.x - r.w / 2 > -2 && r.x + r.w / 2 < 1282, `${pack} x ${r.text}`);
      assert.ok(r.y > 0 && r.y < 720, `${pack} y ${r.text}`);
    }
  }
});
test('timing monotonic and total fill', () => {
  const c = mk(SCRIPT, { total: 30 });
  for (let i = 1; i < c.scenes.length; i++) assert.ok(c.scenes[i].t0 >= c.scenes[i - 1].t0);
  assert.ok(Math.abs(c.total - 30) < 0.5);
});
test('explicit times and ::dur', () => {
  const c = mk('[0:02] one two\n\n[0:08] three four\n::dur 3');
  assert.equal(c.scenes[0].t0, 2); assert.equal(c.scenes[1].t0, 8); assert.equal(c.scenes[1].dur, 3);
});
test('frames: finite geometry across time', () => {
  const c = mk(SCRIPT);
  for (let t = 0; t <= c.total; t += 0.1) {
    const f = frameAt(c, t, { pulse: 0.5 });
    assert.ok(f.passes.length >= 1);
    for (const p of f.passes) { assert.ok(p.geo.n % 3 === 0); for (const v of p.geo.pos) assert.ok(Number.isFinite(v)); for (const r of p.runs) assert.ok(Number.isFinite(r.x + r.y + r.alpha)); }
  }
});
test('transition overlap yields two passes', () => {
  const c = mk(SCRIPT); const s = c.scenes[1];
  const f = frameAt(c, s.t0, {});
  assert.equal(f.passes.length, 2);
});
test('spring settles', () => { assert.ok(Math.abs(spring(3, 200, 0.6) - 1) < 0.01); });
test('layout variety', () => {
  const txt = Array.from({ length: 10 }, (_, i) => `Statement number ${i} about **power** and labour`).join('\n\n');
  const used = new Set(summarize(mk(txt)).map((s) => s.layout));
  assert.ok(used.size >= 3, [...used].join());
});
