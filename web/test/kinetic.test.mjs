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
  assert.equal(c.scenes[0].t0, 2); assert.equal(c.scenes[0].dur, 2.5); assert.equal(c.scenes[0].gone, 4.5);
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
test('size per line, word and syllable; others stay normal', () => {
  const c = mk('::layout center\nfirst line\nbig line {size=2}\nplain **col^2|laps|ing**');
  const R = (t) => c.scenes[0].runs.find((r) => r.text.toLowerCase() === t);
  assert.ok(R('big').size > R('first').size * 1.5);
  assert.ok(R('col').size > R('laps').size * 1.5);
  assert.ok(Math.abs(R('laps').size - R('ing').size) < 1e-6);
});

test('lines sharing an {at} form one block; rect regions, align, max, role, colour', () => {
  const c = mk('::layout center\nfirst {at=10:20:40:30 align=left max=6 color=#ff0000 role=body}\nsecond {at=10:20:40:30 align=left max=6 color=#ff0000 role=body}\nelsewhere {at=60:70:30:20}');
  const R = (t) => c.scenes[0].runs.find((r) => r.text.toLowerCase() === t);
  assert.ok(R('first').y < R('second').y, 'stacked, not overlapping');
  assert.ok(R('first').x - R('first').w / 2 >= 1280 * 0.1 - 2 && R('second').x + R('second').w / 2 <= 1280 * 0.5 + 2);
  assert.ok(R('first').y > 720 * 0.2 && R('second').y < 720 * 0.5);
  assert.equal(R('first').color, '#ff0000');
  assert.ok(R('first').size <= 720 * 0.06 + 1);
  assert.ok(R('elsewhere').x > 1280 * 0.6 && R('elsewhere').y > 720 * 0.7);
});

const alphas = (c, t) => frameAt(c, t, {}).passes.flatMap((p) => p.runs.map((r) => r.alpha));
const maxA = (c, t) => Math.max(0, ...alphas(c, t));

test('text of a finished scene keeps fading while the next scene starts (no pop)', () => {
  const c = mk('[0:02] first line here\n---\n[0:06] second line here', { bgMode: 'none' });
  const s0 = c.scenes[0];
  assert.ok(s0.gone > s0.t1, 'a scene without an explicit end fades after its time is up');
  const mid = s0.t1 + s0.outD / 2;
  const f = frameAt(c, mid, {});
  const old = f.passes.flatMap((p) => p.runs).filter((r) => r.text.toLowerCase() === 'first');
  assert.ok(old.length && old[0].alpha > 0.05 && old[0].alpha < 0.95, `fading, alpha ${old[0]?.alpha}`);
  assert.equal(alphas(c, s0.gone + 0.01).filter((a) => a > 0).length > 0, true);
});
test('a fade transition does not leave the old text at full strength until it pops', () => {
  const c = mk('::trans fade\n[0:02] aaa bbb\n---\n::trans fade\n[0:05] ccc ddd', { bgMode: 'none' });
  const a = c.scenes[0];
  let prev = 1;
  for (let t = a.t1 - 0.05; t < a.gone; t += 0.02) {
    const v = frameAt(c, t, {}).passes.flatMap((p) => p.runs).filter((r) => r.text.toLowerCase() === 'aaa').map((r) => r.alpha)[0] ?? 0;
    assert.ok(v <= prev + 1e-6, `alpha never jumps up (${v} after ${prev} at ${t})`);
    assert.ok(prev - v < 0.35, `no sudden drop (${prev} -> ${v} at ${t.toFixed(2)})`);
    prev = v;
  }
});
test('::out sets the fade length and ::out cut removes it', () => {
  const slow = mk('::out 1.2\n[0:02-0:03] hello', { bgMode: 'none' });
  assert.equal(slow.scenes[0].outD, 1.2);
  const cut = mk('::out cut\n[0:02] hello\n---\n[0:05] bye', { bgMode: 'none' });
  assert.equal(cut.scenes[0].outD, 0);
  assert.equal(cut.scenes[0].gone, cut.scenes[0].t1);
});
test('scenes are self-contained: block order in the text does not change timing or transitions', () => {
  const a = mk('[0:10] late scene\n---\n[0:02] early scene', { bgMode: 'none' });
  assert.equal(a.scenes[0].t0, 10); assert.equal(a.scenes[1].t0, 2);
  assert.equal(a.scenes[1].dur, 8, 'the early scene runs until the next timed scene, wherever it is written');
  assert.equal(a.scenes[1].next, 0); assert.equal(a.scenes[0].enter, a.scenes[1].trans);
  assert.ok(maxA(a, 3) > 0 && maxA(a, 11) > 0);
});
test('a blank line or --- always starts a scene, and +++ keeps one going', () => {
  assert.equal(parseScript('# a\nline\n\nmore\n---\n# b\nx').scenes.length, 3);
  assert.equal(parseScript('# a\nline\n\nmore').scenes.length, 2);
  assert.equal(parseScript('[0:01] one\n\n[0:03] two').scenes.length, 2);
  assert.equal(parseScript('[0:01] one\n+++\n\n[0:03] two').scenes.length, 1);
  assert.equal(parseScript('[0:01] one\n\n+++\n[0:03] two').scenes.length, 1);
  assert.equal(parseScript('[0:01] one\n\n+++\n\n[0:03] two\n\n[0:05] three').scenes.length, 2);
  assert.equal(parseScript('[0:01] one\n+++\n---\n[0:03] two').scenes.length, 2);
});
test('a script mixing blank lines and one --- keeps its stanzas as separate scenes', () => {
  const txt = '[0:03-0:08] one\n\n[0:10-0:15] two\n\n[0:19] three\n[0:20] four\n\n---\n[0:45] five';
  assert.equal(parseScript(txt).scenes.length, 4);
  const c = mk(txt, { bgMode: 'none' });
  assert.ok(c.scenes[0].gone < c.scenes[1].t0 + 1, 'the first stanza is gone before the third starts');
  assert.equal(frameAt(c, 16, {}).passes.flatMap((p) => p.runs).length, 0);
});
test('the lyrics demo compiles into separate scenes and uses the new syntax', async () => {
  const { DEMO_LYRICS, MODES } = await import('../js/script.js');
  assert.equal(MODES.lyrics.place, 'full');
  const sc = parseScript(DEMO_LYRICS);
  assert.equal(sc.scenes.length, 9);
  assert.ok(/::deco/.test(DEMO_LYRICS) && /@fx/.test(DEMO_LYRICS) && /::fx/.test(DEMO_LYRICS) && /::out/.test(DEMO_LYRICS) && /~2\.0\|laps/.test(DEMO_LYRICS));
  const c = mk(DEMO_LYRICS, { bgMode: 'none' });
  assert.ok(c.scenes.some((s) => s.decor.length) && c.scenes.some((s) => s.runs.some((r) => r.fx?.length)));
  for (let t = 0; t < 70; t += 0.5) for (const p of frameAt(c, t, {}).passes) for (const r of p.runs) assert.ok(Number.isFinite(r.x + r.y + r.alpha));
});
test('nothing is drawn before the first scene starts', () => {
  const c = mk('[0:05] hi there', { bgMode: 'scenes' });
  assert.equal(frameAt(c, 1, {}).passes.length, 0);
});

test('layout side bars are off by default and ::deco turns decorations on', () => {
  const base = '::layout left\n::emph none\n[0:01] hello there world';
  const off = mk(base, { bgMode: 'none' });
  assert.equal(off.scenes[0].decor.length, 0, 'no bar unless asked');
  const on = mk('::layout left\n::deco bar+underline color=#ff0000\n[0:01] hello there world', { bgMode: 'none' });
  assert.ok(on.scenes[0].decor.length >= 2);
  assert.ok(on.scenes[0].decor.every((d) => d.c === '#ff0000'));
  const all = mk('@deco brackets\n[0:01] one\n---\n[0:04] two', { bgMode: 'none' });
  assert.ok(all.scenes.every((s) => s.decor.length === 8));
  const g = frameAt(on, 1.5, {}).passes[0].geo; assert.ok(g.n > 0);
  const none = frameAt(off, 1.5, {}).passes[0].geo; assert.equal(none.n, 0);
});
test('every decoration name makes shapes', async () => {
  const { DECO_NAMES } = await import('../js/kinetic.js');
  for (const n of DECO_NAMES) assert.ok(mk(`::deco ${n}\n[0:01] hi there`, { bgMode: 'none' }).scenes[0].decor.length > 0, n);
});
test('per-word effects parse from {fx=..}, bare names, lines and scenes', async () => {
  const { FX_NAMES } = await import('../js/kinetic.js');
  const c = mk('[0:01] plain shaky{shake} bouncy{fx=bounce+rainbow amp=2 speed=3}\n[0:02] all wave {wave}\n::fx pulse\n---\n[0:05] scene wide', { bgMode: 'none' });
  const runs = (i) => c.scenes[i].runs;
  const find = (i, txt) => runs(i).find((r) => r.text.toLowerCase() === txt);
  assert.equal(find(0, 'shaky').fx.join(), 'shake');
  assert.deepEqual(find(0, 'bouncy').fx, ['bounce', 'rainbow']); assert.equal(find(0, 'bouncy').fxAmp, 2); assert.equal(find(0, 'bouncy').fxSpeed, 3);
  assert.equal(find(0, 'plain').fx?.join(), 'pulse');
  assert.equal(find(1, 'scene').fx, undefined);
  for (const n of FX_NAMES) {
    const k = mk(`[0:01] word{${n}}`, { bgMode: 'none' });
    for (let t = 1.2; t < 2; t += 0.13) assert.ok(frameAt(k, t, {}).passes[0].runs.every((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.alpha) && Number.isFinite(r.rot)), n);
  }
});
test('effects move the word and are repeatable', () => {
  const k = mk('[0:01] word{shake}', { bgMode: 'none' });
  const at = (t) => frameAt(k, t, {}).passes[0].runs[0];
  assert.ok(Math.abs(at(1.8).x - at(1.9).x) + Math.abs(at(1.8).y - at(1.9).y) > 0);
  assert.equal(at(1.85).x, at(1.85).x);
  const r = mk('[0:01] word{rainbow}', { bgMode: 'none' });
  assert.notEqual(frameAt(r, 1.5, {}).passes[0].runs[0].color, frameAt(r, 1.9, {}).passes[0].runs[0].color);
});

import { parseLook, LOOK_NAMES } from '../js/kinetic.js';
test('text looks: default plain, ::look per scene, @look for all, runs carry it', () => {
  assert.deepEqual(parseLook('Glow+outline  nope'), ['glow', 'outline']);
  assert.deepEqual(LOOK_NAMES.includes('neon'), true);
  const plain = compileScript(parseScript('[0:01] Hello world'), { W: 1280, H: 720, measure });
  assert.deepEqual(plain.scenes[0].look, []);
  const c = compileScript(parseScript('@look outline\n[0:01] One\n\n::look neon+glow\n[0:05] Two'), { W: 1280, H: 720, measure });
  assert.deepEqual(c.scenes.map((s) => s.look), [['outline'], ['neon', 'glow']]);
  const f = frameAt(c, 3); assert.ok(f.passes[0].runs.filter((r) => !r.deco).every((r) => r.look === 'outline'));
  const f2 = frameAt(c, 7); assert.ok(f2.passes.at(-1).runs.filter((r) => !r.deco).every((r) => r.look === 'neon+glow'));
});
