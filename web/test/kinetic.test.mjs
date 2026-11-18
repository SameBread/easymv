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

test('time tag with end sets scene length and fade-out', () => {
  const c = mk('[0:02.0-0:04.5] hello there\n\n[0:08] next line', { bgMode: 'none' });
  assert.equal(c.scenes[0].t0, 2); assert.equal(c.scenes[0].dur, 2.5); assert.equal(c.scenes[0].fadeOut, true);
  assert.equal(c.scenes[1].t0, 8);
  const f = frameAt(c, 6, {}); // in the gap: nothing visible
  assert.ok(f.passes.every((p) => p.runs.length === 0));
  const g = frameAt(c, 4.45, {}); assert.ok(g.passes[0].runs.every((r) => r.alpha < 0.3));
});
test('transparent background draws no geometry', () => {
  const c = mk('# Hi there\nfriend', { bgMode: 'none', pack: 'smooth', layoutSet: 'calm' });
  const f = frameAt(c, 1.5, {});
  assert.equal(f.passes[0].geo.n, 0);
  assert.ok(f.passes[0].runs.length > 0);
  const d = frameAt(mk('# Hi there\nfriend'), 1.5, {});
  assert.ok(d.passes[0].geo.n > 0);
});
test('lower-third placement keeps text in the lower band', () => {
  const c = mk('[0:01] a line of words that sings\n[0:03] another line', { place: 'lower', layoutSet: 'calm', bgMode: 'none' });
  for (const sc of c.scenes) for (const r of sc.runs) { assert.ok(r.y > 720 * 0.55 && r.y < 720 * 0.97, `y ${r.y}`); assert.ok(['center', 'left', 'diagonal'].includes(sc.layout)); }
});
test('word reveal spreads words across the line time', () => {
  const c = mk('[0:01.0-0:05.0] one two three four', { reveal: 'word', bgMode: 'none' });
  const t = c.scenes[0].runs.map((r) => r.t0).sort((a, b) => a - b);
  assert.ok(t[3] - t[0] > 1.5, t.join()); assert.ok(t[3] < 5);
  const l = mk('[0:01.0-0:05.0] one two three four', { reveal: 'line', bgMode: 'none' });
  const u = l.scenes[0].runs.map((r) => r.t0); assert.ok(Math.max(...u) - Math.min(...u) < 0.2);
});
test('colour overrides and solid background', () => {
  const c = mk('# Hi', { bgMode: 'none', fg: '#ff0000', accent: '#00ff00' });
  assert.deepEqual(c.scenes[0].pal.fg, [255, 0, 0]);
  const s = mk('# Hi', { bgMode: 'solid', bgColor: '#102030' });
  assert.equal(s.scenes[0].bgKind, 'solid'); assert.deepEqual(s.scenes[0].pal.bg, [16, 32, 48]);
});
test('::reveal directive beats the script default', () => {
  const c = mk('::reveal line\n[0:01.0-0:05.0] one two three four', { reveal: 'word' });
  const u = c.scenes[0].runs.map((r) => r.t0); assert.ok(Math.max(...u) - Math.min(...u) < 0.2);
});

import { parseRegion, parseMods } from '../js/kinetic.js';
test('regions: grid cells, spans, names', () => {
  assert.deepEqual(parseRegion('A1'), { c0: 0, c1: 0, r0: 0, r1: 0 });
  assert.deepEqual(parseRegion('c3'), { c0: 2, c1: 2, r0: 2, r1: 2 });
  assert.deepEqual(parseRegion('A1-B2'), { c0: 0, c1: 1, r0: 0, r1: 1 });
  assert.deepEqual(parseRegion('left'), { c0: 0, c1: 0, r0: 0, r1: 2 });
  assert.deepEqual(parseRegion('top right'), { c0: 2, c1: 2, r0: 0, r1: 0 });
  assert.equal(parseRegion('nowhere'), null);
});
test('mods parse', () => {
  assert.deepEqual(parseMods('big accent at=C3 delay=.5'), { size: 1.5, color: 'accent', at: 'C3', delay: 0.5 });
});
test('::at puts the scene in its region', () => {
  const c = mk('::at A1\nhello world');
  for (const r of c.scenes[0].runs) assert.ok(r.x < 1280 / 3 + 5 && r.y < 720 / 3 + 5, `${r.x},${r.y}`);
  const d = mk('::at right\nhello world'); for (const r of d.scenes[0].runs) assert.ok(r.x > 1280 * 0.6);
});
test('line {at} and word {at} placement, word styling', () => {
  const c = mk('first line\nsecond line {at=C3}\nplain [big word]{size=2 color=#ff0000 delay=.4} end{at=A1}');
  const runs = c.scenes[0].runs;
  const sec = runs.filter((r) => r.li === 1); assert.ok(sec.length && sec.every((r) => r.x > 1280 * 0.6 && r.y > 720 * 0.6));
  const end = runs.find((r) => r.text.toLowerCase() === 'end'); assert.ok(end.x < 1280 / 3 + 5 && end.y < 720 / 3 + 5);
  const big = runs.find((r) => r.text.toLowerCase() === 'big'); assert.equal(big.color, '#ff0000');
  const plain = runs.find((r) => r.text.toLowerCase() === 'plain'); assert.ok(big.size > plain.size * 1.5);
});
test('syllables appear one by one with editable durations', () => {
  const c = mk('[0:54.90-0:59.00] i\'m **col|laps~.6|ing**{size=2 color=accent} {at=B3}');
  const rs = c.scenes[0].runs.filter((r) => /^(col|laps|ing)$/i.test(r.text));
  assert.equal(rs.length, 3);
  assert.ok(rs[0].x < rs[1].x && rs[1].x < rs[2].x);
  assert.ok(Math.abs(rs[1].t0 - rs[0].t0 - 0.28) < 1e-6);
  assert.ok(Math.abs(rs[2].t0 - rs[1].t0 - 0.6) < 1e-6);
  const d = mk('go **ba|na|na**{step=.5}').scenes[0].runs.filter((r) => /^na$/i.test(r.text));
  assert.ok(Math.abs(d[1].t0 - d[0].t0 - 0.5) < 1e-6);
});
