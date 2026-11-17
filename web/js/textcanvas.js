// Browser-only text rasterising for lyrics: wrap, measure and draw one line of lyrics
// to a canvas (base colour, or the karaoke highlight colour). The browser's own text
// engine does the shaping, so ligatures and non-Latin scripts just work.

import { familyCss, loadBundled, nearestWeight, migrateFont, isBundled } from './fonts.js';

const loaded = new Map();

export function fontCss(style, H) {
  const px = Math.max(8, Math.round(style.size * H));
  const font = migrateFont(style.font);
  return { css: `${style.italic ? 'italic ' : ''}${nearestWeight(font, style.weight)} ${px}px ${familyCss(font)}`, px };
}

/** Make sure a (possibly user-supplied) font is ready before measuring or drawing. */
export function ensureFont(style, H) {
  const { css } = fontCss(style, H);
  if (!document.fonts) return Promise.resolve();
  const font = migrateFont(style.font);
  if (isBundled(font)) return loadBundled(font).then(() => document.fonts.load(css, 'Aa')).catch(() => []);
  if (!loaded.has(css)) loaded.set(css, document.fonts.load(css, 'Aa').catch(() => []));
  return loaded.get(css);
}

let scratch = null;
function ctx2d() {
  scratch ??= document.createElement('canvas').getContext('2d');
  return scratch;
}

/** Wrap text to `maxW` px. Returns the wrapped lines and pixel size of the block. */
export function measureLine(text, style, H, W) {
  const g = ctx2d();
  const { css, px } = fontCss(style, H);
  g.font = css;
  const maxW = Math.max(px * 2, style.maxWidth * W);
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (g.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  if (!lines.length) lines.push('');
  const lineH = Math.round(px * 1.22);
  const pad = Math.ceil(px * (0.25 + style.outline * 0.6 + style.shadow * 0.5));
  const textW = Math.max(...lines.map((l) => g.measureText(l).width));
  return { lines, css, px, lineH, pad, w: Math.ceil(textW + pad * 2), h: lineH * lines.length + pad * 2 };
}

/** Draw a measured line block. `hi` draws the karaoke highlight colour and no outline/shadow. */
export function drawLine(m, style, hi = false) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, m.w); c.height = Math.max(1, m.h);
  const g = c.getContext('2d');
  g.font = m.css;
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.textAlign = style.align === 'left' ? 'left' : style.align === 'right' ? 'right' : 'center';
  const x = style.align === 'left' ? m.pad : style.align === 'right' ? m.w - m.pad : m.w / 2;
  m.lines.forEach((line, i) => {
    const y = m.pad + m.lineH * (i + 0.5);
    if (!hi && style.outline > 0) {
      g.lineWidth = Math.max(1, style.outline * m.px);
      g.strokeStyle = style.outlineColor;
      g.shadowColor = 'transparent';
      g.strokeText(line, x, y);
    }
    if (!hi && style.shadow > 0) {
      g.shadowColor = 'rgba(0,0,0,.55)';
      g.shadowBlur = style.shadow * m.px * 0.4;
      g.shadowOffsetY = style.shadow * m.px * 0.08;
    } else g.shadowColor = 'transparent';
    g.fillStyle = hi ? style.hiColor : style.color;
    g.fillText(line, x, y);
  });
  return c;
}

/** Register a user font file so it can be used by name. */
export async function registerFont(name, file) {
  const face = new FontFace(name, await file.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  loaded.clear();
  return face;
}
