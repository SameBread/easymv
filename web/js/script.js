// Settings, presets, demos, compile cache and text measuring for "script" layers
// (kinetic text for presentations, lyric videos and captions).
import { parseScript, compileScript, PACKS } from './kinetic.js';
import { familyCss, nearestWeight, migrateFont } from './fonts.js';

export const SCRIPT_DEFAULTS = {
  text: '# Your title\nA short line to start\n\n- First point\n- Second **point**\n\n> A quote worth reading\n-- Someone',
  mode: 'presentation',
  pack: 'punchy', energy: 0.6, seed: 1, fontHead: '', fontBody: '', fontFiles: {},
  fit: 'script',          // 'script' = scene lengths from the text; 'project' = stretch to project length
  bgMode: 'scenes',       // 'scenes' = own animated backgrounds, 'solid' = one colour, 'none' = transparent (sits over other layers)
  bgColor: '#101820',
  fg: '', accent: '',     // '' = automatic
  reveal: 'auto',         // 'auto' springy stagger, 'word' spread words across the line time, 'line' whole line at once
  place: 'full',          // 'full' | 'lower' | 'middle' | 'upper'
  layouts: 'all',         // 'all' | 'calm' (centre, left, diagonal only)
  shadow: 0,              // 0..1 soft shadow behind text (helps on busy backgrounds)
  pulse: 1,
};

/** One-click bundles of the options above. Text is never touched. */
export const MODES = {
  presentation: { label: 'Presentation / explainer', mode: 'presentation', bgMode: 'scenes', reveal: 'auto', place: 'full', layouts: 'all', shadow: 0, pack: 'punchy', energy: 0.7, fit: 'script' },
  lyrics: { label: 'Lyrics over a background', mode: 'lyrics', bgMode: 'none', reveal: 'word', place: 'lower', layouts: 'calm', shadow: 0.6, pack: 'smooth', energy: 0.4, fit: 'script', fg: '', accent: '' },
};
export function applyMode(s, id) { Object.assign(s, MODES[id]); }

export function scriptSettings(def) {
  const s = { ...SCRIPT_DEFAULTS, ...(def.script ?? {}) };
  s.pack = PACKS[s.pack] ? s.pack : 'punchy';
  s.energy = Math.min(1, Math.max(0, Number(s.energy) || 0));
  s.seed = Math.round(Number(s.seed) || 1);
  s.fontFiles = { ...(s.fontFiles ?? {}) };
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
      fontHead: s.fontHead || undefined, fontBody: s.fontBody || undefined, total: s.fit === 'project' ? total : undefined,
      bgMode: s.bgMode, bgColor: s.bgColor, fg: s.fg || undefined, accent: s.accent || undefined,
      reveal: s.reveal, place: s.place, layoutSet: s.layouts, shadow: s.shadow });
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

// ---------- demos ----------

export const DEMO_PRESENTATION = `# Marxism in 30 seconds
A way to read history

---

Every society
runs on **WORK**

---

Some people own the factories
Others sell their **labour**

---

> The history of all hitherto existing society is the history of class struggle.
-- Marx and Engels, 1848

---

Owners keep the **PROFIT**
Workers keep the wage

---

2 classes
(bourgeoisie and proletariat)

---

- Capital builds **power**
- Power shapes laws and ideas
- Crises force **change**

---

Marx's bet:
the system will **BREAK**

---

Agree or not
**THINK** about who owns what

---

# Das Kapital
Start here`;

export const DEMO_LYRICS = `[0:02.10] every dull **memories**

[0:08.50] faces null then **fades** free

[0:18.23] your **spectre**
[0:19.20] walks these streets
[0:20.10] with me

[0:21.47] in **shadows**
[0:22.87] only i can see

[0:24.43] every step
[0:25.93] is a **question** mark

[0:27.90] this city
[0:28.90] that **forgets**
[0:30.00] the dark

[0:34.27] **rain** keeps falling slow

[0:36.57] and i...
[0:37.57] maybe I'll find **peace**

[0:40.40] in the **hush** between

[0:42.77] the breeze where the lights
[0:44.77] hum **lullabies**

[0:46.90] city's feeling **bare**

[0:49.37] and im hearing **echoes**
[0:51.50] call your name

[0:53.33] rain keeps falling
[0:54.90-0:59.00] i'm **collapsing**`;
