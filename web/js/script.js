// Settings, compile cache and text measuring for "script" layers (kinetic text / presentations).
import { parseScript, compileScript, PACKS } from './kinetic.js';
import { familyCss, nearestWeight, migrateFont } from './fonts.js';

export const SCRIPT_DEFAULTS = {
  text: '# Your title\nA short line to start\n\n- First point\n- Second **point**\n\n> A quote worth reading\n-- Someone',
  pack: 'punchy', energy: 0.6, seed: 1, fontHead: '', fontBody: '',
  fit: 'script', // 'script' = use scene lengths; 'project' = stretch to the project length
  pulse: 1,
};

export function scriptSettings(def) {
  const s = { ...SCRIPT_DEFAULTS, ...(def.script ?? {}) };
  s.pack = PACKS[s.pack] ? s.pack : 'punchy';
  s.energy = Math.min(1, Math.max(0, Number(s.energy) || 0));
  s.seed = Math.round(Number(s.seed) || 1);
  return s;
}

let ctx = null;
export function measureText(text, font, weight, px) {
  ctx ??= document.createElement('canvas').getContext('2d');
  const f = migrateFont(font);
  ctx.font = `${nearestWeight(f, weight)} ${px}px ${familyCss(f)}`;
  return ctx.measureText(text).width;
}

const cache = new Map();
/** Compile (cached) for a canvas size. `total` is the project length in seconds when fit==='project'. */
export function compileFor(def, W, H, total, measure = measureText) {
  const s = scriptSettings(def);
  const key = JSON.stringify([s, W, H, s.fit === 'project' ? Math.round(total * 10) : 0]);
  let c = cache.get(key);
  if (!c) {
    c = compileScript(parseScript(s.text), { W, H, measure, pack: s.pack, energy: s.energy, seed: s.seed,
      fontHead: s.fontHead || undefined, fontBody: s.fontBody || undefined, total: s.fit === 'project' ? total : undefined });
    cache.set(key, c);
    if (cache.size > 12) cache.delete(cache.keys().next().value);
  }
  return c;
}

/** Fonts a script may use, known before compiling (so they can be loaded before measuring). */
export function scriptFonts(def) {
  const st = scriptSettings(def);
  const P = PACKS[st.pack];
  const used = new Set([st.fontHead || P.head, st.fontBody || P.body]);
  const sc = parseScript(st.text);
  if (sc.options.font) used.add(sc.options.font);
  const pk = PACKS[sc.options.pack];
  if (pk) { used.add(pk.head); used.add(pk.body); }
  for (const s of sc.scenes) if (s.dir.style && PACKS[s.dir.style]) { used.add(PACKS[s.dir.style].head); used.add(PACKS[s.dir.style].body); }
  return [...used];
}
