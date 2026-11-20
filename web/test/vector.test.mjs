import test from 'node:test';
import assert from 'node:assert/strict';
import { presetPath, SHAPE_KINDS, SHAPE_GROUPS, parseRich, niceScale, layoutChart, normChart, resolveTable, parseDelimited, chartFromRows, rowsFromChart } from '../js/vector.js';
import { parseScript, compileScript } from '../js/kinetic.js';
import { plain } from '../js/scripttext.js';

test('every listed shape has finite geometry', () => {
  assert.ok(SHAPE_KINDS.length >= 70);
  for (const g of SHAPE_GROUPS) for (const k of g.kinds) {
    const p = presetPath(k, 200, 120, {});
    assert.ok(p.known, k);
    assert.ok(p.cmds.length > 1, k);
    for (const c of p.cmds) for (const v of c.slice(1)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} ${c}`);
  }
  assert.equal(presetPath('nonsense', 10, 10).known, false);
  assert.equal(presetPath('line', 10, 10).open, true);
});

test('rich text styles', () => {
  const r = parseRich('plain **bold** <i>it</i> <u>un</u> <s>st</s> __u2__ ~~s2~~');
  const f = (t) => r.find((x) => x.t.includes(t));
  assert.ok(f('bold').b && f('it').i && f('un').u && f('st').s && f('u2').u && f('s2').s);
  assert.ok(!f('plain').b);
});

test('scale, chart and table helpers', () => {
  const sc = niceScale(0, 9.3, 5); assert.ok(sc.max >= 9.3 && sc.min === 0 && sc.step > 0);
  const l = layoutChart({ type: 'column', series: [{ values: [1, 2, 3] }, { values: [3, 2, 1] }], categories: ['a', 'b', 'c'] }, 600, 400);
  assert.ok(l.area.w > 100 && l.area.h > 100 && l.showLegend);
  assert.equal(layoutChart({ type: 'pie', series: [{ values: [1, 2] }], categories: ['a', 'b'] }, 600, 400).pie, true);
  assert.equal(normChart({ series: [{ values: ['x', '4'] }] }).series[0].values[0], 0);
  const t = resolveTable({ data: [['a {2x1}', ''], ['c', 'd']], header: true });
  assert.equal(t.cells.length, 3); assert.equal(t.cells[0].cs, 2);
  const rows = parseDelimited('Name,Q1,Q2\n"A, B",1,2\nC,3,4');
  assert.equal(rows[1][0], 'A, B');
  const c = chartFromRows(rows);
  assert.deepEqual(c.series.map((x) => x.name), ['Q1', 'Q2']);
  assert.equal(rowsFromChart(c)[0][1], 'Q1');
});

test('script: timed lines and headings share one grammar', () => {
  const a = parseScript('[0:10] # Big\n[0:12] second\n[0:14] ## small\n[0:16] last');
  assert.equal(a.scenes.length, 1);
  assert.equal(a.scenes[0].lines[0].role, 'title');
  const b = parseScript('# [0:05] flipped\nbody');
  assert.equal(b.scenes[0].lines[0].tag, 5);
  assert.equal(b.scenes[0].lines[0].role, 'title');
  const c = parseScript('first\nsecond\n# New slide\nbody');
  assert.equal(c.scenes.length, 2);
  const d = parseScript('one\n## sub stays\ntwo');
  assert.equal(d.scenes.length, 1);
});

test('script: style tags reach runs and plain text', () => {
  const m = (s, f, w, px) => s.length * px * 0.55;
  const sc = parseScript('[0:01] <b>Bold</b> and <i>slanted</i> __under__ ~~gone~~ text');
  const w = sc.scenes[0].lines[0].words;
  assert.ok(w[0].st?.b && w[2].st?.i && w[3].st?.u && w[4].st?.s && !w[1].st);
  assert.equal(plain('<b>Bold</b> __x__ ~~y~~ z'), 'Bold x y z');
  const comp = compileScript(sc, { measure: m, width: 1280, height: 720 });
  assert.ok(comp);
});
