// Audio visualizer geometry: bars / spikes / dots / waveform, wrapped around a shape
// preset (see shapes.js). Pure functions of (settings, audio data, frame), so the
// preview and the export always agree and scrubbing is safe.

import { sampleShape, SHAPES } from './shapes.js';

export const VIS_MODES = {
  bars:   { label: 'Bars',     icon: 'equalizer' },
  spikes: { label: 'Spikes',   icon: 'change_history' },
  dots:   { label: 'Dots',     icon: 'scatter_plot' },
  wave:   { label: 'Waveform', icon: 'waves' },
};

export const VIS_DEFAULTS = {
  source: 'master',    // which audio source drives it ('master' or a stem id)
  mode: 'bars',
  shape: 'circle',
  count: 64,           // elements around the shape
  bands: 64,           // spectrum resolution requested from the engine
  radius: 0.22,        // shape size, fraction of the smaller canvas side
  length: 0.16,        // longest bar, same unit
  fill: 0.6,           // bar width as a fraction of the spacing between bars
  line: 0.006,         // waveform line width (fraction of the smaller side)
  color1: '#ff6b9d',
  color2: '#6bd5ff',
  gradient: 'position', // position | amp | solid
  mirror: true,        // symmetric layout so closed shapes join seamlessly
  reverse: false,      // flip which end is low frequency
  both: false,         // bars grow inward as well as outward
  spin: 0,             // degrees per second
  release: 140,        // ms, how slowly bars fall
  floor: 0.04,         // idle bar height (fraction of length)
  gain: 1,
};

export function visSettings(def) {
  const v = { ...VIS_DEFAULTS, ...(def.vis ?? {}) };
  v.count = Math.max(3, Math.min(512, Math.round(v.count)));
  v.bands = Math.max(8, Math.min(256, Math.round(v.bands)));
  if (!SHAPES[v.shape]) v.shape = 'circle';
  return v;
}

// ---------- audio data -> amplitudes ----------

/**
 * Per-band spectrum at a video frame with peak-hold release (deterministic, causal in
 * the precomputed series so scrubbing gives identical results to playing).
 * @param spec { data: Float32Array frame-major [analysisFrame * bands + band], bands, rate }
 */
export function bandsAtFrame(spec, fps, frame, releaseMs, out) {
  const { data, bands, rate } = spec;
  const frames = Math.floor(data.length / bands);
  out ??= new Float32Array(bands);
  out.fill(0);
  if (frames === 0) return out;
  const a = Math.min(frames - 1, Math.floor((frame * rate) / fps));
  const b = Math.min(frames, Math.max(a + 1, Math.floor(((frame + 1) * rate) / fps)));
  const decay = releaseMs > 0 ? Math.exp(-1000 / (rate * releaseMs)) : 0;
  const lookback = releaseMs > 0 ? Math.min(a, Math.ceil((3 * releaseMs * rate) / 1000)) : 0;
  for (let band = 0; band < bands; band++) {
    let m = 0;
    for (let i = a; i < b; i++) m = Math.max(m, data[i * bands + band]);
    let w = 1;
    for (let k = 1; k <= lookback; k++) {
      w *= decay;
      const v = data[(a - k) * bands + band] * w;
      if (v > m) m = v;
    }
    out[band] = m;
  }
  return out;
}

/**
 * Signed waveform window around a video frame, resampled to `count` points by
 * averaging (keeps the shape stable as count changes). `pcm` is interleaved.
 */
export function waveAtFrame(pcm, fps, frame, count, windowMs = 45, out) {
  const { data, channels, sampleRate } = pcm;
  out ??= new Float32Array(count);
  out.fill(0);
  const total = Math.floor(data.length / channels);
  if (total === 0) return out;
  const start = Math.floor((frame / fps) * sampleRate);
  const len = Math.max(count, Math.floor((windowMs / 1000) * sampleRate));
  for (let i = 0; i < count; i++) {
    const a = start + Math.floor((i * len) / count);
    const b = start + Math.max(Math.floor(((i + 1) * len) / count), Math.floor((i * len) / count) + 1);
    let sum = 0; let n = 0;
    for (let s = a; s < b; s++) {
      if (s < 0 || s >= total) continue;
      let v = 0;
      for (let c = 0; c < channels; c++) v += data[s * channels + c];
      sum += v / channels; n++;
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

/** Map `bands` values (or wave samples) to `count` positions around the shape. */
export function layoutAmps(values, count, { mirror, reverse, closed, signed = false }) {
  const out = new Float32Array(count);
  const n = values.length;
  for (let i = 0; i < count; i++) {
    const u = closed ? i / count : count === 1 ? 0 : i / (count - 1);
    let idx = u;
    if (mirror) idx = closed ? (u <= 0.5 ? u * 2 : (1 - u) * 2) : Math.abs(2 * u - 1);
    if (reverse) idx = 1 - idx;
    const pos = idx * (n - 1);
    const lo = Math.floor(pos); const hi = Math.min(n - 1, lo + 1);
    const f = pos - lo;
    out[i] = values[lo] * (1 - f) + values[hi] * f;
    if (!signed) out[i] = Math.max(0, out[i]);
  }
  return out;
}

// ---------- colour ----------

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1], 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Same hue/saturation/brightness/contrast maths as the image shader, on the CPU. */
export function adjustRgb([r, g, b], hueDeg, sat, bri, con) {
  const a = (hueDeg * Math.PI) / 180;
  const cs = Math.cos(a); const sn = Math.sin(a);
  const k = 0.57735026;
  // rotate about the (1,1,1) axis
  const cx = k * b - k * g; const cy = k * r - k * b; const cz = k * g - k * r; // cross(k, c)
  const d = k * (r + g + b);
  let x = r * cs + cx * sn + k * d * (1 - cs);
  let y = g * cs + cy * sn + k * d * (1 - cs);
  let z = b * cs + cz * sn + k * d * (1 - cs);
  const l = 0.2126 * x + 0.7152 * y + 0.0722 * z;
  x = l + (x - l) * sat; y = l + (y - l) * sat; z = l + (z - l) * sat;
  const f = (v) => Math.min(1, Math.max(0, (v * bri - 0.5) * con + 0.5));
  return [f(x), f(y), f(z)];
}

const lerp = (a, b, t) => a + (b - a) * t;
const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ---------- geometry ----------

/**
 * Build triangles in local pixel space centred on the origin (the renderer applies the
 * layer transform). `amps` are 0..1 for bars/spikes/dots and -1..1 for the waveform.
 * @returns {{ pos: Float32Array, col: Float32Array, vertexCount: number }}
 */
export function buildVisual(vis, amps, { minDim, time = 0, colors, intensity = 1 }) {
  const { shape, mode, count } = vis;
  const closed = SHAPES[shape].closed;
  const s = sampleShape(shape, count);
  const R = vis.radius * minDim * (shape === 'line' ? 2.2 : 1);
  const L = vis.length * minDim * intensity;
  const spin = ((vis.spin * time) * Math.PI) / 180;
  const cs = Math.cos(spin); const sn = Math.sin(spin);
  const rot = (x, y) => [x * cs - y * sn, x * sn + y * cs];

  // spacing between neighbours, in pixels, from the real outline length
  const perimeter = shape === 'line' ? 2 * R : approxPerimeter(s, R, closed);
  const spacing = perimeter / (closed ? count : Math.max(1, count - 1));

  const verts = []; // x,y
  const cols = [];  // r,g,b,a
  const quad = (a, b, c, d, ca, cb) => {
    verts.push(...a, ...b, ...c, ...a, ...c, ...d);
    cols.push(...ca, ...cb, ...cb, ...ca, ...cb, ...ca);
  };
  const tri = (a, b, c, ca, cb) => {
    verts.push(...a, ...b, ...c);
    cols.push(...ca, ...ca, ...cb);
  };
  const colAt = (i, amp) => {
    const u = closed ? i / count : count === 1 ? 0 : i / (count - 1);
    const t = vis.gradient === 'solid' ? 0 : vis.gradient === 'amp' ? Math.min(1, Math.abs(amp)) : (vis.mirror ? (closed ? (u <= 0.5 ? u * 2 : (1 - u) * 2) : Math.abs(2 * u - 1)) : u);
    const c = mixRgb(colors[0], colors[1], t);
    return [c[0], c[1], c[2], 1];
  };

  const base = (i) => rot(s.x[i] * R, s.y[i] * R);
  const dir = (i) => rot(s.nx[i], s.ny[i]);

  if (mode === 'wave') {
    const lw = Math.max(1, vis.line * minDim) / 2;
    const pts = [];
    for (let i = 0; i < count; i++) {
      const b = base(i); const n = dir(i);
      const off = amps[i] * L * vis.gain;
      pts.push([b[0] + n[0] * off, b[1] + n[1] * off, n]);
    }
    const segs = closed ? count : count - 1;
    for (let i = 0; i < segs; i++) {
      const p = pts[i]; const q = pts[(i + 1) % count];
      const dx = q[0] - p[0]; const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * lw; const ny = (dx / len) * lw;
      quad([p[0] - nx, p[1] - ny], [q[0] - nx, q[1] - ny], [q[0] + nx, q[1] + ny], [p[0] + nx, p[1] + ny], colAt(i, amps[i]), colAt((i + 1) % count, amps[(i + 1) % count]));
    }
  } else {
    const half = Math.max(0.75, (spacing * vis.fill) / 2);
    for (let i = 0; i < count; i++) {
      const amp = Math.min(1, Math.max(0, amps[i] * vis.gain));
      const h = L * (vis.floor + (1 - vis.floor) * amp);
      const b = base(i); const n = dir(i);
      const t = [-n[1], n[0]];
      const inner = vis.both ? -h : 0;
      const c = colAt(i, amp);
      const p0 = [b[0] + n[0] * inner, b[1] + n[1] * inner];
      const p1 = [b[0] + n[0] * h, b[1] + n[1] * h];
      if (mode === 'bars') {
        quad([p0[0] - t[0] * half, p0[1] - t[1] * half], [p0[0] + t[0] * half, p0[1] + t[1] * half],
          [p1[0] + t[0] * half, p1[1] + t[1] * half], [p1[0] - t[0] * half, p1[1] - t[1] * half], c, c);
      } else if (mode === 'spikes') {
        tri([p0[0] - t[0] * half, p0[1] - t[1] * half], [p0[0] + t[0] * half, p0[1] + t[1] * half], p1, c, c);
        if (vis.both) tri([p0[0] - t[0] * half, p0[1] - t[1] * half], [p0[0] + t[0] * half, p0[1] + t[1] * half], [b[0] + n[0] * h, b[1] + n[1] * h], c, c);
      } else { // dots: a diamond riding the tip
        const r = Math.max(1.5, half * 1.1);
        const q = p1;
        quad([q[0] + n[0] * r, q[1] + n[1] * r], [q[0] + t[0] * r, q[1] + t[1] * r], [q[0] - n[0] * r, q[1] - n[1] * r], [q[0] - t[0] * r, q[1] - t[1] * r], c, c);
      }
    }
  }
  return { pos: new Float32Array(verts), col: new Float32Array(cols), vertexCount: verts.length / 2 };
}

function approxPerimeter(s, R, closed) {
  let total = 0;
  const n = s.x.length;
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % n;
    total += Math.hypot(s.x[j] - s.x[i], s.y[j] - s.y[i]) * R;
  }
  return total;
}

/** Approximate half extent in pixels (for selection boxes and hit tests). */
export function visExtent(vis, minDim) {
  const R = vis.radius * minDim * (vis.shape === 'line' ? 2.2 : 1);
  const L = vis.length * minDim;
  return vis.shape === 'line' ? { w: 2 * R, h: 2 * L + 8 } : { w: 2 * (R + L), h: 2 * (R + L) };
}

/** One-call helper used by the renderer: amplitudes for this frame. */
export function visAmplitudes(vis, { spec, pcm, fps, frame }) {
  const closed = SHAPES[vis.shape].closed;
  if (vis.mode === 'wave') {
    const raw = pcm ? waveAtFrame(pcm, fps, frame, Math.max(vis.count, 64)) : new Float32Array(64);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.max(-1, Math.min(1, raw[i] * 2.5));
    return layoutAmps(raw, vis.count, { mirror: vis.mirror, reverse: vis.reverse, closed, signed: true });
  }
  if (!spec) return new Float32Array(vis.count);
  const bands = bandsAtFrame(spec, fps, frame, vis.release);
  return layoutAmps(bands, vis.count, { mirror: vis.mirror, reverse: vis.reverse, closed });
}

/** Ready-made starting points shown in the Add menu. */
export const VIS_PRESETS = [
  { name: 'Circle bars',    vis: { shape: 'circle', mode: 'bars', count: 72, mirror: true } },
  { name: 'Line spectrum',  vis: { shape: 'line', mode: 'bars', count: 48, mirror: true, reverse: true, radius: 0.2, length: 0.2 } },
  { name: 'Triangle spikes', vis: { shape: 'triangle', mode: 'spikes', count: 60, mirror: true, radius: 0.25, length: 0.14, spin: 12 } },
  { name: 'Square pulse',   vis: { shape: 'square', mode: 'bars', count: 64, mirror: true, radius: 0.2, length: 0.14, color1: '#7cf3b2', color2: '#6bd5ff' } },
  { name: 'Wave ring',      vis: { shape: 'circle', mode: 'wave', count: 160, mirror: true, radius: 0.22, length: 0.1, line: 0.005 } },
  { name: 'Star dots',      vis: { shape: 'star', mode: 'dots', count: 50, mirror: true, radius: 0.22, length: 0.12, color1: '#ffd166', color2: '#ff6b9d' } },
  { name: 'Heart bars',     vis: { shape: 'heart', mode: 'bars', count: 80, mirror: true, radius: 0.2, length: 0.1, color1: '#ff6b9d', color2: '#ffd1e3' } },
];
