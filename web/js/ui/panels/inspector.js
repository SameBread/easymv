// Inspector: everything about the selected layer in one place. Sound connections and
// keyframes are shown ON the property they affect, so it is always clear what belongs to what.

import * as core from '../../core.js';
import { state, on, layerName, LAYER_TYPE_INFO, sources } from '../../core.js';
import { h, icon, iconBtn, clear, numField, selectField, colorField, toggle, showMenu, rafThrottle } from '../dom.js';
import { propsFor, PROP_BY_NAME, toUi, fromUi, fmtValue, FEATURES, FEATURE_LABELS, CURVES, COMBINES } from '../../props.js';
import { MODES } from '../../timeline.js';
import { valueAtFrame } from '../../meters.js';
import { VIS_MODES, VIS_DEFAULTS } from '../../visualizer.js';
import { SHAPES, SHAPE_IDS } from '../../shapes.js';
import { FX_KINDS, FX_IDS, fxSettings } from '../../effects.js';
import { visSettings } from '../../visualizer.js';

const curveFn = {
  linear: (x) => x, easeIn: (x) => x * x, easeOut: (x) => 1 - (1 - x) * (1 - x),
  smoothstep: (x) => x * x * (3 - 2 * x),
};
const applyCurve = (c, x) => (c.curve === 'threshold' ? (x >= (c.threshold ?? 0.5) ? 1 : 0) : (curveFn[c.curve] ?? curveFn.linear)(x));

export function createInspectorPanel(shell) {
  const element = h('div.panel-inspector');
  const expanded = new Set();     // "prop#i" keys of open connection editors
  let showAdvanced = false;
  let live = [];                  // refs updated every frame
  let lastSig = '';

  const sigOf = () => {
    const def = state.selected && core.layerById(state.selected);
    if (!def) return 'none';
    return JSON.stringify([
      def.id, def.type, def.fx?.kind, def.background, def._error, core.layerIndex(def.id), state.project.elements.length,
      state.project.connections.filter((c) => c.element === def.id).map((c) => [c.property, c.source, c.feature, c.curve, c.combine, !!c.muted]),
      state.project.tracks.filter((t) => t.element === def.id).map((t) => [t.property, t.mode, t.keys.length]),
      sources(), showAdvanced, [...expanded], def.vis?.mode, def.vis?.shape, def.vis?.gradient, def.visualBlend,
    ]);
  };

  // ---------- small builders ----------

  const section = (title, iconName, ...body) =>
    h('details.sect', { open: true }, h('summary', icon(iconName), h('span', title), icon('expand_more', 'chev')), h('div.sect-body', body));

  const bindNum = (def, path, opts) => {
    const get = () => path.split('.').reduce((o, k) => o?.[k], def);
    const mul = opts.mul ?? 1;
    const f = numField({
      ...opts, value: (get() ?? opts.def ?? 0) * mul, min: (opts.min ?? -Infinity) * mul, max: (opts.max ?? Infinity) * mul,
      step: (opts.step ?? 1),
      onChange: (v) => core.updateLayer(def.id, { [path]: v / mul }, `Edit ${opts.label}`, `edit:${def.id}:${path}`),
    });
    return f.el;
  };
  const bindSel = (def, path, opts) => {
    const get = path.split('.').reduce((o, k) => o?.[k], def);
    return selectField({ ...opts, value: get ?? opts.def, onChange: (v) => core.updateLayer(def.id, { [path]: v }, `Edit ${opts.label}`) }).el;
  };
  const bindColor = (def, path, label) => {
    const get = path.split('.').reduce((o, k) => o?.[k], def);
    return colorField({ label, value: get, onChange: (v, final) => core.updateLayer(def.id, { [path]: v }, `Edit ${label}`, `edit:${def.id}:${path}`) }).el;
  };
  const bindToggle = (def, path, label, title) => {
    const get = path.split('.').reduce((o, k) => o?.[k], def);
    return toggle({ label, value: get, title, onChange: (v) => core.updateLayer(def.id, { [path]: v }, `Edit ${label}`) }).el;
  };
  const grid = (...kids) => h('div.fgrid', kids);

  // ---------- header ----------

  function headerSection(def) {
    const n = state.project.elements.length;
    const nameInput = h('input.name-input', { value: layerName(def), 'aria-label': 'Layer name', onchange: (e) => core.updateLayer(def.id, { name: e.target.value || undefined }, 'Rename layer') });
    const order = numField({
      label: 'Order', value: core.layerIndex(def.id) + 1, min: 1, max: n, step: 1,
      title: 'Stacking position: 1 is the back, ' + n + ' is the front. Type a number to jump there.',
      onChange: (v, final) => { if (final) core.setOrder(def.id, Math.round(v)); },
    });
    const kids = [
      h('div.layer-title', h('span.kind-chip', icon(LAYER_TYPE_INFO[def.type]?.icon ?? 'image'), LAYER_TYPE_INFO[def.type]?.label ?? def.type), nameInput),
      grid(order.el, bindSel(def, 'visualBlend', { label: 'Blend', options: [['normal', 'Normal'], ['add', 'Add (glow)'], ['multiply', 'Multiply']], def: 'normal', title: 'How this layer mixes with what is behind it' })),
    ];
    if (def.type === 'static' || def.type === 'gif' || def.type === 'frameSequence' || def.type === 'spriteSheet') {
      kids.push(bindToggle(def, 'background', 'Background layer', 'Automatic mode treats backgrounds differently (soft blur instead of beat pulses)'));
    }
    if (def._error) kids.push(h('div.note.err', def._error));
    return h('div.sect-flat', kids);
  }

  // ---------- type specific ----------

  function imageSection(def, asset) {
    const kids = [];
    if (def.type === 'static') {
      kids.push(selectField({
        label: 'Treat as', value: 'static', options: [['static', 'Static image'], ['spriteSheet', 'Sprite sheet']],
        onChange: (v) => {
          const patch = { type: v };
          if (v === 'spriteSheet') Object.assign(patch, { frameWidth: 64, frameHeight: 64, columns: 4, rows: 4, frameCount: 16, internalFps: 12, padding: 0, loopMode: 'loop', interpolate: false });
          core.updateLayer(def.id, patch, `Treat ${layerName(def)} as ${v}`, null, { assets: true });
        },
      }).el);
    }
    if (def.type === 'spriteSheet') {
      kids.push(grid(
        bindNum(def, 'frameWidth', { label: 'Frame W', step: 1, min: 1 }), bindNum(def, 'frameHeight', { label: 'Frame H', step: 1, min: 1 }),
        bindNum(def, 'columns', { label: 'Columns', step: 1, min: 1 }), bindNum(def, 'rows', { label: 'Rows', step: 1, min: 1 }),
        bindNum(def, 'frameCount', { label: 'Frames', step: 1, min: 1 }), bindNum(def, 'padding', { label: 'Padding', step: 1, min: 0, suffix: 'px' })));
    }
    if (def.type === 'spriteSheet' || def.type === 'frameSequence') kids.push(bindNum(def, 'internalFps', { label: 'Animation fps', step: 0.5, min: 0.5, max: 120 }));
    if (def.type !== 'static') kids.push(bindSel(def, 'loopMode', { label: 'Loop', options: [['loop', 'Loop'], ['once', 'Once'], ['pingPong', 'Ping-pong']], def: 'loop' }));
    kids.push(bindSel(def, 'fit', { label: 'Fit', options: ['cover', 'contain', 'natural'], def: def.type === 'static' ? 'cover' : 'natural' }));
    if (def.type === 'spriteSheet') kids.push(bindSel(def, 'filter', { label: 'Filter', options: ['linear', 'nearest'], def: 'linear' }));
    if (def.type === 'spriteSheet' || def.type === 'frameSequence') {
      kids.push(bindToggle(def, 'interpolate', 'Crossfade frames'));
      if (def.interpolate) kids.push(h('div.note.warn', 'Crossfading hand-drawn frames can produce ghosting.'));
    }
    if (def.type === 'frameSequence' && asset) {
      kids.push(h('div.row', h('button.btn.tonal', { type: 'button', onclick: () => shell.openReorder(def.id) }, icon('swap_vert'), 'Reorder frames…'),
        h('span.muted', `${asset.frameCount} frames, ${asset.width}×${asset.height}${def.frameOrder ? ' (custom order)' : ''}`)));
    }
    return section('Image', 'image', kids);
  }

  function shapePicker(def, vis) {
    const wrap = h('div.chips', { role: 'radiogroup', 'aria-label': 'Wrap around shape' });
    for (const id of SHAPE_IDS) {
      wrap.append(h('button.chip.shape', { type: 'button', role: 'radio', 'aria-checked': String(vis.shape === id), class: vis.shape === id ? 'on' : '', title: SHAPES[id].label,
        onclick: () => core.updateLayer(def.id, { 'vis.shape': id }, `Shape: ${SHAPES[id].label}`) }, icon(SHAPES[id].icon), h('span', SHAPES[id].label)));
    }
    return wrap;
  }

  function visualizerSection(def) {
    const vis = visSettings(def);
    const modes = h('div.chips', { role: 'radiogroup', 'aria-label': 'Style' });
    for (const [id, m] of Object.entries(VIS_MODES)) {
      modes.append(h('button.chip', { type: 'button', role: 'radio', 'aria-checked': String(vis.mode === id), class: vis.mode === id ? 'on' : '',
        onclick: () => core.updateLayer(def.id, { 'vis.mode': id }, `Style: ${m.label}`) }, icon(m.icon), h('span', m.label)));
    }
    const srcOpts = sources().map((s) => [s, s === 'master' ? 'Master mix' : s]);
    return section('Visualizer', 'graphic_eq',
      h('div.fld-label', 'Wrap around'), shapePicker(def, vis),
      h('div.fld-label', 'Style'), modes,
      grid(
        selectField({ label: 'Sound source', value: vis.source, options: srcOpts, onChange: (v) => core.updateLayer(def.id, { 'vis.source': v }, 'Change visualizer source') }).el,
        bindNum(def, 'vis.count', { label: 'Count', step: 1, min: 3, max: 512, def: VIS_DEFAULTS.count }),
        bindNum(def, 'vis.radius', { label: 'Size', step: 0.005, min: 0.02, max: 1, mul: 100, suffix: '%', def: VIS_DEFAULTS.radius }),
        bindNum(def, 'vis.length', { label: 'Height', step: 0.005, min: 0.01, max: 1, mul: 100, suffix: '%', def: VIS_DEFAULTS.length }),
        vis.mode === 'wave' ? bindNum(def, 'vis.line', { label: 'Line', step: 0.0005, min: 0.001, max: 0.05, mul: 1000, suffix: '‰', def: VIS_DEFAULTS.line })
          : bindNum(def, 'vis.fill', { label: 'Bar width', step: 0.01, min: 0.05, max: 1, mul: 100, suffix: '%', def: VIS_DEFAULTS.fill }),
        bindNum(def, 'vis.spin', { label: 'Spin', step: 1, min: -360, max: 360, suffix: '°/s', def: 0 }),
        bindNum(def, 'vis.release', { label: 'Fall time', step: 5, min: 0, max: 1500, suffix: 'ms', def: VIS_DEFAULTS.release }),
        bindNum(def, 'vis.gain', { label: 'Gain', step: 0.01, min: 0.1, max: 4, mul: 100, suffix: '%', def: 1 })),
      grid(bindColor(def, 'vis.color1', 'Color A'), bindColor(def, 'vis.color2', 'Color B'),
        bindSel(def, 'vis.gradient', { label: 'Color by', options: [['position', 'Position'], ['amp', 'Loudness'], ['solid', 'Solid (A)']], def: 'position' })),
      h('div.toggles', bindToggle(def, 'vis.mirror', 'Mirror', 'Symmetric layout so closed shapes join up'),
        bindToggle(def, 'vis.reverse', 'Flip low/high'), bindToggle(def, 'vis.both', 'Both sides')),
      h('div.note', 'Tip: ' + (vis.mode === 'wave' ? 'the waveform follows the actual audio signal.' : 'bars follow the frequency spectrum, bass at the start of the shape.')));
  }

  function effectSection(def) {
    const fx = fxSettings(def);
    const kinds = h('div.chips', { role: 'radiogroup' });
    for (const id of FX_IDS) {
      kinds.append(h('button.chip', { type: 'button', role: 'radio', 'aria-checked': String(fx.kind === id), class: fx.kind === id ? 'on' : '',
        onclick: () => {
          const d = FX_KINDS[id].defaults;
          core.updateLayer(def.id, { 'fx.kind': id, 'fx.area': d.area, 'fx.c1': d.c1, 'fx.c2': d.c2, 'fx.size': d.size, 'fx.count': d.count, 'fx.pixel': d.pixel ?? 0, visualBlend: d.blend, name: layerName(def) === FX_KINDS[fx.kind].label ? FX_KINDS[id].label : def.name }, `Effect: ${FX_KINDS[id].label}`);
        } }, icon(FX_KINDS[id].icon), h('span', FX_KINDS[id].label)));
    }
    const fire = fx.kind === 'pixelFire';
    return section('Effect', 'auto_awesome',
      kinds,
      grid(
        fire ? null : bindNum(def, 'fx.count', { label: 'Particles', step: 5, min: 1, max: 4000, def: fx.count }),
        bindNum(def, 'fx.size', { label: fire ? 'Pixel size' : 'Size', step: 0.5, min: 1, max: 200, def: fx.size }),
        bindNum(def, 'fx.speed', { label: 'Speed', step: 0.01, min: 0, max: 5, mul: 100, suffix: '%', def: fx.speed }),
        bindNum(def, 'fx.wind', { label: 'Wind', step: 0.01, min: -1, max: 1, mul: 100, suffix: '%', def: fx.wind }),
        bindNum(def, 'fx.area.0', { label: 'Width', step: 0.01, min: 0.05, max: 2, mul: 100, suffix: '%', def: fx.area[0] }),
        bindNum(def, 'fx.area.1', { label: 'Height', step: 0.01, min: 0.05, max: 2, mul: 100, suffix: '%', def: fx.area[1] }),
        bindNum(def, 'fx.seed', { label: 'Random seed', step: 1, min: 0, max: 9999, def: fx.seed })),
      grid(bindColor(def, 'fx.c1', fire ? 'Hot color' : 'Color A'), bindColor(def, 'fx.c2', fire ? 'Cool color' : 'Color B')),
      fire ? null : grid(bindNum(def, 'fx.pixel', { label: 'Lo-fi pixels', step: 1, min: 0, max: 64, suffix: 'px', def: fx.pixel, title: '0 = smooth. Above 0 snaps particles to a pixel grid and a low frame rate for a retro look.' }),
        fx.pixel > 0 ? bindNum(def, 'fx.fps', { label: 'Lo-fi fps', step: 1, min: 1, max: 60, def: fx.fps }) : null),
      h('div.note', 'Effects are deterministic: the same frame always looks the same, so scrubbing and export match the preview.'));
  }

  function lyricsSection(def) {
    const n = def.lyrics?.lines?.length ?? 0;
    return section('Lyrics', 'lyrics',
      h('div.note', n ? `${n} line${n === 1 ? '' : 's'}. Edit text, timing and style in the Lyrics panel.` : 'No lines yet. Open the Lyrics panel to paste words and tap along to the song.'),
      h('div.row', h('button.btn.tonal', { type: 'button', onclick: () => shell.showPanel('lyrics') }, icon('lyrics'), 'Open Lyrics panel')));
  }

  // ---------- property rows ----------

  const feat = (f) => FEATURE_LABELS[f] ?? f;

  function propRow(def, info, rows) {
    const id = def.id; const prop = info.name;
    const track = core.trackOf(id, prop);
    const conns = core.connectionsFor(id, prop);
    const edit = core.editValue(id, prop);
    const wrap = h('div.prop', { dataset: { prop } });
    const keyBtn = h('button.icon-btn.sm.key', { type: 'button', title: 'Add or remove a keyframe at the playhead', 'aria-label': `Keyframe ${info.label}`,
      onclick: () => core.toggleKeyAtPlayhead(id, prop) }, icon('diamond'));
    const liveEl = h('span.live', { title: 'Value right now, including sound and keyframes' });
    let ctl;
    if (info.toggle) {
      const t = toggle({ label: info.label, value: edit >= 0.5, onChange: (v) => core.setProperty(id, prop, v ? 1 : 0, `${info.label}: ${v ? 'on' : 'off'}`) });
      ctl = t.el; rows.push({ id, prop, keyBtn, liveEl, setValue: (v) => { t.cb.checked = v >= 0.5; } });
    } else {
      const f = numField({
        label: info.label, value: toUi(info, edit), min: toUi(info, info.min), max: toUi(info, info.max), step: info.step, suffix: info.suffix,
        onChange: (v) => core.setProperty(id, prop, fromUi(info, v)),
      });
      ctl = f.el; rows.push({ id, prop, keyBtn, liveEl, setValue: (v) => f.set(toUi(info, v)) });
    }
    const linkBtn = h('button.icon-btn.sm.link', { type: 'button', title: `Link a sound to ${info.label}`, 'aria-label': `Link sound to ${info.label}`,
      onclick: (e) => showLinkMenu(e.currentTarget, id, prop) }, icon('link'));
    const top = h('div.prop-top', ctl, liveEl, keyBtn, linkBtn);
    wrap.append(top);
    if (track) wrap.append(trackEditor(track, info));
    conns.forEach((c, i) => wrap.append(connEditor(def, info, c, i)));

    // drop a feature from the Signals panel onto the row
    wrap.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-easymv-signal')) { e.preventDefault(); wrap.classList.add('drop'); } });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
    wrap.addEventListener('drop', (e) => {
      wrap.classList.remove('drop');
      const raw = e.dataTransfer.getData('application/x-easymv-signal'); if (!raw) return;
      e.preventDefault();
      const { source, feature } = JSON.parse(raw);
      const c = core.addConnection(id, prop, source, feature);
      expanded.add(`${prop}#${core.connectionsFor(id, prop).indexOf(c)}`);
      core.structural();
    });
    return wrap;
  }

  function showLinkMenu(anchor, id, prop) {
    const items = [{ header: `Link a sound to ${PROP_BY_NAME[prop].label}` }];
    for (const s of sources()) {
      items.push({ label: s === 'master' ? 'Master mix' : s, icon: 'music_note', submenu: FEATURES.map((f) => ({ label: feat(f), run: () => {
        const c = core.addConnection(id, prop, s, f);
        expanded.add(`${prop}#${core.connectionsFor(id, prop).indexOf(c)}`);
        core.structural();
      } })) });
    }
    if (!state.bridge) items.push({ separator: true }, { header: 'Analyze a song first to see live meters' });
    showMenu(anchor, items);
  }

  function trackEditor(track, info) {
    const isVis = track.property === 'visible';
    const parts = [h('span.tl-tag', icon('timeline'), `${track.keys.length} key${track.keys.length === 1 ? '' : 's'}`)];
    if (!isVis) {
      parts.push(selectField({ label: 'With sound', value: track.mode, options: Object.entries(MODES), onChange: (v) => core.setTrackMode(track.element, track.property, v),
        title: 'Override: the timeline replaces the sound. Blend: sound is added to / multiplied with the timeline. Mix: crossfade between the two.' }).el);
      if (track.mode === 'mix') parts.push(numField({ label: 'Mix', value: track.mix * 100, min: 0, max: 100, step: 1, suffix: '%', onChange: (v) => core.setTrackMode(track.element, track.property, 'mix', v / 100) }).el);
    } else parts.push(h('span.muted', 'Edit the visibility bar in the timeline'));
    parts.push(h('button.icon-btn.sm', { type: 'button', title: 'Remove all keyframes of this property', 'aria-label': 'Remove timeline',
      onclick: () => core.removeTrack(track.element, track.property) }, icon('close')));
    return h('div.track-row', parts);
  }

  function connEditor(def, info, c, i) {
    const key = `${info.name}#${i}`;
    const open = expanded.has(key);
    const meter = h('span.meter', h('span.meter-fill'));
    const chip = h('button.sig-chip', { type: 'button', class: `${c.muted ? 'muted' : ''} ${c.origin === 'auto' ? 'auto' : ''}`, 'aria-expanded': String(open), title: 'Edit this connection',
      onclick: () => { if (expanded.has(key)) expanded.delete(key); else expanded.add(key); core.structural(); } },
    icon('graphic_eq'), h('span.chip-text', `${c.source === 'master' ? '' : `${c.source} · `}${feat(c.feature)}`), c.origin === 'auto' ? h('span.tag', 'auto') : null, meter, icon(open ? 'expand_less' : 'expand_more', 'chev'));
    live.push({ meterFill: meter.firstChild, c });
    const box = h('div.conn-box', chip);
    if (!open) return box;

    const graph = h('canvas.curve', { width: 220, height: 90, 'aria-label': 'Mapping graph' });
    const ed = h('div.conn-edit');
    ed.append(graph);
    const refreshGraph = () => drawCurve(graph, c, info, state.bridge ? currentFeature(c) : null);
    live.push({ graph: refreshGraph });
    attachCurveDrag(graph, c, info, () => { refreshGraph(); });
    const upd = (patch, label) => { core.updateConnection(c, patch, label ?? 'Edit connection'); };
    ed.append(grid(
      selectField({ label: 'Source', value: c.source, options: sources().map((s) => [s, s === 'master' ? 'Master mix' : s]), onChange: (v) => upd({ source: v }) }).el,
      selectField({ label: 'Reacts to', value: c.feature, options: FEATURES.map((f) => [f, feat(f)]), onChange: (v) => upd({ feature: v }) }).el,
      numField({ label: 'At silence', value: toUi(info, c.outMin), step: info.step, suffix: info.suffix, onChange: (v) => { c.outMin = fromUi(info, v); core.updateConnection(c, {}, 'Edit connection', `conn:${key}`); refreshGraph(); } }).el,
      numField({ label: 'At loudest', value: toUi(info, c.outMax), step: info.step, suffix: info.suffix, onChange: (v) => { c.outMax = fromUi(info, v); core.updateConnection(c, {}, 'Edit connection', `conn:${key}`); refreshGraph(); } }).el,
      selectField({ label: 'Response', value: c.curve, options: CURVES.map((x) => [x, ({ linear: 'Linear', easeIn: 'Ease in', easeOut: 'Punchy (ease out)', smoothstep: 'Smooth', threshold: 'On/off threshold' })[x]]), onChange: (v) => upd({ curve: v }) }).el,
      selectField({ label: 'Combine', value: c.combine, options: Object.entries(COMBINES), onChange: (v) => upd({ combine: v }),
        title: 'Add: adds on top of the value. Multiply: scales it. Set: replaces it. Max/Min: keeps the larger/smaller.' }).el,
      c.curve === 'threshold' ? numField({ label: 'Threshold', value: (c.threshold ?? 0.5) * 100, min: 0, max: 100, step: 1, suffix: '%', onChange: (v) => { c.threshold = v / 100; core.updateConnection(c, {}, 'Edit connection', `conn:${key}`); refreshGraph(); } }).el : null));
    // one friendly smoothing slider (snappy .. floaty); attack and release are derived
    const sFromRelease = Math.max(0, Math.min(1, Math.log((c.releaseMs || 10) / 10) / Math.log(200)));
    const slider = h('input.slider', { type: 'range', min: 0, max: 1, step: 0.01, value: sFromRelease, 'aria-label': 'Smoothing: snappy to floaty' });
    slider.addEventListener('input', () => {
      const rel = Math.round(10 * 200 ** Number(slider.value));
      core.updateConnection(c, { releaseMs: rel, attackMs: Math.max(1, Math.min(150, Math.round(rel * 0.1))) }, 'Edit smoothing', `conn:${key}:smooth`);
    });
    ed.append(h('label.fld', h('span.fld-label', 'Smoothing'), h('div.slider-row', h('span.muted', 'snappy'), slider, h('span.muted', 'floaty'))));
    ed.append(h('div.row',
      toggle({ label: 'Mute', value: !!c.muted, title: 'Temporarily ignore this connection', onChange: (v) => core.updateConnection(c, { muted: v || undefined }, v ? 'Mute connection' : 'Unmute connection') }).el,
      h('span.grow'),
      h('button.btn.text.danger', { type: 'button', onclick: () => core.removeConnection(c) }, icon('delete'), 'Remove')));
    box.append(ed);
    refreshGraph();
    return box;
  }

  const currentFeature = (c) => {
    const fi = FEATURES.indexOf(c.feature);
    if (fi < 0 || !state.engine) return null;
    return valueAtFrame(core.getSeries(c.source, fi), state.engine.analysis_rate(), state.project.videoFps, state.frame);
  };

  function drawCurve(canvas, c, info, liveX) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 220; const hh = canvas.clientHeight || 90;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    const css = getComputedStyle(canvas);
    const col = (n, d) => css.getPropertyValue(n).trim() || d;
    const R = canvas._R ?? Math.max(Math.abs(c.outMin), Math.abs(c.outMax), 0.05 * (info.max - info.min)) * 1.4;
    const px = 14; const py = 10;
    const X = (x) => px + x * (w - 2 * px);
    const Y = (v) => hh / 2 - (v / R) * (hh / 2 - py);
    g.strokeStyle = col('--md-outline-variant', '#444'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(px, Y(0)); g.lineTo(w - px, Y(0)); g.moveTo(X(0), py - 4); g.lineTo(X(0), hh - py + 4); g.stroke();
    g.strokeStyle = col('--md-primary', '#f69'); g.lineWidth = 2; g.beginPath();
    for (let k = 0; k <= 48; k++) { const x = k / 48; const v = c.outMin + (c.outMax - c.outMin) * applyCurve(c, x); k ? g.lineTo(X(x), Y(v)) : g.moveTo(X(x), Y(v)); }
    g.stroke();
    g.fillStyle = col('--md-primary', '#f69');
    for (const [x, v] of [[0, c.outMin], [1, c.outMax]]) { g.beginPath(); g.arc(X(x), Y(v), 5, 0, 7); g.fill(); }
    if (liveX != null) {
      const v = c.outMin + (c.outMax - c.outMin) * applyCurve(c, liveX);
      g.fillStyle = col('--md-tertiary', '#6bd5ff'); g.beginPath(); g.arc(X(liveX), Y(v), 4, 0, 7); g.fill();
      g.strokeStyle = col('--md-tertiary', '#6bd5ff'); g.globalAlpha = 0.4; g.beginPath(); g.moveTo(X(liveX), py - 4); g.lineTo(X(liveX), hh - py + 4); g.stroke(); g.globalAlpha = 1;
    }
    canvas._map = { X, Y, R, px, hh, py, w };
  }

  function attachCurveDrag(canvas, c, info, redraw) {
    let which = null;
    canvas.addEventListener('pointerdown', (e) => {
      const m = canvas._map; if (!m) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left; const y = e.clientY - r.top;
      const d0 = Math.hypot(x - m.X(0), y - m.Y(c.outMin)); const d1 = Math.hypot(x - m.X(1), y - m.Y(c.outMax));
      if (Math.min(d0, d1) > 22) return;
      which = d0 <= d1 ? 'outMin' : 'outMax';
      canvas._R = m.R;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!which) return;
      const m = canvas._map; const r = canvas.getBoundingClientRect();
      const y = e.clientY - r.top;
      const v = ((m.hh / 2 - y) / (m.hh / 2 - m.py)) * m.R;
      c[which] = Math.max(info.min - info.max, Math.min(info.max - info.min, Math.round(v / (m.R / 100) ) * (m.R / 100)));
      core.updateConnection(c, {}, 'Edit mapping', `conn:graph:${info.name}`);
      redraw();
    });
    const end = () => { which = null; canvas._R = undefined; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  }

  // ---------- build ----------

  function build() {
    clear(element); live = [];
    const def = state.selected && core.layerById(state.selected);
    lastSig = sigOf();
    if (!def) {
      element.append(h('div.empty-note', icon('tune'), h('p', 'Select a layer to edit it.'), h('p.muted', 'Click a layer in the Layers panel, or click it in the preview.')));
      return;
    }
    const asset = state.assets[core.layerIndex(def.id)];
    const rows = [];
    element.append(headerSection(def));
    if (def.type === 'visualizer') element.append(visualizerSection(def));
    else if (def.type === 'effect') element.append(effectSection(def));
    else if (def.type === 'lyrics') element.append(lyricsSection(def));
    else if (def.type === 'script') element.append(section('Script', 'lyrics', h('div.row', h('button.btn.tonal', { type: 'button', onclick: () => shell.showPanel('script') }, icon('lyrics'), 'Open Script panel'))));
    else element.append(imageSection(def, asset));

    const props = propsFor(def.type).filter((p) => showAdvanced || !p.advanced);
    for (const group of ['Transform', 'Look', 'Layer']) {
      const gp = props.filter((p) => p.group === group);
      if (!gp.length) continue;
      element.append(section(group === 'Layer' ? 'Effect strength' : group, group === 'Transform' ? 'open_in_full' : group === 'Look' ? 'palette' : 'bolt',
        gp.map((p) => propRow(def, p, rows))));
    }
    element.append(h('div.sect-flat', toggle({ label: 'Show advanced properties', value: showAdvanced, onChange: (v) => { showAdvanced = v; build(); } })));
    live.push({ rows });
    refreshLive();
  }

  function refreshLive() {
    const def = state.selected && core.layerById(state.selected);
    if (!def) return;
    for (const item of live) {
      if (item.rows) {
        for (const r of item.rows) {
          const info = PROP_BY_NAME[r.prop];
          const track = core.trackOf(r.id, r.prop);
          const edit = core.editValue(r.id, r.prop);
          const liveV = core.evaluated(r.id, r.prop);
          r.setValue(edit);
          const atKey = track?.keys.some((k) => k.f === state.frame);
          r.keyBtn.classList.toggle('on', !!atKey);
          r.keyBtn.classList.toggle('has', !!track);
          const differs = Math.abs(liveV - edit) > 1e-3 * Math.max(1, Math.abs(edit));
          r.liveEl.textContent = differs ? `→ ${fmtValue(info, liveV)}` : '';
        }
      }
      if (item.meterFill) {
        const v = currentFeature(item.c);
        item.meterFill.style.width = `${Math.round((v ?? 0) * 100)}%`;
      }
      if (item.graph) item.graph();
    }
  }

  const structural = rafThrottle(() => { if (sigOf() !== lastSig) build(); else refreshLive(); });
  on('project', structural); on('selection', structural); on('engine', structural); on('issues', structural);
  on('frame', rafThrottle(refreshLive));
  build();
  return { element, title: 'Inspector' };
}
