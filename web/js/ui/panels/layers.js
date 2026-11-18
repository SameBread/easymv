// Layers panel: Clip Studio Paint style stack. Top = front. Drag the handle to reorder,
// eye = visible by default, lock = protect from preview dragging, click = select.

import * as core from '../../core.js';
import { state, on, layerName, LAYER_TYPE_INFO } from '../../core.js';
import { h, icon, iconBtn, clear, showMenu, rafThrottle } from '../dom.js';

const thumbCache = new Map();

async function makeThumb(asset) {
  const def = asset.def;
  const c = document.createElement('canvas'); c.width = 40; c.height = 40;
  const g = c.getContext('2d');
  const draw = (src, sw, sh, sx = 0, sy = 0) => {
    const s = Math.min(40 / sw, 40 / sh);
    g.drawImage(src, sx, sy, sw, sh, (40 - sw * s) / 2, (40 - sh * s) / 2, sw * s, sh * s);
  };
  try {
    if (def.type === 'static') { const b = await createImageBitmap(asset.file); draw(b, b.width, b.height); b.close(); }
    else if (def.type === 'spriteSheet') { const b = await createImageBitmap(asset.file); draw(b, def.frameWidth, def.frameHeight, 0, 0); b.close(); }
    else if (def.type === 'frameSequence') { const [b] = await asset.thumbnails(40); draw(b, b.width, b.height); b.close(); }
    else if (def.type === 'gif') {
      const data = asset.decoder?.frame_rgba(0);
      if (data) { const id = new ImageData(new Uint8ClampedArray(data), asset.width, asset.height); const t = document.createElement('canvas'); t.width = asset.width; t.height = asset.height; t.getContext('2d').putImageData(id, 0, 0); draw(t, t.width, t.height); }
    }
  } catch { /* leave blank */ }
  return c;
}

function thumb(def, asset) {
  const holder = h('span.thumb');
  if (!asset || !['static', 'spriteSheet', 'gif', 'frameSequence'].includes(def.type)) {
    holder.append(icon(LAYER_TYPE_INFO[def.type]?.icon ?? 'image'));
    holder.classList.add(`kind-${def.type}`);
    return holder;
  }
  const key = JSON.stringify([def.id, def.path, def.zipPath, def.frameWidth, def.frameHeight]);
  if (!thumbCache.has(key)) thumbCache.set(key, makeThumb(asset));
  thumbCache.get(key).then((c) => { const k = c.cloneNode(); k.getContext('2d').drawImage(c, 0, 0); if (holder.isConnected || true) holder.append(k); });
  return holder;
}

export function createLayersPanel(shell) {
  const list = h('div.layer-list', { role: 'listbox', 'aria-label': 'Layers' });
  const addBtn = iconBtn('add', 'Add layer', (e) => shell.showAddMenu(e.currentTarget));
  const dupBtn = iconBtn('content_copy', 'Duplicate layer', () => state.selected && core.duplicateLayer(state.selected));
  const upBtn = iconBtn('arrow_upward', 'Bring forward', () => nudgeOrder(+1));
  const downBtn = iconBtn('arrow_downward', 'Send backward', () => nudgeOrder(-1));
  const delBtn = iconBtn('delete', 'Delete layer (Del)', () => state.selected && core.removeLayers([state.selected]));
  const head = h('div.panel-toolbar', addBtn, h('span.grow'), upBtn, downBtn, dupBtn, delBtn);
  const element = h('div.panel-layers', head, list);

  const nudgeOrder = (d) => { if (state.selected) core.reorderLayer(state.selected, core.layerIndex(state.selected) + d); };

  const render = () => {
    clear(list);
    const els = state.project.elements;
    const hasSel = !!state.selected;
    for (const b of [dupBtn, upBtn, downBtn, delBtn]) b.disabled = !hasSel;
    if (!els.length) {
      list.append(h('div.empty-note', 'No layers yet.', h('br'), h('button.btn.tonal', { type: 'button', onclick: (e) => shell.showAddMenu(e.currentTarget) }, icon('add'), 'Add a layer')));
      return;
    }
    const n = els.length;
    for (let d = 0; d < n; d++) {
      const i = n - 1 - d;
      const def = els[i];
      const hasVisTrack = !!core.trackOf(def.id, 'visible');
      const visible = (def.base?.visible ?? 1) >= 0.5;
      const conns = core.connectionsFor(def.id).filter((c) => !c.muted).length;
      const keys = state.project.tracks.filter((t) => t.element === def.id && t.property !== 'visible').length;
      const row = h('div.layer-row', {
        role: 'option', 'aria-selected': String(state.selected === def.id), tabIndex: 0,
        class: `${state.selected === def.id ? 'selected' : ''} ${visible || hasVisTrack ? '' : 'off'}`,
        dataset: { id: def.id },
        onclick: () => core.select(def.id),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); core.select(def.id); } },
        oncontextmenu: (e) => { e.preventDefault(); core.select(def.id); shell.showLayerMenu({ x: e.clientX, y: e.clientY }, def.id); },
      },
      h('span.handle', { title: 'Drag to reorder', onpointerdown: (e) => startDrag(e, def.id) }, icon('drag_indicator')),
      thumb(def, state.assets[i]),
      h('span.lname', h('span.lname-text', layerName(def)), h('span.lsub', LAYER_TYPE_INFO[def.type]?.label ?? def.type)),
      def._error ? h('span.badge.err', { title: def._error }, icon('close')) : null,
      conns ? h('span.badge', { title: `${conns} sound connection${conns > 1 ? 's' : ''}` }, icon('graphic_eq'), conns) : null,
      keys ? h('span.badge', { title: `${keys} keyframed propert${keys > 1 ? 'ies' : 'y'}` }, icon('diamond'), keys) : null,
      h('button.icon-btn.sm', {
        type: 'button', title: hasVisTrack ? 'Visibility is keyframed (edit it in the timeline)' : 'Show / hide', 'aria-label': 'Toggle visibility', disabled: hasVisTrack,
        onclick: (e) => { e.stopPropagation(); core.setProperty(def.id, 'visible', visible ? 0 : 1, visible ? 'Hide layer' : 'Show layer'); },
      }, icon(visible || hasVisTrack ? 'visibility' : 'visibility_off')),
      h('button.icon-btn.sm', {
        type: 'button', title: def.locked ? 'Unlock' : 'Lock (protect from dragging in the preview)', 'aria-label': 'Toggle lock',
        onclick: (e) => { e.stopPropagation(); core.updateLayer(def.id, { locked: !def.locked }, def.locked ? 'Unlock layer' : 'Lock layer'); },
      }, icon(def.locked ? 'lock' : 'lock_open')));
      list.append(row);
    }
  };

  // ---- pointer-based reordering (works with touch as well as mouse) ----
  function startDrag(e, id) {
    e.preventDefault(); e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const rows = [...list.querySelectorAll('.layer-row')];
    const from = rows.findIndex((r) => r.dataset.id === id);
    const line = h('div.drop-line');
    list.append(line);
    rows[from]?.classList.add('dragging');
    let target = from;
    const move = (ev) => {
      let k = rows.length;
      for (let r = 0; r < rows.length; r++) {
        const rc = rows[r].getBoundingClientRect();
        if (ev.clientY < rc.top + rc.height / 2) { k = r; break; }
      }
      target = k;
      const ref = rows[Math.min(k, rows.length - 1)].getBoundingClientRect();
      const lr = list.getBoundingClientRect();
      line.style.top = `${(k >= rows.length ? ref.bottom : ref.top) - lr.top - 1.5}px`;
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      line.remove();
      rows[from]?.classList.remove('dragging');
      const finalDisplayed = target > from ? target - 1 : target;
      if (finalDisplayed !== from) core.reorderLayer(id, rows.length - 1 - finalDisplayed);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    move(e);
  }

  const structure = () => JSON.stringify(state.project.elements.map((e) => [e.id, e.name, e.type, e.locked, e.base?.visible, e._error]))
    + state.project.connections.length + state.project.tracks.map((t) => `${t.element}.${t.property}`).join();
  let last = '';
  const refresh = rafThrottle(() => { const s = structure() + state.selected; if (s !== last) { last = s; render(); } });
  on('project', refresh); on('selection', refresh); on('engine', refresh); on('issues', refresh);
  render();
  return { element, title: 'Layers' };
}
