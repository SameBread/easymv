// Timeline data helpers: keyframe tracks and visibility spans. Pure functions over the
// project's `tracks` array, mirrored by the Rust evaluator (same hold/linear/smooth maths)
// so the UI can show timeline values without asking the engine.
//
// Track: { element, property, mode: 'override'|'add'|'multiply'|'mix', mix, keys: [{ f, v, interp }] }
// Times are integer video frames.

export const INTERPS = ['hold', 'linear', 'smooth'];
export const MODES = {
  override: 'Override sound',
  add: 'Blend (add)',
  multiply: 'Blend (multiply)',
  mix: 'Mix',
};

/** Default blend mode for a property when a timeline track is first created. */
export function defaultMode(property) {
  if (property === 'visible') return 'override';
  if (['scale', 'scaleX', 'scaleY', 'opacity', 'brightness', 'contrast', 'saturation', 'intensity'].includes(property)) return 'multiply';
  return 'add';
}

export const findTrack = (project, element, property) =>
  project.tracks.find((t) => t.element === element && t.property === property) ?? null;

/** Timeline value at frame `f` (hold before the first / after the last key). */
export function valueAt(track, f) {
  const k = track.keys;
  if (!k.length) return 0;
  if (f <= k[0].f) return k[0].v;
  if (f >= k[k.length - 1].f) return k[k.length - 1].v;
  let lo = 0; let hi = k.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (k[mid].f <= f) lo = mid; else hi = mid; }
  const a = k[lo]; const b = k[lo + 1];
  const interp = track.property === 'visible' ? 'hold' : a.interp;
  if (interp === 'hold') return a.v;
  let t = (f - a.f) / (b.f - a.f);
  if (interp === 'smooth') t = t * t * (3 - 2 * t);
  return a.v + (b.v - a.v) * t;
}

/** Create the track if needed, then set (or add) the key at frame `f`. Returns the track. */
export function setKey(project, element, property, f, v, interp = 'linear') {
  let t = findTrack(project, element, property);
  if (!t) {
    t = { element, property, mode: defaultMode(property), mix: 0.5, keys: [] };
    project.tracks.push(t);
  }
  const existing = t.keys.find((k) => k.f === f);
  if (existing) existing.v = v;
  else {
    const prev = [...t.keys].reverse().find((k) => k.f < f);
    t.keys.push({ f, v, interp: property === 'visible' ? 'hold' : (prev?.interp ?? interp) });
    t.keys.sort((a, b) => a.f - b.f);
  }
  return t;
}

/** Remove keys by frame; drops the track when it empties. */
export function removeKeys(project, track, frames) {
  const set = new Set(frames);
  track.keys = track.keys.filter((k) => !set.has(k.f));
  if (!track.keys.length) project.tracks = project.tracks.filter((t) => t !== track);
}

/**
 * Move a set of keys (by frame) by `delta` frames, clamped to [0, max]. Keys that would
 * collide with an unselected key replace it. Returns the new frames of the moved keys.
 */
export function moveKeys(track, frames, delta, max = Infinity) {
  const sel = new Set(frames);
  const moving = track.keys.filter((k) => sel.has(k.f));
  if (!moving.length) return [];
  const lo = Math.min(...moving.map((k) => k.f)); const hi = Math.max(...moving.map((k) => k.f));
  const d = Math.max(-lo, Math.min(max - hi, delta));
  const still = track.keys.filter((k) => !sel.has(k.f) && !moving.some((m) => m.f + d === k.f));
  for (const m of moving) m.f += d;
  track.keys = [...still, ...moving].sort((a, b) => a.f - b.f);
  return moving.map((m) => m.f);
}

export function setInterp(track, frames, interp) {
  if (track.property === 'visible') return;
  const set = new Set(frames);
  for (const k of track.keys) if (set.has(k.f)) k.interp = interp;
}

/** Drop tracks that point at layers/properties that no longer exist. */
export function pruneTracks(project, propertyNames) {
  const ids = new Set(project.elements.map((e) => e.id));
  project.tracks = project.tracks.filter((t) => ids.has(t.element) && propertyNames.includes(t.property) && t.keys.length);
}

// ---------- visibility spans ----------

/**
 * The visibility track as on/off spans [start, end) in frames. A layer without a track is
 * visible for the whole song (so it has one span); `total` is the song length in frames.
 */
export function visibilitySpans(track, total) {
  if (!track) return [[0, total]];
  const spans = [];
  let on = null;
  const keys = track.keys;
  const initial = keys.length ? keys[0].v >= 0.5 : true;
  if (initial && keys[0]?.f > 0) on = 0;
  for (const k of keys) {
    const vis = k.v >= 0.5;
    if (vis && on === null) on = k.f;
    else if (!vis && on !== null) { if (k.f > on) spans.push([on, k.f]); on = null; }
  }
  if (on !== null && total > on) spans.push([on, total]);
  return spans;
}

/** Rebuild the visibility track from spans. Returns null when the layer is simply always visible. */
export function spansToKeys(spans, total) {
  const merged = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const s = Math.max(0, Math.round(a)); const e = Math.min(total, Math.round(b));
    if (e <= s) continue;
    if (merged.length && s <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], e);
    else merged.push([s, e]);
  }
  if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] >= total) return null;
  if (!merged.length) return [{ f: 0, v: 0, interp: 'hold' }];
  const keys = [];
  if (merged[0][0] > 0) keys.push({ f: 0, v: 0, interp: 'hold' });
  for (const [s, e] of merged) {
    keys.push({ f: s, v: 1, interp: 'hold' });
    if (e < total) keys.push({ f: e, v: 0, interp: 'hold' });
  }
  return keys;
}

/** Write spans back to the project (creating, replacing or removing the visibility track). */
export function setVisibilitySpans(project, element, spans, total) {
  const keys = spansToKeys(spans, total);
  const existing = findTrack(project, element, 'visible');
  if (!keys) { if (existing) project.tracks = project.tracks.filter((t) => t !== existing); return; }
  if (existing) existing.keys = keys;
  else project.tracks.push({ element, property: 'visible', mode: 'override', mix: 0.5, keys });
}

// ---------- sections ----------

export const SECTION_COLORS = ['#ff6b9d', '#6bd5ff', '#7cf3b2', '#ffd166', '#b39dff', '#ff9f6b'];

/** Frames of every beat-like peak in a normalized feature series (for snapping). */
export function peakFrames(series, rate, fps, threshold = 0.5, minGapMs = 120) {
  const out = [];
  let last = -Infinity;
  const gap = (minGapMs / 1000) * rate;
  for (let i = 1; i < series.length - 1; i++) {
    if (series[i] >= threshold && series[i] >= series[i - 1] && series[i] > series[i + 1] && i - last >= gap) {
      out.push(Math.round((i / rate) * fps)); last = i;
    }
  }
  return out;
}

/** Snap `f` to the nearest candidate within `tol` frames, else return `f`. */
export function snapFrame(f, candidates, tol) {
  let best = f; let d = tol + 1;
  for (const c of candidates) { const x = Math.abs(c - f); if (x < d) { d = x; best = c; } }
  return d <= tol ? best : f;
}
