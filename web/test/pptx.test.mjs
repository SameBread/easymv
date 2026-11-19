import test from 'node:test';
import assert from 'node:assert/strict';
import { planSlides, planSlidesAuto, readingSeconds } from '../js/pptx.js';
import { parseScript, compileScript } from '../js/kinetic.js';

const para = (text, sz = 20, extra = {}) => ({ text, sz, algn: 'l', color: null, bullet: false, lvl: 0, ...extra });
const blk = (kind, box, paras) => ({ kind, box, paras, anchor: 'top' });
const E = 12700; const SZ = { w: 960 * E, h: 540 * E };
const lorem = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const parsed = { size: SZ, media: new Map(), slides: [
  { bg: { type: 'solid', hex: '#fff' }, items: [], hasArt: false, blocks: [blk('title', { x: 60 * E, y: 40 * E, w: 840 * E, h: 80 * E }, [para('Short title', 40)]), blk('body', { x: 60 * E, y: 150 * E, w: 840 * E, h: 330 * E }, [para('one', 24), para('two', 24)])] },
  { bg: { type: 'solid', hex: '#fff' }, items: [], hasArt: false, blocks: [blk('title', { x: 60 * E, y: 40 * E, w: 840 * E, h: 80 * E }, [para('Wordy', 40)]), blk('body', { x: 60 * E, y: 150 * E, w: 840 * E, h: 330 * E }, Array.from({ length: 12 }, (_, i) => para(`Paragraph ${i} ${lorem(18)}`, 20)))] },
  { bg: { type: 'solid', hex: '#fff' }, items: [{ kind: 'pic' }], hasArt: true, blocks: [] },
] };

test('reading time grows with words but is bounded', () => {
  assert.ok(readingSeconds(5) < readingSeconds(60)); assert.ok(readingSeconds(10000) <= 24); assert.ok(readingSeconds(1) >= 2.6);
});
test('wordy slides are split into pages instead of shrinking; time adapts; picture-only slides hold', () => {
  const p = planSlides(parsed, { W: 1280, H: 720 });
  assert.ok(p.pages >= 3, `pages ${p.pages}`);
  assert.ok(p.spans[1].t1 - p.spans[1].t0 > 2 * (p.spans[0].t1 - p.spans[0].t0), 'wordy slide runs longer');
  assert.equal(Math.round((p.spans[2].t1 - p.spans[2].t0) * 10) / 10, 3);
  assert.ok(p.total > 30, 'long decks are not capped at 30 s');
  const c = compileScript(parseScript(p.text), { W: 1280, H: 720, measure: (a, f, w, px) => a.length * px * 0.5, bgMode: 'none' });
  for (const s of c.scenes) for (const r of s.runs) assert.ok(r.size >= 720 * 0.02, `tiny text ${r.size} "${r.text}"`);
});
test('fixed seconds and fit-to-song are honoured', () => {
  assert.ok(Math.abs(planSlides(parsed, { perSlide: 6 }).spans[0].t1 - 6) < 1e-6);
  assert.ok(Math.abs(planSlides(parsed, { fitTo: 90 }).total - 90) < 1e-6);
});
test('auto layout: plain script, paged when wordy', () => {
  const p = planSlidesAuto(parsed, {});
  assert.match(p.text, /# Short title/); assert.ok(p.pages >= 3);
});
