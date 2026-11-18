// Preview panel: the canvas, a selection outline with direct manipulation, and transport.

import * as core from '../../core.js';
import { state, on, fmtTime } from '../../core.js';
import { P } from '../../animation.js';
const P_ROT = P.rotation;
import { h, icon, iconBtn, btn, rafThrottle } from '../dom.js';
import { hitTest, itemQuad, itemCenter } from '../../interact.js';

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

  const play = iconBtn('play_arrow', 'Play / pause (Space)', () => core.togglePlay(), 'primary');
  const toStart = iconBtn('first_page', 'Go to start (Home)', () => { core.stop(); core.seek(0); });
  const back10 = iconBtn('replay_10', 'Back 10 seconds (J)', () => core.skip(-10));
  const prev = iconBtn('skip_previous', 'Previous frame (←)', () => core.seek(state.frame - 1));
  const next = iconBtn('skip_next', 'Next frame (→)', () => core.seek(state.frame + 1));
  const fwd10 = iconBtn('forward_10', 'Forward 10 seconds (L)', () => core.skip(10));
  const toEnd = iconBtn('last_page', 'Go to end (End)', () => { core.stop(); core.seek(core.totalFrames() - 1); });
  const loop = iconBtn('repeat', 'Loop', () => core.setLoop(!core.transport.loop));
  const speed = h('select.speed', { 'aria-label': 'Playback speed', title: 'Playback speed', onchange: () => core.setSpeed(Number(speed.value)) },
    ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => h('option', { value: v, selected: v === 1 }, `${v}×`)));
  const time = h('span.time', '0:00 / 0:00');
  const scrub = h('input.scrub', { type: 'range', min: 0, max: 0, value: 0, step: 1, 'aria-label': 'Playhead' });
  scrub.addEventListener('input', () => { core.seek(Number(scrub.value)); });
  const bar = h('div.transport', toStart, back10, prev, play, next, fwd10, toEnd, time, scrub, loop, speed);
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
    const q = itemQuad(it, cw, ch);
    const S = Math.max(cw, ch) / 90;   // handle size in canvas px
    const mk = (tag, attrs) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) el.setAttribute(k, attrs[k]); svg.append(el); return el; };
    if (it.asset.def.locked) return;
    q.forEach(([x, y], i) => mk('rect', { x: x - S / 2, y: y - S / 2, width: S, height: S, class: 'handle', 'data-h': 'scale', 'data-i': i }));
    const mid = [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2];
    const c = itemCenter(it, cw, ch);
    const dx = mid[0] - c[0]; const dy = mid[1] - c[1]; const dl = Math.hypot(dx, dy) || 1;
    const rx = mid[0] + (dx / dl) * S * 3; const ry = mid[1] + (dy / dl) * S * 3;
    mk('line', { x1: mid[0], y1: mid[1], x2: rx, y2: ry, class: 'handle-stem' });
    mk('circle', { cx: rx, cy: ry, r: S * 0.6, class: 'handle', 'data-h': 'rotate' });
  };

  const refresh = () => {
    const ready = !!state.renderer;
    empty.hidden = !!state.bridge || state.project.elements.length > 0;
    canvas.style.visibility = ready && empty.hidden ? 'visible' : 'hidden';
    const total = core.totalFrames();
    scrub.max = Math.max(0, total - 1);
    scrub.value = state.frame;
    for (const b of [play, prev, next, toStart, back10, fwd10, toEnd, loop, speed, scrub]) b.disabled = !ready;
    loop.classList.toggle('on', core.transport.loop);
    const fps = state.project.videoFps;
    time.textContent = `${fmtTime(state.frame / fps)} / ${fmtTime(total / fps)}`;
    play.replaceChildren(icon(state.playing ? 'pause' : 'play_arrow'));
  };
  on('frame', () => { refresh(); updateOverlay(); });
  on('engine', refresh); on('renderer', refresh); on('transport', refresh); on('project', refresh); on('selection', updateOverlay);

  // ---- direct manipulation ----
  const ptrs = new Map();
  let dragging = false;
  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
  };
  let hd = null;   // active handle drag
  stage.addEventListener('pointerdown', (e) => {
    if (!state.lastPlan) return;
    stage.setPointerCapture(e.pointerId);
    const kind = e.target?.dataset?.h;
    if (kind && state.selected) {
      const it = state.lastPlan.find((x) => x.asset.def.id === state.selected);
      if (it && state.renderer) {
        const c = itemCenter(it, state.renderer.width, state.renderer.height);
        const [px, py] = toCanvas(e);
        hd = { kind, c, last: Math.hypot(px - c[0], py - c[1]) || 1, rot0: it.props[P_ROT], a0: Math.atan2(py - c[1], px - c[0]) };
        e.preventDefault(); return;
      }
    }
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
    if (hd && state.selected) {
      const [px, py] = toCanvas(e);
      if (hd.kind === 'scale') {
        const d = Math.hypot(px - hd.c[0], py - hd.c[1]) || 1;
        core.nudgeLayer(state.selected, 0, 0, d / hd.last); hd.last = d;
      } else {
        let r = hd.rot0 + (Math.atan2(py - hd.c[1], px - hd.c[0]) - hd.a0);
        if (e.shiftKey) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
        core.setProperty(state.selected, 'rotation', r, 'Rotate layer', `rot:${state.selected}`);
      }
      return;
    }
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
  const up = (e) => { hd = null; ptrs.delete(e.pointerId); if (!ptrs.size) dragging = false; };
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
