// Test-only stand-in for the wasm-bindgen module, so the UI can be exercised without a WASM build.
// It mimics the real API shape (flat Float32 output in "linear memory", JSON in/out), not the DSP.
const NAMES = ['positionX','positionY','rotation','scale','scaleX','scaleY','mirrorX','mirrorY','opacity','hueShift','saturation','brightness','contrast','blur','anchorX','anchorY','visible','intensity'];
const DEFAULTS = [0.5,0.5,0,1,1,1,0,0,1,0,1,1,1,0,0.5,0.5,1,1];
const N = 18;
const OUT = 4096, PCM = 1 << 20, SECS = 4, SR = 44100;
let memory;
export default async function init() { memory = new WebAssembly.Memory({ initial: 48 }); return { memory }; }
export const property_count = () => N;
export const property_names = () => JSON.stringify(NAMES);
export function validate_project(j) {
  const p = JSON.parse(j); const ids = new Set(); const out = [];
  for (const e of p.elements) { if (ids.has(e.id)) out.push({ severity: 'error', message: `duplicate element id '${e.id}'` }); ids.add(e.id); }
  return JSON.stringify(out);
}
export function auto_mode(j) {
  const p = JSON.parse(j);
  p.connections = p.connections.filter((c) => c.origin !== 'auto');
  const hero = p.elements[p.elements.length - 1];
  if (hero) p.connections.push({ source: 'master', feature: 'onset', element: hero.id, property: 'scaleX', curve: 'easeOut', outMin: 0, outMax: 0.15, combine: 'add', attackMs: 10, releaseMs: 200, origin: 'auto' });
  return JSON.stringify(p);
}
const baseOf = (e) => { const v = [...DEFAULTS]; for (const [k, x] of Object.entries(e.base ?? {})) v[NAMES.indexOf(k)] = x; return v; };
export class Engine {
  constructor(j) { this.p = JSON.parse(j); this.q = 1 + this.p.stems.length; this.els = []; }
  load_master() {} load_stem() {} free() {}
  analysis_pending() { return this.q; }
  analysis_step() { this.q--; return 'x'; }
  compile(j) { this.p = JSON.parse(j); this.els = this.p.elements.map(baseOf); this.tracks = this.p.tracks ?? []; return '[]'; }
  update_base(j) { this.els = JSON.parse(j).elements.map(baseOf); }
  trackValue(t, f) {
    const k = t.keys; if (f <= k[0].f) return k[0].v; if (f >= k.at(-1).f) return k.at(-1).v;
    let i = 0; while (k[i + 1].f <= f) i++;
    if (t.property === 'visible' || k[i].interp === 'hold') return k[i].v;
    return k[i].v + (k[i + 1].v - k[i].v) * ((f - k[i].f) / (k[i + 1].f - k[i].f));
  }
  spectrum_series(_id, bands) { const n = SECS * 200; const a = new Float32Array(n * bands); for (let i = 0; i < n; i++) for (let b = 0; b < bands; b++) a[i * bands + b] = 0.5 + 0.5 * Math.sin(i / 20 + b); return a; }
  source_mono_ptr() { return PCM; } source_mono_len() { return SR * SECS; }
  evaluate_batch(start, count) {
    const total = this.total_frames(); if (start >= total) return 0;
    const n = Math.min(count, 64, total - start);
    const f = new Float32Array(memory.buffer, OUT, this.output_len());
    for (let i = 0; i < n; i++) this.els.forEach((b, e) => {
      const v = Float32Array.from(b); const id = this.p.elements[e].id;
      for (const t of this.tracks ?? []) if (t.element === id) { const idx = NAMES.indexOf(t.property); if (idx >= 0) v[idx] = this.trackValue(t, start + i); }
      f.set(v, (i * this.els.length + e) * N);
    });
    return n;
  }
  output_ptr() { return OUT; } output_len() { return 64 * this.els.length * N; }
  total_frames() { return Math.ceil(SECS * this.p.videoFps); } element_count() { return this.els.length; }
  source_ids() { return JSON.stringify(['master', ...this.p.stems.map((s) => s.id)]); }
  analysis_rate() { return 200; }
  feature_series() { const s = new Float32Array(SECS * 200); for (let i = 0; i < s.length; i += 50) s[i] = 1; return s; }
  master_sample_rate() { return SR; } master_channels() { return 2; } master_frames() { return SR * SECS; }
  master_pcm_ptr() { return PCM; } master_pcm_len() { return SR * SECS * 2; }
}
export class GifDecoder { constructor() { throw new Error('mock: gif unsupported'); } }
