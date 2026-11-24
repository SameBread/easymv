// Kinetic text engine: turns a plain-text script into animated, automatically laid-out scenes.
// Pure and deterministic (no DOM, no Math.random): the same script, size and time always give
// the same picture, so scrubbing and export match the preview.
//
//   parseScript(text)                -> { options, scenes[] }       (outline syntax, see below)
//   compileScript(script, ctx)       -> compiled timeline            (layout, timing, motion)
//   frameAt(compiled, t, {pulse})    -> { passes[] }                 (what to draw at time t)
//
// Script syntax (everything is optional; plain paragraphs work):
//   blank line or ---     next scene          # Title      ## Subtitle
//   - bullet              > quote             -- Attribution
//   **word**              emphasis            [mm:ss.x] text   start time;  [mm:ss.x-mm:ss.x] text  also sets the end
//   ::dur 4  ::bg #123456  ::style retro  ::layout stack  ::trans push  ::pal 2  ::reveal word   scene settings
//   @pack punchy  @energy 0.8  @seed 3  @font Anton   whole-script settings
//
// ctx: { W, H, measure(text, font, weight, px) -> width px, total? (seconds to fill) }

// ---------- small utils ----------

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function hash(...vals) {
  let h = 2166136261 >>> 0;
  for (const v of vals) {
    const s = String(v);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 0x9e3779b9; h = Math.imul(h, 2246822507) >>> 0;
  }
  h ^= h >>> 15; h = Math.imul(h, 2654435761) >>> 0;
  return h >>> 0;
}
/** Seeded random in [0,1) from any values. */
export const rnd = (...v) => hash(...v) / 4294967296;
const pick = (arr, r) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
function pickWeighted(entries, r) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return entries[0][0];
  let x = r * total;
  for (const [k, w] of entries) { x -= w; if (x <= 0) return k; }
  return entries.at(-1)[0];
}

// ---------- colour ----------

export const hexToRgb = (h) => { const s = h.replace('#', ''); const n = parseInt(s.length === 3 ? s.replace(/./g, '$&$&') : s, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const rgbToHex = (c) => `#${c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const luminance = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export const contrast = (a, b) => { const la = luminance(a); const lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const mixc = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
/** Move `c` toward white or black until it has at least `min` contrast against `bg`. */
export function ensureContrast(c, bg, min) {
  if (contrast(c, bg) >= min) return c;
  const target = contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg) ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0.1; t <= 1.0001; t += 0.1) { const m = mixc(c, target, t); if (contrast(m, bg) >= min) return m; }
  return target;
}
const readable = (bg) => (luminance(bg) > 0.4 ? [17, 17, 20] : [255, 255, 255]);

// ---------- packs (style personalities) ----------

export const PACKS = {
  punchy: {
    label: 'Punchy', head: 'Anton', body: 'Inter', headWeight: 400, bodyWeight: 800, caps: true,
    palettes: [
      { bg: '#0e0e12', bg2: '#251040', fg: '#ffffff', accent: '#ff3d71' },
      { bg: '#ffd23f', bg2: '#ff9f1c', fg: '#111111', accent: '#e63946' },
      { bg: '#2b2d42', bg2: '#14213d', fg: '#edf2f4', accent: '#ef233c' },
      { bg: '#00e5c7', bg2: '#00a8f0', fg: '#0b132b', accent: '#f72585' },
      { bg: '#f72585', bg2: '#7209b7', fg: '#ffffff', accent: '#ffd60a' },
    ],
    motion: ['pop', 'drop', 'slideL', 'slideR', 'zoom', 'flip'], spring: { k: 300, z: 0.55 }, step: 0.085,
    transitions: ['push', 'wipe', 'bars', 'zoom', 'cut', 'slices'], transDur: 0.34,
    layouts: { stack: 3, bigword: 2.4, diagonal: 1.4, center: 1, left: 1, split: 1.6, list: 1, quote: 1, stat: 1 },
    bgs: ['gradient', 'split', 'bars', 'blobs'], emph: 'mix', pulse: 0.07, drift: 0.05, idle: 0.01,
  },
  smooth: {
    label: 'Smooth', head: 'Playfair Display', body: 'Inter', headWeight: 700, bodyWeight: 400, caps: false,
    palettes: [
      { bg: '#101820', bg2: '#1b2a41', fg: '#f2f2f2', accent: '#f4b942' },
      { bg: '#0b3954', bg2: '#087e8b', fg: '#ffffff', accent: '#ffb5a7' },
      { bg: '#f4f1ea', bg2: '#e4ddcf', fg: '#1d1d1f', accent: '#c8553d' },
      { bg: '#2d1e2f', bg2: '#5a3a5e', fg: '#fdf0ff', accent: '#ffc857' },
    ],
    motion: ['rise', 'fade', 'zoom'], spring: { k: 90, z: 0.9 }, step: 0.14,
    transitions: ['fade', 'zoom', 'push', 'cover'], transDur: 0.55,
    layouts: { center: 3, left: 2, quote: 2, split: 1, bigword: 1, stack: 0.5, diagonal: 0.3, list: 1, stat: 1 },
    bgs: ['gradient', 'blobs', 'solid'], emph: 'color', pulse: 0.03, drift: 0.04, idle: 0.012,
  },
  retro: {
    label: 'Retro pixel', head: 'Press Start 2P', body: 'Press Start 2P', headWeight: 400, bodyWeight: 400, caps: true,
    palettes: [
      { bg: '#0d0221', bg2: '#261447', fg: '#00f0ff', accent: '#ff2a6d' },
      { bg: '#1a1c2c', bg2: '#333c57', fg: '#f4f4f4', accent: '#ffcd75' },
      { bg: '#222034', bg2: '#45283c', fg: '#fbf236', accent: '#5fcde4' },
    ],
    motion: ['drop', 'slideL', 'flip', 'pop'], spring: { k: 420, z: 0.8 }, step: 0.11,
    transitions: ['slices', 'bars', 'cut', 'wipe'], transDur: 0.3,
    layouts: { center: 2, stack: 1.5, left: 1.5, list: 1.5, quote: 1, split: 1, bigword: 1, diagonal: 1, stat: 1 },
    bgs: ['dots', 'bars', 'solid'], emph: 'bar', pulse: 0.05, drift: 0.0, idle: 0,
  },
  handwritten: {
    label: 'Handwritten', head: 'Permanent Marker', body: 'Caveat', headWeight: 400, bodyWeight: 700, caps: false,
    palettes: [
      { bg: '#fff8e7', bg2: '#f3e9cf', fg: '#222222', accent: '#e4572e' },
      { bg: '#1f3b2d', bg2: '#16301f', fg: '#f5f5dc', accent: '#ffd166' },
      { bg: '#e8f1f2', bg2: '#cfe3e6', fg: '#13293d', accent: '#ee6c4d' },
    ],
    motion: ['rise', 'tilt', 'pop'], spring: { k: 150, z: 0.7 }, step: 0.12,
    transitions: ['fade', 'push', 'cover'], transDur: 0.45,
    layouts: { center: 2, left: 2, diagonal: 2, quote: 1.5, list: 1.5, bigword: 1.2, split: 1, stack: 0.4, stat: 1 },
    bgs: ['solid', 'dots'], emph: 'bar', pulse: 0.03, drift: 0.03, idle: 0.015,
  },
  editorial: {
    label: 'Editorial', head: 'Playfair Display', body: 'Inter', headWeight: 700, bodyWeight: 600, caps: false,
    palettes: [
      { bg: '#f5f2eb', bg2: '#ebe6d9', fg: '#161616', accent: '#d1342f' },
      { bg: '#111111', bg2: '#1c1c1c', fg: '#f5f2eb', accent: '#e9c46a' },
      { bg: '#e9ecef', bg2: '#dee2e6', fg: '#212529', accent: '#1971c2' },
    ],
    motion: ['rise', 'fade', 'slideL'], spring: { k: 120, z: 0.85 }, step: 0.11,
    transitions: ['push', 'fade', 'wipe', 'cover'], transDur: 0.45,
    layouts: { left: 3, split: 2.5, list: 2, quote: 2, center: 1, stat: 2, bigword: 1, stack: 0.4, diagonal: 0.3 },
    bgs: ['solid', 'bars'], emph: 'bar', pulse: 0.02, drift: 0.02, idle: 0.008,
  },
};
export const PACK_IDS = Object.keys(PACKS);
export const LAYOUT_IDS = ['center', 'left', 'stack', 'bigword', 'diagonal', 'split', 'list', 'quote', 'stat'];
export const TRANSITION_IDS = ['cut', 'fade', 'push', 'zoom', 'wipe', 'bars', 'cover', 'slices'];

// ---------- parsing ----------

const STOP = new Set(('a an the and or but if so of to in on at by for from with as is are was were be been being it its this that these those i you he she we they me him her us them my your his our their ' +
  'not no do does did have has had will would can could should may might must just than then there here what which who whom when where why how all any each more most other some such only own same too very s t').split(' '));
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
const TT = String.raw`(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?`;
const TIME_TAG = new RegExp(String.raw`^\[${TT}(?:\s*[-\u2013>]\s*${TT})?\]\s*`);
const tsec = (a, b, c) => Number(a) * 60 + Number(b) + (c ? Number(c) / 10 ** c.length : 0);

/** `{size=1.5 color=accent at=C3 delay=.3 motion=pop}` -> { size, color, at, delay, motion }. Bare words: big, small, accent, dim. */
/** Per-word effects that keep moving while the word is on screen:  word{shake}  word{fx=bounce+rainbow amp=1.5 speed=2} */
export const FX_NAMES = ['shake', 'tremble', 'bounce', 'hop', 'wave', 'wobble', 'swing', 'pulse', 'heartbeat', 'breathe', 'float', 'drift', 'spin', 'flicker', 'blink', 'glitch', 'jelly', 'rubber', 'rainbow'];
const FX_SET = new Set(FX_NAMES);
/** Decorations drawn around a scene's text:  ::deco bar  /  ::deco underline+brackets color=#ff0 */
export const DECO_NAMES = ['bar', 'bar-right', 'bars', 'underline', 'overline', 'rules', 'box', 'brackets', 'panel', 'highlight', 'diamonds'];
const DECO_SET = new Set(DECO_NAMES);
export const parseFxList = (str) => String(str ?? '').toLowerCase().split(/[+|,\s]+/).filter((x) => FX_SET.has(x));

export function parseMods(str) {
  const m = {};
  for (const tok of String(str).split(/[\s,]+/).filter(Boolean)) {
    const kv = /^(\w+)[=:](.+)$/.exec(tok);
    const [k, v] = kv ? [kv[1].toLowerCase(), kv[2]] : [tok.toLowerCase(), null];
    if (k === 'size' && v != null && Number(v) > 0) m.size = Math.min(4, Number(v));
    else if (k === 'big') m.size = 1.5;
    else if (k === 'small') m.size = 0.7;
    else if (k === 'color' || k === 'colour') m.color = v;
    else if (k === 'accent' || k === 'dim' || k === 'fg') m.color = k;
    else if (k === 'at' && v) m.at = v;
    else if (k === 'step' && v != null && Number(v) > 0) m.step = Math.min(3, Number(v));
    else if (k === 'delay' && v != null && Number.isFinite(Number(v))) m.delay = Number(v);
    else if (k === 'motion' && v) m.motion = v;
    else if (k === 'align' && /^(left|center|centre|right)$/i.test(v ?? '')) m.align = v.toLowerCase() === 'centre' ? 'center' : v.toLowerCase();
    else if (k === 'anchor' && /^(top|middle|bottom)$/i.test(v ?? '')) m.anchor = v.toLowerCase();
    else if (k === 'max' && v != null && Number(v) > 0) m.max = Math.min(40, Number(v));
    else if (k === 'role' && v) m.role = v.toLowerCase();
    else if (k === 'fx' && v) m.fx = parseFxList(v);
    else if (FX_SET.has(k) && v == null) (m.fx ??= []).push(k);
    else if (k === 'amp' && v != null && Number.isFinite(Number(v))) m.amp = clamp(Number(v), 0, 4);
    else if (k === 'speed' && v != null && Number.isFinite(Number(v))) m.speed = clamp(Number(v), 0.1, 6);
    else if (k === 'bold' || k === 'italic' || k === 'underline' || k === 'strike') (m.st ??= {})[k[0]] = v !== '0' && v !== 'off';
    else if (/^[A-Ca-c][1-3]$/.test(k) && v == null) m.at = tok;
  }
  return m;
}

function parseWords(text) {
  const words = []; let on = false; const st = { b: false, i: false, u: false, s: false };
  const re = /\[([^\]]+)\]\{([^}]*)\}|(\S+?)\{([^}]*)\}|\S+/g;
  const push = (raw, mod) => {
    for (const w0 of raw.split(/\s+/).filter(Boolean)) {
      let tok = w0; let emph = on;
      // style tags <b> <i> <u> <s> (and __u__, ~~s~~) change the look only; ** is still the emphasis marker
      const live = { ...st }; let any = false;
      tok = tok.replace(/<(\/?)([biusBIUS])>/g, (_, c, k) => { st[k.toLowerCase()] = !c; if (!c) live[k.toLowerCase()] = true; any = true; return ''; });
      if (tok.startsWith('__') && tok.length > 2) { tok = tok.slice(2); st.u = true; live.u = true; any = true; }
      if (tok.endsWith('__') && tok.length > 2) { tok = tok.slice(0, -2); st.u = false; any = true; }
      if (tok.startsWith('~~') && tok.length > 2) { tok = tok.slice(2); st.s = true; live.s = true; any = true; }
      if (tok.endsWith('~~') && tok.length > 2) { tok = tok.slice(0, -2); st.s = false; any = true; }
      if (tok.startsWith('**')) { on = true; emph = true; tok = tok.slice(2); }
      if (tok.endsWith('**')) { tok = tok.slice(0, -2); on = false; }
      if (!tok) continue;
      const w = { t: tok, emph };
      if (mod) w.mod = mod;
      const sty = { ...live, ...(mod?.st ?? {}) };
      if (sty.b || sty.i || sty.u || sty.s) w.st = sty;
      if (tok.includes('|')) {   // syllables: col|laps~.6|ing  (~n = seconds before the next one; default mod step or 0.28)
        const parts = tok.split('|').filter(Boolean).map((p) => { const m = /^(.*?)(?:\^(\d*\.?\d+))?(?:~(\d*\.?\d+))?$/.exec(p); return { t: m[1], f: m[2] != null ? Math.min(4, Number(m[2])) : 1, d: m[3] != null ? Number(m[3]) : null }; }).filter((x) => x.t);
        if (parts.length > 1) { w.t = parts.map((x) => x.t).join(''); w.syl = parts; }
        else w.t = tok.replace(/[|]|[~^]\d*\.?\d+/g, '');
      }
      words.push(w);
    }
  };
  let m;
  while ((m = re.exec(text))) {
    if (m[1] != null) push(m[1], parseMods(m[2]));
    else if (m[3] != null) push(m[3], parseMods(m[4]));
    else push(m[0], null);
  }
  return words;
}

// ---------- placement: a 3 x 3 board (columns A B C, rows 1 2 3) ----------

const NAMED = {
  full: [0, 2, 0, 2], left: [0, 0, 0, 2], right: [2, 2, 0, 2], top: [0, 2, 0, 0], bottom: [0, 2, 2, 2], middle: [0, 2, 1, 1],
  center: [1, 1, 1, 1], centre: [1, 1, 1, 1], 'top-left': [0, 0, 0, 0], 'top-right': [2, 2, 0, 0], 'bottom-left': [0, 0, 2, 2],
  'bottom-right': [2, 2, 2, 2], 'top-center': [1, 1, 0, 0], 'top-centre': [1, 1, 0, 0], 'bottom-center': [1, 1, 2, 2], 'bottom-centre': [1, 1, 2, 2],
  'middle-left': [0, 0, 1, 1], 'middle-right': [2, 2, 1, 1], 'left-half': [0, 1, 0, 2], 'right-half': [1, 2, 0, 2],
  'top-half': [0, 2, 0, 1], 'bottom-half': [0, 2, 1, 2], 'lower-third': [0, 2, 2, 2], 'upper-third': [0, 2, 0, 0],
};
const cell = (t) => [t.charCodeAt(0) & 31, Number(t[1])].map((v, i) => v - 1) ;
/** "B2", "A1-B2", "left", "top-right" -> { c0, c1, r0, r1 } (inclusive, 0-based) or null. */
export function parseRegion(str) {
  if (str == null) return null;
  const v = String(str).trim().toLowerCase().replace(/[_\s]+/g, '-');
  const rc = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(v);   // x:y:w:h in percent of the canvas
  if (rc) return { rect: [+rc[1], +rc[2], +rc[3], +rc[4]] };
  if (NAMED[v]) { const [c0, c1, r0, r1] = NAMED[v]; return { c0, c1, r0, r1 }; }
  const m = /^([abc][1-3])(?:-([abc][1-3]))?$/.exec(v);
  if (!m) return null;
  const a = cell(m[1]); const b = m[2] ? cell(m[2]) : a;
  return { c0: Math.min(a[0], b[0]), c1: Math.max(a[0], b[0]), r0: Math.min(a[1], b[1]), r1: Math.max(a[1], b[1]) };
}
function regionBox(rg, safe, full) {
  if (rg.rect && full) {
    const [px, py, pw, ph] = rg.rect;
    return { x: (px / 100) * full.W, y: (py / 100) * full.H, w: Math.max(8, (pw / 100) * full.W), h: Math.max(8, (ph / 100) * full.H), align: 'center', anchorY: 'middle' };
  }
  if (rg.rect) return regionBox({ c0: 0, c1: 2, r0: 0, r1: 2 }, safe);
  const cw = safe.w / 3; const rh = safe.h / 3;
  const box = { x: safe.x + rg.c0 * cw, y: safe.y + rg.r0 * rh, w: (rg.c1 - rg.c0 + 1) * cw, h: (rg.r1 - rg.r0 + 1) * rh };
  box.align = rg.c0 === rg.c1 && rg.c0 === 0 ? 'left' : rg.c0 === rg.c1 && rg.c0 === 2 ? 'right' : 'center';
  box.anchorY = rg.r0 === rg.r1 && rg.r0 === 0 ? 'top' : rg.r0 === rg.r1 && rg.r0 === 2 ? 'bottom' : 'middle';
  return box;
}

export function parseScript(text) {
  const options = {}; const scenes = []; let cur = null;
  const flush = () => { if (cur && (cur.lines.length || cur.dir.dur != null)) scenes.push(cur); cur = null; };
  const open = () => { cur ??= { lines: [], dir: {}, dirIdx: {}, src: [], t: null }; return cur; };
  let ln = -1;
  // Scene separators: a blank line or --- always starts a new scene. A line holding just +++ cancels the blank line
  // next to it, so a long stanza can have spacing and still be one scene.
  let pendingBreak = false; let keepGoing = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    ln++;
    const line = rawLine.trim();
    if (!line) { if (!keepGoing) pendingBreak = true; continue; }
    if (/^\+{3,}$/.test(line)) { pendingBreak = false; keepGoing = true; continue; }
    if (/^-{3,}$/.test(line)) { flush(); pendingBreak = false; keepGoing = false; continue; }
    if (pendingBreak) flush();
    pendingBreak = false; keepGoing = false;
    let m;
    if ((m = /^@(\w+)\s+(.*)$/.exec(line))) { options[m[1]] = m[2].trim(); continue; }
    if ((m = /^::(\w+)\s*(.*)$/.exec(line))) { const o = open(); o.dir[m[1]] = m[2].trim(); o.dirIdx[m[1]] = ln; o.src.push(ln); continue; }
    // One grammar for every line:  [time] marker text {mods}   (marker and time may come in either order)
    //   time   [0:12.5]  [0:12.5-0:15]        marker  #  ##  -  1.  >  --
    let t = null; let t1 = null; let body = line; let role = null;
    const takeTime = () => { if (t == null && (m = TIME_TAG.exec(body))) { t = tsec(m[1], m[2], m[3]); if (m[4] != null) t1 = tsec(m[4], m[5], m[6]); body = body.slice(m[0].length); return true; } return false; };
    const takeMarker = () => {
      if (role) return false;
      if ((m = /^(#{1,2})\s+(.*)$/.exec(body))) { role = m[1].length === 1 ? 'title' : 'sub'; body = m[2]; return true; }
      if ((m = /^[-*•]\s+(.*)$/.exec(body))) { role = 'bullet'; body = m[1]; return true; }
      if ((m = /^\d+[.)]\s+(.*)$/.exec(body))) { role = 'bullet'; body = m[1]; return true; }
      if ((m = /^>\s*(.*)$/.exec(body))) { role = 'quote'; body = m[1]; return true; }
      if ((m = /^--\s*(.*)$/.exec(body))) { role = 'cite'; body = m[1]; return true; }
      return false;
    };
    for (let guard = 0; guard < 3; guard++) if (!takeTime() && !takeMarker()) break;
    // A "# Title" starts a new scene in an untimed outline. Timed lines never split a scene by themselves:
    // use a blank line or --- for that, so a heading can sit among timestamped lyrics without cutting them in two.
    if (role === 'title' && cur?.lines.length && t == null && cur.lines.every((l) => l.tag == null)) flush();
    let lineMod = null;
    const lm = /\s+\{([^}]*)\}\s*$/.exec(body);
    if (lm) { lineMod = parseMods(lm[1]); body = body.slice(0, lm.index); }
    const sc = open();
    const words = parseWords(body);
    if (!words.length) continue;
    if (t != null && sc.t == null && !sc.lines.length) sc.t = t;
    sc.src.push(ln);
    if (lineMod?.color) for (const w of words) w.mod = { color: lineMod.color, ...(w.mod ?? {}) };
    if (lineMod?.role && ROLE_SCALE[lineMod.role]) role = lineMod.role;
    sc.lines.push({ words, role, t: t != null && sc.lines.length ? t : null, t1, idx: ln, tag: t, tag1: t1, ...(lineMod?.at ? { at: lineMod.at } : {}), ...(lineMod && Object.keys(lineMod).length ? { mod: lineMod } : {}) });
  }
  flush();
  return { options, scenes };
}

/** Fill in roles and emphasis that the author did not specify. Pure. */
export function annotate(script) {
  const freq = new Map();
  const seen = new Map();
  for (const sc of script.scenes) for (const ln of sc.lines) {
    const key = ln.words.map((w) => norm(w.t)).join(' ');
    seen.set(key, (seen.get(key) ?? 0) + 1);
    for (const w of ln.words) { const n = norm(w.t); if (n) freq.set(n, (freq.get(n) ?? 0) + 1); }
  }
  for (const sc of script.scenes) {
    const n = sc.lines.length;
    sc.lines.forEach((ln, i) => {
      const nw = ln.words.length; const txt = ln.words.map((w) => w.t).join(' ');
      if (!ln.role) {
        if (/^\(.*\)$/.test(txt)) ln.role = 'whisper';
        else if (nw <= 3 && /[0-9]/.test(txt) && /^[\s\p{Sc}0-9.,%+\-x×/a-zA-Z]*$/u.test(txt) && /[0-9]/.test(txt.split(/\s+/)[0])) ln.role = 'stat';
        else if (n === 1 && nw <= 5) ln.role = 'hook';
        else if (seen.get(ln.words.map((w) => norm(w.t)).join(' ')) > 1) ln.role = 'hook';
        else if (i === 0 && n > 1 && nw <= 4 && sc.lines.slice(1).some((o) => o.words.length > nw)) ln.role = 'head';
        else ln.role = 'body';
      }
      ln.explicit = ln.words.some((w) => w.emph);
      if (!ln.explicit && ln.role !== 'cite' && ln.role !== 'whisper' && sc.dir.emph !== 'none') {
        let best = -1; let bs = 0;
        ln.words.forEach((w, k) => {
          const x = norm(w.t); if (!x || STOP.has(x)) return;
          let s = 0.2 + Math.min(x.length, 10) / 10;
          if (freq.get(x) === 1) s += 0.6;
          if (/^[\p{Lu}]{2,}$/u.test(w.t)) s += 1.6;
          if (/[0-9]/.test(w.t)) s += 1.4;
          if (k === nw - 1) s += 0.25;
          if (s > bs) { bs = s; best = k; }
        });
        if (best >= 0 && bs >= 1.2 && nw > 1) ln.words[best].emph = true;
      }
    });
  }
  return script;
}

// ---------- timing ----------

export function readingTime(words, energy = 0.5) {
  return clamp((1.1 + words / 2.9) / (0.75 + 0.5 * energy), 1.8, 11);
}

function planTiming(script, energy, total) {
  const sc = script.scenes;
  let anyExplicit = false;
  const exEnd = sc.map((s) => { const v = s.lines.map((l) => l.t1).filter((x) => x != null); return v.length ? Math.max(...v) : null; });
  const dur = sc.map((s) => {
    const nw = s.lines.reduce((a, l) => a + l.words.length, 0);
    if (s.dir.dur != null && Number.isFinite(Number(s.dir.dur))) return Number(s.dir.dur);
    return readingTime(nw, energy);
  });
  const start = new Array(sc.length).fill(null);
  sc.forEach((s, i) => { if (s.t != null) { start[i] = s.t; anyExplicit = true; } });
  if (total && !anyExplicit) {
    const sum = dur.reduce((a, b) => a + b, 0);
    const k = total / sum;
    for (let i = 0; i < dur.length; i++) if (sc[i].dir.dur == null) dur[i] *= k;
  }
  const endX = new Array(sc.length).fill(false);
  let t = 0;
  for (let i = 0; i < sc.length; i++) {
    if (start[i] == null) start[i] = t;
    // the next scene that was given a time, wherever it sits in the text
    let nextStart = null;
    for (let j = 0; j < sc.length; j++) if (j !== i && sc[j].t != null && sc[j].t > start[i] + 1e-6 && (nextStart == null || sc[j].t < nextStart)) nextStart = sc[j].t;
    if (sc[i].dir.dur == null) {
      if (exEnd[i] != null) { dur[i] = Math.max(0.3, exEnd[i] - start[i]); endX[i] = true; }
      else if (nextStart != null) dur[i] = Math.max(0.5, nextStart - start[i]);
    }
    t = start[i] + dur[i];
  }
  return { start, dur, endX };
}

// ---------- layout ----------

const ROLE_SCALE = { title: 1, head: 0.8, sub: 0.6, hook: 0.95, stat: 1.5, body: 0.55, bullet: 0.5, quote: 0.62, cite: 0.38, whisper: 0.4 };
const HEAD_ROLES = new Set(['title', 'head', 'hook', 'stat', 'sub']);
const lineGap = 1.12;

function Ctx(c, packName, fonts) {
  const P = PACKS[packName];
  const m100 = new Map();
  const font = (role) => (HEAD_ROLES.has(role) ? fonts.head : fonts.body);
  const weight = (role) => (HEAD_ROLES.has(role) ? P.headWeight : P.bodyWeight);
  const text = (role, s) => (P.caps && HEAD_ROLES.has(role) ? s.toUpperCase() : s);
  const wt = (role, st) => (st?.b ? Math.max(weight(role), 800) : weight(role));
  const w100 = (s, role, st) => { const f = font(role); const w = wt(role, st); const k = `${f}|${w}|${st?.i ? 'i' : ''}|${s}`; let v = m100.get(k); if (v == null) { v = c.measure(s, f, w, 100, !!st?.i); m100.set(k, v); } return v; };
  return { P, font, weight: wt, text, width: (s, role, px, st) => (w100(s, role, st) * px) / 100 };
}

/** Break words into rows no wider than maxW, minimising uneven row lengths (dynamic programming). */
export function balanceRows(widths, space, maxW) {
  const n = widths.length;
  if (!n) return [];
  const best = new Array(n + 1).fill(Infinity); const prev = new Array(n + 1).fill(0);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    let w = -space;
    for (let i = j; i >= 1; i--) {
      w += widths[i - 1] + space;
      if (w > maxW && i < j) break;
      const slack = Math.max(0, maxW - w);
      const cost = (j === n ? 0 : slack * slack) + (w > maxW ? 1e9 : 0) + best[i - 1];
      if (cost < best[j]) { best[j] = cost; prev[j] = i - 1; }
    }
  }
  const rows = []; let j = n;
  while (j > 0) { const i = prev[j]; rows.unshift([i, j]); j = i; }
  return rows;
}

/** Lay lines out as a block at font size `S` (px for a role scale of 1). Returns rows with positions relative to (0,0)=top-left. */
function blockAt(cx, lines, S, maxW, align) {
  const rows = []; let y = 0; let w = 0;
  lines.forEach((ln, li) => {
    const px = S * ROLE_SCALE[ln.role] * (ln.mod?.size ?? 1);
    const words = ln.words.map((x) => cx.text(ln.role, x.t));
    const fs = ln.words.map((x) => x.mod?.size ?? 1);
    const widths = words.map((t, k) => cx.width(t, ln.role, px * fs[k], ln.words[k].st));
    const space = cx.width(' ', ln.role, px) || px * 0.28;
    const brk = balanceRows(widths, space, maxW);
    if (li > 0) y += px * (ln.role === 'bullet' && lines[li - 1].role === 'bullet' ? 0.18 : 0.32);
    for (const [a, b] of brk) {
      let rw = 0; let fm = 1; for (let k = a; k < b; k++) { rw += widths[k] + (k > a ? space : 0); fm = Math.max(fm, fs[k]); }
      rows.push({ li, a, b, px, fs, widths, space, rw, y: y + px * fm * 0.5 * lineGap, words });
      y += px * fm * lineGap; w = Math.max(w, rw);
    }
  });
  return { rows, h: y, w, align };
}

function fitBlock(cx, lines, box, align, scale = 1) {
  let lo = 8; let hi = Math.min(box.h * 0.9, box.cap ?? Infinity); let best = null;
  for (let it = 0; it < 16; it++) {
    const mid = (lo + hi) / 2;
    const b = blockAt(cx, lines, mid, box.w, align);
    if (b.h <= box.h && b.w <= box.w * 1.001) { best = { b, S: mid }; lo = mid; } else hi = mid;
  }
  if (!best) { const b = blockAt(cx, lines, lo, box.w, align); best = { b, S: lo }; }
  if (scale !== 1) { const S = best.S * scale; return { b: blockAt(cx, lines, S, box.w, align), S }; }
  return best;
}

/** Turn a laid-out block into runs placed in `box`. */
function placeBlock(cx, lines, b, box, { align = 'center', anchorY = 'middle', shift = null, rot = 0 } = {}) {
  const runs = [];
  const y0 = anchorY === 'top' ? box.y : anchorY === 'bottom' ? box.y + box.h - b.h : box.y + (box.h - b.h) / 2;
  b.rows.forEach((row, ri) => {
    const ln = lines[row.li];
    let x = align === 'left' ? box.x : align === 'right' ? box.x + box.w - row.rw : box.x + (box.w - row.rw) / 2;
    const off = shift ? shift(ri, b.rows.length) : { dx: 0, dy: 0 };
    for (let k = row.a; k < row.b; k++) {
      const w = row.widths[k];
      runs.push({ text: row.words[k], role: ln.role, li: row.li, wi: k, emph: ln.words[k].emph, size: row.px * (row.fs?.[k] ?? 1), mod: ln.words[k].mod, syl: ln.words[k].syl, st: ln.words[k].st,
        x: x + w / 2 + off.dx, y: y0 + row.y + off.dy, w, rot });
      x += w + row.space;
    }
  });
  return runs;
}

const sceneLines = (sc) => sc.lines;
const countWords = (sc) => sc.lines.reduce((a, l) => a + l.words.length, 0);

function layoutCenter(cx, sc, box, align = 'center') {
  const { b } = fitBlock(cx, sceneLines(sc), box, align);
  return { runs: placeBlock(cx, sceneLines(sc), b, box, { align }) };
}

function layoutLeft(cx, sc, box, W, H) {
  const bx = { x: box.x + W * 0.035, y: box.y, w: box.w * 0.78, h: box.h, cap: box.cap };
  const { b } = fitBlock(cx, sceneLines(sc), bx, 'left');
  const runs = placeBlock(cx, sceneLines(sc), b, bx, { align: 'left' });
  const top = Math.min(...runs.map((r) => r.y - r.size * 0.55)); const bot = Math.max(...runs.map((r) => r.y + r.size * 0.55));
  return { runs, decor: [{ k: 'rect', x: box.x - W * 0.005, y: top, w: Math.max(6, W * 0.008), h: bot - top, c: 'accent', bar: true }] };
}

function layoutDiagonal(cx, sc, box) {
  const { b } = fitBlock(cx, sceneLines(sc), { ...box, w: box.w * 0.78 }, 'center');
  const span = box.w * 0.2;
  const runs = placeBlock(cx, sceneLines(sc), b, box, { align: 'center', rot: -0.045, shift: (i, n) => ({ dx: (n > 1 ? i / (n - 1) - 0.5 : 0) * span * 2, dy: 0 }) });
  return { runs };
}

function layoutList(cx, sc, box, W, H) {
  const bx = { x: box.x + W * 0.05, y: box.y, w: box.w - W * 0.05, h: box.h };
  const { b } = fitBlock(cx, sceneLines(sc), bx, 'left', 0.92);
  const runs = placeBlock(cx, sceneLines(sc), b, bx, { align: 'left', anchorY: 'middle' });
  const decor = [];
  b.rows.forEach((row) => {
    const ln = sc.lines[row.li];
    if (ln.role === 'bullet' && row.a === 0) {
      const d = row.px * 0.34;
      decor.push({ k: 'rect', x: bx.x - W * 0.05 + d * 0.2, y: runs.find((r) => r.li === row.li && r.wi === 0).y - d / 2, w: d, h: d, c: 'accent', li: row.li, rot: 0.785 });
    }
  });
  return { runs, decor };
}

function layoutQuote(cx, sc, box, W, H) {
  const q = H * 0.2; const gap = q * 0.7;
  const bx = { x: box.x + W * 0.05, y: box.y + gap, w: box.w - W * 0.1, h: box.h - gap };
  const { b } = fitBlock(cx, sceneLines(sc), bx, 'center', 0.9);
  const runs = placeBlock(cx, sceneLines(sc), b, bx, { align: 'center' });
  const top = Math.min(...runs.map((r) => r.y - r.size * 0.5));
  runs.unshift({ text: '\u201C', role: 'title', li: -1, wi: 0, emph: false, size: q, x: box.x + box.w / 2, y: Math.max(box.y + q * 0.55, top - q * 0.2), w: q * 0.5, rot: 0, color: 'accent', alpha: 0.9, deco: true });
  return { runs };
}

function layoutStack(cx, sc, box) {
  const tokens = [];
  sc.lines.forEach((ln, li) => ln.words.forEach((w, wi) => tokens.push({ text: cx.text('title', w.t), li, wi, emph: w.emph, role: ln.role })));
  // merge tiny words into their neighbours so every row is a readable chunk
  const rows = [];
  for (const t of tokens) {
    const last = rows.at(-1);
    if (last && (last.chars < 4 || t.text.length <= 2) && last.toks.length < 3 && last.li === t.li) { last.toks.push(t); last.chars += t.text.length + 1; }
    else rows.push({ toks: [t], chars: t.text.length, li: t.li });
  }
  const rowText = (r) => r.toks.map((t) => t.text).join(' ');
  const sizes = rows.map((r) => Math.min(box.w / Math.max(0.01, cx.width(rowText(r), 'title', 100) / 100), box.h * 0.45));
  let total = sizes.reduce((s, px) => s + px * lineGap * 0.92, 0);
  const k = total > box.h ? box.h / total : 1;
  total *= k;
  let y = box.y + (box.h - total) / 2;
  const runs = [];
  rows.forEach((r, i) => {
    const px = sizes[i] * k; const wTot = cx.width(rowText(r), 'title', px);
    const space = cx.width(' ', 'title', px) || px * 0.28;
    let x = box.x + (box.w - wTot) / 2;
    const cy = y + (px * lineGap * 0.92) / 2;
    for (const t of r.toks) {
      const w = cx.width(t.text, 'title', px);
      runs.push({ text: t.text, role: t.role === 'body' ? 'hook' : t.role, li: t.li, wi: t.wi, emph: t.emph, size: px, x: x + w / 2, y: cy, w, rot: 0 });
      x += w + space;
    }
    y += px * lineGap * 0.92;
  });
  return { runs, stack: true };
}

function layoutBigword(cx, sc, box, W, H) {
  let big = null;
  sc.lines.forEach((ln, li) => ln.words.forEach((w, wi) => { if (w.emph && !big) big = { li, wi, w }; }));
  if (!big) return null;
  const bigText = cx.text('title', big.w.t);
  const bw = cx.width(bigText, 'title', 100) / 100;
  const px = Math.min((box.w * 0.92) / Math.max(0.01, bw), box.h * 0.5);
  const runs = [{ text: bigText, role: 'title', li: big.li, wi: big.wi, emph: true, size: px, x: box.x + box.w / 2, y: box.y + box.h * 0.4, w: bw * px, rot: 0 }];
  const rest = { lines: sc.lines.map((ln, li) => ({ ...ln, words: ln.words.map((w, wi) => (li === big.li && wi === big.wi ? null : w)).filter(Boolean) })).filter((l) => l.words.length) };
  const map = []; sc.lines.forEach((ln, li) => { if (ln.words.some((w, wi) => !(li === big.li && wi === big.wi))) map.push(li); });
  if (rest.lines.length) {
    const cap = { x: box.x + box.w * 0.12, y: box.y + box.h * 0.66, w: box.w * 0.76, h: box.h * 0.34 };
    const lines = rest.lines.map((l) => ({ ...l, role: l.role === 'title' ? 'head' : l.role }));
    const { b } = fitBlock(cx, lines, cap, 'center', 0.8);
    const rr = placeBlock(cx, lines, b, cap, { align: 'center', anchorY: 'top' });
    for (const r of rr) {
      const orig = sc.lines[map[r.li]];
      let seen = -1; let wi = -1;
      for (let k = 0; k < orig.words.length; k++) { if (!(map[r.li] === big.li && k === big.wi)) seen++; if (seen === r.wi) { wi = k; break; } }
      r.li = map[r.li]; r.wi = wi; runs.push(r);
    }
  }
  return { runs, bigword: true };
}

function layoutSplit(cx, sc, box, W, H) {
  if (sc.lines.length < 2) return null;
  const left = { x: box.x, y: box.y, w: box.w * 0.43, h: box.h };
  const right = { x: box.x + box.w * 0.54, y: box.y, w: box.w * 0.46, h: box.h };
  const headLines = [{ ...sc.lines[0], role: sc.lines[0].role === 'body' ? 'title' : sc.lines[0].role }];
  const hb = fitBlock(cx, headLines, left, 'left');
  const rr = placeBlock(cx, headLines, hb.b, left, { align: 'left' });
  const rest = sc.lines.slice(1);
  const rb = fitBlock(cx, rest, right, 'left', 0.85);
  const rb2 = placeBlock(cx, rest, rb.b, right, { align: 'left' });
  for (const r of rb2) r.li += 1;
  const dx = box.x + box.w * 0.485;
  return { runs: [...rr, ...rb2], decor: [{ k: 'rect', x: dx - 3, y: box.y + box.h * 0.12, w: 6, h: box.h * 0.76, c: 'accent', grow: 'y', bar: true }] };
}

function layoutStat(cx, sc, box, W, H) {
  const idx = sc.lines.findIndex((l) => l.role === 'stat');
  if (idx < 0) return null;
  const st = sc.lines[idx]; const txt = cx.text('stat', st.words.map((w) => w.t).join(' '));
  const bw = cx.width(txt, 'stat', 100) / 100;
  const px = Math.min((box.w * 0.8) / Math.max(0.01, bw), box.h * 0.6);
  const runs = [{ text: txt, role: 'stat', li: idx, wi: 0, emph: true, size: px, x: box.x + box.w / 2, y: box.y + box.h * 0.4, w: bw * px, rot: 0, whole: true }];
  const others = sc.lines.map((l, i) => ({ l, i })).filter((o) => o.i !== idx);
  if (others.length) {
    const lines = others.map((o) => ({ ...o.l, role: o.l.role === 'stat' ? 'body' : o.l.role }));
    const cap = { x: box.x + box.w * 0.1, y: box.y + box.h * 0.68, w: box.w * 0.8, h: box.h * 0.32 };
    const { b } = fitBlock(cx, lines, cap, 'center', 0.8);
    for (const r of placeBlock(cx, lines, b, cap, { align: 'center', anchorY: 'top' })) { r.li = others[r.li].i; runs.push(r); }
  }
  return { runs, stat: true };
}

const LAYOUTS = {
  center: (cx, sc, box) => layoutCenter(cx, sc, box),
  left: layoutLeft, stack: layoutStack, bigword: layoutBigword, diagonal: layoutDiagonal, split: layoutSplit, list: layoutList, quote: layoutQuote, stat: layoutStat,
};

function eligible(name, sc) {
  const nw = countWords(sc); const nl = sc.lines.length;
  const roles = sc.lines.map((l) => l.role);
  const hasEmph = sc.lines.some((l) => l.words.some((w) => w.emph));
  switch (name) {
    case 'stack': return nw >= 2 && nw <= 9 && nl <= 4 && !roles.includes('bullet');
    case 'bigword': return hasEmph && nw >= 2 && nw <= 12;
    case 'diagonal': return nl >= 2 && nl <= 5 && nw <= 24;
    case 'split': return nl >= 2 && nl <= 5 && (roles[0] === 'title' || roles[0] === 'head' || roles[0] === 'hook' || nl >= 3);
    case 'list': return roles.includes('bullet');
    case 'quote': return roles.includes('quote');
    case 'stat': return roles.includes('stat');
    default: return true;
  }
}

function chooseLayout(sc, P, energy, prev, seed, i, allow) {
  if (sc.dir.layout && LAYOUTS[sc.dir.layout]) return sc.dir.layout;
  const roles = sc.lines.map((l) => l.role);
  const loud = new Set(['stack', 'bigword', 'diagonal']);
  const entries = LAYOUT_IDS.filter((n) => eligible(n, sc) && (!allow || allow.includes(n))).map((n) => {
    let w = P.layouts[n] ?? 1;
    if (loud.has(n)) w *= 0.6 + 0.9 * energy; else if (n === 'center' || n === 'left' || n === 'quote') w *= 1.35 - 0.7 * energy;
    if (n === 'stat' && roles.includes('stat')) w *= 8;
    if (n === 'quote' && roles.includes('quote')) w *= 8;
    if (n === 'list' && roles.includes('bullet')) w *= 8;
    if (prev[0] === n) w *= 0.12; else if (prev[1] === n) w *= 0.5;
    w *= 0.8 + 0.4 * rnd(seed, 'lay', i, n);
    return [n, w];
  });
  if (!entries.length) return 'center';
  return pickWeighted(entries, rnd(seed, 'pick', i));
}

// ---------- compile ----------

function planPalette(P, sc, i, seed, prevIdx, ov = {}) {
  let idx;
  if (sc.dir.pal != null && Number.isFinite(Number(sc.dir.pal))) idx = (Number(sc.dir.pal) - 1 + P.palettes.length * 10) % P.palettes.length;
  else { idx = Math.floor(rnd(seed, 'pal', i) * P.palettes.length); if (idx === prevIdx && P.palettes.length > 1) idx = (idx + 1) % P.palettes.length; }
  const base = P.palettes[idx];
  let bg = hexToRgb(base.bg); let bg2 = hexToRgb(base.bg2);
  if (ov.bgMode === 'solid' && ov.bgColor) { bg = hexToRgb(ov.bgColor); bg2 = mixc(bg, luminance(bg) > 0.4 ? [0, 0, 0] : [255, 255, 255], 0.12); }
  if (sc.dir.bg && /^#[0-9a-f]{3,6}$/i.test(sc.dir.bg)) { bg = hexToRgb(sc.dir.bg); bg2 = mixc(bg, luminance(bg) > 0.4 ? [0, 0, 0] : [255, 255, 255], 0.12); }
  const none = ov.bgMode === 'none';
  const ref = none ? [24, 24, 28] : bg;
  let fg = none ? [255, 255, 255] : ensureContrast(hexToRgb(base.fg), bg, 4.5);
  let accent = ensureContrast(hexToRgb(base.accent), ref, 3);
  if (ov.fg && /^#[0-9a-f]{3,6}$/i.test(ov.fg)) fg = hexToRgb(ov.fg);
  if (ov.accent && /^#[0-9a-f]{3,6}$/i.test(ov.accent)) accent = hexToRgb(ov.accent);
  return { idx, bg, bg2, fg, accent, onAccent: readable(accent) };
}

const IN_FOR = { spin: 'spin', stretch: 'stretch', swing: 'swing', bounce: 'bounce', pop: 'pop', drop: 'drop', slideL: 'slideL', slideR: 'slideR', zoom: 'zoom', flip: 'flip', rise: 'rise', fade: 'fade', tilt: 'tilt', type: 'type' };

/**
 * Lay out and time every scene. ctx: { W, H, measure, total?, fonts? }.
 * The result depends only on the script text and ctx (never on time or randomness).
 */
/** Shapes around the text block. `spec` = "bar+underline color=#ff0 w=2" (names from DECO_NAMES, or none). */
function makeDeco(spec, runs, W, H) {
  const toks = spec.toLowerCase().split(/[\s,+]+/).filter(Boolean);
  const names = toks.filter((x) => DECO_SET.has(x)); if (!names.length || !runs.length) return [];
  const kv = (k) => { const m = new RegExp(`(?:^|[\\s,])${k}[=:]([^\\s,]+)`, 'i').exec(spec); return m ? m[1] : null; };
  const c = kv('colou?r') ?? 'accent'; const wm = clamp(Number(kv('w') ?? kv('width') ?? 1) || 1, 0.3, 6);
  const x0 = Math.min(...runs.map((r) => r.x - r.w / 2)); const x1 = Math.max(...runs.map((r) => r.x + r.w / 2));
  const y0 = Math.min(...runs.map((r) => r.y - r.size * 0.55)); const y1 = Math.max(...runs.map((r) => r.y + r.size * 0.55));
  const avg = runs.reduce((a, r) => a + r.size, 0) / runs.length; const pad = Math.max(8, avg * 0.35); const th = Math.max(3, H * 0.006 * wm);
  const out = []; const R = (x, y, w, h, extra = {}) => out.push({ k: 'rect', x, y, w, h, c, ...extra });
  const bw = x1 - x0; const bh = y1 - y0;
  for (const n of new Set(names)) {
    if (n === 'bar' || n === 'bars') R(x0 - pad - th, y0, th, bh, { grow: 'y' });
    if (n === 'bar-right' || n === 'bars') R(x1 + pad, y0, th, bh, { grow: 'y' });
    if (n === 'underline') R(x0, y1 + pad * 0.5, bw, th);
    if (n === 'overline' || n === 'rules') R(x0, y0 - pad * 0.5 - th, bw, th);
    if (n === 'rules') R(x0, y1 + pad * 0.5, bw, th);
    if (n === 'box') { const X = x0 - pad; const Y = y0 - pad; const w = bw + pad * 2; const h = bh + pad * 2; R(X, Y, w, th); R(X, Y + h - th, w, th); R(X, Y, th, h, { grow: 'y' }); R(X + w - th, Y, th, h, { grow: 'y' }); }
    if (n === 'brackets') {
      const X = x0 - pad; const Y = y0 - pad; const w = bw + pad * 2; const h = bh + pad * 2; const L = Math.min(w, h) * 0.22;
      R(X, Y, L, th); R(X, Y, th, L, { grow: 'y' }); R(X + w - L, Y, L, th); R(X + w - th, Y, th, L, { grow: 'y' });
      R(X, Y + h - th, L, th); R(X, Y + h - L, th, L, { grow: 'y' }); R(X + w - L, Y + h - th, L, th); R(X + w - th, Y + h - L, th, L, { grow: 'y' });
    }
    if (n === 'panel') R(x0 - pad * 1.4, y0 - pad, bw + pad * 2.8, bh + pad * 2, { a: 0.3 });
    if (n === 'highlight') R(x0 - pad * 0.4, y0 + bh * 0.52, bw + pad * 0.8, bh * 0.42, { a: 0.45 });
    if (n === 'diamonds') { const d = th * 3; for (let k = -1; k <= 1; k++) R((x0 + x1) / 2 + k * d * 2.6 - d / 2, y1 + pad * 0.7, d, d, { rot: 0.785 }); }
  }
  return out;
}

export function compileScript(script, ctx) {
  annotate(script);
  const { W, H } = ctx;
  const opts = script.options;
  const packName = PACKS[ctx.pack ?? opts.pack] ? (ctx.pack ?? opts.pack) : 'punchy';
  const P = PACKS[packName];
  const energy = clamp(Number(ctx.energy ?? opts.energy ?? 0.6), 0, 1);
  const seed = Number(ctx.seed ?? opts.seed ?? 1);
  const fonts = { head: ctx.fontHead || opts.font || P.head, body: ctx.fontBody || (opts.font && !ctx.fontHead ? opts.font : P.body) };
  const cx = Ctx(ctx, packName, fonts);
  const { start, dur, endX } = planTiming(script, energy, ctx.total);
  const mx = W * 0.075; const my = H * 0.09;
  let box = { x: mx, y: my, w: W - 2 * mx, h: H - 2 * my };
  const place = ctx.place ?? opts.place ?? 'full';
  if (place === 'lower') box = { x: mx, y: H * 0.6, w: W - 2 * mx, h: H * 0.34 };
  else if (place === 'upper') box = { x: mx, y: H * 0.06, w: W - 2 * mx, h: H * 0.34 };
  else if (place === 'middle') box = { x: mx, y: H * 0.3, w: W - 2 * mx, h: H * 0.4 };
  if (place !== 'full') box.cap = H * 0.14;
  const allow = (ctx.layoutSet ?? opts.layouts) === 'calm' ? ['center', 'left', 'diagonal'] : null;
  const bgMode = ['scenes', 'solid', 'none'].includes(ctx.bgMode) ? ctx.bgMode : 'scenes';
  const revealDef = ['auto', 'word', 'line'].includes(ctx.reveal) ? ctx.reveal : 'auto';
  const ov = { bgMode, bgColor: ctx.bgColor, fg: ctx.fg, accent: ctx.accent };

  const scenes = []; let prevLay = []; let prevPal = -1;
  script.scenes.forEach((sc, i) => {
    const styleName = sc.dir.style && PACKS[sc.dir.style] ? sc.dir.style : packName;
    const SP = PACKS[styleName];
    const scx = styleName === packName ? cx : Ctx(ctx, styleName, { head: SP.head, body: SP.body });
    // placement: scene-level region (::at / @at), plus lines / words that carry their own {at=..}
    const sceneRg = parseRegion(sc.dir.at ?? (sc.dir.at === undefined ? opts.at : null));
    let sbox = box; let salign = sc.dir.align ?? null;
    if (sceneRg) { sbox = regionBox(sceneRg, box, { W, H }); sbox.cap = H * 0.22; salign ??= sbox.align; }
    const mainLines = []; const map = [];
    sc.lines.forEach((ln, li) => {
      if (ln.at && parseRegion(ln.at)) return;
      const ws = ln.words.filter((w) => !(w.mod?.at && parseRegion(w.mod.at)));
      if (!ws.length) return;
      mainLines.push(ws.length === ln.words.length ? ln : { ...ln, words: ws }); map.push(li);
    });
    const proxy = { ...sc, lines: mainLines };
    const layoutName = mainLines.length ? chooseLayout(proxy, SP, energy, prevLay, seed, i, sceneRg && !sc.dir.layout ? ['center', 'left'] : allow) : 'center';
    prevLay = [layoutName, prevLay[0]];
    let lay = { runs: [] }; let used = layoutName;
    if (mainLines.length) {
      lay = sceneRg && !sc.dir.layout ? layoutCenter(scx, proxy, sbox, salign ?? 'center') : LAYOUTS[layoutName](scx, proxy, sbox, W, H);
      if (!lay) { lay = layoutCenter(scx, proxy, sbox, salign ?? 'center'); used = 'center'; }
      if (sbox.anchorY && sceneRg && lay.runs.length) {
        const ys = lay.runs.filter((r) => !r.deco); const yt = Math.min(...ys.map((r) => r.y - r.size * 0.55)); const yb = Math.max(...ys.map((r) => r.y + r.size * 0.55));
        const d = sbox.anchorY === 'top' ? sbox.y - yt : sbox.anchorY === 'bottom' ? sbox.y + sbox.h - yb : 0;
        if (d) for (const r of lay.runs) r.y += d;
      }
      for (const r of lay.runs) if (r.li >= 0) r.li = map[r.li] ?? r.li;
      for (const dc of lay.decor ?? []) if (dc.li != null) dc.li = map[dc.li] ?? dc.li;
    }
    // keep everything inside the safe box
    const rs = lay.runs.filter((r) => !r.deco);
    if (rs.length) {
      const x0 = Math.min(...rs.map((r) => r.x - r.w / 2)); const x1 = Math.max(...rs.map((r) => r.x + r.w / 2));
      const y0 = Math.min(...rs.map((r) => r.y - r.size * 0.55)); const y1 = Math.max(...rs.map((r) => r.y + r.size * 0.55));
      const k = Math.min(1, sbox.w / Math.max(1, x1 - x0), sbox.h / Math.max(1, y1 - y0));
      if (k < 0.999) { const ox = (x0 + x1) / 2; const oy = (y0 + y1) / 2; for (const r of lay.runs) { r.x = ox + (r.x - ox) * k; r.y = oy + (r.y - oy) * k; r.size *= k; r.w *= k; } }
    }
    const pal = planPalette(SP, sc, i, seed, prevPal, ov); prevPal = pal.idx;
    // lines and words with their own spot
    // lines sharing the same {at=..} are one block (so a text box with several paragraphs stays together)
    const groups = new Map();
    sc.lines.forEach((ln, li) => { if (ln.at && parseRegion(ln.at)) { if (!groups.has(ln.at)) groups.set(ln.at, []); groups.get(ln.at).push(li); } });
    for (const [at, lis] of groups) {
      const b = regionBox(parseRegion(at), box, { W, H }); const m0 = sc.lines[lis[0]].mod ?? {};
      if (m0.align) b.align = m0.align; if (m0.anchor) b.anchorY = m0.anchor;
      b.cap = m0.max ? (H * m0.max) / 100 : H * 0.2;
      const kept = lis.filter((li) => sc.lines[li].words.some((w) => !(w.mod?.at && parseRegion(w.mod.at))));
      const ls = kept.map((li) => ({ ...sc.lines[li], words: sc.lines[li].words.filter((w) => !(w.mod?.at && parseRegion(w.mod.at))) }));
      if (!ls.length) continue;
      const { b: blk } = fitBlock(scx, ls, b, b.align);
      for (const r of placeBlock(scx, ls, blk, b, { align: b.align, anchorY: b.anchorY })) lay.runs.push({ ...r, li: kept[r.li] });
    }
    sc.lines.forEach((ln, li) => {
      const lrg = ln.at ? parseRegion(ln.at) : null;
      ln.words.forEach((w, wi) => {
        const wrg = w.mod?.at ? parseRegion(w.mod.at) : null;
        if (!wrg || lrg) return;
        const b = regionBox(wrg, box, { W, H });
        const ref = lay.runs.find((r) => r.li === li);
        const size = (ref ? ref.size / (ref.mod?.size ?? 1) : Math.min(b.h * 0.5, H * 0.12)) * (w.mod.size ?? 1);
        const text = scx.text(ln.role, w.t); const wd = scx.width(text, ln.role, size);
        const x = b.align === 'left' ? b.x + wd / 2 : b.align === 'right' ? b.x + b.w - wd / 2 : b.x + b.w / 2;
        const y = b.anchorY === 'top' ? b.y + size * 0.55 : b.anchorY === 'bottom' ? b.y + b.h - size * 0.55 : b.y + b.h / 2;
        lay.runs.push({ text, role: ln.role, li, wi, emph: w.emph, size, x, y, w: wd, rot: 0, mod: w.mod });
      });
    });

    // timing of lines within the scene (reveal order); explicit line times win
    const t0 = start[i]; const d = dur[i];
    const lead = sc.t != null ? 0 : Math.min(0.2, d * 0.1); const tail = endX[i] ? 0 : Math.min(0.6, d * 0.2);
    const wts = sc.lines.map((l) => Math.max(1, l.words.length));
    const wsum = wts.reduce((a, b) => a + b, 0);
    let acc = 0; const lineT = sc.lines.map((ln, li) => {
      const v = ln.t != null ? ln.t : li === 0 ? t0 + lead : t0 + lead + (d - lead - tail) * (acc / wsum);
      acc += wts[li]; return v;
    });
    const lineEnds = sc.lines.map((ln, li) => ln.t1 ?? (li + 1 < sc.lines.length ? lineT[li + 1] : t0 + d - tail));
    const reveal = ['auto', 'word', 'line'].includes(sc.dir.reveal) ? sc.dir.reveal : revealDef;
    // motion personality for this scene
    const mseed = rnd(seed, 'motion', i);
    const inType = IN_FOR[sc.dir.motion] ?? pick(SP.motion, mseed);
    const emphStyle = ['bar', 'color', 'none'].includes(sc.dir.emph) ? sc.dir.emph : SP.emph === 'mix' ? (rnd(seed, 'emph', i) < 0.5 ? 'bar' : 'color') : SP.emph;
    const spring = { k: SP.spring.k * (0.7 + 0.6 * energy), z: SP.spring.z };
    const step = SP.step * (1.35 - 0.7 * energy);
    const lineCount = new Map();
    const sceneFx = sc.dir.fx != null ? parseFxList(sc.dir.fx) : parseFxList(opts.fx);
    const sceneAmp = clamp(Number(sc.dir.amp ?? opts.amp ?? 1) || 1, 0, 4); const sceneSpeed = clamp(Number(sc.dir.speed ?? opts.speed ?? 1) || 1, 0.1, 6);
    const runs = lay.runs.flatMap((r0, idx) => {
      let r = r0;
      const li = r.li >= 0 ? r.li : 0;
      const ord = lineCount.get(li) ?? 0; lineCount.set(li, ord + 1);
      if (!r.syl && !r.deco && sc.lines[li]) { const w = sc.lines[li].words.find((x) => x.syl && x.t.toLowerCase() === String(r.text).toLowerCase()); if (w) r = { ...r, syl: w.syl, mod: r.mod ?? w.mod }; }
      if (!r.mod && !r.deco && sc.lines[li]) { const w = sc.lines[li].words.find((x) => x.mod && x.t.toLowerCase() === String(r.text).toLowerCase()); if (w) r = { ...r, mod: w.mod, size: r.size * (w.mod.size ?? 1) }; }
      if (!r.st && !r.deco && r.wi >= 0 && sc.lines[li]?.words[r.wi]?.st && String(sc.lines[li].words[r.wi].t).toLowerCase() === String(r.text).toLowerCase()) r = { ...r, st: sc.lines[li].words[r.wi].st };
      const lmod = sc.lines[li]?.mod;
      const fxl = r.mod?.fx ?? lmod?.fx ?? sceneFx;
      const mc = r.mod?.color;
      const c = mc ?? r.color ?? (r.emph && emphStyle === 'color' ? 'accent' : r.role === 'whisper' || r.role === 'cite' ? 'dim' : 'fg');
      const onBar = r.emph && emphStyle === 'bar' && !r.deco && !mc;
      let rt = lineT[li] + ord * step;
      if (reveal === 'line') rt = lineT[li] + ord * 0.02;
      else if (reveal === 'word') { const nW = sc.lines[li].words.length; const span = Math.max(0.2, lineEnds[li] - lineT[li]); rt = lineT[li] + ord * Math.min(0.9, (span * 0.8) / Math.max(1, nW)); }
      rt += r.mod?.delay ?? 0;
      const base = { ...r, idx, font: scx.font(r.role), weight: scx.weight(r.role, r.st), color: onBar ? 'onAccent' : c,
        t0: r.deco ? lineT[0] : rt, anim: { type: r.deco ? 'zoom' : (IN_FOR[r.mod?.motion] ?? inType), spring },
        bar: onBar, phase: rnd(seed, 'ph', i, idx) * 6.283,
        ...(fxl.length && !r.deco ? { fx: fxl, fxAmp: r.mod?.amp ?? lmod?.amp ?? sceneAmp, fxSpeed: r.mod?.speed ?? lmod?.speed ?? sceneSpeed } : {}) };
      if (!r.syl || r.deco) return [base];
      // syllables: one run each, left to right inside the word's box, appearing one by one
      const parts = r.syl.map((p) => scx.text(r.role, p.t));
      const ws = parts.map((p, si) => scx.width(p, r.role, r.size * r.syl[si].f)); const tot = ws.reduce((a2, b2) => a2 + b2, 0) || 1;
      const kx = 1; let x = r.x - tot / 2; let tt = base.t0;
      return parts.map((p, si) => {
        const pw = ws[si] * kx; const out = { ...base, text: p, size: r.size * r.syl[si].f, w: pw, x: x + pw / 2, t0: tt, bar: false, color: onBar ? 'accent' : base.color, syl: undefined, phase: base.phase + si };
        x += pw; tt += r.syl[si].d ?? r.mod?.step ?? 0.28;
        return out;
      });
    });
    // character-level reveal for short title runs when the scene asks for it (typewriter)
    // Decorations are off unless asked for (::deco bar, or @deco bar for every scene). The layouts' own side bars are gone by default.
    const decoSpec = String(sc.dir.deco ?? opts.deco ?? ctx.deco ?? 'none');
    const decor = [...(lay.decor ?? []).filter((dc) => !dc.bar), ...makeDeco(decoSpec, lay.runs.filter((r) => !r.deco), W, H)]
      .map((dc) => ({ ...dc, t0: dc.li != null ? lineT[dc.li] : t0 + lead, spring }));
    const bgKind = bgMode === 'none' ? 'none' : bgMode === 'solid' ? 'solid' : (sc.dir.bgstyle ?? pick(SP.bgs, rnd(seed, 'bg', i)));
    // Every scene owns its own exit: its text fades over `outD` seconds and stays on screen while that happens, even if the
    // next scene has already started. `::out 0.6` sets the length, `::out cut` removes the fade. An explicit end time means
    // "fully gone by then", otherwise the fade starts when the scene's time is up.
    const od = String(sc.dir.out ?? '').trim().toLowerCase();
    const outD = od === 'cut' || od === 'none' ? 0 : Number.isFinite(Number(od)) && od !== '' ? clamp(Number(od), 0, 4) : 0.35;
    const gone = endX[i] ? t0 + d : t0 + d + outD;
    scenes.push({ i, t0, t1: t0 + d, dur: d, layout: used, pal, bgKind, runs, decor, inType, emphStyle, spring,
      idle: SP.idle, pulse: SP.pulse, drift: SP.drift, pack: styleName, trans: null, enter: null, next: -1, lineT, outD, gone, reveal });
  });

  // transitions between scenes
  // (paired by time, so the order of the blocks in the text does not matter)
  const byTime = scenes.map((_, i) => i).sort((x, y) => scenes[x].t0 - scenes[y].t0 || x - y);
  for (let k = 0; k < byTime.length - 1; k++) {
    const i = byTime[k]; const j = byTime[k + 1];
    const a = scenes[i]; const SP = PACKS[scenes[j].pack];
    const forced = script.scenes[j].dir.trans;
    let type = TRANSITION_IDS.includes(forced) ? forced : null;
    if (!type) {
      const ents = SP.transitions.map((n) => [n, (n === 'cut' || n === 'slices' ? 0.5 + energy : n === 'fade' || n === 'cover' ? 1.5 - energy : 1) * (0.8 + 0.4 * rnd(seed, 'tr', i, n))]);
      type = pickWeighted(ents, rnd(seed, 'trp', i));
      const before = k > 0 ? scenes[byTime[k - 1]] : null;
      if (before?.trans?.type === type) type = pickWeighted(ents.filter(([n]) => n !== type), rnd(seed, 'trq', i));
    }
    const dirs = ['left', 'right', 'up', 'down'];
    a.trans = { type, d: type === 'cut' ? 0.02 : SP.transDur * (1.35 - 0.7 * energy), dir: dirs[Math.floor(rnd(seed, 'dir', i) * 4)] };
    a.next = j; scenes[j].enter = a.trans;
  }
  const total = scenes.length ? Math.max(...scenes.map((s) => s.t1)) : 0;
  return { W, H, packName, energy, seed, scenes, total, fonts, shadow: clamp(Number(ctx.shadow) || 0, 0, 1), bgMode };
}

// ---------- evaluation ----------

/** Damped spring 0 -> 1 with overshoot; k = stiffness, z = damping ratio. */
export function spring(u, k, z) {
  if (u <= 0) return 0;
  const w = Math.sqrt(k);
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * u) * (Math.cos(wd * u) + ((z * w) / wd) * Math.sin(wd * u));
  }
  return 1 - Math.exp(-w * u) * (1 + w * u);
}

const hsl = (h, s2, l) => { const k = (n) => (n + h / 30) % 12; const a = s2 * Math.min(l, 1 - l); const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [f(0) * 255, f(8) * 255, f(4) * 255]; };
/** Continuous per-word effects. Everything is a pure function of the time, so scrubbing and export match the preview. */
function fxApply(st, r, t, u, sz) {
  const A = r.fxAmp ?? 1; const S = r.fxSpeed ?? 1; const ph = r.phase ?? 0; const wi = Math.max(0, r.wi ?? 0);
  const k = easeOutCubic(clamp(u / 0.4, 0, 1));          // effects ease in after the word arrives
  const T = t * S;
  for (const f of r.fx) {
    switch (f) {
      case 'shake': { const n = Math.floor(T * 22); st.dx += (rnd('shx', r.idx, n) - 0.5) * sz * 0.14 * A * k; st.dy += (rnd('shy', r.idx, n) - 0.5) * sz * 0.14 * A * k; st.rot += (rnd('shr', r.idx, n) - 0.5) * 0.08 * A * k; break; }
      case 'tremble': { const n = Math.floor(T * 40); st.dx += (rnd('trx', r.idx, n) - 0.5) * sz * 0.045 * A * k; st.dy += (rnd('try', r.idx, n) - 0.5) * sz * 0.045 * A * k; break; }
      case 'bounce': { const b = Math.abs(Math.sin(T * 4 + wi * 0.5)); st.dy -= b * sz * 0.22 * A * k; st.sy *= 1 - (1 - b) * 0.08 * A * k; st.sx *= 1 + (1 - b) * 0.06 * A * k; break; }
      case 'hop': { const c = (T * 1.4 + wi * 0.15) % 1; const h2 = c < 0.35 ? Math.sin((c / 0.35) * Math.PI) : 0; st.dy -= h2 * sz * 0.4 * A * k; break; }
      case 'wave': st.dy += Math.sin(T * 3.2 + wi * 0.8 + ph * 0.1) * sz * 0.13 * A * k; break;
      case 'wobble': st.rot += Math.sin(T * 4 + ph) * 0.13 * A * k; break;
      case 'swing': st.rot += Math.sin(T * 1.8 + wi * 0.4) * 0.25 * A * k; st.dy += (1 - Math.cos(T * 1.8 + wi * 0.4)) * sz * 0.03 * A * k; break;
      case 'pulse': { const p = 1 + Math.sin(T * 5 + ph) * 0.09 * A * k; st.sx *= p; st.sy *= p; break; }
      case 'heartbeat': { const c = (T * 1.2) % 1; const b = Math.exp(-((c - 0.12) ** 2) * 220) + 0.6 * Math.exp(-((c - 0.34) ** 2) * 260); const p = 1 + b * 0.18 * A * k; st.sx *= p; st.sy *= p; break; }
      case 'breathe': { const p = 1 + Math.sin(T * 1.3 + ph) * 0.05 * A * k; st.sx *= p; st.sy *= p; break; }
      case 'float': st.dy += Math.sin(T * 1.1 + ph) * sz * 0.1 * A * k; st.dx += Math.cos(T * 0.8 + ph) * sz * 0.04 * A * k; break;
      case 'drift': st.dx += Math.sin(T * 0.6 + ph) * sz * 0.2 * A * k; st.dy += Math.cos(T * 0.45 + ph) * sz * 0.1 * A * k; break;
      case 'spin': st.rot += T * 2 * A; break;
      case 'flicker': { const n = Math.floor(T * 14); st.alpha *= 1 - rnd('fl', r.idx, n) * 0.7 * Math.min(1, A) * k; break; }
      case 'blink': st.alpha *= Math.sin(T * 5 + ph) > -0.2 + (1 - Math.min(1, A)) ? 1 : 0.1; break;
      case 'glitch': { const n = Math.floor(T * 9); if (rnd('gl', r.idx, n) > 0.78) { st.dx += (rnd('glx', r.idx, n) - 0.5) * sz * 0.5 * A; st.sx *= 1 + (rnd('gls', r.idx, n) - 0.3) * 0.5 * A; } break; }
      case 'jelly': { const d = Math.sin(T * 7 + ph) * 0.1 * A * k; st.sx *= 1 + d; st.sy *= 1 - d; break; }
      case 'rubber': { const c = Math.sin(T * 3 + wi * 0.6); st.sx *= 1 + c * 0.16 * A * k; st.sy *= 1 - c * 0.12 * A * k; break; }
      case 'rainbow': st.color = hsl((T * 70 + wi * 38 + ph * 12) % 360, 0.85, 0.62); break;
      default: break;
    }
  }
}

function runState(r, t, sc, pulse, W, H) {
  const u = t - r.t0;
  if (u < 0) return null;
  const a = r.anim; const sp = (x) => spring(x, a.spring.k, a.spring.z);
  const s = sp(u); const sz = r.size;
  const st = { alpha: clamp(u / 0.09, 0, 1), sx: 1, sy: 1, dx: 0, dy: 0, rot: r.rot ?? 0, clip: 1 };
  switch (a.type) {
    case 'pop': st.sx = st.sy = lerp(0.35, 1, s); break;
    case 'rise': st.dy = (1 - s) * sz * 0.7; st.alpha = clamp(u / 0.22, 0, 1); break;
    case 'drop': st.dy = -(1 - s) * sz * 1.4; break;
    case 'slideL': st.dx = -(1 - s) * W * 0.16; break;
    case 'slideR': st.dx = (1 - s) * W * 0.16; break;
    case 'zoom': { const e = easeOutCubic(clamp(u / 0.4, 0, 1)); st.sx = st.sy = lerp(2.4, 1, e); st.alpha = clamp(u / 0.18, 0, 1); break; }
    case 'flip': st.sy = Math.max(0.001, s); st.alpha = clamp(u / 0.06, 0, 1); break;
    case 'tilt': st.rot += (1 - s) * (r.idx % 2 ? 0.3 : -0.3); st.dy = (1 - s) * sz * 0.4; break;
    case 'fade': st.alpha = clamp(u / 0.5, 0, 1); break;
    case 'type': st.clip = clamp(u / 0.25, 0, 1); break;
    case 'spin': st.rot += (1 - s) * -6.283; st.sx = st.sy = lerp(0.2, 1, s); st.alpha = clamp(u / 0.15, 0, 1); break;
    case 'stretch': st.sx = lerp(2.4, 1, s); st.sy = Math.max(0.05, lerp(0.2, 1, s)); st.alpha = clamp(u / 0.12, 0, 1); break;
    case 'swing': st.rot += (1 - s) * 0.9 * (r.idx % 2 ? 1 : -1); st.dy = -(1 - s) * sz * 0.5; break;
    case 'bounce': st.dy = -sz * 1.5 * Math.abs(Math.cos(u * 9)) * Math.exp(-u * 4.5); break;
    default: break;
  }
  if (r.fx?.length && !r.deco) fxApply(st, r, t, u, sz);
  if (r.deco) { st.alpha *= 0.55; }
  const p = 1 + pulse * sc.pulse * (r.emph ? 1.7 : 0.55) * (r.deco ? 0 : 1);
  st.sx *= p; st.sy *= p;
  if (sc.idle) st.dy += Math.sin(t * 1.4 + r.phase) * sz * sc.idle;
  return st;
}

function pushRect(geo, x, y, w, h, rot, c, a, ox = 0, oy = 0) {
  // axis-aligned rectangle rotated around its centre, 2 triangles
  const cxp = x + w / 2; const cyp = y + h / 2; const co = Math.cos(rot); const si = Math.sin(rot);
  const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([px, py]) => [cxp + px * co - py * si + ox, cyp + px * si + py * co + oy]);
  for (const k of [0, 1, 2, 0, 2, 3]) geo.pos.push(pts[k][0], pts[k][1]), geo.col.push(c[0] / 255, c[1] / 255, c[2] / 255, a);
}
function pushQuadColors(geo, x, y, w, h, cs, a) {
  const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  for (const k of [0, 1, 2, 0, 2, 3]) geo.pos.push(pts[k][0], pts[k][1]), geo.col.push(cs[k][0] / 255, cs[k][1] / 255, cs[k][2] / 255, a);
}
function pushCircle(geo, cx, cy, r, c, a, segs = 28, inner = 0) {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2; const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p = (rad, ang) => [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad];
    const tri = inner > 0 ? [[p(r, a0), p(r, a1), p(inner, a1)], [p(r, a0), p(inner, a1), p(inner, a0)]] : [[[cx, cy], p(r, a0), p(r, a1)]];
    for (const t of tri) for (const v of t) geo.pos.push(v[0], v[1]), geo.col.push(c[0] / 255, c[1] / 255, c[2] / 255, a);
  }
}

function background(geo, sc, t, W, H, pulse) {
  const { bg, bg2, accent } = sc.pal; const u = t - sc.t0;
  const grad = (ang) => {
    const ca = Math.cos(ang); const sa = Math.sin(ang); const R = Math.hypot(W, H) / 2;
    const corner = (x, y) => { const v = ((x - W / 2) * ca + (y - H / 2) * sa) / R * 0.5 + 0.5; return mixc(bg, bg2, clamp(v, 0, 1)); };
    pushQuadColors(geo, 0, 0, W, H, [corner(0, 0), corner(W, 0), corner(W, H), corner(0, H)], 1);
  };
  switch (sc.bgKind) {
    case 'none': break;
    case 'gradient': grad(0.9 + Math.sin(u * 0.35 + sc.i) * 0.35); break;
    case 'split': pushRect(geo, 0, 0, W, H, 0, bg, 1); pushRect(geo, W * 0.3, -H * 0.3, W * 0.9, H * 1.6, -0.35 + Math.sin(u * 0.4) * 0.03, bg2, 1); break;
    case 'bars': {
      pushRect(geo, 0, 0, W, H, 0, bg, 1);
      const n = 7; for (let k = 0; k < n; k++) {
        const w = W / n; const x = k * w; const hh = H * (0.25 + 0.55 * (0.5 + 0.5 * Math.sin(u * 0.8 + k * 1.7)));
        pushRect(geo, x + w * 0.1, H - hh, w * 0.8, hh, 0, bg2, 0.9);
      } break;
    }
    case 'dots': {
      pushRect(geo, 0, 0, W, H, 0, bg, 1);
      const gx = 16; const gy = Math.round(gx * H / W); const sp = W / gx;
      for (let y = 0; y <= gy; y++) for (let x = 0; x <= gx; x++) {
        const ph = Math.sin(u * 1.2 + (x + y) * 0.7) * 0.5 + 0.5;
        pushRect(geo, x * sp + sp * 0.35, y * sp + sp * 0.35, sp * 0.14 * (0.5 + ph), sp * 0.14 * (0.5 + ph), 0, bg2, 0.9);
      } break;
    }
    case 'blobs': {
      grad(1.1);
      for (let k = 0; k < 5; k++) {
        const r0 = rnd('blob', sc.i, k); const r1 = rnd('blob2', sc.i, k);
        const x = (r0 + 0.12 * Math.sin(u * 0.25 + k * 2)) * W; const y = (r1 + 0.1 * Math.cos(u * 0.21 + k)) * H;
        const rad = Math.min(W, H) * (0.18 + 0.2 * rnd('blob3', sc.i, k)) * (1 + pulse * 0.08);
        pushCircle(geo, x, y, rad, mixc(accent, bg2, 0.4), 0.16, 32);
      } break;
    }
    default: pushRect(geo, 0, 0, W, H, 0, bg, 1);
  }
}

function sceneGeometry(sc, t, W, H, pulse) {
  const geo = { pos: [], col: [] };
  background(geo, sc, t, W, H, pulse);
  const u = t - sc.t0;
  for (const d of sc.decor) {
    const e = spring(t - d.t0, d.spring.k * 0.5, 0.9); if (e <= 0) continue;
    const c = sc.pal[d.c] ?? (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(d.c)) ? hexToRgb(String(d.c)) : sc.pal.accent); const a = d.a ?? 1;
    if (d.grow === 'y') pushRect(geo, d.x, d.y + d.h * (1 - e) / 2, d.w, d.h * e, 0, c, a);
    else if (d.rot) pushRect(geo, d.x, d.y, d.w * e, d.h * e, d.rot, c, a);
    else if (d.w < d.h) pushRect(geo, d.x, d.y + d.h * (1 - Math.min(1, e)), d.w, d.h * Math.min(1, e), 0, c, a);
    else pushRect(geo, d.x, d.y, d.w * Math.min(1, e), d.h, 0, c, a);
  }
  void u;
  return geo;
}

function sceneRuns(sc, t, W, H, pulse) {
  const out = []; const bars = [];
  for (const r of sc.runs) {
    const st = runState(r, t, sc, pulse, W, H); if (!st) continue;
    const col = sc.pal[r.color] ?? (/^#[0-9a-f]{3,6}$/i.test(r.color) ? hexToRgb(r.color) : sc.pal.fg);
    const dim = r.color === 'dim' ? mixc(sc.pal.fg, sc.pal.bg, 0.45) : col;
    if (r.bar) {
      const e = spring(t - r.t0 - 0.05, 220, 0.9);
      if (e > 0) bars.push({ x: r.x - r.w / 2 - r.size * 0.12, y: r.y - r.size * 0.42, w: (r.w + r.size * 0.24) * Math.min(1, e), h: r.size * 0.86, rot: r.rot ?? 0, cx: r.x, cy: r.y, c: sc.pal.accent });
    }
    out.push({ text: r.text, font: r.font, weight: r.weight, st: r.st, size: r.size, color: st.color ? rgbToHex(st.color) : rgbToHex(dim), x: r.x + st.dx, y: r.y + st.dy, sx: st.sx, sy: st.sy, rot: st.rot, alpha: st.alpha, clip: st.clip });
  }
  return { runs: out, bars };
}

function drawScene(sc, t, W, H, pulse, tf) {
  const geo = sceneGeometry(sc, t, W, H, pulse);
  const { runs, bars } = sceneRuns(sc, t, W, H, pulse);
  const fade = tf.fade ?? 1;
  for (const b of bars) pushRect(geo, b.x, b.y, b.w, b.h, b.rot, b.c, 0.95 * (tf.pair ? fade : 1));
  // drift (slow camera) then the pass transform, applied to every point
  const u = clamp((t - sc.t0) / Math.max(0.1, sc.dur), 0, 1);
  const ds = 1 + sc.drift * u; const dpx = (rnd('dx', sc.i) - 0.5) * W * sc.drift * u; const dpy = (rnd('dy', sc.i) - 0.5) * H * sc.drift * u;
  const piv = [W / 2, H / 2];
  const cr = Math.cos(tf.rot ?? 0); const sr = Math.sin(tf.rot ?? 0); const S = ds * (tf.scale ?? 1);
  const map = (x, y, isBg) => {
    const px = isBg ? x : x; const py = isBg ? y : y;
    const dx = (px - piv[0]) * S; const dy = (py - piv[1]) * S;
    return [piv[0] + dx * cr - dy * sr + (tf.tx ?? 0) + dpx, piv[1] + dx * sr + dy * cr + (tf.ty ?? 0) + dpy];
  };
  for (let i = 0; i < geo.pos.length; i += 2) { const [x, y] = map(geo.pos[i], geo.pos[i + 1]); geo.pos[i] = x; geo.pos[i + 1] = y; }
  // backgrounds should always cover the screen: grow them a little when the camera drifts
  const rr = runs.map((r) => { const [x, y] = map(r.x, r.y); return { ...r, x, y, size: r.size * S, rot: r.rot + (tf.rot ?? 0), alpha: r.alpha * (tf.alpha ?? 1) * fade }; });
  const ga = (tf.alpha ?? 1) * (tf.bgAlpha ?? 1) * (tf.pair ? 1 : fade);
  const col = geo.col; if (ga < 1) for (let i = 3; i < col.length; i += 4) col[i] *= ga;
  return { geo: { pos: new Float32Array(geo.pos), col: new Float32Array(geo.col), n: geo.pos.length / 2 }, runs: rr, scissors: tf.scissors ?? null };
}

/**
 * Scenes visible at time t, each with its own role. A scene is alive from just before its start (its entrance transition)
 * until it has finished fading out, no matter what other scenes are doing, so text never vanishes because another scene began.
 * While the NEXT scene (by time) is entering, this one takes the "out" half of that same transition.
 */
function sceneStack(c, t) {
  const S = c.scenes; const out = [];
  for (const sc of S) {
    const en = sc.enter; const lo = en ? sc.t0 - en.d / 2 : sc.t0;
    if (t < lo - 1e-9 || t >= sc.gone) continue;
    const nx = sc.next >= 0 ? S[sc.next] : null;
    if (nx && sc.trans) {
      const d = sc.trans.d; const p = (t - (nx.t0 - d / 2)) / d;
      if (p > 0 && p < 1) { out.push({ sc, role: 'out', p, trans: sc.trans, pair: true }); continue; }
    }
    if (en) { const p = (t - lo) / en.d; if (p < 1) { out.push({ sc, role: 'in', p: Math.max(0, p), trans: en, pair: S.some((o) => o.next === sc.i && t < o.gone) }); continue; } }
    out.push({ sc, role: 'solo', p: 1 });
  }
  return out.sort((x, y) => x.sc.t0 - y.sc.t0 || x.sc.i - y.sc.i);
}

const DIR = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

function transformsFor(entry, W, H) {
  if (entry.role === 'solo') return { scale: 1 };
  const e = easeInOut(clamp(entry.p, 0, 1)); const { type, dir } = entry.trans; const [dx, dy] = DIR[dir];
  const out = entry.role === 'out';
  switch (type) {
    case 'cut': return out ? (e < 0.5 ? {} : { bgAlpha: 0 }) : (e < 0.5 ? { alpha: 0 } : {});
    case 'fade': return out ? {} : { alpha: e };
    case 'push': return out ? { tx: -dx * W * e, ty: -dy * H * e } : { tx: dx * W * (1 - e), ty: dy * H * (1 - e) };
    case 'cover': return out ? { scale: 1 - 0.06 * e, alpha: 1 - 0.35 * e } : { tx: dx * W * (1 - e), ty: dy * H * (1 - e) };
    case 'zoom': return out ? { scale: 1 + 0.7 * e, alpha: 1 - e } : { scale: 0.82 + 0.18 * e };
    case 'wipe': {
      if (out) return {};
      const horiz = dx !== 0;
      const rect = horiz ? (dx > 0 ? [W * (1 - e), 0, W, H] : [0, 0, W * e, H]) : (dy > 0 ? [0, H * (1 - e), W, H] : [0, 0, W, H * e]);
      return { scissors: [rect] };
    }
    case 'bars': {
      if (out) return {};
      const n = 6; const rects = [];
      for (let k = 0; k < n; k++) { const local = clamp(e * 1.6 - (k / n) * 0.6, 0, 1); const w = W / n; rects.push([k * w, 0, k * w + w, H * local]); }
      return { scissors: rects };
    }
    case 'slices': {
      const n = 8; const rects = []; const frame = Math.floor(entry.p * 12);
      for (let k = 0; k < n; k++) {
        const showB = rnd('sl', frame, k) < e + 0.1 * (e > 0.5 ? 1 : 0);
        if (showB === !out) rects.push([0, (k * H) / n, W, ((k + 1) * H) / n]);
      }
      return { scissors: rects.length ? rects : [[0, 0, 0, 0]], tx: (rnd('slx', frame, out ? 1 : 2) - 0.5) * W * 0.04 };
    }
    default: return {};
  }
}

/** What to draw at time t. `pulse` (0..1) is the current audio energy; pass 0 for none. */
export function frameAt(c, t, { pulse = 0 } = {}) {
  const passes = [];
  for (const entry of sceneStack(c, t)) {
    const tf = transformsFor(entry, c.W, c.H);
    const sc = entry.sc;
    // the scene's own fade-out: text (and its bars) always; the backdrop only when nothing is taking over behind it
    tf.fade = sc.outD > 0 ? clamp((sc.gone - t) / sc.outD, 0, 1) : 1;
    tf.pair = !!entry.pair;
    const d = drawScene(entry.sc, t, c.W, c.H, pulse, tf);
    if (c.shadow) for (const r of d.runs) r.shadow = c.shadow;
    passes.push(d);
  }
  // a transition edge line for wipes
  return { passes };
}

/** Compact summary used by the UI and tests. */
export function summarize(c) {
  return c.scenes.map((s) => ({ i: s.i, t0: +s.t0.toFixed(2), t1: +s.t1.toFixed(2), layout: s.layout, reveal: s.reveal, motion: s.inType, bg: s.bgKind, trans: s.trans?.type ?? null, words: s.runs.length }));
}
