// Element asset loaders. Each asset exposes the same small interface to the
// renderer, regardless of element type:
//
//   asset.def, asset.ready, asset.width/height  (one frame, in source pixels)
//   asset.frameCount, asset.timeline            (GIF only)
//   asset.textureIndex(frame) -> int            (which GPU texture holds that frame)
//   asset.uvRect(frame) -> [u0,v0,u1,v1]
//   await asset.textureSource(texIdx) -> { image } | { data, width, height }
//   asset.textureBytes(texIdx) -> int           (for the GPU budget)
//
// Decoded frames are never kept resident on the CPU: the renderer uploads and
// the LRU cache (renderer.js) re-requests them on a miss (§4.8).

import { unzip } from '../vendor/fflate.js';
import { atlasUV, validateAtlas, planZipFrames, applyFrameOrder } from './animation.js';

const BITMAP_OPTS = { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' };

async function decodeBlob(blob) {
  try {
    return await createImageBitmap(blob, BITMAP_OPTS);
  } catch (e) {
    throw new Error(`could not decode image: ${e.message ?? e}`);
  }
}

class BaseAsset {
  constructor(def) {
    this.def = def;
    this.ready = false;
    this.width = 0;
    this.height = 0;
    this.frameCount = 1;
    this.timeline = null;
  }
  textureIndex() { return 0; }
  uvRect() { return [0, 0, 1, 1]; }
  textureBytes() { return this.width * this.height * 4; }
  dispose() {}
}

export class StaticAsset extends BaseAsset {
  static async load(def, file) {
    const a = new StaticAsset(def);
    a.file = file;
    const bmp = await decodeBlob(file);
    a.width = bmp.width;
    a.height = bmp.height;
    bmp.close();
    a.ready = true;
    return a;
  }
  async textureSource() { return { image: await decodeBlob(this.file) }; }
}

export class SpriteAsset extends BaseAsset {
  static async load(def, file) {
    const a = new SpriteAsset(def);
    a.file = file;
    const bmp = await decodeBlob(file);
    a.atlasW = bmp.width;
    a.atlasH = bmp.height;
    bmp.close();
    const err = validateAtlas(def, a.atlasW, a.atlasH);
    if (err) throw new Error(err);
    a.width = def.frameWidth;
    a.height = def.frameHeight;
    a.frameCount = def.frameCount;
    a.ready = true;
    return a;
  }
  textureIndex() { return 0; } // the whole atlas is one texture
  uvRect(frame) { return atlasUV(frame, this.def, this.atlasW, this.atlasH); }
  textureBytes() { return this.atlasW * this.atlasH * 4; }
  async textureSource() { return { image: await decodeBlob(this.file) }; }
}

export class GifAsset extends BaseAsset {
  /** @param wasm the engine module namespace (needs GifDecoder) */
  static async load(def, file, wasm, maxMB = 512) {
    const a = new GifAsset(def);
    const bytes = new Uint8Array(await file.arrayBuffer());
    a.decoder = new wasm.GifDecoder(bytes, maxMB);
    a.width = a.decoder.width();
    a.height = a.decoder.height();
    a.frameCount = a.decoder.frame_count();
    a.timeline = Array.from(a.decoder.timeline_ms());
    a.ready = true;
    return a;
  }
  textureIndex(frame) { return frame; }
  async textureSource(i) {
    return { data: this.decoder.frame_rgba(i), width: this.width, height: this.height, straightAlpha: true };
  }
  dispose() { this.decoder?.free(); this.decoder = null; }
}

/** Procedural layers (visualizer, effect, lyrics) have no files; they are always ready. */
export class GeneratedAsset extends BaseAsset {
  constructor(def) { super(def); this.ready = true; }
  textureBytes() { return 0; }
}

function unzipAsync(bytes) {
  return new Promise((resolve, reject) => unzip(bytes, (err, files) => (err ? reject(err) : resolve(files))));
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const mimeOf = (name) => MIME[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream';

export class SequenceAsset extends BaseAsset {
  /** Returns the asset. `onProgress(done,total)` reports dimension validation. */
  static async load(def, file, onProgress) {
    const a = new SequenceAsset(def);
    const files = await unzipAsync(new Uint8Array(await file.arrayBuffer()));
    const plan = planZipFrames(Object.keys(files));
    if (plan.errors.length) throw new Error(`element '${def.id}': ${plan.errors.join('; ')}`);
    a.naturalNames = plan.ordered;
    a.names = applyFrameOrder(plan.ordered, def.frameOrder);
    a.files = files; // compressed/raw bytes only; decoded on demand
    a.frameCount = a.names.length;

    // Validate dimensions of every frame once; first frame sets the size.
    let done = 0;
    const offenders = [];
    for (let i = 0; i < a.names.length; i++) {
      const bmp = await a.decode(i);
      if (i === 0) { a.width = bmp.width; a.height = bmp.height; }
      else if (bmp.width !== a.width || bmp.height !== a.height) {
        offenders.push(`${a.names[i]} (${bmp.width}x${bmp.height})`);
      }
      bmp.close();
      onProgress?.(++done, a.names.length);
    }
    if (offenders.length) {
      throw new Error(
        `element '${def.id}': all frames must be ${a.width}x${a.height}; mismatched: ` +
        `${offenders.slice(0, 8).join(', ')}${offenders.length > 8 ? `, +${offenders.length - 8} more` : ''}`);
    }
    a.ready = true;
    return a;
  }
  async decode(i) {
    const name = this.names[i];
    return decodeBlob(new Blob([this.files[name]], { type: mimeOf(name) }));
  }
  textureIndex(frame) { return frame; }
  async textureSource(i) { return { image: await this.decode(i) }; }
  /** Small bitmap of frame `i` in NATURAL filename order (for the reorder UI). */
  async naturalThumb(i, size = 72) {
    const name = this.naturalNames[i];
    return createImageBitmap(new Blob([this.files[name]], { type: mimeOf(name) }), { resizeWidth: size, resizeQuality: 'low' });
  }
  /** First, middle and last frames (in current playback order) for the thumbnail strip. */
  async thumbnails(size = 72) {
    const idx = [...new Set([0, Math.floor(this.frameCount / 2), this.frameCount - 1])];
    return Promise.all(idx.map(async (i) => {
      const name = this.names[i];
      return createImageBitmap(new Blob([this.files[name]], { type: mimeOf(name) }), { resizeWidth: size, resizeQuality: 'low' });
    }));
  }
}

/**
 * Create the asset for an element definition.
 * @param files Map<string, File> keyed by project path
 */
export async function loadAsset(def, files, wasm, onProgress) {
  if (def.type === 'visualizer' || def.type === 'effect' || def.type === 'lyrics') return new GeneratedAsset(def);
  const need = (path) => {
    const f = files.get(path);
    if (!f) throw new Error(`element '${def.id}': file '${path}' has not been provided`);
    return f;
  };
  switch (def.type) {
    case 'static': return StaticAsset.load(def, need(def.path));
    case 'spriteSheet': return SpriteAsset.load(def, need(def.path));
    case 'gif': return GifAsset.load(def, need(def.path), wasm);
    case 'frameSequence': return SequenceAsset.load(def, need(def.zipPath), onProgress);
    default: throw new Error(`element '${def.id}': unknown type '${def.type}'`);
  }
}
