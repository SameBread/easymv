// Shell: menu bar, command registry and shortcuts, Dockview workspaces, phone layout,
// dialogs. Panels are DOM components created once and moved between hosts.

import { ACTION_BY_ID, ACTIONS, buildMap, eventCombo, comboOf, conflictFor, normalizeCombo, prettyCombo } from '../keymap.js';
import * as core from '../core.js';
import { state, on, sources } from '../core.js';
import { h, icon, iconBtn, btn, clear, showMenu, closeMenus, dialog, numField, selectField, toggle, colorField, rafThrottle } from './dom.js';
import { createPreviewPanel } from './panels/preview.js';
import { createLayersPanel } from './panels/layers.js';
import { createInspectorPanel } from './panels/inspector.js';
import { createTimelinePanel } from './panels/timeline.js';
import { createSignalsPanel } from './panels/signals.js';
import { createLyricsPanel } from './panels/lyrics.js';
import { createScriptPanel } from './panels/script.js';
import { VIS_PRESETS } from '../visualizer.js';
import { FX_KINDS, FX_IDS } from '../effects.js';

const PANELS = [
  { id: 'preview', title: 'Preview', icon: 'movie', make: createPreviewPanel },
  { id: 'layers', title: 'Layers', icon: 'layers', make: createLayersPanel },
  { id: 'inspector', title: 'Inspector', icon: 'tune', make: createInspectorPanel },
  { id: 'timeline', title: 'Timeline', icon: 'timeline', make: createTimelinePanel },
  { id: 'signals', title: 'Signals', icon: 'graphic_eq', make: createSignalsPanel },
  { id: 'lyrics', title: 'Captions', icon: 'closed_caption', make: createLyricsPanel },
  { id: 'script', title: 'Script', icon: 'slideshow', make: createScriptPanel },
];
const PHONE_NAV = ['layers', 'inspector', 'timeline', 'signals', 'lyrics', 'script'];

// Built-in workspaces: functions that lay panels out with Dockview's relative positions.
const BUILTIN = {
  Compose: (add) => {
    add('preview'); add('layers', 'preview', 'left', { w: 250 }); add('inspector', 'preview', 'right', { w: 330 });
    add('timeline', 'preview', 'below', { h: 250 }); add('signals', 'layers', 'within'); add('lyrics', 'inspector', 'within'); add('script', 'inspector', 'within');
    return ['layers', 'inspector'];
  },
  Animate: (add) => {
    add('preview'); add('layers', 'preview', 'left', { w: 230 }); add('inspector', 'preview', 'right', { w: 320 });
    add('timeline', 'preview', 'below', { h: 340 }); add('signals', 'inspector', 'within');
    return ['inspector'];
  },
  Captions: (add) => {
    add('preview'); add('lyrics', 'preview', 'right', { w: 420 }); add('layers', 'preview', 'left', { w: 220 });
    add('timeline', 'preview', 'below', { h: 240 }); add('inspector', 'lyrics', 'within');
    return ['lyrics'];
  },
  Present: (add) => {
    add('preview'); add('script', 'preview', 'right', { w: 420 }); add('layers', 'preview', 'left', { w: 220 });
    add('timeline', 'preview', 'below', { h: 200 }); add('inspector', 'script', 'within');
    return ['script'];
  },
  Mix: (add) => {
    add('preview'); add('signals', 'preview', 'left', { w: 340 }); add('inspector', 'preview', 'right', { w: 330 });
    add('timeline', 'preview', 'below', { h: 220 }); add('layers', 'signals', 'within');
    return ['signals', 'inspector'];
  },
};

const LS_WS = 'easymv.workspaces'; const LS_CUR = 'easymv.workspace';
const readJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d; } catch { return d; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } };

export function createShell(root, dv) {
  const shell = { selectedSection: null };
  const instances = new Map();
  let api = null; let phone = false; let phonePanel = 'layers';
  let currentWs = readJson(LS_CUR, 'Compose');

  // ---------- panels ----------
  const instance = (id) => {
    if (!instances.has(id)) instances.set(id, PANELS.find((p) => p.id === id).make(shell));
    return instances.get(id);
  };
  shell.panel = instance;
  shell.showPanel = (id) => {
    if (phone) { setPhonePanel(id); return; }
    const p = api?.getPanel(id);
    if (p) p.api.setActive();
    else addPanelSomewhere(id);
  };
  function addPanelSomewhere(id) {
    const ref = api.getPanel('inspector') ?? api.getPanel('preview');
    api.addPanel({ id, component: id, title: PANELS.find((p) => p.id === id).title, position: ref ? { referencePanel: ref.id, direction: 'within' } : undefined });
  }

  // ---------- dialogs & pickers ----------
  const filePicker = (accept, multiple, cb) => {
    const i = h('input', { type: 'file', accept, multiple, hidden: true, onchange: () => { cb([...i.files]); i.remove(); } });
    document.body.append(i); i.click();
  };
  shell.pickAudio = () => filePicker('audio/*,.flac', false, ([f]) => { if (f) { core.setMaster(f); core.toast(`Loaded ${f.name}. Analyzing…`); analyzeWithProgress(); } });
  shell.pickStems = () => filePicker('audio/*,.flac', true, (fs) => core.addStems(fs));
  shell.pickPptx = () => filePicker('.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation', false, async ([f]) => {
    if (!f) return;
    try { pptxDialog(f, await core.inspectPptx(f)); } catch (e) { core.toast(e.message || 'Could not read that PowerPoint file.', 5000); }
  });
  shell.pickImages = () => filePicker('image/*,.gif,.zip', true, (fs) => core.addFiles(fs));
  shell.openProject = () => filePicker('.json,.zip,.easymv', false, ([f]) => f && core.openFile(f));

  async function analyzeWithProgress() {
    const bar = h('progress', { max: 1, value: 0 });
    const msg = h('p', 'Analyzing audio…');
    const d = dialog({ title: 'Analyzing', body: [msg, bar], actions: [] });
    d.dlg.addEventListener('cancel', (e) => e.preventDefault());
    try { await core.analyze((frac, m) => { bar.value = frac; if (m) msg.textContent = m; }); } finally { d.close(); }
  }
  shell.analyze = analyzeWithProgress;

  shell.quickStart = async () => {
    if (!state.masterFile) { shell.pickAudio(); return; }
    const bar = h('progress', { max: 1, value: 0 });
    const d = dialog({ title: 'Quick start', body: [h('p', 'Adding a demo layer, analyzing the song and connecting sound automatically…'), bar], actions: [] });
    try { await core.quickStart((f) => { bar.value = f; }); } finally { d.close(); }
  };

  shell.showAddMenu = (anchor) => showMenu(anchor, addItems());
  function addItems() {
    return [
      { label: 'Images, GIFs, frames…', icon: 'image', run: shell.pickImages },
      { label: 'Demo layer', icon: 'auto_fix_high', run: () => core.addDemo() },
      { separator: true },
      { label: 'Visualizer', icon: 'graphic_eq', submenu: VIS_PRESETS.map((p, i) => ({ label: p.label ?? p.name, run: () => core.addVisualizer(i) })) },
      { label: 'Effect', icon: 'auto_awesome', submenu: FX_IDS.map((k) => ({ label: FX_KINDS[k].label, icon: FX_KINDS[k].icon, run: () => core.addEffect(k) })) },
      { label: 'Closed captions (CC)', icon: 'closed_caption', run: () => core.addLyrics() },
      { label: 'Script (kinetic text)', icon: 'slideshow', submenu: [
        { label: 'Presentation / explainer', icon: 'slideshow', run: async () => { await core.addScript(undefined, 'presentation'); shell.showPanel('script'); } },
        { label: 'Lyrics over a background', icon: 'lyrics', run: async () => { await core.addScript(undefined, 'lyrics'); shell.showPanel('script'); } },
        { separator: true },
        { label: 'Demo: presentation (Marxism)', icon: 'auto_fix_high', run: async () => { await core.addScriptDemo('presentation'); shell.showPanel('script'); } },
        { label: 'Demo: lyrics (song + rain)', icon: 'auto_fix_high', run: async () => { await core.addScriptDemo('lyrics'); shell.showPanel('script'); } },
      ] },
      { label: 'PowerPoint slides (.pptx)…', icon: 'slideshow', run: () => shell.pickPptx() },
    ];
  }
  const sel = () => state.selected && core.layerById(state.selected);
  const move = (to) => { const d = sel(); if (d) core.reorderLayer(d.id, to); };
  shell.showLayerMenu = (pos, id) => {
    core.select(id);
    const d = core.layerById(id); const n = state.project.elements.length; const i = core.layerIndex(id);
    showMenu(pos, [
      { label: 'Duplicate', icon: 'content_copy', run: () => core.duplicateLayer(id) },
      { label: 'Bring forward', icon: 'arrow_upward', disabled: i >= n - 1, run: () => core.reorderLayer(id, i + 1) },
      { label: 'Send backward', icon: 'arrow_downward', disabled: i <= 0, run: () => core.reorderLayer(id, i - 1) },
      { label: 'Bring to front', icon: 'vertical_align_top', disabled: i >= n - 1, run: () => core.reorderLayer(id, n - 1) },
      { label: 'Send to back', icon: 'vertical_align_bottom', disabled: i <= 0, run: () => core.reorderLayer(id, 0) },
      { separator: true },
      { label: d.locked ? 'Unlock' : 'Lock', icon: d.locked ? 'lock_open' : 'lock', run: () => core.updateLayer(id, { locked: !d.locked }, 'Toggle lock') },
      { label: 'Delete', icon: 'delete', run: () => core.removeLayers([id]) }]);
  };
  shell.openReorder = (id) => reorderDialog(id);

  function reorderDialog(id) {
    const i = core.layerIndex(id); const asset = state.assets[i]; const def = core.layerById(id);
    if (!asset?.frameCount) return;
    let order = def.frameOrder ? [...def.frameOrder] : Array.from({ length: asset.frameCount }, (_, k) => k);
    const list = h('ol.reorder');
    const draw = () => {
      clear(list);
      order.forEach((src, k) => list.append(h('li', h('span.row-n', String(k + 1)), h('span', `Frame ${src + 1}`),
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Move up', disabled: k === 0, onclick: () => { [order[k - 1], order[k]] = [order[k], order[k - 1]]; draw(); } }, icon('arrow_upward')),
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Move down', disabled: k === order.length - 1, onclick: () => { [order[k + 1], order[k]] = [order[k], order[k + 1]]; draw(); } }, icon('arrow_downward')),
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Remove frame', disabled: order.length <= 1, onclick: () => { order.splice(k, 1); draw(); } }, icon('close')))));
    };
    draw();
    dialog({ title: 'Reorder frames', body: [h('p.muted', 'Order, repeat or drop frames of this sequence.'), list],
      actions: [{ label: 'Cancel' }, { label: 'Apply', variant: 'filled', run: () => core.updateLayer(id, { frameOrder: order }, 'Reorder frames', null, { assets: true }) }] });
  }

  // ---------- commands ----------
  const C = (id, label, run, extra = {}) => ({ id, label, run, ...extra });
  const commands = {
    new: C('new', 'New project', () => { if (confirm('Start a new project? Unsaved changes will be lost.')) core.newDocument(); }),
    open: C('open', 'Open project…', () => shell.openProject(), { shortcut: 'Ctrl+O', icon: 'folder_open' }),
    saveJson: C('saveJson', 'Save project (.json)', () => core.saveProjectJson(), { shortcut: 'Ctrl+S', icon: 'save' }),
    saveBundle: C('saveBundle', 'Save bundle with media (.zip)', () => core.saveBundle(), { icon: 'file_download' }),
    export: C('export', 'Export video…', () => exportDialog(), { shortcut: 'Ctrl+E', icon: 'movie' }),
    undo: C('undo', 'Undo', () => core.undo(), { shortcut: 'Ctrl+Z', icon: 'undo' }),
    redo: C('redo', 'Redo', () => core.redo(), { shortcut: 'Ctrl+Shift+Z', icon: 'redo' }),
    dup: C('dup', 'Duplicate layer', () => sel() && core.duplicateLayer(state.selected), { shortcut: 'Ctrl+D', icon: 'content_copy' }),
    del: C('del', 'Delete layer', () => sel() && core.removeLayers([state.selected]), { shortcut: 'Del', icon: 'delete' }),
    play: C('play', 'Play / pause', () => core.togglePlay(), { shortcut: 'Space', icon: 'play_arrow' }),
    prev: C('prev', 'Previous frame', () => core.seek(state.frame - 1), { shortcut: '←' }),
    next: C('next', 'Next frame', () => core.seek(state.frame + 1), { shortcut: '→' }),
    start: C('start', 'Go to start', () => core.seek(0), { shortcut: 'Home' }),
    key: C('key', 'Keyframe selected property…', () => {}, {}),
    tap: C('tap', 'Tap caption or script line', () => { const d = state.selected && core.layerById(state.selected); (d?.type === 'script' ? instance('script') : instance('lyrics')).tap?.(); }, { shortcut: 'T' }),
  };
  const shortcuts = [
    ['Space', 'Play / pause'], ['← / →', 'Previous / next frame (Shift: 10 frames)'], ['Home', 'Go to start'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
    ['Ctrl+D', 'Duplicate layer'], ['Delete', 'Delete layer, or selected keyframes in the timeline'], ['Ctrl+S / Ctrl+O', 'Save / open'], ['T', 'Tap the next lyric line'],
    ['Ctrl+wheel', 'Zoom the timeline'], ['Shift+drag (timeline)', 'Box-select keyframes'], ['Alt+drag a section', 'Move only the band, not its keyframes'], ['Right-click / long-press', 'Context menus'],
  ];

  // ---------- keyboard: every shortcut is an action in keymap.js, rebindable in Preferences ----------
  const runners = {
    play: () => commands.play.run(), prev: () => core.seek(state.frame - 1), next: () => core.seek(state.frame + 1),
    prev10: () => core.seek(state.frame - 10), next10: () => core.seek(state.frame + 10),
    start: () => { core.stop(); core.seek(0); }, end: () => { core.stop(); core.seek(core.totalFrames() - 1); },
    back10: () => core.skip(-10), fwd10: () => core.skip(10), loop: () => core.setLoop(!core.transport.loop),
    tap: () => commands.tap.run(),
    toolSelect: () => core.setPreviewTool('select'), toolMove: () => core.setPreviewTool('move'),
    toolRotate: () => core.setPreviewTool('rotate'), toolScale: () => core.setPreviewTool('scale'),
    toggleEdit: () => core.setPreviewEdit(!state.prefs.previewEdit),
    resetXform: () => sel() && core.resetTransform(state.selected),
    undo: () => commands.undo.run(), redo: () => commands.redo.run(), redo2: () => commands.redo.run(),
    save: () => commands.saveJson.run(), open: () => commands.open.run(), export: () => commands.export.run(),
    dup: () => commands.dup.run(), del: () => commands.del.run(),
  };
  shell.runAction = (id) => runners[id]?.();
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]') || e.defaultPrevented) return;
    const tag = e.target.tagName;
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) && !(tag === 'INPUT' && ['range', 'checkbox'].includes(e.target.type));
    if (tag === 'SUMMARY') return;
    const combo = eventCombo(e); if (!combo) return;
    const id = buildMap(state.prefs.keys).get(combo); if (!id) return;
    const act = ACTION_BY_ID[id];
    if (typing && !(combo.startsWith('Ctrl+') && !/^(undo|redo|redo2)$/.test(id))) return;   // text fields keep their own keys, undo included
    if (act.skipIn && e.target.closest(act.skipIn)) return;
    e.preventDefault();
    runners[id]?.();
  });

  const CMD_ACTION = { saveJson: 'save' };
  const menuItem = (c, extra = {}) => { const aid = CMD_ACTION[c.id] ?? c.id; return { label: c.label, icon: c.icon, shortcut: ACTION_BY_ID[aid] ? prettyCombo(comboOf(aid, state.prefs.keys)) : c.shortcut, run: c.run, ...extra }; };

  // ---------- menu bar ----------
  const menus = {
    File: () => [
      menuItem(commands.new), menuItem(commands.open), { separator: true },
      menuItem(commands.saveJson), menuItem(commands.saveBundle), { separator: true },
      { label: 'Add media…', icon: 'image', run: shell.pickImages }, { label: 'Add demo layer', icon: 'auto_fix_high', run: () => core.addDemo() },
      { separator: true }, menuItem(commands.export, { disabled: !state.bridge })],
    Edit: () => [
      menuItem(commands.undo, { label: core.canUndo() ? `Undo ${core.undoLabel()}` : 'Undo', disabled: !core.canUndo() }),
      menuItem(commands.redo, { label: core.canRedo() ? `Redo ${core.redoLabel()}` : 'Redo', disabled: !core.canRedo() }),
      { separator: true }, menuItem(commands.dup, { disabled: !sel() }), menuItem(commands.del, { disabled: !sel() })],
    View: () => [
      { header: 'Theme' },
      ...['dark', 'light', 'auto'].map((t) => ({ label: t[0].toUpperCase() + t.slice(1), checked: state.prefs.theme === t, run: () => core.setPref('theme', t) })),
      { separator: true },
      { label: 'Fullscreen', icon: 'fit_screen', run: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()) }],
    Layer: () => [
      { label: 'New layer', icon: 'add', submenu: addItems() }, { separator: true },
      menuItem(commands.dup, { disabled: !sel() }),
      { label: 'Bring forward', icon: 'arrow_upward', disabled: !sel(), run: () => move(core.layerIndex(state.selected) + 1) },
      { label: 'Send backward', icon: 'arrow_downward', disabled: !sel(), run: () => move(core.layerIndex(state.selected) - 1) },
      { label: 'Bring to front', icon: 'vertical_align_top', disabled: !sel(), run: () => move(state.project.elements.length - 1) },
      { label: 'Send to back', icon: 'vertical_align_bottom', disabled: !sel(), run: () => move(0) },
      { separator: true }, menuItem(commands.del, { disabled: !sel() })],
    Timeline: () => [
      menuItem(commands.play), menuItem(commands.prev), menuItem(commands.next), menuItem(commands.start), { separator: true },
      { label: 'Add section at playhead', icon: 'flag', run: () => core.addSection() },
      { label: 'Snap to beats and sections', checked: state.prefs.snap, run: () => core.setPref('snap', !state.prefs.snap) },
      { label: 'Auto-key edits to animated properties', checked: state.prefs.autoKey, run: () => core.setPref('autoKey', !state.prefs.autoKey) }],
    Audio: () => [
      { label: 'Choose song…', icon: 'music_note', run: shell.pickAudio }, { label: 'Add stems…', icon: 'equalizer', run: shell.pickStems },
      { label: 'Analyze', icon: 'refresh', disabled: !state.masterFile, run: shell.analyze }, { separator: true },
      { label: 'Run Automatic mode on images', icon: 'auto_fix_high', disabled: !state.bridge, run: () => { core.runAuto(); core.toast('Automatic links added.'); } },
      { label: 'Quick start', icon: 'bolt', run: shell.quickStart }, { separator: true },
      { label: 'Audio settings…', icon: 'settings', run: () => projectDialog() }],
    Window: () => {
      const ws = readJson(LS_WS, {});
      return [
        { header: 'Panels' },
        ...PANELS.map((p) => ({ label: p.title, icon: p.icon, checked: phone ? phonePanel === p.id : !!api?.getPanel(p.id), run: () => { if (!phone && api.getPanel(p.id) && p.id !== 'preview') api.getPanel(p.id).api.close(); else shell.showPanel(p.id); } })),
        { separator: true }, { header: 'Workspaces' },
        ...Object.keys(BUILTIN).map((n) => ({ label: n, checked: currentWs === n, run: () => loadWorkspace(n) })),
        ...Object.keys(ws).map((n) => ({ label: n, checked: currentWs === n, icon: 'dashboard', run: () => loadWorkspace(n) })),
        { separator: true },
        { label: 'Save workspace as…', icon: 'save', run: saveWorkspaceDialog },
        { label: 'Reset this workspace', icon: 'refresh', run: () => loadWorkspace(BUILTIN[currentWs] ? currentWs : 'Compose', true) },
        { label: 'Export layout…', icon: 'file_download', run: exportLayout }, { label: 'Import layout…', icon: 'file_upload', run: importLayout },
        ...(Object.keys(ws).length ? [{ label: 'Delete saved workspace', icon: 'delete', submenu: Object.keys(ws).map((n) => ({ label: n, run: () => { const w = readJson(LS_WS, {}); delete w[n]; writeJson(LS_WS, w); } })) }] : [])];
    },
    Settings: () => [
      { label: 'Project settings…', icon: 'movie', run: () => projectDialog() }, { label: 'Preferences…', icon: 'settings', run: prefsDialog }],
    Help: () => [
      { label: 'Quick start guide', icon: 'help', run: helpDialog }, { label: 'Keyboard shortcuts', icon: 'keyboard', run: shortcutsDialog },
      { label: 'About EasyMV', icon: 'info', run: aboutDialog }],
  };

  const menubar = h('nav.menubar', { role: 'menubar', 'aria-label': 'Main menu' });
  let openName = null;
  const menuBtns = Object.keys(menus).map((name) => {
    const b = h('button.menu-btn', { type: 'button', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, name);
    const show = () => { openName = name; menuBtns.forEach((x) => x.setAttribute('aria-expanded', String(x === b))); showMenu(b, menus[name](), { onClose: () => { if (openName === name) { openName = null; b.setAttribute('aria-expanded', 'false'); } } }); };
    b.addEventListener('click', () => { if (openName === name) closeMenus(); else show(); });
    b.addEventListener('pointerenter', () => { if (openName && openName !== name) show(); });
    b.addEventListener('keydown', (e) => {
      const i = menuBtns.indexOf(b);
      if (e.key === 'ArrowRight') { menuBtns[(i + 1) % menuBtns.length].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { menuBtns[(i - 1 + menuBtns.length) % menuBtns.length].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { show(); e.preventDefault(); }
    });
    menubar.append(b); return b;
  });
  const hamburger = iconBtn('menu', 'Menu', (e) => showMenu(e.currentTarget, Object.keys(menus).map((n) => ({ label: n, submenu: menus[n]() }))), 'hamburger');

  const undoBtn = iconBtn('undo', 'Undo (Ctrl+Z)', () => core.undo());
  const redoBtn = iconBtn('redo', 'Redo (Ctrl+Shift+Z)', () => core.redo());
  const exportBtn = h('button.btn.filled.sm.export-btn', { type: 'button', onclick: () => commands.export.run() }, icon('movie'), h('span', 'Export'));
  const wsSelect = h('select.fld-select.ws-select', { 'aria-label': 'Workspace', onchange: (e) => loadWorkspace(e.target.value) });
  const topbar = h('header.topbar', hamburger, h('div.brand', h('span.logo', icon('graphic_eq')), h('span.brand-name', 'EasyMV')), menubar, h('span.grow'), wsSelect, undoBtn, redoBtn, exportBtn);
  const banner = h('div.banner.err', { hidden: true, role: 'alert' });
  const dockHost = h('div.dock-host');
  const phoneHost = h('div.phone-host', { hidden: true });
  const phoneStage = h('div.phone-stage'); const phoneBody = h('div.phone-body');
  const phoneNav = h('nav.phone-nav', { role: 'tablist' }, PHONE_NAV.map((id) => {
    const p = PANELS.find((x) => x.id === id);
    return h('button.nav-btn', { type: 'button', role: 'tab', dataset: { id }, onclick: () => setPhonePanel(id) }, icon(p.icon), h('span', p.title));
  }));
  phoneHost.append(phoneStage, phoneBody, phoneNav);
  root.append(topbar, banner, dockHost, phoneHost);

  const refreshChrome = rafThrottle(() => {
    undoBtn.disabled = !core.canUndo(); redoBtn.disabled = !core.canRedo();
    undoBtn.title = core.canUndo() ? `Undo ${core.undoLabel()}` : 'Undo'; redoBtn.title = core.canRedo() ? `Redo ${core.redoLabel()}` : 'Redo';
    exportBtn.disabled = !state.bridge || state.exporting;
    document.title = 'EasyMV';
  });
  on('history', refreshChrome); on('engine', refreshChrome); on('project', refreshChrome); on('export', refreshChrome);
  on('fatal', ({ msg }) => { banner.hidden = !msg; banner.textContent = msg ?? ''; });
  on('prefs', ({ key }) => { if (['theme', 'accent', 'density'].includes(key)) applyTheme(); });
  on('export', () => { exportUpdate?.(); });

  // ---------- theme ----------
  const mq = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = state.prefs.theme === 'auto' ? (mq.matches ? 'dark' : 'light') : state.prefs.theme;
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.density = state.prefs.density;
    const a = state.prefs.accent;
    document.documentElement.style.setProperty('--accent', a);
  }
  mq.addEventListener?.('change', applyTheme);
  applyTheme();

  // ---------- workspaces ----------
  const saveWorkspaceDialog = () => {
    const input = h('input.text-input', { value: 'My layout', 'aria-label': 'Workspace name' });
    dialog({ title: 'Save workspace', body: [h('label.fld', h('span.fld-label', 'Name'), input)], actions: [{ label: 'Cancel' }, { label: 'Save', variant: 'filled', run: () => {
      const n = input.value.trim(); if (!n || BUILTIN[n]) { core.toast('Pick a different name.'); return false; }
      const w = readJson(LS_WS, {}); w[n] = api.toJSON(); writeJson(LS_WS, w); currentWs = n; writeJson(LS_CUR, n); fillWsSelect(); core.toast(`Saved workspace “${n}”.`);
    } }] });
    input.select();
  };
  const exportLayout = () => core.download(new Blob([JSON.stringify({ app: 'easymv', workspace: currentWs, layout: api.toJSON() }, null, 1)], { type: 'application/json' }), `easymv-layout-${currentWs}.json`);
  const importLayout = () => filePicker('.json', false, async ([f]) => {
    try {
      const j = JSON.parse(await f.text()); if (!j.layout) throw new Error('not a layout file');
      const n = (j.workspace && !BUILTIN[j.workspace] ? j.workspace : f.name.replace(/\.json$/, '')) || 'Imported';
      const w = readJson(LS_WS, {}); w[n] = j.layout; writeJson(LS_WS, w); loadWorkspace(n);
    } catch (e) { core.toast(`Could not import layout: ${e.message}`); }
  });
  function fillWsSelect() {
    clear(wsSelect);
    for (const n of [...Object.keys(BUILTIN), ...Object.keys(readJson(LS_WS, {}))]) wsSelect.add(new Option(n, n, false, n === currentWs));
    wsSelect.value = currentWs;
  }

  function loadWorkspace(name, reset = false) {
    if (phone) { currentWs = name; return; }
    const saved = readJson(LS_WS, {})[name];
    const fn = BUILTIN[name];
    if (!fn && !saved) name = 'Compose';
    api.clear();
    const add = (id, ref, dir, size = {}) => {
      api.addPanel({ id, component: id, title: PANELS.find((p) => p.id === id).title,
        position: ref ? { referencePanel: ref, direction: dir === 'within' ? 'within' : dir === 'below' ? 'below' : dir } : undefined,
        initialWidth: size.w, initialHeight: size.h });
    };
    let ok = false;
    if (saved && !reset) { try { api.fromJSON(saved); ok = true; } catch { ok = false; } }
    if (!ok) { const active = (BUILTIN[name] ?? BUILTIN.Compose)(add); for (const id of [...active].reverse()) api.getPanel(id)?.api.setActive(); }
    currentWs = name; writeJson(LS_CUR, name); fillWsSelect();
  }
  // keep user layouts current while they drag panels around
  const autosave = rafThrottle(() => { const w = readJson(LS_WS, {}); if (!phone && w[currentWs] && api) { w[currentWs] = api.toJSON(); writeJson(LS_WS, w); } });

  // ---------- phone ----------
  function setPhonePanel(id) {
    phonePanel = id;
    clear(phoneBody); phoneBody.append(instance(id).element);
    phoneNav.querySelectorAll('.nav-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === id)));
    window.dispatchEvent(new Event('resize'));
  }
  function enterPhone() {
    phone = true; dockHost.hidden = true; phoneHost.hidden = false; document.body.classList.add('phone');
    clear(phoneStage); phoneStage.append(instance('preview').element);
    setPhonePanel(PHONE_NAV.includes(phonePanel) ? phonePanel : 'layers');
  }
  function exitPhone() {
    phone = false; phoneHost.hidden = true; dockHost.hidden = false; document.body.classList.remove('phone');
    loadWorkspace(currentWs);
  }
  const phoneMq = matchMedia('(max-width: 720px)');
  phoneMq.addEventListener?.('change', () => { if (phoneMq.matches !== phone) (phoneMq.matches ? enterPhone : exitPhone)(); });

  // ---------- dialogs ----------
  let exportUpdate = null;
  function exportDialog() {
    const p = state.project;
    const bar = h('progress', { max: 1, value: 0 }); const msg = h('p.muted', '');
    const info = h('p', `${p.resolution[0]}×${p.resolution[1]} at ${p.videoFps} fps, ${(core.totalFrames() / p.videoFps).toFixed(1)} s. Rendered frame by frame, so it is identical to the preview.`);
    const hidden = state.project.elements.filter((e) => (e.base?.visible ?? 1) < 0.5 && !core.trackOf(e.id, 'visible')).length;
    const note = hidden ? h('p.note', `${hidden} hidden layer${hidden === 1 ? '' : 's'} will be skipped.`) : null;
    let d;
    const start = h('button.btn.filled', { type: 'button', onclick: async () => { start.disabled = true; cancel.hidden = false; await core.exportVideo(); start.disabled = false; cancel.hidden = true; } }, icon('movie'), 'Start export');
    const cancel = h('button.btn.text', { type: 'button', hidden: true, onclick: () => core.cancelExport() }, 'Cancel export');
    exportUpdate = () => { bar.value = state.export.frac; msg.textContent = state.export.msg ?? ''; };
    d = dialog({ title: 'Export video', body: [info, note, bar, msg, h('div.row', start, cancel)], actions: [{ label: 'Close' }], onClose: () => { exportUpdate = null; } });
    exportUpdate();
  }

  function projectDialog() {
    const p = state.project;
    const [w, hh] = p.resolution;
    let rw = w; let rh = hh;
    const preset = selectField({ label: 'Size', value: `${w}x${hh}`, options: [['1280x720', '1280×720 (HD)'], ['1920x1080', '1920×1080 (Full HD)'], ['720x1280', '720×1280 (vertical)'], ['1080x1920', '1080×1920 (vertical FHD)'], ['1080x1080', '1080×1080 (square)']],
      onChange: (v) => { [rw, rh] = v.split('x').map(Number); fw.set(rw); fh.set(rh); } });
    const fw = numField({ label: 'Width', value: w, min: 2, max: 7680, step: 2, onChange: (v) => { rw = v; } });
    const fh = numField({ label: 'Height', value: hh, min: 2, max: 7680, step: 2, onChange: (v) => { rh = v; } });
    const fps = selectField({ label: 'Frame rate', value: String(p.videoFps), options: ['24', '30', '48', '60'], onChange: (v) => { p._fps = Number(v); } });
    const sr = selectField({ label: 'Sample rate', value: String(p.sampleRate ?? 44100), options: [['44100', '44,100 Hz'], ['48000', '48,000 Hz']], onChange: (v) => { p._sr = Number(v); } });
    const ar = selectField({ label: 'Analysis rate', value: String(p.analysisRate ?? 200), options: [['100', '100 Hz'], ['200', '200 Hz']], onChange: (v) => { p._ar = Number(v); } });
    dialog({ title: 'Project settings', body: [h('div.fgrid', preset.el, fw.el, fh.el, fps.el, sr.el, ar.el)], actions: [{ label: 'Cancel' }, { label: 'Apply', variant: 'filled', run: async () => {
      const fpsV = p._fps; const srV = p._sr; const arV = p._ar; delete p._fps; delete p._sr; delete p._ar;
      if (rw !== w || rh !== hh) await core.setResolution(rw, rh);
      if (fpsV && fpsV !== p.videoFps) core.setFps(fpsV);
      if ((srV && srV !== p.sampleRate) || (arV && arV !== p.analysisRate)) { core.setAudioSettings({ sampleRate: srV, analysisRate: arV }); if (state.masterFile) shell.analyze(); }
    } }] });
  }

  function prefsDialog() {
    const accents = ['#ff6b9d', '#6bd5ff', '#7cf3b2', '#ffd166', '#b39dff', '#ff9f6b'];
    const sw = h('div.swatches', accents.map((c) => h('button.swatch', { type: 'button', style: { background: c }, 'aria-label': `Accent ${c}`, class: c === state.prefs.accent ? 'on' : '',
      onclick: (e) => { core.setPref('accent', c); sw.querySelectorAll('.swatch').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } })));
    dialog({ title: 'Preferences', body: [
      h('div.fgrid',
        selectField({ label: 'Theme', value: state.prefs.theme, options: [['dark', 'Dark'], ['light', 'Light'], ['auto', 'Match system']], onChange: (v) => core.setPref('theme', v) }).el,
        selectField({ label: 'Density', value: state.prefs.density, options: [['auto', 'Automatic'], ['comfortable', 'Comfortable (touch)'], ['compact', 'Compact']], onChange: (v) => core.setPref('density', v) }).el,
        numField({ label: 'GPU budget', value: state.prefs.budgetMB, min: 64, max: 4096, step: 64, suffix: 'MB', onChange: (v, f) => f && core.setPref('budgetMB', v) }).el,
        numField({ label: 'Audio offset', value: state.prefs.audioOffsetMs, min: -500, max: 500, step: 5, suffix: 'ms', title: 'Shifts the soundtrack against the picture in the export', onChange: (v, f) => f && core.setPref('audioOffsetMs', v) }).el),
      h('div.fld-label', 'Accent color'), sw,
      h('div.row', btn('Keyboard shortcuts…', () => setTimeout(shortcutsDialog, 0), { variant: 'tonal', icon: 'keyboard' })),
      h('div.row', toggle({ label: 'Snap to beats', value: state.prefs.snap, onChange: (v) => core.setPref('snap', v) }).el, toggle({ label: 'Auto-key', value: state.prefs.autoKey, title: 'Editing an animated property writes a keyframe at the playhead', onChange: (v) => core.setPref('autoKey', v) }).el)],
    actions: [{ label: 'Done', variant: 'filled' }] });
  }

  shell.pptxDialog = (f, p) => pptxDialog(f, p);
  function pptxDialog(file, parsed) {
    const opt = { backgrounds: 'keep', timing: 'auto', secs: 5 };
    const pics = parsed.slides.filter((s) => s.images.length).length; const bgs = parsed.slides.filter((s) => s.bg).length;
    const hasSong = !!state.bridge;
    const timingOpts = [['auto', 'Automatic (reading time per slide)'], ['fixed', 'Same seconds for every slide']];
    if (hasSong) timingOpts.push(['fit', 'Stretch to the song length']);
    const secs = numField({ label: 'Seconds per slide', value: 5, min: 1, max: 60, step: 0.5, suffix: 's', onChange: (v, f) => { if (f) opt.secs = v; } });
    secs.el.hidden = true;
    dialog({ title: 'Import PowerPoint', wide: true, body: [
      h('p', `${file.name}: ${parsed.slides.length} slide${parsed.slides.length === 1 ? '' : 's'}, ${bgs} with a background, ${pics} with pictures.`),
      h('div.fgrid',
        selectField({ label: 'Backgrounds', value: 'keep', options: [['keep', 'Keep the PowerPoint backgrounds and pictures'], ['mix', 'Keep them and mix in EasyMV effects'], ['auto', 'EasyMV visuals only (text from the slides)']], onChange: (v) => { opt.backgrounds = v; } }).el,
        selectField({ label: 'Timing', value: 'auto', options: timingOpts, onChange: (v) => { opt.timing = v; secs.el.hidden = v !== 'fixed'; } }).el, secs.el),
      h('p.muted', 'Titles, subtitles, bullets and bold words become animated text; you can edit the result in the Script panel. Slides are timed from 0:00, so move the script layer on the timeline if the music starts later.')],
    actions: [{ label: 'Cancel' }, { label: 'Import', variant: 'filled', run: async () => {
      try { await core.importPptx(parsed, { name: file.name.replace(/\.pptx$/i, ''), backgrounds: opt.backgrounds, perSlide: opt.timing === 'fixed' ? opt.secs : 0, fitToSong: opt.timing === 'fit' }); shell.showPanel('script'); }
      catch (e) { core.toast(e.message || 'Import failed.', 5000); return false; } } }] });
  }

  const helpDialog = () => dialog({ title: 'Quick start', wide: true, body: [
    h('ol.help', h('li', 'Choose a song (Audio → Choose song). It is analyzed in your browser; nothing is uploaded.'),
      h('li', 'Add layers with the + button in Layers: images, a visualizer wrapped around a shape, effects like snow or pixel fire, or closed captions and kinetic-text scripts.'),
      h('li', 'Select a layer. In the Inspector, press the link icon next to a property to make it follow a sound, or drag a signal in from the Signals panel.'),
      h('li', 'Use the diamond next to a property to keyframe it at the playhead. Keyframes can replace the sound, blend with it or mix.'),
      h('li', 'In the Timeline, drag the green bars to decide when each layer is on screen. Hidden layers cost nothing to render.'),
      h('li', 'Closed captions (CC): paste words, press play and tap T on each line, or import an LRC file. Hold the tap button to set how long a caption stays.'),
      h('li', 'Script: write an outline and get animated, automatically laid-out scenes. Use it for presentations, or switch to "Lyrics over a background" for song text with word-by-word reveal. Try Add → Script → Demo.'),
      h('li', 'Window → Workspaces switches layouts. Drag panel tabs to rearrange, then Save workspace as…')),
    h('p.muted', 'Tip: Quick start adds a demo layer and automatic sound links so you can see something moving right away.')], actions: [{ label: 'Close', variant: 'filled' }] });
  const shortcutsDialog = () => {
    const keys = () => state.prefs.keys ?? {};
    const body = h('div.keymap');
    let rec = null;   // action id being recorded
    const note = h('p.muted', 'Click a key to change it, then press the new combination. Esc cancels, Backspace clears it.');
    const draw = () => {
      clear(body);
      let group = '';
      for (const a of ACTIONS) {
        if (a.group !== group) { group = a.group; body.append(h('h4', group)); }
        const combo = comboOf(a.id, keys());
        const b = h('button.key-btn', { type: 'button', class: rec === a.id ? 'rec' : (Object.hasOwn(keys(), a.id) ? 'custom' : ''),
          onclick: () => { rec = rec === a.id ? null : a.id; draw(); } }, rec === a.id ? 'Press keys…' : prettyCombo(combo));
        body.append(h('div.key-row', h('span', a.label), b));
      }
    };
    const onKey = (e) => {
      if (!rec) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { rec = null; draw(); return; }
      const combo = e.key === 'Backspace' ? '' : eventCombo(e); if (e.key !== 'Backspace' && !combo) return;
      const clash = conflictFor(rec, combo, keys());
      if (clash) { core.toast(`${prettyCombo(combo)} is already used by “${clash.label}”.`, 3500); return; }
      core.setPref('keys', { ...keys(), [rec]: combo }); rec = null; draw();
    };
    document.addEventListener('keydown', onKey, true);
    draw();
    dialog({ title: 'Keyboard shortcuts', wide: true, body: [note, body],
      actions: [{ label: 'Reset all', run: () => { core.setPref('keys', {}); draw(); return false; } }, { label: 'Done', variant: 'filled' }],
      onClose: () => document.removeEventListener('keydown', onKey, true) });
  };
  const aboutDialog = () => dialog({ title: 'About EasyMV', body: [h('p', 'EasyMV v0.5. A music-video maker that runs entirely in your browser: Rust and WebAssembly for the sound analysis, WebGL2 for the picture, WebCodecs for the export.'),
    h('p.muted', 'Panels by Dockview (MIT). Icons from Material Symbols (Apache-2.0).')], actions: [{ label: 'Close', variant: 'filled' }] });

  // ---------- dockview ----------
  const created = [];
  api = dv.createDockview(dockHost, {
    className: 'dockview-theme-easymv',
    theme: { name: 'easymv', className: 'dockview-theme-easymv' },
    createComponent: ({ name }) => {
      const wrap = h('div.dv-panel-wrap');
      const comp = { element: wrap, init: () => { wrap.append(instance(name).element); }, dispose: () => { if (wrap.firstChild === instances.get(name)?.element) wrap.firstChild.remove(); } };
      created.push(comp);
      return comp;
    },
  });
  api.onDidLayoutChange?.(autosave);
  new ResizeObserver(() => { api.layout(dockHost.clientWidth, dockHost.clientHeight); }).observe(dockHost);

  shell.api = api; shell.loadWorkspace = loadWorkspace; shell.commands = commands; shell.menus = menus;
  shell.start = () => {
    fillWsSelect();
    if (phoneMq.matches) { phone = false; enterPhone(); } else loadWorkspace(currentWs);
  };
  shell.isPhone = () => phone;
  return shell;
}
