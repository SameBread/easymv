// Internal animation clocks (§4.2, §4.3, §4.5) and atlas math (§4.4).
//
// Everything here is a PURE function of (video frame index, element timing
// parameters). Audio never reaches this module: stable-pace animation by
// construction.

export const PROPERTY_COUNT = 16;

/** Order is the engine contract (§5.3). Verified against the engine at startup. */
export const PROPERTY_NAMES = [
  'positionX', 'positionY', 'rotation', 'scale', 'scaleX', 'scaleY', 'mirrorX', 'mirrorY',
  'opacity', 'hueShift', 'saturation', 'brightness', 'contrast', 'blur', 'anchorX', 'anchorY',
];
export const P = Object.fromEntries(PROPERTY_NAMES.map((n, i) => [n, i]));

const EPS = 1e-9;

/** Map a (possibly unbounded) tick count to a frame index for a loop mode. */
export function frameForTick(tick, frameCount, loopMode) {
  const n = frameCount;
  if (n <= 0) return 0;
  switch (loopMode) {
    case 'once':
      return Math.min(tick, n - 1);
    case 'pingPong': {
      if (n === 1) return 0;
      const p = tick % (2 * n); // period 2N (§4.3)
      return p < n ? p : 2 * n - p - 1;
    }
    case 'loop':
    default:
      return tick % n;
  }
}

/**
 * Resolve which internal frame of a spriteSheet / frameSequence to show.
 * Uses integer-ish math on the frame index to avoid float drift:
 *   ticks = frameIndex * internalFps / videoFps
 * Returns { frame, next, mix } — `next`/`mix` are used only for crossfading.
 */
export function resolveFixedRateFrame(frameIndex, videoFps, internalFps, frameCount, loopMode) {
  const ticksF = (frameIndex * internalFps) / videoFps;
  const tick = Math.floor(ticksF + EPS);
  const mix = Math.max(0, ticksF - tick);
  const frame = frameForTick(tick, frameCount, loopMode);
  const next = frameForTick(tick + 1, frameCount, loopMode);
  return { frame, next, mix: next === frame ? 0 : mix };
}

/** Binary search: largest i with timeline[i] <= t, i in [0, frames-1]. */
export function searchTimeline(timeline, t) {
  const frames = timeline.length - 1;
  let lo = 0;
  let hi = frames - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timeline[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * GIF frame at a video frame index. `timeline` is the prefix-sum array in ms
 * (length frames+1, last = total duration), produced by the engine's GIF
 * decoder after the 0/1 cs -> 100 ms normalization.
 */
export function resolveGifFrame(frameIndex, videoFps, timeline, loopMode = 'loop') {
  const total = timeline[timeline.length - 1];
  const frames = timeline.length - 1;
  if (frames <= 1 || total <= 0) return { frame: 0, next: 0, mix: 0 };
  const elapsedMs = (frameIndex * 1000) / videoFps;
  let t;
  if (loopMode === 'once') t = Math.min(elapsedMs, total - EPS);
  else if (loopMode === 'pingPong') {
    const p = elapsedMs % (2 * total);
    t = p < total ? p : 2 * total - p - EPS;
  } else t = elapsedMs % total;
  const frame = searchTimeline(timeline, t);
  return { frame, next: frame, mix: 0 }; // GIFs never crossfade (§4.7)
}

/** UV rect [u0,v0,u1,v1] for sprite-sheet cell `i`, half-texel inset (§4.4). */
export function atlasUV(i, def, atlasW, atlasH) {
  const { frameWidth: fw, frameHeight: fh, columns } = def;
  const pad = def.padding ?? 0;
  const col = i % columns;
  const row = Math.floor(i / columns);
  const x0 = col * (fw + pad);
  const y0 = row * (fh + pad);
  return [
    (x0 + 0.5) / atlasW,
    (y0 + 0.5) / atlasH,
    (x0 + fw - 0.5) / atlasW,
    (y0 + fh - 0.5) / atlasH,
  ];
}

/** Atlas validation beyond the engine's structural checks (§4.4). Returns error string or null. */
export function validateAtlas(def, atlasW, atlasH) {
  const pad = def.padding ?? 0;
  const needW = def.columns * def.frameWidth + (def.columns - 1) * pad;
  const needH = def.rows * def.frameHeight + (def.rows - 1) * pad;
  if (needW > atlasW) {
    return `element '${def.id}': ${def.columns} columns x ${def.frameWidth}px` +
      `${pad ? ` + ${pad}px padding` : ''} = ${needW}px exceeds atlas width ${atlasW}px` +
      (pad ? ' (if your sheet has no gutters, set padding to 0)' : '');
  }
  if (needH > atlasH) {
    return `element '${def.id}': ${def.rows} rows x ${def.frameHeight}px` +
      `${pad ? ` + ${pad}px padding` : ''} = ${needH}px exceeds atlas height ${atlasH}px` +
      (pad ? ' (if your sheet has no gutters, set padding to 0)' : '');
  }
  return null;
}

/** Natural (numeric-aware) filename compare: frame_2 < frame_10 (§4.6). */
export function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const pa = a.toLowerCase().match(re) ?? [];
  const pb = b.toLowerCase().match(re) ?? [];
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i];
    const y = pb[i];
    const xn = /^\d/.test(x);
    const yn = /^\d/.test(y);
    if (xn && yn) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d;
      if (x.length !== y.length) return x.length - y.length; // 01 vs 1: stable
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return pa.length - pb.length;
}

/**
 * Validate and order the entries of a frame-sequence zip (§4.6, §10.7).
 * `names` are archive entry paths. Returns { ordered: string[], errors: string[] }.
 */
export function planZipFrames(names) {
  const errors = [];
  const ok = /\.(png|jpe?g|webp)$/i;
  const files = names.filter((n) => !n.endsWith('/') && !n.startsWith('__MACOSX/') && !/(^|\/)\.DS_Store$/.test(n));
  if (files.length === 0) return { ordered: [], errors: ['zip is empty'] };
  const nested = files.filter((n) => n.includes('/'));
  if (nested.length) errors.push(`images must be at the top level of the zip (no folders): ${nested.slice(0, 5).join(', ')}${nested.length > 5 ? ', ...' : ''}`);
  const bad = files.filter((n) => !n.includes('/') && !ok.test(n));
  if (bad.length) errors.push(`unsupported files (only .png .jpg .jpeg .webp): ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', ...' : ''}`);
  const images = files.filter((n) => !n.includes('/') && ok.test(n));
  if (images.length === 0 && errors.length === 0) errors.push('zip contains no images');
  return { ordered: images.sort(naturalCompare), errors };
}

/** Apply an explicit frameOrder permutation (from drag-reorder) if present. */
export function applyFrameOrder(ordered, frameOrder) {
  if (!frameOrder || frameOrder.length !== ordered.length) return ordered;
  return frameOrder.map((i) => ordered[i]);
}

/** Compute element intrinsic base size in canvas pixels at scale == 1 (fit mode). */
export function fitSize(fit, w, h, canvasW, canvasH) {
  if (fit === 'contain' || fit === 'cover') {
    const s = fit === 'contain' ? Math.min(canvasW / w, canvasH / h) : Math.max(canvasW / w, canvasH / h);
    return [w * s, h * s];
  }
  return [w, h];
}

export function defaultFit(def) {
  return def.fit ?? (def.type === 'static' ? 'cover' : 'natural');
}

/**
 * Build the per-frame draw plan: which texture(s) each element needs plus its
 * routed property values. Step 1 (internal frame) and step 2 (routed values)
 * of §4.2 are computed independently here and only combined for drawing.
 *
 * @param assets   array parallel to project.elements (index == engine element idx)
 * @param frameView object with get(elementIdx, propIdx)
 */
export function buildPlan(assets, frameView, frameIndex, videoFps) {
  const items = [];
  for (let ei = 0; ei < assets.length; ei++) {
    const a = assets[ei];
    if (!a || !a.ready) continue;
    const def = a.def;

    // Step 1: internal timeline (never reads audio).
    let r;
    if (def.type === 'gif') r = resolveGifFrame(frameIndex, videoFps, a.timeline, def.loopMode ?? 'loop');
    else if (def.type === 'static') r = { frame: 0, next: 0, mix: 0 };
    else {
      r = resolveFixedRateFrame(frameIndex, videoFps, def.internalFps, a.frameCount, def.loopMode ?? 'loop');
      if (!def.interpolate) r.mix = 0;
    }

    // Step 2: routed values, read as a view (no copy).
    const props = new Float32Array(PROPERTY_COUNT);
    for (let p = 0; p < PROPERTY_COUNT; p++) props[p] = frameView.get(ei, p);

    items.push({
      asset: a,
      zIndex: def.zIndex ?? 0,
      order: ei,
      frameA: r.frame,
      frameB: r.mix > 0 ? r.next : null,
      mix: r.mix,
      props,
      visualBlend: def.visualBlend ?? 'normal',
    });
  }
  // Painter's algorithm: ascending z, ties by array order.
  items.sort((x, y) => x.zIndex - y.zIndex || x.order - y.order);
  return items;
}
