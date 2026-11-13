// Engine bridge: wasm init, zero-allocation output view, FrameView (§5.5).

import init, * as wasm from '../pkg/easymv_engine.js';
import { PROPERTY_COUNT, PROPERTY_NAMES } from './animation.js';

export { wasm };

let wasmMemory = null;

export async function initEngine() {
  const exports = await init();
  wasmMemory = exports.memory;
  // The property order is part of the engine contract; fail loudly on drift.
  const count = wasm.property_count();
  const names = JSON.parse(wasm.property_names());
  if (count !== PROPERTY_COUNT || names.join() !== PROPERTY_NAMES.join()) {
    throw new Error(`engine/renderer property layout mismatch: engine=${names.join(',')}`);
  }
  return wasm;
}

/** Reads one frame of a batch without allocating. */
export class FrameView {
  constructor(bridge) { this.bridge = bridge; this.base = 0; }
  at(batchIdx) { this.base = batchIdx * this.bridge.elementCount * PROPERTY_COUNT; return this; }
  get(elementIdx, propertyIdx) {
    return this.bridge.view[this.base + elementIdx * PROPERTY_COUNT + propertyIdx];
  }
}

export class EngineBridge {
  constructor(engine) {
    this.engine = engine;
    this.view = new Float32Array(0);
    this._ptr = -1;
    this._len = -1;
    this.elementCount = 0;
    this.frameView = new FrameView(this);
  }

  /**
   * Recreate the Float32Array view if WASM memory grew (buffer detached) OR the
   * engine reallocated its output buffer (pointer/length changed after compile).
   */
  refreshView() {
    const ptr = this.engine.output_ptr();
    const len = this.engine.output_len();
    if (this.view.buffer !== wasmMemory.buffer || this.view.byteLength === 0 && len > 0 ||
        ptr !== this._ptr || len !== this._len) {
      this.view = new Float32Array(wasmMemory.buffer, ptr, len);
      this._ptr = ptr;
      this._len = len;
    }
    this.elementCount = this.engine.element_count();
  }

  /** Evaluate `count` frames from `start`; returns frames evaluated. */
  evaluate(start, count) {
    const n = this.engine.evaluate_batch(start, count);
    this.refreshView();
    return n;
  }

  get totalFrames() { return this.engine.total_frames(); }

  /** Interleaved master PCM as a Float32Array view (valid until memory grows). */
  masterPcm() {
    return new Float32Array(wasmMemory.buffer, this.engine.master_pcm_ptr(), this.engine.master_pcm_len());
  }
  get masterInfo() {
    return {
      sampleRate: this.engine.master_sample_rate(),
      channels: this.engine.master_channels(),
      frames: this.engine.master_frames(),
    };
  }
}
