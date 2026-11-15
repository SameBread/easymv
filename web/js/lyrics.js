// Lyrics: data model helpers, LRC import/export, tap-to-sync, line animation and
// automatic placement. Pure (no DOM), deterministic, unit-tested.
//
// A lyrics layer's `lyrics` object:
//   { lines: [{ t0, t1?, text, words?: [{ t, text }], pos?: {x, y} }],
//     style:  { font, size, weight, italic, color, hiColor, outline, outlineColor, shadow, align, karaoke, maxWidth },
//     anim:   { in: 'fade'|'slide'|'pop'|'type'|'none', out: 'fade'|'slide'|'none', dur },
//     layout: { mode, seed, tilt, avoid } }
// Times are seconds from the start of the song.

export const LYRIC_FONTS = [
  'system-ui', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
  'Impact', 'Arial Black', 'Georgia', 'Trebuchet MS', 'Courier New', 'Comic Sans MS',
];

export const LYRIC_DEFAULTS = {
  lines: [],
  style: {
    font: 'system-ui', size: 0.075, weight: 700, italic: false,
    color: '#ffffff', hiColor: '#ff6b9d', outline: 0.12, outlineColor: '#14151a', shadow: 0.25,
    align: 'center', karaoke: 'off', maxWidth: 0.82,
  },
  anim: { in: 'fade', out: 'fade', dur: 0.25 },
  layout: { mode: 'lower', seed: 1, tilt: 0, avoid: true },
};

export const LAYOUT_MODES = {
  center:    'Center',
  lower:     'Lower third',
  upper:     'Upper third',
  alternate: 'Alternate left / right',
  cycle:     'Cycle corners',
  random:    'Random (seeded)',
};

export function lyricsSettings(def) {
  const l = def.lyrics ?? {};
  return {
    lines: l.lines ?? [],
    style: { ...LYRIC_DEFAULTS.style, ...(l.style ?? {}) },
    anim: { ...LYRIC_DEFAULTS.anim, ...(l.anim ?? {}) },
    layout: { ...LYRIC_DEFAULTS.layout, ...(l.layout ?? {}) },
  };
}

// ---------- parsing and formatting ----------

const TIME = String.raw`(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?`;
const stamp = (m, a, b, c) => Number(a) * 60 + Number(b) + (c ? Number(c) / 10 ** c.length : 0);

/** Plain text (one line per row, blank lines dropped) -> untimed lines. */
export function linesFromText(text) {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((t) => ({ t0: null, text: t }));
}

/**
 * Parse LRC, including the "enhanced" word-level variant (<mm:ss.xx> tags inside a line).
 * Several [time] tags before one text repeat that text. Metadata tags are ignored,
 * except [offset:+/-ms]. Unparseable lines are skipped.
 */
export function parseLrc(text) {
  const out = [];
  let offset = 0;
  const lineTag = new RegExp(String.raw`\[${TIME}\]`, 'g');
  const wordTag = new RegExp(String.raw`<${TIME}>`, 'g');
  for (const raw of text.split(/\r?\n/)) {
    const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
    if (off) { offset = Number(off[1]) / 1000; continue; }
    const times = [];
    let m;
    lineTag.lastIndex = 0;
    let end = 0;
    while ((m = lineTag.exec(raw)) && m.index === end) { times.push(stamp(...m)); end = lineTag.lastIndex; }
    if (!times.length) continue;
    const body = raw.slice(end);
    const words = [];
    wordTag.lastIndex = 0;
    let last = 0; let wt = null; let w;
    let plain = '';
    while ((w = wordTag.exec(body))) {
      const seg = body.slice(last, w.index);
      if (wt !== null && seg.trim()) words.push({ t: wt, text: seg.trim() });
      plain += seg;
      wt = stamp(...w); last = wordTag.lastIndex;
    }
    const tail = body.slice(last);
    if (wt !== null && tail.trim()) words.push({ t: wt, text: tail.trim() });
    plain += tail;
    const textOnly = plain.replace(/\s+/g, ' ').trim();
    if (!textOnly) continue;
    for (const t of times) {
      const line = { t0: Math.max(0, t + offset), text: textOnly };
      if (words.length) line.words = words.map((x) => ({ t: Math.max(0, x.t + offset), text: x.text }));
      out.push(line);
    }
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function fmtStamp(t, brackets = '[]') {
  const total = Math.max(0, Math.round(t * 100));
  const cs = total % 100; const s = Math.floor(total / 100) % 60; const m = Math.floor(total / 6000);
  return `${brackets[0]}${pad(m)}:${pad(s)}.${pad(cs)}${brackets[1]}`;
}

/** Export timed lines as LRC; `enhanced` adds word tags where words are known. */
export function formatLrc(lines, { enhanced = true } = {}) {
  return lines
    .filter((l) => l.t0 != null)
    .map((l) => {
      if (enhanced && l.words?.length) return `${fmtStamp(l.t0)}${l.words.map((w) => `${fmtStamp(w.t, '<>')}${w.text}`).join(' ')}`;
      return `${fmtStamp(l.t0)}${l.text}`;
    })
    .join('\n');
}

// ---------- timing ----------

/** End time of a line: explicit t1, else the next line's start, else a default hold. */
export function lineEnd(lines, i, total = Infinity, maxHold = 6) {
  const l = lines[i];
  if (l.t1 != null) return l.t1;
  const next = lines.slice(i + 1).find((x) => x.t0 != null);
  const fallback = l.t0 + Math.min(maxHold, Math.max(1.5, l.text.length * 0.09));
  const end = next ? Math.min(next.t0, l.t0 + maxHold * 2) : fallback;
  return Math.min(end, total);
}

/**
 * Tap-to-sync: stamp line `index` as starting at time `t`; the previous line's end is
 * left to auto (next start). Returns the index to tap next (or -1 at the end).
 */
export function tapStamp(lines, index, t) {
  if (index < 0 || index >= lines.length) return -1;
  lines[index].t0 = Math.max(0, t);
  delete lines[index].words;
  if (index > 0 && lines[index - 1].t0 != null && lines[index - 1].t0 > t) lines[index - 1].t0 = Math.max(0, t - 0.05);
  return index + 1 < lines.length ? index + 1 : -1;
}

/** Tap a word inside a line (karaoke): rebuilds `words` from the line text. */
export function tapWord(line, wordIndex, t) {
  const parts = line.text.split(/\s+/).filter(Boolean);
  if (!line.words || line.words.length !== parts.length) line.words = parts.map((p) => ({ t: null, text: p }));
  line.words[wordIndex].t = t;
  return wordIndex + 1 < parts.length ? wordIndex + 1 : -1;
}

export const sortLines = (lines) => lines.sort((a, b) => (a.t0 ?? Infinity) - (b.t0 ?? Infinity));

// ---------- per-frame state ----------

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeOut = (x) => 1 - (1 - x) * (1 - x);
const easeBack = (x) => { const c = 1.70158; const y = x - 1; return 1 + (c + 1) * y ** 3 + c * y * y; };

/**
 * Lines visible at time `t`, with their animation state.
 * @returns {Array<{ i, line, age, alpha, dx, dy, scale, reveal }>} dx/dy in units of the line height.
 */
export function activeLines(lyr, t, total = Infinity) {
  const { lines, anim } = lyr;
  const out = [];
  const dur = Math.max(0.001, anim.dur);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.t0 == null) continue;
    const end = lineEnd(lines, i, total);
    const outDur = anim.out === 'none' ? 0 : dur;
    if (t < l.t0 || t >= end + outDur) continue;
    const age = t - l.t0;
    const pin = anim.in === 'none' ? 1 : clamp01(age / dur);
    const pout = t <= end || outDur === 0 ? 0 : clamp01((t - end) / outDur);
    let alpha = 1; let dx = 0; let dy = 0; let scale = 1; let reveal = 1;
    if (anim.in === 'fade') alpha *= easeOut(pin);
    else if (anim.in === 'slide') { alpha *= easeOut(pin); dy += (1 - easeOut(pin)) * 0.8; }
    else if (anim.in === 'pop') { alpha *= clamp01(pin * 3); scale *= 0.4 + 0.6 * easeBack(pin); }
    else if (anim.in === 'type') reveal = pin;
    if (anim.out === 'fade') alpha *= 1 - pout;
    else if (anim.out === 'slide') { alpha *= 1 - pout; dy -= pout * 0.8; }
    out.push({ i, line: l, age, alpha, dx, dy, scale, reveal });
  }
  return out;
}

/** Karaoke fill 0..1 along the line text at time `t`. */
export function highlightFraction(line, t, end, mode) {
  if (mode === 'off') return 0;
  const words = line.words?.filter((w) => w.t != null);
  if (mode === 'words' && words?.length) {
    const full = words.map((w) => w.text).join(' ');
    let k = -1;
    for (let i = 0; i < words.length; i++) if (words[i].t <= t) k = i;
    if (k < 0) return 0;
    const nextT = k + 1 < words.length ? words[k + 1].t : end;
    const f = clamp01((t - words[k].t) / Math.max(0.05, nextT - words[k].t));
    let before = 0;
    for (let i = 0; i < k; i++) before += words[i].text.length + 1;
    return clamp01((before + f * words[k].text.length) / Math.max(1, full.length));
  }
  return clamp01((t - line.t0) / Math.max(0.05, end - line.t0)); // sweep across the whole line
}

// ---------- automatic placement ----------

function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const overlap = (a, b) => {
  const w = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
  const h = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
  return w > 0 && h > 0 ? w * h : 0;
};

const CORNERS = [[0.28, 0.28], [0.72, 0.72], [0.72, 0.28], [0.28, 0.72]];

/** Seeded shuffle of the 12 grid spots used by the random layout (same result for the same line). */
function randomSpots(layout, i) {
  const r = rng(layout.seed * 7919 + i * 104729);
  const cands = [];
  for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 3; gx++) cands.push([0.2 + gx * 0.3 + (r() - 0.5) * 0.08, 0.15 + gy * 0.23 + (r() - 0.5) * 0.06]);
  for (let k = cands.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [cands[k], cands[j]] = [cands[j], cands[k]]; }
  return cands;
}

/**
 * Pick a normalised centre (x, y) and tilt for line `i`.
 * `box` is the line's size as a fraction of the canvas and `avoid` an array of {x,y,w,h}
 * rectangles (normalised, centre based) to keep clear of. The result depends only on the
 * inputs and the line index (never on which lines were drawn before), so scrubbing,
 * playing and exporting always place a line identically.
 */
export function placeLine(layout, i, box, avoid = []) {
  const r = rng(layout.seed * 15485863 + i * 32452843);
  const mx = Math.min(0.5, box.w / 2 + 0.03); const my = Math.min(0.5, box.h / 2 + 0.03);
  const keep = (x, y) => [Math.min(1 - mx, Math.max(mx, x)), Math.min(1 - my, Math.max(my, y))];
  let cands;
  switch (layout.mode) {
    case 'center': cands = [[0.5, 0.5]]; break;
    case 'upper': cands = [[0.5, 0.16]]; break;
    case 'alternate': cands = [[i % 2 ? 0.7 : 0.3, 0.5 + (i % 4 < 2 ? -0.18 : 0.18)]]; break;
    case 'cycle': cands = [CORNERS[i % CORNERS.length]]; break;
    case 'random': cands = randomSpots(layout, i); break;
    case 'lower':
    default: cands = [[0.5, 0.84]];
  }
  const prevTop = layout.mode === 'random' && i > 0 ? randomSpots(layout, i - 1)[0] : null;
  let best = null; let bestCost = Infinity;
  for (const c of cands) {
    const [x, y] = keep(c[0], c[1]);
    const rect = { x, y, w: box.w, h: box.h };
    let cost = 0;
    if (layout.avoid) for (const a of avoid) cost += overlap(rect, a);
    if (prevTop && Math.abs(x - prevTop[0]) < 0.14 && Math.abs(y - prevTop[1]) < 0.12) cost += 0.5;
    if (cost < bestCost) { bestCost = cost; best = [x, y]; if (cost === 0) break; }
  }
  const tilt = layout.tilt ? (r() * 2 - 1) * layout.tilt : 0;
  return { x: best[0], y: best[1], tilt };
}
