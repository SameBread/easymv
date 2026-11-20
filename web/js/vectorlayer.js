// Native Shape / Chart / Table layers. Each layer rasterises its spec (vector.js) to a canvas, which the renderer uploads
// as a texture and draws with the usual transform, opacity, blend, blur and colour properties. The layer's Intensity
// property is its "reveal" (0 = nothing yet, 1 = fully drawn), so it can be keyframed or linked to the music like any other.

import { paintShape, drawRich, drawChart, drawTable, parseRich, CHART_DEFAULTS, TABLE_DEFAULTS, normChart } from './vector.js';
import { familyCss, migrateFont } from './fonts.js';

export const VECTOR_TYPES = ['shape', 'chart', 'table'];
export const isVectorType = (t) => VECTOR_TYPES.includes(t);

export const SHAPE_DEFAULTS = {
  prst: 'roundRect', adj: {}, fillMode: 'solid', color: '#4e79a7', color2: '#9fc5e8', angle: 90, opacity: 1,
  lineColor: '#ffffff', lineW: 0, dash: 'solid', head: 'none', tail: 'none', shadow: 0,
  text: '', textColor: '#ffffff', textSize: 0.16, align: 'ctr', anchor: 'middle', font: 'Inter', bold: false,
  w: 0.3, h: 0.3,
};

export function vectorSettings(def) {
  if (def.type === 'shape') return { ...SHAPE_DEFAULTS, ...def.shape, adj: { ...def.shape?.adj } };
  if (def.type === 'chart') return { w: 0.7, h: 0.6, ...CHART_DEFAULTS, ...def.chart };
  return { w: 0.7, h: 0.5, ...TABLE_DEFAULTS, ...def.table };
}

/** Size of the layer's box in canvas pixels, and the margin kept around it for strokes and shadows. */
export function vectorBox(def, W, H) {
  const s = vectorSettings(def);
  const bw = Math.max(8, Math.round(s.w * W)); const bh = Math.max(8, Math.round(s.h * H));
  let pad = 2;
  if (def.type === 'shape') pad = Math.ceil((s.lineW * H) / 1080 / 2 + s.shadow * 24 * (H / 1080) + 3);
  return { bw, bh, pad };
}

function shapeSpec(s, W, H, bw, bh) {
  const k = H / 1080;
  const fill = s.fillMode === 'none' ? { type: 'none' } : s.fillMode === 'gradient' ? { type: 'grad', ang: s.angle, stops: [{ pos: 0, hex: s.color }, { pos: 1, hex: s.color2 }], alpha: s.opacity } : { type: 'solid', hex: s.color, alpha: s.opacity };
  const lw = s.lineW * k;
  const line = lw > 0 || ['line', 'arc'].includes(s.prst) ? { w: Math.max(1, lw || 4 * k), color: s.lineColor, alpha: 1, dash: s.dash, head: s.head, tail: s.tail, cap: 'round' } : null;
  const shadow = s.shadow > 0 ? { color: 'rgba(0,0,0,0.5)', blur: 24 * k * s.shadow, dx: 0, dy: 8 * k * s.shadow } : null;
  void bw; void bh; void W;
  return { geom: { prst: s.prst, adj: s.adj }, fill, line, shadow };
}

/** Draw a vector layer to a canvas (size = box + margin on every side). Browser only. */
export function renderVector(def, W, H, progress = 1, makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h })) {
  const s = vectorSettings(def);
  const { bw, bh, pad } = vectorBox(def, W, H);
  const cv = makeCanvas(bw + pad * 2, bh + pad * 2);
  const g = cv.getContext('2d');
  g.translate(pad, pad);
  const fam = `${familyCss(migrateFont(s.font || 'Inter'))}`;
  if (def.type === 'shape') {
    const p = Math.max(0, Math.min(1, progress));
    g.save();
    if (p < 1) { g.translate(bw / 2, bh / 2); g.scale(0.6 + 0.4 * p, 0.6 + 0.4 * p); g.translate(-bw / 2, -bh / 2); }
    g.globalAlpha = p;
    paintShape(g, shapeSpec(s, W, H, bw, bh), bw, bh);
    if (s.text) {
      const size = Math.max(8, s.textSize * bh);
      const inset = Math.min(bw, bh) * 0.1;
      const runs = parseRich(s.text);
      drawRich(g, [{ runs: s.bold ? runs.map((r) => ({ ...r, b: true })) : runs, align: s.align }], { x: inset, y: inset * 0.6, w: bw - inset * 2, h: bh - inset * 1.2 }, { family: fam, size, color: s.textColor, anchor: s.anchor, weight: s.bold ? 700 : 400 });
    }
    g.restore();
  } else if (def.type === 'chart') {
    drawChart(g, { ...s, fontCss: fam }, bw, bh, progress);
  } else {
    drawTable(g, { ...s, fontCss: fam }, bw, bh, progress);
  }
  return { canvas: cv, pad, bw, bh };
}

/** Cache key: everything that changes the picture. Progress is bucketed so a grow-in does not re-render every frame. */
export function vectorKey(def, W, H, progress) {
  const s = def.type === 'shape' ? def.shape : def.type === 'chart' ? def.chart : def.table;
  const step = def.type === 'shape' ? 20 : 40;
  return `vec|${def.id}|${W}x${H}|${Math.round(Math.max(0, Math.min(1, progress)) * step)}|${JSON.stringify(s)}`;
}

export { normChart };
