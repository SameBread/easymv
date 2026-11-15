import test from 'node:test';
import assert from 'node:assert/strict';
import { SHAPES, SHAPE_IDS, sampleShape } from '../js/shapes.js';
import { visSettings, bandsAtFrame, waveAtFrame, layoutAmps, buildVisual, visAmplitudes, VIS_PRESETS, VIS_DEFAULTS } from '../js/visualizer.js';
import { fxSettings, FX_KINDS, FX_IDS } from '../js/effects.js';

test('every shape samples n finite points with unit normals', () => {
  for (const id of SHAPE_IDS) {
    const s = sampleShape(id, 40);
    assert.equal(s.x.length, 40);
    for (let i = 0; i < 40; i++) {
      assert.ok(Number.isFinite(s.x[i]) && Number.isFinite(s.y[i]), `${id} point ${i}`);
      assert.ok(Math.abs(Math.hypot(s.nx[i], s.ny[i]) - 1) < 1e-4, `${id} normal ${i}`);
    }
    assert.equal(s.closed, SHAPES[id].closed);
  }
});

test('circle normals point away from the centre', () => {
  const s = sampleShape('circle', 32);
  for (let i = 0; i < 32; i++) assert.ok(s.x[i] * s.nx[i] + s.y[i] * s.ny[i] > 0.9, `point ${i}`);
});

test('closed shapes do not repeat the first point; open shapes reach both ends', () => {
  const c = sampleShape('square', 24);
  assert.ok(Math.hypot(c.x[23] - c.x[0], c.y[23] - c.y[0]) > 0.01);
  const l = sampleShape('line', 10);
  assert.ok(l.x[9] - l.x[0] > 0.5);
});

test('visSettings clamps and falls back', () => {
  const v = visSettings({ vis: { shape: 'nope', count: 99999 } });
  assert.equal(v.shape, 'circle');
  assert.equal(v.count, 512);
});

test('bandsAtFrame is deterministic regardless of how we got there', () => {
  const bands = 8; const rate = 100; const frames = 400;
  const data = new Float32Array(frames * bands);
  for (let f = 0; f < frames; f++) for (let b = 0; b < bands; b++) data[f * bands + b] = ((f * 7 + b * 13) % 17) / 17;
  const spec = { data, bands, rate };
  const direct = bandsAtFrame(spec, 30, 55, 150);
  for (let f = 0; f < 120; f++) bandsAtFrame(spec, 30, f, 150); // "play" through other frames first
  const after = bandsAtFrame(spec, 30, 55, 150);
  assert.deepEqual([...after], [...direct]);
  // release makes a loud frame linger
  const hit = new Float32Array(frames * bands); hit[100 * bands] = 1;
  const s2 = { data: hit, bands, rate };
  assert.ok(bandsAtFrame(s2, 30, 31, 400)[0] > 0.05);
  assert.equal(bandsAtFrame(s2, 30, 31, 0)[0], 0);
});

test('waveAtFrame reads PCM around the frame time', () => {
  const sr = 8000; const pcm = { data: new Float32Array(sr * 2), channels: 1, sampleRate: sr };
  for (let i = 0; i < pcm.data.length; i++) pcm.data[i] = Math.sin((i / sr) * 2 * Math.PI * 100);
  const w = waveAtFrame(pcm, 30, 30, 64);
  assert.equal(w.length, 64);
  assert.ok(Math.max(...w) > 0.5 && Math.min(...w) < -0.5);
});

test('layoutAmps mirrors symmetric around closed shapes', () => {
  const vals = Float32Array.from([0, 0.25, 0.5, 0.75, 1]);
  const a = layoutAmps(vals, 16, { mirror: true, reverse: false, closed: true });
  for (let i = 1; i < 8; i++) assert.ok(Math.abs(a[i] - a[16 - i]) < 1e-6, `mirror ${i}`);
});

test('buildVisual produces coloured triangles for every shape and mode', () => {
  for (const shape of SHAPE_IDS) for (const mode of ['bars', 'spikes', 'dots', 'wave']) {
    const vis = visSettings({ vis: { shape, mode, count: 32 } });
    const amps = new Float32Array(vis.count).fill(0.6);
    const out = buildVisual(vis, amps, { minDim: 720, time: 1, colors: [[1, 0, 0], [0, 0, 1]] });
    const nv = out.vertexCount;
    assert.ok(nv > 0 && nv % 3 === 0, `${shape}/${mode}: ${nv} verts`);
    assert.ok([...out.pos].every(Number.isFinite), `${shape}/${mode} finite`);
  }
});

test('visAmplitudes without audio is silent and the right length', () => {
  const vis = visSettings({});
  const a = visAmplitudes(vis, { spec: null, pcm: null, fps: 30, frame: 0 });
  assert.equal(a.length, vis.count);
  assert.ok(a.every((v) => v === 0));
});

test('presets cover several shapes and are valid', () => {
  assert.ok(VIS_PRESETS.length >= 6);
  assert.ok(new Set(VIS_PRESETS.map((p) => p.vis.shape)).size >= 5);
  for (const p of VIS_PRESETS) assert.ok(SHAPES[p.vis.shape], p.name);
  assert.ok(VIS_DEFAULTS.count > 0);
});

test('effect kinds have unique shader ids and sane defaults', () => {
  const ids = FX_IDS.map((k) => FX_KINDS[k].id);
  assert.equal(new Set(ids).size, ids.length);
  for (const k of FX_IDS) { const f = fxSettings({ fx: { kind: k } }); assert.ok(f.count >= 1 && f.size > 0, k); }
  assert.equal(fxSettings({ fx: { kind: 'bogus' } }).kind, 'snow');
});
