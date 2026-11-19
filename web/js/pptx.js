// PowerPoint (.pptx) import. A .pptx is a zip of XML parts; this reads the slide order, the text of every slide
// (title, subtitle, bullets, other text boxes, bold runs), slide backgrounds (colour or picture, following the
// layout → master chain) and pictures with their position, and turns them into an EasyMV script plus image layers.
// Everything stays in the browser. `parseXml` is injectable so the code can run outside a browser.

import { unzipSync } from '../vendor/fflate.js';
import { fmtT } from './scripttext.js';

const td = new TextDecoder();
const defaultParse = (s) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el, name) => [...el.getElementsByTagName(name)];
const first = (el, name) => el.getElementsByTagName(name)[0] ?? null;
const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
function resolve(base, target) {   // relationship targets are relative to the part's folder
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dirOf(base) + target).split('/'); const out = [];
  for (const s of parts) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); }
  return out.join('/');
}

/** Parse a .pptx (Uint8Array / ArrayBuffer). Returns { size: {w, h} (EMU), slides: [...], media: Map(path -> Uint8Array) }. */
export function parsePptx(data, { parseXml = defaultParse } = {}) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  let files;
  try { files = unzipSync(u8); } catch { throw new Error('That file is not a valid .pptx (could not open it as a zip).'); }
  const text = (path) => (files[path] ? td.decode(files[path]) : null);
  const xml = (path) => { const t = text(path); return t == null ? null : parseXml(t); };
  const pres = xml('ppt/presentation.xml');
  if (!pres) throw new Error('This does not look like a PowerPoint file (no ppt/presentation.xml). Old .ppt files are not supported; save as .pptx.');
  const rels = (part) => {   // part path -> Map(rId -> resolved target path)
    const relPath = `${dirOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
    const doc = xml(relPath); const m = new Map();
    if (doc) for (const r of kids(doc, 'Relationship')) if (r.getAttribute('TargetMode') !== 'External') m.set(r.getAttribute('Id'), resolve(part, r.getAttribute('Target')));
    return m;
  };
  const sz = first(pres, 'p:sldSz');
  const size = { w: Number(sz?.getAttribute('cx')) || 12192000, h: Number(sz?.getAttribute('cy')) || 6858000 };
  const presRels = rels('ppt/presentation.xml');
  const slidePaths = kids(pres, 'p:sldId').map((s) => presRels.get(s.getAttribute('r:id'))).filter((p) => p && files[p]);

  // theme colours (for schemeClr)
  const theme = {};
  const themePath = Object.keys(files).find((k) => /^ppt\/theme\/theme\d+\.xml$/.test(k));
  const tdoc = themePath ? xml(themePath) : null;
  const cs = tdoc && first(tdoc, 'a:clrScheme');
  if (cs) for (const c of cs.childNodes) {
    if (c.nodeType !== 1) continue;
    const name = c.nodeName.replace('a:', ''); const v = c.firstElementChild;
    theme[name] = v?.getAttribute('val') && v.nodeName === 'a:srgbClr' ? v.getAttribute('val') : v?.getAttribute('lastClr');
  }
  const SCHEME = { bg1: 'lt1', bg2: 'lt2', tx1: 'dk1', tx2: 'dk2' };
  const colorOf = (el) => {   // el = a fill container; returns '#rrggbb' or null
    const f = el && first(el, 'a:solidFill'); if (!f) return null;
    const rgb = first(f, 'a:srgbClr'); if (rgb) return `#${rgb.getAttribute('val')}`;
    const sc = first(f, 'a:schemeClr'); if (sc) { const v = theme[SCHEME[sc.getAttribute('val')] ?? sc.getAttribute('val')]; return v ? `#${v}` : null; }
    const sys = first(f, 'a:sysClr'); return sys ? `#${sys.getAttribute('lastClr') ?? 'FFFFFF'}` : null;
  };
  const bgOf = (doc, relMap) => {   // { color } | { image } | null
    const bg = doc && first(doc, 'p:bg'); if (!bg) return null;
    const blip = first(bg, 'a:blip'); if (blip) { const p = relMap.get(blip.getAttribute('r:embed')); if (p && files[p]) return { image: p }; }
    const c = colorOf(first(bg, 'p:bgPr') ?? bg); return c ? { color: c } : null;
  };

  const media = new Map();
  const useMedia = (p) => { if (p && files[p] && !media.has(p)) media.set(p, files[p]); return p; };
  const slides = slidePaths.map((sp) => {
    const doc = xml(sp); const r = rels(sp);
    const layoutPath = [...r.values()].find((v) => v.includes('slideLayouts/'));
    const layoutDoc = layoutPath ? xml(layoutPath) : null; const lr = layoutPath ? rels(layoutPath) : new Map();
    const masterPath = [...lr.values()].find((v) => v.includes('slideMasters/'));
    const masterDoc = masterPath ? xml(masterPath) : null; const mr = masterPath ? rels(masterPath) : new Map();
    const bg = bgOf(doc, r) ?? bgOf(layoutDoc, lr) ?? bgOf(masterDoc, mr);
    if (bg?.image) useMedia(bg.image);

    const slide = { title: '', subtitle: '', bullets: [], texts: [], images: [], bg, notes: '', hidden: doc.documentElement.getAttribute('show') === '0' };
    const paraText = (p) => {   // text with **bold** for bold runs (unless the whole paragraph is bold)
      const runs = [...p.childNodes].filter((n) => n.nodeType === 1 && (n.nodeName === 'a:r' || n.nodeName === 'a:fld')).map((n) => ({ t: first(n, 'a:t')?.textContent ?? '', b: first(n, 'a:rPr')?.getAttribute('b') === '1' }));
      const all = runs.map((x) => x.t).join('').replace(/\s+/g, ' ').trim();
      if (!all) return { text: '', lvl: 0 };
      const whole = runs.every((x) => x.b || !x.t.trim());
      const text = whole ? all : runs.map((x) => (x.b && x.t.trim() ? `**${x.t.trim()}** ` : x.t)).join('').replace(/\s+/g, ' ').replace(/\*\* \*\*/g, ' ').trim();
      return { text, lvl: Number(first(p, 'a:pPr')?.getAttribute('lvl') ?? 0), bullet: !!first(p, 'a:buChar') || !!first(p, 'a:buAutoNum') };
    };
    const xfrm = (el) => { const x = first(el, 'a:xfrm'); const o = x && first(x, 'a:off'); const e = x && first(x, 'a:ext'); return o && e ? { x: +o.getAttribute('x'), y: +o.getAttribute('y'), w: +e.getAttribute('cx'), h: +e.getAttribute('cy') } : null; };
    const tree = first(doc, 'p:spTree');
    const order = [];   // reading order of loose text boxes: top to bottom, then left to right
    for (const sh of kids(tree, 'p:sp')) {
      const ph = first(sh, 'p:ph'); const type = ph?.getAttribute('type') ?? (ph ? 'body' : '');
      const body = first(sh, 'p:txBody'); if (!body) continue;
      const paras = kids(body, 'a:p').map(paraText).filter((p) => p.text);
      if (!paras.length) continue;
      if (type === 'title' || type === 'ctrTitle') slide.title = paras.map((p) => p.text).join(' ');
      else if (type === 'subTitle') slide.subtitle = paras.map((p) => p.text).join(' ');
      else if (type === 'body' || type === 'obj') for (const p of paras) slide.bullets.push(p);
      else if (['sldNum', 'ftr', 'dt', 'hdr'].includes(type)) continue;
      else order.push({ box: xfrm(sh), paras });
    }
    order.sort((a, b) => ((a.box?.y ?? 0) - (b.box?.y ?? 0)) || ((a.box?.x ?? 0) - (b.box?.x ?? 0)));
    for (const o of order) slide.texts.push(...o.paras.map((p) => p.text));
    for (const pic of kids(tree, 'p:pic')) {
      const blip = first(pic, 'a:blip'); const p = blip && r.get(blip.getAttribute('r:embed'));
      if (p && files[p] && /\.(png|jpe?g|gif|webp|bmp)$/i.test(p)) { useMedia(p); slide.images.push({ path: p, box: xfrm(pic) }); }
    }
    const notesPath = [...r.values()].find((v) => v.includes('notesSlides/'));
    const nd = notesPath ? xml(notesPath) : null;
    if (nd) slide.notes = kids(nd, 'p:sp').filter((s) => first(s, 'p:ph')?.getAttribute('type') === 'body').flatMap((s) => kids(s, 'a:p').map((p) => paraText(p).text)).filter(Boolean).join(' ');
    return slide;
  });
  return { size, slides, media };
}

const words = (s) => (s.match(/\S+/g) ?? []).length;

/** Seconds each slide stays: auto (reading time), a fixed number, or stretched to `fitTo` seconds. */
export function slideDurations(slides, { perSlide = 0, fitTo = 0 } = {}) {
  let d = slides.map((s) => {
    if (perSlide > 0) return perSlide;
    const n = words([s.title, s.subtitle, ...s.bullets.map((b) => b.text), ...s.texts].join(' '));
    return Math.min(9, Math.max(3, 2.4 + n * 0.32));
  });
  if (fitTo > 0 && d.length) { const k = fitTo / d.reduce((a, b) => a + b, 0); d = d.map((x) => x * k); }
  return d;
}

/**
 * The script text for the slides. Each slide is a scene starting at an explicit time.
 * bgMode only matters for the layers; the text is the same: title → `#`, subtitle → `##`, bullets → `-`, loose text → lines.
 */
export function slidesToScript(slides, durations, { start = 0, titleFirstAsDeck = true } = {}) {
  let t = start; const out = ['@pack punchy', ''];
  slides.forEach((s, i) => {
    const lines = [];
    if (s.title) lines.push(`# ${s.title}`);
    if (s.subtitle) lines.push(s.subtitle);
    const multi = s.bullets.length > 1;
    for (const b of s.bullets) lines.push(multi || b.bullet ? `- ${b.text}` : b.text);
    lines.push(...s.texts);
    if (!lines.length && s.notes) lines.push(s.notes);
    if (!lines.length) { t += durations[i]; return; }   // picture-only slides keep their time but show no text
    // the time tag (start-end) sits on the first line, in front of any heading / bullet marker
    lines[0] = `[${fmtT(t)}-${fmtT(t + durations[i] - 0.05)}] ${lines[0]}`;
    out.push(lines.join('\n'), '', '---', '');
    t += durations[i];
  });
  while (out.length && (out.at(-1) === '' || out.at(-1) === '---')) out.pop();
  return out.join('\n');
}
