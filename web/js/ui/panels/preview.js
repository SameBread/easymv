// Preview panel: the canvas, a selection outline with direct manipulation, and transport.

import * as core from '../../core.js';
import { state, on, fmtTime } from '../../core.js';
import { h, icon, iconBtn, btn, rafThrottle } from '../dom.js';
import { hitTest, itemQuad } from '../../interact.js';

export function createPreviewPanel(shell) {
  const canvas = h('canvas.view', { width: 1280, height: 720, 'aria-label': 'Video preview' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'sel');
  const stage = h('div.stage', canvas, svg);
  const frame = h('div.stage-wrap', stage);
  const empty = h('div.empty-state',
    icon('movie'),
    h('p', 'Choose a song to start previewing.'),
    h('div.row', btn('Choose song', () => shell.pickAudio(), { variant: 'filled', icon: 'music_note' }),
      btn('Quick start', () => shell.quickStart(), { variant: 'tonal', icon: 'bolt' })));
  frame.append(empty);

  const play = iconBtn('play_arrow', 'Play / pause (Space)', () => core.togglePlay(), 'primary');
  const prev = iconBtn('skip_previous', 'Previous frame (←)', () => core.seek(state.frame - 1));
  const next = iconBtn('skip_next', 'Next frame (→)', () => core.seek(state.frame + 1));
  const time = h('span.time', '0:00 / 0:00');
  const scrub = h('input.scrub', { type: 'range', min: 0, max: 0, value: 0, step: 1, 'aria-label': 'Playhead' });
  scrub.addEventListener('input', () => { if (state.playing) core.stop(); core.seek(Number(scrub.value)); });
  const bar = h('div.transport', prev, play, next, time, scrub);
  const element = h('div.panel-preview', frame, bar);

  core.attachCanvas(canvas);

  // fit the canvas inside the available area, keeping the project's aspect ratio
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

  const updateOverlay = () => {
    svg.replaceChildren();
    if (!state.selected || !state.lastPlan || !state.renderer) return;
    const it = state.lastPlan.find((x) => x.asset.def.id === state.selected);
    if (!it) return;
    const { width: cw, height: ch } = state.renderer;
    svg.setAttribute('viewBox', `0 0 ${cw} ${ch}`);
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', itemQuad(it, cw, ch).map((q) => q.join(',')).join(' '));
    svg.append(poly);
  };

  const refresh = () => {
    const ready = !!state.bridge;
    empty.hidden = ready;
    canvas.style.visibility = ready ? 'visible' : 'hidden';
    const total = core.totalFrames();
    scrub.max = Math.max(0, total - 1);
    scrub.value = state.frame;
    scrub.disabled = !ready;
    for (const b of [play, prev, next]) b.disabled = !ready;
    const fps = state.project.videoFps;
    time.textContent = ready ? `${fmtTime(state.frame / fps)} / ${fmtTime(total / fps)}` : '0:00 / 0:00';
    play.replaceChildren(icon(state.playing ? 'pause' : 'play_arrow'));
  };
  on('frame', () => { refresh(); updateOverlay(); });
  on('engine', refresh); on('transport', refresh); on('project', refresh); on('selection', updateOverlay);

  // ---- direct manipulation ----
  const ptrs = new Map();
  let dragging = false;
  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
  };
  stage.addEventListener('pointerdown', (e) => {
    if (!state.lastPlan) return;
    stage.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) {
      const [x, y] = toCanvas(e);
      const hit = hitTest(state.lastPlan, x, y, canvas.width, canvas.height);
      if (hit) {
        core.select(hit.asset.def.id);
        dragging = !hit.asset.def.locked;
        const id = hit.asset.def.id;
        if (core.connectionsFor(id).some((c) => c.combine === 'replace' && (c.property === 'positionX' || c.property === 'positionY'))) {
          core.toast("Position is driven by a 'Set' connection here, so dragging won't visibly move it.", 4000);
        }
      } else { core.select(null); dragging = false; }
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const prevPt = ptrs.get(e.pointerId);
    if (!prevPt || !state.selected) return;
    const r = canvas.getBoundingClientRect();
    if (ptrs.size === 1 && dragging) core.nudgeLayer(state.selected, (e.clientX - prevPt.x) / r.width, (e.clientY - prevPt.y) / r.height);
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.entries()];
      const other = a[0] === e.pointerId ? b[1] : a[1];
      const before = Math.hypot(prevPt.x - other.x, prevPt.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 0) core.nudgeLayer(state.selected, 0, 0, after / before);
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (!ptrs.size) dragging = false; };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => {
    if (!state.selected) return;
    e.preventDefault();
    core.nudgeLayer(state.selected, 0, 0, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  refresh(); fit();
  return { element, title: 'Preview' };
}
