// Vector graphics shared by every workflow: preset shapes, charts and tables, drawn with the 2D canvas API.
// The PowerPoint importer, the native Shape / Chart / Table layers and the renderer all use these same functions,
// so a chart looks the same whether it came from a slide deck or was added by hand to a music video.
//
// Everything that decides geometry is pure (no canvas needed) so it can be unit-tested in Node:
//   presetPath(prst, w, h, adj) -> { cmds, open }   path commands: ['M',x,y] ['L',x,y] ['C',..6] ['A',cx,cy,rx,ry,a0,a1,ccw] ['Z']
//   niceScale(min, max, ticks)  -> { min, max, step }
//   parseRich(text)             -> runs [{ t, b, i, u, s }]
//   layoutChart / resolveTable  -> plain data describing what will be drawn

const TAU = Math.PI * 2;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- rich text ----------

/** `**bold** <i>italic</i> <u>underline</u> <s>strike</s> __u__ ~~s~~` -> runs. Tags may nest and span words. */
export function parseRich(text) {
  const st = { b: false, i: false, u: false, s: false };
  const runs = [];
  const re = /<(\/?)([biusBIUS])>|\*\*|__|~~/g;
  let last = 0; let m;
  const emit = (t) => { if (t) runs.push({ t, ...(st.b ? { b: true } : null), ...(st.i ? { i: true } : null), ...(st.u ? { u: true } : null), ...(st.s ? { s: true } : null) }); };
  while ((m = re.exec(String(text ?? '')))) {
    emit(String(text).slice(last, m.index)); last = m.index + m[0].length;
    if (m[2]) st[m[2].toLowerCase()] = !m[1];
    else if (m[0] === '**') st.b = !st.b;
    else if (m[0] === '__') st.u = !st.u;
    else st.s = !st.s;
  }
  emit(String(text ?? '').slice(last));
  return runs;
}

/** Plain text of a run list. */
export const runsText = (runs) => runs.map((r) => r.t).join('');

// ---------- preset shapes ----------

const poly = (pts) => pts.map(([x, y], i) => [i ? 'L' : 'M', x, y]).concat([['Z']]);
const regular = (n, w, h, rot = -Math.PI / 2) => poly(Array.from({ length: n }, (_, i) => [w / 2 + (Math.cos(rot + (i * TAU) / n) * w) / 2, h / 2 + (Math.sin(rot + (i * TAU) / n) * h) / 2]));
const star = (n, w, h, inner) => poly(Array.from({ length: n * 2 }, (_, i) => { const r = i % 2 ? inner : 1; const an = -Math.PI / 2 + (i * Math.PI) / n; return [w / 2 + (Math.cos(an) * r * w) / 2, h / 2 + (Math.sin(an) * r * h) / 2]; }));
const ell = (w, h, ccw = false) => [['M', w, h / 2], ['A', w / 2, h / 2, w / 2, h / 2, 0, TAU, ccw], ['Z']];
const rrect = (x, y, w, h, tl, tr, br, bl) => [['M', x + tl, y], ['L', x + w - tr, y], ...(tr ? [['A', x + w - tr, y + tr, tr, tr, -Math.PI / 2, 0, false]] : []), ['L', x + w, y + h - br], ...(br ? [['A', x + w - br, y + h - br, br, br, 0, Math.PI / 2, false]] : []),
  ['L', x + bl, y + h], ...(bl ? [['A', x + bl, y + h - bl, bl, bl, Math.PI / 2, Math.PI, false]] : []), ['L', x, y + tl], ...(tl ? [['A', x + tl, y + tl, tl, tl, Math.PI, Math.PI * 1.5, false]] : []), ['Z']];
const arcPts = (cx, cy, rx, ry, a0, a1, n = 24) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]; });
const wedge = (cx, cy, rx, ry, a0, a1) => poly([[cx, cy], ...arcPts(cx, cy, rx, ry, a0, a1)]);
const deg = (d) => (d * Math.PI) / 180;

/** Callout body plus a tail pointing at (tx, ty), both in box coordinates. */
function calloutTail(body, w, h, tx, ty) {
  const cx = w / 2; const cy = h / 2;
  const dx = tx - cx; const dy = ty - cy;
  const horiz = Math.abs(dx) / Math.max(1, w) > Math.abs(dy) / Math.max(1, h);
  const pts = horiz
    ? (dx > 0 ? [[w, dy < 0 ? h / 6 : h * 7 / 12], [tx, ty], [w, dy < 0 ? h * 5 / 12 : h * 5 / 6]] : [[0, dy < 0 ? h / 6 : h * 7 / 12], [tx, ty], [0, dy < 0 ? h * 5 / 12 : h * 5 / 6]])
    : (dy > 0 ? [[dx < 0 ? w / 6 : w * 7 / 12, h], [tx, ty], [dx < 0 ? w * 5 / 12 : w * 5 / 6, h]] : [[dx < 0 ? w / 6 : w * 7 / 12, 0], [tx, ty], [dx < 0 ? w * 5 / 12 : w * 5 / 6, 0]]);
  return [...body, ...poly(pts)];
}

const PRESETS = {
  rect: (w, h) => poly([[0, 0], [w, 0], [w, h], [0, h]]),
  roundRect: (w, h, a) => { const r = Math.min(w, h) * a('adj', 16667); return rrect(0, 0, w, h, r, r, r, r); },
  round1Rect: (w, h, a) => { const r = Math.min(w, h) * a('adj', 16667); return rrect(0, 0, w, h, 0, r, 0, 0); },
  round2SameRect: (w, h, a) => { const r = Math.min(w, h) * a('adj1', 16667); const r2 = Math.min(w, h) * a('adj2', 0); return rrect(0, 0, w, h, r, r, r2, r2); },
  round2DiagRect: (w, h, a) => { const r = Math.min(w, h) * a('adj1', 16667); const r2 = Math.min(w, h) * a('adj2', 0); return rrect(0, 0, w, h, r, r2, r, r2); },
  snip1Rect: (w, h, a) => { const o = Math.min(w, h) * a('adj', 16667); return poly([[0, 0], [w - o, 0], [w, o], [w, h], [0, h]]); },
  snip2SameRect: (w, h, a) => { const o = Math.min(w, h) * a('adj1', 16667); return poly([[o, 0], [w - o, 0], [w, o], [w, h], [0, h], [0, o]]); },
  snipRoundRect: (w, h, a) => { const o = Math.min(w, h) * a('adj2', 16667); return poly([[0, 0], [w - o, 0], [w, o], [w, h], [0, h]]); },
  plaque: (w, h, a) => { const o = Math.min(w, h) * a('adj', 16667); return [['M', o, 0], ['L', w - o, 0], ['A', w, 0, o, o, Math.PI, Math.PI / 2, true], ['L', w, h - o], ['A', w, h, o, o, -Math.PI / 2, -Math.PI, true], ['L', o, h], ['A', 0, h, o, o, 0, -Math.PI / 2, true], ['L', 0, o], ['A', 0, 0, o, o, Math.PI / 2, 0, true], ['Z']]; },
  ellipse: (w, h) => ell(w, h),
  triangle: (w, h, a) => poly([[w * a('adj', 50000), 0], [w, h], [0, h]]),
  rtTriangle: (w, h) => poly([[0, 0], [w, h], [0, h]]),
  diamond: (w, h) => poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]),
  parallelogram: (w, h, a) => { const o = Math.min(w, h) * a('adj', 25000); return poly([[o, 0], [w, 0], [w - o, h], [0, h]]); },
  trapezoid: (w, h, a) => { const o = Math.min(w, h) * a('adj', 25000); return poly([[o, 0], [w - o, 0], [w, h], [0, h]]); },
  pentagon: (w, h) => regular(5, w, h),
  hexagon: (w, h, a) => { const o = Math.min(w, h) * a('adj', 25000) * 1.0; const oo = Math.min(o, w / 2); return poly([[oo, 0], [w - oo, 0], [w, h / 2], [w - oo, h], [oo, h], [0, h / 2]]); },
  heptagon: (w, h) => regular(7, w, h),
  octagon: (w, h, a) => { const o = Math.min(w, h) * a('adj', 29289); return poly([[o, 0], [w - o, 0], [w, o], [w, h - o], [w - o, h], [o, h], [0, h - o], [0, o]]); },
  decagon: (w, h) => regular(10, w, h),
  dodecagon: (w, h) => regular(12, w, h),
  star4: (w, h, a) => star(4, w, h, a('adj', 12500) * 2),
  star5: (w, h) => star(5, w, h, 0.382),
  star6: (w, h, a) => star(6, w, h, a('adj', 28868) * 1.7),
  star7: (w, h) => star(7, w, h, 0.45),
  star8: (w, h, a) => star(8, w, h, a('adj', 37500) * 1.3),
  star10: (w, h) => star(10, w, h, 0.62),
  star12: (w, h) => star(12, w, h, 0.72),
  star16: (w, h) => star(16, w, h, 0.8),
  star24: (w, h) => star(24, w, h, 0.86),
  chevron: (w, h, a) => { const o = Math.min(w, h) * a('adj', 50000); return poly([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h], [o, h / 2]]); },
  homePlate: (w, h, a) => { const o = Math.min(w, h) * a('adj', 50000); return poly([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h]]); },
  rightArrow: (w, h, a) => { const hh = (h * a('adj1', 50000)) / 2; const hd = Math.min(w, h) * a('adj2', 50000); return poly([[0, h / 2 - hh], [w - hd, h / 2 - hh], [w - hd, 0], [w, h / 2], [w - hd, h], [w - hd, h / 2 + hh], [0, h / 2 + hh]]); },
  leftArrow: (w, h, a) => { const hh = (h * a('adj1', 50000)) / 2; const hd = Math.min(w, h) * a('adj2', 50000); return poly([[w, h / 2 - hh], [hd, h / 2 - hh], [hd, 0], [0, h / 2], [hd, h], [hd, h / 2 + hh], [w, h / 2 + hh]]); },
  upArrow: (w, h, a) => { const ww = (w * a('adj1', 50000)) / 2; const hd = Math.min(w, h) * a('adj2', 50000); return poly([[w / 2 - ww, h], [w / 2 - ww, hd], [0, hd], [w / 2, 0], [w, hd], [w / 2 + ww, hd], [w / 2 + ww, h]]); },
  downArrow: (w, h, a) => { const ww = (w * a('adj1', 50000)) / 2; const hd = Math.min(w, h) * a('adj2', 50000); return poly([[w / 2 - ww, 0], [w / 2 - ww, h - hd], [0, h - hd], [w / 2, h], [w, h - hd], [w / 2 + ww, h - hd], [w / 2 + ww, 0]]); },
  leftRightArrow: (w, h, a) => { const hh = (h * a('adj1', 50000)) / 2; const hd = Math.min(w, h) * a('adj2', 50000); return poly([[0, h / 2], [hd, 0], [hd, h / 2 - hh], [w - hd, h / 2 - hh], [w - hd, 0], [w, h / 2], [w - hd, h], [w - hd, h / 2 + hh], [hd, h / 2 + hh], [hd, h]]); },
  upDownArrow: (w, h, a) => { const ww = (w * a('adj1', 50000)) / 2; const hd = Math.min(w, h) * a('adj2', 50000); return poly([[w / 2, 0], [w, hd], [w / 2 + ww, hd], [w / 2 + ww, h - hd], [w, h - hd], [w / 2, h], [0, h - hd], [w / 2 - ww, h - hd], [w / 2 - ww, hd], [0, hd]]); },
  notchedRightArrow: (w, h, a) => { const hh = (h * a('adj1', 50000)) / 2; const hd = Math.min(w, h) * a('adj2', 50000); const n = hh * 0.8; return poly([[0, h / 2 - hh], [w - hd, h / 2 - hh], [w - hd, 0], [w, h / 2], [w - hd, h], [w - hd, h / 2 + hh], [0, h / 2 + hh], [n, h / 2]]); },
  plus: (w, h, a) => { const o = Math.min(w, h) * a('adj', 25000); return poly([[o, 0], [w - o, 0], [w - o, o], [w, o], [w, h - o], [w - o, h - o], [w - o, h], [o, h], [o, h - o], [0, h - o], [0, o], [o, o]]); },
  mathPlus: (w, h, a) => { const t = Math.min(w, h) * a('adj1', 23520) * 0.5; return poly([[w / 2 - t, h * 0.1], [w / 2 + t, h * 0.1], [w / 2 + t, h / 2 - t], [w * 0.9, h / 2 - t], [w * 0.9, h / 2 + t], [w / 2 + t, h / 2 + t], [w / 2 + t, h * 0.9], [w / 2 - t, h * 0.9], [w / 2 - t, h / 2 + t], [w * 0.1, h / 2 + t], [w * 0.1, h / 2 - t], [w / 2 - t, h / 2 - t]]); },
  mathMinus: (w, h, a) => { const t = Math.min(w, h) * a('adj1', 23520) * 0.5; return poly([[w * 0.1, h / 2 - t], [w * 0.9, h / 2 - t], [w * 0.9, h / 2 + t], [w * 0.1, h / 2 + t]]); },
  mathEqual: (w, h, a) => { const t = Math.min(w, h) * a('adj1', 23520) * 0.4; const g = h * 0.16; return [...poly([[w * 0.1, h / 2 - g - t], [w * 0.9, h / 2 - g - t], [w * 0.9, h / 2 - g + t], [w * 0.1, h / 2 - g + t]]), ...poly([[w * 0.1, h / 2 + g - t], [w * 0.9, h / 2 + g - t], [w * 0.9, h / 2 + g + t], [w * 0.1, h / 2 + g + t]])]; },
  mathMultiply: (w, h, a) => { const t = Math.min(w, h) * a('adj1', 23520) * 0.32; const c = [w / 2, h / 2]; const d = Math.min(w, h) * 0.4; const r = (sx, sy) => [c[0] + sx, c[1] + sy];
    return poly([r(-d - t, -d + t), r(-t, 0), r(-d - t, d - t), r(-d + t, d + t), r(0, t), r(d - t, d + t), r(d + t, d - t), r(t, 0), r(d + t, -d + t), r(d - t, -d - t), r(0, -t), r(-d + t, -d - t)]); },
  heart: (w, h) => [['M', w / 2, h * 0.28], ['C', w * 0.5, h * 0.05, w * 0.1, 0, w * 0.04, h * 0.3], ['C', 0, h * 0.55, w * 0.3, h * 0.75, w / 2, h], ['C', w * 0.7, h * 0.75, w, h * 0.55, w * 0.96, h * 0.3], ['C', w * 0.9, 0, w * 0.5, h * 0.05, w / 2, h * 0.28], ['Z']],
  moon: (w, h, a) => { const k = a('adj', 50000); return [['M', w, h], ['C', w * (0.15 + 0.2 * (1 - k)), h * 0.9, w * 0.1, h * 0.7, w * 0.1, h / 2], ['C', w * 0.1, h * 0.3, w * (0.15 + 0.2 * (1 - k)), h * 0.1, w, 0], ['C', w * 0.35, h * 0.02, 0, h * 0.2, 0, h / 2], ['C', 0, h * 0.8, w * 0.35, h * 0.98, w, h], ['Z']]; },
  sun: (w, h) => { const cx = w / 2; const cy = h / 2; const rays = []; for (let i = 0; i < 8; i++) { const an = (i * TAU) / 8; const pa = an - 0.12; const pb = an + 0.12; rays.push(...poly([[cx + Math.cos(pa) * w * 0.34, cy + Math.sin(pa) * h * 0.34], [cx + Math.cos(an) * w * 0.5, cy + Math.sin(an) * h * 0.5], [cx + Math.cos(pb) * w * 0.34, cy + Math.sin(pb) * h * 0.34]])); } return [...rays, ['M', cx + w * 0.25, cy], ['A', cx, cy, w * 0.25, h * 0.25, 0, TAU, false], ['Z']]; },
  lightningBolt: (w, h) => poly([[w * 0.38, 0], [w * 0.1, h * 0.5], [w * 0.4, h * 0.5], [w * 0.22, h], [w * 0.9, h * 0.38], [w * 0.55, h * 0.38], [w * 0.75, 0]]),
  teardrop: (w, h) => [['M', w / 2, 0], ['C', w * 0.65, h * 0.22, w, h * 0.4, w, h * 0.62], ['A', w / 2, h * 0.62, w / 2, h * 0.38, 0, Math.PI, false], ['C', 0, h * 0.4, w * 0.35, h * 0.22, w / 2, 0], ['Z']],
  cloud: (w, h) => [[0.3, 0.55, 0.22], [0.5, 0.4, 0.26], [0.72, 0.52, 0.22], [0.5, 0.65, 0.22], [0.18, 0.7, 0.16], [0.84, 0.7, 0.14]].flatMap(([x, y, r]) => [['M', (x + r) * w, y * h], ['A', x * w, y * h, r * w, r * h, 0, TAU, false], ['Z']]),
  donut: (w, h, a) => { const t = Math.min(w, h) * a('adj', 25000); return [...ell(w, h), ['M', w - t, h / 2], ['A', w / 2, h / 2, Math.max(1, w / 2 - t), Math.max(1, h / 2 - t), 0, TAU, true], ['Z']]; },
  noSmoking: (w, h, a) => { const t = Math.min(w, h) * a('adj', 18750); const rx = w / 2 - t; const ry = h / 2 - t; const cx = w / 2; const cy = h / 2; const k = Math.atan2(ry, rx); const dx = Math.cos(k) * t * 0.5; const dy = Math.sin(k) * t * 0.5;
    return [...ell(w, h), ['M', cx + rx, cy], ['A', cx, cy, rx, ry, 0, TAU, true], ['Z'], ['M', cx - rx * 0.7 - dx, cy - ry * 0.7 + dy], ['L', cx - rx * 0.7 + dx, cy - ry * 0.7 - dy], ['L', cx + rx * 0.7 + dx, cy + ry * 0.7 - dy], ['L', cx + rx * 0.7 - dx, cy + ry * 0.7 + dy], ['Z']]; },
  blockArc: (w, h, a) => { const s0 = deg((a('adj1', 10800000) * 100000) / 60000); let s1 = deg((a('adj2', 0) * 100000) / 60000); while (s1 <= s0) s1 += TAU; const t = Math.min(w, h) * a('adj3', 25000); const cx = w / 2; const cy = h / 2;
    return poly([...arcPts(cx, cy, w / 2, h / 2, s0, s1), ...arcPts(cx, cy, Math.max(1, w / 2 - t), Math.max(1, h / 2 - t), s1, s0)]); },
  pie: (w, h, a) => { const s0 = deg((a('adj1', 0) * 100000) / 60000); let s1 = deg((a('adj2', 16200000) * 100000) / 60000); while (s1 <= s0) s1 += TAU; return wedge(w / 2, h / 2, w / 2, h / 2, s0, s1); },
  chord: (w, h, a) => { const s0 = deg((a('adj1', 2700000) * 100000) / 60000); let s1 = deg((a('adj2', 16200000) * 100000) / 60000); while (s1 <= s0) s1 += TAU; return poly(arcPts(w / 2, h / 2, w / 2, h / 2, s0, s1)); },
  frame: (w, h, a) => { const t = Math.min(w, h) * a('adj1', 12500); return [...poly([[0, 0], [w, 0], [w, h], [0, h]]), ['M', t, t], ['L', t, h - t], ['L', w - t, h - t], ['L', w - t, t], ['Z']]; },
  bevel: (w, h, a) => { const t = Math.min(w, h) * a('adj', 12500); return [...poly([[0, 0], [w, 0], [w, h], [0, h]]), ['M', t, t], ['L', t, h - t], ['L', w - t, h - t], ['L', w - t, t], ['Z']]; },
  cube: (w, h, a) => { const t = Math.min(w, h) * a('adj', 25000); return [...poly([[0, t], [w - t, t], [w - t, h], [0, h]]), ...poly([[0, t], [t, 0], [w, 0], [w - t, t]]), ...poly([[w - t, t], [w, 0], [w, h - t], [w - t, h]])]; },
  can: (w, h, a) => { const t = Math.min(h / 2, h * a('adj', 25000) * 0.5); return [['M', 0, t], ['A', w / 2, t, w / 2, t, Math.PI, Math.PI * 2, false], ['L', w, h - t], ['A', w / 2, h - t, w / 2, t, 0, Math.PI, false], ['Z'], ['M', 0, t], ['A', w / 2, t, w / 2, t, Math.PI, 0, true], ['Z']]; },
  smileyFace: (w, h) => { const e = (x, y) => [['M', x + w * 0.06, y], ['A', x, y, w * 0.06, h * 0.06, 0, TAU, true], ['Z']]; return [...ell(w, h), ...e(w * 0.33, h * 0.35), ...e(w * 0.67, h * 0.35), ['M', w * 0.25, h * 0.6], ['C', w * 0.35, h * 0.85, w * 0.65, h * 0.85, w * 0.75, h * 0.6], ['C', w * 0.65, h * 0.75, w * 0.35, h * 0.75, w * 0.25, h * 0.6], ['Z']]; },
  foldedCorner: (w, h, a) => { const o = Math.min(w, h) * a('adj', 16667); return [...poly([[0, 0], [w, 0], [w, h - o], [w - o, h], [0, h]]), ...poly([[w - o, h], [w - o, h - o], [w, h - o]])]; },
  wave: (w, h, a) => { const t = h * a('adj1', 12500); return [['M', 0, t], ['C', w * 0.25, -t, w * 0.5, t * 3, w, t], ['L', w, h - t], ['C', w * 0.75, h + t, w * 0.5, h - t * 3, 0, h - t], ['Z']]; },
  doubleWave: (w, h, a) => { const t = h * a('adj1', 6250); return [['M', 0, t], ['C', w * 0.17, -t, w * 0.33, t * 3, w / 2, t], ['C', w * 0.67, -t, w * 0.83, t * 3, w, t], ['L', w, h - t], ['C', w * 0.83, h + t, w * 0.67, h - t * 3, w / 2, h - t], ['C', w * 0.33, h + t, w * 0.17, h - t * 3, 0, h - t], ['Z']]; },
  wedgeRectCallout: (w, h, a) => calloutTail(PRESETS.rect(w, h), w, h, w * (0.5 + a('adj1', -20833)), h * (0.5 + a('adj2', 62500))),
  wedgeRoundRectCallout: (w, h, a) => calloutTail(PRESETS.roundRect(w, h, () => 0.16667), w, h, w * (0.5 + a('adj1', -20833)), h * (0.5 + a('adj2', 62500))),
  wedgeEllipseCallout: (w, h, a) => calloutTail(ell(w, h), w, h, w * (0.5 + a('adj1', -20833)), h * (0.5 + a('adj2', 62500))),
  flowChartProcess: (w, h) => PRESETS.rect(w, h),
  flowChartAlternateProcess: (w, h) => PRESETS.roundRect(w, h, () => 0.16667),
  flowChartDecision: (w, h) => PRESETS.diamond(w, h),
  flowChartTerminator: (w, h) => PRESETS.roundRect(w, h, () => 0.5),
  flowChartData: (w, h) => PRESETS.parallelogram(w, h, () => 0.2),
  flowChartConnector: (w, h) => ell(w, h),
  flowChartPreparation: (w, h) => PRESETS.hexagon(w, h, () => 0.2),
  flowChartPredefinedProcess: (w, h) => [...PRESETS.rect(w, h), ...poly([[w * 0.1, 0], [w * 0.1, h], [w * 0.1 + 0.001, h], [w * 0.1 + 0.001, 0]]), ...poly([[w * 0.9, 0], [w * 0.9, h], [w * 0.9 + 0.001, h], [w * 0.9 + 0.001, 0]])],
  flowChartDocument: (w, h) => [['M', 0, 0], ['L', w, 0], ['L', w, h * 0.8], ['C', w * 0.75, h * 0.6, w * 0.6, h * 1.05, w / 2, h * 0.9], ['C', w * 0.35, h * 0.78, w * 0.2, h * 0.95, 0, h * 0.85], ['Z']],
  flowChartManualInput: (w, h) => poly([[0, h * 0.2], [w, 0], [w, h], [0, h]]),
  flowChartMerge: (w, h) => poly([[0, 0], [w, 0], [w / 2, h]]),
  flowChartExtract: (w, h) => poly([[w / 2, 0], [w, h], [0, h]]),
};
const OPEN = {
  line: (w, h) => [['M', 0, 0], ['L', w, h]],
  arc: (w, h, a) => { const s0 = deg((a('adj1', 16200000) * 100000) / 60000); let s1 = deg((a('adj2', 0) * 100000) / 60000); while (s1 <= s0) s1 += TAU; return arcPts(w / 2, h / 2, w / 2, h / 2, s0, s1).map(([x, y], i) => [i ? 'L' : 'M', x, y]); },
  leftBracket: (w, h, a) => { const r = Math.min(w, h / 2) * Math.min(1, a('adj', 8333) * 4); return [['M', w, 0], ['L', r, 0], ['L', 0, r], ['L', 0, h - r], ['L', r, h], ['L', w, h]]; },
  rightBracket: (w, h, a) => { const r = Math.min(w, h / 2) * Math.min(1, a('adj', 8333) * 4); return [['M', 0, 0], ['L', w - r, 0], ['L', w, r], ['L', w, h - r], ['L', w - r, h], ['L', 0, h]]; },
  leftBrace: (w, h) => [['M', w, 0], ['C', w * 0.4, 0, w * 0.5, h * 0.2, w * 0.5, h * 0.4], ['C', w * 0.5, h * 0.46, w * 0.3, h * 0.5, 0, h / 2], ['C', w * 0.3, h * 0.5, w * 0.5, h * 0.54, w * 0.5, h * 0.6], ['C', w * 0.5, h * 0.8, w * 0.4, h, w, h]],
  rightBrace: (w, h) => [['M', 0, 0], ['C', w * 0.6, 0, w * 0.5, h * 0.2, w * 0.5, h * 0.4], ['C', w * 0.5, h * 0.46, w * 0.7, h * 0.5, w, h / 2], ['C', w * 0.7, h * 0.5, w * 0.5, h * 0.54, w * 0.5, h * 0.6], ['C', w * 0.5, h * 0.8, w * 0.6, h, 0, h]],
};
const ALIAS = { straightConnector1: 'line', bentConnector3: 'line', curvedConnector3: 'line', cross: 'plus', ellipseRibbon: 'wave', ribbon: 'wave', ribbon2: 'wave', flowChartTerminator: 'flowChartTerminator', snip2DiagRect: 'snip2SameRect', rect2: 'rect', octagon2: 'octagon', roundRect2: 'roundRect', flowChartOffpageConnector: 'pentagon', flowChartDelay: 'roundRect', flowChartSort: 'diamond', flowChartCollate: 'flowChartMerge', flowChartSummingJunction: 'flowChartConnector', flowChartOr: 'flowChartConnector', flowChartInternalStorage: 'flowChartPredefinedProcess', flowChartMultidocument: 'flowChartDocument', flowChartManualOperation: 'trapezoid', flowChartMagneticDisk: 'can', flowChartDisplay: 'hexagon', flowChartInputOutput: 'flowChartData', flowChartPunchedCard: 'snip1Rect', flowChartPunchedTape: 'wave' };

/** Names of every preset shape that draws exactly (the rest become a rectangle). */
export const SHAPE_KINDS = [...Object.keys(PRESETS), ...Object.keys(OPEN)];

/** Friendly names + groups for the shape picker. */
export const SHAPE_GROUPS = [
  { label: 'Basic', kinds: ['rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'parallelogram', 'trapezoid', 'pentagon', 'hexagon', 'octagon', 'plus', 'frame', 'donut', 'teardrop', 'heart', 'moon', 'sun', 'cloud', 'lightningBolt', 'smileyFace', 'can', 'cube', 'bevel', 'foldedCorner'] },
  { label: 'Arrows', kinds: ['rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow', 'upDownArrow', 'chevron', 'homePlate', 'notchedRightArrow'] },
  { label: 'Stars', kinds: ['star4', 'star5', 'star6', 'star8', 'star10', 'star12', 'star16', 'star24'] },
  { label: 'Callouts & marks', kinds: ['wedgeRectCallout', 'wedgeRoundRectCallout', 'wedgeEllipseCallout', 'mathPlus', 'mathMinus', 'mathMultiply', 'mathEqual', 'noSmoking', 'wave', 'doubleWave'] },
  { label: 'Lines & brackets', kinds: ['line', 'arc', 'leftBracket', 'rightBracket', 'leftBrace', 'rightBrace', 'pie', 'blockArc', 'chord'] },
  { label: 'Flow chart', kinds: ['flowChartProcess', 'flowChartAlternateProcess', 'flowChartDecision', 'flowChartTerminator', 'flowChartData', 'flowChartDocument', 'flowChartConnector', 'flowChartPreparation', 'flowChartPredefinedProcess'] },
];
export const shapeLabel = (k) => k.replace(/^flowChart/, 'Flow ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** Path commands for a preset at w x h. `adj` uses the OOXML numbers (100000 = 100 %). Unknown presets give a rectangle. */
export function presetPath(prst, w, h, adj = {}) {
  const a = (k, d) => ((adj?.[k] != null && Number.isFinite(Number(adj[k])) ? Number(adj[k]) : d) / 100000);
  const name = ALIAS[prst] ?? prst;
  if (OPEN[name]) return { cmds: OPEN[name](w, h, a), open: true, known: true };
  const f = PRESETS[name];
  return { cmds: (f ?? PRESETS.rect)(w, h, a), open: false, known: !!f };
}

/** Custom geometry (a:custGeom paths) -> the same command list. */
export function customPath(paths, w, h) {
  const cmds = [];
  for (const pa of paths) {
    const sx = pa.w ? w / pa.w : 1; const sy = pa.h ? h / pa.h : 1; let cur = [0, 0];
    for (const c of pa.cmds) {
      const q = c.pts.map(([x, y]) => [x * sx, y * sy]);
      if (c.t === 'moveTo' && q[0]) { cmds.push(['M', ...q[0]]); cur = q[0]; }
      else if (c.t === 'lnTo' && q[0]) { cmds.push(['L', ...q[0]]); cur = q[0]; }
      else if (c.t === 'cubicBezTo' && q.length >= 3) { cmds.push(['C', ...q[0], ...q[1], ...q[2]]); cur = q[2]; }
      else if (c.t === 'quadBezTo' && q.length >= 2) { cmds.push(['C', cur[0] + (2 / 3) * (q[0][0] - cur[0]), cur[1] + (2 / 3) * (q[0][1] - cur[1]), q[1][0] + (2 / 3) * (q[0][0] - q[1][0]), q[1][1] + (2 / 3) * (q[0][1] - q[1][1]), ...q[1]]); cur = q[1]; }
      else if (c.t === 'arcTo' && c.arc) {
        const { wR, hR, st, sw } = c.arc; const rx = wR * sx; const ry = hR * sy; const a0 = deg(st); const a1 = a0 + deg(sw);
        const cx = cur[0] - rx * Math.cos(a0); const cy = cur[1] - ry * Math.sin(a0);
        cmds.push(['A', cx, cy, rx, ry, a0, a1, sw < 0]); cur = [cx + rx * Math.cos(a1), cy + ry * Math.sin(a1)];
      } else if (c.t === 'close') cmds.push(['Z']);
    }
  }
  return { cmds, open: false, known: true };
}

/** Command list -> Path2D (browser). */
export function toPath2D(cmds) {
  const p = new Path2D();
  for (const c of cmds) {
    if (c[0] === 'M') p.moveTo(c[1], c[2]);
    else if (c[0] === 'L') p.lineTo(c[1], c[2]);
    else if (c[0] === 'C') p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else if (c[0] === 'A') { if (c[3] > 0 && c[4] > 0) p.ellipse(c[1], c[2], c[3], c[4], 0, c[5], c[6], c[7]); }
    else if (c[0] === 'Z') p.closePath();
  }
  return p;
}

// ---------- paint ----------

/** fill: { type: 'solid', hex } | { type: 'grad', stops:[{pos,hex}], ang, path } | { type: 'none' }. */
export function fillStyle(g, f, w, h) {
  if (!f || f.type === 'none') return null;
  if (f.type === 'solid') return f.hex;
  if (f.type === 'grad' && f.stops?.length) {
    let gr;
    if (f.path) gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) / 2);
    else { const a = ((f.ang ?? 0) * Math.PI) / 180; const L = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2; gr = g.createLinearGradient(w / 2 - Math.cos(a) * L, h / 2 - Math.sin(a) * L, w / 2 + Math.cos(a) * L, h / 2 + Math.sin(a) * L); }
    for (const st of f.stops) gr.addColorStop(clamp01(st.pos), st.hex);
    return gr;
  }
  return null;
}

/** An arrowhead at (x, y) pointing along angle `an`. */
function arrowHead(g, kind, x, y, an, wpx) {
  const L = Math.max(6, wpx * 3.2); const Wd = Math.max(5, wpx * 2.6);
  g.save(); g.translate(x, y); g.rotate(an); g.setLineDash([]);
  g.beginPath();
  if (kind === 'oval') g.ellipse(0, 0, Wd / 2, Wd / 2, 0, 0, TAU);
  else if (kind === 'diamond') { g.moveTo(L / 2, 0); g.lineTo(0, Wd / 2); g.lineTo(-L / 2, 0); g.lineTo(0, -Wd / 2); g.closePath(); }
  else if (kind === 'stealth') { g.moveTo(L / 2, 0); g.lineTo(-L / 2, Wd / 2); g.lineTo(-L / 4, 0); g.lineTo(-L / 2, -Wd / 2); g.closePath(); }
  else if (kind === 'arrow') { g.moveTo(-L / 2, Wd / 2); g.lineTo(L / 2, 0); g.lineTo(-L / 2, -Wd / 2); g.stroke(); g.restore(); return; }
  else { g.moveTo(L / 2, 0); g.lineTo(-L / 2, Wd / 2); g.lineTo(-L / 2, -Wd / 2); g.closePath(); }
  g.fill(); g.restore();
}

/**
 * Paint one shape into the box (0,0,w,h) of the current transform.
 * spec: { geom: { prst, adj } | { cust }, fill, line: { w (px), color, alpha, dash, head, tail }, shadow }.
 * `blip` is an optional decoded image for picture fills.
 */
export function paintShape(g, spec, w, h, { blip = null } = {}) {
  const geom = spec.geom ?? { prst: 'rect' };
  const sh = geom.cust ? customPath(geom.cust, w, h) : presetPath(geom.prst, w, h, geom.adj);
  const path = toPath2D(sh.cmds);
  const fill = spec.fill; const line = spec.line;
  g.save();
  if (spec.shadow) { g.shadowColor = spec.shadow.color; g.shadowBlur = spec.shadow.blur || 4; g.shadowOffsetX = spec.shadow.dx ?? 0; g.shadowOffsetY = spec.shadow.dy ?? 0; }
  if (!sh.open && fill && fill.type !== 'none') {
    g.globalAlpha = fill.alpha ?? 1;
    if (fill.type === 'blip') {
      if (blip) { g.save(); g.clip(path); const k = Math.max(w / blip.width, h / blip.height); g.drawImage(blip, (w - blip.width * k) / 2, (h - blip.height * k) / 2, blip.width * k, blip.height * k); g.restore(); }
    } else { g.fillStyle = fillStyle(g, fill, w, h) ?? '#808080'; g.fill(path, 'nonzero'); }
  }
  g.shadowColor = 'transparent';
  const stroked = line && !line.none && line.color;
  if (stroked || (sh.open && !line)) {
    const lw = Math.max(1, line?.w ?? 2);
    g.globalAlpha = line?.alpha ?? 1; g.strokeStyle = line?.color ?? '#888888'; g.lineWidth = lw; g.lineJoin = 'round'; g.lineCap = line?.cap ?? 'butt';
    const d = line?.dash;
    if (d && d !== 'solid') g.setLineDash(d.includes('dot') || d === 'sysDash' ? [lw, lw * 1.5] : d.includes('lg') ? [lw * 8, lw * 3] : [lw * 4, lw * 2]);
    g.stroke(path);
    g.setLineDash([]);
    if (geom.prst && (ALIAS[geom.prst] ?? geom.prst) === 'line' && (line?.head || line?.tail)) {
      g.fillStyle = line.color ?? '#888888';
      const an = Math.atan2(h, w);
      if (line.tail && line.tail !== 'none') arrowHead(g, line.tail, w, h, an, lw);
      if (line.head && line.head !== 'none') arrowHead(g, line.head, 0, 0, an + Math.PI, lw);
    }
  }
  g.restore();
}

// ---------- rich text drawing ----------

const fontOf = (family, px, b, i) => `${i ? 'italic ' : ''}${b ? 700 : 400} ${px}px ${family}`;

/**
 * Wrap and draw paragraphs inside `box`. paras: [{ runs:[{t,b,i,u,s,color,size}], align, bullet, lvl, size, color }].
 * Returns the text height. `draw:false` only measures. Underline and strike-through are drawn as rules.
 */
export function drawRich(g, paras, box, { family = 'Inter, system-ui, sans-serif', size = 18, color = '#111111', anchor = 'top', lineGap = 1.2, weight = 400, draw = true, alpha = 1 } = {}) {
  const lines = []; // { runs:[{t,font,px,b,i,u,s,color,w}], w, h, align }
  for (const p of paras) {
    const psize = p.size ?? size; const indent = (p.lvl ?? 0) * psize * 1.2 + (p.bullet ? psize * 0.9 : 0);
    const maxW = Math.max(psize, box.w - indent);
    const toks = [];
    for (const r of p.runs) for (const part of String(r.t).split(/(\s+)/)) if (part) toks.push({ ...r, t: part, px: r.size ?? psize, b: r.b || (weight >= 600), color: r.color ?? p.color ?? color });
    let cur = []; let cw = 0; let first = true;
    const flush = () => { while (cur.length && /^\s+$/.test(cur.at(-1).t)) { cw -= cur.at(-1).w; cur.pop(); } lines.push({ runs: cur, w: cw, h: Math.max(psize, ...cur.map((x) => x.px)) * lineGap, align: p.align ?? 'l', indent, bullet: first && p.bullet, bp: psize, bcolor: cur[0]?.color ?? color }); first = false; cur = []; cw = 0; };
    for (const t of toks) {
      g.font = fontOf(family, t.px, t.b, t.i); t.w = g.measureText(t.t).width;
      if (cw + t.w > maxW && cur.length && !/^\s+$/.test(t.t)) flush();
      if (!cur.length && /^\s+$/.test(t.t)) continue;
      cur.push(t); cw += t.w;
    }
    if (cur.length || !toks.length) flush();
  }
  const total = lines.reduce((a, l) => a + l.h, 0);
  if (!draw) return total;
  let y = anchor === 'middle' ? box.y + (box.h - total) / 2 : anchor === 'bottom' ? box.y + box.h - total : box.y;
  g.save(); g.globalAlpha *= alpha; g.textBaseline = 'alphabetic';
  for (const l of lines) {
    const base = y + l.h * 0.5 + (l.runs.length ? Math.max(...l.runs.map((r) => r.px)) * 0.33 : 0);
    let x = box.x + l.indent;
    const avail = box.w - l.indent;
    if (l.align === 'ctr' || l.align === 'center') x += (avail - l.w) / 2; else if (l.align === 'r' || l.align === 'right') x += avail - l.w;
    if (l.bullet) { g.fillStyle = l.bcolor; g.beginPath(); g.arc(box.x + l.indent - l.bp * 0.55, base - l.bp * 0.3, l.bp * 0.12, 0, TAU); g.fill(); }
    for (const r of l.runs) {
      g.font = fontOf(family, r.px, r.b, r.i); g.fillStyle = r.color; g.fillText(r.t, x, base);
      if (r.u || r.s) { const th = Math.max(1, r.px * 0.06); const w = r.w; if (r.u) g.fillRect(x, base + r.px * 0.1, w, th); if (r.s) g.fillRect(x, base - r.px * 0.3, w, th); }
      x += r.w;
    }
    y += l.h;
  }
  g.restore();
  return total;
}

// ---------- charts ----------

export const CHART_TYPES = [['column', 'Column'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'], ['pie', 'Pie'], ['doughnut', 'Doughnut'], ['scatter', 'Scatter']];
export const CHART_PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#9c755f', '#ff9da7', '#bab0ac'];
export const CHART_DEFAULTS = {
  type: 'column', grouping: 'clustered', title: '', categories: ['Q1', 'Q2', 'Q3', 'Q4'],
  series: [{ name: 'Series 1', values: [4, 7, 5, 9] }, { name: 'Series 2', values: [3, 5, 8, 6] }],
  legend: 'bottom', labels: false, grid: true, smooth: false, markers: true, hole: 0.55, fg: '#1b1b1b', bg: '', gridColor: '', font: 'Inter', size: 1,
};

/** "Nice" axis for data spanning [min, max]. */
export function niceScale(min, max, ticks = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (min === max) { if (min === 0) max = 1; else if (min > 0) { min = 0; } else max = 0; }
  const range = max - min;
  const raw = range / Math.max(1, ticks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag; const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  return { min: Math.floor(min / step + 1e-9) * step, max: Math.ceil(max / step - 1e-9) * step, step };
}

const fmtNum = (v) => { const a = Math.abs(v); if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`; if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`; if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`; return `${+v.toFixed(a < 1 ? 2 : a < 10 ? 1 : 0)}`; };
export { fmtNum };

/** Normalise a chart spec: fill defaults, colours, numeric values. */
export function normChart(c) {
  const s = { ...CHART_DEFAULTS, ...c };
  s.series = (s.series?.length ? s.series : CHART_DEFAULTS.series).map((x, i) => ({ ...x, name: x.name ?? `Series ${i + 1}`, color: x.color || CHART_PALETTE[i % CHART_PALETTE.length], values: (x.values ?? []).map((v) => (v == null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v))), xs: x.xs?.map(Number) }));
  const n = Math.max(0, ...s.series.map((x) => x.values.length));
  s.categories = Array.from({ length: n }, (_, i) => String(s.categories?.[i] ?? i + 1));
  s.series.forEach((x) => { while (x.values.length < n) x.values.push(0); });
  return s;
}

/** Everything the chart drawing needs, as plain numbers (testable without a canvas). */
export function layoutChart(c, w, h) {
  const s = normChart(c);
  const px = Math.max(8, Math.min(w, h) * 0.045 * (s.size ?? 1));
  const titleH = s.title ? px * 1.9 : 0;
  const pie = s.type === 'pie' || s.type === 'doughnut';
  const pieColor = (i) => s.series[0]?.ptColors?.[i] ?? s.palette?.[i % s.palette.length] ?? CHART_PALETTE[i % CHART_PALETTE.length];
  const legendItems = pie ? s.categories.map((n, i) => ({ name: n, color: pieColor(i) })) : s.series.map((x) => ({ name: x.name, color: x.color }));
  const showLegend = s.legend !== 'none' && (pie ? true : s.series.length > 1 || s.legend === 'force');
  const lw = showLegend ? Math.min(w * 0.3, Math.max(...legendItems.map((l) => l.name.length), 4) * px * 0.55 + px * 2) : 0;
  const lh = showLegend ? px * 1.8 : 0;
  const pad = px * 0.6;
  const area = { x: pad, y: pad + titleH, w: w - pad * 2, h: h - pad * 2 - titleH };
  if (showLegend) { if (s.legend === 'right') area.w -= lw; else if (s.legend === 'left') { area.x += lw; area.w -= lw; } else if (s.legend === 'top') { area.y += lh; area.h -= lh; } else area.h -= lh; }
  let scale = null;
  if (!pie && s.type !== 'scatter') {
    let lo = 0; let hi = 0;
    if (s.grouping === 'stacked' && (s.type === 'column' || s.type === 'bar' || s.type === 'area')) {
      for (let i = 0; i < s.categories.length; i++) { let pos = 0; let neg = 0; for (const x of s.series) { if (x.values[i] >= 0) pos += x.values[i]; else neg += x.values[i]; } hi = Math.max(hi, pos); lo = Math.min(lo, neg); }
    } else if (s.grouping === 'percent') { lo = 0; hi = 100; }
    else for (const x of s.series) for (const v of x.values) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
    scale = niceScale(lo, hi, 5);
  } else if (s.type === 'scatter') {
    const xs = s.series.flatMap((x) => x.xs ?? x.values.map((_, i) => i + 1)); const ys = s.series.flatMap((x) => x.values);
    scale = { x: niceScale(Math.min(...xs), Math.max(...xs), 5), y: niceScale(Math.min(0, ...ys), Math.max(...ys), 5) };
  }
  return { s, px, titleH, pie, pieColor, legendItems, showLegend, lw, lh, pad, area, scale };
}

/** Draw a chart into the box (0,0,w,h). `progress` 0..1 grows the data in (bars rise, lines draw, pies sweep). */
export function drawChart(g, c, w, h, progress = 1) {
  const L = layoutChart(c, w, h); const { s, px, area, scale } = L;
  const fam = s.fontCss ?? `${s.font || 'Inter'}, system-ui, sans-serif`;
  const fg = s.fg; const grid = s.gridColor || `${fg}2e`;
  const P = clamp01(progress);
  g.save();
  if (s.bg) { g.fillStyle = s.bg; g.fillRect(0, 0, w, h); }
  g.textBaseline = 'middle';
  const txt = (t, x, y, { align = 'center', size = px * 0.8, bold = false, color = fg, base = 'middle' } = {}) => { g.font = `${bold ? 700 : 400} ${size}px ${fam}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = base; g.fillText(t, x, y); };
  if (s.title) txt(s.title, w / 2, L.pad + px * 0.95, { size: px * 1.15, bold: true });
  // legend
  if (L.showLegend) {
    g.font = `400 ${px * 0.8}px ${fam}`;
    const items = L.legendItems; const sw = px * 0.8;
    if (s.legend === 'right' || s.legend === 'left') {
      const x0 = s.legend === 'right' ? w - L.lw - L.pad + px * 0.3 : L.pad; let y = h / 2 - (items.length * px * 1.5) / 2;
      for (const it of items) { g.fillStyle = it.color; g.fillRect(x0, y, sw, sw); txt(it.name, x0 + sw + px * 0.4, y + sw / 2, { align: 'left' }); y += px * 1.5; }
    } else {
      const widths = items.map((it) => { g.font = `400 ${px * 0.8}px ${fam}`; return g.measureText(it.name).width + sw + px * 1.3; });
      let tot = widths.reduce((a, b) => a + b, 0); if (tot > w - L.pad * 2) tot = w - L.pad * 2;
      let x = (w - tot) / 2; const y = s.legend === 'top' ? L.pad + L.titleH + L.lh / 2 : h - L.pad - L.lh / 2;
      items.forEach((it, i) => { g.fillStyle = it.color; g.fillRect(x, y - sw / 2, sw, sw); txt(it.name, x + sw + px * 0.4, y, { align: 'left' }); x += widths[i]; });
    }
  }
  if (L.pie) {
    const vals = s.series[0]?.values.map((v) => Math.max(0, v)) ?? []; const tot = vals.reduce((a, b) => a + b, 0) || 1;
    const R = Math.max(4, Math.min(area.w, area.h) / 2 - px * 0.2); const cx = area.x + area.w / 2; const cy = area.y + area.h / 2;
    let a0 = -Math.PI / 2; const sweepMax = P * TAU;
    vals.forEach((v, i) => {
      const a1 = a0 + (v / tot) * TAU; const cl = Math.min(a1, -Math.PI / 2 + sweepMax);
      if (cl > a0) {
        g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a0, cl); g.closePath(); g.fillStyle = L.pieColor(i); g.fill();
        g.lineWidth = Math.max(1, px * 0.08); g.strokeStyle = s.bg || '#ffffff'; g.stroke();
      }
      if (s.labels && cl >= a1 - 1e-6 && v / tot > 0.04) { const am = (a0 + a1) / 2; const rr = s.type === 'doughnut' ? R * (1 + s.hole) / 2 : R * 0.62; txt(`${Math.round((v / tot) * 100)}%`, cx + Math.cos(am) * rr, cy + Math.sin(am) * rr, { size: px * 0.8, bold: true, color: '#ffffff' }); }
      a0 = a1;
    });
    if (s.type === 'doughnut') { g.save(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(cx, cy, R * s.hole, 0, TAU); g.fill(); g.restore(); if (s.bg) { g.fillStyle = s.bg; g.beginPath(); g.arc(cx, cy, R * s.hole, 0, TAU); g.fill(); } }
    g.restore(); return L;
  }
  // axes
  const labelW = px * 3.4; const catH = px * 1.6;
  const horiz = s.type === 'bar';
  const plot = { x: area.x + (horiz ? labelW * 1.05 : labelW * 0.85), y: area.y + px * 0.4, w: 0, h: 0 };
  plot.w = area.x + area.w - plot.x - px * 0.4; plot.h = area.y + area.h - catH - plot.y;
  if (plot.w < 10 || plot.h < 10) { g.restore(); return L; }
  const isScatter = s.type === 'scatter';
  const V = isScatter ? scale.y : scale;
  const vToY = (v) => plot.y + plot.h - ((v - V.min) / (V.max - V.min || 1)) * plot.h;
  const vToX = (v) => plot.x + ((v - V.min) / (V.max - V.min || 1)) * plot.w;
  const nCat = s.categories.length || 1;
  // grid + value labels
  g.lineWidth = 1; g.strokeStyle = grid;
  for (let v = V.min; v <= V.max + V.step * 1e-6; v += V.step) {
    const t = s.grouping === 'percent' ? `${fmtNum(v)}%` : fmtNum(v);
    if (horiz) { const x = vToX(v); if (s.grid) { g.beginPath(); g.moveTo(x, plot.y); g.lineTo(x, plot.y + plot.h); g.stroke(); } txt(t, x, plot.y + plot.h + px * 0.9, { size: px * 0.72 }); }
    else { const y = vToY(v); if (s.grid) { g.beginPath(); g.moveTo(plot.x, y); g.lineTo(plot.x + plot.w, y); g.stroke(); } txt(t, plot.x - px * 0.4, y, { align: 'right', size: px * 0.72 }); }
  }
  if (isScatter) {
    const X = scale.x; const xToX = (v) => plot.x + ((v - X.min) / (X.max - X.min || 1)) * plot.w;
    for (let v = X.min; v <= X.max + X.step * 1e-6; v += X.step) { const x = xToX(v); if (s.grid) { g.beginPath(); g.moveTo(x, plot.y); g.lineTo(x, plot.y + plot.h); g.stroke(); } txt(fmtNum(v), x, plot.y + plot.h + px * 0.9, { size: px * 0.72 }); }
    s.series.forEach((x) => { x.values.forEach((v, i) => { const xv = x.xs?.[i] ?? i + 1; const k = clamp01(P * s.series[0].values.length - i + 1); if (k <= 0) return; g.globalAlpha = k; g.fillStyle = x.color; g.beginPath(); g.arc(xToX(xv), vToY(v), px * 0.3 * k, 0, TAU); g.fill(); }); g.globalAlpha = 1; });
    g.strokeStyle = fg; g.lineWidth = 1.2; g.beginPath(); g.moveTo(plot.x, plot.y); g.lineTo(plot.x, plot.y + plot.h); g.lineTo(plot.x + plot.w, plot.y + plot.h); g.stroke();
    g.restore(); return L;
  }
  // baseline
  const zero = horiz ? vToX(0) : vToY(0);
  g.strokeStyle = fg; g.lineWidth = 1.2; g.beginPath();
  if (horiz) { g.moveTo(zero, plot.y); g.lineTo(zero, plot.y + plot.h); } else { g.moveTo(plot.x, zero); g.lineTo(plot.x + plot.w, zero); }
  g.stroke();
  const bandSize = (horiz ? plot.h : plot.w) / nCat;
  const catPos = (i) => (horiz ? plot.y : plot.x) + bandSize * (i + 0.5);
  const every = Math.max(1, Math.ceil((s.categories.reduce((a, b) => Math.max(a, b.length), 1) * px * 0.55) / Math.max(1, bandSize)));
  s.categories.forEach((cn, i) => { if (i % every) return; if (horiz) txt(cn, plot.x - px * 0.4 - (zero - plot.x), catPos(i), { align: 'right', size: px * 0.72 }); else txt(cn, catPos(i), plot.y + plot.h + px * 0.9, { size: px * 0.72 }); });
  const ease = (i, n) => clamp01(P * (1 + 0.6) - (i / Math.max(1, n)) * 0.6);
  const stackedLike = s.grouping === 'stacked' || s.grouping === 'percent';
  const pctTot = (i) => s.series.reduce((a, x) => a + Math.abs(x.values[i]), 0) || 1;
  const val = (x, i) => (s.grouping === 'percent' ? (x.values[i] / pctTot(i)) * 100 : x.values[i]);
  if (s.type === 'column' || s.type === 'bar') {
    const k = s.series.length; const gap = bandSize * 0.22; const inner = bandSize - gap * 2;
    for (let i = 0; i < nCat; i++) {
      let pos = 0; let neg = 0;
      s.series.forEach((x, si) => {
        const e = ease(i, nCat); const v = val(x, i) * e; if (!v) return;
        const bw = stackedLike ? inner : inner / k; const off = stackedLike ? 0 : si * bw;
        let a0; let a1;
        if (stackedLike) { if (v >= 0) { a0 = pos; pos += v; a1 = pos; } else { a0 = neg; neg += v; a1 = neg; } } else { a0 = 0; a1 = v; }
        g.fillStyle = x.color;
        if (horiz) { const xa = vToX(a0); const xb = vToX(a1); g.fillRect(Math.min(xa, xb), catPos(i) - inner / 2 + off, Math.abs(xb - xa), bw * (stackedLike ? 1 : 0.92)); }
        else { const ya = vToY(a0); const yb = vToY(a1); g.fillRect(catPos(i) - inner / 2 + off, Math.min(ya, yb), bw * (stackedLike ? 1 : 0.92), Math.abs(yb - ya)); }
        if (s.labels && e > 0.98 && stackedLike) { const mid = (a0 + a1) / 2; if (horiz) txt(fmtNum(val(x, i)), vToX(mid), catPos(i), { size: px * 0.7, color: '#ffffff', bold: true }); else txt(fmtNum(val(x, i)), catPos(i), vToY(mid), { size: px * 0.7, color: '#ffffff', bold: true }); }
        else if (s.labels && e > 0.98) { const lbl = fmtNum(val(x, i)); if (horiz) txt(lbl, vToX(a1) + (v >= 0 ? px * 0.3 : -px * 0.3), catPos(i) - inner / 2 + off + bw / 2, { align: v >= 0 ? 'left' : 'right', size: px * 0.7 }); else txt(lbl, catPos(i) - inner / 2 + off + bw / 2, vToY(a1) + (v >= 0 ? -px * 0.5 : px * 0.5), { size: px * 0.7 }); }
      });
    }
  } else {   // line / area
    const pts = (x) => x.values.map((_, i) => [catPos(i), vToY(val(x, i))]);
    const cum = new Array(nCat).fill(0);
    s.series.forEach((x) => {
      const p = pts(x); if (!p.length) return;
      let base = p;
      if (s.type === 'area' && stackedLike) { base = p.map((pt, i) => { cum[i] += val(x, i); return [pt[0], vToY(cum[i])]; }); }
      const reveal = plot.x + plot.w * P + 1;
      g.save(); g.beginPath(); g.rect(plot.x - px, plot.y - px, reveal - plot.x + px, plot.h + px * 3); g.clip();
      const trace = (arr) => { g.moveTo(arr[0][0], arr[0][1]); for (let i = 1; i < arr.length; i++) { if (s.smooth && arr.length > 2) { const p0 = arr[Math.max(0, i - 2)]; const p1 = arr[i - 1]; const p2 = arr[i]; const p3 = arr[Math.min(arr.length - 1, i + 1)]; g.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]); } else g.lineTo(arr[i][0], arr[i][1]); } };
      if (s.type === 'area') { g.beginPath(); trace(base); g.lineTo(base.at(-1)[0], zero); g.lineTo(base[0][0], zero); g.closePath(); g.globalAlpha = 0.55; g.fillStyle = x.color; g.fill(); g.globalAlpha = 1; }
      g.beginPath(); trace(base); g.strokeStyle = x.color; g.lineWidth = Math.max(2, px * 0.22); g.lineJoin = 'round'; g.stroke();
      if (s.markers && s.type === 'line') for (const pt of base) { g.fillStyle = x.color; g.beginPath(); g.arc(pt[0], pt[1], px * 0.28, 0, TAU); g.fill(); }
      if (s.labels && P > 0.98) base.forEach((pt, i) => txt(fmtNum(val(x, i)), pt[0], pt[1] - px * 0.7, { size: px * 0.7 }));
      g.restore();
    });
  }
  g.restore();
  return L;
}

// ---------- tables ----------

export const TABLE_DEFAULTS = {
  data: [['Name', 'Role', 'Score'], ['Ada', 'Engineer', '92'], ['Grace', 'Admiral', '88'], ['Linus', 'Maintainer', '95']],
  header: true, banded: true, firstCol: false, accent: '#4e79a7', fg: '#1b1b1b', bg: '#ffffff', border: '#00000033', borderW: 1, size: 1, font: 'Inter', align: [], colW: [], pad: 0.5, valign: 'middle',
};

/**
 * Turn a table spec into a grid of resolved cells. A cell is a string (with <b>/<i>/<u>/<s>/** markup) or an object
 * { t | runs | paras, span:[cols, rows], fill, color, align, anchor, b, i, u, s, size, borders }. `span` merges to the right/down.
 */
export function resolveTable(spec) {
  const s = { ...TABLE_DEFAULTS, ...spec };
  const data = s.data?.length ? s.data : [['']];
  const nR = data.length; const nC = Math.max(1, ...data.map((r) => r.length));
  const grid = Array.from({ length: nR }, () => Array.from({ length: nC }, () => null));
  const cells = [];
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      if (grid[r][c]) continue;
      const raw = data[r][c];
      if (raw === undefined && c >= data[r].length) { grid[r][c] = { skip: true }; continue; }
      let o = typeof raw === 'object' && raw ? raw : { t: raw ?? '' };
      if (typeof o.t === 'string') { const sm = /\s*\{(\d+)x(\d+)\}\s*$/.exec(o.t); if (sm) o = { ...o, t: o.t.slice(0, sm.index), span: [Number(sm[1]), Number(sm[2])] }; }
      if (o.merged) { grid[r][c] = { skip: true }; continue; }
      const cs = Math.max(1, Math.min(nC - c, o.span?.[0] ?? o.gridSpan ?? 1)); const rs = Math.max(1, Math.min(nR - r, o.span?.[1] ?? o.rowSpan ?? 1));
      const head = s.header && r === 0; const band = s.banded && !head && r % 2 === 0;
      const cell = { r, c, cs, rs, head, paras: o.paras ?? [{ runs: o.runs ?? parseRich(o.t ?? ''), align: o.align }], 
        fill: o.fill ?? (head ? { type: 'solid', hex: s.accent } : band ? { type: 'solid', hex: `${s.accent}22` } : s.bg ? { type: 'solid', hex: s.bg } : null),
        color: o.color ?? (head ? '#ffffff' : s.fg), align: o.align ?? s.align?.[c] ?? (head ? 'ctr' : 'l'), anchor: o.anchor ?? s.valign, size: o.size, sz: o.sz, b: o.b ?? (head || (s.firstCol && c === 0)), i: o.i, u: o.u, s: o.s, borders: o.borders };
      for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) grid[rr][cc] = rr === r && cc === c ? cell : { skip: true };
      cells.push(cell);
    }
  }
  const colW = Array.from({ length: nC }, (_, i) => (Number(s.colW?.[i]) > 0 ? Number(s.colW[i]) : 1));
  const rowH = Array.from({ length: nR }, (_, i) => (Number(s.rowH?.[i]) > 0 ? Number(s.rowH[i]) : 1));
  return { s, nR, nC, cells, colW, rowH };
}

/** Draw a table into the box (0,0,w,h). Row heights grow to fit wrapped text, then everything is scaled to the box. */
export function drawTable(g, spec, w, h, progress = 1) {
  const T = resolveTable(spec); const { s } = T;
  const fam = s.fontCss ?? `${s.font || 'Inter'}, system-ui, sans-serif`;
  const base = Math.max(8, Math.min(h / Math.max(2, T.nR) * 0.42, w / Math.max(2, T.nC) * 0.22) * (s.size ?? 1));
  const unit = s.refH ? h / s.refH : 0;                       // px per point when the sizes came from a document (pt)
  const cellSize = (c) => c.size ?? (c.sz && unit ? c.sz * unit : base);
  const cellParas = (c) => c.paras.map((p) => ({ ...p, align: p.align ?? c.align, runs: p.runs.map((r) => ({ ...r, b: r.b ?? c.b, i: r.i ?? c.i, u: r.u ?? c.u, s: r.s ?? c.s, color: r.color ?? c.color, size: r.size ?? (r.sz && unit ? r.sz * unit : undefined) })) }));
  const sumW = T.colW.reduce((a, b) => a + b, 0); const colPx = T.colW.map((v) => (v / sumW) * w);
  const colX = colPx.reduce((a, v) => (a.push(a.at(-1) + v), a), [0]);
  const padX = base * s.pad * 1.1; const padY = base * s.pad * 0.6;
  // natural row heights
  const need = T.rowH.map((v) => v);
  const rowMin = T.rowH.map(() => base * 1.2 + padY * 2);
  for (const c of T.cells) {
    const bw = colX[c.c + c.cs] - colX[c.c];
    const th = drawRich(g, cellParas(c), { x: 0, y: 0, w: bw - padX * 2, h: 0 }, { family: fam, size: cellSize(c), draw: false, weight: c.b ? 700 : 400 }) + padY * 2;
    if (c.rs === 1) rowMin[c.r] = Math.max(rowMin[c.r], th);
  }
  const sumNeed = need.reduce((a, b) => a + b, 0);
  const free = Math.max(0, h - rowMin.reduce((a, b) => a + b, 0));
  const rowPx = rowMin.map((m, i) => m + (free * need[i]) / sumNeed);
  const tot = rowPx.reduce((a, b) => a + b, 0); const k = tot > h ? h / tot : 1;
  const rowY = rowPx.reduce((a, v) => (a.push(a.at(-1) + v * k), a), [0]);
  g.save();
  const reveal = clamp01(progress);
  for (const c of T.cells) {
    const rowAlpha = clamp01(reveal * (T.nR + 1) - c.r);
    if (rowAlpha <= 0) continue;
    const x = colX[c.c]; const y = rowY[c.r]; const cw = colX[c.c + c.cs] - x; const ch = rowY[Math.min(T.nR, c.r + c.rs)] - y;
    g.save(); g.globalAlpha *= rowAlpha;
    if (c.fill && c.fill.type !== 'none') { g.fillStyle = fillStyle(g, { ...c.fill, ...(c.fill.type === 'grad' ? {} : null) }, cw, ch) ?? c.fill.hex; g.save(); g.translate(x, y); g.fillStyle = fillStyle(g, c.fill, cw, ch) ?? '#ffffff'; g.fillRect(0, 0, cw, ch); g.restore(); }
    drawRich(g, cellParas(c), { x: x + padX, y: y + padY, w: cw - padX * 2, h: ch - padY * 2 }, { family: fam, size: cellSize(c), color: c.color, anchor: c.anchor, weight: c.b ? 700 : 400 });
    g.restore();
  }
  // borders on top of fills
  const bw = Math.max(0, s.borderW);
  if (bw > 0 || T.cells.some((c) => c.borders)) {
    for (const c of T.cells) {
      const rowAlpha = clamp01(reveal * (T.nR + 1) - c.r); if (rowAlpha <= 0) continue;
      const x = colX[c.c]; const y = rowY[c.r]; const cw = colX[c.c + c.cs] - x; const ch = rowY[Math.min(T.nR, c.r + c.rs)] - y;
      const side = (name, x0, y0, x1, y1) => { const b = c.borders?.[name]; if (b?.none) return; const wpx = b?.wpt != null ? b.wpt * (unit || 1) : (b?.w ?? bw); if (!wpx) return; g.strokeStyle = b?.color ?? s.border; g.lineWidth = wpx; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
      g.save(); g.globalAlpha *= rowAlpha;
      side('t', x, y, x + cw, y); side('b', x, y + ch, x + cw, y + ch); side('l', x, y, x, y + ch); side('r', x + cw, y, x + cw, y + ch);
      g.restore();
    }
  }
  g.restore();
  return { rowY, colX };
}

/** CSV / TSV / pasted-sheet text -> rows. Handles quoted fields. */
export function parseDelimited(text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!t) return [];
  const delim = t.split('\n')[0].includes('\t') ? '\t' : ',';
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  row.push(cur); rows.push(row);
  return rows;
}

/** Rows (first row = header, first column = categories) -> chart spec fields. Numbers are parsed leniently ("1,200", "45%"). */
export function chartFromRows(rows, { type = 'column' } = {}) {
  const num = (v) => { const n = Number(String(v ?? '').replace(/[,%$€£\s]/g, '')); return Number.isFinite(n) ? n : 0; };
  if (!rows.length) return {};
  const head = rows[0]; const body = rows.slice(1);
  if (type === 'scatter') return { categories: body.map((r) => r[0]), series: head.slice(1).map((n, j) => ({ name: n, values: body.map((r) => num(r[j + 1])), xs: body.map((r) => num(r[0])) })) };
  return { categories: body.map((r) => r[0] ?? ''), series: head.slice(1).map((n, j) => ({ name: n || `Series ${j + 1}`, values: body.map((r) => num(r[j + 1])) })) };
}
export const rowsFromChart = (c) => { const s = normChart(c); return [['', ...s.series.map((x) => x.name)], ...s.categories.map((n, i) => [n, ...s.series.map((x) => x.values[i])])]; };
