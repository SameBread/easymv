import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, formatLrc, linesFromText, tapStamp, tapWord, lineEnd, activeLines, highlightFraction, placeLine, lyricsSettings, fmtStamp } from '../js/lyrics.js';
import * as TL from '../js/timeline.js';

test('LRC parse and format round-trip', () => {
  const src = '[ti:x]\n[00:01.50]Hello world\n[00:04.00]Second line\n[00:07.25][00:09.00]Repeat me';
  const lines = parseLrc(src);
  assert.equal(lines.length, 4);
  assert.equal(lines[0].t0, 1.5);
  assert.equal(lines[2].text, 'Repeat me');
  assert.equal(lines[3].t0, 9);
  const back = parseLrc(formatLrc(lines));
  assert.deepEqual(back.map((l) => [l.t0, l.text]), lines.map((l) => [l.t0, l.text]));
});

test('enhanced LRC keeps word times; offset tag applies', () => {
  const l = parseLrc('[offset:+500]\n[00:01.00]<00:01.00>Hel<00:01.50>lo <00:02.00>there')[0];
  assert.equal(l.t0, 1.5);
  assert.ok(l.words.length >= 2 && l.words[0].t === 1.5);
  assert.equal(fmtStamp(61.5), '[01:01.50]');
});

test('tap to sync stamps in order and finishes', () => {
  const lines = linesFromText('a\n\nb\nc');
  assert.equal(lines.length, 3);
  assert.equal(tapStamp(lines, 0, 1), 1);
  assert.equal(tapStamp(lines, 1, 2.5), 2);
  assert.equal(tapStamp(lines, 2, 4), -1);
  assert.deepEqual(lines.map((l) => l.t0), [1, 2.5, 4]);
  const w = { t0: 1, text: 'one two three' };
  assert.equal(tapWord(w, 0, 1), 1); assert.equal(tapWord(w, 1, 1.4), 2); assert.equal(tapWord(w, 2, 1.9), -1);
  assert.deepEqual(w.words.map((x) => x.t), [1, 1.4, 1.9]);
});

test('lineEnd uses the next line start', () => {
  const lines = [{ t0: 1, text: 'a' }, { t0: 3, text: 'b' }];
  assert.equal(lineEnd(lines, 0), 3);
  assert.ok(lineEnd(lines, 1) > 3);
});

test('activeLines: visible only inside its window, animation progresses', () => {
  const lyr = lyricsSettings({ lyrics: { lines: [{ t0: 2, text: 'a' }, { t0: 5, text: 'b' }], anim: { in: 'fade', out: 'fade', dur: 0.5 } } });
  assert.equal(activeLines(lyr, 1).length, 0);
  const early = activeLines(lyr, 2.05)[0]; const later = activeLines(lyr, 2.6)[0];
  assert.ok(early.alpha < later.alpha);
  assert.equal(later.alpha, 1);
  assert.equal(activeLines(lyr, 20).length, 0);
});

test('karaoke fraction grows across the line', () => {
  const l = { t0: 0, text: 'abcd efgh' };
  assert.ok(highlightFraction(l, 0.5, 2, 'line') < highlightFraction(l, 1.5, 2, 'line'));
  assert.equal(highlightFraction(l, 1, 2, 'off'), 0);
});

test('automatic placement is deterministic and independent of what was drawn before', () => {
  const layout = { mode: 'random', seed: 42, tilt: 10, avoid: true };
  const box = { w: 0.4, h: 0.1 };
  const avoid = [{ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }];
  const direct = placeLine(layout, 7, box, avoid);
  for (let i = 0; i < 30; i++) placeLine(layout, i, box, avoid);
  assert.deepEqual(placeLine(layout, 7, box, avoid), direct);
  assert.notDeepEqual(placeLine({ ...layout, seed: 43 }, 7, box, avoid), direct);
  const p = placeLine(layout, 3, box, avoid);
  assert.ok(p.x >= 0.2 && p.x <= 0.8 && p.y >= 0.05 && p.y <= 0.95);
});

test('modes place where they say', () => {
  const box = { w: 0.3, h: 0.08 };
  assert.ok(placeLine({ mode: 'lower', seed: 1, avoid: false }, 0, box).y > 0.7);
  assert.ok(placeLine({ mode: 'upper', seed: 1, avoid: false }, 0, box).y < 0.3);
  assert.notEqual(placeLine({ mode: 'alternate', seed: 1, avoid: false }, 0, box).x, placeLine({ mode: 'alternate', seed: 1, avoid: false }, 1, box).x);
});

// ---------- timeline ----------
const project = () => ({ elements: [{ id: 'a' }, { id: 'b' }], tracks: [], sections: [] });

test('track interpolation: hold, linear, smooth, and clamping outside the keys', () => {
  const p = project();
  const t = TL.setKey(p, 'a', 'positionX', 10, 0);
  TL.setKey(p, 'a', 'positionX', 20, 1);
  assert.equal(TL.valueAt(t, 0), 0); assert.equal(TL.valueAt(t, 30), 1);
  assert.equal(TL.valueAt(t, 15), 0.5);
  TL.setInterp(t, [10], 'hold'); assert.equal(TL.valueAt(t, 15), 0);
  TL.setInterp(t, [10], 'smooth'); assert.ok(Math.abs(TL.valueAt(t, 12.5) - 0.15625) < 1e-9);
});

test('visibility is always hold and defaults to visible without a track', () => {
  const p = project();
  TL.setVisibilitySpans(p, 'a', [[30, 60], [90, 120]], 150);
  const tr = TL.findTrack(p, 'a', 'visible');
  assert.equal(TL.valueAt(tr, 10), 0); assert.equal(TL.valueAt(tr, 45), 1); assert.equal(TL.valueAt(tr, 70), 0); assert.equal(TL.valueAt(tr, 100), 1);
  assert.deepEqual(TL.visibilitySpans(tr, 150), [[30, 60], [90, 120]]);
  assert.deepEqual(TL.visibilitySpans(null, 150), [[0, 150]]);
});

test('spans merge, clamp, and collapse to "always visible"', () => {
  assert.equal(TL.spansToKeys([[0, 150]], 150), null);
  assert.equal(TL.spansToKeys([[0, 80], [70, 200]], 150), null);
  const k = TL.spansToKeys([[10, 50], [40, 80]], 150);
  assert.deepEqual(k.map((x) => [x.f, x.v]), [[0, 0], [10, 1], [80, 0]]);
  const p = project();
  TL.setVisibilitySpans(p, 'a', [[10, 20]], 100); TL.setVisibilitySpans(p, 'a', [[0, 100]], 100);
  assert.equal(p.tracks.length, 0);
});

test('moveKeys clamps and replaces collisions; removeKeys drops empty tracks', () => {
  const p = project();
  const t = TL.setKey(p, 'a', 'scale', 10, 1); TL.setKey(p, 'a', 'scale', 20, 2); TL.setKey(p, 'a', 'scale', 30, 3);
  TL.moveKeys(t, [10, 20], 10, 100);
  assert.deepEqual(t.keys.map((k) => [k.f, k.v]), [[20, 1], [30, 2]]);
  TL.moveKeys(t, [20, 30], -500, 100);
  assert.deepEqual(t.keys.map((k) => k.f), [0, 10]);
  TL.removeKeys(p, t, [0, 10]);
  assert.equal(p.tracks.length, 0);
});

test('default blend modes and pruning', () => {
  assert.equal(TL.defaultMode('opacity'), 'multiply');
  assert.equal(TL.defaultMode('positionX'), 'add');
  assert.equal(TL.defaultMode('visible'), 'override');
  const p = project();
  TL.setKey(p, 'a', 'scale', 1, 1); TL.setKey(p, 'ghost', 'scale', 1, 1); TL.setKey(p, 'b', 'nonsense', 1, 1);
  TL.pruneTracks(p, ['scale']);
  assert.deepEqual(p.tracks.map((t) => t.element), ['a']);
});

test('beat snapping', () => {
  const series = new Float32Array(1000); series[100] = 1; series[400] = 0.9; series[405] = 1;
  const frames = TL.peakFrames(series, 200, 30, 0.5);
  assert.ok(frames.length >= 2);
  assert.equal(TL.snapFrame(16, [15, 60], 3), 15);
  assert.equal(TL.snapFrame(30, [15, 60], 3), 30);
});
