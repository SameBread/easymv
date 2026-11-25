// Settings, presets, demos, compile cache and text measuring for "script" layers
// (kinetic text for presentations, lyric videos and captions).
import { parseScript, compileScript, PACKS, getScriptTempo } from './kinetic.js';
import { familyCss, nearestWeight, migrateFont, fontReady, loadBundled } from './fonts.js';

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
  look: 'none',           // how the letters are drawn (see LOOK_NAMES): outline, glow, neon... 'none' by default; text can override with ::look / @look
  deco: 'none',           // decorations around the text (see DECO_NAMES): 'none' by default; text can override with ::deco / @deco
  shadow: 0,              // 0..1 soft shadow behind text (helps on busy backgrounds)
  pulse: 1,
};

/** One-click bundles of the options above. Text is never touched. */
export const MODES = {
  presentation: { label: 'Presentation / explainer', mode: 'presentation', bgMode: 'scenes', reveal: 'auto', place: 'full', layouts: 'all', shadow: 0, pack: 'punchy', energy: 0.7, fit: 'script' },
  lyrics: { label: 'Lyrics over a background', mode: 'lyrics', bgMode: 'none', reveal: 'word', place: 'full', layouts: 'calm', shadow: 0.6, pack: 'smooth', energy: 0.4, fit: 'script', fg: '', accent: '' },
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
let measuredEarly = false;     // set when something was measured before its font had loaded (the numbers would be wrong)
export function measureText(text, font, weight, px, italic = false) {
  ctx ??= document.createElement('canvas').getContext('2d');
  const f = migrateFont(font);
  if (!fontReady(f)) measuredEarly = true;
  ctx.font = `${italic ? 'italic ' : ''}${nearestWeight(f, weight)} ${px}px ${familyCss(f)}`;
  return ctx.measureText(text).width;
}

const cache = new Map();
/** Compile (cached) for a canvas size. `total` is the project length in seconds when fit==='project'. */
export function compileFor(def, W, H, total, measure = measureText) {
  const s = scriptSettings(def);
  const tempo = getScriptTempo();
  const key = JSON.stringify([s, W, H, s.fit === 'project' ? Math.round(total * 10) : 0, tempo]);
  let c = cache.get(key);
  if (!c) {
    measuredEarly = false;
    c = compileScript(parseScript(s.text), { W, H, measure, pack: s.pack, energy: s.energy, seed: s.seed,
      fontHead: s.fontHead || undefined, fontBody: s.fontBody || undefined, total: s.fit === 'project' ? total : undefined,
      bgMode: s.bgMode, bgColor: s.bgColor, fg: s.fg || undefined, accent: s.accent || undefined,
      reveal: s.reveal, place: s.place, layoutSet: s.layouts, shadow: s.shadow, deco: s.deco, look: s.look, tempo });
    // text measured before its font finished loading is spaced by a stand-in font: use it for now but never keep it
    if (!measuredEarly) cache.set(key, c);
    else for (const f of scriptFonts(def)) loadBundled(migrateFont(f));      // start loading so the next call measures properly
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
@energy 0.25
@fx breathe

::layout center
::reveal word
::emph color
::out 0.8
::trans fade
[0:03.80] Every dull{color=dim} memories
[0:10.50] faces null{color=dim motion=fade} then fades{motion=fade} free{color=dim}

::layout stack
::reveal line
::out 0.5
::trans fade
[0:19.40] Your **spectre**{motion=fade}
[0:20.70] walks these streets
[0:21.60] with me{color=dim}

::layout stack
::reveal line
::out 0.5
::trans fade
[0:22.97] in shadows{color=dim motion=fade}
[0:23.70] [only i]{size=0.9}
[0:24.57] can see{motion=fade}

::layout left
::align left
::out 0.6
::trans fade
[0:25.93] Every step
[0:26.70] is a [question mark]{motion=tilt}
[0:29.40] this city
[0:29.80] that forgets
[0:31.20-0:33.50] the **dark**{color=dim}

::layout center
::fx wave
::amp 0.8
::speed 0.8
::out 0.4
::trans fade
[0:35.30] Rain keeps falling{motion=drop} slow{delay=0.3 color=dim}
[0:37.87] [and i...]{color=dim motion=fade}

::layout center
::deco bar
::out 0.6
::trans fade
[0:38.77] maybe I'll find **peace**{color=accent motion=rise}
[0:41.90] In the hush{size=0.85 color=dim} between
[0:44.27] the breeze{motion=slideR}
[0:45.27] where the lights{color=accent}
[0:46.27] [hum lullabies]{wave}

::layout stack
::deco none
::out 0.5
::trans fade
[0:48.40] city's feeling bare{color=dim}
[0:50.67] and i'm hearing echoes{motion=zoom}
[0:52.90-0:54.60] call **your name**{color=accent}

::layout bigword
[0:54.63-0:56.39] Rain keeps falling{motion=drop}

::layout bigword
::at B2
[0:56.40] I'm{size=0.5 color=dim}
[0:58.00-1:02.50] col~2.0|laps~1.4|ing{motion=drop shake}
`;
