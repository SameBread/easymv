// Preview panel: tool bar (select / move / rotate / scale, editing on-off), the canvas with a selection outline,
// and a VLC-style transport. Editing can be switched off so nothing is drawn over the picture and nothing can be moved by accident.

import * as core from '../../core.js';
import { state, on, fmtTime } from '../../core.js';
import { P } from '../../animation.js';
import { h, icon, iconBtn, btn, rafThrottle } from '../dom.js';
import { hitTest, itemQuad, itemCenter } from '../../interact.js';
import { comboOf, prettyCombo } from '../../keymap.js';

const P_ROT = P.rotation;
const TOOLS = [
  ['select', 'near_me', 'Select (click, drag to move, handles to resize and rotate)', 'toolSelect'],
  ['move', 'open_with', 'Move (drag the selected layer)', 'toolMove'],
  ['rotate', 'rotate_right', 'Rotate (drag around the layer)', 'toolRotate'],
  ['scale', 'open_in_full', 'Scale (drag away from or toward the layer)', 'toolScale'],
];

export function createPreviewPanel(shell) {
  const canvas = h('canvas.view', { width: 1280, height: 720, 'aria-label': 'Video preview' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'sel-overlay');
  const stage = h('div.stage', canvas, svg);
  const frame = h('div.stage-wrap', stage);
  const empty = h('div.empty-state',
    icon('movie'),
    h('p', 'Choose a song to start previewing.'),
    h('div.row', btn('Choose song', () => shell.pickAudio(), { variant: 'filled', icon: 'music_note' }),
      btn('Quick start', () => shell.quickStart(), { variant: 'tonal', icon: 'bolt' })));
  frame.append(empty);

  // ---- tool bar ----
  const hint = (t, act) => `${t} (${prettyCombo(comboOf(act, state.prefs.keys))})`;
  const toolBtns = TOOLS.map(([id, ic, title, act]) => {
    const b = h('button.icon-btn.tool', { type: 'button', 'aria-label': title, 'aria-pressed': 'false', onclick: (e) => { core.setPreviewTool(id); e.currentTarget.blur(); } }, icon(ic));
    b.dataset.tool = id; b.dataset.act = act; b.dataset.title = title; return b;
  });
  const editBtn = h('button.icon-btn.tool.edit-toggle', { type: 'button', onclick: (e) => { core.setPreviewEdit(!state.prefs.previewEdit); e.currentTarget.blur(); } }, icon('edit'));
  const resetBtn = h('button.icon-btn.tool', { type: 'button', 'aria-label': 'Reset position, scale and rotation', onclick: (e) => { if (state.selected) core.resetTransform(state.selected); e.currentTarget.blur(); } }, icon('refresh'));
  const toolbar = h('div.pv-tools', { role: 'toolbar', 'aria-label': 'Preview tools' }, ...toolBtns, h('span.sep'), resetBtn, h('span.grow'), editBtn);
  const refreshTools = () => {
    const edit = state.prefs.previewEdit !== false; const tool = state.prefs.previewTool ?? 'select';
    for (const b of toolBtns) { const on_ = edit && b.dataset.tool === tool; b.classList.toggle('on', on_); b.setAttribute('aria-pressed', String(on_)); b.title = hint(b.dataset.title, b.dataset.act); }
    editBtn.classList.toggle('on', edit);
    editBtn.setAttribute('aria-pressed', String(edit));
    editBtn.title = hint(edit ? 'Editing on: click to hide outlines and lock the picture' : 'Editing off: click to edit layers in the preview', 'toggleEdit');
    editBtn.setAttribute('aria-label', edit ? 'Editing on' : 'Editing off');
    editBtn.replaceChildren(icon(edit ? 'edit' : 'lock'));
    resetBtn.title = hint('Reset position, scale and rotation of the selected layer', 'resetXform');
    stage.classList.toggle('no-edit', !edit);
    stage.dataset.tool = tool;
    updateOverlay();
  };

  // ---- transport (VLC-style). Buttons are built once and never re-created: replacing a button's content while a
  //      click is in progress would drop the click, which made the mouse unreliable during playback. ----
  const tb = (name, title, fn, cls = '') => iconBtn(name, title, (e) => { fn(); e.currentTarget.blur(); }, cls);
  const play = tb('play_arrow', 'Play / pause (Space)', () => core.togglePlay(), 'primary');
  const toStart = tb('first_page', 'Go to start (Home)', () => { core.stop(); core.seek(0); });
  const back10 = tb('replay_10', 'Back 10 seconds (J)', () => core.skip(-10));
  const prev = tb('chevron_left', 'Previous frame (←)', () => core.seek(state.frame - 1));
  const next = tb('chevron_right', 'Next frame (→)', () => core.seek(state.frame + 1));
  const fwd10 = tb('forward_10', 'Forward 10 seconds (L)', () => core.skip(10));
  const toEnd = tb('last_page', 'Go to end (End)', () => { core.stop(); core.seek(core.totalFrames() - 1); });
  const loop = tb('repeat', 'Loop (Shift+L)', () => core.setLoop(!core.transport.loop));
  const playIcons = { play: icon('play_arrow'), pause: icon('pause') };
  play.replaceChildren(playIcons.play);
  const speed = h('select.speed', { 'aria-label': 'Playback speed', title: 'Playback speed', onchange: () => { core.setSpeed(Number(speed.value)); speed.blur(); } },
    ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => h('option', { value: v, selected: v === 1 }, `${v}×`)));
  const time = h('span.time', '0:00 / 0:00');
  const scrub = h('input.scrub', { type: 'range', min: 0, max: 0, value: 0, step: 1, 'aria-label': 'Playhead' });
  scrub.addEventListener('input', () => { core.seek(Number(scrub.value)); });
  const bar = h('div.transport', toStart, back10, prev, play, next, fwd10, toEnd, time, scrub, loop, speed);
  const element = h('div.panel-preview', toolbar, frame, bar);

  core.attachCanvas(canvas);

  const fit = rafThrottle(() => {
    const [w, hh] = state.project.resolution;
    const r = frame.getBoundingClientRect();
    const s = Math.min(r.width / w, r.height / hh);
    stage.style.width = `${Math.max(40, Math.floor(w * s))}px`;
    stage.style.height = `${Math.max(40, Math.floor(hh * s))}px`;
  });
  new ResizeObserver(fit).observe(frame);
  on('project', fit);
  on('renderer', fit);

  const svgEl = (tag, attrs) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) el.setAttribute(k, attrs[k]); svg.append(el); return el; };
  function updateOverlay() {
    svg.replaceChildren();
    if (state.prefs.previewEdit === false || !state.selected || !state.lastPlan || !state.renderer) return;
    const it = state.lastPlan.find((x) => x.asset.def.id === state.selected);
    if (!it) return;
    const { width: cw, height: ch } = state.renderer;
    svg.setAttribute('viewBox', `0 0 ${cw} ${ch}`);
    const q = itemQuad(it, cw, ch);
    svgEl('polygon', { points: q.map((p) => p.join(',')).join(' ') });
    if (it.asset.def.locked) return;
    const tool = state.prefs.previewTool ?? 'select';
    const S = Math.max(cw, ch) / 90;
    const c = itemCenter(it, cw, ch);
    if (tool !== 'select') {   // a small cross marks the pivot for the other tools
      svgEl('line', { x1: c[0] - S, y1: c[1], x2: c[0] + S, y2: c[1], class: 'handle-stem' });
      svgEl('line', { x1: c[0], y1: c[1] - S, x2: c[0], y2: c[1] + S, class: 'handle-stem' });
      return;
    }
    q.forEach(([x, y], i) => svgEl('rect', { x: x - S / 2, y: y - S / 2, width: S, height: S, class: 'handle', 'data-h': 'scale', 'data-i': i }));
    const mid = [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2];
    const dx = mid[0] - c[0]; const dy = mid[1] - c[1]; const dl = Math.hypot(dx, dy) || 1;
    const rx = mid[0] + (dx / dl) * S * 3; const ry = mid[1] + (dy / dl) * S * 3;
    svgEl('line', { x1: mid[0], y1: mid[1], x2: rx, y2: ry, class: 'handle-stem' });
    svgEl('circle', { cx: rx, cy: ry, r: S * 0.6, class: 'handle', 'data-h': 'rotate' });
  }

  let lastShown = '';
  const refresh = () => {
    const ready = !!state.renderer;
    empty.hidden = !!state.bridge || state.project.elements.length > 0;
    canvas.style.visibility = ready && empty.hidden ? 'visible' : 'hidden';
    const total = core.totalFrames();
    if (scrub.max !== String(Math.max(0, total - 1))) scrub.max = Math.max(0, total - 1);
    if (scrub.value !== String(state.frame)) scrub.value = state.frame;
    const fps = state.project.videoFps;
    const txt = `${fmtTime(state.frame / fps)} / ${fmtTime(total / fps)}`;
    if (txt !== time.textContent) time.textContent = txt;
    // only touch the buttons when their state really changed
    const sig = `${state.playing}|${core.transport.loop}`;
    if (sig !== lastShown) {
      lastShown = sig;
      play.replaceChildren(state.playing ? playIcons.pause : playIcons.play);
      play.setAttribute('aria-pressed', String(state.playing));
      loop.classList.toggle('on', core.transport.loop);
    }
  };
  on('frame', () => { refresh(); updateOverlay(); });
  on('engine', refresh); on('transport', refresh); on('project', refresh); on('renderer', refresh); on('selection', updateOverlay);
  on('prefs', refreshTools);

  // ---- direct manipulation ----
  const ptrs = new Map();
  let drag = null;   // { kind: 'move'|'scale'|'rotate', c, last, a0, rot0 }
  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
  };
  const selectedItem = () => state.lastPlan?.find((x) => x.asset.def.id === state.selected);
  const editing = () => state.prefs.previewEdit !== false;

  stage.addEventListener('pointerdown', (e) => {
    if (!editing() || !state.lastPlan || e.button !== 0 && e.pointerType === 'mouse') return;
    stage.setPointerCapture(e.pointerId);
    const tool = state.prefs.previewTool ?? 'select';
    const [px, py] = toCanvas(e);
    const kind = e.target?.dataset?.h;
    if (kind && state.selected) {            // grabbed a handle
      const it = selectedItem();
      if (it && state.renderer) {
        const c = itemCenter(it, state.renderer.width, state.renderer.height);
        drag = { kind, c, last: Math.hypot(px - c[0], py - c[1]) || 1, rot0: it.props[P_ROT], a0: Math.atan2(py - c[1], px - c[0]) };
        e.preventDefault(); return;
      }
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size !== 1) { drag = null; return; }
    const hit = hitTest(state.lastPlan, px, py, canvas.width, canvas.height);
    if (hit) core.select(hit.asset.def.id);
    else if (!hit && tool === 'select') core.select(null);
    const it = selectedItem();
    if (!it || it.asset.def.locked) { drag = null; return; }
    const id = it.asset.def.id;
    if (tool === 'rotate' || tool === 'scale') {
      const c = itemCenter(it, state.renderer.width, state.renderer.height);
      drag = { kind: tool, c, last: Math.hypot(px - c[0], py - c[1]) || 1, rot0: it.props[P_ROT], a0: Math.atan2(py - c[1], px - c[0]) };
    } else if (hit) {
      drag = { kind: 'move' };
      if (core.connectionsFor(id).some((c) => c.combine === 'replace' && (c.property === 'positionX' || c.property === 'positionY'))) {
        core.toast("Position is driven by a 'Set' connection here, so dragging won't visibly move it.", 4000);
      }
    } else if (tool === 'move') drag = { kind: 'move' };   // Godot-style: the move tool drags the selection from anywhere
    else drag = null;
  });
  stage.addEventListener('pointermove', (e) => {
    if (!editing() || !state.selected) return;
    const [px, py] = toCanvas(e);
    if (drag && drag.kind !== 'move') {
      if (drag.kind === 'scale') {
        const d = Math.hypot(px - drag.c[0], py - drag.c[1]) || 1;
        core.nudgeLayer(state.selected, 0, 0, d / drag.last); drag.last = d;
      } else {
        let r = drag.rot0 + (Math.atan2(py - drag.c[1], px - drag.c[0]) - drag.a0);
        if (e.shiftKey) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
        core.setProperty(state.selected, 'rotation', r, 'Rotate layer', `rot:${state.selected}`);
      }
      return;
    }
    const prevPt = ptrs.get(e.pointerId);
    if (!prevPt) return;
    const r = canvas.getBoundingClientRect();
    if (ptrs.size === 1 && drag?.kind === 'move') core.nudgeLayer(state.selected, (e.clientX - prevPt.x) / r.width, (e.clientY - prevPt.y) / r.height);
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.entries()];
      const other = a[0] === e.pointerId ? b[1] : a[1];
      const before = Math.hypot(prevPt.x - other.x, prevPt.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 0) core.nudgeLayer(state.selected, 0, 0, after / before);
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  const up = (e) => { drag = null; ptrs.delete(e.pointerId); };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => {
    if (!editing() || !state.selected) return;
    e.preventDefault();
    core.nudgeLayer(state.selected, 0, 0, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  refresh(); refreshTools(); fit();
  return { element, title: 'Preview' };
}
