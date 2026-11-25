// Fonts: a font list that only contains fonts that really exist.
//  - bundled: open fonts shipped with the app (always available, same on every computer)
//  - installed: a short list of common fonts, kept only if the browser really has them
//  - local: everything installed on the computer, via the browser's Local Font Access
//    permission (Chrome and Edge), only when the user asks for it
// Generic CSS names such as "cursive" or "fantasy" are not offered: they map to different
// (or missing) fonts on every system.

export const BUNDLED = [
  { name: 'Inter', file: 'inter', weights: [400, 700, 900], tag: 'Clean' },
  { name: 'Montserrat', file: 'montserrat', weights: [400, 800], tag: 'Clean' },
  { name: 'Space Grotesk', file: 'space-grotesk', weights: [700], tag: 'Clean' },
  { name: 'Anton', file: 'anton', weights: [400], tag: 'Impact' },
  { name: 'Bebas Neue', file: 'bebas-neue', weights: [400], tag: 'Impact' },
  { name: 'Oswald', file: 'oswald', weights: [700], tag: 'Impact' },
  { name: 'Archivo Black', file: 'archivo-black', weights: [400], tag: 'Impact' },
  { name: 'Playfair Display', file: 'playfair-display', weights: [400, 700], tag: 'Serif' },
  { name: 'DM Serif Display', file: 'dm-serif-display', weights: [400], tag: 'Serif' },
  { name: 'Pacifico', file: 'pacifico', weights: [400], tag: 'Script' },
  { name: 'Caveat', file: 'caveat', weights: [700], tag: 'Handwriting' },
  { name: 'Permanent Marker', file: 'permanent-marker', weights: [400], tag: 'Handwriting' },
  { name: 'Press Start 2P', file: 'press-start-2p', weights: [400], tag: 'Pixel' },
];
const BUNDLED_BY_NAME = new Map(BUNDLED.map((b) => [b.name, b]));

const COMMON = ['Arial', 'Arial Black', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Calibri', 'Cambria', 'Georgia', 'Times New Roman',
  'Courier New', 'Consolas', 'Impact', 'Comic Sans MS', 'Helvetica', 'Helvetica Neue', 'Futura', 'Gill Sans', 'Palatino', 'Garamond', 'Rockwell',
  'Franklin Gothic Medium', 'Lucida Console', 'Candara', 'Century Gothic', 'Bahnschrift', 'Segoe Script', 'Ink Free', 'Brush Script MT', 'Roboto', 'Open Sans', 'Noto Sans', 'Ubuntu'];

export const SYSTEM_FONT = 'system-ui';
export const DEFAULT_FONT = 'Inter';
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'cursive', 'fantasy']);
/** Old projects may name a generic family; map it to something that exists everywhere. */
export const migrateFont = (name) => (name === 'cursive' ? 'Caveat' : name === 'fantasy' ? 'Anton' : name || DEFAULT_FONT);

const loaded = new Map();       // name -> Promise
const ready = new Set();        // names whose files have finished loading
let base = new URL('../fonts/', import.meta.url).href;
export const setFontBase = (u) => { base = u; };

/** Load a bundled font (all its weights). Resolves immediately for anything else. */
export function loadBundled(name) {
  const b = BUNDLED_BY_NAME.get(name);
  if (!b || typeof FontFace === 'undefined') return Promise.resolve();
  if (!loaded.has(name)) {
    loaded.set(name, Promise.all(b.weights.map(async (w) => {
      const face = new FontFace(b.name, `url(${base}${b.file}-${w}.woff2)`, { weight: String(w), style: 'normal' });
      await face.load(); document.fonts.add(face);
    })).then(() => { ready.add(name); }).catch(() => { loaded.delete(name); }));
  }
  return loaded.get(name);
}
export const loadAllBundled = () => Promise.all(BUNDLED.map((b) => loadBundled(b.name)));
export const isBundled = (name) => BUNDLED_BY_NAME.has(name);
/** True when text measured in this font is trustworthy: not a bundled font, or its files have finished loading. */
export const fontReady = (name) => !BUNDLED_BY_NAME.has(name) || ready.has(name) || typeof FontFace === 'undefined';

/** Pick the closest bundled weight so bold text does not get faux-bolded. */
export function nearestWeight(name, want) {
  const b = BUNDLED_BY_NAME.get(name);
  if (!b) return want;
  return b.weights.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) ? w : best), b.weights[0]);
}

let probe = null;
const width = (font, text) => { probe ??= document.createElement('canvas').getContext('2d'); probe.font = `72px ${font}`; return probe.measureText(text).width; };
/** True if the browser really has this family (compares against two fallbacks). */
export function isInstalled(name) {
  if (GENERIC.has(name) || BUNDLED_BY_NAME.has(name)) return true;
  const t = 'mmmmmmmmmmlliWQ@#';
  return ['monospace', 'serif'].some((fb) => width(`"${name}", ${fb}`, t) !== width(fb, t));
}

let local = null;               // families from the Local Font Access API
export const hasLocalFontAccess = () => typeof window !== 'undefined' && 'queryLocalFonts' in window;
export const localFontsScanned = () => local !== null;
export async function scanLocalFonts() {
  if (!hasLocalFontAccess()) throw new Error('This browser cannot list installed fonts. Use Chrome or Edge, or load a font file.');
  const faces = await window.queryLocalFonts();
  local = [...new Set(faces.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  return local;
}

/** Everything the picker offers, grouped. */
export function fontGroups() {
  const groups = [{ title: 'Bundled (look the same everywhere)', fonts: BUNDLED.map((b) => ({ name: b.name, tag: b.tag })) }];
  const common = COMMON.filter(isInstalled);
  if (common.length) groups.push({ title: 'Installed on this computer', fonts: common.map((name) => ({ name })) });
  if (local) {
    const have = new Set([...BUNDLED.map((b) => b.name), ...common]);
    groups.push({ title: `All your fonts (${local.length})`, fonts: local.filter((n) => !have.has(n)).map((name) => ({ name })) });
  }
  return groups;
}

export const familyCss = (name) => (GENERIC.has(name) ? name : `"${name}", ${BUNDLED_BY_NAME.get(name)?.tag === 'Serif' ? 'serif' : 'sans-serif'}`);
