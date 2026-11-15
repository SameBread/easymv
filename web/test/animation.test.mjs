import test from 'node:test';
import assert from 'node:assert/strict';
import {
  frameForTick, resolveFixedRateFrame, resolveGifFrame, searchTimeline, atlasUV, validateAtlas,
  naturalCompare, planZipFrames, applyFrameOrder, fitSize, buildPlan, PROPERTY_NAMES, P,
} from '../js/animation.js';

test('property order matches the engine contract', () => {
  assert.equal(PROPERTY_NAMES.length, 18);
  assert.equal(P.visible, 16);
  assert.equal(P.intensity, 17);
  assert.equal(P.positionX, 0);
  assert.equal(P.scale, 3);
  assert.equal(P.blur, 13);
  assert.equal(P.anchorY, 15);
});

test('loop / once / pingPong tick mapping', () => {
  const seq = (mode, n, count) => Array.from({ length: count }, (_, t) => frameForTick(t, n, mode));
  assert.deepEqual(seq('loop', 3, 7), [0, 1, 2, 0, 1, 2, 0]);
  assert.deepEqual(seq('once', 3, 6), [0, 1, 2, 2, 2, 2]);
  // period 2N: 0 1 2 2 1 0 | 0 1 2 ...
  assert.deepEqual(seq('pingPong', 3, 9), [0, 1, 2, 2, 1, 0, 0, 1, 2]);
});

test('fixed-rate animation is exact at integer ratios (no float drift)', () => {
  // 30 fps video, 10 fps animation: 3 video frames per drawing.
  const f = (i) => resolveFixedRateFrame(i, 30, 10, 12, 'loop').frame;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(f), [0, 0, 0, 1, 1, 1, 2]);
  // Boundaries across a long run: frame 3k is always drawing k.
  for (let k = 0; k < 5000; k++) assert.equal(f(3 * k), k % 12);
  // 29.97-ish rates must not throw or produce NaN.
  const r = resolveFixedRateFrame(1234, 29.97, 12, 7, 'loop');
  assert.ok(Number.isInteger(r.frame) && r.frame >= 0 && r.frame < 7);
});

test('judder case alternates 2/3 video frames per drawing (12 fps on 30)', () => {
  const counts = new Map();
  for (let i = 0; i < 60; i++) {
    const { frame } = resolveFixedRateFrame(i, 30, 12, 1000, 'loop');
    counts.set(frame, (counts.get(frame) ?? 0) + 1);
  }
  assert.deepEqual([...new Set(counts.values())].sort(), [2, 3]);
});

test('internal animation never depends on anything but frame index and timing', () => {
  // Same inputs -> same output, regardless of call order (scrub-safe).
  const a = [5, 1, 9, 1].map((i) => resolveFixedRateFrame(i, 24, 12, 8, 'loop').frame);
  const b = [1, 5, 9, 1].map((i) => resolveFixedRateFrame(i, 24, 12, 8, 'loop').frame);
  assert.equal(a[1], b[0]);
  assert.equal(a[0], b[1]);
});

test('crossfade mix is the fractional tick; off for once-at-end', () => {
  const r = resolveFixedRateFrame(1, 30, 10, 4, 'loop'); // tick 0.333
  assert.equal(r.frame, 0);
  assert.equal(r.next, 1);
  assert.ok(Math.abs(r.mix - 1 / 3) < 1e-9);
  const end = resolveFixedRateFrame(100, 30, 10, 4, 'once');
  assert.equal(end.frame, 3);
  assert.equal(end.mix, 0);
});

test('gif timeline binary search + wrap', () => {
  const timeline = [0, 100, 150, 350]; // delays 100, 50, 200
  assert.equal(searchTimeline(timeline, 0), 0);
  assert.equal(searchTimeline(timeline, 99.9), 0);
  assert.equal(searchTimeline(timeline, 100), 1);
  assert.equal(searchTimeline(timeline, 149), 1);
  assert.equal(searchTimeline(timeline, 150), 2);
  assert.equal(searchTimeline(timeline, 349), 2);
  // 10 fps video: frame i is at i*100 ms; total 350 ms.
  const seq = Array.from({ length: 8 }, (_, i) => resolveGifFrame(i, 10, timeline).frame);
  // t: 0,100,200,300,400->50,500->150,600->250,700->0
  assert.deepEqual(seq, [0, 1, 2, 2, 0, 2, 2, 0]);
  assert.equal(resolveGifFrame(1000, 10, timeline, 'once').frame, 2);
  assert.equal(resolveGifFrame(5, 10, [0, 100], 'loop').frame, 0);
});

test('atlas UV rect: half-texel inset and padding pitch', () => {
  const def = { frameWidth: 128, frameHeight: 128, columns: 8, padding: 1 };
  const [u0, v0, u1, v1] = atlasUV(9, def, 1031, 520); // col 1, row 1
  assert.ok(Math.abs(u0 - (129 + 0.5) / 1031) < 1e-12);
  assert.ok(Math.abs(v0 - (129 + 0.5) / 520) < 1e-12);
  assert.ok(Math.abs(u1 - (129 + 128 - 0.5) / 1031) < 1e-12);
  assert.ok(Math.abs(v1 - (129 + 128 - 0.5) / 520) < 1e-12);
  // Inset keeps the sampled region strictly inside the cell.
  assert.ok(u1 - u0 < 128 / 1031);
});

test('atlas validation reports specific errors', () => {
  const def = { id: 'chibi', frameWidth: 128, frameHeight: 128, columns: 8, rows: 4, padding: 0 };
  assert.equal(validateAtlas(def, 1024, 512), null);
  assert.match(validateAtlas(def, 1000, 512), /exceeds atlas width 1000px/);
  assert.match(validateAtlas(def, 1024, 500), /exceeds atlas height 500px/);
  assert.match(validateAtlas({ ...def, padding: 1 }, 1024, 512), /set padding to 0/);
});

test('natural filename order', () => {
  const names = ['frame_10.png', 'frame_2.png', 'frame_1.png', 'frame_0003.png'];
  assert.deepEqual(names.sort(naturalCompare), ['frame_1.png', 'frame_2.png', 'frame_0003.png', 'frame_10.png']);
});

test('zip planning: top-level images only, natural order, specific errors', () => {
  const ok = planZipFrames(['f_10.png', 'f_2.png', 'f_1.png', '__MACOSX/._f_1.png', '.DS_Store']);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.ordered, ['f_1.png', 'f_2.png', 'f_10.png']);

  const nested = planZipFrames(['frames/a.png', 'b.png']);
  assert.match(nested.errors[0], /top level/);
  assert.match(nested.errors[0], /frames\/a\.png/);

  const bad = planZipFrames(['a.png', 'notes.txt', 'b.gif']);
  assert.match(bad.errors[0], /notes\.txt/);
  assert.match(bad.errors[0], /b\.gif/);

  assert.deepEqual(planZipFrames([]).errors, ['zip is empty']);
});

test('frameOrder permutation is applied', () => {
  assert.deepEqual(applyFrameOrder(['a', 'b', 'c'], [2, 0, 1]), ['c', 'a', 'b']);
  assert.deepEqual(applyFrameOrder(['a', 'b'], undefined), ['a', 'b']);
  assert.deepEqual(applyFrameOrder(['a', 'b'], [0]), ['a', 'b']); // wrong length ignored
});

test('fit modes', () => {
  assert.deepEqual(fitSize('natural', 100, 50, 1000, 1000), [100, 50]);
  assert.deepEqual(fitSize('contain', 200, 100, 1000, 1000), [1000, 500]);
  assert.deepEqual(fitSize('cover', 200, 100, 1000, 1000), [2000, 1000]);
});

test('buildPlan: array order is paint order, and routing does not change the internal frame', () => {
  const mk = (id, type, extra = {}) => ({
    ready: true,
    frameCount: 12,
    timeline: [0, 100, 200],
    def: { id, type, internalFps: 12, loopMode: 'loop', ...extra },
  });
  const assets = [mk('bg', 'static'), mk('mid', 'gif'), mk('hero', 'spriteSheet')];
  const viewWith = (scale) => ({ get: (e, p) => (p === P.scale ? scale : p === P.opacity || p === P.visible ? 1 : 0) });
  const planA = buildPlan(assets, viewWith(1), 30, 24);
  const planB = buildPlan(assets, viewWith(9), 30, 24); // wildly different routing
  assert.deepEqual(planA.map((i) => i.asset.def.id), ['bg', 'mid', 'hero']);
  assert.deepEqual(planA.map((i) => i.frameA), planB.map((i) => i.frameA));
  assert.notEqual(planA[0].props[P.scale], planB[0].props[P.scale]);
});

test('buildPlan culls hidden and fully transparent layers', () => {
  const mk = (id) => ({ ready: true, frameCount: 1, timeline: [0], def: { id, type: 'static' } });
  const assets = [mk('a'), mk('b'), mk('c')];
  const view = { get: (e, p) => (p === P.visible ? (e === 1 ? 0 : 1) : p === P.opacity ? (e === 2 ? 0 : 1) : 0) };
  assert.deepEqual(buildPlan(assets, view, 0, 30).map((i) => i.asset.def.id), ['a']);
});

test('generated layers get their own plan kinds', () => {
  const g = (id, type) => ({ ready: true, def: { id, type } });
  const view = { get: (e, p) => (p === P.opacity || p === P.visible ? 1 : 0) };
  const plan = buildPlan([g('v', 'visualizer'), g('f', 'effect'), g('l', 'lyrics')], view, 10, 30);
  assert.deepEqual(plan.map((i) => i.kind), ['visualizer', 'effect', 'lyrics']);
});

test('buildPlan skips assets that are not ready', () => {
  const a = { ready: false, def: { id: 'x', type: 'static' } };
  assert.equal(buildPlan([a], { get: () => 1 }, 0, 30).length, 0);
});
