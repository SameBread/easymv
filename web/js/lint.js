// Script checker. Reads the text line by line and reports things that would be silently ignored or probably not what was meant,
// so a typo like ::dcoe or motion=bunce shows up instead of quietly doing nothing.
// Pure: lintScript(text, { songSec, tempo }) -> [{ line, from, to, severity: 'error'|'warn'|'info', msg, fix? }]

import { LAYOUT_IDS, TRANSITION_IDS, PACK_IDS, DECO_NAMES, FX_NAMES, LOOK_NAMES, MOTION_IDS } from './kinetic.js';

export const DIRECTIVES = {
  align: ['left', 'center', 'right'], amp: 'number', at: 'any', bg: 'color', bgstyle: 'any', deco: 'deco', dur: 'number', emph: ['bar', 'color', 'none'],
  fx: 'fx', layout: LAYOUT_IDS, look: 'look', motion: MOTION_IDS, out: 'out', pal: 'number', reveal: ['auto', 'word', 'line'], speed: 'number', style: PACK_IDS,
  sync: ['beat', 'none'], trans: TRANSITION_IDS,
};
export const OPTIONS = { pack: PACK_IDS, energy: 'number', seed: 'number', font: 'any', layouts: 'any', place: 'any', at: 'any', deco: 'deco', look: 'look', fx: 'fx', amp: 'number', speed: 'number', sync: ['beat', 'none'] };
const MOD_KV = { size: 'number', color: 'color', colour: 'color', at: 'any', step: 'number', delay: 'number', motion: MOTION_IDS, align: ['left', 'center', 'centre', 'right'], anchor: ['top', 'middle', 'bottom'], max: 'number', role: 'any', fx: 'fx', sync: ['beat', 'none'], amp: 'number', speed: 'number', bold: 'any', italic: 'any', underline: 'any', strike: 'any' };
const MOD_BARE = new Set(['big', 'small', 'accent', 'dim', 'fg', ...FX_NAMES]);

/** Edit distance, for "did you mean". */
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function closest(word, list) {
  let best = null;
  for (const x of list) { const e = lev(String(word).toLowerCase(), String(x).toLowerCase()); if (e <= Math.max(1, Math.ceil(String(x).length / 3)) && (!best || e < best.e)) best = { x, e }; }
  return best?.x ?? null;
}
const isNum = (v) => v !== '' && Number.isFinite(Number(v));
const isColor = (v) => /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) || ['accent', 'dim', 'fg'].includes(v.toLowerCase());

function checkValue(kind, value, ctx, push) {
  const v = String(value ?? '').trim();
  if (kind === 'any') return;
  if (kind === 'number') { if (!isNum(v)) push(`“${v}” should be a number`); return; }
  if (kind === 'color') { if (!isColor(v)) push(`“${v}” is not a colour (use #rrggbb, accent, dim or fg)`); return; }
  if (kind === 'out') { if (!(isNum(v) || /^(cut|none)$/i.test(v))) push('use a number of seconds, or cut'); return; }
  if (kind === 'fx') { for (const n of v.split(/[+|,\s]+/).filter(Boolean)) if (!FX_NAMES.includes(n.toLowerCase()) && n.toLowerCase() !== 'none') { const c = closest(n, FX_NAMES); push(`unknown effect “${n}”${c ? ` — did you mean ${c}?` : ''}`, c ? { label: `Use ${c}`, from: n, to: c } : null); } return; }
  if (kind === 'look') {
    for (const n of v.split(/[\s,+]+/).filter(Boolean)) if (n.toLowerCase() !== 'none' && !LOOK_NAMES.includes(n.toLowerCase())) { const c = closest(n, LOOK_NAMES); push(`unknown look “${n}”${c ? ` — did you mean ${c}?` : ''}`, c ? { label: `Use ${c}`, from: n, to: c } : null); }
    return;
  }
  if (kind === 'deco') {
    const names = v.split(/[\s,+]+/).filter((x) => x && !/^(colou?r|w|width)[=:]/i.test(x));
    for (const n of names) if (n.toLowerCase() !== 'none' && !DECO_NAMES.includes(n.toLowerCase())) { const c = closest(n, DECO_NAMES); push(`unknown decoration “${n}”${c ? ` — did you mean ${c}?` : ''}`, c ? { label: `Use ${c}`, from: n, to: c } : null); }
    return;
  }
  if (Array.isArray(kind)) {
    if (!kind.some((k) => k.toLowerCase() === v.toLowerCase())) { const c = closest(v, kind); push(`“${v}” is not one of: ${kind.join(', ')}${c ? ` — did you mean ${c}?` : ''}`, c ? { label: `Use ${c}`, from: v, to: c } : null); }
  }
}

export function lintScript(text, { songSec = 0, tempo = null } = {}) {
  const out = [];
  const src = String(text).split(/\r?\n/);
  const add = (line, severity, msg, from = 0, to = null, fix = null) => out.push({ line, from, to: to ?? src[line]?.length ?? 0, severity, msg, fix });
  let sceneStart = 0; let sceneLines = 0; let sceneHasDir = false; let lastT = null; let lastStartLine = 0;
  const starts = []; let pendingBreak = false; let keepGoing = false;
  const endScene = () => { if (sceneHasDir && !sceneLines) add(lastStartLine, 'info', 'This scene has settings but no text, so nothing shows.'); sceneLines = 0; sceneHasDir = false; lastT = null; };

  src.forEach((raw, ln) => {
    const line = raw.trim();
    if (/^\/\//.test(line)) return;
    if (!line) { if (!keepGoing) pendingBreak = true; return; }
    if (/^\+{3,}$/.test(line)) { pendingBreak = false; keepGoing = true; if (ln === 0 || !sceneLines) add(ln, 'info', '+++ keeps the scene going across a blank line, but there is nothing before it here.'); return; }
    if (/^-{3,}$/.test(line)) { endScene(); pendingBreak = false; keepGoing = false; return; }
    if (pendingBreak) endScene();
    pendingBreak = false; keepGoing = false;
    let m;
    const off = raw.length - raw.trimStart().length;
    if ((m = /^@(\w+)\s*(.*)$/.exec(line))) {
      const key = m[1].toLowerCase();
      if (!(key in OPTIONS)) { const c = closest(key, Object.keys(OPTIONS)); add(ln, 'warn', `unknown option @${m[1]}${c ? ` — did you mean @${c}?` : ''}`, off, off + m[1].length + 1, c ? { label: `Use @${c}`, from: `@${m[1]}`, to: `@${c}` } : null); }
      else if (!m[2]) add(ln, 'warn', `@${key} needs a value`, off);
      else checkValue(OPTIONS[key], m[2], {}, (msg, fix) => add(ln, 'warn', `@${key}: ${msg}`, off, null, fix));
      return;
    }
    if ((m = /^::(\w+)\s*(.*)$/.exec(line))) {
      const key = m[1].toLowerCase(); sceneHasDir = true; lastStartLine = ln;
      if (!(key in DIRECTIVES)) { const c = closest(key, Object.keys(DIRECTIVES)); add(ln, 'warn', `unknown instruction ::${m[1]}${c ? ` — did you mean ::${c}?` : ''}`, off, off + m[1].length + 2, c ? { label: `Use ::${c}`, from: `::${m[1]}`, to: `::${c}` } : null); }
      else if (!m[2] && key !== 'deco') add(ln, 'warn', `::${key} needs a value`, off);
      else checkValue(DIRECTIVES[key], m[2], {}, (msg, fix) => add(ln, 'warn', `::${key}: ${msg}`, off, null, fix));
      return;
    }
    if (/^::|^@/.test(line)) return;
    // a content line
    lastStartLine = ln;
    sceneLines++;
    // times
    const bodyAt = (i) => raw.indexOf(i);
    const tm = /^\s*\[([^\]]*)\]/.exec(raw);
    let tStart = null; let tEnd = null;
    if (tm) {
      const parts = tm[1].split(/[-–>]/).map((x) => x.trim());
      const conv = (x) => {
        if (!x) return null;
        if (x[0] === '@') { if (!tempo) { add(ln, 'warn', 'A bar time like [@17] needs a tempo. Set it from the timeline: Tempo.', 0, tm[0].length); return null; } const q = /^@(\d+)(?:\.(\d+(?:\.\d+)?))?$/.exec(x); if (!q) { add(ln, 'error', `“${x}” is not a bar time (try @17 or @17.3)`, 0, tm[0].length); return null; } return (Number(q[1]) - 1) * tempo.sig + (q[2] != null ? Number(q[2]) - 1 : 0); }
        const q = /^(\d+):(\d+)(?:[.:](\d+))?$/.exec(x); if (!q) { add(ln, 'error', `“${x}” is not a time (try 0:12.5)`, 0, tm[0].length); return null; }
        return Number(q[1]) * 60 + Number(q[2]) + (q[3] ? Number(`0.${q[3]}`) : 0);
      };
      // bar times are measured in beats here, which is enough to compare order; absolute checks use seconds only
      const isBar = parts.some((x) => x[0] === '@');
      const a = conv(parts[0]); const b = parts[1] ? conv(parts[1]) : null;
      if (!isBar) { tStart = a; tEnd = b; }
      if (a != null && b != null && b <= a) add(ln, 'error', 'The end time is not after the start time.', 0, tm[0].length);
    }
    if (tStart != null) {
      if (songSec && tStart > songSec + 0.5) add(ln, 'warn', `This starts at ${tStart.toFixed(1)} s, after the song ends (${songSec.toFixed(1)} s).`, 0, tm[0].length);
      if (lastT != null && tStart < lastT - 0.001) add(ln, 'warn', 'This line is timed earlier than the line before it in the same scene. Put it in its own scene or fix the time.', 0, tm[0].length);
      lastT = tStart;
      starts.push({ t: tStart, ln });
    }
    // brackets and emphasis
    const opens = (raw.match(/\{/g) ?? []).length; const closes = (raw.match(/\}/g) ?? []).length;
    if (opens !== closes) add(ln, 'warn', opens > closes ? 'A { is never closed.' : 'A } has no matching {.', 0);
    if (((raw.match(/\*\*/g) ?? []).length) % 2) add(ln, 'warn', 'Unpaired ** (emphasis markers come in pairs).', 0);
    // {mods}
    const re = /\{([^}]*)\}/g; let mm;
    while ((mm = re.exec(raw))) {
      const at0 = mm.index + 1; let pos = 0;
      for (const tok of mm[1].split(/(\s+|,)/)) {
        const from = at0 + pos; pos += tok.length;
        if (!tok.trim() || tok === ',') continue;
        const kv = /^(\w+)[=:](.*)$/.exec(tok);
        if (kv) {
          const key = kv[1].toLowerCase();
          if (!(key in MOD_KV)) { const c = closest(key, Object.keys(MOD_KV)); add(ln, 'warn', `unknown word setting “${kv[1]}”${c ? ` — did you mean ${c}?` : ''}`, from, from + tok.length, c ? { label: `Use ${c}`, from: `${kv[1]}${tok[kv[1].length]}`, to: `${c}${tok[kv[1].length]}` } : null); }
          else checkValue(MOD_KV[key], kv[2], {}, (msg, fix) => add(ln, 'warn', `${key}: ${msg}`, from, from + tok.length, fix));
        } else {
          const k = tok.toLowerCase();
          if (!MOD_BARE.has(k) && !/^[A-Ca-c][1-3]$/.test(tok)) { const c = closest(k, [...MOD_BARE]); add(ln, 'warn', `“${tok}” does nothing here${c ? ` — did you mean ${c}?` : ''}`, from, from + tok.length, c ? { label: `Use ${c}`, from: tok, to: c } : null); }
        }
      }
    }
    void bodyAt; void sceneStart;
  });
  endScene();
  // two scenes starting at the same moment draw on top of each other
  const seen = new Map();
  for (const s of starts) { const k = s.t.toFixed(2); if (seen.has(k) && seen.get(k) !== s.ln) add(s.ln, 'info', `Another line also starts at ${k} s, so they appear together.`); else seen.set(k, s.ln); }
  return out.sort((a, b) => a.line - b.line || a.from - b.from);
}

/** Apply a quick fix returned by lintScript to the text. */
export function applyFix(text, issue) {
  if (!issue.fix) return text;
  const src = String(text).split(/\r?\n/);
  src[issue.line] = src[issue.line].replace(issue.fix.from, issue.fix.to);
  return src.join('\n');
}

/** Suggestions for what to type next at a position in a line, for the editor's suggestion bar. */
export function suggest(lineText, col) {
  const before = lineText.slice(0, col);
  let m;
  if ((m = /^\s*::(\w*)$/.exec(before))) return { prefix: m[1], replace: '::' + m[1], items: Object.keys(DIRECTIVES).filter((k) => k.startsWith(m[1].toLowerCase())).map((k) => ({ label: `::${k}`, insert: `::${k} ` })) };
  if ((m = /^\s*@(\w*)$/.exec(before))) return { prefix: m[1], replace: '@' + m[1], items: Object.keys(OPTIONS).filter((k) => k.startsWith(m[1].toLowerCase())).map((k) => ({ label: `@${k}`, insert: `@${k} ` })) };
  if ((m = /^\s*::(\w+)\s+([\w+\-]*)$/.exec(before))) {
    const key = m[1].toLowerCase(); const spec = DIRECTIVES[key]; const part = m[2];
    const pool = Array.isArray(spec) ? spec : spec === 'fx' ? FX_NAMES : spec === 'deco' ? DECO_NAMES : spec === 'look' ? LOOK_NAMES : [];
    const head = part.includes('+') ? part.slice(0, part.lastIndexOf('+') + 1) : ''; const tail = part.slice(head.length);
    return { prefix: tail, replace: part, items: pool.filter((x) => x.startsWith(tail.toLowerCase())).map((x) => ({ label: x, insert: head + x })) };
  }
  if ((m = /\{([^}]*)$/.exec(before))) {
    const inner = m[1]; const tok = /[^\s,]*$/.exec(inner)[0];
    const kv = /^(\w+)[=:](.*)$/.exec(tok);
    if (kv) {
      const key = kv[1].toLowerCase(); const spec = MOD_KV[key]; const pool = Array.isArray(spec) ? spec : spec === 'fx' ? FX_NAMES : [];
      const head = kv[2].includes('+') ? kv[2].slice(0, kv[2].lastIndexOf('+') + 1) : ''; const tail = kv[2].slice(head.length);
      return { prefix: tail, replace: kv[2], items: pool.filter((x) => x.toLowerCase().startsWith(tail.toLowerCase())).map((x) => ({ label: x, insert: head + x })) };
    }
    const keys = [...Object.keys(MOD_KV).map((k) => `${k}=`), ...MOD_BARE];
    return { prefix: tok, replace: tok, items: keys.filter((k) => k.startsWith(tok.toLowerCase())).slice(0, 14).map((k) => ({ label: k, insert: k })) };
  }
  return null;
}
