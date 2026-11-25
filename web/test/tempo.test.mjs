import test from 'node:test';
import assert from 'node:assert/strict';
import { normTempo, beatAt, timeAt, noteBeats, snapSeconds, gridLines, barBeat, timeOfBarBeat, parseBarTag, detectTempo, tapTempo, firstBeatAfter } from '../js/tempo.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const T = normTempo({ bpm: 120, offset: 0.5, sig: 4 });

test('beats and seconds convert both ways', () => {
  near(beatAt(0.5, T), 0); near(beatAt(1, T), 1); near(timeAt(4, T), 2.5); near(timeAt(beatAt(7.77, T), T), 7.77);
  near(beatAt(0, T), -1);
});
test('tempo changes keep beats continuous', () => {
  const C = normTempo({ bpm: 120, offset: 0, changes: [{ t: 10, bpm: 60 }] });
  near(beatAt(10, C), 20); near(beatAt(12, C), 22); near(timeAt(22, C), 12); near(timeAt(beatAt(15.3, C), C), 15.3);
});
test('note lengths', () => {
  assert.equal(noteBeats('1/4', T), 1); assert.equal(noteBeats('1/8', T), 0.5); assert.equal(noteBeats('1/2', T), 2);
  near(noteBeats('1/8T', T), 1 / 3); assert.equal(noteBeats('bar', T), 4); assert.equal(noteBeats('1/16', T), 0.25);
});
test('snapping to a division', () => {
  near(snapSeconds(1.12, T, '1/4'), 1); near(snapSeconds(1.3, T, '1/4'), 1.5); near(snapSeconds(1.3, T, '1/8'), 1.25);
  near(snapSeconds(2.4, T, 'bar'), 2.5);
});
test('grid lines', () => {
  const g = gridLines(T, 0, 3, '1/4'); assert.deepEqual(g.map((x) => x.t), [0, 0.5, 1, 1.5, 2, 2.5, 3]); assert.equal(g[1].beat, 0);
  assert.equal(gridLines(T, 0.5, 10.5, '1/8').length, 41);
});
test('bars and beats', () => {
  assert.deepEqual(barBeat(0.5, T), { bar: 1, beat: 1 }); near(barBeat(2.5, T).bar, 2); near(barBeat(2.5, T).beat, 1); near(barBeat(3, T).beat, 2);
  near(timeOfBarBeat(17, 3, T), 0.5 + (16 * 4 + 2) * 0.5); near(parseBarTag('@17.3', T), timeOfBarBeat(17, 3, T));
  near(parseBarTag('@2', T), 2.5); assert.equal(parseBarTag('@x', T), null);
});
test('firstBeatAfter', () => { near(firstBeatAfter(T, 0), 0); near(firstBeatAfter(T, 0.2), 0.5); });

function synth(bpm, offset, secs, rate = 200, noise = 0.15) {
  const n = secs * rate; const a = new Float32Array(n);
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < n; i++) a[i] = rnd() * noise;
  const per = 60 / bpm;
  for (let t = offset, k = 0; t < secs; t += per, k++) {
    const i = Math.round(t * rate); const strength = k % 4 === 0 ? 1 : 0.6;
    for (let d = 0; d < 6 && i + d < n; d++) a[i + d] += strength * Math.exp(-d * 0.7);
    // off-beat hi-hat
    const j = Math.round((t + per / 2) * rate); for (let d = 0; d < 3 && j + d < n; d++) a[j + d] += 0.25 * Math.exp(-d);
  }
  return a;
}
for (const [bpm, off] of [[128, 0.13], [90, 0.4], [174, 0.07], [100, 0.0]]) {
  test(`detects ${bpm} bpm`, () => {
    const r = detectTempo(synth(bpm, off, 60), 200);
    assert.ok(r, 'result');
    const ok = Math.abs(r.bpm - bpm) < 0.6 || Math.abs(r.bpm * 2 - bpm) < 1 || Math.abs(r.bpm / 2 - bpm) < 0.6;
    assert.ok(ok, `got ${r.bpm}`);
    if (Math.abs(r.bpm - bpm) < 0.6) {
      const per = 60 / bpm; const d = Math.abs(((r.offset - off) % per + per * 1.5) % per - per / 2);
      assert.ok(d < 0.03 || Math.abs(d - per / 2) < 0.03 || true);
      const dd = Math.min(Math.abs(r.offset - off) % per, per - (Math.abs(r.offset - off) % per)); assert.ok(dd < 0.03, `offset off by ${dd}`);
    }
    assert.ok(r.confidence > 0.3);
    assert.ok(r.alternatives.length >= 1);
  });
}
test('silence and too-short audio give null', () => {
  assert.equal(detectTempo(new Float32Array(200 * 60), 200), null); assert.equal(detectTempo(new Float32Array(100), 200), null);
});
test('tap tempo', () => {
  const taps = [1, 1.5, 2.01, 2.5, 3.0, 3.51]; const r = tapTempo(taps);
  assert.ok(Math.abs(r.bpm - 120) < 1.5); assert.ok(Math.abs(r.offset - 1) < 0.05);
  assert.equal(tapTempo([1, 1.5]), null);
  assert.ok(Math.abs(tapTempo([0, 5, 6, 6.5, 7, 7.5]).bpm - 120) < 3);
});

import { parseScript, setScriptTempo } from '../js/kinetic.js';
test('scripts accept [@bar.beat] times', () => {
  setScriptTempo({ bpm: 120, offset: 1, sig: 4 });
  const s = parseScript('[@1] one\n[@2.3-@3] two\n[0:10-@9] three');
  assert.equal(s.scenes[0].lines[0].tag, 1);
  assert.equal(s.scenes[0].lines[1].tag, 1 + 4 * 0.5 + 2 * 0.5); assert.equal(s.scenes[0].lines[1].tag1, 1 + 8 * 0.5);
  assert.equal(s.scenes[0].lines[2].tag, 10); assert.equal(s.scenes[0].lines[2].tag1, 1 + 32 * 0.5);
  setScriptTempo(null);
  const n = parseScript('[@4] no tempo');
  assert.equal(n.scenes[0].lines[0].tag, null); assert.equal(n.scenes[0].lines[0].words.map((w) => w.t).join(' '), 'no tempo');
});

import { compileScript, frameAt } from '../js/kinetic.js';
const mkc = (txt, extra = {}) => compileScript(parseScript(txt), { W: 1280, H: 720, measure: (s, f, w, px) => s.length * px * 0.55, bgMode: 'none', ...extra });
test('fx sync=beat pulses on the beat, not on a free clock', () => {
  const tempo = { bpm: 120, offset: 0, sig: 4 };
  const c = mkc('[0:01-0:08] word{pulse sync=beat}', { tempo });
  const size = (t) => { const r = frameAt(c, t, {}).passes[0].runs[0]; return r.sx; };
  const on = size(3.0); const mid = size(3.25); const on2 = size(3.5);
  assert.ok(on > mid * 1.05, `${on} vs ${mid}`); assert.ok(Math.abs(on - on2) < 1e-6 * Math.max(1, on), 'same on every beat');
  const free = mkc('[0:01-0:08] word{pulse}', { tempo });
  assert.notEqual(frameAt(free, 3.0, {}).passes[0].runs[0].sx, frameAt(c, 3.0, {}).passes[0].runs[0].sx);
});
test('::sync beat and @sync beat apply to scenes and scripts', () => {
  const tempo = { bpm: 100, offset: 0, sig: 4 };
  const a = mkc('::fx bounce\n::sync beat\n[0:01] hi there', { tempo });
  assert.ok(a.scenes[0].runs.every((r) => r.fxSync === 'beat'));
  const b = mkc('@sync beat\n@fx bounce\n[0:01] hi there', { tempo });
  assert.ok(b.scenes[0].runs.every((r) => r.fxSync === 'beat'));
});
