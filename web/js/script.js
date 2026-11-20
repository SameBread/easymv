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
export function measureText(text, font, weight, px, italic = false) {
  ctx ??= document.createElement('canvas').getContext('2d');
  const f = migrateFont(font);
  ctx.font = `${italic ? 'italic ' : ''}${nearestWeight(f, weight)} ${px}px ${familyCss(f)}`;
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

// Both demos show the whole syntax: scene directives (::at ::style ::trans ::reveal ::dur ::layout), line {at=..},
// word [..]{size color at delay motion}, syllables a|b~secs|c^size, and explicit end times for instrumental gaps.
export const DEMO_PRESENTATION = `@pack punchy

# Marxism in 30 seconds
A way to read history {size=.8 at=B3}

---
::style editorial
::trans push
::at left
Every society
runs on **WORK**{size=1.7 color=accent}

---
::style punchy
::trans wipe
::layout center
::reveal line
Some people own the **fac|to|ries**{color=accent step=.3}
Others sell their [labour]{size=1.5 color=#ffd166 delay=.5}

---
::layout quote
::trans fade
> The history of all hitherto existing society is the history of class struggle.
-- Marx and Engels, 1848

---
::trans bars
::at top
Owners keep the **PROFIT**{motion=zoom}
Workers keep the wage {at=C3 color=dim}

---
::style retro
::emph color
::dur 3.5
2 classes
(bourgeoisie and proletariat) {at=C3 size=.7}

---
::style smooth
::trans fade
::layout list
- Capital builds **power**{color=accent}
- Power shapes laws and ideas
- Crises force **change**{size=1.4 color=accent}

---
::trans zoom
::layout center
Marx's bet: {at=A1 size=.7}
the system will **BREAK**{size=2 color=accent motion=drop} {at=B2}
it **cra^1.5|cks~.5|a|part** {at=C3 size=.7}

---
::style editorial
::at center
Agree or not
**THINK**{size=1.8 color=accent} about who owns what

---
# Das Kapital
Start **here**{color=accent delay=.6 motion=rise}`;

export const DEMO_LYRICS = `@pack smooth

::trans fade
[0:02.30-0:06.30] every dull **mem|o|ries**{big color=accent step=.22 motion=pop}

::trans fade
[0:08.50-0:13.50] faces null then **fades**{big delay=.25 color=accent motion=fade} free

::style retro
::emph color
::trans push
::at bottom-left
[0:17.90] your **spectre**{big color=accent motion=rise}
[0:19.20] walks these streets {at=B2}
[0:20.10] with me {at=C3}

::style retro
::emph color
::trans push
::at top-right
[0:21.47] in **shadows**{big color=dim motion=fade} {at=A2}
[0:22.20] only i {at=B3}
[0:23.07-0:24.00] can see {at=C2}

::style retro
::emph color
::trans push
[0:24.43] every step {at=A2}
[0:25.20-0:27.50] is a **question**{big color=accent motion=pop} mark {at=C3}

::style handwritten
::emph color
::at A3
[0:27.90] this city
[0:28.30] that **forgets**{big color=accent motion=pop}
[0:29.70-0:31.00] the dark {at=C1 motion=fade}

::style handwritten
::emph color
::trans push
::at top
[0:33.80-0:36.00] **rain**{big color=#7fc8ff} keeps falling slow {motion=rise}

::style handwritten
::emph color
[0:36.37] and i... {at=A1}
[0:37.27-0:40.30] maybe I'll find **peace**{size=1.8 color=accent motion=pop} {at=B3}

::style smooth
::trans fade
::at middle-left
[0:40.40-0:42.40] in the **hush**{big color=dim motion=fade} between

::style smooth
::at B1
[0:42.77] the breeze where the lights
[0:44.77-0:46.10] hum **lul|la|bies**{big color=accent step=.25 motion=fade}

::style smooth
[0:46.90-0:49.00] city's feeling **bare**{size=1.8 motion=fade}

::style retro
::emph color
::trans push
::at A2
[0:49.17] and im hearing **echoes**{big color=accent motion=rise}
[0:51.40-0:53.03] call your name {at=C2 delay=.2}

::style retro
::emph color
::at top
[0:53.13-0:54.60] rain keeps falling {color=#7fc8ff}

::at center
::trans fade
[0:54.90-1:02.00] i'm{small} **col^1.2~1.8|laps^1.5~1.8|ing^1.9**{color=accent motion=drop}`;
