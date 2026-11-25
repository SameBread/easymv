// Inspector for a Slideshow folder: one timing model for every slide, with per-slide overrides.

import * as core from '../../core.js';
import { state } from '../../core.js';
import { h, icon, selectField, toggle } from '../dom.js';
import { DECK_MODES, DECK_TRANS, deckSettings, parseClock, clockText } from '../../deck.js';

export function createDeckSections(section, shell) {
  const fpsNow = () => core.fps?.() ?? state.project.videoFps ?? 30;
  const songSec = () => (state.bridge ? core.totalFrames() / fpsNow() : 0);

  /** A time box: type "1:23.5" or "83", press Enter. The little target button copies the playhead. */
  function clockField({ label, value, placeholder, onChange, allowEmpty }) {
    const input = h('input.text-input.clock', { type: 'text', value: value == null ? '' : clockText(value), placeholder, inputmode: 'decimal', 'aria-label': label, spellcheck: false });
    const commit = () => {
      const t = input.value.trim();
      if (!t && allowEmpty) { onChange(null); return; }
      const v = parseClock(t);
      if (Number.isNaN(v)) { input.value = value == null ? '' : clockText(value); core.toast('Time looks like 1:23 or 83.5', 2500); return; }
      onChange(v);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    const here = h('button.icon-btn.sm', { type: 'button', title: 'Use the playhead time', 'aria-label': `${label}: use playhead`, onclick: () => onChange(state.frame / fpsNow()) }, icon('near_me'));
    const clear = allowEmpty ? h('button.icon-btn.sm', { type: 'button', title: 'Leave open (until the song ends)', 'aria-label': `${label}: leave open`, disabled: value == null, onclick: () => onChange(null) }, icon('close')) : null;
    return h('label.fld.col', h('span.fld-label', label), h('span.clock-row', input, here, clear));
  }

  function sections(def) {
    const d = deckSettings(def.deck);
    const sp = core.deckTiming(def.id);
    const song = songSec();
    const set = (patch, label) => core.setDeck(def.id, patch, label);
    const name = h('input.text-input', { type: 'text', value: def.name ?? '', 'aria-label': 'Slideshow name', placeholder: 'Slideshow name' });
    name.addEventListener('change', () => core.updateLayer(def.id, { name: name.value }, 'Rename slideshow'));

    const total = sp ? sp.total - sp.start : 0;
    const past = song && sp && sp.total > song + 0.5;
    const summary = h('div.deck-summary', { class: past ? 'warn' : '' },
      icon(past ? 'warning' : 'schedule'),
      h('span', `${d.slides.filter((s) => !s.hidden).length} of ${d.slides.length} slides · ${clockText(sp?.start ?? 0)} → ${clockText(sp?.total ?? 0)} (${Math.round(total)} s)`),
      past ? h('span.muted', ` — runs ${Math.round(sp.total - song)} s past the song`) : null);

    const modeSel = selectField({ label: 'Timing', value: d.mode, options: DECK_MODES.map(([v, l]) => [v, l]), onChange: (v) => set({ mode: v }, 'Change slideshow timing') }).el;
    const modeHint = h('div.note', DECK_MODES.find((m) => m[0] === d.mode)?.[2] ?? '');
    const fixed = h('input.text-input.sm', { type: 'number', min: '0.5', max: '600', step: '0.5', value: String(d.fixed), 'aria-label': 'Seconds per slide' });
    fixed.addEventListener('change', () => { const v = Number(fixed.value); if (v > 0) set({ fixed: v }, 'Seconds per slide'); });
    const beatsN = Number(d.beats) || 4;
    const beats = h('input.text-input.sm', { type: 'number', min: '0.25', max: '128', step: '0.25', value: String(beatsN), 'aria-label': 'Beats per slide' });
    beats.addEventListener('change', () => { const v = Number(beats.value); if (v > 0) set({ beats: v }, 'Beats per slide'); });
    const transSel = selectField({ label: 'Default transition', value: d.trans, options: DECK_TRANS, onChange: (v) => set({ trans: v }, 'Default transition') }).el;
    const fade = h('input.text-input.sm', { type: 'number', min: '0.05', max: '3', step: '0.05', value: String(d.fade), 'aria-label': 'Transition length' });
    fade.addEventListener('change', () => { const v = Number(fade.value); if (v > 0) set({ fade: v }, 'Transition length'); });

    const win = section('Slideshow', 'folder_open',
      h('label.fld.col', h('span.fld-label', 'Name'), name),
      summary,
      h('div.row.two', clockField({ label: 'Starts at', value: d.start, placeholder: '0:00', onChange: (v) => set({ start: Math.max(0, v ?? 0) }, 'Slideshow start') }),
        clockField({ label: 'Ends by', value: d.end, placeholder: song ? `song end ${clockText(song)}` : 'open', allowEmpty: true, onChange: (v) => set({ end: v }, 'Slideshow end') })),
      h('div.note', song ? 'Before Start and after End the slideshow is gone, so you can put your own intro or ending around it.' : 'Add a song to spread slides across its length. Until then, End is a hard limit and an open End uses each slide’s own length.'),
      modeSel, modeHint,
      d.mode === 'beats' ? h('label.fld.col', h('span.fld-label', 'Beats per slide'), h('span.clock-row', beats, h('span.muted', core.getTempo() ? `= ${(beatsN * 60 / core.getTempo().bpm).toFixed(2)} s at ${Math.round(core.getTempo().bpm * 10) / 10} BPM` : 'no tempo yet: set it in the timeline'))) : null,
      d.mode === 'beats' ? h('div.row', ...[[1, '1 beat'], [2, '2'], [4, '1 bar'], [8, '2 bars'], [16, '4 bars']].map(([n, l]) => h('button.btn.text.sm', { type: 'button', class: d.beats === n ? 'on' : '', onclick: () => set({ beats: n }, 'Beats per slide') }, l))) : null,
      d.mode === 'fixed' || d.slides.some((s) => !s.pages?.length) ? h('label.fld.col', h('span.fld-label', d.mode === 'fixed' ? 'Seconds per slide' : 'Seconds for slides without text'), fixed) : null,
      h('div.row.two', transSel, h('label.fld.col', h('span.fld-label', 'Transition (s)'), fade)),
      toggle({ label: 'Animate (fades, zoom, chart growth)', value: d.animate !== false, onChange: (v) => set({ animate: v }, 'Slideshow animation') }).el);

    // per-slide table
    const rows = d.slides.map((s, i) => {
      const w = sp?.slides[i];
      const cur = shell.deckSlide === i;
      const dur = h('input.text-input.sm', { type: 'number', min: '0.5', step: '0.5', value: s.dur ? String(s.dur) : '', placeholder: w ? (w.t1 - w.t0).toFixed(1) : '—', 'aria-label': `Slide ${i + 1} seconds`, disabled: s.hidden });
      dur.addEventListener('change', () => { const v = Number(dur.value); core.setDeckSlide(def.id, i, { dur: v > 0 ? v : null }, `Slide ${i + 1} length`); });
      const tr = h('select.sel.sm', { 'aria-label': `Slide ${i + 1} transition`, disabled: s.hidden, onchange: (e) => core.setDeckSlide(def.id, i, { trans: e.target.value || null }, `Slide ${i + 1} transition`) },
        h('option', { value: '' }, 'Default'), ...DECK_TRANS.map(([v, l]) => h('option', { value: v, selected: s.trans === v }, l)));
      const nPieces = (s.art ? 1 : 0) + (s.objects?.length ?? 0) + (s.pages?.length ? 1 : 0);
      return h('div.deck-slide', { class: `${cur ? 'cur' : ''} ${s.hidden ? 'skip' : ''}`, onclick: (e) => { if (e.target.closest('input,select,button')) return; shell.deckSlide = i; if (w) core.seek(Math.round(w.t0 * fpsNow())); } },
        h('span.n', String(i + 1)),
        h('span.t', { title: s.title || '' }, s.title || (s.art ? 'Picture' : 'Slide'), h('small', w ? `${clockText(w.t0)} · ${nPieces} piece${nPieces === 1 ? '' : 's'}` : 'skipped')),
        dur, tr,
        h('button.icon-btn.sm', { type: 'button', title: s.hidden ? 'Include this slide' : 'Skip this slide', 'aria-pressed': String(!!s.hidden), onclick: () => core.setDeckSlide(def.id, i, { hidden: !s.hidden }, s.hidden ? 'Include slide' : 'Skip slide') }, icon(s.hidden ? 'visibility_off' : 'visibility')));
    });
    const list = section('Slides', 'slideshow',
      h('div.deck-head', h('span', '#'), h('span', 'Slide'), h('span', 'Seconds'), h('span', 'Transition'), h('span')),
      h('div.deck-slides', rows),
      h('div.note', 'Leave Seconds empty to let the timing mode decide. A number is kept exactly and the other slides share what is left. Click a row to jump there.'));

    const text = d.script && core.layerById(d.script);
    const pieces = section('Inside this folder', 'folder_open',
      h('div.note', `${core.deckChildren(def.id).length} layers: slide artwork, charts and tables, and the text. They are timed by this slideshow, so change timing here. Anything else (your own intro, ending, effects) just goes outside the folder.`),
      text ? h('div.row', h('button.btn.tonal', { type: 'button', onclick: () => { core.select(text.id); shell.showPanel('script'); } }, icon('slideshow'), 'Open the text script')) : null,
      h('div.note', 'Editing the text script by hand is fine, but changing timing here rewrites its timestamps.'));
    return [win, list, pieces];
  }
  return { sections };
}
