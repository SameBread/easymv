import { Renderer } from '../js/renderer.js';
import { GeneratedAsset } from '../js/assets.js';
import { buildPlan, P, PROPERTY_COUNT } from '../js/animation.js';
import { FX_KINDS } from '../js/effects.js';
const out = {};
try {
  const mk = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); return c; };
  const atlas = mk(32, 32, (g) => { [['#f00', '#0f0'], ['#00f', '#ff0']].forEach((r, y) => r.forEach((col, x) => { g.fillStyle = col; g.fillRect(x * 16, y * 16, 16, 16); })); });
  const bg = mk(8, 8, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 8, 8); });
  const bmp = (cv) => createImageBitmap(cv, { premultiplyAlpha: 'premultiply' });
  const sprite = { def: { id: 's', type: 'spriteSheet', filter: 'nearest', fit: 'natural' }, ready: true, width: 16, height: 16, frameCount: 4,
    textureIndex: () => 0,
    uvRect: (i) => { const c = i % 2, r = Math.floor(i / 2); return [(c * 16 + .5) / 32, (r * 16 + .5) / 32, (c * 16 + 15.5) / 32, (r * 16 + 15.5) / 32]; },
    async textureSource() { return { image: await bmp(atlas) }; } };
  const back = { def: { id: 'b', type: 'static' }, ready: true, width: 8, height: 8, frameCount: 1,
    textureIndex: () => 0, uvRect: () => [0, 0, 1, 1], async textureSource() { return { image: await bmp(bg) }; } };
  const W = 128;
  const r = new Renderer(document.getElementById('c'), { width: W, height: W, budgetMB: 8 });
  const props = (o) => { const a = new Float32Array(PROPERTY_COUNT); a.set([.5, .5, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, .5, .5, 1, 1]); for (const [k, v] of Object.entries(o)) a[P[k]] = v; return a; };
  const snap = () => { const g = document.createElement('canvas'); g.width = W; g.height = W; const c = g.getContext('2d'); c.drawImage(document.getElementById('c'), 0, 0); return c.getImageData(0, 0, W, W).data; };
  const px = (x, y) => { const d = snap(); const i = (y * W + x) * 4; return Array.from(d.slice(i, i + 4)); };
  const lit = (d) => { let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) n++; return n; };
  const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  async function frame(assets, per, f, vf = 0, opts = {}) {
    const plan = buildPlan(assets, { get: (e, p) => per[e][p] }, vf, 30);
    for (const it of plan) if (it.asset === sprite) it.frameA = f;
    await r.prepare(plan); r.draw(plan, opts);
    return plan;
  }
  // painter order is array order: background first, sprite on top
  await frame([back, sprite], [props({}), props({ scale: 4 })], 1); out.greenCenter = px(64, 64); out.whiteCorner = px(2, 2);
  await frame([back, sprite], [props({}), props({ scale: 4 })], 2); out.blueCenter = px(64, 64);
  await frame([back, sprite], [props({}), props({ scale: 4, opacity: .5 })], 0); out.halfRed = px(64, 64);
  await frame([back, sprite], [props({}), props({ scale: 4, hueShift: 120 })], 0); out.hue120 = px(64, 64);
  await frame([back, sprite], [props({}), props({ scale: 4, blur: 20 })], 0); out.blurEdge = px(33, 64);
  await frame([back, sprite], [props({}), props({ scale: 2, positionX: .25 })], 0); out.moved = [px(32, 64), px(96, 64)];
  // reversing the array puts the white background on top
  await frame([sprite, back], [props({ scale: 4 }), props({})], 0); out.bgOnTop = px(64, 64);

  // ---- generated layers ----
  const dark = { ...back, def: { id: 'k', type: 'static' }, async textureSource() { return { image: await bmp(mk(8, 8, (g) => { g.fillStyle = '#000'; g.fillRect(0, 0, 8, 8); })) }; } };
  const nbands = 32;
  const spec = { data: new Float32Array(400 * nbands).fill(0.8), bands: nbands, rate: 100 };
  r.audio = { fps: 30, spectrum: () => spec, pcm: () => null };
  r.avoid = [];
  const vis = new GeneratedAsset({ id: 'v', type: 'visualizer', vis: { shape: 'circle', mode: 'bars', count: 48, radius: 0.25, length: 0.15 } });
  await frame([dark, vis], [props({}), props({})], 0, 10); const visA = snap(); out.visLit = lit(visA);
  out.visCenterDark = px(64, 64);
  await frame([dark, vis], [props({}), props({})], 0, 50); await frame([dark, vis], [props({}), props({})], 0, 10); out.visDeterministic = same(visA, snap());
  const tri = new GeneratedAsset({ id: 't', type: 'visualizer', vis: { shape: 'triangle', mode: 'spikes', count: 48, radius: 0.25, length: 0.15 } });
  await frame([dark, tri], [props({}), props({})], 0, 10); out.triLit = lit(snap()); out.triDiffers = !same(visA, snap());
  const sq = new GeneratedAsset({ id: 'q', type: 'visualizer', vis: { shape: 'square', mode: 'wave', count: 64, radius: 0.25, length: 0.15 } });
  r.audio = { fps: 30, spectrum: () => spec, pcm: () => ({ data: Float32Array.from({ length: 44100 * 2 }, (_, i) => Math.sin(i / 30)), channels: 1, sampleRate: 44100 }) };
  await frame([dark, sq], [props({}), props({})], 0, 10); out.waveLit = lit(snap());

  const snow = new GeneratedAsset({ id: 'n', type: 'effect', fx: { kind: 'snow', count: 300, size: 10 } });
  await frame([dark, snow], [props({}), props({})], 0, 20); const sA = snap(); out.snowLit = lit(sA);
  await frame([dark, snow], [props({}), props({})], 0, 60); out.snowMoves = !same(sA, snap());
  await frame([dark, snow], [props({}), props({})], 0, 20); out.snowDeterministic = same(sA, snap());
  const fire = new GeneratedAsset({ id: 'f', type: 'effect', fx: { kind: 'pixelFire', pixel: 8 } });
  await frame([dark, fire], [props({}), props({})], 0, 20); out.fireLit = lit(snap());
  const lofi = new GeneratedAsset({ id: 'g', type: 'effect', fx: { kind: 'glitter', count: 120, pixel: 8, fps: 8 } });
  await frame([dark, lofi], [props({}), props({})], 0, 5); out.lofiLit = lit(snap());

  const lyr = new GeneratedAsset({ id: 'l', type: 'lyrics', lyrics: { lines: [{ t0: 0, text: 'HELLO WORLD' }], style: { size: 0.2, color: '#ffffff' }, anim: { in: 'none', out: 'none' }, layout: { mode: 'center', seed: 1, avoid: false } } });
  await frame([dark, lyr], [props({}), props({})], 0, 15); out.lyricsLit = lit(snap());
  await frame([dark, lyr], [props({}), props({})], 0, 15 + 30 * 40); out.lyricsGone = lit(snap());

  const scr = new GeneratedAsset({ id: 'k', type: 'script', script: { text: '# Hello world\nBig **ideas** here\n\n- one\n- two', pack: 'punchy', seed: 2 } });
  await frame([dark, scr], [props({}), props({})], 0, 60); out.scriptLit = lit(snap());
  await frame([dark, scr], [props({}), props({})], 0, 60 + 30 * 3); out.scriptLit2 = lit(snap());
  await frame([dark, scr], [props({}), props({})], 0, 60 + 30 * 3 - 4); out.scriptTrans = lit(snap());

  // ---- stacking audit: effects must overlay, not cover; order must be respected ----
  const blue = { ...back, def: { id: 'bl', type: 'static' }, async textureSource() { return { image: await bmp(mk(8, 8, (g) => { g.fillStyle = '#3366aa'; g.fillRect(0, 0, 8, 8); })) }; } };
  const near = (r, g, b) => Math.abs(r - 51) + Math.abs(g - 102) + Math.abs(b - 170) < 14;
  const frac = () => { const d = snap(); let n = 0; for (let i = 0; i < d.length; i += 4) if (near(d[i], d[i + 1], d[i + 2])) n++; return n / (d.length / 4); };
  out.fxCover = {};
  for (const kind of Object.keys(FX_KINDS)) {
    const fa = new GeneratedAsset({ id: `f_${kind}`, type: 'effect', fx: { kind } });
    await frame([blue, fa], [props({}), props({})], 0, 45); out.fxCover[kind] = +frac().toFixed(2);
  }
  const rainA = new GeneratedAsset({ id: 'rn', type: 'effect', fx: { kind: 'rain' } });
  const scrA = new GeneratedAsset({ id: 'sc', type: 'script', script: { text: '# Hello\nbig **words**', bgMode: 'none', place: 'full', pack: 'punchy', seed: 2 } });
  const white = () => { const d = snap(); let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++; return n; };
  await frame([blue, rainA, scrA], [props({}), props({}), props({})], 0, 60); out.stackA = { bg: +frac().toFixed(2), text: white() };
  await frame([rainA, blue, scrA], [props({}), props({}), props({})], 0, 60); out.stackB = { bg: +frac().toFixed(2), text: white() };
  await frame([rainA, scrA, blue], [props({}), props({}), props({})], 0, 60); out.stackC = { bg: +frac().toFixed(2), text: white() };
  await frame([blue, scrA, rainA], [props({}), props({}), props({})], 0, 60); out.stackD = { bg: +frac().toFixed(2), text: white() };
  const hid = props({}); hid[P.visible] = 0;
  await frame([blue, rainA, scrA], [props({}), hid, props({})], 0, 60); out.hideRain = { bg: +frac().toFixed(2) };
  await frame([blue, rainA, scrA], [props({}), props({}), hid], 0, 60); out.hideScript = { text: white() };
  await frame([blue, rainA, scrA], [hid, props({}), props({})], 0, 60); out.hideBlue = { bg: +frac().toFixed(2) };
  // semi-transparent image keeps what is underneath
  const half = { ...back, def: { id: 'hf', type: 'static' }, async textureSource() { return { image: await bmp(mk(8, 8, (g) => { g.fillStyle = 'rgba(255,0,0,0.5)'; g.fillRect(0, 0, 8, 8); })) }; } };
  await frame([blue, half], [props({}), props({})], 0, 5); out.halfOver = px(64, 64);

  // culling equality: an invisible layer must draw exactly what no layer draws
  await frame([dark, vis], [props({}), props({ visible: 0 })], 0, 10); const hidden = snap();
  await frame([dark], [props({})], 0, 10); out.cullEqual = same(hidden, snap());
  out.visFlagCulled = (await frame([dark, vis], [props({}), props({ visible: 0 })], 0, 10)).length === 1;
} catch (e) { out.error = String(e.stack || e); }
window.__out = out;
