import test from 'node:test';
import assert from 'node:assert/strict';
import { deckSpans, buildDeckScript, artMotion, parseClock, clockText } from '../js/deck.js';

const slides = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ title: `S${i}`, pages: [{ w: 2, head: [], lines: [`line ${i}`] }], ...extra }));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

test('even spreads over the song', () => {
  const sp = deckSpans({ mode: 'even', slides: slides(4) }, { songSec: 100 });
  near(sp.slides[0].t0, 0); near(sp.slides[3].t1, 100); near(sp.slides[1].t1 - sp.slides[1].t0, 25);
});
test('start offset and end limit bound the window', () => {
  const sp = deckSpans({ mode: 'even', start: 20, end: 80, slides: slides(3) }, { songSec: 200 });
  near(sp.slides[0].t0, 20); near(sp.slides[2].t1, 80);
});
test('open end in even mode runs to the song end', () => {
  const sp = deckSpans({ mode: 'even', start: 10, slides: slides(2) }, { songSec: 50 });
  near(sp.slides[1].t1, 50);
});
test('manual durations are kept, the rest share what remains', () => {
  const s = slides(3); s[0].dur = 10;
  const sp = deckSpans({ mode: 'even', slides: s }, { songSec: 40 });
  near(sp.slides[0].t1 - sp.slides[0].t0, 10); near(sp.slides[1].t1 - sp.slides[1].t0, 15); near(sp.slides[2].t1, 40);
});
test('hidden slides are skipped', () => {
  const s = slides(3); s[1].hidden = true;
  const sp = deckSpans({ mode: 'even', slides: s }, { songSec: 30 });
  assert.equal(sp.slides[1], null); near(sp.slides[2].t1 - sp.slides[2].t0, 15);
});
test('reading mode is natural, but an explicit end only compresses', () => {
  const nat = deckSpans({ mode: 'reading', slides: slides(3) }, { songSec: 100 });
  near(nat.total, 6);
  const cut = deckSpans({ mode: 'reading', end: 3, slides: slides(3) }, { songSec: 100 });
  near(cut.total, 3);
  const roomy = deckSpans({ mode: 'reading', end: 60, slides: slides(3) }, { songSec: 100 });
  near(roomy.total, 6);
});
test('fixed mode uses the seconds each', () => {
  near(deckSpans({ mode: 'fixed', fixed: 7, slides: slides(2) }).total, 14);
});
test('script timestamps follow the spans', () => {
  const d = { mode: 'even', start: 5, slides: slides(2) };
  const txt = buildDeckScript(d, deckSpans(d, { songSec: 25 }));
  assert.match(txt, /\[0:05\.00-/); assert.match(txt, /\[0:15\.00-/);
});
test('artMotion makes visibility spans and fades', () => {
  const m = artMotion([[2, 6]], 'fade', 0.4);
  assert.equal(m.visible.length, 1); assert.ok(m.tracks.opacity.length >= 4);
  assert.deepEqual(artMotion([[2, 6]], 'cut').tracks, {});
  assert.ok(artMotion([[2, 6]], 'push').tracks.positionX.length);
});
test('parseClock', () => {
  assert.equal(parseClock('1:23'), 83); assert.equal(parseClock('83.5'), 83.5); assert.ok(Number.isNaN(parseClock('x')));
  assert.equal(clockText(83), clockText(parseClock('1:23')));
});

test('beats mode: every slide is N beats and cuts land on the grid', () => {
  const tempo = { bpm: 120, offset: 0.1, sig: 4 };
  const sp = deckSpans({ mode: 'beats', beats: 4, start: 3.3, slides: slides(3) }, { songSec: 60, tempo });
  near(sp.slides[0].t0, 3.1); near(sp.slides[0].t1 - sp.slides[0].t0, 2); near(sp.slides[2].t1, 9.1);
  const nt = deckSpans({ mode: 'beats', beats: 4, fixed: 5, slides: slides(2) }, { songSec: 60 });
  near(nt.total, 10, 1e-6);
});

test('Ken Burns adds slow, sorted scale keys across each span and leaves other cases alone', () => {
  const sorted = (ks) => ks.every((k, i) => !i || k.t >= ks[i - 1].t);
  const plain = artMotion([[0, 4]], 'cut');
  assert.deepEqual(plain.tracks, {});                          // unchanged without Ken Burns
  const zin = artMotion([[0, 4]], 'cut', 0.4, 'in');
  assert.ok(zin.tracks.scale[1].v > zin.tracks.scale[0].v);
  const zout = artMotion([[0, 4]], 'fade', 0.4, 'out');
  assert.ok(zout.tracks.scale.at(-1).v < zout.tracks.scale[0].v);
  for (const trans of ['cut', 'fade', 'zoom', 'push', 'rise']) for (const kb of ['in', 'out', 'pan', 'auto']) {
    const m = artMotion([[0, 3], [4, 6.5], [8, 8.3]], trans, 0.4, kb);
    for (const ks of Object.values(m.tracks)) assert.ok(sorted(ks), `${trans}/${kb} unsorted`);
  }
  const pan = artMotion([[0, 4]], 'cut', 0.4, 'pan');
  assert.ok(pan.tracks.positionX[1].v !== pan.tracks.positionX[0].v && pan.tracks.scale[0].v > 1);
  assert.equal(artMotion([[0, 4]], 'push', 0.4, 'in').tracks.scale, undefined);   // push owns the position, no zoom added
});
