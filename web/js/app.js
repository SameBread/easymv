// EasyMV app wiring: file intake, analysis, routing UI, preview, editing, undo/redo, export.

import { initEngine, wasm, EngineBridge } from './engine.js';
import { Renderer } from './renderer.js';
import { loadAsset } from './assets.js';
import { buildPlan, PROPERTY_NAMES } from './animation.js';
import { probeCodecs, openOutput, runExport, estimateOutputBytes, isLikelyMobile } from './exporter.js';
import { History } from './history.js';
import { Meter, valueAtFrame, isSilent } from './meters.js';
import { hitTest, itemQuad, nudgeBase } from './interact.js';
import { PRESETS, applyPreset, demoElementDefs, demoFiles } from './presets.js';
import { packBundle, unpackBundle } from './bundle.js';

const $ = (id) => document.getElementById(id);
const FEATURES = ['rms', 'low', 'mid', 'high', 'onset', 'centroid'];
const CURVES = ['linear', 'easeIn', 'easeOut', 'smoothstep', 'threshold'];
const COMBINES = ['add', 'multiply', 'replace', 'max', 'min'];
const EXPORT_WARN_SECONDS = 180;
const MB = 1024 * 1024;

const state = {
  files: new Map(),      // project path -> File (element assets)
  masterFile: null,
  stemFiles: [],         // {id, file}
  project: null,
  engine: null,
  bridge: null,
  assets: [],            // parallel to project.elements
  renderer: null,
  frame: 0,
  playing: false,
  audioCtx: null,
  audioSrc: null,
  playStart: 0,
  drawing: false,
  abort: null,
  exporting: false,
  selected: null,        // selected element id
  lastPlan: null,
  meters: [],
  seriesCache: new Map(),
};

const history = new History(200);
const assetCache = new Map(); // element id -> { sig, asset }  (kept after removal so undo is instant)

const ext = (name) => (name.split('.').pop() || '').toLowerCase();
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const slug = (s) => s.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '') || 'item';
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function uniqueId(base, taken) {
  let id = base; let n = 2;
  while (taken.has(id) || id === 'master') id = `${base}_${n++}`;
  return id;
}

function showFatal(msg) { const b = $('fatal'); b.textContent = msg; b.hidden = !msg; }

let toastTimer = 0;
function toast(msg, ms = 2400) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function setSelect(sel, value) {
  const v = String(value);
  if (![...sel.options].some((o) => o.value === v)) sel.add(new Option(v, v));
  sel.value = v;
}

// ---------- project model ----------

function newProject() {
  return {
    version: 4,
    videoFps: Number($('fps').value),
    analysisRate: Number($('ar').value),
    sampleRate: Number($('sr').value),
    resolution: [even(Number($('w').value)), even(Number($('h').value))],
    masterMix: { path: state.masterFile?.name ?? 'master', label: 'Master Mix' },
    stems: state.stemFiles.map((s) => ({ id: s.id, path: s.file.name, label: s.id })),
    elements: [],
    connections: [],
  };
}

/** Project as the engine should see it (UI-only fields removed). */
function strip(p) {
  return { ...p, elements: p.elements.map(({ _error, ...el }) => el) };
}

function refreshAudioSettings() {
  const p = state.project;
  p.analysisRate = Number($('ar').value);
  p.sampleRate = Number($('sr').value);
  p.masterMix = { path: state.masterFile?.name ?? 'master', label: 'Master Mix' };
  p.stems = state.stemFiles.map((s) => ({ id: s.id, path: s.file.name, label: s.id }));
}

// ---------- undo / redo ----------

function snapshot() {
  const p = state.project;
  return JSON.stringify({ videoFps: p.videoFps, resolution: p.resolution, elements: strip(p).elements, connections: p.connections });
}

function updateHistoryButtons() {
  $('undo').disabled = !history.canUndo;
  $('redo').disabled = !history.canRedo;
  $('undo').title = history.canUndo ? `Undo: ${history.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
  $('redo').title = history.canRedo ? `Redo: ${history.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo';
}

function commit(label, key = null) {
  if (!state.project) return;
  history.push(snapshot(), label, key);
  updateHistoryButtons();
}

function resetHistory() { history.reset(snapshot()); updateHistoryButtons(); }

async function restore(snapStr) {
  const snap = JSON.parse(snapStr);
  const p = state.project;
  const resChanged = snap.resolution[0] !== p.resolution[0] || snap.resolution[1] !== p.resolution[1];
  p.videoFps = snap.videoFps; p.resolution = snap.resolution;
  p.elements = snap.elements; p.connections = snap.connections;
  setSelect($('fps'), p.videoFps);
  syncResolutionInputs();
  await syncAssets();
  if (state.selected && !p.elements.some((e) => e.id === state.selected)) state.selected = null;
  if (resChanged && state.engine) await rebuildRenderer();
  renderElements(); renderConns(); recompile();
}

let chain = Promise.resolve();
function step(kind) {
  chain = chain.then(async () => {
    const r = kind === 'undo' ? history.undo() : history.redo();
    if (!r) return;
    await restore(r.state);
    updateHistoryButtons();
    toast(`${kind === 'undo' ? 'Undid' : 'Redid'}: ${r.label}`);
  }).catch((e) => showFatal(`${kind} failed: ${e.message ?? e}`));
}
$('undo').onclick = () => step('undo');
$('redo').onclick = () => step('redo');

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if (mod && key === 'z') { e.preventDefault(); step(e.shiftKey ? 'redo' : 'undo'); }
  else if (mod && key === 'y') { e.preventDefault(); step('redo'); }
  else if (key === ' ' && !typing && e.target.tagName !== 'BUTTON' && state.bridge) { e.preventDefault(); $('play').click(); }
  else if ((key === 'delete') && !typing && state.selected) { e.preventDefault(); removeElement(state.selected); }
});

// ---------- audio intake ----------

$('master').onchange = (e) => {
  state.masterFile = e.target.files[0] ?? null;
  invalidateAnalysis();
};

$('stems').onchange = (e) => {
  const taken = new Set(state.stemFiles.map((s) => s.id));
  for (const f of e.target.files) {
    const id = uniqueId(slug(f.name), taken);
    state.stemFiles.push({ id, file: f }); taken.add(id);
  }
  e.target.value = '';
  stemsChanged();
};

/** Stem changes alter what connections can refer to, so they restart undo history. */
function stemsChanged() {
  refreshAudioSettings();
  invalidateAnalysis();
  renderStems(); renderConns();
  resetHistory();
}

function renderStems() {
  const ul = $('stemList');
  ul.replaceChildren();
  for (const s of state.stemFiles) {
    const li = document.createElement('li');
    const name = document.createElement('input');
    name.value = s.id;
    name.onchange = () => {
      const clash = state.stemFiles.some((o) => o !== s && o.id === name.value) || name.value === 'master' || !name.value;
      if (clash) { name.value = s.id; return; }
      const old = s.id; s.id = name.value;
      for (const c of state.project.connections) if (c.source === old) c.source = s.id;
      stemsChanged();
      toast('Stem changes clear the undo history.');
    };
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.onclick = () => {
      state.stemFiles = state.stemFiles.filter((o) => o !== s);
      state.project.connections = state.project.connections.filter((c) => c.source !== s.id);
      stemsChanged();
      toast('Stem removed (its connections too). Undo history cleared.');
    };
    li.append(name, rm);
    ul.append(li);
  }
}

function invalidateAnalysis() {
  stop();
  state.engine?.free?.();
  state.engine = null; state.bridge = null;
  state.seriesCache.clear();
  renderSignals();
  $('analyze').textContent = 'Analyze audio';
  refreshButtons();
}

function refreshButtons() {
  const ready = !!state.bridge;
  $('analyze').disabled = !state.masterFile;
  $('quick').disabled = !state.masterFile;
  for (const id of ['play', 'scrub', 'export', 'auto', 'addConn', 'presetApply']) $(id).disabled = !ready;
}

async function analyze() {
  showFatal('');
  try {
    refreshAudioSettings();
    $('analyze').disabled = true; $('quick').disabled = true;
    const prog = $('analyzeProg'); prog.hidden = false; prog.value = 0;
    state.engine?.free?.();
    const engine = new wasm.Engine(JSON.stringify(strip(state.project)));
    const read = async (f) => new Uint8Array(await f.arrayBuffer());
    engine.load_master(await read(state.masterFile), ext(state.masterFile.name));
    for (const s of state.stemFiles) engine.load_stem(s.id, await read(s.file), ext(s.file.name));
    const total = engine.analysis_pending();
    while (engine.analysis_pending() > 0) {
      engine.analysis_step();
      prog.value = 1 - engine.analysis_pending() / total;
      await new Promise((r) => setTimeout(r, 0)); // let the UI paint
    }
    prog.hidden = true;
    state.engine = engine;
    state.bridge = new EngineBridge(engine);
    state.seriesCache.clear();
    await rebuildRenderer();
    recompile();
    renderSignals();
    const pr = state.project;
    const mi = state.bridge.masterInfo;
    probeCodecs({ width: pr.resolution[0], height: pr.resolution[1], fps: pr.videoFps, sampleRate: mi.sampleRate, channels: mi.channels })
      .then((r) => { $('codec').textContent = `Output: ${r.label}`; })
      .catch((e) => { $('codec').textContent = e.message; });
    $('analyze').textContent = 'Re-analyze';
    refreshButtons();
    seek(0);
    return true;
  } catch (e) {
    showFatal(`Analysis failed: ${e.message ?? e}`);
    $('analyzeProg').hidden = true;
    refreshButtons();
    return false;
  }
}
$('analyze').onclick = analyze;

// ---------- assets (cached by signature so undo/redo never reloads needlessly) ----------

const assetSig = (d) => JSON.stringify([d.type, d.path, d.zipPath, d.frameWidth, d.frameHeight, d.columns, d.rows, d.frameCount, d.padding, d.frameOrder]);

async function syncAssets() {
  const els = state.project.elements;
  const next = [];
  for (const def of els) {
    const sig = assetSig(def);
    const hit = assetCache.get(def.id);
    if (hit && hit.sig === sig) { hit.asset.def = def; def._error = null; next.push(hit.asset); continue; }
    if (hit) { state.renderer?.dropAsset(def.id); hit.asset.dispose?.(); assetCache.delete(def.id); }
    try {
      const asset = await loadAsset(def, state.files, wasm);
      assetCache.set(def.id, { sig, asset });
      def._error = null;
      next.push(asset);
    } catch (e) {
      def._error = e.message ?? String(e);
      next.push(null);
    }
  }
  state.assets = next;
  // Bound memory held for removed elements (undo still covers the most recent ones).
  const live = new Set(els.map((e) => e.id));
  const stale = [...assetCache.keys()].filter((k) => !live.has(k));
  for (const k of stale.slice(0, Math.max(0, stale.length - 12))) {
    assetCache.get(k).asset.dispose?.(); state.renderer?.dropAsset(k); assetCache.delete(k);
  }
}

// ---------- elements ----------

async function addElementFiles(fileList) {
  const p = state.project;
  const taken = new Set(p.elements.map((el) => el.id));
  const names = [];
  for (const f of fileList) {
    const x = ext(f.name);
    const id = uniqueId(slug(f.name), taken); taken.add(id);
    const z = p.elements.length;
    let def;
    if (x === 'gif') def = { id, type: 'gif', path: f.name, loopMode: 'loop', zIndex: z };
    else if (x === 'zip') def = { id, type: 'frameSequence', zipPath: f.name, internalFps: 12, loopMode: 'loop', interpolate: false, zIndex: z };
    else def = { id, type: 'static', path: f.name, zIndex: z };
    // A new file with a name we already hold replaces it: drop anything decoded from the old one.
    if (state.files.has(f.name) && state.files.get(f.name) !== f) {
      for (const [k, c] of assetCache) if (assetSig(c.asset.def).includes(JSON.stringify(f.name))) { c.asset.dispose?.(); state.renderer?.dropAsset(k); assetCache.delete(k); }
    }
    state.files.set(f.name, f);
    p.elements.push(def); names.push(id);
  }
  await syncAssets();
  renderElements(); recompile();
  commit(`Add ${names.join(', ')}`);
}

$('addEl').onchange = async (e) => { await addElementFiles([...e.target.files]); e.target.value = ''; };

async function addDemoVisuals() {
  const files = await demoFiles();
  for (const [name, f] of Object.entries(files)) state.files.set(name, f);
  const defs = demoElementDefs(new Set(state.project.elements.map((e) => e.id)));
  const z0 = Math.max(0, ...state.project.elements.map((e) => e.zIndex ?? 0));
  defs.forEach((d) => { if (d.zIndex > 0) d.zIndex = z0 + 1; });
  state.project.elements.push(...defs);
  await syncAssets();
  renderElements(); recompile();
  commit('Add demo visuals');
}
$('demo').onclick = addDemoVisuals;

function removeElement(id) {
  const p = state.project;
  p.elements = p.elements.filter((e) => e.id !== id);
  p.connections = p.connections.filter((c) => c.element !== id);
  if (state.selected === id) state.selected = null;
  syncAssets().then(() => { renderElements(); renderConns(); recompile(); commit(`Remove ${id}`); });
}

function select(id) {
  if (state.selected === id) return;
  state.selected = id;
  renderElements();
  updateSelection();
}

async function elementEdited(label) {
  await syncAssets();
  renderElements(); recompile();
  commit(label);
}

function numField(def, key, label, step = 1) {
  const l = document.createElement('label');
  l.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'number'; inp.step = step; inp.value = def[key] ?? '';
  inp.onchange = () => { def[key] = inp.value === '' ? undefined : Number(inp.value); elementEdited(`Edit ${def.id} ${label}`); };
  l.append(inp);
  return l;
}

function selField(def, key, label, options) {
  const l = document.createElement('label');
  l.textContent = label;
  const s = document.createElement('select');
  for (const o of options) s.add(new Option(o, o, false, (def[key] ?? options[0]) === o));
  s.onchange = () => { def[key] = s.value; elementEdited(`Edit ${def.id} ${label}`); };
  l.append(s);
  return l;
}

function note(text, cls) { const n = document.createElement('div'); n.className = `issue ${cls}`; n.textContent = text; return n; }

function renderElements() {
  const box = $('elements');
  box.replaceChildren();
  const p = state.project;
  p.elements.forEach((def, i) => {
    const d = document.createElement('div');
    d.className = `el${state.selected === def.id ? ' selected' : ''}`;
    const h = document.createElement('h3');
    h.textContent = `${def.id} `;
    h.onclick = () => select(state.selected === def.id ? null : def.id);
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = def.type; h.append(tag);
    const rm = document.createElement('button'); rm.textContent = '✕'; rm.style.float = 'right';
    rm.onclick = (ev) => { ev.stopPropagation(); removeElement(def.id); };
    h.append(rm);
    d.append(h);

    const f = document.createElement('div'); f.className = 'fields';
    if (def.type === 'static') {
      const l = document.createElement('label'); l.textContent = 'Treat as';
      const s = document.createElement('select');
      s.add(new Option('static image', 'static')); s.add(new Option('sprite sheet', 'spriteSheet'));
      s.onchange = () => {
        def.type = s.value;
        if (s.value === 'spriteSheet') Object.assign(def, { frameWidth: 64, frameHeight: 64, columns: 4, rows: 4, frameCount: 16, internalFps: 12, padding: 0, loopMode: 'loop', interpolate: false });
        elementEdited(`Edit ${def.id} type`);
      };
      l.append(s); f.append(l);
    }
    if (def.type === 'spriteSheet') {
      f.append(numField(def, 'frameWidth', 'frame W'), numField(def, 'frameHeight', 'frame H'),
        numField(def, 'columns', 'columns'), numField(def, 'rows', 'rows'),
        numField(def, 'frameCount', 'frames'), numField(def, 'padding', 'padding px'));
    }
    if (def.type === 'spriteSheet' || def.type === 'frameSequence') f.append(numField(def, 'internalFps', 'anim fps', 0.5));
    if (def.type !== 'static') f.append(selField(def, 'loopMode', 'loop', ['loop', 'once', 'pingPong']));
    f.append(numField(def, 'zIndex', 'z-index'));
    f.append(selField(def, 'visualBlend', 'blend', ['normal', 'add', 'multiply']));
    f.append(selField(def, 'fit', 'fit', def.type === 'static' ? ['cover', 'contain', 'natural'] : ['natural', 'contain', 'cover']));
    if (def.type === 'spriteSheet') f.append(selField(def, 'filter', 'filter', ['linear', 'nearest']));
    d.append(f);

    if (def.type === 'spriteSheet' || def.type === 'frameSequence') {
      const lab = document.createElement('label'); lab.className = 'muted';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!def.interpolate;
      cb.onchange = () => { def.interpolate = cb.checked; elementEdited(`Edit ${def.id} crossfade`); };
      lab.append(cb, ' crossfade frames');
      d.append(lab);
      if (def.interpolate) d.append(note('Crossfading hand-drawn frames can produce ghosting.', 'warning'));
    }
    const asset = state.assets[i];
    if (def.type === 'frameSequence' && asset) {
      const th = document.createElement('div'); th.className = 'thumbs';
      const btn = document.createElement('button'); btn.textContent = 'Reorder frames…';
      btn.onclick = () => openReorder(i);
      th.append(btn);
      d.append(th);
      d.append(note(`${asset.frameCount} frames, ${asset.width}×${asset.height}${def.frameOrder ? ' (custom order)' : ''}`, 'muted'));
      asset.thumbnails().then((bmps) => {
        for (const b of bmps) {
          if (!th.isConnected) { b.close(); continue; }
          const c = document.createElement('canvas'); c.width = b.width; c.height = b.height;
          c.getContext('2d').drawImage(b, 0, 0); b.close(); th.prepend(c);
        }
        // keep the button last
        th.append(btn);
      }).catch(() => {});
    }
    if (def._error) d.append(note(def._error, 'error'));
    box.append(d);
  });
}

// ---------- frame-sequence reorder dialog ----------

function openReorder(i) {
  const asset = state.assets[i]; const def = state.project.elements[i];
  if (!asset) return;
  const n = asset.frameCount;
  const dlg = $('reorder'); const grid = $('reorderGrid');
  // order[position] = natural-order index (same convention as the project's frameOrder)
  let order = def.frameOrder?.length === n ? [...def.frameOrder] : [...Array(n).keys()];
  const tiles = new Map();
  const move = (nat, to) => {
    const from = order.indexOf(nat);
    to = Math.max(0, Math.min(n - 1, to));
    if (from === to) return;
    order.splice(from, 1); order.splice(to, 0, nat);
    render();
  };
  const makeTile = (nat) => {
    const t = document.createElement('div'); t.className = 'tile'; t.draggable = true;
    const c = document.createElement('canvas'); c.width = 72; c.height = Math.max(1, Math.round((72 * asset.height) / asset.width));
    const label = document.createElement('div'); label.className = 'lbl';
    const mv = document.createElement('div'); mv.className = 'mv';
    const l = document.createElement('button'); l.textContent = '◀'; l.onclick = () => move(nat, order.indexOf(nat) - 1);
    const r = document.createElement('button'); r.textContent = '▶'; r.onclick = () => move(nat, order.indexOf(nat) + 1);
    mv.append(l, r);
    t.append(c, label, mv);
    t.ondragstart = (e) => e.dataTransfer.setData('text/plain', String(nat));
    t.ondragover = (e) => { e.preventDefault(); t.classList.add('over'); };
    t.ondragleave = () => t.classList.remove('over');
    t.ondrop = (e) => { e.preventDefault(); t.classList.remove('over'); move(Number(e.dataTransfer.getData('text/plain')), order.indexOf(nat)); };
    t.label = label; t.canvas = c;
    return t;
  };
  const render = () => {
    grid.replaceChildren();
    order.forEach((nat, pos) => {
      if (!tiles.has(nat)) tiles.set(nat, makeTile(nat));
      const t = tiles.get(nat);
      t.label.textContent = `${pos + 1}${nat !== pos ? ` (was ${nat + 1})` : ''}`;
      grid.append(t);
    });
  };
  render();
  (async () => {
    for (let nat = 0; nat < n && dlg.open; nat++) {
      const b = await asset.naturalThumb(nat);
      const c = tiles.get(nat).canvas; c.width = b.width; c.height = b.height;
      c.getContext('2d').drawImage(b, 0, 0); b.close();
    }
  })();
  $('reorderReset').onclick = () => { order = [...Array(n).keys()]; render(); };
  $('reorderCancel').onclick = () => dlg.close();
  $('reorderApply').onclick = async () => {
    const identity = order.every((v, k) => v === k);
    if (identity) delete def.frameOrder; else def.frameOrder = order;
    dlg.close();
    await elementEdited(`Reorder frames of ${def.id}`);
  };
  dlg.showModal();
}

// ---------- routing UI ----------

function renderConns() {
  const box = $('conns');
  box.replaceChildren();
  const p = state.project;
  const sources = ['master', ...state.stemFiles.map((s) => s.id)];
  p.connections.forEach((c, i) => {
    const d = document.createElement('div'); d.className = 'conn';
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = c.origin ?? 'user';
    const edited = () => { c.origin = 'user'; tag.textContent = 'user'; recompile(); commit('Edit connection'); };
    const sel = (key, opts) => {
      const l = document.createElement('label'); l.textContent = key;
      const s = document.createElement('select');
      const list = opts.includes(c[key]) ? opts : [c[key], ...opts]; // keep unknown values visible
      for (const o of list) s.add(new Option(o, o, false, c[key] === o));
      s.onchange = () => { c[key] = s.value; edited(); if (key === 'curve') renderConns(); };
      l.append(s); return l;
    };
    const num = (key, step = 0.01) => {
      const l = document.createElement('label'); l.textContent = key;
      const n = document.createElement('input'); n.type = 'number'; n.step = step; n.value = c[key] ?? 0;
      n.onchange = () => { c[key] = Number(n.value); edited(); };
      l.append(n); return l;
    };
    d.append(sel('source', sources), sel('feature', FEATURES),
      sel('element', p.elements.map((e) => e.id)), sel('property', PROPERTY_NAMES),
      sel('curve', CURVES), sel('combine', COMBINES), num('outMin'), num('outMax'),
      num('attackMs', 5), num('releaseMs', 10));
    if (c.curve === 'threshold') d.append(num('threshold'));
    const foot = document.createElement('div'); foot.className = 'full';
    const rm = document.createElement('button'); rm.textContent = 'Remove';
    rm.onclick = () => { p.connections.splice(i, 1); renderConns(); recompile(); commit('Remove connection'); };
    foot.append(tag, rm); d.append(foot);
    box.append(d);
  });
}

$('addConn').onclick = () => {
  const p = state.project;
  if (!p.elements.length) { toast('Add an element first.'); return; }
  p.connections.push({
    source: 'master', feature: 'rms', element: p.elements[0].id, property: 'scale',
    curve: 'linear', outMin: 0, outMax: 0.1, combine: 'add', attackMs: 10, releaseMs: 200, origin: 'user',
  });
  renderConns(); recompile(); commit('Add connection');
};

function runAuto() {
  const out = JSON.parse(wasm.auto_mode(JSON.stringify(strip(state.project))));
  state.project.connections = out.connections;
  renderConns(); recompile();
}

$('auto').onclick = () => {
  try { runAuto(); commit('Automatic mode'); } catch (e) { showFatal(`Automatic mode failed: ${e.message ?? e}`); }
};

for (const [k, v] of Object.entries(PRESETS)) $('presetSel').add(new Option(v.label, k));
$('presetApply').onclick = () => {
  const key = $('presetSel').value;
  const added = applyPreset(state.project, key);
  if (!added) { toast('Add an element first.'); return; }
  renderConns(); recompile(); commit(`Add preset: ${PRESETS[key].label.split(' — ')[0]}`);
};

function recompile() {
  const p = state.project;
  const issues = JSON.parse(wasm.validate_project(JSON.stringify(strip(p))));
  let compileIssues = [];
  if (state.engine) {
    try {
      compileIssues = JSON.parse(state.engine.compile(JSON.stringify(strip(p))));
      state.bridge.refreshView();
      const total = state.bridge.totalFrames;
      $('scrub').max = Math.max(0, total - 1);
      state.frame = Math.min(state.frame, Math.max(0, total - 1));
    } catch (e) {
      compileIssues = [{ severity: 'error', message: e.message ?? String(e) }];
    }
  }
  const seen = new Set();
  const box = $('issues'); box.replaceChildren();
  for (const i of [...issues, ...compileIssues]) {
    if (seen.has(i.message)) continue; seen.add(i.message);
    box.append(note(i.message, i.severity));
  }
  updateGpu();
  requestDraw();
}

// ---------- settings ----------

function syncResolutionInputs() {
  const [w, h] = state.project.resolution;
  $('w').value = w; $('h').value = h;
  const key = `${w}x${h}`;
  $('res').value = [...$('res').options].some((o) => o.value === key) ? key : 'custom';
}

async function setResolution(w, h) {
  state.project.resolution = [even(w), even(h)];
  syncResolutionInputs();
  if (state.engine) await rebuildRenderer();
  recompile();
  commit('Change resolution');
}
$('res').onchange = () => { if ($('res').value !== 'custom') { const [w, h] = $('res').value.split('x').map(Number); setResolution(w, h); } };
$('w').onchange = () => setResolution(Number($('w').value), Number($('h').value));
$('h').onchange = () => setResolution(Number($('w').value), Number($('h').value));
$('fps').onchange = () => { state.project.videoFps = Number($('fps').value); recompile(); commit('Change frame rate'); };
for (const id of ['sr', 'ar']) $(id).onchange = () => { refreshAudioSettings(); invalidateAnalysis(); };
$('budget').onchange = () => { state.renderer?.setBudgetMB(Number($('budget').value)); };

// ---------- save / load ----------

function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

$('saveProj').onclick = () => {
  download(new Blob([JSON.stringify(strip(state.project), null, 2)], { type: 'application/json' }), 'project.easymv.json');
};

$('saveBundle').onclick = async () => {
  try {
    refreshAudioSettings();
    const files = new Map(state.files);
    if (state.masterFile) files.set(state.masterFile.name, state.masterFile);
    for (const s of state.stemFiles) files.set(s.file.name, s.file);
    toast('Packing bundle…', 8000);
    const { blob, missing } = await packBundle(strip(state.project), files);
    download(blob, 'project.easymv.zip');
    toast(missing.length ? `Saved, but missing: ${missing.join(', ')}` : `Bundle saved (${(blob.size / MB).toFixed(1)} MB)`, 5000);
  } catch (e) { showFatal(`Could not save bundle: ${e.message ?? e}`); }
};

async function adoptProject(p, bundleFiles) {
  const errs = JSON.parse(wasm.validate_project(JSON.stringify(p))).filter((i) => i.severity === 'error');
  if (errs.length) throw new Error(errs.map((i) => i.message).join('\n'));
  invalidateAnalysis();
  for (const c of assetCache.values()) c.asset.dispose?.();
  assetCache.clear();
  state.renderer?.dispose(); state.renderer = null;
  if (bundleFiles) {
    for (const [k, f] of bundleFiles) state.files.set(k, f);
    state.masterFile = bundleFiles.get(p.masterMix.path) ?? null;
    state.stemFiles = p.stems.map((s) => ({ id: s.id, file: bundleFiles.get(s.path) })).filter((s) => s.file);
  }
  state.project = p;
  state.selected = null;
  setSelect($('fps'), p.videoFps); setSelect($('sr'), p.sampleRate); setSelect($('ar'), p.analysisRate);
  syncResolutionInputs();
  await syncAssets();
  renderStems(); renderElements(); renderConns(); recompile();
  resetHistory();
  refreshButtons();
}

$('loadProj').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  showFatal('');
  try {
    if (/\.zip$/i.test(f.name)) {
      const { project, files } = await unpackBundle(f);
      await adoptProject(project, files);
      if (state.masterFile) await analyze(); else showFatal('Bundle has no master mix file.');
    } else {
      await adoptProject(JSON.parse(await f.text()), null);
      const p = state.project;
      showFatal(`Project loaded. Re-select its audio (master: ${p.masterMix.path}; stems: ${p.stems.map((s) => s.path).join(', ') || 'none'}) and any element files by name. ` +
        'Tip: "Save bundle (.zip)" avoids this.');
    }
  } catch (err) { showFatal(`Could not load project: ${err.message ?? err}`); }
};

// ---------- preview ----------

async function rebuildRenderer() {
  state.renderer?.dispose();
  const [w, h] = state.project.resolution;
  state.renderer = new Renderer($('view'), { width: w, height: h, budgetMB: Number($('budget').value) });
  $('view').style.aspectRatio = `${w} / ${h}`;
}

function updateGpu() {
  if (!state.renderer) return;
  const u = state.renderer.usage;
  $('gpu').textContent = `GPU texture cache: ${(u.used / MB).toFixed(0)} / ${(u.budget / MB).toFixed(0)} MB`;
}

async function drawFrame(f) {
  if (!state.bridge || !state.renderer) return;
  state.bridge.evaluate(f, 1);
  const plan = buildPlan(state.assets, state.bridge.frameView.at(0), f, state.project.videoFps);
  await state.renderer.prepare(plan);
  state.renderer.draw(plan);
  state.lastPlan = plan;
  const fps = state.project.videoFps;
  const total = state.bridge.totalFrames;
  $('time').textContent = `${fmtTime(f / fps)} / ${fmtTime(total / fps)}`;
  $('scrub').value = f;
  updateGpu();
  updateSelection();
  updateSignals(f);
}

let pending = false;
function requestDraw() {
  if (state.drawing) { pending = true; return; }
  state.drawing = true;
  drawFrame(state.frame).catch((e) => showFatal(`Render error: ${e.message ?? e}`)).finally(() => {
    state.drawing = false;
    if (pending) { pending = false; requestDraw(); }
  });
}

function seek(f) { state.frame = Math.max(0, Math.min(f, Math.max(0, (state.bridge?.totalFrames ?? 1) - 1))); requestDraw(); }
$('scrub').oninput = (e) => { if (state.playing) stop(); seek(Number(e.target.value)); };

async function play() {
  if (!state.bridge) return;
  const info = state.bridge.masterInfo;
  state.audioCtx ??= new AudioContext();
  await state.audioCtx.resume();
  const pcm = state.bridge.masterPcm();
  const buf = state.audioCtx.createBuffer(info.channels, info.frames, info.sampleRate);
  for (let c = 0; c < info.channels; c++) {
    const plane = new Float32Array(info.frames);
    for (let i = 0; i < info.frames; i++) plane[i] = pcm[i * info.channels + c];
    buf.copyToChannel(plane, c);
  }
  const fps = state.project.videoFps;
  const offset = state.frame / fps;
  state.audioSrc = state.audioCtx.createBufferSource();
  state.audioSrc.buffer = buf;
  state.audioSrc.connect(state.audioCtx.destination);
  state.playStart = state.audioCtx.currentTime - offset;
  state.audioSrc.start(0, offset);
  state.playing = true;
  $('play').textContent = '⏸';
  const tick = () => {
    if (!state.playing) return;
    const f = Math.floor((state.audioCtx.currentTime - state.playStart) * fps);
    if (f >= state.bridge.totalFrames) { stop(); seek(0); return; }
    if (f !== state.frame) { state.frame = f; requestDraw(); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stop() {
  state.playing = false;
  try { state.audioSrc?.stop(); } catch { /* not started */ }
  state.audioSrc = null;
  $('play').textContent = '▶';
}
$('play').onclick = () => (state.playing ? stop() : play());

// ---------- signal meters ----------

function getSeries(id, fi) {
  const key = `${id}:${fi}`;
  let s = state.seriesCache.get(key);
  if (!s) { s = state.engine.feature_series(id, fi); state.seriesCache.set(key, s); }
  return s;
}

function renderSignals() {
  const box = $('signals');
  box.replaceChildren();
  state.meters = [];
  $('signalsPanel').hidden = !state.engine;
  if (!state.engine) return;
  const css = getComputedStyle(document.documentElement);
  const colors = { wave: css.getPropertyValue('--mut').trim() || '#888', head: css.getPropertyValue('--acc').trim() || '#f69' };
  const ids = JSON.parse(state.engine.source_ids());
  for (const id of ids) {
    const wrap = document.createElement('div'); wrap.className = 'sig';
    const top = document.createElement('div'); top.className = 'top';
    const name = document.createElement('strong'); name.textContent = id;
    const fsel = document.createElement('select');
    FEATURES.forEach((f) => fsel.add(new Option(f, f)));
    const val = document.createElement('span'); val.className = 'val';
    top.append(name, fsel, val);
    const canvas = document.createElement('canvas');
    wrap.append(top, canvas); box.append(wrap);
    const m = { id, fi: 0, series: getSeries(id, 0), val };
    m.meter = new Meter(canvas, m.series, colors);
    fsel.onchange = () => { m.fi = FEATURES.indexOf(fsel.value); m.series = getSeries(id, m.fi); m.meter.setSeries(m.series); updateSignals(state.frame); };
    const seekTo = (e) => { const r = canvas.getBoundingClientRect(); if (state.playing) stop(); seek(Math.round(((e.clientX - r.left) / r.width) * (state.bridge.totalFrames - 1))); };
    canvas.onpointerdown = (e) => { canvas.setPointerCapture(e.pointerId); seekTo(e); canvas.onpointermove = seekTo; };
    canvas.onpointerup = () => { canvas.onpointermove = null; };
    state.meters.push(m);
  }
  updateSignals(state.frame);
}

function updateSignals(f) {
  if (!state.bridge || !state.meters.length) return;
  const total = Math.max(1, state.bridge.totalFrames - 1);
  const rate = state.engine.analysis_rate();
  const fps = state.project.videoFps;
  for (const m of state.meters) {
    m.meter.draw(f / total);
    m.val.textContent = isSilent(m.series) ? 'silent' : valueAtFrame(m.series, rate, fps, f).toFixed(2);
  }
}

// ---------- direct manipulation in the preview ----------

function updateSelection() {
  const svg = $('sel');
  svg.replaceChildren();
  if (!state.selected || !state.lastPlan || !state.renderer) return;
  const it = state.lastPlan.find((x) => x.asset.def.id === state.selected);
  if (!it) return;
  const { width: cw, height: ch } = state.renderer;
  svg.setAttribute('viewBox', `0 0 ${cw} ${ch}`);
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  poly.setAttribute('points', itemQuad(it, cw, ch).map((q) => q.join(',')).join(' '));
  svg.append(poly);
}

function baseEdited(label) {
  try { state.engine?.update_base(JSON.stringify(strip(state.project))); } catch { recompile(); }
  commit(label, `drag:${state.selected}`);
  requestDraw();
}

(() => {
  const stage = $('stage'); const canvas = $('view');
  const ptrs = new Map();
  let dragging = false;
  const selectedDef = () => state.project.elements.find((e) => e.id === state.selected);
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
        select(hit.asset.def.id); dragging = true;
        const id = hit.asset.def.id;
        if (state.project.connections.some((c) => c.element === id && c.combine === 'replace' && (c.property === 'positionX' || c.property === 'positionY'))) {
          toast("Position is driven by a 'replace' connection here, so dragging won't visibly move it.", 4000);
        }
      } else { select(null); dragging = false; }
    }
  });

  stage.addEventListener('pointermove', (e) => {
    const prev = ptrs.get(e.pointerId);
    if (!prev || !state.selected) return;
    const def = selectedDef(); if (!def) return;
    const r = canvas.getBoundingClientRect();
    if (ptrs.size === 1 && dragging) {
      nudgeBase(def, (e.clientX - prev.x) / r.width, (e.clientY - prev.y) / r.height);
      baseEdited(`Move ${def.id}`);
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.entries()];
      const other = a[0] === e.pointerId ? b[1] : a[1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 0) { nudgeBase(def, 0, 0, after / before); baseEdited(`Resize ${def.id}`); }
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });

  const up = (e) => { ptrs.delete(e.pointerId); if (!ptrs.size) dragging = false; };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);

  stage.addEventListener('wheel', (e) => {
    if (!state.selected) return; // let the page scroll when nothing is selected
    const def = selectedDef(); if (!def) return;
    e.preventDefault();
    nudgeBase(def, 0, 0, Math.exp(-e.deltaY * 0.0015));
    baseEdited(`Resize ${def.id}`);
  }, { passive: false });
})();

// ---------- quick start ----------

$('quick').onclick = async () => {
  if (!state.masterFile) { toast('Choose a master mix first.'); return; }
  if (!state.project.elements.length) await addDemoVisuals();
  if (!state.bridge && !(await analyze())) return;
  try { runAuto(); commit('Quick start'); } catch (e) { showFatal(`Automatic mode failed: ${e.message ?? e}`); return; }
  seek(0);
  await play();
  toast('Playing with automatic routing. Tweak anything, or export when happy.', 4000);
};

// ---------- export ----------

let wakeLock = null;
async function lockScreen() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported or denied */ } }
async function unlockScreen() { try { await wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (!state.exporting) return;
  if (document.hidden) $('exportMsg').textContent = 'This tab is hidden, so the browser may slow or pause the export. Switch back to keep it going.';
  else lockScreen();
});

$('export').onclick = async () => {
  showFatal('');
  const msg = $('exportMsg');
  try {
    stop();
    const p = state.project;
    const info = state.bridge.masterInfo;
    const probe = await probeCodecs({
      width: p.resolution[0], height: p.resolution[1], fps: p.videoFps,
      sampleRate: info.sampleRate, channels: info.channels,
    });
    $('codec').textContent = `Output: ${probe.label}`;
    const dur = state.bridge.totalFrames / p.videoFps;
    if (typeof window.showSaveFilePicker !== 'function') {
      const est = estimateOutputBytes({ width: p.resolution[0], height: p.resolution[1], fps: p.videoFps, durationSec: dur });
      const limit = isLikelyMobile() ? 300 * MB : 1500 * MB;
      if (dur > EXPORT_WARN_SECONDS || est > limit) {
        const lower = isLikelyMobile() ? ' Consider a smaller resolution such as 1280×720 or 720×1280.' : '';
        if (!confirm(`This browser buffers the whole file in memory (about ${(est / MB).toFixed(0)} MB). For long videos use Chrome or Edge on a computer.${lower}\n\nContinue anyway?`)) return;
      }
    }
    // The save picker needs the user gesture, so it opens before the long render.
    const output = await openOutput(probe.container);

    const canvas = document.createElement('canvas');
    const renderer = new Renderer(canvas, { width: p.resolution[0], height: p.resolution[1], budgetMB: Number($('budget').value) });
    state.abort = new AbortController();
    state.exporting = true;
    await lockScreen();
    $('export').hidden = true; $('cancel').hidden = false; $('exportProg').hidden = false;
    msg.textContent = 'Keep this tab open and in the foreground until the export finishes.';
    const t0 = performance.now();
    const result = await runExport({
      bridge: state.bridge, assets: state.assets, renderer, project: p, probe, output,
      audioOffsetMs: Number(localStorage.getItem('easymv.audioOffsetMs') ?? 0),
      signal: state.abort.signal,
      onProgress: (frac, f) => {
        $('exportProg').value = frac;
        if (f % 15 === 0 && !document.hidden) msg.textContent = `Frame ${f + 1} / ${state.bridge.totalFrames} (${((f + 1) / ((performance.now() - t0) / 1000)).toFixed(1)} fps)`;
      },
    });
    renderer.dispose();
    msg.textContent = result === 'done' ? `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s.` : 'Export cancelled; project unchanged.';
  } catch (e) {
    if (e?.name !== 'AbortError') showFatal(`Export failed: ${e.message ?? e}`);
  } finally {
    state.exporting = false;
    await unlockScreen();
    $('export').hidden = false; $('cancel').hidden = true; $('exportProg').hidden = true;
    state.bridge?.refreshView();
    requestDraw();
  }
};
$('cancel').onclick = () => state.abort?.abort();

// ---------- boot ----------

state.project = newProject();
resetHistory();
renderStems(); renderElements(); renderConns(); refreshButtons();

(async () => {
  try {
    await initEngine();
    recompile();
    if (typeof VideoEncoder === 'undefined') $('codec').textContent = 'WebCodecs unavailable: export will not work in this browser.';
  } catch (e) {
    showFatal(`Could not start the engine: ${e.message ?? e}. Did the WASM build run (npm run build:wasm)?`);
  }
})();
