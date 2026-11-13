import { Renderer } from '../js/renderer.js';
import { buildPlan, P } from '../js/animation.js';
const out = {};
try {
  const mk = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); return c; };
  const atlas = mk(32, 32, (g) => { [['#f00', '#0f0'], ['#00f', '#ff0']].forEach((r, y) => r.forEach((col, x) => { g.fillStyle = col; g.fillRect(x * 16, y * 16, 16, 16); })); });
  const bg = mk(8, 8, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 8, 8); });
  const bmp = (cv) => createImageBitmap(cv, { premultiplyAlpha: 'premultiply' });
  const sprite = { def: { id: 's', type: 'spriteSheet', zIndex: 1, filter: 'nearest', fit: 'natural' }, ready: true, width: 16, height: 16, frameCount: 4,
    textureIndex: () => 0,
    uvRect: (i) => { const c = i % 2, r = Math.floor(i / 2); return [(c * 16 + .5) / 32, (r * 16 + .5) / 32, (c * 16 + 15.5) / 32, (r * 16 + 15.5) / 32]; },
    async textureSource() { return { image: await bmp(atlas) }; } };
  const back = { def: { id: 'b', type: 'static', zIndex: 0 }, ready: true, width: 8, height: 8, frameCount: 1,
    textureIndex: () => 0, uvRect: () => [0, 0, 1, 1], async textureSource() { return { image: await bmp(bg) }; } };
  const r = new Renderer(document.getElementById('c'), { width: 128, height: 128, budgetMB: 8 });
  const props = (o) => { const a = new Float32Array([.5, .5, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, .5, .5]); for (const [k, v] of Object.entries(o)) a[P[k]] = v; return a; };
  const px = (x, y) => { const g = document.createElement('canvas'); g.width = 128; g.height = 128; const c = g.getContext('2d'); c.drawImage(document.getElementById('c'), 0, 0); return Array.from(c.getImageData(x, y, 1, 1).data); };
  async function frame(per, f) {
    const plan = buildPlan([sprite, back], { get: (e, p) => per[e][p] }, 0, 30);
    for (const it of plan) if (it.asset === sprite) it.frameA = f;
    await r.prepare(plan); r.draw(plan);
  }
  await frame([props({ scale: 4 }), props({})], 1); out.greenCenter = px(64, 64); out.whiteCorner = px(2, 2);
  await frame([props({ scale: 4 }), props({})], 2); out.blueCenter = px(64, 64);
  await frame([props({ scale: 4, opacity: .5 }), props({})], 0); out.halfRed = px(64, 64);
  await frame([props({ scale: 4, hueShift: 120 }), props({})], 0); out.hue120 = px(64, 64);
  await frame([props({ scale: 4, blur: 20 }), props({})], 0); out.blurEdge = px(33, 64);
  await frame([props({ scale: 2, positionX: .25 }), props({})], 0); out.moved = [px(32, 64), px(96, 64)];
} catch (e) { out.error = String(e.stack || e); }
window.__out = out;
