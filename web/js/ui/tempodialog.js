// Tempo dialog: find the song's BPM (detect or tap), line the grid up with the first beat, add tempo changes,
// and listen to a metronome over the song to check it. Everything it edits is `project.tempo` (see tempo.js).

import * as core from '../core.js';
import { state } from '../core.js';
import { h, icon, dialog, selectField } from './dom.js';
import { clockText } from '../deck.js';

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function openTempoDialog() {
  let found = null;          // last detection result
  let taps = [];
  let tapInfo = '';
  const body = h('div.tempo-dlg');
  const fpsNow = () => state.project.videoFps;
  const nowSec = () => state.frame / fpsNow();
  const songLen = () => (state.bridge ? core.totalFrames() / fpsNow() : 0);

  function render() {
    const t = core.getTempo();
    body.replaceChildren(
      h('div.deck-summary', icon('schedule'), h('span', t ? `${round(t.bpm)} BPM · ${t.sig}/4 · first beat at ${clockText(t.offset)}${t.changes.length ? ` · ${t.changes.length} change${t.changes.length === 1 ? '' : 's'}` : ''}` : 'No tempo yet. Detect it from the song or tap it out.')),
      detectCard(), tapCard(t), fieldsCard(t), changesCard(t), checkCard());
  }

  function detectCard() {
    const run = () => {
      found = core.detectSongTempo();
      if (!found) core.toast('Could not find a steady beat. Try tapping it instead.', 3500);
      render();
    };
    const useBpm = (bpm, label) => h('button.btn.tonal', { type: 'button', onclick: () => { core.patchTempo({ bpm: round(bpm, 2), offset: found.offset }, 'Set tempo from song', 'tempo'); render(); } }, label ?? `Use ${round(bpm, 1)}`);
    return h('section.tempo-card',
      h('h4', 'From the song'),
      h('div.row', h('button.btn.filled', { type: 'button', disabled: !state.bridge, onclick: run }, icon('graphic_eq'), 'Detect BPM'),
        !state.bridge ? h('span.muted', 'Load a song first.') : null),
      found ? h('div.tempo-found',
        h('div', h('b', `${round(found.bpm, 1)} BPM`), `  ·  beat at ${clockText(found.offset)}  ·  ${Math.round(found.confidence * 100)}% sure`),
        h('div.row', useBpm(found.bpm), ...found.alternatives.map((a) => useBpm(a, `Use ${round(a, 1)} (${a < found.bpm ? '÷2' : '×2'})`))),
        h('div.note', 'Detection is often half or double the real tempo. If it feels twice as slow or fast, use the other value.')) : null);
  }

  function tapCard(t) {
    const tap = () => {
      taps.push(nowSec());
      const r = core.tapTempo(taps);
      if (r) {
        tapInfo = `${round(r.bpm, 1)} BPM from ${taps.length} taps`;
        core.setTempo({ ...(t ?? { sig: 4, changes: [] }), bpm: round(r.bpm, 2), offset: r.offset, sig: t?.sig ?? 4, changes: t?.changes ?? [] }, 'Tap tempo', 'tempo');
        const el = body.querySelector('.tap-info'); if (el) el.textContent = tapInfo;
        const sum = body.querySelector('.deck-summary span'); const cur = core.getTempo(); if (sum && cur) sum.textContent = `${round(cur.bpm)} BPM · ${cur.sig}/4 · first beat at ${clockText(cur.offset)}`;
      } else tapInfo = `${taps.length} tap${taps.length === 1 ? '' : 's'} — keep going`;
      const el = body.querySelector('.tap-info'); if (el) el.textContent = tapInfo;
    };
    return h('section.tempo-card',
      h('h4', 'Tap it out'),
      h('div.row', h('button.btn.filled.tap-btn', { type: 'button', onclick: tap, 'aria-label': 'Tap on every beat' }, icon('touch_app'), 'Tap'),
        h('button.btn.text', { type: 'button', onclick: () => { taps = []; tapInfo = ''; render(); } }, 'Start over'),
        playButton()),
      h('div.note.tap-info', tapInfo || 'Press Play, then tap on every beat (4 or more taps). The grid follows your taps.'));
  }

  function playButton() {
    const b = h('button.btn.tonal', { type: 'button', onclick: () => { core.togglePlay(); setTimeout(() => { b.replaceChildren(icon(state.playing ? 'pause' : 'play_arrow'), state.playing ? 'Pause' : 'Play'); }, 60); } }, icon(state.playing ? 'pause' : 'play_arrow'), state.playing ? 'Pause' : 'Play');
    return b;
  }

  function fieldsCard(t) {
    const cur = t ?? { bpm: 120, offset: 0, sig: 4, changes: [] };
    const bpm = h('input.text-input.sm', { type: 'number', min: '20', max: '400', step: '0.01', value: String(round(cur.bpm)), 'aria-label': 'BPM' });
    bpm.addEventListener('change', () => { const v = Number(bpm.value); if (v >= 20 && v <= 400) { core.patchTempo({ bpm: v }, 'Edit BPM'); render(); } });
    const off = h('input.text-input.sm', { type: 'number', step: '0.001', value: String(round(cur.offset, 3)), 'aria-label': 'First beat at (seconds)' });
    off.addEventListener('change', () => { const v = Number(off.value); if (Number.isFinite(v)) { core.patchTempo({ offset: v }, 'Move beat grid'); render(); } });
    const nudge = (ms) => h('button.btn.text.sm', { type: 'button', onclick: () => { core.patchTempo({ offset: round(cur.offset + ms / 1000, 3) }, 'Move beat grid'); render(); } }, `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`);
    const sig = selectField({ label: 'Beats per bar', value: String(cur.sig), options: [2, 3, 4, 5, 6, 7, 9, 12].map((n) => [String(n), `${n}`]), onChange: (v) => { core.patchTempo({ sig: Number(v) }, 'Beats per bar'); render(); } }).el;
    return h('section.tempo-card',
      h('h4', 'Fine tune'),
      h('div.row.two', h('label.fld.col', h('span.fld-label', 'BPM'), bpm), sig),
      h('div.row', h('label.fld.col', h('span.fld-label', 'First beat at (seconds)'), off), nudge(-10), nudge(10),
        h('button.btn.tonal', { type: 'button', title: 'Make the beat under the playhead the first beat of a bar', onclick: () => { core.patchTempo({ offset: round(nowSec(), 3) }, 'Beat 1 at playhead'); render(); } }, icon('near_me'), 'Beat 1 at playhead')),
      h('div.note', 'Play with the metronome on and nudge until the clicks sit on the music. Beat 1 should be the first strong beat of a bar.'));
  }

  function changesCard(t) {
    if (!t) return h('div');
    const rows = t.changes.map((c, i) => h('div.row', h('span', `from ${clockText(c.t)}`), h('b', `${round(c.bpm, 1)} BPM`),
      h('button.icon-btn.sm', { type: 'button', title: 'Remove this change', 'aria-label': 'Remove tempo change', onclick: () => { core.patchTempo({ changes: t.changes.filter((_, j) => j !== i) }, 'Remove tempo change'); render(); } }, icon('close'))));
    const bpm = h('input.text-input.sm', { type: 'number', min: '20', max: '400', step: '0.01', value: String(round(t.bpm)), 'aria-label': 'New BPM' });
    return h('section.tempo-card',
      h('h4', 'Tempo changes'), ...rows,
      h('div.row', h('label.fld.col', h('span.fld-label', 'New BPM'), bpm),
        h('button.btn.tonal', { type: 'button', onclick: () => { const v = Number(bpm.value); if (v >= 20 && v <= 400) { core.patchTempo({ changes: [...t.changes.filter((c) => Math.abs(c.t - nowSec()) > 0.05), { t: round(nowSec(), 3), bpm: v }] }, 'Add tempo change'); render(); } } }, icon('add'), `Change here (${clockText(nowSec())})`)),
      h('div.note', 'For songs that speed up or slow down. The new tempo starts at the playhead.'));
  }

  function checkCard() {
    const on = !!state.prefs.metronome;
    return h('section.tempo-card',
      h('h4', 'Check it'),
      h('div.row',
        h('button.btn.tonal', { type: 'button', 'aria-pressed': String(on), class: on ? 'on' : '', onclick: () => { core.setMetronome(!on); render(); } }, icon('music_note'), on ? 'Metronome on' : 'Metronome off'),
        h('button.btn.text', { type: 'button', onclick: () => { core.setTempo(null, 'Clear tempo'); found = null; render(); } }, icon('delete'), 'Clear tempo')),
      h('div.note', songLen() ? 'The click plays on every beat while you play the song, louder on beat 1.' : 'Load a song to play along.'));
  }

  render();
  dialog({ title: 'Tempo & beat grid', wide: true, body: [body], actions: [{ label: 'Done', variant: 'filled' }], onClose: () => { if (state.playing) core.stop(); } });
}
