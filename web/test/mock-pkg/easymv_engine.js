// Test-only stand-in for the wasm-bindgen module, so the UI can be exercised without a WASM build.
// It mimics the real API shape (flat Float32 output in "linear memory", JSON in/out), not the DSP.
const NAMES = ['positionX','positionY','rotation','scale','scaleX','scaleY','mirrorX','mirrorY','opacity','hueShift','saturation','brightness','contrast','blur','anchorX','anchorY'];
const DEFAULTS = [0.5,0.5,0,1,1,1,0,0,1,0,1,1,1,0,0.5,0.5];
const OUT = 4096, PCM = 1 << 20, SECS = 4, SR = 44100;
let memory;
export default async function init() { memory = new WebAssembly.Memory({ initial: 48 }); return { memory }; }
export const property_count = () => 16;
export const property_names = () => JSON.stringify(NAMES);
export function validate_project(j) {
  const p = JSON.parse(j); const ids = new Set(); const out = [];
  for (const e of p.elements) { if (ids.has(e.id)) out.push({ severity: 'error', message: `duplicate element id '${e.id}'` }); ids.add(e.id); }
  return JSON.stringify(out);
}
export function auto_mode(j) {
  const p = JSON.parse(j);
  p.connections = p.connections.filter((c) => c.origin !== 'auto');
  const hero = p.elements.find((e) => (e.zIndex ?? 0) >= 0);
  if (hero) p.connections.push({ source: 'master', feature: 'onset', element: hero.id, property: 'scaleX', curve: 'easeOut', outMin: 0, outMax: 0.15, combine: 'add', attackMs: 10, releaseMs: 200, origin: 'auto' });
  return JSON.stringify(p);
}
const baseOf = (e) => { const v = [...DEFAULTS]; for (const [k, x] of Object.entries(e.base ?? {})) v[NAMES.indexOf(k)] = x; return v; };
export class Engine {
  constructor(j) { this.p = JSON.parse(j); this.q = 1 + this.p.stems.length; this.els = []; }
  load_master() {} load_stem() {} free() {}
  analysis_pending() { return this.q; }
  analysis_step() { this.q--; return 'x'; }
  compile(j) { this.p = JSON.parse(j); this.els = this.p.elements.map(baseOf); return '[]'; }
  update_base(j) { this.els = JSON.parse(j).elements.map(baseOf); }
  evaluate_batch(start, count) {
    const total = this.total_frames(); if (start >= total) return 0;
    const n = Math.min(count, 64, total - start);
    const f = new Float32Array(memory.buffer, OUT, this.output_len());
    for (let i = 0; i < n; i++) this.els.forEach((b, e) => f.set(b, (i * this.els.length + e) * 16));
    return n;
  }
  output_ptr() { return OUT; } output_len() { return 64 * this.els.length * 16; }
  total_frames() { return Math.ceil(SECS * this.p.videoFps); } element_count() { return this.els.length; }
  source_ids() { return JSON.stringify(['master', ...this.p.stems.map((s) => s.id)]); }
  analysis_rate() { return 200; }
  feature_series() { const s = new Float32Array(SECS * 200); for (let i = 0; i < s.length; i += 50) s[i] = 1; return s; }
  master_sample_rate() { return SR; } master_channels() { return 2; } master_frames() { return SR * SECS; }
  master_pcm_ptr() { return PCM; } master_pcm_len() { return SR * SECS * 2; }
}
export class GifDecoder { constructor() { throw new Error('mock: gif unsupported'); } }
