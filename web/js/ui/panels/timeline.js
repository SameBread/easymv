// Timeline: one row per layer. Visibility bars say when a layer is on screen, diamonds are
// keyframes (expand a layer to see one row per animated property), the ruler holds sections.

import * as core from '../../core.js';
import { state, on, layerName, fmtTime, LAYER_TYPE_INFO } from '../../core.js';
import * as TL from '../../timeline.js';
import { h, icon, iconBtn, clear, showMenu, rafThrottle, dialog } from '../dom.js';
import { propsFor, PROP_BY_NAME } from '../../props.js';
import { lineEnd } from '../../lyrics.js';
import { compileFor } from '../../script.js';
import { moveScene, setSceneEnd } from '../../scripttext.js';
import { openTempoDialog } from '../tempodialog.js';
import { NOTE_DIVISIONS, noteBeats } from '../../tempo.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

export function createTimelinePanel(shell) {
  const element = h('div.panel-timeline');
  const expanded = new Set();
  const selKeys = new Map();             // "id|prop|f" -> {element, property, f}
  let ppf = 0;                           // pixels per frame
  let fit = true;
  let labelW = 168;
  let drag = null;
  let lastScrollFrame = -1;

  const toolbar = h('div.panel-toolbar');
  const scroller = h('div.tl-scroll', { tabIndex: 0, role: 'application', 'aria-label': 'Timeline' });
  const content = h('div.tl-content');
  const playhead = h('div.tl-playhead', h('span.tl-head'));
  scroller.append(content);
  element.append(toolbar, scroller);

  const total = () => core.totalFrames();
  const fps = () => state.project.videoFps;
  const width = () => Math.max(10, total() * ppf);
  const xOf = (f) => f * ppf;
  const frameAt = (clientX) => (clientX - content.getBoundingClientRect().left - labelW) / ppf;
  const tol = () => 7 / ppf;

  function applyFit() {
    const avail = Math.max(120, scroller.clientWidth - labelW - 12);
    ppf = avail / Math.max(1, total());
  }

  let altHeld = false;
  /** Grid snapping: with a tempo and a note length chosen, positions land on that note length (hold Alt to move freely). */
  function gridSnap(f) {
    const t = core.getTempo(); const g = state.prefs.grid ?? 'off';
    if (!t || g === 'off' || altHeld) return null;
    return Math.round(core.snapSeconds(f / fps(), t, g) * fps());
  }
  function snap(f, extra = []) {
    if (altHeld) return f;
    const gs = gridSnap(f);
    if (gs != null) {
      // an exact hit on a section edge or the playhead still wins over the grid
      const near = [state.frame, ...state.project.sections.flatMap((s) => [s.start, s.end]), ...extra].filter((c) => Math.abs(c - f) <= Math.min(tol(), 3));
      return near.length ? near.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a)) : gs;
    }
    if (!state.prefs.snap) return f;
    const cands = [...state.beats, state.frame, 0, total(), ...state.project.sections.flatMap((s) => [s.start, s.end]), ...extra];
    return TL.snapFrame(f, cands, tol());
  }

  // ---------- toolbar ----------

  function buildToolbar() {
    clear(toolbar);
    toolbar.append(
      iconBtn('zoom_out', 'Zoom out', () => zoom(1 / 1.5), 'sm'),
      iconBtn('zoom_in', 'Zoom in', () => zoom(1.5), 'sm'),
      iconBtn('fit_screen', 'Fit whole song', () => { fit = true; render(); }, 'sm'),
      h('span.divider'),
      h('button.btn.text.sm', { type: 'button', class: state.prefs.snap ? 'on' : '', title: 'Snap to beats, sections and the playhead', 'aria-pressed': String(state.prefs.snap),
        onclick: () => { core.setPref('snap', !state.prefs.snap); buildToolbar(); } }, icon('bolt'), 'Snap'),
      (() => {
        const tp = core.getTempo(); const g = state.prefs.grid ?? 'off';
        return h('span.tl-tempo',
          h('button.btn.text.sm', { type: 'button', class: tp ? 'on' : '', title: tp ? 'Tempo and beat grid' : 'Set the tempo: detect the BPM, tap it, or type it', onclick: () => openTempoDialog() }, icon('music_note'), tp ? `${Math.round(tp.bpm * 10) / 10} BPM` : 'Tempo'),
          tp ? h('button.btn.text.sm', { type: 'button', class: g !== 'off' ? 'on' : '', title: 'Snap by note length (hold Alt to move freely)', 'aria-label': 'Grid snap',
            onclick: (e) => showMenu(e.currentTarget, [{ header: 'Snap to note length' }, { label: 'Off', icon: g === 'off' ? 'done' : null, run: () => { core.setPref('grid', 'off'); buildToolbar(); render(); } },
              ...NOTE_DIVISIONS.map(([v, l]) => ({ label: l, icon: g === v ? 'done' : null, run: () => { core.setPref('grid', v); buildToolbar(); render(); } }))]) }, icon('grid_on'), g === 'off' ? 'Grid off' : (NOTE_DIVISIONS.find((x) => x[0] === g)?.[1] ?? g)) : null);
      })(),
      h('button.btn.text.sm', { type: 'button', title: 'Add a section starting at the playhead', onclick: () => core.addSection() }, icon('flag'), 'Section'),
      h('button.btn.text.sm', { type: 'button', title: 'Drop a marker at the playhead (Shift+M). Jump between markers with [ and ]', onclick: () => core.addMarker() }, icon('bookmark'), 'Marker'),
      h('button.btn.text.sm', { type: 'button', title: 'Show the layer at the playhead until the next cut', onclick: () => cutHere() }, icon('content_cut'), 'Split'),
      h('span.grow'),
      h('span.muted.tl-time', `${fmtTime(state.frame / fps())} / ${fmtTime(total() / fps())}`));
  }

  function zoom(k, anchorFrame = state.frame) {
    fit = false;
    const x0 = xOf(anchorFrame) - scroller.scrollLeft;
    ppf = clamp(ppf * k, 0.05, 40);
    render();
    scroller.scrollLeft = xOf(anchorFrame) - x0;
  }

  function cutHere() {
    const id = state.selected; if (!id) { core.toast('Select a layer first.'); return; }
    const spans = core.visibilitySpans(id);
    const f = state.frame;
    const out = [];
    for (const [a, b] of spans) { if (f > a && f < b) out.push([a, f], [f, b]); else out.push([a, b]); }
    core.setVisibility(id, out.length === spans.length ? spans : out.map(([a, b], i) => (i % 2 && a === f ? [a + 1, b] : [a, b])));
  }

  // ---------- render ----------

  /** Bar / beat / sub-beat lines for the current tempo, as elements positioned in the track coordinate system. */
  function gridLevel() {
    const tp = core.getTempo(); if (!tp) return null;
    const g = state.prefs.grid ?? 'off';
    const pxPer = (div) => noteBeats(div, tp) * (60 / tp.bpm) * fps() * ppf;
    let fine = g === 'off' ? '1/4' : g;
    if (pxPer(fine) < 7) fine = '1/4';
    if (pxPer(fine) < 7) fine = 'bar';
    if (pxPer(fine) < 7) return null;
    return { tp, fine, barPx: pxPer('bar') };
  }
  function gridEls(kind) {
    const lv = gridLevel(); if (!lv) return [];
    const { tp, fine, barPx } = lv;
    const out = [];
    for (const { f, beat } of core.tempoGrid(fine, 0, total())) {
      const isBar = Math.abs(beat / tp.sig - Math.round(beat / tp.sig)) < 1e-6;
      const isBeat = Math.abs(beat - Math.round(beat)) < 1e-6;
      const cls = isBar ? 'bar' : isBeat ? 'beat' : 'sub';
      const el = h('i.gl', { class: `${cls} ${kind}`, style: { left: `${xOf(f)}px` } });
      if (kind === 'ruler' && isBar && barPx > 34) el.append(h('span.gl-n', String(Math.round(beat / tp.sig) + 1)));
      out.push(el);
    }
    return out;
  }

  function ruler() {
    const sec = Math.max(0.1, 1);
    const stepS = STEPS.find((s) => s * fps() * ppf >= 74) ?? STEPS.at(-1);
    const r = h('div.tl-row.tl-ruler', h('div.tl-label.corner'));
    const tr = h('div.tl-track', { style: { width: `${width()}px` }, dataset: { role: 'ruler' } });
    void sec;
    for (let s = 0; s * fps() <= total(); s += stepS) {
      tr.append(h('span.tick', { style: { left: `${xOf(s * fps())}px` } }, fmtTime(s)));
    }
    if (state.beats.length && ppf * (total() / state.beats.length) > 3) {
      for (const f of state.beats) tr.append(h('i.beat', { style: { left: `${xOf(f)}px` } }));
    }
    for (const s of state.project.sections) {
      const sel = shell.selectedSection === s.id;
      tr.append(h('div.sect-band', { class: sel ? 'sel' : '', dataset: { role: 'sec', id: s.id }, style: { left: `${xOf(s.start)}px`, width: `${Math.max(6, xOf(s.end - s.start))}px`, '--c': s.color }, title: `${s.name} — drag to move with its keyframes (Alt: band only)` },
        h('span.sect-name', s.name), h('i.grip.l', { dataset: { role: 'sec-l', id: s.id } }), h('i.grip.r', { dataset: { role: 'sec-r', id: s.id } })));
    }
    for (const m of state.project.markers ?? []) {
      tr.append(h('div.tl-marker', { dataset: { role: 'marker', id: m.id }, style: { left: `${xOf(m.f)}px` }, title: `${m.name || 'Marker'} — click to jump, double-click to rename, right-click for more` },
        h('i.mk-flag'), m.name ? h('span.mk-name', m.name) : null));
    }
    tr.append(...gridEls('ruler'));
    r.append(tr);
    return r;
  }

  function deckRow(def) {
    const isSel = state.selected === def.id;
    const sp = core.deckTiming(def.id);
    const label = h('div.tl-label', { class: isSel ? 'sel' : '', onclick: () => core.select(def.id) },
      h('button.icon-btn.sm.twirl', { type: 'button', 'aria-expanded': String(!def.collapsed), 'aria-label': def.collapsed ? 'Open folder' : 'Close folder', title: def.collapsed ? 'Show the slides inside' : 'Hide the slides inside',
        onclick: (e) => { e.stopPropagation(); core.toggleFolder(def.id); } }, icon(def.collapsed ? 'expand_more' : 'expand_less')),
      icon('folder_open', 'kind'), h('span.tl-name', layerName(def)));
    const tr = h('div.tl-track', { class: `${isSel ? 'sel' : ''} deck`, style: { width: `${width()}px` }, dataset: { role: 'track', id: def.id } });
    sp?.slides.forEach((s, i) => {
      if (!s) return;
      const sl = def.deck.slides[i]; const a = s.t0 * fps(); const b = s.t1 * fps();
      tr.append(h('div.deck-seg', { class: def.deck.off ? 'off' : '', style: { left: `${xOf(a)}px`, width: `${Math.max(3, xOf(b - a) - 1)}px` }, title: `Slide ${i + 1}${sl.title ? `: ${sl.title}` : ''} · ${(s.t1 - s.t0).toFixed(1)} s`,
        dataset: { role: 'deckseg', id: def.id, i: String(i) }, onclick: (e) => { e.stopPropagation(); core.select(def.id); shell.deckSlide = i; core.emit?.('project'); } }, h('span', String(i + 1))));
    });
    return [h('div.tl-row.deck-row', { class: isSel ? 'sel' : '', dataset: { layer: def.id } }, label, tr)];
  }

  function layerRow(def) {
    if (def.type === 'deck') return deckRow(def);
    const idx = core.layerIndex(def.id);
    const isSel = state.selected === def.id;
    const open = expanded.has(def.id);
    const tracks = state.project.tracks.filter((t) => t.element === def.id && t.property !== 'visible');
    const label = h('div.tl-label', { class: isSel ? 'sel' : '', onclick: () => core.select(def.id), oncontextmenu: (e) => { e.preventDefault(); layerMenu(e, def); } },
      h('button.icon-btn.sm.twirl', { type: 'button', 'aria-expanded': String(open), 'aria-label': open ? 'Collapse' : 'Expand properties', title: 'Show animated properties',
        onclick: (e) => { e.stopPropagation(); if (expanded.has(def.id)) expanded.delete(def.id); else expanded.add(def.id); render(); } }, icon(open ? 'expand_less' : 'expand_more')),
      icon(LAYER_TYPE_INFO[def.type]?.icon ?? 'image', 'kind'),
      h('span.tl-name', layerName(def)),
      tracks.length ? h('span.badge', String(tracks.length)) : null);
    const tr = h('div.tl-track', { class: isSel ? 'sel' : '', style: { width: `${width()}px` }, dataset: { role: 'track', id: def.id } });
    const spans = core.visibilitySpans(def.id);
    const hasTrack = !!core.trackOf(def.id, 'visible');
    const baseVisible = (def.base?.visible ?? 1) >= 0.5;
    if (def.type === 'lyrics' && def.lyrics?.lines?.length) {
      const L = def.lyrics.lines;
      L.forEach((l, i) => {
        if (l.t0 == null) return;
        const a = l.t0 * fps(); const b = lineEnd(L, i, total() / fps()) * fps();
        tr.append(h('div.lyric-clip', { style: { left: `${xOf(a)}px`, width: `${Math.max(3, xOf(b - a))}px` }, title: l.text, dataset: { role: 'clip', f: String(Math.round(a)) } }, l.text));
      });
    }
    if (baseVisible || hasTrack) {
      spans.forEach(([a, b], i) => {
        tr.append(h('div.vis-bar', { class: hasTrack ? '' : 'static', dataset: { role: 'bar', id: def.id, i: String(i) }, style: { left: `${xOf(a)}px`, width: `${Math.max(4, xOf(b - a))}px` },
          title: hasTrack ? 'Drag to move, drag the ends to resize, double-click to split, right-click for more' : 'Visible the whole song. Drag an end to start a cut.' },
        h('i.grip.l', { dataset: { role: 'bar-l', id: def.id, i: String(i) } }), h('i.grip.r', { dataset: { role: 'bar-r', id: def.id, i: String(i) } })));
      });
    }
    if (def.type === 'script') {
      try {
        const [W, H] = state.project.resolution;
        const c = compileFor(def, W, H, total() / fps());
        c.scenes.forEach((sc, i) => {
          const a = sc.t0 * fps(); const b = sc.t1 * fps(); const g = sc.gone * fps();
          tr.append(h('div.scene-seg', { style: { left: `${xOf(a)}px`, width: `${Math.max(6, xOf(b - a))}px` }, title: `Scene ${i + 1}: ${fmtTime(sc.t0)} to ${fmtTime(sc.t1)}. Drag to move it, drag the right end to change its length (Alt = free).`,
            dataset: { role: 'scene', id: def.id, i: String(i), t0: String(sc.t0), t1: String(sc.t1) } },
          h('span', String(i + 1)), g > b ? h('i.scene-tail', { style: { width: `${xOf(g - b)}px` } }) : null, h('i.grip.r', { dataset: { role: 'scene-r', id: def.id, i: String(i), t0: String(sc.t0), t1: String(sc.t1) } })));
        });
      } catch { /* a script that does not compile yet shows no blocks */ }
    }
    // keyframe summary
    for (const t of tracks) for (const k of t.keys) tr.append(h('i.kf.mini', { style: { left: `${xOf(k.f)}px` }, dataset: { role: 'mini', f: String(k.f) } }));
    const rows = [h('div.tl-row', { class: isSel ? 'sel' : '', dataset: { layer: def.id } }, label, tr)];
    if (open) {
      for (const t of tracks) rows.push(propRow(def, t));
      const free = propsFor(def.type).filter((p) => !p.toggle && !core.trackOf(def.id, p.name));
      rows.push(h('div.tl-row.sub.add', h('div.tl-label.sub', h('button.btn.text.sm', { type: 'button', onclick: (e) => showMenu(e.currentTarget, [{ header: 'Animate a property at the playhead' },
        ...free.map((p) => ({ label: p.label, run: () => core.toggleKeyAtPlayhead(def.id, p.name) }))]) }, icon('add'), 'Animate property…')), h('div.tl-track', { style: { width: `${width()}px` } })));
    }
    void idx;
    return rows;
  }

  function propRow(def, t) {
    const info = PROP_BY_NAME[t.property];
    const label = h('div.tl-label.sub', { title: `${info?.label}: ${TL.MODES[t.mode]}` }, h('span.tl-name', info?.label ?? t.property), h('span.mode-tag', t.mode === 'override' ? 'override' : t.mode === 'mix' ? 'mix' : 'blend'));
    const tr = h('div.tl-track', { style: { width: `${width()}px` }, dataset: { role: 'track', id: def.id } });
    for (let i = 0; i < t.keys.length - 1; i++) {
      const a = t.keys[i]; const b = t.keys[i + 1];
      if (a.interp !== 'hold') tr.append(h('i.kf-link', { style: { left: `${xOf(a.f)}px`, width: `${xOf(b.f - a.f)}px` } }));
    }
    for (const k of t.keys) {
      const id = `${def.id}|${t.property}|${k.f}`;
      tr.append(h('i.kf', { class: `${k.interp} ${selKeys.has(id) ? 'sel' : ''}`, style: { left: `${xOf(k.f)}px` }, dataset: { role: 'kf', id: def.id, prop: t.property, f: String(k.f) }, title: `${info?.label} = ${(k.v * (info?.mul ?? 1)).toFixed(2)}${info?.suffix ?? ''} · ${k.interp}` }));
    }
    return h('div.tl-row.sub', label, tr);
  }

  function render() {
    if (!state.project) return;
    if (fit || !ppf) applyFit();
    buildToolbar();
    const keepL = scroller.scrollLeft; const keepT = scroller.scrollTop;
    clear(content);
    content.style.width = `${labelW + width() + 12}px`;
    content.style.setProperty('--label-w', `${labelW}px`);
    content.append(ruler());
    const layers = [...state.project.elements].reverse();
    const closed = new Set(layers.filter((d) => d.type === 'deck' && d.collapsed).map((d) => d.id));
    for (const def of layers) { if (def.group && closed.has(def.group)) continue; for (const r of layerRow(def)) { if (def.group) r.classList?.add('in-folder'); content.append(r); } }
    if (!layers.length) content.append(h('div.empty-note', h('p', 'Add layers to see them here.')));
    const gl = gridEls('rows');
    if (gl.length) content.append(h('div.tl-grid', { 'aria-hidden': 'true' }, ...gl));
    content.append(playhead);
    placePlayhead();
    scroller.scrollLeft = keepL; scroller.scrollTop = keepT;
  }

  function placePlayhead() {
    playhead.style.left = `${labelW + xOf(state.frame)}px`;
    const t = element.querySelector('.tl-time'); if (t) t.textContent = `${fmtTime(state.frame / fps())} / ${fmtTime(total() / fps())}`;
    // keep the playhead in view while playing
    if (state.playing) {
      const x = labelW + xOf(state.frame);
      const vis0 = scroller.scrollLeft + labelW; const vis1 = scroller.scrollLeft + scroller.clientWidth;
      if (x > vis1 - 24 || x < vis0) scroller.scrollLeft = x - labelW - 40;
    }
  }

  // ---------- menus & dialogs ----------

  function layerMenu(e, def) {
    showMenu({ x: e.clientX, y: e.clientY }, [
      { label: 'Always visible', icon: 'visibility', run: () => core.setVisibility(def.id, [[0, total()]]) },
      { label: 'Hide from playhead to end', icon: 'visibility_off', run: () => core.setVisibility(def.id, [[0, Math.max(1, state.frame)]]) },
      { label: 'Show from playhead to end', icon: 'visibility', run: () => core.setVisibility(def.id, [[state.frame, total()]]) },
      { separator: true },
      { label: 'Remove all keyframes', icon: 'delete', run: () => core.editTracks((p) => { p.tracks = p.tracks.filter((t) => t.element !== def.id || t.property === 'visible'); }, 'Remove keyframes') }]);
  }

  function barMenu(e, id, i) {
    const spans = core.visibilitySpans(id);
    showMenu({ x: e.clientX, y: e.clientY }, [
      { label: 'Split at playhead', icon: 'content_cut', disabled: !(state.frame > spans[i][0] && state.frame < spans[i][1]), run: () => {
        const out = spans.flatMap((s, k) => (k === i ? [[s[0], state.frame], [state.frame + 1, s[1]]] : [s]));
        core.setVisibility(id, out);
      } },
      ...state.project.sections.map((s) => ({ label: `Fit to “${s.name}”`, icon: 'flag', run: () => { const out = spans.slice(); out[i] = [s.start, s.end]; core.setVisibility(id, out); } })),
      { separator: true },
      { label: 'Delete this span', icon: 'delete', run: () => core.setVisibility(id, spans.filter((_, k) => k !== i)) }]);
  }

  function nameDialog(sec) {
    const input = h('input.text-input', { value: sec.name, 'aria-label': 'Section name' });
    const colors = h('div.swatches', TL.SECTION_COLORS.map((c) => h('button.swatch', { type: 'button', style: { background: c }, 'aria-label': c, class: c === sec.color ? 'on' : '', onclick: (e) => { sec.color = c; colors.querySelectorAll('.swatch').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } })));
    dialog({ title: 'Section', body: [h('label.fld', h('span.fld-label', 'Name'), input), h('div.fld-label', 'Color'), colors],
      actions: [{ label: 'Cancel' }, { label: 'Save', variant: 'filled', run: () => core.editSection(sec.id, { name: input.value || sec.name, color: sec.color }) }] });
    input.select();
  }

  function markerName(m) {
    const input = h('input.text-input', { value: m.name, placeholder: 'Marker name', 'aria-label': 'Marker name' });
    dialog({ title: 'Marker', body: [input], actions: [{ label: 'Cancel' }, { label: 'Save', variant: 'filled', run: () => core.editMarker(m.id, { name: input.value.trim() }, 'Rename marker') }] });
    input.select();
  }

  function sectionMenu(e, s) {
    showMenu({ x: e.clientX, y: e.clientY }, [
      { label: 'Rename / color…', icon: 'edit', run: () => nameDialog({ ...s }) },
      { label: 'Duplicate with keyframes', icon: 'content_copy', run: () => core.duplicateSection(s.id) },
      { label: 'Start at playhead', run: () => core.editSection(s.id, { start: Math.min(state.frame, s.end - 1) }) },
      { label: 'End at playhead', run: () => core.editSection(s.id, { end: Math.max(state.frame, s.start + 1) }) },
      { separator: true },
      { label: 'Delete section', icon: 'delete', run: () => core.removeSection(s.id) }]);
  }

  function kfMenu(e) {
    const interps = TL.INTERPS;
    showMenu({ x: e.clientX, y: e.clientY }, [
      { header: 'Keyframe' },
      ...interps.map((it) => ({ label: `Change to ${it}`, run: () => setInterpSel(it) })),
      { separator: true },
      { label: 'Delete', icon: 'delete', shortcut: 'Del', run: deleteSel }]);
  }

  const groups = () => {
    const by = new Map();
    for (const k of selKeys.values()) { const key = `${k.element}|${k.property}`; if (!by.has(key)) by.set(key, { element: k.element, property: k.property, frames: [] }); by.get(key).frames.push(k.f); }
    return [...by.values()];
  };
  function deleteSel() {
    if (!selKeys.size) return;
    const g = groups(); selKeys.clear();
    core.editTracks((p) => { for (const x of g) { const t = TL.findTrack(p, x.element, x.property); if (t) TL.removeKeys(p, t, x.frames); } }, 'Delete keyframes');
  }
  function setInterpSel(it) {
    const g = groups();
    core.editTracks((p) => { for (const x of g) { const t = TL.findTrack(p, x.element, x.property); if (t) TL.setInterp(t, x.frames, it); } }, `Keyframes: ${it}`);
  }

  // ---------- pointer interaction ----------

  const roleOf = (e) => { const el = e.target.closest?.('[data-role]'); return el ? { el, role: el.dataset.role, d: el.dataset } : null; };

  content.addEventListener('pointerdown', (e) => {
    if (e.button === 2 || e.target.closest('.tl-label')) return;   // labels have their own buttons
    const hit = roleOf(e);
    const f0 = frameAt(e.clientX);
    scroller.focus({ preventScroll: true });
    if (hit?.role === 'marker') { const m = state.project.markers.find((x) => x.id === hit.d.id); if (m) core.seek(m.f); return; }
    if (!hit || hit.role === 'track' || hit.role === 'ruler' || hit.role === 'clip' || hit.role === 'mini') {
      if (hit?.d.id) core.select(hit.d.id);
      if (e.shiftKey && hit?.role === 'track') {
        drag = { kind: 'marquee', x0: e.clientX, y0: e.clientY, box: h('div.marquee') }; content.append(drag.box);
      } else { if (!e.shiftKey) selKeys.clear(); drag = { kind: 'seek' }; core.seek(f0); }
      scroller.setPointerCapture(e.pointerId); return;
    }
    const d = hit.d;
    if (hit.role === 'kf') {
      const id = `${d.id}|${d.prop}|${d.f}`;
      if (e.shiftKey) { if (selKeys.has(id)) selKeys.delete(id); else selKeys.set(id, { element: d.id, property: d.prop, f: Number(d.f) }); }
      else if (!selKeys.has(id)) { selKeys.clear(); selKeys.set(id, { element: d.id, property: d.prop, f: Number(d.f) }); }
      core.select(d.id);
      drag = { kind: 'kf', start: f0, applied: 0, moved: false };
      render(); scroller.setPointerCapture(e.pointerId); return;
    }
    if (hit.role === 'bar' || hit.role === 'bar-l' || hit.role === 'bar-r') {
      core.select(d.id);
      const spans = core.visibilitySpans(d.id).map((s) => [...s]);
      drag = { kind: hit.role, id: d.id, i: Number(d.i), spans, start: f0, moved: false };
      scroller.setPointerCapture(e.pointerId); return;
    }
    if (hit.role === 'scene' || hit.role === 'scene-r') {
      core.select(d.id);
      const def = core.layerById(d.id); if (!def) return;
      drag = { kind: hit.role, id: d.id, si: Number(d.i), t0: Number(d.t0), t1: Number(d.t1), start: frameAt(e.clientX), text0: def.script?.text ?? '', moved: false };
      scroller.setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    if (hit.role === 'sec' || hit.role === 'sec-l' || hit.role === 'sec-r') {
      const s = state.project.sections.find((x) => x.id === d.id); if (!s) return;
      shell.selectedSection = s.id;
      drag = { kind: hit.role, id: s.id, s0: { ...s }, start: f0, alt: e.altKey, delta: 0 };
      scroller.setPointerCapture(e.pointerId); e.preventDefault();
    }
  });

  scroller.addEventListener('pointermove', (e) => {
    altHeld = e.altKey;
    if (!drag) return;
    const f = frameAt(e.clientX);
    if (drag.kind === 'seek') { core.seek(clamp(f, 0, total() - 1)); return; }
    if (drag.kind === 'marquee') {
      const r = content.getBoundingClientRect();
      const x0 = Math.min(drag.x0, e.clientX); const x1 = Math.max(drag.x0, e.clientX);
      const y0 = Math.min(drag.y0, e.clientY); const y1 = Math.max(drag.y0, e.clientY);
      Object.assign(drag.box.style, { left: `${x0 - r.left}px`, top: `${y0 - r.top}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      selKeys.clear();
      for (const k of content.querySelectorAll('.kf')) {
        const b = k.getBoundingClientRect();
        if (b.right >= x0 && b.left <= x1 && b.bottom >= y0 && b.top <= y1) selKeys.set(`${k.dataset.id}|${k.dataset.prop}|${k.dataset.f}`, { element: k.dataset.id, property: k.dataset.prop, f: Number(k.dataset.f) });
        k.classList.toggle('sel', selKeys.has(`${k.dataset.id}|${k.dataset.prop}|${k.dataset.f}`));
      }
      return;
    }
    if (drag.kind === 'kf') {
      const first = selKeys.values().next().value;
      let want = Math.round(f) - Math.round(drag.start);
      if (!drag.moved && Math.abs(want) < 1) return;
      drag.moved = true;
      // snap the key under the pointer, apply the same delta to the others
      if (selKeys.size === 1 && first) want = snap(first.f + want - drag.applied, []) - first.f + drag.applied;
      const step = want - drag.applied; if (!step) return;
      const g = groups();
      core.editTracks((p) => {
        for (const x of g) { const t = TL.findTrack(p, x.element, x.property); if (t) TL.moveKeys(t, x.frames, step, total()); }
      }, 'Move keyframes', 'kfmove');
      // moveKeys clamps; resync selection from the tracks
      const moved = new Map();
      for (const k of selKeys.values()) { const nf = k.f + step; const kk = { ...k, f: clamp(nf, 0, total()) }; moved.set(`${kk.element}|${kk.property}|${kk.f}`, kk); }
      selKeys.clear(); for (const [a, b] of moved) selKeys.set(a, b);
      drag.applied = want; return;
    }
    if (drag.kind === 'scene' || drag.kind === 'scene-r') {
      const dtF = Math.round(f) - Math.round(drag.start);
      if (!drag.moved && Math.abs(dtF) < 1) return;
      drag.moved = true;
      const fr = fps();
      if (drag.kind === 'scene') {
        const want = snap(drag.t0 * fr + dtF, [])
        const t0 = Math.max(0, want / fr);
        core.setScript(drag.id, (x) => { x.text = moveScene(drag.text0, drag.si, drag.t0, t0); }, 'Move scene', `scene:${drag.id}:${drag.si}`);
      } else {
        const want = snap(drag.t1 * fr + dtF, []);
        const t1 = Math.max(drag.t0 + 0.3, want / fr);
        core.setScript(drag.id, (x) => { x.text = setSceneEnd(drag.text0, drag.si, drag.t0, t1); }, 'Change scene length', `scene:${drag.id}:${drag.si}:end`);
      }
      return;
    }
    if (drag.kind === 'bar' || drag.kind === 'bar-l' || drag.kind === 'bar-r') {
      const raw = Math.round(f) - Math.round(drag.start);
      if (!drag.moved && Math.abs(raw) < 1) return;
      drag.moved = true;
      const s = drag.spans.map((x) => [...x]); const cur = s[drag.i];
      if (drag.kind === 'bar') { const len = cur[1] - cur[0]; const a = clamp(snap(cur[0] + raw, [cur[0] + raw + len]), 0, total() - len); cur[0] = a; cur[1] = a + len; }
      else if (drag.kind === 'bar-l') cur[0] = clamp(snap(cur[0] + raw), 0, cur[1] - 1);
      else cur[1] = clamp(snap(cur[1] + raw), cur[0] + 1, total());
      core.setVisibility(drag.id, s); return;
    }
    if (drag.kind === 'sec-l') core.editSection(drag.id, { start: clamp(snap(Math.round(f)), 0, drag.s0.end - 1) }, 'Resize section', `sec:${drag.id}`);
    else if (drag.kind === 'sec-r') core.editSection(drag.id, { end: clamp(snap(Math.round(f)), drag.s0.start + 1, total()) }, 'Resize section', `sec:${drag.id}`);
    else if (drag.kind === 'sec') {
      drag.delta = clamp(Math.round(f) - Math.round(drag.start), -drag.s0.start, total() - drag.s0.end);
      const band = content.querySelector(`.sect-band[data-id="${drag.id}"]`);
      if (band) band.style.left = `${xOf(drag.s0.start + drag.delta)}px`;
    }
  });

  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'marquee') d.box.remove();
    if (d.kind === 'sec' && d.delta) {
      if (d.alt) core.editSection(d.id, { start: d.s0.start + d.delta, end: d.s0.end + d.delta }, 'Move section');
      else core.moveSection(d.id, d.delta);
    }
    if (d.kind === 'kf') render();
  };
  scroller.addEventListener('pointerup', endDrag);
  scroller.addEventListener('pointercancel', endDrag);

  content.addEventListener('dblclick', (e) => {
    const hit = roleOf(e); if (!hit) return;
    if (hit.role === 'bar') { const id = hit.d.id; const spans = core.visibilitySpans(id); const f = Math.round(frameAt(e.clientX)); const i = Number(hit.d.i);
      if (f > spans[i][0] + 1 && f < spans[i][1] - 1) core.setVisibility(id, spans.flatMap((s, k) => (k === i ? [[s[0], f], [f + 1, s[1]]] : [s]))); }
    else if (hit.role === 'track' && hit.d.id) {
      const id = hit.d.id; const spans = core.visibilitySpans(id); const f = Math.round(frameAt(e.clientX));
      core.setVisibility(id, [...spans, [f, Math.min(total(), f + Math.round(fps() * 4))]]);
    } else if (hit.role === 'sec') { const s = state.project.sections.find((x) => x.id === hit.d.id); if (s) nameDialog({ ...s }); }
    else if (hit.role === 'ruler') core.addSection(Math.round(frameAt(e.clientX)));
    else if (hit.role === 'kf') core.seek(Number(hit.d.f));
    else if (hit.role === 'marker') { const m = state.project.markers.find((x) => x.id === hit.d.id); if (m) markerName(m); }
  });

  content.addEventListener('contextmenu', (e) => {
    const hit = roleOf(e); if (!hit) return;
    e.preventDefault();
    if (hit.role === 'bar' || hit.role === 'bar-l' || hit.role === 'bar-r') barMenu(e, hit.d.id, Number(hit.d.i));
    else if (hit.role === 'sec') sectionMenu(e, state.project.sections.find((x) => x.id === hit.d.id));
    else if (hit.role === 'kf') {
      const id = `${hit.d.id}|${hit.d.prop}|${hit.d.f}`;
      if (!selKeys.has(id)) { selKeys.clear(); selKeys.set(id, { element: hit.d.id, property: hit.d.prop, f: Number(hit.d.f) }); render(); }
      kfMenu(e);
    } else if (hit.role === 'marker') {
      const m = state.project.markers.find((x) => x.id === hit.d.id); if (!m) return;
      showMenu({ x: e.clientX, y: e.clientY }, [{ label: 'Rename…', icon: 'edit', run: () => markerName(m) }, { label: 'Move to playhead', run: () => core.editMarker(m.id, { f: state.frame }, 'Move marker') }, { separator: true }, { label: 'Delete marker', icon: 'delete', run: () => core.removeMarker(m.id) }]);
    } else if (hit.role === 'ruler') showMenu({ x: e.clientX, y: e.clientY }, [{ label: 'Add section here', icon: 'flag', run: () => core.addSection(Math.round(frameAt(e.clientX))) }, { label: 'Add marker here', icon: 'bookmark', run: () => core.addMarker(Math.round(frameAt(e.clientX))) }]);
  });

  // long-press = right-click on touch
  let press = null;
  content.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; const target = e.target;
    press = setTimeout(() => { press = null; target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: t.clientX, clientY: t.clientY })); }, 550);
  }, { passive: true });
  for (const n of ['touchend', 'touchmove', 'touchcancel']) content.addEventListener(n, () => { clearTimeout(press); press = null; }, { passive: true });

  window.addEventListener('keydown', (e) => { if (e.key === 'Alt') altHeld = true; });
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') altHeld = false; });
  scroller.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSel(); e.preventDefault(); }
    else if (e.key === 'Escape') { selKeys.clear(); render(); }
  });

  scroller.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, clamp(frameAt(e.clientX), 0, total()));
  }, { passive: false });

  // pinch zoom on touch
  const pointers = new Map(); let pinch = null;
  scroller.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { pointers.set(e.pointerId, e.clientX); if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.abs(a - b), ppf }; drag = null; } } });
  scroller.addEventListener('pointermove', (e) => {
    if (!pinch || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e.clientX);
    const [a, b] = [...pointers.values()]; const d = Math.abs(a - b);
    if (d > 10) { fit = false; const centre = clamp(frameAt((a + b) / 2), 0, total()); const x0 = xOf(centre) - scroller.scrollLeft; ppf = clamp(pinch.ppf * (d / pinch.d), 0.05, 40); render(); scroller.scrollLeft = xOf(centre) - x0; }
  });
  const upPtr = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
  scroller.addEventListener('pointerup', upPtr); scroller.addEventListener('pointercancel', upPtr);

  new ResizeObserver(rafThrottle(() => {
    labelW = scroller.clientWidth < 520 ? 112 : 168;
    if (fit) render();
  })).observe(scroller);

  const rerender = rafThrottle(() => { if (!drag || drag.kind === 'kf' || drag.kind.startsWith('bar') || drag.kind.startsWith('sec-') || drag.kind.startsWith('scene')) render(); });
  on('project', rerender); on('selection', rerender); on('engine', rerender);
  on('frame', rafThrottle(placePlayhead));
  render();
  return { element, title: 'Timeline' };
}
