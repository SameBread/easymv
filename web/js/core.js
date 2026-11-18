// EasyMV core: application state and every operation on it (no DOM). The UI panels read
// `state`, call these functions and listen for events; nothing here touches the page,
// which keeps the logic testable and lets any panel be docked anywhere.
//
// Events (see on/emit): project, selection, frame, engine, history, issues, toast, fatal, export.

import { initEngine, wasm, EngineBridge } from './engine.js';
import { Renderer } from './renderer.js';
import { loadAsset } from './assets.js';
import { buildPlan, PROPERTY_NAMES, P, PROPERTY_COUNT, isImageType, fitSize, defaultFit } from './animation.js';
import { probeCodecs, openOutput, runExport, estimateOutputBytes, isLikelyMobile } from './exporter.js';
import { History } from './history.js';
import { applyPreset, demoElementDefs, demoFiles } from './presets.js';
import { packBundle, unpackBundle } from './bundle.js';
import { VIS_DEFAULTS, VIS_PRESETS } from './visualizer.js';
import { FX_KINDS, FX_COMMON } from './effects.js';
import { LYRIC_DEFAULTS, lyricsSettings } from './lyrics.js';
import { SCRIPT_DEFAULTS, scriptSettings, applyMode, DEMO_PRESENTATION, DEMO_LYRICS } from './script.js';
import { linesToScript, scriptToLines, scriptToLrc } from './scripttext.js';
import { registerFont } from './textcanvas.js';
import * as TL from './timeline.js';
import { PROP_BY_NAME } from './props.js';

export const MB = 1024 * 1024;
export const EXPORT_WARN_SECONDS = 180;

// ---------- tiny event bus ----------

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, detail) { for (const fn of listeners.get(evt) ?? []) fn(detail); }

export const toast = (msg, ms = 2400) => emit('toast', { msg, ms });
export const fatal = (msg) => emit('fatal', { msg });

// ---------- state ----------

export const state = {
  files: new Map(),      // project path -> File (layer media, fonts)
  masterFile: null,
  stemFiles: [],         // {id, file}
  project: null,
  engine: null,
  bridge: null,
  assets: [],            // parallel to project.elements
  renderer: null,        // the preview renderer (the Preview panel owns the canvas)
  canvas: null,
  frame: 0,
  playing: false,
  selected: null,        // selected layer id
  lastPlan: null,
  frameValues: null,     // evaluated properties of the current frame (Float32Array)
  seriesCache: new Map(),
  specCache: new Map(),
  exporting: false,
  export: { frac: 0, msg: '' },
  beats: [],             // beat frames for timeline snapping
  prefs: loadPrefs(),
};

const history = new History(200);
const assetCache = new Map();
let audioCtx = null; let audioSrc = null; let playStart = 0;
const fontNames = new Set();

function loadPrefs() {
  const def = { theme: 'dark', accent: '#ff6b9d', budgetMB: 256, audioOffsetMs: 0, snap: true, autoKey: true, density: 'auto' };
  try { return { ...def, ...JSON.parse(localStorage.getItem('easymv.prefs') ?? '{}') }; } catch { return def; }
}
export function setPref(key, value) {
  state.prefs[key] = value;
  try { localStorage.setItem('easymv.prefs', JSON.stringify(state.prefs)); } catch { /* storage blocked */ }
  if (key === 'budgetMB') state.renderer?.setBudgetMB(Number(value));
  emit('prefs', { key, value });
}

// ---------- helpers ----------

export const ext = (name) => (name.split('.').pop() || '').toLowerCase();
export const slug = (s) => s.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '') || 'item';
export const even = (n) => Math.max(2, Math.round(n / 2) * 2);
export const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const fmtTimeMs = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor((s % 1) * 100)).padStart(2, '0')}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function uniqueId(base, taken) {
  let id = base; let n = 2;
  while (taken.has(id) || id === 'master') id = `${base}_${n++}`;
  return id;
}

export const layerById = (id) => state.project?.elements.find((e) => e.id === id) ?? null;
export const layerIndex = (id) => state.project?.elements.findIndex((e) => e.id === id) ?? -1;
export const layerName = (def) => def.name ?? def.id;
export const fps = () => state.project.videoFps;
export const totalFrames = () => state.bridge?.totalFrames ?? Math.round(30 * state.project.videoFps);
export const sources = () => ['master', ...state.stemFiles.map((s) => s.id)];

export const LAYER_TYPE_INFO = {
  static: { label: 'Image', icon: 'image' },
  spriteSheet: { label: 'Sprite sheet', icon: 'grid_view' },
  gif: { label: 'GIF', icon: 'gif_box' },
  frameSequence: { label: 'Frame sequence', icon: 'photo_library' },
  visualizer: { label: 'Visualizer', icon: 'graphic_eq' },
  effect: { label: 'Effect', icon: 'auto_awesome' },
  lyrics: { label: 'Closed captions', icon: 'closed_caption' },
  script: { label: 'Script', icon: 'slideshow' },
};

// ---------- project model ----------

export function newProject() {
  return {
    version: 5,
    videoFps: 30,
    analysisRate: 200,
    sampleRate: 44100,
    resolution: [1280, 720],
    masterMix: { path: 'master', label: 'Master Mix' },
    stems: [],
    elements: [],
    connections: [],
    tracks: [],
    sections: [],
  };
}

/** Bring older projects (v4: zIndex-ordered elements) up to the current model. */
export function migrate(p) {
  p.tracks ??= []; p.sections ??= []; p.connections ??= []; p.stems ??= [];
  if (!p.version || p.version < 5) {
    const order = p.elements.map((e, i) => [e, i]).sort((a, b) => (a[0].zIndex ?? 0) - (b[0].zIndex ?? 0) || a[1] - b[1]);
    p.elements = order.map(([e]) => { if ((e.zIndex ?? 0) < 0) e.background = true; return e; });
    p.version = 5;
  }
  normalize(p);
  return p;
}

/** Paint order is array order; zIndex is derived (negative = background) for automatic mode. */
export function normalize(p) {
  p.elements.forEach((e, i) => { e.zIndex = e.background ? -1 : i; });
}

/** Project as the engine should see it (UI-only data removed). */
export function strip(p) {
  const { sections, ...rest } = p;
  return {
    ...rest,
    // the engine only routes numbers: render-only choices (blend mode, script type) are hidden from it so an older engine build still accepts them
    elements: p.elements.map(({ _error, name, locked, background, vis, fx, lyrics, script, visualBlend, ...el }) => (el.type === 'script' ? { ...el, type: 'lyrics' } : el)),
    connections: p.connections.filter((c) => !c.muted).map(({ muted, ...c }) => c),
  };
}

// ---------- undo / redo ----------

function snapshot() {
  const p = state.project;
  const clean = (e) => { const { _error, ...rest } = e; return rest; };
  return JSON.stringify({ videoFps: p.videoFps, resolution: p.resolution, elements: p.elements.map(clean), connections: p.connections, tracks: p.tracks, sections: p.sections });
}

export const canUndo = () => history.canUndo;
export const canRedo = () => history.canRedo;
export const undoLabel = () => history.undoLabel;
export const redoLabel = () => history.redoLabel;

export function commit(label, key = null) {
  if (!state.project) return;
  history.push(snapshot(), label, key);
  emit('history');
}
function resetHistory() { history.reset(snapshot()); emit('history'); }

async function restore(snapStr) {
  const snap = JSON.parse(snapStr);
  const p = state.project;
  const resChanged = snap.resolution[0] !== p.resolution[0] || snap.resolution[1] !== p.resolution[1];
  Object.assign(p, { videoFps: snap.videoFps, resolution: snap.resolution, elements: snap.elements, connections: snap.connections, tracks: snap.tracks, sections: snap.sections });
  normalize(p);
  await syncAssets();
  if (state.selected && !layerById(state.selected)) select(null);
  if (resChanged && state.canvas) await rebuildRenderer();
  structural();
}

let chain = Promise.resolve();
function step(kind) {
  chain = chain.then(async () => {
    const r = kind === 'undo' ? history.undo() : history.redo();
    if (!r) return;
    await restore(r.state);
    emit('history');
    toast(`${kind === 'undo' ? 'Undid' : 'Redid'}: ${r.label}`);
  }).catch((e) => fatal(`${kind} failed: ${e.message ?? e}`));
  return chain;
}
export const undo = () => step('undo');
export const redo = () => step('redo');

// ---------- audio intake and analysis ----------

export function setMaster(file) {
  state.masterFile = file ?? null;
  refreshAudioSettings();
  invalidateAnalysis();
  emit('project', { audio: true });
}

export function addStems(files) {
  const taken = new Set(state.stemFiles.map((s) => s.id));
  for (const f of files) {
    const id = uniqueId(slug(f.name), taken);
    state.stemFiles.push({ id, file: f }); taken.add(id);
  }
  stemsChanged();
}

export function renameStem(id, next) {
  const clash = state.stemFiles.some((o) => o.id === next) || next === 'master' || !next;
  const s = state.stemFiles.find((o) => o.id === id);
  if (!s || clash) return false;
  s.id = next;
  for (const c of state.project.connections) if (c.source === id) c.source = next;
  for (const e of state.project.elements) if (e.vis?.source === id) e.vis.source = next;
  stemsChanged();
  toast('Stem changes clear the undo history.');
  return true;
}

export function removeStem(id) {
  state.stemFiles = state.stemFiles.filter((o) => o.id !== id);
  state.project.connections = state.project.connections.filter((c) => c.source !== id);
  for (const e of state.project.elements) if (e.vis?.source === id) e.vis.source = 'master';
  stemsChanged();
  toast('Stem removed (its connections too). Undo history cleared.');
}

function stemsChanged() {
  refreshAudioSettings();
  invalidateAnalysis();
  resetHistory();
  emit('project', { audio: true });
}

export function refreshAudioSettings() {
  const p = state.project;
  p.masterMix = { path: state.masterFile?.name ?? 'master', label: 'Master Mix' };
  p.stems = state.stemFiles.map((s) => ({ id: s.id, path: s.file.name, label: s.id }));
}

export function invalidateAnalysis() {
  stop();
  state.engine?.free?.();
  state.engine = null; state.bridge = null;
  state.seriesCache.clear(); state.specCache.clear();
  state.beats = [];
  emit('engine');
}

export async function analyze(onProgress) {
  fatal('');
  try {
    refreshAudioSettings();
    state.engine?.free?.();
    const engine = new wasm.Engine(JSON.stringify(strip(state.project)));
    const read = async (f) => new Uint8Array(await f.arrayBuffer());
    engine.load_master(await read(state.masterFile), ext(state.masterFile.name));
    for (const s of state.stemFiles) engine.load_stem(s.id, await read(s.file), ext(s.file.name));
    const total = engine.analysis_pending();
    while (engine.analysis_pending() > 0) {
      engine.analysis_step();
      onProgress?.(1 - engine.analysis_pending() / total);
      await new Promise((r) => setTimeout(r, 0));
    }
    state.engine = engine;
    state.bridge = new EngineBridge(engine);
    state.seriesCache.clear(); state.specCache.clear();
    await rebuildRenderer();
    recompile();
    state.beats = TL.peakFrames(getSeries('master', 4), engine.analysis_rate(), fps(), 0.5);
    emit('engine');
    seek(0);
    return true;
  } catch (e) {
    fatal(`Analysis failed: ${e.message ?? e}`);
    emit('engine');
    return false;
  }
}

export function getSeries(id, fi) {
  const key = `${id}:${fi}`;
  let s = state.seriesCache.get(key);
  if (!s) { s = state.engine.feature_series(id, fi); state.seriesCache.set(key, s); }
  return s;
}

function spectrumFor(src, bands) {
  if (!state.engine) return null;
  const key = `${src}:${bands}`;
  let s = state.specCache.get(key);
  if (!s) {
    const data = state.engine.spectrum_series(src, bands);
    s = data.length ? { data, bands, rate: state.engine.analysis_rate() } : null;
    state.specCache.set(key, s);
  }
  return s;
}

/** What the renderer needs from the audio engine (preview and export use the same provider). */
export function audioProvider() {
  const bridge = state.bridge;
  return {
    fps: fps(),
    spectrum: (src, bands) => spectrumFor(src, bands),
    pcm: (src) => {
      if (!bridge) return null;
      const info = bridge.masterInfo;
      if (src === 'master') return { data: bridge.masterPcm(), channels: info.channels, sampleRate: info.sampleRate };
      const m = bridge.sourceMono(src);
      return m ? { data: m, channels: 1, sampleRate: info.sampleRate } : null;
    },
  };
}

// ---------- assets ----------

const assetSig = (d) => JSON.stringify([d.type, d.path, d.zipPath, d.frameWidth, d.frameHeight, d.columns, d.rows, d.frameCount, d.padding, d.frameOrder]);

export async function syncAssets() {
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
  // fonts used by lyrics layers
  for (const def of els) {
    const s = def.lyrics?.style;
    if (s?.fontFile && !fontNames.has(s.font) && state.files.has(s.fontFile)) {
      try { await registerFont(s.font, state.files.get(s.fontFile)); fontNames.add(s.font); } catch (e) { def._error = `font: ${e.message ?? e}`; }
    }
  }
  for (const def of els) {
    for (const [name, path] of Object.entries(def.script?.fontFiles ?? {})) {
      if (!fontNames.has(name) && state.files.has(path)) {
        try { await registerFont(name, state.files.get(path)); fontNames.add(name); } catch (e) { def._error = `font: ${e.message ?? e}`; }
      }
    }
  }
  const live = new Set(els.map((e) => e.id));
  const stale = [...assetCache.keys()].filter((k) => !live.has(k));
  for (const k of stale.slice(0, Math.max(0, stale.length - 12))) {
    assetCache.get(k).asset.dispose?.(); state.renderer?.dropAsset(k); assetCache.delete(k);
  }
}

function dropCachedFor(fileName) {
  for (const [k, c] of assetCache) if (assetSig(c.asset.def).includes(JSON.stringify(fileName))) { c.asset.dispose?.(); state.renderer?.dropAsset(k); assetCache.delete(k); }
}

// ---------- layers ----------

function takenIds() { return new Set(state.project.elements.map((e) => e.id)); }

const OVERLAY_TYPES = new Set(['effect', 'visualizer', 'lyrics', 'script']);
/** Where a new layer goes: overlays (effects, visualizers, captions, scripts) always on top; pictures just above the
 *  topmost picture, so a new background never lands on top of your effects and text. */
export function insertIndexFor(def, els = state.project.elements) {
  if (OVERLAY_TYPES.has(def.type)) return els.length;
  let top = -1;
  els.forEach((e, i) => { if (!OVERLAY_TYPES.has(e.type)) top = i; });
  return top + 1;
}

async function pushLayers(defs, label, select_ = true) {
  const p = state.project;
  for (const d of defs) p.elements.splice(insertIndexFor(d), 0, d);
  normalize(p);
  await syncAssets();
  structural();
  if (select_ && defs.length) select(defs.at(-1).id);
  commit(label);
}

export async function addFiles(fileList) {
  const taken = takenIds();
  const defs = [];
  for (const f of fileList) {
    const x = ext(f.name);
    const id = uniqueId(slug(f.name), taken); taken.add(id);
    let def;
    if (x === 'gif') def = { id, type: 'gif', path: f.name, loopMode: 'loop' };
    else if (x === 'zip') def = { id, type: 'frameSequence', zipPath: f.name, internalFps: 12, loopMode: 'loop', interpolate: false };
    else if (['ttf', 'otf', 'woff', 'woff2'].includes(x)) { await addFontFile(f); continue; }
    else def = { id, type: 'static', path: f.name };
    def.name = slug(f.name);
    if (state.files.has(f.name) && state.files.get(f.name) !== f) dropCachedFor(f.name);
    state.files.set(f.name, f);
    defs.push(def);
  }
  if (defs.length) await pushLayers(defs, `Add ${defs.map((d) => d.id).join(', ')}`);
}

export async function addDemo() {
  const files = await demoFiles();
  for (const [name, f] of Object.entries(files)) state.files.set(name, f);
  const defs = demoElementDefs(takenIds());
  defs.forEach((d) => { if (d.zIndex < 0) d.background = true; });
  defs.forEach((d) => { d.name = d.id.replace('demo_', 'Demo '); });
  await pushLayers(defs, 'Add demo visuals', false);
}

export async function addVisualizer(presetIndex = 0) {
  const preset = VIS_PRESETS[presetIndex] ?? VIS_PRESETS[0];
  const id = uniqueId(slug(preset.name.toLowerCase()), takenIds());
  const def = { id, name: preset.name, type: 'visualizer', vis: { ...VIS_DEFAULTS, ...preset.vis }, visualBlend: 'screen' };
  await pushLayers([def], `Add ${preset.name}`);
}

export async function addEffect(kind) {
  const info = FX_KINDS[kind];
  const id = uniqueId(kind, takenIds());
  const { area, blend, y, ...rest } = info.defaults;
  const def = { id, name: info.label, type: 'effect', fx: { ...FX_COMMON, kind, ...rest, area }, visualBlend: blend, base: {} };
  if (y != null) def.base.positionY = y;
  await pushLayers([def], `Add ${info.label}`);
  // Starter sound links, ordinary connections the user can edit or delete.
  const link = (feature, property, outMin, outMax) => ({ source: 'master', feature, element: id, property, curve: 'smoothstep', outMin, outMax, combine: 'replace', attackMs: 30, releaseMs: 300, origin: 'user' });
  if (kind === 'glitter') state.project.connections.push(link('high', 'intensity', 0.4, 1.5));
  if (kind === 'sparks') state.project.connections.push(link('rms', 'intensity', 0.3, 1.6));
  if (kind === 'pixelFire') state.project.connections.push(link('rms', 'intensity', 0.6, 1.3));
  if (['glitter', 'sparks', 'pixelFire'].includes(kind)) { recompile(); commit('Link effect to sound'); }
}

export async function addLyrics() {
  const id = uniqueId('captions', takenIds());
  const def = { id, name: 'Captions', type: 'lyrics', lyrics: structuredClone(LYRIC_DEFAULTS) };
  await pushLayers([def], 'Add closed captions');
}

/** Add a script layer. `mode` is 'presentation' or 'lyrics' (lyrics = transparent, word-by-word, lower third). */
export async function addScript(text, mode = 'presentation', name = 'Script') {
  const id = uniqueId('script', takenIds());
  const script = { ...structuredClone(SCRIPT_DEFAULTS) };
  applyMode(script, mode);
  if (text) script.text = text;
  const def = { id, name, type: 'script', script };
  await pushLayers([def], `Add ${name.toLowerCase()}`);
  return id;
}

/** Ready-made examples, like the image demo: 'presentation' (explainer) or 'lyrics' (song over a rain effect). */
export async function addScriptDemo(kind) {
  if (kind === 'lyrics') {
    const fxId = uniqueId('rain', takenIds());
    const info = FX_KINDS.rain; const { area, blend, y, ...rest } = info.defaults;
    const bg = { id: fxId, name: 'Demo rain', type: 'effect', fx: { ...FX_COMMON, kind: 'rain', ...rest, area }, visualBlend: blend, base: {} };
    await pushLayers([bg], 'Add rain', false);
    const id = await addScript(DEMO_LYRICS, 'lyrics', 'Demo lyrics');
    const def = layerById(id); def.script.pack = 'smooth'; def.script.seed = 3;
    structural(); commit('Add lyrics demo');
    toast('Lyrics demo added. Load a song and these lines follow it.');
    return id;
  }
  const id = await addScript(DEMO_PRESENTATION, 'presentation', 'Demo presentation');
  const def = layerById(id); def.script.seed = 7; def.script.energy = 0.75;
  structural(); commit('Add presentation demo');
  return id;
}

/** Turn a closed-captions layer into a script layer with the same lines and times. */
export async function captionsToScript(id) {
  const def = layerById(id); if (!def) return;
  const lyr = lyricsSettings(def);
  const text = linesToScript(lyr.lines.map((l) => ({ t0: l.t0, t1: l.t1 ?? null, text: l.text })));
  return addScript(text || undefined, 'lyrics', `${def.name ?? 'Captions'} (script)`);
}

/** Turn a script layer into a closed-captions layer (one caption per timed line). */
export async function scriptToCaptions(id) {
  const def = layerById(id); if (!def) return;
  const lines = scriptToLines(scriptSettings(def).text).map((l) => ({ t0: l.t0, ...(l.t1 != null ? { t1: l.t1 } : {}), text: l.text }));
  const nid = uniqueId('captions', takenIds());
  const nd = { id: nid, name: `${def.name ?? 'Script'} (captions)`, type: 'lyrics', lyrics: { ...structuredClone(LYRIC_DEFAULTS), lines } };
  await pushLayers([nd], 'Convert script to captions');
  return nid;
}

export function setScript(id, mutate, label = 'Edit script', key = null) {
  const def = layerById(id); if (!def) return;
  def.script = scriptSettings(def);
  mutate(def.script);
  structural(); commit(label, key);
}

export async function removeLayers(ids) {
  const p = state.project;
  const set = new Set(ids);
  p.elements = p.elements.filter((e) => !set.has(e.id));
  p.connections = p.connections.filter((c) => !set.has(c.element));
  p.tracks = p.tracks.filter((t) => !set.has(t.element));
  normalize(p);
  if (state.selected && set.has(state.selected)) state.selected = null;
  await syncAssets();
  structural();
  emit('selection');
  commit(`Remove ${ids.join(', ')}`);
}

export async function duplicateLayer(id) {
  const p = state.project;
  const i = layerIndex(id); if (i < 0) return;
  const src = p.elements[i];
  const nid = uniqueId(id, takenIds());
  const copy = { ...structuredClone(src), id: nid, name: `${layerName(src)} copy` };
  delete copy._error;
  p.elements.splice(i + 1, 0, copy);
  for (const c of p.connections.filter((c) => c.element === id)) p.connections.push({ ...c, element: nid, origin: 'user' });
  for (const t of p.tracks.filter((t) => t.element === id)) p.tracks.push({ ...structuredClone(t), element: nid });
  normalize(p);
  await syncAssets();
  structural();
  select(nid);
  commit(`Duplicate ${id}`);
}

/** Move a layer to array position `to` (0 = back). */
export function reorderLayer(id, to, label = 'Reorder layers') {
  const p = state.project;
  const from = layerIndex(id);
  to = clamp(Math.round(to), 0, p.elements.length - 1);
  if (from < 0 || from === to) return;
  const [el] = p.elements.splice(from, 1);
  p.elements.splice(to, 0, el);
  normalize(p);
  // engine element indices changed
  syncAssets().then(() => { structural(); commit(label); });
}

/** Typed z position: 1 = back, N = front. */
export const setOrder = (id, n) => reorderLayer(id, n - 1, 'Change layer order');

/** Patch fields on a layer definition and refresh. `deep` keys like 'vis.count' are supported. */
export async function updateLayer(id, patch, label, key = null, { assets = false } = {}) {
  const def = layerById(id); if (!def) return;
  for (const [k, v] of Object.entries(patch)) {
    const parts = k.split('.');
    let o = def;
    for (let i = 0; i < parts.length - 1; i++) o = (o[parts[i]] ??= {});
    if (v === undefined) delete o[parts.at(-1)]; else o[parts.at(-1)] = v;
  }
  if (patch.background !== undefined) normalize(state.project);
  if (assets) await syncAssets();
  structural();
  commit(label ?? `Edit ${layerName(def)}`, key);
}

export function select(id) {
  if (state.selected === id) return;
  state.selected = id;
  emit('selection');
  drawSoon();
}

// ---------- property values (base, timeline, evaluated) ----------

/** Value of a property at the current frame as the engine evaluated it (includes sound and timeline). */
export function evaluated(id, prop) {
  const i = layerIndex(id);
  const idx = PROPERTY_NAMES.indexOf(prop);
  if (!state.frameValues || i < 0 || idx < 0) return baseValue(id, prop);
  return state.frameValues[i * PROPERTY_COUNT + idx];
}

export function baseValue(id, prop) {
  const def = layerById(id);
  return def?.base?.[prop] ?? PROP_BY_NAME[prop].def;
}

export const trackOf = (id, prop) => TL.findTrack(state.project, id, prop);

/** The value that editing starts from: the timeline's value if keyframed, otherwise the base. */
export function editValue(id, prop) {
  const t = trackOf(id, prop);
  return t ? TL.valueAt(t, state.frame) : baseValue(id, prop);
}

/**
 * Set a property. With a timeline track and auto-key on, it writes a keyframe at the
 * playhead; otherwise it edits the base value.
 */
export function setProperty(id, prop, value, label, key = null) {
  const def = layerById(id); if (!def) return;
  const info = PROP_BY_NAME[prop];
  value = clamp(value, info.min, info.max);
  const t = trackOf(id, prop);
  if (t && prop !== 'visible') {
    if (!state.prefs.autoKey) { toast('This property is keyframed. Turn on auto-key or add a keyframe to edit it here.'); return; }
    TL.setKey(state.project, id, prop, state.frame, value);
    recompile();
  } else if (t) {
    toast('Visibility is keyframed. Edit its bar in the timeline.');
    return;
  } else {
    def.base ??= {};
    def.base[prop] = value;
    pushBase();
  }
  emit('project', { light: true });
  commit(label ?? `Set ${PROP_BY_NAME[prop].label}`, key ?? `set:${id}:${prop}`);
}

function pushBase() {
  try { state.engine?.update_base(JSON.stringify(strip(state.project))); } catch { recompile(); }
  drawSoon();
}

/** Drag/resize helper for the preview: normalised deltas and a scale factor. */
export function nudgeLayer(id, dx, dy, scaleFactor = 1) {
  const def = layerById(id); if (!def || def.locked) return;
  const key = `drag:${id}`;
  if (dx || dy) {
    setProperty(id, 'positionX', editValue(id, 'positionX') + dx, `Move ${layerName(def)}`, key);
    setProperty(id, 'positionY', editValue(id, 'positionY') + dy, `Move ${layerName(def)}`, key);
  }
  if (scaleFactor !== 1) {
    setProperty(id, 'scaleX', editValue(id, 'scaleX') * scaleFactor, `Resize ${layerName(def)}`, key);
    setProperty(id, 'scaleY', editValue(id, 'scaleY') * scaleFactor, `Resize ${layerName(def)}`, key);
  }
}

// ---------- timeline editing ----------

export function toggleKeyAtPlayhead(id, prop) {
  const p = state.project;
  const t = TL.findTrack(p, id, prop);
  const f = state.frame;
  if (t?.keys.some((k) => k.f === f)) {
    TL.removeKeys(p, t, [f]);
    commit(`Remove keyframe (${PROP_BY_NAME[prop].label})`);
  } else {
    const v = t ? TL.valueAt(t, f) : baseValue(id, prop);
    TL.setKey(p, id, prop, f, v);
    commit(`Add keyframe (${PROP_BY_NAME[prop].label})`);
  }
  structural();
}

export function removeTrack(id, prop) {
  const p = state.project;
  p.tracks = p.tracks.filter((t) => !(t.element === id && t.property === prop));
  structural(); commit(`Remove timeline (${PROP_BY_NAME[prop].label})`);
}

export function setTrackMode(id, prop, mode, mix) {
  const t = trackOf(id, prop); if (!t) return;
  t.mode = mode; if (mix != null) t.mix = mix;
  recompile(); emit('project', { light: true }); commit('Change blend mode', `mode:${id}:${prop}`);
}

/** Apply a mutation to the project's tracks, then recompile and record one undo step. */
export function editTracks(fn, label, key = null) {
  fn(state.project);
  structural();
  commit(label, key);
}

export function setVisibility(id, spans) {
  TL.setVisibilitySpans(state.project, id, spans, totalFrames());
  structural(); commit('Edit visibility', `vis:${id}`);
}

export const visibilitySpans = (id) => TL.visibilitySpans(trackOf(id, 'visible'), totalFrames());

// ---------- sections ----------

export function addSection(start = state.frame, length = Math.round(fps() * 8)) {
  const p = state.project;
  const n = p.sections.length;
  const s = { id: `sec${Date.now().toString(36)}${n}`, name: `Section ${n + 1}`, color: TL.SECTION_COLORS[n % TL.SECTION_COLORS.length], start, end: Math.min(totalFrames(), start + length) };
  p.sections.push(s);
  structural(); commit('Add section');
  return s;
}

export function editSection(id, patch, label = 'Edit section', key = null) {
  const s = state.project.sections.find((x) => x.id === id); if (!s) return;
  Object.assign(s, patch);
  if (s.end <= s.start) s.end = s.start + 1;
  structural(); commit(label, key);
}

export function removeSection(id) {
  state.project.sections = state.project.sections.filter((s) => s.id !== id);
  structural(); commit('Delete section');
}

/** Shift everything inside a section (keyframes of every layer) and the section itself. */
export function moveSection(id, delta) {
  const p = state.project;
  const s = p.sections.find((x) => x.id === id); if (!s) return;
  const total = totalFrames();
  delta = clamp(delta, -s.start, total - s.end);
  if (!delta) return;
  for (const t of p.tracks) {
    const inside = t.keys.filter((k) => k.f >= s.start && k.f < s.end).map((k) => k.f);
    if (inside.length) TL.moveKeys(t, inside, delta, total);
  }
  s.start += delta; s.end += delta;
  structural(); commit('Move section');
}

/** Copy the keyframes of a section right after it, with a new section marker. */
export function duplicateSection(id) {
  const p = state.project;
  const s = p.sections.find((x) => x.id === id); if (!s) return;
  const len = s.end - s.start; const total = totalFrames();
  if (s.end + len > total) { toast('Not enough room after this section.'); return; }
  for (const t of p.tracks) {
    const copies = t.keys.filter((k) => (k.f >= s.start && k.f < s.end) || (t.property === 'visible' && k.f === s.end));
    for (const k of copies) {
      const f = k.f + len;
      const ex = t.keys.find((x) => x.f === f);
      if (ex) { ex.v = k.v; ex.interp = k.interp; } else t.keys.push({ ...k, f });
    }
    t.keys.sort((a, b) => a.f - b.f);
  }
  const n = p.sections.length;
  p.sections.push({ id: `sec${Date.now().toString(36)}${n}`, name: `${s.name} copy`, color: s.color, start: s.start + len, end: s.end + len });
  structural(); commit('Duplicate section');
}

// ---------- connections ----------

export function connectionsFor(id, prop) {
  return state.project.connections.filter((c) => c.element === id && (!prop || c.property === prop));
}

export function addConnection(id, prop, source = 'master', feature = 'rms') {
  const info = PROP_BY_NAME[prop];
  const span = info.max - info.min;
  const big = ['blur'].includes(prop);
  const c = {
    source, feature, element: id, property: prop, curve: 'linear',
    outMin: 0, outMax: big ? 20 : prop === 'rotation' ? 0.2 : Math.min(0.2, span * 0.1),
    combine: 'add', attackMs: 10, releaseMs: 200, origin: 'user',
  };
  state.project.connections.push(c);
  structural(); commit(`Link ${feature} to ${info.label}`);
  return c;
}

export function updateConnection(c, patch, label = 'Edit connection', key = null) {
  Object.assign(c, patch, { origin: 'user' });
  structural(); commit(label, key ?? `conn:${state.project.connections.indexOf(c)}`);
}

export function removeConnection(c) {
  state.project.connections = state.project.connections.filter((x) => x !== c);
  structural(); commit('Remove connection');
}

/** Run Automatic mode on image layers only; effects, visualizers and lyrics are never auto-targeted. */
export function runAuto() {
  const p = state.project;
  const imageIds = new Set(p.elements.filter((e) => isImageType(e.type)).map((e) => e.id));
  const sub = strip({ ...p, elements: p.elements.filter((e) => imageIds.has(e.id)), connections: p.connections.filter((c) => imageIds.has(c.element)) });
  const out = JSON.parse(wasm.auto_mode(JSON.stringify(sub)));
  const kept = p.connections.filter((c) => c.origin !== 'auto');
  p.connections = [...kept, ...out.connections.filter((c) => c.origin === 'auto')];
  structural();
}

export function applyRoutingPreset(key) {
  const p = state.project;
  const sub = { ...p, elements: p.elements.filter((e) => isImageType(e.type)), connections: p.connections };
  const added = applyPreset(sub, key);
  if (!added) return 0;
  p.connections = sub.connections;
  structural();
  return added;
}

// ---------- lyrics ----------

export function setLyrics(id, mutate, label = 'Edit lyrics', key = null) {
  const def = layerById(id); if (!def) return;
  def.lyrics = lyricsSettings(def);
  mutate(def.lyrics);
  structural(); commit(label, key);
}

export async function addFontFile(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  state.files.set(file.name, file);
  await registerFont(name, file);
  fontNames.add(name);
  emit('fonts');
  toast(`Font "${name}" added.`);
  return { name, path: file.name };
}
export const userFonts = () => [...fontNames];

// ---------- structure change: validate, compile, redraw ----------

function computeAvoid() {
  const p = state.project;
  const [cw, ch] = p.resolution;
  const rects = [];
  for (const [i, def] of p.elements.entries()) {
    const a = state.assets[i];
    if (!a || !isImageType(def.type) || def.background || def.base?.visible === 0) continue;
    const [bw, bh] = fitSize(defaultFit(def), a.width, a.height, cw, ch);
    const sc = (def.base?.scale ?? 1);
    const w = (bw * sc * (def.base?.scaleX ?? 1)) / cw; const h = (bh * sc * (def.base?.scaleY ?? 1)) / ch;
    if (w * h > 0.7) continue;
    rects.push({ x: def.base?.positionX ?? 0.5, y: def.base?.positionY ?? 0.5, w, h });
  }
  return rects;
}

export function structural() {
  recompile();
  emit('project', {});
}

let issueCache = [];
export const issues = () => issueCache;

export function recompile() {
  const p = state.project;
  TL.pruneTracks(p, PROPERTY_NAMES);
  let found = [];
  try { found = JSON.parse(wasm.validate_project(JSON.stringify(strip(p)))); } catch (e) { found = [{ severity: 'error', message: e.message ?? String(e) }]; }
  if (state.engine) {
    try {
      found = [...found, ...JSON.parse(state.engine.compile(JSON.stringify(strip(p))))];
      state.bridge.refreshView();
      state.frame = Math.min(state.frame, Math.max(0, totalFrames() - 1));
    } catch (e) { found.push({ severity: 'error', message: e.message ?? String(e) }); }
  }
  const seen = new Set();
  issueCache = found.filter((i) => !seen.has(i.message) && seen.add(i.message));
  for (const e of p.elements) if (e._error) issueCache.push({ severity: 'error', message: `${layerName(e)}: ${e._error}` });
  if (state.renderer) { state.renderer.avoid = computeAvoid(); state.renderer.audio = audioProvider(); state.renderer.duration = totalFrames() / p.videoFps; }
  emit('issues');
  drawSoon();
}

// ---------- settings ----------

export async function setResolution(w, h) {
  state.project.resolution = [even(w), even(h)];
  if (state.canvas) await rebuildRenderer();
  structural(); commit('Change resolution');
}

export function setFps(v) {
  state.project.videoFps = Number(v);
  state.beats = state.engine ? TL.peakFrames(getSeries('master', 4), state.engine.analysis_rate(), fps(), 0.5) : [];
  structural(); commit('Change frame rate');
}

export function setAudioSettings({ sampleRate, analysisRate }) {
  if (sampleRate) state.project.sampleRate = Number(sampleRate);
  if (analysisRate) state.project.analysisRate = Number(analysisRate);
  invalidateAnalysis();
  emit('project', { audio: true });
}

// ---------- save / load ----------

export function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

export function saveProjectJson() {
  const p = { ...strip(state.project), sections: state.project.sections };
  p.elements = state.project.elements.map(({ _error, ...e }) => e);
  p.connections = state.project.connections;
  download(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }), 'project.easymv.json');
}

export async function saveBundle() {
  try {
    refreshAudioSettings();
    const files = new Map(state.files);
    if (state.masterFile) files.set(state.masterFile.name, state.masterFile);
    for (const s of state.stemFiles) files.set(s.file.name, s.file);
    const p = { ...state.project, elements: state.project.elements.map(({ _error, ...e }) => e) };
    toast('Packing bundle…', 8000);
    const { blob, missing } = await packBundle(p, files);
    download(blob, 'project.easymv.zip');
    toast(missing.length ? `Saved, but missing: ${missing.join(', ')}` : `Bundle saved (${(blob.size / MB).toFixed(1)} MB)`, 5000);
  } catch (e) { fatal(`Could not save bundle: ${e.message ?? e}`); }
}

async function adoptProject(p, bundleFiles) {
  migrate(p);
  const errs = JSON.parse(wasm.validate_project(JSON.stringify(strip(p)))).filter((i) => i.severity === 'error');
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
  await syncAssets();
  if (state.canvas) await rebuildRenderer();
  resetHistory();
  emit('selection');
  structural();
  emit('engine');
}

export async function newDocument() {
  await adoptProject(newProject(), null);
  state.masterFile = null; state.stemFiles = [];
  emit('engine');
}

export async function openFile(f) {
  fatal('');
  try {
    if (/\.zip$/i.test(f.name)) {
      const { project, files } = await unpackBundle(f);
      await adoptProject(project, files);
      if (state.masterFile) await analyze(); else fatal('Bundle has no master mix file.');
    } else {
      await adoptProject(JSON.parse(await f.text()), null);
      const p = state.project;
      fatal(`Project loaded. Re-select its audio (master: ${p.masterMix.path}; stems: ${p.stems.map((s) => s.path).join(', ') || 'none'}) and any layer files by name. Tip: "Save bundle (.zip)" avoids this.`);
    }
  } catch (err) { fatal(`Could not load project: ${err.message ?? err}`); }
}

// ---------- preview, playback ----------

export async function rebuildRenderer() {
  state.renderer?.dispose();
  if (!state.canvas) return;
  const [w, h] = state.project.resolution;
  state.renderer = new Renderer(state.canvas, { width: w, height: h, budgetMB: Number(state.prefs.budgetMB) });
  state.renderer.audio = audioProvider();
  state.renderer.duration = totalFrames() / state.project.videoFps;
  state.renderer.avoid = computeAvoid();
  emit('renderer');
}

export function attachCanvas(canvas) { state.canvas = canvas; rebuildRenderer(); }

/** Without a song there is no engine: show layers at their own values (base plus timeline) so you can still compose. */
function baseOnlyView(f) {
  const els = state.project.elements;
  return { get: (e, q) => {
    const id = els[e]?.id; const name = PROPERTY_NAMES[q];
    const t = trackOf(id, name);
    return t ? TL.valueAt(t, f) : baseValue(id, name);
  } };
}

/** The layer's own Show/Hide switch is authoritative when it has no visibility keyframes, whatever the engine last saw. */
function visibilityAuthority(view) {
  const els = state.project.elements;
  const hid = els.map((e) => !trackOf(e.id, 'visible'));
  return { get: (e, q) => {
    if (q === P_VISIBLE && hid[e]) return (els[e].base?.visible ?? 1) >= 0.5 ? 1 : 0;
    return view.get(e, q);
  } };
}
const P_VISIBLE = PROPERTY_NAMES.indexOf('visible');

async function drawFrame(f) {
  if (!state.renderer) return;
  let view;
  if (state.bridge) {
    state.bridge.evaluate(f, 1);
    const fv = state.bridge.frameView.at(0);
    const n = state.bridge.elementCount;
    const vals = new Float32Array(n * PROPERTY_COUNT);
    for (let e = 0; e < n; e++) for (let q = 0; q < PROPERTY_COUNT; q++) vals[e * PROPERTY_COUNT + q] = fv.get(e, q);
    state.frameValues = vals;
    view = state.bridge.frameView.at(0);
  } else {
    view = baseOnlyView(f);
    const n = state.project.elements.length;
    state.frameValues = Float32Array.from({ length: n * PROPERTY_COUNT }, (_, i) => view.get(Math.floor(i / PROPERTY_COUNT), i % PROPERTY_COUNT));
  }
  state.renderer.audio = audioProvider();
  view = visibilityAuthority(view);
  const plan = buildPlan(state.assets, view, f, fps());
  await state.renderer.prepare(plan);
  state.renderer.draw(plan);
  state.lastPlan = plan;
  emit('frame', { frame: f });
}

let drawing = false; let pending = false;
export function drawSoon() {
  if (drawing) { pending = true; return; }
  drawing = true;
  drawFrame(state.frame).catch((e) => fatal(`Render error: ${e.message ?? e}`)).finally(() => {
    drawing = false;
    if (pending) { pending = false; drawSoon(); }
  });
}

export function seek(f) {
  state.frame = clamp(Math.round(f), 0, Math.max(0, totalFrames() - 1));
  drawSoon();
  emit('frame', { frame: state.frame, seek: true });
}

export const transport = { loop: false, rate: 1 };

export async function play() {
  if (state.playing) return;
  const rate = fps();
  if (!state.bridge) {
    // no song yet: a silent clock so layers, scripts and effects can still be previewed
    state.playing = true; emit('transport');
    const t0 = performance.now(); const f0 = state.frame;
    const tick = () => {
      if (!state.playing || state.bridge) return;
      const f = f0 + Math.floor(((performance.now() - t0) / 1000) * rate * transport.rate);
      if (f >= totalFrames()) { if (transport.loop) { stop(); seek(0); play(); } else { stop(); seek(0); } return; }
      if (f !== state.frame) { state.frame = f; drawSoon(); emit('frame', { frame: f }); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return;
  }
  const info = state.bridge.masterInfo;
  audioCtx ??= new AudioContext();
  await audioCtx.resume();
  const pcm = state.bridge.masterPcm();
  const buf = audioCtx.createBuffer(info.channels, info.frames, info.sampleRate);
  for (let c = 0; c < info.channels; c++) {
    const plane = new Float32Array(info.frames);
    for (let i = 0; i < info.frames; i++) plane[i] = pcm[i * info.channels + c];
    buf.copyToChannel(plane, c);
  }
  const offset = state.frame / rate;
  audioSrc = audioCtx.createBufferSource();
  audioSrc.buffer = buf;
  audioSrc.playbackRate.value = transport.rate;
  audioSrc.connect(audioCtx.destination);
  playStart = audioCtx.currentTime - offset / transport.rate;
  audioSrc.start(0, offset);
  state.playing = true;
  emit('transport');
  const tick = () => {
    if (!state.playing) return;
    const f = Math.floor((audioCtx.currentTime - playStart) * rate * transport.rate);
    if (f >= totalFrames()) { stop(); seek(0); if (transport.loop) play(); return; }
    if (f !== state.frame) { state.frame = f; drawSoon(); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Jump relative to now by seconds (keeps playing). */
export function skip(sec) {
  const was = state.playing;
  if (was) stop();
  seek(state.frame + Math.round(sec * fps()));
  if (was) play();
}
export function setSpeed(r) { transport.rate = r; if (state.playing) { stop(); play(); } emit('transport'); }
export function setLoop(v) { transport.loop = !!v; emit('transport'); }

export function stop() {
  const was = state.playing;
  state.playing = false;
  try { audioSrc?.stop(); } catch { /* not started */ }
  audioSrc = null;
  if (was) emit('transport');
}

export const togglePlay = () => (state.playing ? stop() : play());

// ---------- quick start ----------

export async function quickStart(onProgress) {
  if (!state.masterFile) { toast('Choose a master mix first.'); return false; }
  if (!state.project.elements.length) await addDemo();
  if (!state.bridge && !(await analyze(onProgress))) return false;
  try { runAuto(); commit('Quick start'); } catch (e) { fatal(`Automatic mode failed: ${e.message ?? e}`); return false; }
  seek(0);
  await play();
  toast('Playing with automatic routing. Tweak anything, or export when happy.', 4000);
  return true;
}

// ---------- export ----------

let wakeLock = null;
async function lockScreen() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ } }
async function unlockScreen() { try { await wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }

let abort = null;
export const cancelExport = () => abort?.abort();

export async function exportVideo() {
  fatal('');
  try {
    stop();
    const p = state.project;
    const info = state.bridge.masterInfo;
    const probe = await probeCodecs({ width: p.resolution[0], height: p.resolution[1], fps: p.videoFps, sampleRate: info.sampleRate, channels: info.channels });
    const dur = state.bridge.totalFrames / p.videoFps;
    if (typeof window.showSaveFilePicker !== 'function') {
      const est = estimateOutputBytes({ width: p.resolution[0], height: p.resolution[1], fps: p.videoFps, durationSec: dur });
      const limit = isLikelyMobile() ? 300 * MB : 1500 * MB;
      if (dur > EXPORT_WARN_SECONDS || est > limit) {
        const lower = isLikelyMobile() ? ' Consider a smaller resolution such as 1280×720 or 720×1280.' : '';
        if (!confirm(`This browser buffers the whole file in memory (about ${(est / MB).toFixed(0)} MB). For long videos use Chrome or Edge on a computer.${lower}\n\nContinue anyway?`)) return;
      }
    }
    const output = await openOutput(probe.container);
    const canvas = document.createElement('canvas');
    const renderer = new Renderer(canvas, { width: p.resolution[0], height: p.resolution[1], budgetMB: Number(state.prefs.budgetMB) });
    renderer.audio = audioProvider();
    renderer.avoid = computeAvoid();
    abort = new AbortController();
    state.exporting = true;
    await lockScreen();
    state.export = { frac: 0, msg: 'Keep this tab open and in the foreground until the export finishes.', codec: probe.label };
    emit('export');
    const t0 = performance.now();
    const result = await runExport({
      bridge: state.bridge, assets: state.assets, renderer, project: p, probe, output,
      audioOffsetMs: Number(state.prefs.audioOffsetMs ?? 0),
      signal: abort.signal,
      onProgress: (frac, f) => {
        state.export.frac = frac;
        if (f % 15 === 0 && !document.hidden) state.export.msg = `Frame ${f + 1} / ${state.bridge.totalFrames} (${((f + 1) / ((performance.now() - t0) / 1000)).toFixed(1)} fps)`;
        emit('export');
      },
    });
    renderer.dispose();
    state.export.msg = result === 'done' ? `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s.` : 'Export cancelled; project unchanged.';
  } catch (e) {
    if (e?.name !== 'AbortError') fatal(`Export failed: ${e.message ?? e}`);
  } finally {
    state.exporting = false;
    await unlockScreen();
    state.bridge?.refreshView();
    emit('export');
    drawSoon();
  }
}

document.addEventListener('visibilitychange', () => {
  if (!state.exporting) return;
  if (document.hidden) { state.export.msg = 'This tab is hidden, so the browser may slow or pause the export. Switch back to keep it going.'; emit('export'); } else lockScreen();
});

// ---------- boot ----------

export async function boot() {
  state.project = newProject();
  resetHistory();
  await initEngine();
  recompile();
  if (typeof VideoEncoder === 'undefined') toast('WebCodecs unavailable: export will not work in this browser.', 6000);
  emit('project', {});
}
