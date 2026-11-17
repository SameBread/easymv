// Lyrics: paste words, tap along to the song to time them (or import LRC), then style
// and place them. Edits the selected lyrics layer (or the first one).

import * as core from '../../core.js';
import { state, on, layerById, fmtTimeMs } from '../../core.js';
import { fontField } from '../fontpicker.js';
import { h, icon, clear, numField, selectField, colorField, toggle, rafThrottle } from '../dom.js';
import { lyricsSettings, linesFromText, parseLrc, formatLrc, sortLines, tapStamp, tapWord, fmtStamp, LAYOUT_MODES } from '../../lyrics.js';

export function createLyricsPanel(shell) {
  const element = h('div.panel-lyrics');
  let tapIdx = 0; let wordMode = false; let wordIdx = 0;
  let lastSig = '';

  const target = () => {
    const sel = state.selected && layerById(state.selected);
    if (sel?.type === 'lyrics') return sel;
    return state.project.elements.find((e) => e.type === 'lyrics') ?? null;
  };
  const fps = () => state.project.videoFps;
  const now = () => state.frame / fps();
  const edit = (def, fn, label, key) => core.setLyrics(def.id, fn, label, key);

  function parseTime(s) {
    const m = /^\s*(?:(\d+):)?(\d+(?:[.,]\d+)?)\s*$/.exec(s);
    return m ? Number(m[1] ?? 0) * 60 + Number(m[2].replace(',', '.')) : null;
  }

  // ---------- tap to sync ----------

  function tap() {
    const def = target(); if (!def) return;
    const t = now();
    edit(def, (l) => {
      if (wordMode) {
        const line = l.lines[tapIdx]; if (!line) return;
        if (line.t0 == null) tapStamp(l.lines, tapIdx, t);
        const next = tapWord(line, wordIdx, t);
        if (next < 0) { wordIdx = 0; tapIdx = Math.min(l.lines.length - 1, tapIdx + 1); } else wordIdx = next;
      } else {
        const next = tapStamp(l.lines, tapIdx, t);
        tapIdx = next < 0 ? l.lines.length : next;
      }
    }, 'Tap lyric', `tap:${def.id}`);
  }

  element.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === element.querySelector('.tap-btn')) return;
    if (e.key === 'Enter' && e.target.classList.contains('tap-btn')) return;
  });

  // ---------- sections ----------

  const section = (title, ic, ...body) => h('details.sect', { open: true }, h('summary', icon(ic), h('span', title), icon('expand_more', 'chev')), h('div.sect-body', body));
  const set = (def, path, label) => (v) => core.setLyrics(def.id, (l) => { const ks = path.split('.'); let o = l; for (const k of ks.slice(0, -1)) o = o[k]; o[ks.at(-1)] = v; }, `Lyrics ${label}`, `lyr:${def.id}:${path}`);

  function linesSection(def, lyr) {
    const paste = h('textarea.paste', { rows: 4, placeholder: 'Paste lyrics here, one line per row…', 'aria-label': 'Lyrics text' });
    const lines = lyr.lines;
    const next = lines[tapIdx];
    const tapBtn = h('button.btn.filled.tap-btn', { type: 'button', disabled: !lines.length, onclick: tap, title: 'Tap on the beat of each line while the song plays. Shortcut: T', 'aria-keyshortcuts': 'T' },
      icon('bolt'), wordMode ? 'Tap word' : 'Tap line');
    const rows = h('div.lyric-rows', { role: 'list' });
    lines.forEach((l, i) => {
      const t = h('input.time-input', { value: l.t0 == null ? '' : fmtTimeMs(l.t0), placeholder: '--:--', 'aria-label': `Line ${i + 1} time`,
        onchange: (e) => { const v = e.target.value.trim() === '' ? null : parseTime(e.target.value); edit(def, (x) => { x.lines[i].t0 = v; if (v != null) sortLines(x.lines); }, 'Set lyric time'); } });
      const txt = h('input.text-input', { value: l.text, 'aria-label': `Line ${i + 1} text`, onchange: (e) => edit(def, (x) => { x.lines[i].text = e.target.value; delete x.lines[i].words; }, 'Edit lyric', `lyr-text:${i}`) });
      rows.append(h('div.lyric-row', { role: 'listitem', class: `${i === tapIdx ? 'next' : ''} ${l.t0 != null && now() >= l.t0 ? 'past' : ''}`,
        onclick: (e) => { if (e.target.tagName !== 'INPUT') { tapIdx = i; wordIdx = 0; if (l.t0 != null) core.seek(Math.round(l.t0 * fps())); build(); } } },
      h('span.row-n', String(i + 1)), t, txt,
      h('button.icon-btn.sm', { type: 'button', title: 'Clear time', 'aria-label': 'Clear time', onclick: () => edit(def, (x) => { x.lines[i].t0 = null; delete x.lines[i].words; }, 'Clear lyric time') }, icon('close')),
      h('button.icon-btn.sm', { type: 'button', title: 'Delete line', 'aria-label': 'Delete line', onclick: () => edit(def, (x) => { x.lines.splice(i, 1); }, 'Delete lyric line') }, icon('delete'))));
    });
    const lrcIn = h('input', { type: 'file', accept: '.lrc,.txt,text/plain', hidden: true, onchange: async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      const parsed = parseLrc(await f.text());
      if (!parsed.length) { core.toast('No timed lines found in that file.'); return; }
      edit(def, (x) => { x.lines = parsed; }, 'Import LRC'); tapIdx = 0; core.toast(`Imported ${parsed.length} lines.`);
    } });
    return section('Words and timing', 'lyrics',
      h('div.row', h('button.btn.tonal', { type: 'button', onclick: () => {
        const arr = linesFromText(paste.value); if (!arr.length) return;
        edit(def, (x) => { x.lines = [...x.lines, ...arr]; }, 'Add lyric lines'); paste.value = '';
      } }, icon('add'), 'Add lines'),
      h('button.btn.text', { type: 'button', onclick: () => { edit(def, (x) => { x.lines = linesFromText(paste.value); }, 'Replace lyrics'); tapIdx = 0; } }, 'Replace all')),
      paste,
      h('div.tap-bar', tapBtn,
        h('span.muted', next ? `Next: “${next.text.slice(0, 28)}${next.text.length > 28 ? '…' : ''}”` : lines.length ? 'All lines timed.' : 'Add some lines first.'),
        h('span.grow'),
        h('button.btn.text.sm', { type: 'button', onclick: () => { tapIdx = 0; wordIdx = 0; build(); } }, icon('refresh'), 'Restart'),
        toggle({ label: 'Word by word', value: wordMode, title: 'For karaoke: tap each word of a line', onChange: (v) => { wordMode = v; wordIdx = 0; build(); } }).el),
      h('div.note', state.playing ? 'Playing. Tap on each line as it starts (or press T).' : 'Press play in the preview, then tap each line as it is sung (or press T). Drag the scrubber to re-time.'),
      rows, lrcIn,
      h('div.row',
        h('button.btn.text', { type: 'button', onclick: () => lrcIn.click() }, icon('file_upload'), 'Import LRC'),
        h('button.btn.text', { type: 'button', disabled: !lines.some((l) => l.t0 != null), onclick: () => core.download(new Blob([formatLrc(lines)], { type: 'text/plain' }), `${def.id}.lrc`) }, icon('file_download'), 'Export LRC'),
        h('button.btn.text', { type: 'button', disabled: !lines.length, onclick: () => { edit(def, (x) => { const d = state.engine ? 0 : 3; let t = now(); for (const l of x.lines) { l.t0 = t; t += 3 + d * 0; } }, 'Space lines evenly'); } }, icon('timeline'), 'Space evenly from playhead')));
  }

  function styleSection(def, lyr) {
    const s = lyr.style;
    const fontIn = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2', hidden: true, onchange: async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      const { name, path } = await core.addFontFile(f);
      core.setLyrics(def.id, (l) => { l.style.font = name; l.style.fontFile = path; }, 'Use custom font');
    } });
    const num = (label, path, o) => numField({ label, value: (path.split('.').reduce((a, k) => a[k], lyr)) * (o.mul ?? 1), min: o.min * (o.mul ?? 1), max: o.max * (o.mul ?? 1), step: o.step, suffix: o.suffix, onChange: (v) => set(def, path, label)(v / (o.mul ?? 1)) }).el;
    return section('Style', 'text_fields',
      h('div.fgrid',
        fontField({ value: s.font, toast: core.toast, onLoadFile: () => fontIn.click(), onChange: (v) => core.setLyrics(def.id, (l) => { l.style.font = v; delete l.style.fontFile; }, 'Lyrics font') }).el,
        num('Size', 'style.size', { min: 0.02, max: 0.3, step: 0.005, mul: 100, suffix: '%' }),
        selectField({ label: 'Weight', value: String(s.weight), options: [['300', 'Light'], ['400', 'Regular'], ['600', 'Semi-bold'], ['700', 'Bold'], ['900', 'Black']], onChange: (v) => set(def, 'style.weight', 'weight')(Number(v)) }).el,
        selectField({ label: 'Align', value: s.align, options: ['left', 'center', 'right'], onChange: set(def, 'style.align', 'align') }).el,
        num('Outline', 'style.outline', { min: 0, max: 0.4, step: 0.01, mul: 100, suffix: '%' }),
        num('Shadow', 'style.shadow', { min: 0, max: 1, step: 0.01, mul: 100, suffix: '%' }),
        num('Max width', 'style.maxWidth', { min: 0.2, max: 1, step: 0.01, mul: 100, suffix: '%' })),
      h('div.fgrid',
        colorField({ label: 'Text', value: s.color, onChange: set(def, 'style.color', 'color') }).el,
        colorField({ label: 'Highlight', value: s.hiColor, onChange: set(def, 'style.hiColor', 'highlight') }).el,
        colorField({ label: 'Outline', value: s.outlineColor, onChange: set(def, 'style.outlineColor', 'outline color') }).el),
      h('div.row', toggle({ label: 'Italic', value: s.italic, onChange: set(def, 'style.italic', 'italic') }).el,
        h('button.btn.text', { type: 'button', onclick: () => fontIn.click() }, icon('upload_file'), 'Load font file…')), fontIn,
      selectField({ label: 'Karaoke', value: s.karaoke, options: [['off', 'Off'], ['line', 'Sweep across line'], ['words', 'Word by word (needs word taps)']], onChange: set(def, 'style.karaoke', 'karaoke') }).el);
  }

  function animSection(def, lyr) {
    const a = lyr.anim; const L = lyr.layout;
    return section('Animation and placement', 'auto_awesome',
      h('div.fgrid',
        selectField({ label: 'Appear', value: a.in, options: [['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide up'], ['pop', 'Pop'], ['type', 'Typewriter']], onChange: set(def, 'anim.in', 'appear') }).el,
        selectField({ label: 'Leave', value: a.out, options: [['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide up']], onChange: set(def, 'anim.out', 'leave') }).el,
        numField({ label: 'Duration', value: a.dur, min: 0.05, max: 2, step: 0.05, suffix: 's', onChange: set(def, 'anim.dur', 'duration') }).el),
      h('div.fgrid',
        selectField({ label: 'Placement', value: L.mode, options: Object.entries(LAYOUT_MODES), onChange: set(def, 'layout.mode', 'placement'),
          title: 'Where each line appears. Random and corner modes move lines around automatically and the result is the same every time you play it.' }).el,
        numField({ label: 'Tilt', value: L.tilt, min: -45, max: 45, step: 1, suffix: '°', onChange: set(def, 'layout.tilt', 'tilt') }).el,
        numField({ label: 'Seed', value: L.seed, min: 1, max: 9999, step: 1, onChange: set(def, 'layout.seed', 'seed') }).el),
      h('div.row', toggle({ label: 'Avoid other layers', value: L.avoid, title: 'Keep text away from the main image where possible', onChange: set(def, 'layout.avoid', 'avoid') }).el,
        h('button.btn.tonal', { type: 'button', title: 'Pick a new random arrangement', onclick: () => set(def, 'layout.seed', 'seed')(1 + Math.floor(Math.random() * 9999)) }, icon('refresh'), 'Shuffle layout')));
  }

  function build() {
    clear(element); lastSig = sig();
    const def = target();
    if (!def) {
      element.append(h('div.empty-note', icon('lyrics'), h('p', 'No lyrics layer yet.'),
        h('button.btn.filled', { type: 'button', onclick: () => core.addLyrics() }, icon('add'), 'Add lyrics layer')));
      return;
    }
    const lyr = lyricsSettings(def);
    element.append(h('div.panel-toolbar', h('span.muted', `Editing “${def.name ?? def.id}”`)), linesSection(def, lyr), styleSection(def, lyr), animSection(def, lyr));
  }

  const sig = () => { const d = target(); return d ? JSON.stringify([d.id, d.lyrics, tapIdx, wordMode, state.playing]) : 'none'; };
  const refresh = rafThrottle(() => {
    if (element.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (sig() !== lastSig) build();
  });
  on('project', refresh); on('selection', refresh);
  on('transport', refresh);
  build();
  return { element, title: 'Lyrics', tap };
}
