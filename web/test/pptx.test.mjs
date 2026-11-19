import test from 'node:test';
import assert from 'node:assert/strict';
import { slideDurations, slidesToScript } from '../js/pptx.js';
import { parseScript } from '../js/kinetic.js';

const slides = [{ title: 'A', subtitle: 'sub', bullets: [], texts: [], images: [] },
  { title: 'B', subtitle: '', bullets: [{ text: 'one', bullet: true }, { text: 'two', bullet: true }], texts: [], images: [] },
  { title: '', subtitle: '', bullets: [], texts: [], images: [{}] }];
test('durations: auto, fixed, fit', () => {
  const a = slideDurations(slides); assert.ok(a.every((d) => d >= 3 && d <= 9));
  assert.deepEqual(slideDurations(slides, { perSlide: 5 }), [5, 5, 5]);
  const f = slideDurations(slides, { fitTo: 30 }); assert.ok(Math.abs(f.reduce((x, y) => x + y, 0) - 30) < 1e-9);
});
test('script: one timed scene per text slide, picture-only slides keep their time', () => {
  const d = [4, 4, 4]; const t = slidesToScript(slides, d);
  const sc = parseScript(t);
  assert.equal(sc.scenes.length, 2);
  assert.match(t, /\[0:00\.00-0:03\.95\] # A/);
  assert.match(t, /\[0:04\.00-0:07\.95\] # B\n- one\n- two/);
});
