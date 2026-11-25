// Tempo: a beat grid for the song. Pure functions (no DOM, no state) so everything here is unit-tested.
//
//   tempo = { bpm: 120, offset: 0.35, sig: 4, changes: [{ t: 64.2, bpm: 140 }] }
//     bpm     quarter-note beats per minute
//     offset  seconds at which beat 1 of bar 1 falls (may be negative or after 0)
//     sig     beats per bar
//     changes tempo changes, in seconds, ascending (optional)
//
// Everything works in "beats" internally: beatAt(t) and timeAt(beat) convert, so a grid, a snap or a script time like
// "bar 17" stay on the beat even when the tempo changes mid-song.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const NOTE_DIVISIONS = [
  ['bar', 'Bar'], ['1/2', '1/2 note'], ['1/4', '1/4 (beat)'], ['1/8', '1/8'], ['1/16', '1/16'], ['1/32', '1/32'],
  ['1/4T', '1/4 triplet'], ['1/8T', '1/8 triplet'], ['1/16T', '1/16 triplet'],
];

export function normTempo(t) {
  if (!t || !Number.isFinite(Number(t.bpm)) || Number(t.bpm) <= 0) return null;
  const changes = (t.changes ?? []).filter((c) => Number.isFinite(c.t) && Number.isFinite(c.bpm) && c.bpm > 0)
    .map((c) => ({ t: Number(c.t), bpm: clamp(Number(c.bpm), 20, 400) })).sort((a, b) => a.t - b.t);
  return { bpm: clamp(Number(t.bpm), 20, 400), offset: Number.isFinite(Number(t.offset)) ? Number(t.offset) : 0, sig: clamp(Math.round(Number(t.sig) || 4), 1, 16), changes };
}

/** Piecewise-linear map between seconds and beats: [{ t0, beat0, bpm }]. */
function segments(tempo) {
  const segs = [{ t0: tempo.offset, beat0: 0, bpm: tempo.bpm }];
  for (const c of tempo.changes) {
    if (c.t <= segs.at(-1).t0) { segs.at(-1).bpm = c.bpm; continue; }
    const last = segs.at(-1);
    segs.push({ t0: c.t, beat0: last.beat0 + ((c.t - last.t0) * last.bpm) / 60, bpm: c.bpm });
  }
  return segs;
}

/** Position in beats (beat 0 = the downbeat of bar 1) of time t (seconds). */
export function beatAt(t, tempo) {
  const segs = segments(tempo);
  if (t <= segs[0].t0) return ((t - segs[0].t0) * segs[0].bpm) / 60;
  let s = segs[0];
  for (const x of segs) { if (x.t0 <= t) s = x; else break; }
  return s.beat0 + ((t - s.t0) * s.bpm) / 60;
}

export function timeAt(beat, tempo) {
  const segs = segments(tempo);
  if (beat <= 0) return segs[0].t0 + (beat * 60) / segs[0].bpm;
  let s = segs[0];
  for (const x of segs) { if (x.beat0 <= beat) s = x; else break; }
  return s.t0 + ((beat - s.beat0) * 60) / s.bpm;
}

/** Length of a note division in beats (quarter note = 1). 'bar' = one bar. */
export function noteBeats(div, tempo) {
  if (div === 'bar') return tempo?.sig ?? 4;
  const m = /^1\/(\d+)(T)?$/.exec(String(div));
  if (!m) return 1;
  const len = 4 / Number(m[1]);
  return m[2] ? (len * 2) / 3 : len;
}

/** Nearest grid line (seconds) to t for a division. */
export function snapSeconds(t, tempo, div = '1/4') {
  const len = noteBeats(div, tempo);
  return timeAt(Math.round(beatAt(t, tempo) / len) * len, tempo);
}

/** Grid lines (seconds) between t0 and t1 for a division, with the beat number of each (0-based, may be fractional). */
export function gridLines(tempo, t0, t1, div = '1/4') {
  const len = noteBeats(div, tempo);
  const out = [];
  const b0 = Math.ceil(beatAt(Math.max(t0, -1e9), tempo) / len - 1e-9);
  for (let k = b0; k < b0 + 200000; k++) {
    const beat = k * len; const t = timeAt(beat, tempo);
    if (t > t1 + 1e-9) break;
    if (t >= t0 - 1e-9) out.push({ t, beat });
  }
  return out;
}

/** "bar 17, beat 3" for a time. Bars and beats are 1-based. */
export function barBeat(t, tempo) {
  const b = beatAt(t, tempo); const sig = tempo.sig;
  const bar = Math.floor(b / sig + 1e-9) + 1;
  const beat = b - (bar - 1) * sig + 1;
  return { bar, beat };
}
export const timeOfBarBeat = (bar, beat, tempo) => timeAt((bar - 1) * tempo.sig + (beat - 1), tempo);
export const barBeatText = (t, tempo) => { const { bar, beat } = barBeat(t, tempo); return `${bar}.${(Math.round(beat * 100) / 100).toString()}`; };

/** Script times: "@17" (bar 17), "@17.3" (bar 17, beat 3), "@17.3.5" (bar 17, beat 3.5). null when unreadable. */
export function parseBarTag(text, tempo) {
  const m = /^@(\d+)(?:\.(\d+(?:\.\d+)?))?$/.exec(String(text).trim());
  if (!m || !tempo) return null;
  return timeOfBarBeat(Number(m[1]), m[2] != null ? Number(m[2]) : 1, tempo);
}

// ---------- detection ----------

/**
 * Estimate tempo from an onset-strength series (any positive "how hit-like is this moment" curve) sampled at `rate` Hz.
 * Returns { bpm, offset, confidence, alternatives: [half, double] } or null when there is nothing to find.
 * Works by autocorrelation (what repeats?) then a fine comb search (where exactly do the beats fall?).
 */
export function detectTempo(onset, rate, { min = 60, max = 190, maxSeconds = 300 } = {}) {
  const n = Math.min(onset.length, Math.floor(rate * maxSeconds));
  if (n < rate * 6) return null;
  // flatten the envelope: remove the slow trend, keep only rises
  const e = new Float32Array(n);
  const win = Math.max(3, Math.round(rate * 0.4));
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += onset[i]; if (i >= win) sum -= onset[i - win];
    const mean = sum / Math.min(i + 1, win);
    // the rising edge pins down WHEN a hit starts; a little of the flat envelope keeps soft hits visible
    e[i] = Math.max(0, onset[i] - (i ? onset[i - 1] : onset[i])) + 0.25 * Math.max(0, onset[i] - mean);
  }
  // a little blur, so hits that fall between two samples still line up with each other
  const e0 = e.slice(); for (let i = 1; i < n - 1; i++) e[i] = 0.25 * e0[i - 1] + 0.5 * e0[i] + 0.25 * e0[i + 1];
  let energy = 0; for (let i = 0; i < n; i++) energy += e[i] * e[i];
  if (energy < 1e-9) return null;

  const lagMin = Math.max(2, Math.floor((rate * 60) / (max * 1.05))); const lagMax = Math.ceil((rate * 60) / (min / 1.05));
  const ac = new Float64Array(lagMax * 4 + 2);
  const top = Math.min(ac.length, n - 1);
  for (let lag = lagMin; lag < top; lag++) {
    let a = 0; for (let i = lag; i < n; i++) a += e[i] * e[i - lag];
    ac[lag] = a / (n - lag);
  }
  const at = (lag) => { const i = Math.floor(lag); if (i + 1 >= ac.length || i < 0) return 0; const f = lag - i; return ac[i] * (1 - f) + ac[i + 1] * f; };
  // score each candidate tempo with its harmonics (a beat pattern repeats every 2 and 4 beats) and a soft preference for 90-150
  let best = null;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (rate * 60) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.75) ** 2);
    const s = (at(lag) + 0.6 * at(lag * 2) + 0.35 * at(lag * 4) + 0.3 * at(lag / 2)) * (0.55 + 0.45 * prior);
    if (!best || s > best.s) best = { lag, s, bpm };
  }
  if (!best || best.s <= 0) return null;
  // parabolic refinement of the lag
  const l = best.lag; const y0 = at(l - 1); const y1 = at(l); const y2 = at(l + 1);
  const den = y0 - 2 * y1 + y2; const shift = den < 0 ? clamp((0.5 * (y0 - y2)) / den, -1, 1) : 0;
  let bpm = (rate * 60) / (l + shift);

  // fine comb search around the estimate: which tempo and phase put beats on the strongest onsets?
  const period0 = 60 / bpm;
  const comb = (b, phase) => {
    const per = 60 / b; let s = 0; let c = 0;
    for (let t = phase; t < n / rate - 0.01; t += per, c++) {
      const x = t * rate; const i = Math.floor(x); const f = x - i;
      s += e[i] * (1 - f) + (e[i + 1] ?? 0) * f;
    }
    return c ? s / c : 0;
  };
  let bestComb = null;
  for (let d = -0.04; d <= 0.04001; d += 0.002) {
    const b = bpm * (1 + d); const per = 60 / b; const steps = Math.max(8, Math.round(per / 0.004));
    for (let k = 0; k < steps; k++) {
      const phase = (k / steps) * per; const s = comb(b, phase);
      if (!bestComb || s > bestComb.s) bestComb = { s, b, phase };
    }
  }
  bpm = bestComb.b;
  const period = 60 / bpm;
  // confidence: how much stronger is the comb than an off-beat comb?
  const off = 0.5 * (comb(bpm, (bestComb.phase + period / 3) % period) + comb(bpm, (bestComb.phase + (2 * period) / 3) % period));
  const confidence = clamp(off > 0 ? 1 - off / bestComb.s : 1, 0, 1);
  void period0;
  return { bpm, offset: bestComb.phase, confidence, alternatives: [bpm / 2, bpm * 2].filter((x) => x >= 40 && x <= 260) };
}

/** Tap tempo: the times (seconds) of taps -> { bpm, offset } or null. Pauses longer than 2.5 s start over. */
export function tapTempo(taps) {
  const t = []; for (const x of taps) { if (t.length && x - t.at(-1) > 2.5) t.length = 0; t.push(x); }
  if (t.length < 3) return null;
  const gaps = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  const good = gaps.filter((g) => Math.abs(g - med) < med * 0.35);
  const per = good.reduce((a, b) => a + b, 0) / good.length;
  let off = 0; t.forEach((x, i) => { off += x - i * per; }); off /= t.length;
  return { bpm: 60 / per, offset: off };
}

/** Move the offset by whole beats so beat 1 is the first one at or after `t0`. */
export const firstBeatAfter = (tempo, t0 = 0) => timeAt(Math.ceil(beatAt(t0, tempo) - 1e-9), tempo);
