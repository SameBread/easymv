// Pure text helpers for script layers: rewrite times, scene settings and convert to/from LRC and
// closed captions. The script text is the single source of truth, so every manual control edits it.

import { parseScript } from './kinetic.js';
import { parseLrc } from './lyrics.js';

export function fmtT(t) {
  const x = Math.max(0, Math.round(t * 100) / 100);
  const m = Math.floor(x / 60); const s = x - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
const TAG = /^(\s*)\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?(?:\s*[-–>]\s*\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)?\]\s*/;
const stripTag = (l) => l.replace(TAG, '$1');
const lines = (text) => String(text).split(/\r?\n/);

/** Plain words of a script line: markup (heading marks, bullets, quotes, **) removed. */
export function plain(body) {
  return body.replace(/^\s*(#{1,2}\s+|[-*•]\s+|\d+[.)]\s+|>\s*|--\s*)/, '').replace(/\*\*/g, '').replace(/\[([^\]]+)\]\{[^}]*\}/g, '$1').replace(/\s*\{[^}]*\}/g, '').replace(/~\d*\.?\d+/g, '').replace(/\|/g, '').trim();
}

/** Every content line of the script, in order: { k, idx, scene, t, t1, text }. */
export function listLines(text) {
  const out = [];
  const sc = parseScript(text).scenes;
  const src = lines(text);
  sc.forEach((s, si) => s.lines.forEach((l, li) => {
    const t = li === 0 ? s.t : l.t;
    out.push({ k: out.length, idx: l.idx, scene: si, first: li === 0, t, t1: l.t1, text: plain(stripTag(src[l.idx])) });
  }));
  return out;
}

/** Set (or clear with null) the start and end time of content line k. undefined keeps the old value. */
export function setLineTime(text, k, { t, t1 } = {}) {
  const all = listLines(text); const it = all[k]; if (!it) return text;
  const src = lines(text);
  const nt = t === undefined ? it.t : t;
  const n1 = t1 === undefined ? it.t1 : t1;
  const body = stripTag(src[it.idx]).trimStart();
  const indent = /^\s*/.exec(src[it.idx])[0];
  let tag = '';
  if (nt != null) tag = n1 != null && n1 > nt ? `[${fmtT(nt)}-${fmtT(n1)}] ` : `[${fmtT(nt)}] `;
  src[it.idx] = `${indent}${tag}${body}`;
  return src.join('\n');
}

/** Scene setting (::key value) of scene si, or null. */
export function getDir(text, si, key) {
  return parseScript(text).scenes[si]?.dir[key] ?? null;
}
/** Set or remove (empty value) a scene setting line. */
export function setDir(text, si, key, value) {
  const sc = parseScript(text).scenes[si]; if (!sc) return text;
  const src = lines(text);
  const at = sc.dirIdx[key];
  if (at != null) { if (value) src[at] = `::${key} ${value}`; else src.splice(at, 1); }
  else if (value) { const last = Math.max(...sc.src); src.splice(last + 1, 0, `::${key} ${value}`); }
  return src.join('\n');
}

/** Scenes as short rows for a list: { i, text, t }. */
export function sceneRows(text) {
  return parseScript(text).scenes.map((s, i) => ({ i, t: s.t, text: s.lines.map((l) => l.words.map((w) => w.t).join(' ')).join(' / ') }));
}

/** Group timed lines {t0,t1,text} into scenes: a gap longer than `gap` seconds starts a new scene. */
export function linesToScript(list, { gap = 1.6, maxLines = 3, header = '' } = {}) {
  const timed = list.filter((l) => l.t0 != null && String(l.text).trim());
  const out = []; let n = 0; let prevEnd = null;
  timed.forEach((l, i) => {
    const next = timed[i + 1];
    let t1 = l.t1 ?? null;
    if (t1 == null && !next) t1 = l.t0 + 4;
    const newScene = i === 0 || n >= maxLines || l.t0 - (prevEnd ?? l.t0) > gap || /[.!?]$/.test(timed[i - 1].text.trim());
    if (newScene) { if (out.length) out.push(''); n = 0; }
    out.push(`[${fmtT(l.t0)}${t1 != null ? `-${fmtT(t1)}` : ''}] ${l.text.trim()}`);
    n++; prevEnd = l.t0;
  });
  return `${header ? `${header}\n\n` : ''}${out.join('\n')}`;
}
export const lrcToScript = (lrc, opts) => linesToScript(parseLrc(lrc).map((l) => ({ t0: l.t0, t1: l.t1 ?? null, text: l.text })), opts);

/** Closed-caption lines from a script: one per content line that has a start time. */
export function scriptToLines(text) {
  return listLines(text).map((l) => ({ t0: l.t, t1: l.t1 ?? undefined, text: l.text })).filter((l) => l.text);
}
export function scriptToLrc(text) {
  return listLines(text).filter((l) => l.t != null).map((l) => `[${fmtT(l.t).padStart(8, '0')}]${l.text}`).join('\n');
}
