// Deterministic offline export (§8): frame-indexed render -> VideoEncoder,
// master mix -> AudioEncoder, mux with mp4-muxer / webm-muxer.

import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Buffer, FileSystemWritableFileStreamTarget as Mp4File } from '../vendor/mp4-muxer.mjs';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmBuffer, FileSystemWritableFileStreamTarget as WebmFile } from '../vendor/webm-muxer.mjs';
import { buildPlan } from './animation.js';

export const EXPORT_BATCH = 32;          // evaluate_batch size (§13 Q1, see README)
const VIDEO_QUEUE_MAX = 30;              // backpressure (§8.4)
const AUDIO_QUEUE_MAX = 16;
const AUDIO_CHUNK_FRAMES = 4096;
const AUDIO_LOOKAHEAD_US = 500_000;      // interleave audio ~0.5 s ahead of video

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- codec selection ----------

/** H.264 level_idc (hex) for macroblock rate; never below 4.1 (§8.1). */
export function avcLevelHex(width, height, fps) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = mbs * fps;
  if (mbs <= 8192 && rate <= 245_760) return '29'; // 4.1
  if (mbs <= 8704 && rate <= 522_240) return '2a'; // 4.2
  if (mbs <= 36_864 && rate <= 983_040) return '33'; // 5.1
  return '34';                                       // 5.2
}

/** VP9 level for luma sample rate. */
export function vp9LevelCode(width, height, fps) {
  const rate = width * height * fps;
  if (rate <= 66_846_720) return '40';
  if (rate <= 133_693_440) return '41';
  if (rate <= 267_386_880) return '50';
  if (rate <= 534_773_760) return '51';
  return '52';
}

export function videoBitrate(width, height, fps) {
  return Math.round(Math.min(40_000_000, Math.max(2_000_000, width * height * fps * 0.09)));
}

/** Rough output size in bytes (video + 192 kbps audio), for in-memory-export warnings. */
export function estimateOutputBytes({ width, height, fps, durationSec }) {
  return Math.round(((videoBitrate(width, height, fps) + 192_000) * durationSec) / 8);
}

export function isLikelyMobile() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform ?? ''));
}

function configs({ width, height, fps, sampleRate, channels }) {
  const bitrate = videoBitrate(width, height, fps);
  const ch = Math.min(2, channels);
  return {
    h264: { codec: `avc1.4d00${avcLevelHex(width, height, fps)}`, width, height, bitrate, framerate: fps, avc: { format: 'avc' } },
    aac: { codec: 'mp4a.40.2', sampleRate, numberOfChannels: ch, bitrate: 192_000 },
    vp9: { codec: `vp09.00.${vp9LevelCode(width, height, fps)}.08`, width, height, bitrate, framerate: fps },
    // Chrome's Opus encoder only accepts 8/12/16/24/48 kHz: always encode at 48 kHz.
    opus: { codec: 'opus', sampleRate: 48_000, numberOfChannels: ch, bitrate: 160_000 },
  };
}

/**
 * Mandatory capability probe before any frame is rendered (§8.2).
 * Returns { container: 'mp4'|'webm', video, audio, label } or throws.
 */
export async function probeCodecs(params) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
    throw new Error('This browser has no WebCodecs support. Use a current Chrome, Edge, or Safari.');
  }
  if (params.width % 2 || params.height % 2) {
    throw new Error(`Resolution ${params.width}x${params.height} must have even dimensions for video encoding.`);
  }
  const c = configs(params);
  const ok = async (kind, cfg) => {
    try { return (await kind.isConfigSupported(cfg)).supported === true; } catch { return false; }
  };
  const [h264, aac] = [await ok(VideoEncoder, c.h264), await ok(AudioEncoder, c.aac)];
  if (h264 && aac) return { container: 'mp4', video: c.h264, audio: c.aac, label: 'MP4 (H.264 + AAC)' };
  const [vp9, opus] = [await ok(VideoEncoder, c.vp9), await ok(AudioEncoder, c.opus)];
  if (vp9 && opus) return { container: 'webm', video: c.vp9, audio: c.opus, label: 'WebM (VP9 + Opus)' };
  throw new Error('No supported codec pair in this browser (need H.264+AAC or VP9+Opus).');
}

// ---------- output target ----------

/**
 * Open the output. MUST be called directly from a click handler: the save
 * picker needs a user gesture, and it is called before the long render.
 * Falls back to an in-memory Blob where showSaveFilePicker is unavailable (§8.5).
 */
export async function openOutput(container) {
  const ext = container === 'mp4' ? 'mp4' : 'webm';
  const mime = container === 'mp4' ? 'video/mp4' : 'video/webm';
  if (typeof window.showSaveFilePicker === 'function') {
    const handle = await window.showSaveFilePicker({
      suggestedName: `easymv.${ext}`,
      types: [{ description: container === 'mp4' ? 'MP4 video' : 'WebM video', accept: { [mime]: [`.${ext}`] } }],
    });
    const stream = await handle.createWritable();
    const target = container === 'mp4' ? new Mp4File(stream) : new WebmFile(stream);
    return { streaming: true, target, name: handle.name, mime,
      commit: async () => { await stream.close(); },
      abort: async () => { try { await stream.abort(); } catch { /* already closed */ } } };
  }
  const target = container === 'mp4' ? new Mp4Buffer() : new WebmBuffer();
  return { streaming: false, target, name: `easymv.${ext}`, mime,
    commit: async () => {
      const blob = new Blob([target.buffer], { type: mime });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `easymv.${ext}` });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    },
    abort: async () => {} };
}

// ---------- audio sources ----------

/** Planar chunks straight from the engine's interleaved master PCM (no full copy). */
function viewAudioSource(bridge) {
  const info = bridge.masterInfo;
  const ch = Math.min(2, info.channels);
  return {
    sampleRate: info.sampleRate, channels: ch, frames: info.frames,
    chunk(start, n) {
      const pcm = bridge.masterPcm(); // re-view each time: WASM memory may have grown
      const out = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) {
        for (let i = 0; i < n; i++) out[c * n + i] = pcm[(start + i) * info.channels + c];
      }
      return out;
    },
  };
}

/** Resample the master to 48 kHz with the browser (for Opus). */
async function resampledAudioSource(bridge, targetRate) {
  const info = bridge.masterInfo;
  const ch = Math.min(2, info.channels);
  const pcm = bridge.masterPcm();
  const inBuf = new AudioBuffer({ numberOfChannels: ch, length: info.frames, sampleRate: info.sampleRate });
  for (let c = 0; c < ch; c++) {
    const plane = new Float32Array(info.frames);
    for (let i = 0; i < info.frames; i++) plane[i] = pcm[i * info.channels + c];
    inBuf.copyToChannel(plane, c);
  }
  const outLen = Math.ceil((info.frames * targetRate) / info.sampleRate);
  const ctx = new OfflineAudioContext(ch, outLen, targetRate);
  const src = ctx.createBufferSource();
  src.buffer = inBuf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  const planes = Array.from({ length: ch }, (_, c) => out.getChannelData(c));
  return {
    sampleRate: targetRate, channels: ch, frames: out.length,
    chunk(start, n) {
      const o = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) o.set(planes[c].subarray(start, start + n), c * n);
      return o;
    },
  };
}

// ---------- export ----------

/**
 * @param opts.bridge      EngineBridge (compiled engine)
 * @param opts.assets      assets parallel to project.elements
 * @param opts.renderer    Renderer sized to the export resolution
 * @param opts.project     current project
 * @param opts.probe       result of probeCodecs()
 * @param opts.output      result of openOutput()
 * @param opts.audioOffsetMs  A/V sync compensation (§8.3); >0 delays audio
 * @param opts.signal      AbortSignal for cancellation
 * @param opts.onProgress  (fraction, frameIndex) => void
 * @returns 'done' | 'cancelled'
 */
export async function runExport(opts) {
  const { bridge, assets, renderer, project, probe, output, signal, onProgress } = opts;
  const fps = project.videoFps;
  const total = bridge.totalFrames;
  const keyInterval = Math.round(fps * 2);
  const frameDurUs = Math.round(1_000_000 / fps);
  const offsetUs = Math.round((opts.audioOffsetMs ?? 0) * 1000);
  const videoBaseUs = Math.max(0, -offsetUs);
  const audioBaseUs = Math.max(0, offsetUs);
  const { width, height } = probe.video;

  const audio = probe.audio.sampleRate === bridge.masterInfo.sampleRate
    ? viewAudioSource(bridge)
    : await resampledAudioSource(bridge, probe.audio.sampleRate);

  let fatal = null;
  const fail = (e) => { fatal ??= e; };

  const muxer = probe.container === 'mp4'
    ? new Mp4Muxer({
        target: output.target,
        video: { codec: 'avc', width, height, frameRate: fps },
        audio: { codec: 'aac', numberOfChannels: audio.channels, sampleRate: audio.sampleRate },
        fastStart: output.streaming ? 'fragmented' : 'in-memory',
        firstTimestampBehavior: 'cross-track-offset',
      })
    : new WebmMuxer({
        target: output.target,
        video: { codec: 'V_VP9', width, height, frameRate: fps },
        audio: { codec: 'A_OPUS', numberOfChannels: audio.channels, sampleRate: audio.sampleRate },
        firstTimestampBehavior: 'permissive',
      });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: fail,
  });
  videoEncoder.configure(probe.video);
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: fail,
  });
  audioEncoder.configure({ ...probe.audio, sampleRate: audio.sampleRate, numberOfChannels: audio.channels });

  let audioCursor = 0; // in audio frames
  async function feedAudioUntil(limitUs) {
    while (audioCursor < audio.frames && (audioBaseUs + (audioCursor * 1e6) / audio.sampleRate) < limitUs) {
      const n = Math.min(AUDIO_CHUNK_FRAMES, audio.frames - audioCursor);
      const data = new AudioData({
        format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: n, numberOfChannels: audio.channels,
        timestamp: Math.round(audioBaseUs + (audioCursor * 1e6) / audio.sampleRate), // explicit (§8.4)
        data: audio.chunk(audioCursor, n),
      });
      audioEncoder.encode(data);
      data.close();
      audioCursor += n;
      while (audioEncoder.encodeQueueSize > AUDIO_QUEUE_MAX && !fatal) await sleep(1);
    }
  }

  const abortAll = async () => {
    try { videoEncoder.close(); } catch { /* closed */ }
    try { audioEncoder.close(); } catch { /* closed */ }
    await output.abort();
  };

  const fv = bridge.frameView;
  try {
    for (let start = 0; start < total; start += EXPORT_BATCH) {
      const n = bridge.evaluate(start, EXPORT_BATCH);
      for (let i = 0; i < n; i++) {
        if (signal?.aborted) { await abortAll(); return 'cancelled'; }
        if (fatal) throw fatal;
        const frameIdx = start + i;
        const tsUs = Math.round((frameIdx * 1_000_000) / fps);

        const plan = buildPlan(assets, fv.at(i), frameIdx, fps); // pure function of frameIdx
        await renderer.prepare(plan);
        renderer.draw(plan);

        const vf = new VideoFrame(renderer.canvas, {
          timestamp: videoBaseUs + tsUs, duration: frameDurUs, // explicit (§8.4)
        });
        videoEncoder.encode(vf, { keyFrame: frameIdx % keyInterval === 0 });
        vf.close(); // always

        await feedAudioUntil(videoBaseUs + tsUs + AUDIO_LOOKAHEAD_US);
        while (videoEncoder.encodeQueueSize > VIDEO_QUEUE_MAX && !fatal) await sleep(1); // backpressure
        onProgress?.((frameIdx + 1) / total, frameIdx);
      }
    }
    await feedAudioUntil(Infinity);
    await videoEncoder.flush();
    await audioEncoder.flush();
    if (fatal) throw fatal;
    muxer.finalize();
    videoEncoder.close();
    audioEncoder.close();
    await output.commit();
    return 'done';
  } catch (e) {
    await abortAll();
    throw e;
  }
}
