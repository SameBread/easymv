// PowerPoint (.pptx) import.
//
// A .pptx is a zip of XML parts. `parsePptx` reads it into a plain model (no canvas, no DOM beyond DOMParser):
//   slide.items   everything that is *not text*, in paint order (master and layout decorations first): shapes with
//                 geometry / fill / line / shadow, pictures with crop, table cells
//   slide.blocks  every text box with its position, paragraphs, font size, alignment, colour
// `renderSlideArt` paints the items onto a canvas (the slide's artwork); `planSlides` turns the text blocks into
// timed script scenes placed exactly where they sat on the slide, splitting wordy boxes into readable pages.

import { unzipSync } from '../vendor/fflate.js';
import { fmtT } from './scripttext.js';
import { paintShape, drawChart, drawTable, drawRich, CHART_PALETTE } from './vector.js';

const td = new TextDecoder();
const defaultParse = (s) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el, name) => (el ? [...el.getElementsByTagName(name)] : []);
const first = (el, name) => el?.getElementsByTagName(name)[0] ?? null;
const child = (el, name) => (el ? [...el.childNodes].find((n) => n.nodeType === 1 && n.nodeName === name) ?? null : null);
const children = (el) => (el ? [...el.childNodes].filter((n) => n.nodeType === 1) : []);
const num = (v, d = 0) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
function resolve(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = [];
  for (const s of (dirOf(base) + target).split('/')) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); }
  return out.join('/');
}

// ---------- colours ----------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
function hexToRgb(h) { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const rgbToHex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const l = (mx + mn) / 2; let h = 0; let s = 0;
  if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
  return [h, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
export const luminance = (hex) => { const [r, g, b] = hexToRgb(hex).map((v) => v / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const PRST_COLORS = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080', orange: '#ffa500' };

/** Parse a DrawingML colour element (the parent holding srgbClr / schemeClr / ...) into { hex, alpha }. */
function readColor(parent, theme) {
  const c = children(parent).find((n) => /^a:(srgbClr|schemeClr|sysClr|prstClr|scrgbClr|hslClr)$/.test(n.nodeName));
  if (!c) return null;
  let hex = null;
  if (c.nodeName === 'a:srgbClr') hex = `#${c.getAttribute('val')}`;
  else if (c.nodeName === 'a:sysClr') hex = `#${c.getAttribute('lastClr') ?? 'ffffff'}`;
  else if (c.nodeName === 'a:prstClr') hex = PRST_COLORS[c.getAttribute('val')] ?? '#000000';
  else if (c.nodeName === 'a:schemeClr') {
    const v = c.getAttribute('val'); const m = theme.clrMap?.[v] ?? v;
    hex = theme.colors[m] ? `#${theme.colors[m]}` : (v === 'phClr' ? null : '#808080');
  }
  if (!hex) return null;
  let rgb = hexToRgb(hex); let alpha = 1;
  for (const t of children(c)) {
    const v = num(t.getAttribute('val'), 100000) / 100000;
    const n = t.nodeName.replace('a:', '');
    if (n === 'alpha') alpha = v;
    else if (['lumMod', 'lumOff', 'satMod', 'tint', 'shade'].includes(n)) {
      let [h, s, l] = rgbToHsl(rgb);
      if (n === 'lumMod') l = clamp01(l * v); else if (n === 'lumOff') l = clamp01(l + v); else if (n === 'satMod') s = clamp01(s * v);
      else if (n === 'tint') l = clamp01(l + (1 - l) * (1 - v)); else if (n === 'shade') l = clamp01(l * v);
      rgb = hslToRgb([h, s, l]);
    }
  }
  return { hex: rgbToHex(rgb), alpha };
}

// ---------- parse ----------

/** Parse a .pptx (Uint8Array / ArrayBuffer) into { size: {w,h} EMU, slides, media: Map(path -> bytes) }. */
export function parsePptx(data, { parseXml = defaultParse } = {}) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  let files;
  try { files = unzipSync(u8); } catch { throw new Error('That file is not a valid .pptx (could not open it as a zip).'); }
  const xmlCache = new Map();
  const xml = (path) => { if (xmlCache.has(path)) return xmlCache.get(path); const t = files[path] ? td.decode(files[path]) : null; const d = t == null ? null : parseXml(t); xmlCache.set(path, d); return d; };
  const pres = xml('ppt/presentation.xml');
  if (!pres) throw new Error('This does not look like a PowerPoint file (no ppt/presentation.xml). Old .ppt files are not supported; save as .pptx.');
  const relsCache = new Map();
  const rels = (part) => {
    if (relsCache.has(part)) return relsCache.get(part);
    const doc = xml(`${dirOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`); const m = new Map();
    if (doc) for (const r of kids(doc, 'Relationship')) if (r.getAttribute('TargetMode') !== 'External') m.set(r.getAttribute('Id'), resolve(part, r.getAttribute('Target')));
    relsCache.set(part, m); return m;
  };
  const sz = first(pres, 'p:sldSz');
  const size = { w: num(sz?.getAttribute('cx'), 12192000), h: num(sz?.getAttribute('cy'), 6858000) };
  const presRels = rels('ppt/presentation.xml');
  const slidePaths = kids(pres, 'p:sldId').map((s) => presRels.get(s.getAttribute('r:id'))).filter((p) => p && files[p]);

  // theme colours + the default text styles of the master
  const theme = { colors: {}, clrMap: { bg1: 'lt1', bg2: 'lt2', tx1: 'dk1', tx2: 'dk2' } };
  const themePath = Object.keys(files).find((k) => /^ppt\/theme\/theme\d+\.xml$/.test(k));
  const cs = themePath && first(xml(themePath), 'a:clrScheme');
  for (const c of children(cs)) { const v = c.firstElementChild; theme.colors[c.nodeName.replace('a:', '')] = v?.nodeName === 'a:srgbClr' ? v.getAttribute('val') : v?.getAttribute('lastClr'); }

  const media = new Map();
  const useMedia = (p) => { if (p && files[p] && !media.has(p)) media.set(p, files[p]); return p; };

  const parseFill = (spPr, rmap) => {   // -> { type: 'solid'|'grad'|'blip'|'none', ... } | undefined (inherit)
    if (!spPr) return undefined;
    if (child(spPr, 'a:noFill')) return { type: 'none' };
    const solid = child(spPr, 'a:solidFill'); if (solid) { const c = readColor(solid, theme); return c ? { type: 'solid', ...c } : undefined; }
    const grad = child(spPr, 'a:gradFill');
    if (grad) {
      const stops = kids(grad, 'a:gs').map((g) => ({ pos: num(g.getAttribute('pos')) / 100000, ...readColor(g, theme) })).filter((s) => s.hex);
      const lin = first(grad, 'a:lin');
      if (stops.length) return { type: 'grad', stops, ang: num(lin?.getAttribute('ang')) / 60000, path: !!first(grad, 'a:path') };
    }
    const bf = child(spPr, 'a:blipFill'); const blip = bf && first(bf, 'a:blip');
    if (blip) { const p = rmap.get(blip.getAttribute('r:embed')); if (p && files[p]) return { type: 'blip', path: useMedia(p), alpha: num(first(blip, 'a:alphaModFix')?.getAttribute('amt'), 100000) / 100000 }; }
    return undefined;
  };
  const parseLine = (spPr) => {
    const ln = child(spPr, 'a:ln'); if (!ln) return undefined;
    if (child(ln, 'a:noFill')) return { none: true };
    const c = readColor(child(ln, 'a:solidFill'), theme);
    const end = (n) => { const t = child(ln, n)?.getAttribute('type'); return t && t !== 'none' ? ({ triangle: 'triangle', arrow: 'arrow', stealth: 'stealth', oval: 'oval', diamond: 'diamond' }[t] ?? 'triangle') : null; };
    return { w: num(ln.getAttribute('w'), 12700), color: c?.hex, alpha: c?.alpha ?? 1, dash: child(ln, 'a:prstDash')?.getAttribute('val') ?? null, head: end('a:headEnd'), tail: end('a:tailEnd'), cap: ln.getAttribute('cap') === 'rnd' ? 'round' : undefined };
  };
  const parseShadow = (spPr) => {
    const sh = child(child(spPr, 'a:effectLst'), 'a:outerShdw'); if (!sh) return undefined;
    const c = readColor(sh, theme);
    return { blur: num(sh.getAttribute('blurRad')), dist: num(sh.getAttribute('dist')), dir: num(sh.getAttribute('dir')) / 60000, color: c?.hex ?? '#000000', alpha: c?.alpha ?? 0.4 };
  };
  const parseGeom = (spPr) => {
    const pg = child(spPr, 'a:prstGeom');
    if (pg) { const adj = {}; for (const g of kids(pg, 'a:gd')) adj[g.getAttribute('name')] = num(/val (-?\d+)/.exec(g.getAttribute('fmla') ?? '')?.[1]); return { prst: pg.getAttribute('prst'), adj }; }
    const cg = child(spPr, 'a:custGeom');
    if (cg) {
      const paths = kids(cg, 'a:path').map((p) => ({ w: num(p.getAttribute('w')), h: num(p.getAttribute('h')), fill: p.getAttribute('fill') !== 'none',
        cmds: children(p).map((c) => ({ t: c.nodeName.replace('a:', ''), pts: kids(c, 'a:pt').map((q) => [num(q.getAttribute('x')), num(q.getAttribute('y'))]), arc: c.nodeName === 'a:arcTo' ? { wR: num(c.getAttribute('wR')), hR: num(c.getAttribute('hR')), st: num(c.getAttribute('stAng')) / 60000, sw: num(c.getAttribute('swAng')) / 60000 } : null })) }));
      return { cust: paths };
    }
    return null;
  };
  const parseXfrm = (holder) => {
    const x = child(holder, 'a:xfrm') ?? child(holder, 'p:xfrm'); if (!x) return null;
    const o = child(x, 'a:off'); const e = child(x, 'a:ext'); if (!o || !e) return null;
    return { x: num(o.getAttribute('x')), y: num(o.getAttribute('y')), w: num(e.getAttribute('cx')), h: num(e.getAttribute('cy')), rot: num(x.getAttribute('rot')) / 60000, fh: x.getAttribute('flipH') === '1', fv: x.getAttribute('flipV') === '1',
      ch: child(x, 'a:chOff') ? { x: num(child(x, 'a:chOff').getAttribute('x')), y: num(child(x, 'a:chOff').getAttribute('y')), w: num(child(x, 'a:chExt')?.getAttribute('cx')), h: num(child(x, 'a:chExt')?.getAttribute('cy')) } : null };
  };
  const styleColor = (sp, ref) => { const r = child(child(sp, 'p:style'), ref); return r ? readColor(r, theme) : null; };

  const tagText = (t, st) => {
    const safe = t.replace(/<(\/?[biusBIUS])>/g, '\u2039$1\u203a');
    if (!safe.trim()) return safe;
    const lead = /^\s*/.exec(safe)[0]; const trail = /\s*$/.exec(safe)[0]; const core = safe.trim();
    let o = ''; let c = '';
    for (const k of ['b', 'i', 'u', 's']) if (st[k]) { o += `<${k}>`; c = `</${k}>${c}`; }
    return `${lead}${o}${core}${c}${trail}`;
  };
  const runStyle = (rPr, defAttr) => {
    const a = (n) => rPr?.getAttribute(n) ?? defAttr?.(n) ?? null;
    const u = a('u'); const sk = a('strike');
    return { b: a('b') === '1', i: a('i') === '1', u: !!u && u !== 'none', s: !!sk && sk !== 'noStrike' };
  };
  /** Paragraphs of a text body as plain runs: [{ runs: [{ t, b, i, u, s, color, sz (pt) }], algn }]. Used where text is drawn by the art itself (tables, SmartArt). */
  const readRichParas = (body, { sz = 18, color = null } = {}) => {
    const out = [];
    for (const p of kids(body, 'a:p')) {
      const runs = [];
      for (const n of children(p)) {
        if (n.nodeName === 'a:br') { runs.push({ t: '\n' }); continue; }
        if (n.nodeName !== 'a:r' && n.nodeName !== 'a:fld') continue;
        const rPr = child(n, 'a:rPr'); const t = first(n, 'a:t')?.textContent ?? '';
        if (!t) continue;
        const c = rPr && readColor(child(rPr, 'a:solidFill'), theme);
        runs.push({ t, ...runStyle(rPr), color: c?.hex ?? color ?? undefined, sz: num(rPr?.getAttribute('sz')) ? num(rPr.getAttribute('sz')) / 100 : sz });
      }
      const pPr = child(p, 'a:pPr');
      const defSz = num(child(p, 'a:endParaRPr')?.getAttribute('sz')) / 100;
      if (!runs.some((r) => r.t.trim())) { if (kids(body, 'a:p').length > 1) out.push({ runs: [{ t: ' ', sz: defSz || sz }], algn: 'l' }); continue; }
      out.push({ runs: runs.map(({ t, ...r }) => ({ t: t === '\n' ? ' ' : t, ...r })), algn: pPr?.getAttribute('algn') ?? 'l', bullet: !!child(pPr, 'a:buChar') });
    }
    return out;
  };
  const mixHex = (a, b, t) => { const x = hexToRgb(a); const y = hexToRgb(b); return rgbToHex(x.map((v, i) => v * (1 - t) + y[i] * t)); };
  const themeHex = (name) => { const v = theme.colors[theme.clrMap?.[name] ?? name]; return v ? `#${v}` : null; };

  // placeholders of a layout / master, for inherited position and text style
  const phMap = (doc) => {
    const m = [];
    for (const sp of kids(doc, 'p:sp')) { const ph = first(sp, 'p:ph'); if (ph) m.push({ type: ph.getAttribute('type') ?? 'body', idx: ph.getAttribute('idx'), sp, xf: parseXfrm(child(sp, 'p:spPr')) }); }
    return m;
  };
  const sameKind = { ctrTitle: 'title', subTitle: 'body', obj: 'body' };
  const findPh = (list, type, idx) => list.find((p) => idx != null && p.idx === idx) ?? list.find((p) => p.type === type) ?? list.find((p) => (sameKind[type] ?? type) === (sameKind[p.type] ?? p.type));


  const mapBox = (b, T) => ({ ...b, x: T.ox + b.x * T.sx, y: T.oy + b.y * T.sy, w: b.w * T.sx, h: b.h * T.sy });
  const accentHex = (i) => themeHex(`accent${(i % 6) + 1}`) ?? CHART_PALETTE[i % CHART_PALETTE.length];

  /** a:tbl -> a table spec for vector.js drawTable. Sizes stay in points; `refH` is the frame height in points. */
  const parseTable = (tbl, box, rmap, T) => {
    const tblPr = child(tbl, 'a:tblPr'); const styled = !!child(tblPr, 'a:tableStyleId');
    const firstRow = tblPr?.getAttribute('firstRow') === '1'; const bandRow = tblPr?.getAttribute('bandRow') === '1'; const firstCol = tblPr?.getAttribute('firstCol') === '1';
    const acc = accentHex(0); const tx1 = themeHex('tx1') ?? '#222222';
    const colW = kids(tbl, 'a:gridCol').map((c) => num(c.getAttribute('w')));
    const trs = kids(tbl, 'a:tr'); const rowH = trs.map((r) => num(r.getAttribute('h')));
    const side = (tcPr, nm) => { const ln = child(tcPr, nm); if (!ln) return undefined; if (child(ln, 'a:noFill')) return { none: true }; const c = readColor(child(ln, 'a:solidFill'), theme); return c ? { wpt: num(ln.getAttribute('w'), 12700) / 12700, color: c.hex } : undefined; };
    const data = trs.map((tr, r) => kids(tr, 'a:tc').filter((tc) => tc.parentNode === tr).map((tc) => {
      if (tc.getAttribute('hMerge') === '1' || tc.getAttribute('vMerge') === '1') return { merged: true };
      const tcPr = child(tc, 'a:tcPr'); let fill = parseFill(tcPr, rmap);
      const head = styled && firstRow && r === 0;
      if (fill === undefined && styled) fill = head ? { type: 'solid', hex: acc } : { type: 'solid', hex: mixHex('#ffffff', acc, bandRow && r % 2 === 1 ? 0.4 : 0.2) };
      const dcolor = head ? '#ffffff' : tx1;
      const paras = readRichParas(child(tc, 'a:txBody') ?? tc, { sz: 18, color: dcolor });
      const bl = { l: side(tcPr, 'a:lnL'), r: side(tcPr, 'a:lnR'), t: side(tcPr, 'a:lnT'), b: side(tcPr, 'a:lnB') };
      const borders = Object.fromEntries(Object.entries(bl).filter(([, v]) => v));
      const al = child(tc, 'a:txBody') && child(child(child(tc, 'a:txBody'), 'a:p'), 'a:pPr')?.getAttribute('algn');
      return { paras: paras.length ? paras.map((p) => ({ ...p, runs: p.runs.map((x) => ({ ...x, b: x.b || head || (styled && firstCol && false) })) })) : [{ runs: [{ t: ' ', sz: 18 }] }], fill: fill?.type === 'none' ? { type: 'none' } : fill ?? null, color: dcolor,
        span: [num(tc.getAttribute('gridSpan'), 1), num(tc.getAttribute('rowSpan'), 1)], anchor: { t: 'top', ctr: 'middle', b: 'bottom' }[tcPr?.getAttribute('anchor') ?? 't'] ?? 'top', align: al ?? 'l', borders: Object.keys(borders).length ? borders : undefined };
    }));
    return { data, header: false, banded: false, colW: colW.length ? colW : undefined, rowH: rowH.some((v) => v > 0) ? rowH : undefined, refH: Math.max(1, box.h / 12700),
      border: styled ? '#ffffff' : '#9a9a9a', borderW: 0, pad: 0.7, fg: tx1, bg: '', valign: 'top', unitBorder: true };
  };

  const txt = (el) => (el ? kids(el, 'a:t').map((t) => t.textContent).join('') : '');
  const ptsOf = (node) => {
    if (!node) return [];
    const cache = first(node, 'c:strCache') ?? first(node, 'c:numCache') ?? first(node, 'c:strLit') ?? first(node, 'c:numLit') ?? node;
    const n = num(first(cache, 'c:ptCount')?.getAttribute('val'));
    const out = new Array(n).fill('');
    for (const pt of kids(cache, 'c:pt')) out[num(pt.getAttribute('idx'))] = first(pt, 'c:v')?.textContent ?? '';
    return out;
  };
  /** A chart part -> chart spec for vector.js drawChart. */
  const parseChart = (doc) => {
    const chart = first(doc, 'c:chart'); const plot = first(chart, 'c:plotArea'); if (!plot) return null;
    const groups = children(plot).filter((n) => /^c:(bar|bar3D|line|line3D|area|area3D|pie|pie3D|ofPie|doughnut|scatter|bubble|radar|stock|surface)Chart$/.test(n.nodeName));
    if (!groups.length) return null;
    const g0 = groups[0]; const kind = g0.nodeName.replace(/^c:|Chart$/g, '').replace('3D', '');
    const dir = first(g0, 'c:barDir')?.getAttribute('val');
    const type = { bar: dir === 'bar' ? 'bar' : 'column', line: 'line', area: 'area', pie: 'pie', ofPie: 'pie', doughnut: 'doughnut', scatter: 'scatter', bubble: 'scatter', radar: 'line', stock: 'line', surface: 'area' }[kind] ?? 'column';
    const gv = child(g0, 'c:grouping')?.getAttribute('val');
    const grouping = gv === 'stacked' ? 'stacked' : gv === 'percentStacked' ? 'percent' : 'clustered';
    const sers = groups.flatMap((g) => kids(g, 'c:ser'));
    const pieLike = type === 'pie' || type === 'doughnut';
    let categories = [];
    const series = sers.map((ser, i) => {
      const catNode = first(ser, 'c:cat') ?? first(ser, 'c:xVal');
      const cats = ptsOf(catNode); if (cats.length > categories.length) categories = cats;
      const vals = ptsOf(first(ser, 'c:val') ?? first(ser, 'c:yVal')).map((v) => Number(v) || 0);
      const fill = parseFill(child(ser, 'c:spPr'), new Map()); const lineFill = readColor(child(child(ser, 'c:spPr'), 'a:ln') && child(child(child(ser, 'c:spPr'), 'a:ln'), 'a:solidFill'), theme);
      const o = { name: first(child(ser, 'c:tx'), 'c:v')?.textContent?.trim() || `Series ${i + 1}`, values: vals, color: (type === 'line' ? lineFill?.hex : fill?.hex) ?? fill?.hex ?? lineFill?.hex ?? accentHex(i) };
      if (type === 'scatter') o.xs = ptsOf(first(ser, 'c:xVal')).map((v, k) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : k + 1));
      if (pieLike) { o.ptColors = []; for (const dp of kids(ser, 'c:dPt')) { const f = parseFill(child(dp, 'c:spPr'), new Map()); if (f?.hex) o.ptColors[num(dp.getAttribute('idx'))] = f.hex; } for (let k = 0; k < vals.length; k++) o.ptColors[k] ??= accentHex(k); }
      return o;
    });
    if (!series.length) return null;
    if (type === 'scatter') categories = series[0].xs.map(String);
    const del = first(chart, 'c:autoTitleDeleted')?.getAttribute('val') === '1';
    let title = txt(child(chart, 'c:title')).trim();
    if (!title && !del && series.length === 1 && !child(chart, 'c:title')) title = '';
    const legendEl = child(chart, 'c:legend'); const lp = child(legendEl, 'c:legendPos')?.getAttribute('val') ?? 'r';
    const dl = first(g0, 'c:dLbls'); const labels = !!dl && (first(dl, 'c:showVal')?.getAttribute('val') === '1' || first(dl, 'c:showPercent')?.getAttribute('val') === '1');
    const mk = (ser) => child(child(ser, 'c:marker'), 'c:symbol')?.getAttribute('val') !== 'none';
    return { type, grouping, title, categories, series, legend: legendEl ? ({ b: 'bottom', r: 'right', t: 'top', l: 'left', tr: 'right' }[lp] ?? 'bottom') : 'none', labels, grid: !!first(plot, 'c:majorGridlines'),
      smooth: sers.some((x) => first(x, 'c:smooth')?.getAttribute('val') === '1'), markers: sers.every(mk), hole: num(first(g0, 'c:holeSize')?.getAttribute('val'), 55) / 100,
      fg: themeHex('tx1') ? mixHex(themeHex('tx1'), themeHex('bg1') ?? '#ffffff', 0.25) : '#444444', bg: '', size: 1, font: 'Inter', palette: [0, 1, 2, 3, 4, 5].map(accentHex) };
  };

  /** SmartArt: use the pre-computed drawing part (dsp:) when the file has one, else lay the node texts out as a row of boxes. */
  const parseSmartArt = (dgm, frame, rmap, T) => {
    const out = [];
    const dmPath = rmap.get(dgm.getAttribute('r:dm')); const dm = dmPath && xml(dmPath);
    const ext = dm && first(dm, 'dsp:dataModelExt'); const dp = ext && rmap.get(ext.getAttribute('relId')); const dd = dp && xml(dp);
    const mk = (local, geom, fill, line, paras, trect, anchor) => {
      const abs = { ...local, x: frame.x + local.x, y: frame.y + local.y };
      const box = mapBox(abs, T);
      const text = paras?.length ? { paras, rect: trect ? { x: (frame.x + trect.x - abs.x) * T.sx, y: (frame.y + trect.y - abs.y) * T.sy, w: trect.w * T.sx, h: trect.h * T.sy } : null, anchor: anchor ?? 'middle' } : null;
      out.push({ kind: 'shape', geom, xf: box, fill, line, shadow: null, text });
    };
    if (dd) {
      for (const sp of kids(dd, 'dsp:sp')) {
        const spPr = child(sp, 'dsp:spPr'); const xf = parseXfrm(spPr); if (!xf) continue;
        const geom = parseGeom(spPr) ?? { prst: 'rect', adj: {} };
        const st = child(sp, 'dsp:style');
        let fill = parseFill(spPr, rmap); let line = parseLine(spPr);
        if (fill === undefined) { const c = readColor(child(st, 'a:fillRef'), theme); fill = c ? { type: 'solid', ...c } : null; }
        if (line === undefined) { const c = readColor(child(st, 'a:lnRef'), theme); line = c && num(child(st, 'a:lnRef')?.getAttribute('idx')) > 0 ? { w: 12700, color: c.hex, alpha: c.alpha } : null; }
        const fc = readColor(child(st, 'a:fontRef'), theme);
        const tb = child(sp, 'dsp:txBody'); const paras = tb ? readRichParas(tb, { sz: 18, color: fc?.hex ?? '#ffffff' }) : [];
        const txf = child(sp, 'dsp:txXfrm'); const o = child(txf, 'a:off'); const e = child(txf, 'a:ext');
        const trect = o && e ? { x: num(o.getAttribute('x')), y: num(o.getAttribute('y')), w: num(e.getAttribute('cx')), h: num(e.getAttribute('cy')) } : null;
        mk(xf, geom, fill ?? null, line ?? null, paras, trect, { t: 'top', ctr: 'middle', b: 'bottom' }[child(tb, 'a:bodyPr')?.getAttribute('anchor') ?? 'ctr'] ?? 'middle');
      }
    } else if (dm) {
      const nodes = kids(dm, 'dgm:pt').filter((p) => (p.getAttribute('type') ?? 'node') === 'node').map((p) => txt(first(p, 'dgm:t'))).filter((t) => t.trim());
      const n = nodes.length; const wide = frame.w >= frame.h; const gap = Math.min(frame.w, frame.h) * 0.06;
      nodes.forEach((t, i) => {
        const bw = wide ? (frame.w - gap * (n - 1)) / n : frame.w; const bh = wide ? frame.h : (frame.h - gap * (n - 1)) / n;
        const local = { x: wide ? i * (bw + gap) : 0, y: wide ? 0 : i * (bh + gap), w: bw, h: bh, rot: 0, fh: false, fv: false };
        const sz = Math.max(8, Math.min(24, (Math.min(bw, bh) / 12700) * 0.26));
        mk(local, { prst: 'roundRect', adj: {} }, { type: 'solid', hex: accentHex(i), alpha: 1 }, null, [{ runs: [{ t, sz, color: '#ffffff', b: false }], algn: 'ctr' }], null, 'middle');
      });
    }
    return out;
  };

  const slides = slidePaths.map((sp) => {
    const doc = xml(sp); const r = rels(sp);
    const layoutPath = [...r.values()].find((v) => v.includes('slideLayouts/'));
    const layoutDoc = layoutPath ? xml(layoutPath) : null; const lr = layoutPath ? rels(layoutPath) : new Map();
    const masterPath = [...lr.values()].find((v) => v.includes('slideMasters/'));
    const masterDoc = masterPath ? xml(masterPath) : null; const mr = masterPath ? rels(masterPath) : new Map();
    const layoutPh = layoutDoc ? phMap(layoutDoc) : []; const masterPh = masterDoc ? phMap(masterDoc) : [];
    const cm = masterDoc && first(masterDoc, 'p:clrMap'); const clrMap = cm ? Object.fromEntries([...cm.attributes].map((a) => [a.name, a.value])) : theme.clrMap;
    const saved = theme.clrMap; theme.clrMap = clrMap;
    const txStyles = masterDoc && first(masterDoc, 'p:txStyles');

    const bgOf = (d, rm) => {
      const bg = d && first(d, 'p:bg'); if (!bg) return null;
      const fill = parseFill(child(bg, 'p:bgPr'), rm); if (fill) return fill;
      const ref = child(bg, 'p:bgRef'); const c = ref && readColor(ref, theme); return c ? { type: 'solid', ...c } : null;
    };
    const bg = bgOf(doc, r) ?? bgOf(layoutDoc, lr) ?? bgOf(masterDoc, mr) ?? { type: 'solid', hex: '#ffffff', alpha: 1 };

    const items = []; const blocks = [];
    const push = (it) => items.push(it);

    // text-property lookup along: shape lstStyle -> layout ph -> master ph -> master txStyles
    const lvlNode = (lst, lvl) => child(lst, `a:lvl${lvl + 1}pPr`);
    const lookup = (chain, lvl, get) => { for (const lst of chain) { const v = get(lvlNode(lst, lvl)); if (v != null) return v; } return null; };

    const readText = (sp, ctx) => {   // ctx: { box, kind, ph, isShapeText }
      const body = child(sp, 'p:txBody') ?? child(sp, 'a:txBody') ?? sp; if (!body) return null;
      const ph = ctx.ph; const lph = ph ? findPh(layoutPh, ph.type, ph.idx) : null; const mph = ph ? findPh(masterPh, ph.type, ph.idx) : null;
      const styleKey = ctx.kind === 'title' ? 'p:titleStyle' : ctx.kind === 'body' ? 'p:bodyStyle' : 'p:otherStyle';
      const chain = [child(body, 'a:lstStyle'), lph && child(child(lph.sp, 'p:txBody'), 'a:lstStyle'), mph && child(child(mph.sp, 'p:txBody'), 'a:lstStyle'), child(txStyles, styleKey)].filter(Boolean);
      const bpr = child(body, 'a:bodyPr'); const lbpr = lph && child(child(lph.sp, 'p:txBody'), 'a:bodyPr'); const mbpr = mph && child(child(mph.sp, 'p:txBody'), 'a:bodyPr');
      const anchor = bpr?.getAttribute('anchor') ?? lbpr?.getAttribute('anchor') ?? mbpr?.getAttribute('anchor') ?? (ctx.kind === 'title' ? 'ctr' : 't');
      const fit = first(bpr, 'a:normAutofit'); const scale = fit ? num(fit.getAttribute('fontScale'), 100000) / 100000 : 1;
      const paras = [];
      for (const p of kids(body, 'a:p')) {
        const lvl = num(child(p, 'a:pPr')?.getAttribute('lvl'));
        const runs = children(p).filter((n) => n.nodeName === 'a:r' || n.nodeName === 'a:fld').map((n) => ({ t: first(n, 'a:t')?.textContent ?? '', rPr: child(n, 'a:rPr') }));
        const br = children(p).some((n) => n.nodeName === 'a:br');
        const all = runs.map((x) => x.t).join('').replace(/\s+/g, ' ').trim();
        if (!all) continue;
        const pPr = child(p, 'a:pPr');
        const dAttr = (a) => lookup(chain, lvl, (n) => child(n, 'a:defRPr')?.getAttribute(a));
        let text = runs.map((x) => tagText(x.t.replace(/\s+/g, ' '), runStyle(x.rPr, dAttr))).join('').replace(/\s+/g, ' ').trim();
        for (const k of ['b', 'i', 'u', 's']) text = text.replace(new RegExp(`</${k}>(\\s*)<${k}>`, 'g'), '$1');
        const r0 = runs.find((x) => x.t.trim())?.rPr;
        const szv = num(r0?.getAttribute('sz')) || lookup(chain, lvl, (n) => (child(n, 'a:defRPr')?.getAttribute('sz') ? num(child(n, 'a:defRPr').getAttribute('sz')) : null)) || (ctx.kind === 'title' ? 4400 : 1800);
        const col = (r0 && readColor(child(r0, 'a:solidFill'), theme)) ?? lookup(chain, lvl, (n) => { const f = child(child(n, 'a:defRPr'), 'a:solidFill'); return f ? readColor(f, theme) : null; });
        const algn = pPr?.getAttribute('algn') ?? lookup(chain, lvl, (n) => n?.getAttribute('algn')) ?? 'l';
        paras.push({ text, lvl, sz: (szv / 100) * scale, color: col?.hex ?? null, algn, bullet: !!child(pPr, 'a:buChar') || !!child(pPr, 'a:buAutoNum'), br });
      }
      return paras.length ? { box: ctx.box, kind: ctx.kind, paras, anchor: { t: 'top', ctr: 'middle', b: 'bottom' }[anchor] ?? 'top' } : null;
    };

    // walk a shape tree; `T` maps child coordinates to slide coordinates (group transforms)
    const IDT = { sx: 1, sy: 1, ox: 0, oy: 0 };
    const walk = (tree, rmap, T, own) => {
      for (const n of children(tree)) {
        const name = n.nodeName;
        if (name === 'p:grpSp') {
          const x = parseXfrm(child(n, 'p:grpSpPr')); let T2 = T;
          if (x?.ch && x.ch.w && x.ch.h) T2 = { sx: (x.w / x.ch.w) * T.sx, sy: (x.h / x.ch.h) * T.sy, ox: T.ox + (x.x - x.ch.x * (x.w / x.ch.w)) * T.sx, oy: T.oy + (x.y - x.ch.y * (x.h / x.ch.h)) * T.sy };
          walk(n, rmap, T2, own);
        } else if (name === 'mc:AlternateContent') {
          const fb = child(n, 'mc:Fallback') ?? child(n, 'mc:Choice'); if (fb) walk(fb, rmap, T, own);
        } else if (name === 'p:sp' || name === 'p:cxnSp') {
          const spPr = child(n, 'p:spPr'); const ph = child(child(child(n, 'p:nvSpPr'), 'p:nvPr'), 'p:ph');
          const phInfo = ph ? { type: ph.getAttribute('type') ?? 'body', idx: ph.getAttribute('idx') } : null;
          let xf = parseXfrm(spPr);
          if (!xf && phInfo) xf = findPh(layoutPh, phInfo.type, phInfo.idx)?.xf ?? findPh(masterPh, phInfo.type, phInfo.idx)?.xf ?? null;
          if (!xf && own && phInfo) {   // no position anywhere in the file: use the usual title / body areas
            const t = phInfo.type; const W = size.w; const H = size.h;
            xf = (t === 'title' || t === 'ctrTitle') ? { x: W * 0.06, y: H * 0.06, w: W * 0.88, h: H * 0.2 } : t === 'subTitle' ? { x: W * 0.06, y: H * 0.3, w: W * 0.88, h: H * 0.12 } : { x: W * 0.06, y: H * 0.3, w: W * 0.88, h: H * 0.6 };
          }
          if (!xf) continue;
          const box = mapBox(xf, T);
          if (phInfo && !own) continue;                    // prompts on a layout / master are not content
          if (phInfo && ['sldNum', 'ftr', 'dt', 'hdr'].includes(phInfo.type)) continue;
          // artwork: geometry + fill + line (placeholders are drawn too when they carry their own fill)
          const geom = parseGeom(spPr) ?? (name === 'p:cxnSp' ? { prst: 'line', adj: {} } : { prst: 'rect', adj: {} });
          let fill = parseFill(spPr, rmap); let line = parseLine(spPr);
          if (fill === undefined && !phInfo) { const c = styleColor(n, 'a:fillRef'); const idx = num(child(child(n, 'p:style'), 'a:fillRef')?.getAttribute('idx')); if (c && idx > 0) fill = { type: 'solid', ...c }; }
          if (line === undefined && !phInfo) { const c = styleColor(n, 'a:lnRef'); const idx = num(child(child(n, 'p:style'), 'a:lnRef')?.getAttribute('idx')); if (c && idx > 0) line = { w: 12700 * idx, color: c.hex, alpha: c.alpha, dash: null }; }
          if ((fill && fill.type !== 'none') || (line && !line.none) || geom.prst === 'line') push({ kind: 'shape', geom, xf: box, fill: fill ?? null, line: line ?? null, shadow: parseShadow(spPr) ?? null, ref: undefined });
          if (own) {
            const kind = !phInfo ? 'other' : (phInfo.type === 'title' || phInfo.type === 'ctrTitle') ? 'title' : phInfo.type === 'subTitle' ? 'sub' : 'body';
            const tb = readText(n, { box, kind: kind === 'sub' ? 'body' : kind, ph: phInfo });
            if (tb) { tb.kind = kind; blocks.push(tb); }
          }
        } else if (name === 'p:pic') {
          const blip = first(n, 'a:blip'); const p = blip && rmap.get(blip.getAttribute('r:embed'));
          const xf = parseXfrm(child(n, 'p:spPr')); if (!p || !files[p] || !xf || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(p)) continue;
          const sr = first(n, 'a:srcRect');
          push({ kind: 'pic', path: useMedia(p), xf: mapBox(xf, T), crop: sr ? { l: num(sr.getAttribute('l')) / 100000, t: num(sr.getAttribute('t')) / 100000, r: num(sr.getAttribute('r')) / 100000, b: num(sr.getAttribute('b')) / 100000 } : null, alpha: num(first(blip, 'a:alphaModFix')?.getAttribute('amt'), 100000) / 100000, shadow: parseShadow(child(n, 'p:spPr')) ?? null });
        } else if (name === 'p:graphicFrame') {
          const xf = parseXfrm(n); if (!xf) continue;
          const box = mapBox(xf, T);
          const tbl = first(n, 'a:tbl'); const chartRef = first(n, 'c:chart'); const dgm = first(n, 'dgm:relIds');
          if (tbl) push({ kind: 'table', xf: box, spec: parseTable(tbl, box, rmap, T) });
          else if (chartRef) {
            const cp = rmap.get(chartRef.getAttribute('r:id')); const cd = cp && xml(cp);
            const spec = cd && parseChart(cd);
            if (spec) push({ kind: 'chart', xf: box, spec });
          } else if (dgm) { for (const it of parseSmartArt(dgm, xf, rmap, T)) push(it); }
          else if (own) { const blip = first(n, 'a:blip'); const p = blip && rmap.get(blip.getAttribute('r:embed')); if (p && files[p]) push({ kind: 'pic', path: useMedia(p), xf: box, crop: null, alpha: 1, shadow: null }); }
        }
      }
    };
    // master and layout decorations first (they sit behind the slide), then the slide itself
    if (masterDoc && layoutDoc?.documentElement.getAttribute('showMasterSp') !== '0') walk(first(masterDoc, 'p:spTree'), mr, IDT, false);
    if (layoutDoc) walk(first(layoutDoc, 'p:spTree'), lr, IDT, false);
    walk(first(doc, 'p:spTree'), r, IDT, true);
    theme.clrMap = saved;

    const notesPath = [...r.values()].find((v) => v.includes('notesSlides/'));
    const nd = notesPath ? xml(notesPath) : null;
    const notes = nd ? kids(nd, 'p:sp').filter((s) => first(s, 'p:ph')?.getAttribute('type') === 'body').flatMap((s) => kids(s, 'a:p').map((p) => kids(p, 'a:t').map((t) => t.textContent).join(''))).filter(Boolean).join(' ') : '';
    if (bg.type === 'blip') useMedia(bg.path);
    // reading order: title first, then top-to-bottom, left-to-right
    blocks.sort((a, b) => (a.kind === 'title' ? -1 : 0) - (b.kind === 'title' ? -1 : 0) || (a.box.y - b.box.y) || (a.box.x - b.box.x));
    return { bg, items, blocks, notes, hidden: doc.documentElement.getAttribute('show') === '0',
      // legacy summary used by the import dialog
      title: blocks.find((b) => b.kind === 'title')?.paras.map((p) => p.text).join(' ') ?? '', images: items.filter((i) => i.kind === 'pic'), hasArt: items.length > 0 || bg.type !== 'solid' };
  });
  return { size, slides, media };
}

// ---------- artwork renderer (canvas) ----------

const EMU_PT = 12700;
/**
 * Paint a slide's artwork (no text) onto a canvas of W x H. The slide is scaled to fit and centred; the slide background
 * fills the whole canvas, so a slide with a different aspect ratio than the video gets bars in its own background colour.
 * Returns { canvas, tf: { s, ox, oy } } where tf maps slide EMU to canvas pixels.
 */
export async function renderSlideArt(parsed, slide, W, H, { decode, skip = new Set() } = {}) {
  const dec = decode ?? (async (bytes) => createImageBitmap(new Blob([bytes])));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = canvas.getContext('2d');
  const s = Math.min(W / parsed.size.w, H / parsed.size.h); const ox = (W - parsed.size.w * s) / 2; const oy = (H - parsed.size.h * s) / 2;
  const imgs = parsed.__imgs ??= new Map();
  const img = async (path) => { if (!imgs.has(path)) imgs.set(path, dec(parsed.media.get(path)).catch(() => null)); return imgs.get(path); };
  const fillStyle = async (f, w, h) => {
    if (f.type === 'solid') return f.hex;
    if (f.type === 'grad') {
      let gr;
      if (f.path) gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) / 2);
      else { const a = (f.ang * Math.PI) / 180; const L = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2; gr = g.createLinearGradient(w / 2 - Math.cos(a) * L, h / 2 - Math.sin(a) * L, w / 2 + Math.cos(a) * L, h / 2 + Math.sin(a) * L); }
      for (const st of f.stops) gr.addColorStop(clamp01(st.pos), st.hex);
      return gr;
    }
    return null;
  };
  // background over the whole canvas
  const bg = slide.bg;
  if (bg.type === 'blip') { const im = await img(bg.path); if (im) { const k = Math.max(W / im.width, H / im.height); g.drawImage(im, (W - im.width * k) / 2, (H - im.height * k) / 2, im.width * k, im.height * k); } else { g.fillStyle = '#222'; g.fillRect(0, 0, W, H); } }
  else { const st = await fillStyle(bg, W, H); g.fillStyle = st ?? '#ffffff'; g.fillRect(0, 0, W, H); }

  const rich = (paras, defColor) => paras.map((p) => ({ align: p.algn, bullet: p.bullet, runs: p.runs.map((r) => ({ ...r, size: (r.sz ?? 18) * EMU_PT * s, color: r.color ?? defColor })) }));
  for (const it of slide.items) {
    if (skip.has(it.kind)) continue;
    const b = it.xf; const x = ox + b.x * s; const y = oy + b.y * s; const w = b.w * s; const h = b.h * s;
    if (w <= 0 && h <= 0) continue;
    g.save();
    g.translate(x + w / 2, y + h / 2);
    if (b.rot) g.rotate((b.rot * Math.PI) / 180);
    g.scale(b.fh ? -1 : 1, b.fv ? -1 : 1);
    g.translate(-w / 2, -h / 2);
    const sh = it.shadow ? (() => { const a = (it.shadow.dir * Math.PI) / 180; return { color: it.shadow.color, blur: (it.shadow.blur * s) || 4, dx: Math.cos(a) * it.shadow.dist * s, dy: Math.sin(a) * it.shadow.dist * s }; })() : null;
    if (it.kind === 'pic') {
      const im = await img(it.path);
      if (im) {
        const c = it.crop ?? { l: 0, t: 0, r: 0, b: 0 };
        if (sh) { g.shadowColor = sh.color; g.shadowBlur = sh.blur; g.shadowOffsetX = sh.dx; g.shadowOffsetY = sh.dy; }
        g.globalAlpha = it.alpha ?? 1;
        g.drawImage(im, c.l * im.width, c.t * im.height, Math.max(1, im.width * (1 - c.l - c.r)), Math.max(1, im.height * (1 - c.t - c.b)), 0, 0, w, h);
      }
    } else if (it.kind === 'chart') {
      drawChart(g, it.spec, w, h, 1);
    } else if (it.kind === 'table') {
      drawTable(g, it.spec, w, h, 1);
    } else {
      const fill = it.fill?.type === 'blip' ? { ...it.fill } : it.fill;
      const blip = fill?.type === 'blip' ? await img(fill.path) : null;
      const line = it.line && !it.line.none && it.line.color ? { ...it.line, w: Math.max(1, (it.line.w ?? 12700) * s) } : it.line?.none ? { none: true } : null;
      paintShape(g, { geom: it.geom, fill, line: line ?? (it.geom.prst === 'line' ? { w: Math.max(1, s * 12700), color: '#888888' } : null), shadow: sh }, w, h, { blip });
      if (it.text?.paras?.length) {
        const r = it.text.rect ?? { x: 0, y: 0, w: b.w, h: b.h };
        drawRich(g, rich(it.text.paras, '#ffffff'), { x: r.x * s + w * 0.03, y: r.y * s, w: r.w * s - w * 0.06, h: r.h * s }, { anchor: it.text.anchor ?? 'middle' });
      }
    }
    g.restore();
  }
  return { canvas, tf: { s, ox, oy } };
}

// ---------- planning: timing, pagination, script ----------

const plainT = (t) => String(t).replace(/<\/?[biusBIUS]>/g, '');
const words = (s) => (plainT(s).match(/\S+/g) ?? []).length;
const MIN_TEXT = 0.034;      // smallest comfortable text height, as a share of the video height
const MAX_PAGE_SEC = 24;

/** Seconds to read `n` words: a short lead-in plus ~3.2 words per second, bounded. */
export const readingSeconds = (n) => Math.min(MAX_PAGE_SEC, Math.max(2.6, 1.6 + n / 3.2));

const clean = (t) => t.replace(/[{}]/g, '').replace(/^\s*(?:[-#>•–—*]+\s+|#+)/, '').replace(/^\((.*)\)$/, '$1').replace(/^::/, '').replace(/^---+$/, '').trim();

/**
 * Plan the whole deck. `art[i]` = { tf: {s, ox, oy}, lum(rectPx) -> 0..1 | null } for slide i (optional: without it text colour comes from the slide only).
 * Returns { text, spans: [{ t0, t1 } per slide], total, pages } where `text` is the script.
 */
export function planSlides(parsed, { W = 1280, H = 720, perSlide = 0, fitTo = 0, art = [] } = {}) {
  const { size } = parsed; const out = []; let t = 0;
  const plans = parsed.slides.map((slide, si) => {
    if (slide.hidden) return { si, skip: true, pages: [], dur: 0 };
    const tf = art[si]?.tf ?? (() => { const s = Math.min(W / size.w, H / size.h); return { s, ox: (W - size.w * s) / 2, oy: (H - size.h * s) / 2 }; })();
    const blocks = slide.blocks.map((b) => {
      let px = { x: tf.ox + b.box.x * tf.s, y: tf.oy + b.box.y * tf.s, w: b.box.w * tf.s, h: b.box.h * tf.s };
      const maxSz = Math.max(...b.paras.map((p) => p.sz));
      const tpx = Math.max(maxSz * EMU_PT * tf.s * 0.98, MIN_TEXT * H);
      const chars = b.paras.reduce((a, p) => a + plainT(p.text).length, 0);
      // a box too small for even one comfortable line is grown around its centre
      const minH = tpx * 1.5; const minW = Math.min(W * 0.6, Math.max(W * 0.18, Math.min(chars, 24) * tpx * 0.5));
      if (px.h < minH) { px.y -= (minH - px.h) / 2; px.h = minH; }
      if (px.w < minW) { px.x -= (minW - px.w) / 2; px.w = minW; }
      px.x = Math.max(0, Math.min(W - px.w, px.x)); px.y = Math.max(0, Math.min(H - px.h, px.y));
      const capLines = Math.max(1, Math.floor(px.h / (tpx * 1.3))); const perLine = Math.max(4, Math.floor(px.w / (tpx * 0.5)));
      const pages = []; let cur = []; let used = 0;
      for (const p of b.paras) {
        const need = Math.max(1, Math.ceil(plainT(p.text).length / (perLine * 0.9)));   // wrapped lines this paragraph takes
        if (cur.length && used + need > capLines) { pages.push(cur); cur = []; used = 0; }
        cur.push(p); used += need;
      }
      if (cur.length) pages.push(cur);
      return { b, px, tpx, pages };
    });
    const K = Math.max(1, ...blocks.map((x) => x.pages.length));
    const pageSets = [];
    for (let k = 0; k < K; k++) {
      const shown = blocks.map((x) => ({ ...x, paras: x.pages[Math.min(k, x.pages.length - 1)], fresh: x.pages.length > 1 || k === 0 }));
      const nw = shown.reduce((a, x) => a + (x.fresh ? x.paras.reduce((m, p) => m + words(p.text), 0) : 0), 0);
      pageSets.push({ shown, words: nw });
    }
    let durs = pageSets.map((p) => (p.shown.length ? readingSeconds(p.words) : 3));
    if (perSlide > 0) { const tot = durs.reduce((a, b) => a + b, 0); durs = durs.map((d) => (d / tot) * perSlide); }
    return { si, slide, tf, pageSets, durs, dur: durs.reduce((a, b) => a + b, 0), empty: !blocks.length };
  });
  let k = 1;
  if (fitTo > 0) { const tot = plans.reduce((a, p) => a + p.dur, 0); if (tot > 0) k = fitTo / tot; }

  const lines = ['@pack editorial', ''];
  const spans = []; let pagesN = 0; const deckSlides = [];
  for (const p of plans) {
    if (p.skip) { spans.push(null); deckSlides.push({ hidden: true, pages: [] }); continue; }
    const s0 = t; const dpages = [];
    p.pageSets.forEach((ps, pi) => {
      const d = p.durs[pi] * k;
      if (ps.shown.length) {
        const sec = [];
        for (const blk of ps.shown) {
          const rgn = `${(blk.px.x / W * 100).toFixed(2)}:${(blk.px.y / H * 100).toFixed(2)}:${(blk.px.w / W * 100).toFixed(2)}:${(blk.px.h / H * 100).toFixed(2)}`;
          const isTitle = blk.b.kind === 'title';
          const roleScale = isTitle ? 1 : 0.55;
          const maxPct = ((Math.max(...blk.paras.map((q) => q.sz)) * EMU_PT * p.tf.s * 1.05) / H * 100) / roleScale;
          const sample = p.slide && art[p.si]?.lum?.(blk.px);
          const own = blk.paras[0].color;
          let color;
          if (sample != null) { const bgLum = sample; const ownLum = own ? luminance(own) : null; color = own && Math.abs(ownLum - bgLum) > 0.35 ? own : (bgLum > 0.45 ? '#111111' : '#ffffff'); }
          else color = own ?? null;
          const mods = `at=${rgn} align=${{ l: 'left', ctr: 'center', r: 'right', just: 'left' }[blk.paras[0].algn] ?? 'left'} anchor=${blk.b.anchor} max=${Math.max(2, maxPct).toFixed(1)} role=${isTitle ? 'title' : 'body'}${color ? ` color=${color}` : ''}`;
          for (const q of blk.paras) { const txt = clean(q.text); if (txt) sec.push(`${txt} {${mods}}`); }
        }
        if (sec.length) {
          const nw = ps.words;
          const head = ['---', '::trans fade', '::emph none', '::layout center', `::reveal ${nw > 14 ? 'line' : 'word'}`];
          dpages.push({ w: p.durs[pi], head: [...head.slice(1)], lines: [...sec] });
          sec[0] = `[${fmtT(t)}-${fmtT(t + Math.max(0.5, d - 0.05))}] ${sec[0]}`;
          lines.push(...head, ...sec, '');
          pagesN++;
        }
      }
      t += d;
    });
    spans.push({ t0: s0, t1: t });
    deckSlides.push({ title: plainT(p.slide?.title ?? ''), hidden: false, pages: dpages });
  }
  const text = lines.join('\n').replace(/^---\n/m, '').trimEnd();
  return { text, spans, total: t, pages: pagesN, deckSlides, head: '@pack editorial' };
}

/**
 * Plain layout for "EasyMV visuals only": no positions, EasyMV designs everything. Titles become `#` headings,
 * bullets stay bullets, and a wordy slide is split into pages of at most ~38 words so the text stays big.
 */
export function planSlidesAuto(parsed, { perSlide = 0, fitTo = 0 } = {}) {
  const lines = ['@pack punchy', '']; const spans = []; let t = 0; let pagesN = 0; const deckSlides = [];
  const plans = parsed.slides.map((slide) => {
    if (slide.hidden) return null;
    const title = slide.blocks.find((b) => b.kind === 'title');
    const rest = slide.blocks.filter((b) => b !== title).flatMap((b) => b.paras.map((p) => ({ text: clean(p.text), bullet: p.bullet || b.kind === 'body' && b.paras.length > 1, sub: b.kind === 'sub' }))).filter((p) => p.text);
    const pages = []; let cur = []; let n = 0;
    for (const p of rest) { const w = words(p.text); if (cur.length && n + w > 38) { pages.push(cur); cur = []; n = 0; } cur.push(p); n += w; }
    if (cur.length || !pages.length) pages.push(cur);
    const head = title ? clean(title.paras.map((p) => p.text).join(' ')) : '';
    return { head, pages, durs: pages.map((pg) => readingSeconds(words(head) + pg.reduce((a, p) => a + words(p.text), 0))) };
  });
  let k = 1;
  if (fitTo > 0) { const tot = plans.reduce((a, p) => a + (p ? p.durs.reduce((x, y) => x + y, 0) : 0), 0); if (tot) k = fitTo / tot; }
  for (const p of plans) {
    if (!p) { spans.push(null); deckSlides.push({ hidden: true, pages: [] }); continue; }
    const s0 = t; const dpages = [];
    let durs = p.durs; if (perSlide > 0) { const tot = durs.reduce((a, b) => a + b, 0); durs = durs.map((d) => (d / tot) * perSlide); }
    p.pages.forEach((pg, i) => {
      const d = durs[i] * k; const body = [];
      if (p.head) body.push(i === 0 || p.pages.length > 1 ? `# ${p.head}` : '');
      for (const q of pg) body.push(q.sub ? q.text : (q.bullet ? `- ${q.text}` : q.text));
      const real = body.filter(Boolean);
      if (real.length) { dpages.push({ w: p.durs[i], head: [], lines: [...real] }); real[0] = `[${fmtT(t)}-${fmtT(t + Math.max(0.5, d - 0.05))}] ${real[0]}`; lines.push('---', ...real, ''); pagesN++; }
      t += d;
    });
    spans.push({ t0: s0, t1: t });
    deckSlides.push({ title: p.head, hidden: false, pages: dpages });
  }
  return { text: lines.join('\n').replace(/^---\n/m, '').trimEnd(), spans, total: t, pages: pagesN, deckSlides, head: '@pack punchy' };
}
