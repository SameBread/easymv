// A Slideshow is a folder of layers (slide artwork, charts, tables, text) owned by one master layer.
// The master's `deck` model is the only place that decides WHEN things happen; every child is rebuilt from it.
// This file is pure (no DOM, no state) so the timing rules can be unit-tested.
//
//   deck = {
//     start: 0,                 // seconds: when the first slide appears
//     end: null,                // seconds: the slideshow is gone by then (null = song end / natural length)
//     mode: 'reading' | 'fixed' | 'even' | 'weighted',
//     fixed: 5,                 // seconds per slide for 'fixed' and for slides with no text
//     fade: 0.4,                // overlap / transition length
//     trans: 'fade',            // default transition
//     scriptHead: '@pack editorial',
//     script: 'layer-id' | null,
//     slides: [{ title, hidden, dur: null|seconds, trans: null|id, art: layerId|null, objects: [ids],
//                pages: [{ w: seconds of reading, head: ['::trans fade', …], lines: ['text {mods}', …] }] }],
//   }

import { fmtT } from './scripttext.js';
import { normTempo, beatAt, timeAt } from './tempo.js';

export const DECK_MODES = [
  ['reading', 'Reading time', 'Each slide stays as long as its text takes to read'],
  ['fixed', 'Same seconds each', 'Every slide gets the same number of seconds'],
  ['even', 'Even across the window', 'Slides share the time between Start and End equally (the song length if End is left open)'],
  ['beats', 'On the beat', 'Every slide lasts the same number of beats of the song’s tempo, so cuts land on the beat (set the tempo first)'],
  ['weighted', 'By text across the window', 'Slides share the time between Start and End, wordier slides get more'],
];
export const DECK_TRANS = [
  ['fade', 'Crossfade'], ['dissolve', 'Dissolve'], ['zoom', 'Zoom in'], ['push', 'Push left'], ['rise', 'Rise up'], ['cut', 'Cut'],
];
export const DECK_DEFAULTS = { start: 0, end: null, mode: 'reading', fixed: 5, beats: 8, fade: 0.4, trans: 'fade', scriptHead: '@pack editorial', script: null, slides: [] };
export const deckSettings = (d) => ({ ...DECK_DEFAULTS, ...d, slides: d?.slides ?? [] });

const MIN_DUR = 0.4;

/** Natural length of a slide in seconds under the deck's mode. */
export function naturalSeconds(slide, deck) {
  if (deck.mode === 'fixed' || deck.mode === 'beats') return deck.fixed;
  const w = (slide.pages ?? []).reduce((a, p) => a + Math.max(0.5, p.w ?? 0), 0);
  return w > 0 ? w : deck.fixed;
}

/**
 * When does everything happen? Returns, per slide (null for hidden ones), `{ t0, t1, pages: [{ t0, t1 }] }`.
 * `songSec` is the length of the song (0 when there is none). Manual per-slide durations are honoured first and the rest
 * is spread over what remains of the window. An explicit End is a hard limit: natural timings are only ever compressed to fit it.
 */
export function deckSpans(deckIn, { songSec = 0, tempo = null } = {}) {
  const deck = deckSettings(deckIn);
  const tp = normTempo(tempo);
  const shown = deck.slides.map((s) => !s.hidden);
  const n = shown.filter(Boolean).length;
  const start = Math.max(0, Number(deck.start) || 0);
  const limit = deck.end != null && Number(deck.end) > start ? Number(deck.end) : null;
  const spread = deck.mode === 'even' || deck.mode === 'weighted';
  const onBeat = deck.mode === 'beats' && tp;
  const windowEnd = limit ?? (spread && songSec > start ? songSec : null);
  const manual = (s) => (s.dur > 0 ? Number(s.dur) : null);
  const dur = deck.slides.map(() => 0);
  let startShift = 0;
  if (n && onBeat) {
    // slides are N beats long and the first one starts on the nearest beat, so every cut lands on the grid
    const N = Math.max(0.25, Number(deck.beats) || 4); let t = timeAt(Math.round(beatAt(start, tp)), tp);
    deck.slides.forEach((s, i) => { if (!shown[i]) return; const t1 = manual(s) ? t + manual(s) : timeAt(beatAt(t, tp) + N, tp); dur[i] = t1 - t; t = t1; });
    if (limit) { const total = dur.reduce((a, b) => a + b, 0); const avail = limit - start; if (total > avail) { const k = avail / total; deck.slides.forEach((s, i) => { dur[i] *= k; }); } }
    startShift = timeAt(Math.round(beatAt(start, tp)), tp) - start;
  } else if (n) {
    if (spread && windowEnd) {
      const used = deck.slides.reduce((a, s, i) => a + (shown[i] && manual(s) ? manual(s) : 0), 0);
      const free = deck.slides.map((s, i) => shown[i] && !manual(s));
      const avail = Math.max(MIN_DUR * free.filter(Boolean).length, windowEnd - start - used);
      const wt = deck.slides.map((s, i) => (free[i] ? (deck.mode === 'weighted' ? Math.max(1, naturalSeconds(s, { ...deck, mode: 'reading' })) : 1) : 0));
      const sum = wt.reduce((a, b) => a + b, 0) || 1;
      deck.slides.forEach((s, i) => { if (shown[i]) dur[i] = manual(s) ?? Math.max(MIN_DUR, (avail * wt[i]) / sum); });
    } else {
      deck.slides.forEach((s, i) => { if (shown[i]) dur[i] = manual(s) ?? naturalSeconds(s, deck); });
      if (limit) {
        const total = dur.reduce((a, b) => a + b, 0); const avail = limit - start;
        if (total > avail) {
          const fixedTot = deck.slides.reduce((a, s, i) => a + (shown[i] && manual(s) ? manual(s) : 0), 0);
          const flex = total - fixedTot;
          const k = flex > 0 ? Math.max(0.05, (avail - fixedTot) / flex) : avail / total;
          deck.slides.forEach((s, i) => { if (shown[i]) dur[i] = flex > 0 ? (manual(s) ?? Math.max(MIN_DUR, dur[i] * k)) : dur[i] * k; });
        }
      }
    }
  }
  let t = start + startShift;
  const slides = deck.slides.map((s, i) => {
    if (!shown[i]) return null;
    const t0 = t; t += dur[i];
    const pages = s.pages ?? []; const tw = pages.reduce((a, p) => a + Math.max(0.5, p.w ?? 0), 0) || 1;
    let pt = t0;
    return { t0, t1: t, pages: pages.map((p) => { const a = pt; pt += (dur[i] * Math.max(0.5, p.w ?? 0)) / tw; return { t0: a, t1: pt }; }) };
  });
  return { slides, start: start + startShift, end: t, total: t, limit, windowEnd };
}

/** The deck's transition name -> the script engine's transition. */
export const scriptTrans = (t) => ({ fade: 'fade', dissolve: 'fade', zoom: 'zoom', push: 'push', rise: 'cover', cut: 'cut' }[t] ?? 'fade');

/** Text of the deck's script layer, with every page timed from `spans`. */
export function buildDeckScript(deckIn, spans) {
  const deck = deckSettings(deckIn);
  const out = [deck.scriptHead ?? '@pack editorial', ''];
  deck.slides.forEach((s, i) => {
    const sp = spans.slides[i]; if (!sp) return;
    (s.pages ?? []).forEach((pg, k) => {
      const lines = (pg.lines ?? []).filter(Boolean); if (!lines.length) return;
      const w = sp.pages[k]; const head = (pg.head ?? []).filter((h) => !(s.trans && /^::trans\b/.test(h)));
      if (s.trans) head.unshift(`::trans ${scriptTrans(s.trans)}`);
      const body = [...lines]; body[0] = `[${fmtT(w.t0)}-${fmtT(Math.max(w.t0 + 0.3, w.t1 - 0.05))}] ${body[0]}`;
      out.push('---', ...head, ...body, '');
    });
  });
  return out.join('\n').replace(/^---\n/m, '').trimEnd();
}

/**
 * Keyframes for one piece of slide artwork. `spans` are [t0, t1] in seconds (one per slide that uses it).
 * Returns { visible: [[t0, t1]…], tracks: { property: keys[] } } in seconds; the caller converts to frames.
 */
export function artMotion(spans, trans, fade = 0.4) {
  const vis = []; const tr = { opacity: [], scale: [], positionX: [], positionY: [] };
  const key = (arr, t, v) => arr.push({ t, v });
  for (const [a, b] of spans) {
    if (trans === 'cut') { vis.push([a, b]); continue; }
    const tail = trans === 'push' || trans === 'rise' ? fade * 1.25 : fade;
    vis.push([a, b + tail]);
    if (trans === 'push') {
      key(tr.positionX, a, 1.5); key(tr.positionX, a + fade * 1.25, 0.5); key(tr.positionX, Math.max(a + fade * 1.25, b), 0.5); key(tr.positionX, b + tail, -0.5);
    } else if (trans === 'rise') {
      key(tr.positionY, a, 1.5); key(tr.positionY, a + fade * 1.25, 0.5); key(tr.positionY, Math.max(a + fade * 1.25, b), 0.5); key(tr.positionY, b + tail, -0.5);
    } else {
      key(tr.opacity, a, 0); key(tr.opacity, a + fade, 1); key(tr.opacity, Math.max(a + fade, b), 1); key(tr.opacity, b + fade, 0);
      if (trans === 'zoom') { key(tr.scale, a, 1.18); key(tr.scale, a + fade * 1.6, 1); key(tr.scale, b + fade, 1.04); }
      else if (trans === 'fade') { key(tr.scale, a, 1); key(tr.scale, b + fade, 1.045); }
    }
  }
  return { visible: vis, tracks: Object.fromEntries(Object.entries(tr).filter(([, v]) => v.length)) };
}

/** Keys for a chart/table "Reveal" (intensity) that grows in shortly after the slide appears. */
export function objectMotion(a, order, trans, animate = true) {
  const t0 = trans === 'cut' ? a : a + 0.35 + order * 0.35;
  return [{ t: a, v: 0 }, { t: t0, v: 0 }, { t: t0 + (animate && trans !== 'cut' ? 0.9 : 0.05), v: 1 }];
}

export const clockText = (s) => fmtT(Math.max(0, s));
/** "1:23", "1:23.5", "83" -> seconds (NaN when unreadable). */
export function parseClock(str) {
  const t = String(str ?? '').trim(); if (!t) return NaN;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return NaN;
  return t.includes(':') ? Number(m[1] ?? 0) * 60 + Number(m[2]) : Number(m[2]);
}
