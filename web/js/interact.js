// Preview interaction maths: where is an element on the canvas, and what is under a pointer?
// Mirrors the vertex shader in renderer.js (translate * rotate * scale * mirror * anchor).

import { P, defaultFit, fitSize } from './animation.js';
import { visSettings, visExtent } from './visualizer.js';
import { fxSettings } from './effects.js';
import { lyricsSettings } from './lyrics.js';
import { vectorBox } from './vectorlayer.js';

function geometry(item, cw, ch) {
  const { asset, props } = item;
  let bw; let bh; let offY = 0;
  if (item.kind === 'visualizer') { const e = visExtent(visSettings(asset.def), Math.min(cw, ch)); bw = e.w; bh = e.h; }
  else if (item.kind === 'effect') { const f = fxSettings(asset.def); bw = f.area[0] * cw; bh = f.area[1] * ch; }
  else if (item.kind === 'script') { bw = cw; bh = ch; }
  else if (item.kind === 'vector') { const b = vectorBox(asset.def, cw, ch); bw = b.bw; bh = b.bh; }
  else if (item.kind === 'lyrics') {
    const l = lyricsSettings(asset.def);
    bw = l.style.maxWidth * cw; bh = l.style.size * ch * 2.6;
    offY = ({ lower: 0.34, upper: -0.34 }[l.layout.mode] ?? 0) * ch;
  } else [bw, bh] = fitSize(defaultFit(asset.def), asset.width, asset.height, cw, ch);
  const sc = props[P.scale];
  return {
    px: props[P.positionX] * cw, py: props[P.positionY] * ch + offY,
    w: bw * sc * props[P.scaleX], h: bh * sc * props[P.scaleY],
    rot: props[P.rotation],
    ax: item.kind === 'image' ? props[P.anchorX] : 0.5, ay: item.kind === 'image' ? props[P.anchorY] : 0.5,
    mx: props[P.mirrorX] >= 0.5 ? -1 : 1, my: props[P.mirrorY] >= 0.5 ? -1 : 1,
  };
}

/** Four canvas-pixel corners of the element quad, order (0,0) (1,0) (1,1) (0,1). */
export function itemQuad(item, cw, ch) {
  const g = geometry(item, cw, ch);
  const c = Math.cos(g.rot); const s = Math.sin(g.rot);
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([qx, qy]) => {
    const lx = (qx - g.ax) * g.mx * g.w; const ly = (qy - g.ay) * g.my * g.h;
    return [c * lx - s * ly + g.px, s * lx + c * ly + g.py];
  });
}

export function pointInItem(item, x, y, cw, ch) {
  const g = geometry(item, cw, ch);
  if (g.w === 0 || g.h === 0) return false;
  const c = Math.cos(-g.rot); const s = Math.sin(-g.rot);
  const dx = x - g.px; const dy = y - g.py;
  const lx = c * dx - s * dy; const ly = s * dx + c * dy;
  const qx = lx / (g.w * g.mx) + g.ax; const qy = ly / (g.h * g.my) + g.ay;
  return qx >= 0 && qx <= 1 && qy >= 0 && qy <= 1;
}

/** Topmost visible item under (x, y) in canvas pixels. `plan` is z-sorted ascending. */
export function hitTest(plan, x, y, cw, ch) {
  // a full-canvas script block would swallow every click, so it only counts when nothing else is under the pointer
  let script = null;
  for (let i = plan.length - 1; i >= 0; i--) {
    const it = plan[i];
    if (it.props[P.opacity] < 0.02) continue; // invisible right now: not clickable
    if (it.kind === 'script') { script ??= it; continue; }
    if (pointInItem(it, x, y, cw, ch)) return it;
  }
  return script;
}

/** Quad centre in canvas px. */
export const itemCenter = (item, cw, ch) => { const q = itemQuad(item, cw, ch); return [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2]; };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Apply a drag (normalized dx, dy) and/or scale factor to an element's base values. */
export function nudgeBase(def, dxNorm, dyNorm, scaleFactor = 1) {
  def.base ??= {};
  const b = def.base;
  if (dxNorm || dyNorm) {
    b.positionX = clamp((b.positionX ?? 0.5) + dxNorm, -1, 2);
    b.positionY = clamp((b.positionY ?? 0.5) + dyNorm, -1, 2);
  }
  if (scaleFactor !== 1) {
    b.scaleX = clamp((b.scaleX ?? 1) * scaleFactor, 0.01, 10);
    b.scaleY = clamp((b.scaleY ?? 1) * scaleFactor, 0.01, 10);
  }
}
