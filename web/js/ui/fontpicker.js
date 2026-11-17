// Font picker: a button that shows the current font in its own face and opens a searchable,
// grouped list where every name is previewed in that font.

import { h, icon, dialog, clear } from './dom.js';
import { fontGroups, loadBundled, loadAllBundled, hasLocalFontAccess, scanLocalFonts, localFontsScanned, familyCss, migrateFont } from '../fonts.js';

export function fontField({ label = 'Font', value, onChange, onLoadFile, toast }) {
  const cur = migrateFont(value);
  loadBundled(cur);
  const btn = h('button.font-btn', { type: 'button', title: 'Choose a font', style: { fontFamily: familyCss(cur) }, onclick: open }, h('span.font-name', cur), icon('expand_more'));
  function open() {
    const q = h('input.text-input', { type: 'search', placeholder: 'Search fonts…', 'aria-label': 'Search fonts' });
    const list = h('div.font-list');
    const draw = () => {
      clear(list);
      const needle = q.value.trim().toLowerCase();
      for (const g of fontGroups()) {
        const fonts = g.fonts.filter((f) => !needle || f.name.toLowerCase().includes(needle));
        if (!fonts.length) continue;
        list.append(h('div.font-group', g.title));
        for (const f of fonts.slice(0, 400)) {
          list.append(h('button.font-item', { type: 'button', class: f.name === cur ? 'on' : '', onclick: () => { d.close(); onChange(f.name); } },
            h('span.font-sample', { style: { fontFamily: familyCss(f.name) } }, f.name), f.tag ? h('span.tag', f.tag) : null));
        }
      }
      if (!list.firstChild) list.append(h('p.muted', 'No fonts match.'));
    };
    q.addEventListener('input', draw);
    const scan = hasLocalFontAccess() && !localFontsScanned()
      ? h('button.btn.tonal', { type: 'button', onclick: async () => { try { await scanLocalFonts(); draw(); } catch (e) { toast?.(e.message); } } }, icon('search'), 'Scan my computer’s fonts')
      : null;
    const file = onLoadFile ? h('button.btn.text', { type: 'button', onclick: () => { d.close(); onLoadFile(); } }, icon('upload_file'), 'Load font file…') : null;
    const d = dialog({ title: label, wide: true, body: [q, h('div.row', scan, file, hasLocalFontAccess() ? null : h('span.muted', 'Your browser can’t list installed fonts; use the bundled fonts or load a file.')), list], actions: [{ label: 'Close' }] });
    loadAllBundled().then(draw); draw(); q.focus();
  }
  return { el: h('div.fld', h('span.fld-label', label), btn), btn };
}
