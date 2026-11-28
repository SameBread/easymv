// Effect events: a small script that says WHEN things happen to an effect layer (a gust of wind, a burst of sparks, a flash...).
// The grammar mirrors the lyrics script:   [time] verb words {options}     // a comment
//
//   [0:12] gust right 0.8 for 2s          wind pushes right for two seconds
//   [0:20] wind left 0.4 over 3s          wind settles at "left, 0.4" (until changed)
//   [0:30] calm over 2s                   wind dies down
//   [0:35-0:40] speed 2.5                 faster from 0:35 (the end time ends it)
//   [@17] burst 120 at 0.5,0.8            on bar 17: 120 particles burst out at that spot
//   [@17.3] flash white                   a flash on beat 3
//   [0:50] pulse size 0.5 every beat      the size throbs on every beat
//
// Pure and deterministic: compileFx(text, ctx) -> { events, ... }, sampleFx(c, t, base) -> everything the GPU needs at time t.
// Wind and speed are INTEGRATED over time (a gust pushes particles somewhere; they do not snap back), using a table that is
// built once per script, so any frame can be drawn on its own (scrub, seek, export) and always matches.

import { beatAt, timeAt, noteBeats, timeOfBarBeat } from './tempo.js';

export const FX_VERBS = {
  gust: 'a burst of wind: direction, strength, for/attack/release',
  wind: 'steady wind from now on: direction, strength, over',
  calm: 'wind dies down: over',
  speed: 'speed multiplier: number, over',
  density: 'how many particles show (0 to 2): number, over',
  size: 'particle size multiplier: number, over',
  turbulence: 'how much particles sway (0 to 4): number, over',
  glow: 'brightness multiplier: number, over',
  burst: 'a one-time burst of particles: count, at x,y, direction, {spread power life}',
  flash: 'a quick flash of light: strength, colour, {decay}',
  tint: 'wash the effect with a colour: colour, amount, for',
  pulse: 'throb to the beat: speed|size|density|glow, amount, every beat|bar|1/8',
};
export const FX_DIRS = ['left', 'right', 'up', 'down'];
export const FX_MODS = {
  for: 'duration', over: 'duration', attack: 'duration', release: 'duration', decay: 'duration', life: 'duration', every: 'duration',
  count: 'number', spread: 'number', power: 'number', amount: 'number', strength: 'number', x: 'number', y: 'number', color: 'color', dir: 'dir',
};
const CHANNELS = ['speed', 'size', 'density', 'glow'];
export const FX_COLORS = { white: '#ffffff', red: '#ff3b30', orange: '#ff9500', yellow: '#ffd60a', green: '#34c759', cyan: '#5ac8fa', blue: '#3a7bff', purple: '#af52de', pink: '#ff6bb5', warm: '#ffd9a0', cold: '#9fd0ff', black: '#000000' };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (x) => { const u = clamp(x, 0, 1); return u * u * (3 - 2 * u); };

// ---------- reading ----------

/** "0:12.5", "1:02", "12.5", "@17", "@17.3" -> seconds, or null. */
export function parseTime(s, tempo) {
  s = String(s).trim();
  if (s[0] === '@') {
    const m = /^@(\d+)(?:\.(\d+(?:\.\d+)?))?$/.exec(s); if (!m) return null;
    if (!tempo) return { bar: true, t: null };
    return { t: timeOfBarBeat(Number(m[1]), m[2] != null ? Number(m[2]) : 1, tempo) };
  }
  let m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (m) return { t: (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) };
  m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s); if (m) return { t: Number(m[1]) * 60 + Number(m[2]) };
  m = /^\d+(?:\.\d+)?$/.exec(s); if (m) return { t: Number(s) };
  return null;
}

/** A length of time: "2s", "500ms", "2 beats", "1bar", "1/8" -> seconds from time t0. null when unreadable. */
export function parseSpan(tok, t0, tempo) {
  tok = String(tok).trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)(ms|s|sec)?$/.exec(tok);
  if (m) return m[2] === 'ms' ? Number(m[1]) / 1000 : Number(m[1]);
  m = /^(\d+(?:\.\d+)?)?\s*(beats?|bars?)$/.exec(tok);
  if (m) { if (!tempo) return { needsTempo: true }; const n = m[1] != null ? Number(m[1]) : 1; const beats = /bar/.test(m[2]) ? n * tempo.sig : n; return timeAt(beatAt(t0, tempo) + beats, tempo) - t0; }
  m = /^1\/(\d+)(t)?$/.exec(tok);
  if (m) { if (!tempo) return { needsTempo: true }; return timeAt(beatAt(t0, tempo) + noteBeats(tok.toUpperCase(), tempo), tempo) - t0; }
  return null;
}

const dirVec = (name) => ({ left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] })[name] ?? null;
const hexRgb = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return null; const v = parseInt(m[1], 16); return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };
export function parseColor(tok) {
  const t = String(tok).toLowerCase();
  const h = FX_COLORS[t] ?? (/^#[0-9a-f]{6}$/i.test(t) ? t : /^#[0-9a-f]{3}$/i.test(t) ? `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}` : null);
  return h ? hexRgb(h) : null;
}

const TAG = /^\s*\[([^\]]*)\]\s*(.*)$/;

/** Split one event line into its pieces. Returns { t0, t1, verb, words, mods, problems[] } or null for blank/comment lines. */
export function parseLine(raw, tempo) {
  const line = raw.trim();
  if (!line || line.startsWith('//')) return null;
  const m = TAG.exec(raw);
  const out = { t0: null, t1: null, verb: '', words: [], mods: {}, problems: [], timeText: null };
  if (!m) { out.problems.push({ code: 'notime', msg: 'This line has no time. Start it with [0:12] (or [@17] for bar 17).' }); out.rest = line; return out; }
  out.timeText = m[1];
  const [a, b] = m[1].split(/\s*-\s*/);
  const ta = parseTime(a, tempo);
  if (!ta) out.problems.push({ code: 'badtime', msg: `“${m[1]}” is not a time. Use 0:12, 0:12.5 or @17.3.` });
  else if (ta.bar) out.problems.push({ code: 'needstempo', msg: 'Bar times need a tempo. Set one in Audio > Tempo & beat grid.' });
  else out.t0 = ta.t;
  if (b != null) { const tb = parseTime(b, tempo); if (tb && !tb.bar) out.t1 = tb.t; else out.problems.push({ code: 'badtime', msg: `“${b}” is not a time.` }); }
  let rest = m[2];
  const mm = /\{([^}]*)\}?\s*$/.exec(rest);
  if (mm) { rest = rest.slice(0, mm.index); for (const kv of mm[1].split(/[\s,]+/).filter(Boolean)) { const e = kv.indexOf('='); if (e > 0) out.mods[kv.slice(0, e).toLowerCase()] = kv.slice(e + 1); else out.words.push(kv); } }
  const words = rest.trim().split(/\s+/).filter(Boolean);
  out.verb = (words.shift() ?? '').toLowerCase();
  out.words = [...words, ...out.words];
  return out;
}

/** Pull the loose words of a line apart: numbers, directions, colours, "for 2s", "at 0.5,0.8"... */
function readWords(words, t0, tempo, problems) {
  const r = { nums: [], dir: null, color: null, at: null, spans: {}, bare: [] };
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase();
    if (['for', 'over', 'every', 'attack', 'release', 'decay', 'life'].includes(w)) {
      let tok = words[i + 1] ?? ''; let used = 1;
      if (/^\d+(\.\d+)?$/.test(tok) && /^(beats?|bars?)$/i.test(words[i + 2] ?? '')) { tok = `${tok} ${words[i + 2]}`; used = 2; }
      const v = parseSpan(tok, t0 ?? 0, tempo);
      if (v == null) problems.push({ code: 'badspan', msg: `“${w} ${tok}” needs a length like 2s, 500ms, 2 beats or 1 bar.` });
      else if (v.needsTempo) problems.push({ code: 'needstempo', msg: 'Beats and bars need a tempo. Set one in Audio > Tempo & beat grid.' });
      else r.spans[w] = v;
      i += used; continue;
    }
    if (w === 'at') {
      const m = /^(-?\d*\.?\d+)[,x](-?\d*\.?\d+)$/.exec(words[i + 1] ?? '');
      if (m) { r.at = [Number(m[1]), Number(m[2])]; i++; } else problems.push({ code: 'badat', msg: '“at” needs a position like at 0.5,0.8 (0 to 1 across the effect).' });
      continue;
    }
    if (dirVec(w)) { r.dir = dirVec(w); continue; }
    const deg = /^(-?\d+(?:\.\d+)?)(?:°|deg)$/.exec(w);
    if (deg) { const a = (Number(deg[1]) * Math.PI) / 180; r.dir = [Math.cos(a), Math.sin(a)]; continue; }
    if (/^-?\d*\.?\d+x?$/.test(w)) { r.nums.push(Number(w.replace(/x$/, ''))); continue; }
    if (parseColor(w)) { r.color = parseColor(w); continue; }
    if (CHANNELS.includes(w)) { r.channel = w; continue; }
    r.bare.push(w);
  }
  return r;
}

const defNum = (v, d) => (Number.isFinite(v) ? v : d);

/** Compile the script. ctx: { tempo, songSec }. Returns { events, issues } where issues are [{ line, msg, severity }]. */
export function compileFx(text, ctx = {}) {
  const tempo = ctx.tempo ?? null;
  const events = []; const issues = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, ln) => {
    const p = parseLine(raw, tempo); if (!p) return;
    for (const pr of p.problems) issues.push({ line: ln, msg: pr.msg, severity: 'error', code: pr.code });
    if (p.t0 == null) return;
    const probs = []; const w = readWords(p.words, p.t0, tempo, probs);
    for (const pr of probs) issues.push({ line: ln, msg: pr.msg, severity: 'warn', code: pr.code });
    for (const [k, v] of Object.entries(p.mods)) {
      if (!FX_MODS[k]) { issues.push({ line: ln, msg: `Unknown option “${k}”.`, severity: 'warn', code: 'badmod' }); continue; }
      if (FX_MODS[k] === 'duration') { const s = parseSpan(v, p.t0, tempo); if (s != null && !s.needsTempo) w.spans[k] = s; else issues.push({ line: ln, msg: `“${k}=${v}” needs a length like 2s or 1 bar.`, severity: 'warn', code: 'badspan' }); }
      else if (FX_MODS[k] === 'number') { if (Number.isFinite(Number(v))) w[`m_${k}`] = Number(v); else issues.push({ line: ln, msg: `“${k}” needs a number.`, severity: 'warn', code: 'badnum' }); }
      else if (FX_MODS[k] === 'color') { const c = parseColor(v); if (c) w.color = c; else issues.push({ line: ln, msg: `“${v}” is not a colour (use a name like white or #ffd166).`, severity: 'warn', code: 'badcolor' }); }
      else if (FX_MODS[k] === 'dir') { const d = dirVec(v); if (d) w.dir = d; }
    }
    const t0 = p.t0; const span = p.t1 != null && p.t1 > t0 ? p.t1 - t0 : null;
    const n0 = w.nums[0];
    switch (p.verb) {
      case 'gust': {
        const dur = w.spans.for ?? span ?? 1.5;
        const d = w.dir ?? [1, 0];
        events.push({ type: 'gust', t0, dur, att: clamp(w.spans.attack ?? dur * 0.3, 0.02, dur), rel: clamp(w.spans.release ?? dur * 0.5, 0.02, dur * 2), amp: clamp(defNum(n0 ?? w.m_strength, 1), -4, 4), dx: d[0], dy: d[1], line: ln });
        break;
      }
      case 'wind': case 'calm': {
        const d = p.verb === 'calm' ? [0, 0] : (w.dir ?? [1, 0]); const amp = p.verb === 'calm' ? 0 : clamp(defNum(n0 ?? w.m_strength, 0.5), -4, 4);
        events.push({ type: 'wind', t0, over: w.spans.over ?? 0.8, vx: d[0] * amp, vy: d[1] * amp, line: ln });
        break;
      }
      case 'speed': case 'density': case 'size': case 'turbulence': case 'glow': {
        const v = n0 ?? w.m_amount;
        if (v == null) { issues.push({ line: ln, msg: `${p.verb} needs a number, like “${p.verb} 1.5”.`, severity: 'error', code: 'nonum' }); break; }
        const max = { speed: 8, density: 2, size: 6, turbulence: 4, glow: 4 }[p.verb];
        events.push({ type: p.verb === 'turbulence' ? 'turb' : p.verb, t0, over: w.spans.over ?? 0.5, v: clamp(v, 0, max), t1: span ? t0 + span : null, line: ln });
        break;
      }
      case 'burst': {
        const d = w.dir ?? null;
        events.push({ type: 'burst', t0, count: Math.round(clamp(defNum(n0 ?? w.m_count, 60), 1, 400)), ox: w.at?.[0] ?? w.m_x ?? 0.5, oy: w.at?.[1] ?? w.m_y ?? 0.5,
          spread: clamp(defNum(w.m_spread, d ? 0.35 : 1), 0.02, 1), power: clamp(defNum(w.m_power, 1), 0.1, 4), life: clamp(w.spans.life ?? w.spans.for ?? span ?? 1.6, 0.2, 8), ang: d ? Math.atan2(d[1], d[0]) : null, line: ln });
        break;
      }
      case 'flash': {
        events.push({ type: 'flash', t0, amp: clamp(defNum(n0 ?? w.m_strength, 0.8), 0, 2), decay: clamp(w.spans.decay ?? w.spans.for ?? span ?? 0.3, 0.03, 3), rgb: w.color ?? [1, 1, 1], line: ln });
        break;
      }
      case 'tint': {
        if (!w.color) { issues.push({ line: ln, msg: 'tint needs a colour, like “tint blue 0.5 for 4s”.', severity: 'error', code: 'nocolor' }); break; }
        events.push({ type: 'tint', t0, dur: w.spans.for ?? span ?? 2, amt: clamp(defNum(n0 ?? w.m_amount, 0.6), 0, 1), rgb: w.color, line: ln });
        break;
      }
      case 'pulse': {
        const ch = w.channel ?? 'size';
        const every = w.spans.every;
        if (!tempo && every == null) issues.push({ line: ln, msg: 'pulse needs a tempo or an “every 0.5s”. Set a tempo in Audio > Tempo & beat grid.', severity: 'error', code: 'needstempo' });
        events.push({ type: 'pulse', t0, t1: span ? t0 + span : null, ch, amt: clamp(defNum(n0 ?? w.m_amount, 0.5), -2, 4), everySec: every ?? null, everyBeats: every == null ? 1 : null, line: ln });
        break;
      }
      default:
        issues.push({ line: ln, msg: p.verb ? `Unknown action “${p.verb}”.` : 'Nothing after the time.', severity: 'error', code: 'badverb' });
    }
  });
  events.sort((a, b) => a.t0 - b.t0 || a.line - b.line);
  let endT = 0;
  for (const e of events) endT = Math.max(endT, e.t0 + (e.dur ?? 0) + (e.over ?? 0) + (e.rel ?? 0) + (e.decay ?? 0) * 4 + (e.life ?? 0) + (e.t1 != null ? e.t1 - e.t0 : 0));
  return { events, issues, endT, tempo, static: events.length === 0, _tables: null };
}

// ---------- sampling ----------

/** Value of a stepped channel (speed, size...) at t: each event ramps from the previous value to its own over `over`. */
function stepValue(list, t, start) {
  let v = start; let prevT1 = null;
  for (const e of list) {
    if (e.t0 > t) break;
    const ramp = e.over > 0 ? smooth((t - e.t0) / e.over) : 1;
    // a time range ("[0:35-0:40] speed 2") returns to the start value after it ends
    if (e.t1 != null && t >= e.t1) { const back = smooth((t - e.t1) / Math.max(0.05, e.over)); v = e.v + (start - e.v) * back; prevT1 = e.t1; continue; }
    v = v + (e.v - v) * ramp; void prevT1;
  }
  return v;
}

function groupByType(c) {
  if (c._g) return c._g;
  const g = { gust: [], wind: [], speed: [], density: [], size: [], turb: [], glow: [], burst: [], flash: [], tint: [], pulse: [] };
  for (const e of c.events) g[e.type].push(e);
  c._g = g; return g;
}

/** Instantaneous (not integrated) quantities at t. */
function rates(c, t, base, grav) {
  const g = groupByType(c);
  // steady wind: replaced (not added to) by wind/calm events
  let wx = base.wind; let wy = base.windY ?? 0;
  for (const e of g.wind) { if (e.t0 > t) break; const k = e.over > 0 ? smooth((t - e.t0) / e.over) : 1; wx += (e.vx - wx) * k; wy += (e.vy - wy) * k; }
  for (const e of g.gust) {
    const u = t - e.t0; if (u < 0 || u > e.att + e.dur + e.rel) continue;
    const env = u < e.att ? smooth(u / e.att) : u < e.dur ? 1 : 1 - smooth((u - e.dur) / e.rel);
    wx += e.dx * e.amp * env; wy += e.dy * e.amp * env;
  }
  const mul = { speed: 1, size: 1, density: 1, glow: 1 };
  if (c.tempo) {
    for (const e of g.pulse) {
      const hi = e.t1 ?? Infinity; if (t < e.t0 || t >= hi) continue;
      let ph;
      if (e.everySec != null) ph = ((t - e.t0) / e.everySec) % 1;
      else { const b = beatAt(t, c.tempo); ph = ((b % e.everyBeats) + e.everyBeats) % e.everyBeats / e.everyBeats; }
      mul[e.ch] *= 1 + e.amt * Math.pow(1 - ph, 2.2);
    }
  } else for (const e of g.pulse) if (e.everySec != null && t >= e.t0 && (e.t1 == null || t < e.t1)) mul[e.ch] *= 1 + e.amt * Math.pow(1 - (((t - e.t0) / e.everySec) % 1), 2.2);
  const speed = base.speed * stepValue(g.speed, t, 1) * mul.speed * (grav ? clamp(1 + 0.6 * wy * grav, 0.15, 3) : 1);
  return { wx, wy, speed, size: stepValue(g.size, t, 1) * mul.size, density: stepValue(g.density, t, 1) * mul.density, turb: stepValue(g.turb, t, 1), glow: stepValue(g.glow, t, 1) * mul.glow };
}

const DT = 1 / 60;
function tables(c, base, grav) {
  const key = `${base.speed}|${base.wind}|${base.windY ?? 0}|${grav}`;
  if (c._tables?.key === key) return c._tables;
  const T = Math.min(3600, Math.ceil(c.endT + 2));
  const n = Math.ceil(T / DT) + 1;
  const ph = new Float32Array(n); const dx = new Float32Array(n); const dy = new Float32Array(n);
  let r0 = rates(c, 0, base, grav);
  for (let i = 1; i < n; i++) {
    const r1 = rates(c, i * DT, base, grav);
    ph[i] = ph[i - 1] + 0.5 * (r0.speed + r1.speed) * DT;
    dx[i] = dx[i - 1] + 0.5 * (r0.wx + r1.wx) * DT;
    dy[i] = dy[i - 1] + 0.5 * (r0.wy + r1.wy) * DT;
    r0 = r1;
  }
  c._tables = { key, T, n, ph, dx, dy, tail: r0 };
  return c._tables;
}

/**
 * Everything the GPU needs at time t.
 * base: { speed, wind, windY } from the panel. grav: +1 for things that fall, -1 for things that rise, 0 otherwise.
 */
export function sampleFx(c, t, base, grav = 0) {
  const out = { phase: 0, dx: 0, dy: 0, lx: base.wind, ly: base.windY ?? 0, size: 1, density: 1, turb: 1, glow: 1, tint: [0, 0, 0, 0], flash: [1, 1, 1, 0], bursts: [] };
  if (!c || c.static) {
    const speed = base.speed * (grav ? clamp(1 + 0.6 * (base.windY ?? 0) * grav, 0.15, 3) : 1);
    out.phase = t * speed; out.dx = base.wind * t; out.dy = (base.windY ?? 0) * t; return out;
  }
  const tb = tables(c, base, grav);
  if (t <= 0) { out.phase = t * base.speed; out.dx = t * base.wind; out.dy = t * (base.windY ?? 0); }
  else if (t >= tb.T) { const e = (t - tb.T); out.phase = tb.ph[tb.n - 1] + e * tb.tail.speed; out.dx = tb.dx[tb.n - 1] + e * tb.tail.wx; out.dy = tb.dy[tb.n - 1] + e * tb.tail.wy; }
  else { const f = t / DT; const i = Math.floor(f); const u = f - i; const j = Math.min(i + 1, tb.n - 1); out.phase = tb.ph[i] + (tb.ph[j] - tb.ph[i]) * u; out.dx = tb.dx[i] + (tb.dx[j] - tb.dx[i]) * u; out.dy = tb.dy[i] + (tb.dy[j] - tb.dy[i]) * u; }
  const r = rates(c, t, base, grav);
  out.lx = r.wx; out.ly = r.wy; out.size = r.size; out.density = r.density; out.turb = r.turb; out.glow = r.glow;
  const g = groupByType(c);
  // flash: strongest decaying flash, colour of the newest
  let fa = 0;
  for (const e of g.flash) { const u = t - e.t0; if (u < 0 || u > e.decay * 5) continue; const a = e.amp * Math.exp((-u * 3) / e.decay) * (u < 0.015 ? u / 0.015 : 1); if (a > fa) { fa = a; out.flash = [...e.rgb, 0]; } }
  out.flash[3] = Math.min(1, fa);
  // tint: the strongest active wash
  for (const e of g.tint) {
    const u = t - e.t0; if (u < 0 || u > e.dur) continue;
    const a = e.amt * smooth(u / Math.max(0.05, e.dur * 0.25)) * (1 - smooth((u - e.dur * 0.6) / Math.max(0.05, e.dur * 0.4)));
    if (a > out.tint[3]) out.tint = [...e.rgb, a];
  }
  for (const e of g.burst) { const age = t - e.t0; if (age >= 0 && age <= e.life) out.bursts.push({ age, life: e.life, count: e.count, ox: e.ox, oy: e.oy, spread: e.spread, power: e.power, ang: e.ang, seed: Math.floor(e.t0 * 1000) % 100000 }); }
  if (out.bursts.length > 8) out.bursts = out.bursts.slice(-8);
  return out;
}

/** A graph of the wind and speed over the song, for the editor: [{ t, wind, speed }] sampled `n` times. */
export function graphFx(c, base, grav, seconds, n = 240) {
  const out = [];
  for (let i = 0; i < n; i++) { const t = (i / (n - 1)) * seconds; const r = c.static ? { wx: base.wind, wy: base.windY ?? 0, speed: base.speed, density: 1 } : rates(c, t, base, grav); out.push({ t, wx: r.wx, wy: r.wy, speed: r.speed, density: r.density }); }
  return out;
}

// ---------- editor help: check, colour, suggest ----------

export function lintFx(text, { songSec = 0, tempo = null } = {}) {
  const c = compileFx(text, { tempo });
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const i of c.issues) {
    const ln = lines[i.line] ?? '';
    let fix = null; let from = 0; let to = ln.length;
    if (i.code === 'badverb') {
      const m = /^\s*\[[^\]]*\]\s*(\S+)/.exec(ln);
      if (m) { from = ln.indexOf(m[1], ln.indexOf(']')); to = from + m[1].length; const near = closestWord(m[1], Object.keys(FX_VERBS)); if (near) { i.msg += ` Did you mean ${near}?`; fix = { label: `Use ${near}`, from: m[1], to: near }; } }
    }
    out.push({ line: i.line, from, to, severity: i.severity, msg: i.msg, fix });
  }
  for (const e of c.events) {
    if (songSec && e.t0 > songSec + 0.01) out.push({ line: e.line, from: 0, to: (lines[e.line] ?? '').length, severity: 'info', msg: 'This starts after the song ends.' });
  }
  return out;
}

function closestWord(w, list) {
  w = w.toLowerCase(); let best = null;
  const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  for (const x of list) { const e = lev(w, x); if (e <= Math.max(1, Math.ceil(x.length / 3)) && (!best || e < best.e)) best = { x, e }; }
  return best?.x ?? null;
}

/** Apply a quick fix from lintFx: replace the first occurrence of fix.from after the time tag. */
export function applyFxFix(text, issue) {
  if (!issue.fix) return text;
  const lines = text.split('\n'); const ln = lines[issue.line] ?? '';
  const close = ln.indexOf(']'); const at = ln.indexOf(issue.fix.from, Math.max(0, close));
  if (at >= 0) lines[issue.line] = ln.slice(0, at) + issue.fix.to + ln.slice(at + issue.fix.from.length);
  return lines.join('\n');
}

/** Per-character classes for highlighting one line. */
export function classifyFx(line) {
  const cls = new Array(line.length).fill('');
  const mark = (a, b, c) => { for (let i = a; i < Math.min(b, line.length); i++) cls[i] = c; };
  if (/^\s*\/\//.test(line)) { mark(0, line.length, 'k-comment'); return cls; }
  const m = /^(\s*)(\[[^\]]*\]?)(\s*)(\S*)/.exec(line);
  if (!m) return cls;
  mark(m[1].length, m[1].length + m[2].length, 'k-time');
  const vs = m[1].length + m[2].length + m[3].length;
  mark(vs, vs + m[4].length, FX_VERBS[m[4].toLowerCase()] ? 'k-dir' : 'se-error');
  const re = /\{[^}]*\}?/g; let x; while ((x = re.exec(line))) mark(x.index, x.index + x[0].length, 'k-mods');
  const wr = /\b(left|right|up|down)\b|#[0-9a-f]{6}\b|\b(\d+(?:\.\d+)?)(ms|s|x)?\b/gi; let y;
  while ((y = wr.exec(line.slice(vs + m[4].length)))) { const s = vs + m[4].length + y.index; if (!cls[s]) mark(s, s + y[0].length, /^[a-z]/i.test(y[0]) ? 'k-opt' : 'k-val'); }
  return cls;
}

export function suggestFx(lineText, col) {
  const before = lineText.slice(0, col);
  let m;
  if ((m = /^\s*\[[^\]]*\]\s+(\w*)$/.exec(before))) return { prefix: m[1], replace: m[1], items: Object.keys(FX_VERBS).filter((k) => k.startsWith(m[1].toLowerCase())).map((k) => ({ label: k, insert: k })) };
  if ((m = /^\s*\[[^\]]*\]\s+(gust|wind|burst)\b.*\s(\w*)$/i.exec(before))) { const part = m[2].toLowerCase(); const pool = [...FX_DIRS, 'for', ...(m[1] === 'burst' ? ['at'] : ['over'])]; return { prefix: part, replace: m[2], items: pool.filter((k) => k.startsWith(part)).map((k) => ({ label: k, insert: k })) }; }
  if ((m = /^\s*\[[^\]]*\]\s+(tint|flash)\b.*\s(\w*)$/i.exec(before))) { const part = m[2].toLowerCase(); return { prefix: part, replace: m[2], items: Object.keys(FX_COLORS).filter((k) => k.startsWith(part)).map((k) => ({ label: k, insert: k })) }; }
  if ((m = /^\s*\[[^\]]*\]\s+pulse\b.*\s(\w*)$/i.exec(before))) { const part = m[1].toLowerCase(); return { prefix: part, replace: m[1], items: [...CHANNELS, 'every'].filter((k) => k.startsWith(part)).map((k) => ({ label: k, insert: k })) }; }
  if ((m = /\{([^}]*)$/.exec(before))) { const tok = /[^\s,]*$/.exec(m[1])[0]; return { prefix: tok, replace: tok, items: Object.keys(FX_MODS).map((k) => `${k}=`).filter((k) => k.startsWith(tok.toLowerCase())).map((k) => ({ label: k, insert: k })) }; }
  return null;
}

// ---------- ready-made scripts ----------

export const FX_TEMPLATES = [
  { id: 'breeze', name: 'Gentle breeze', icon: 'air', text: '// a soft breeze that comes and goes\n[0:08] gust right 0.4 for 4s\n[0:20] gust left 0.3 for 3s\n[0:32] gust right 0.5 for 5s' },
  { id: 'storm', name: 'Storm building', icon: 'thunderstorm', text: '// the weather turns\n[0:10] wind right 0.3 over 6s\n[0:20] density 1.5 over 4s\n[0:24] wind right 0.9 over 6s\n[0:26] flash white\n[0:33] flash cold\n[0:40] gust left 1.5 for 1.5s\n[0:48] calm over 5s' },
  { id: 'beat', name: 'Beat pulse', icon: 'graphic_eq', text: '// throbs with the tempo (set it in Audio > Tempo)\n[@1] pulse size 0.6 every beat\n[@1] pulse glow 0.5 every bar' },
  { id: 'chorus', name: 'Chorus bursts', icon: 'celebration', text: '// a burst on the first beat of bars 9 and 17\n[@9] burst 120 at 0.5,0.7 up\n[@9] flash 0.5\n[@17] burst 160 at 0.3,0.7 up\n[@17] burst 160 at 0.7,0.7 up' },
  { id: 'drop', name: 'Drop & calm', icon: 'trending_down', text: '// everything freezes, then rushes back\n[0:30] speed 0.15 over 1s\n[0:34] speed 3 over 0.2s\n[0:34] flash white\n[0:36] speed 1 over 3s' },
];
