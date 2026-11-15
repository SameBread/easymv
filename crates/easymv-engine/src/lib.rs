//! EasyMV engine: audio decode/resample, feature extraction, smoothing,
//! routing evaluation (`evaluate_batch`), automatic mode, GIF decoding.
//!
//! Pure logic lives in plain modules (unit-testable natively); this file is the
//! thin wasm-bindgen layer.

pub mod audio;
pub mod automode;
pub mod core;
pub mod features;
pub mod gif_decode;
pub mod project;
pub mod routing;

use project::{Project, PROPERTY_COUNT, PROPERTY_NAMES};
use wasm_bindgen::prelude::*;

fn js_err(s: impl Into<String>) -> JsError {
    JsError::new(&s.into())
}

fn parse_project(json: &str) -> Result<Project, JsError> {
    serde_json::from_str(json).map_err(|e| js_err(format!("invalid project JSON: {e}")))
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Number of properties per element in the output buffer (§5.3).
#[wasm_bindgen]
pub fn property_count() -> u32 {
    PROPERTY_COUNT as u32
}

/// JSON array of property names, in buffer order.
#[wasm_bindgen]
pub fn property_names() -> String {
    serde_json::to_string(&PROPERTY_NAMES).unwrap()
}

/// Validate a project. Returns JSON `[{severity, message}]`.
#[wasm_bindgen]
pub fn validate_project(project_json: &str) -> Result<String, JsError> {
    let p = parse_project(project_json)?;
    Ok(serde_json::to_string(&project::validate(&p)).unwrap())
}

/// Run automatic mode: replaces `origin: "auto"` connections, keeps user ones.
/// Returns the full updated project JSON.
#[wasm_bindgen]
pub fn auto_mode(project_json: &str) -> Result<String, JsError> {
    let mut p = parse_project(project_json)?;
    automode::apply(&mut p);
    Ok(serde_json::to_string(&p).unwrap())
}

#[wasm_bindgen]
pub struct Engine {
    core: core::Core,
}

#[wasm_bindgen]
impl Engine {
    /// Create an engine from a project (analysis settings are fixed here).
    #[wasm_bindgen(constructor)]
    pub fn new(project_json: &str) -> Result<Engine, JsError> {
        let p = parse_project(project_json)?;
        Ok(Engine { core: core::Core::new(&p).map_err(js_err)? })
    }

    pub fn load_master(&mut self, bytes: &[u8], ext: &str) -> Result<(), JsError> {
        self.core.load_master(bytes.to_vec(), Some(ext)).map_err(js_err)
    }

    pub fn load_stem(&mut self, id: &str, bytes: &[u8], ext: &str) -> Result<(), JsError> {
        self.core.load_stem(id, bytes.to_vec(), Some(ext)).map_err(js_err)
    }

    /// Sources still waiting for analysis.
    pub fn analysis_pending(&self) -> u32 {
        self.core.analysis_pending() as u32
    }

    /// Analyze one queued source; returns its id ("" when nothing was queued).
    /// Call in a loop, yielding to the UI between calls, to show progress.
    pub fn analysis_step(&mut self) -> Result<String, JsError> {
        Ok(self.core.analysis_step().map_err(js_err)?.unwrap_or_default())
    }

    /// (Re)compile routing from a project. Cheap; does not re-analyze audio.
    /// Returns JSON `[{severity, message}]` warnings; throws on errors.
    pub fn compile(&mut self, project_json: &str) -> Result<String, JsError> {
        let p = parse_project(project_json)?;
        let issues = self.core.compile(&p).map_err(js_err)?;
        Ok(serde_json::to_string(&issues).unwrap())
    }

    /// Evaluate `count` frames from `start_frame` (§5.5). Returns frames evaluated.
    pub fn evaluate_batch(&mut self, start_frame: u32, count: u32) -> u32 {
        self.core.evaluate_batch(start_frame as usize, count as usize) as u32
    }

    /// Pointer to the output buffer in WASM linear memory. May change after `compile`.
    pub fn output_ptr(&self) -> *const f32 {
        self.core.output().as_ptr()
    }

    /// Output buffer length in f32 elements. May change after `compile`.
    pub fn output_len(&self) -> usize {
        self.core.output().len()
    }

    /// Re-read element base values only (no recompile). For live drag edits.
    pub fn update_base(&mut self, project_json: &str) -> Result<(), JsError> {
        let p = parse_project(project_json)?;
        self.core.update_base(&p).map_err(js_err)
    }

    /// JSON array of analyzed source ids (master first).
    pub fn source_ids(&self) -> String {
        serde_json::to_string(&self.core.source_ids()).unwrap()
    }

    pub fn analysis_rate(&self) -> u32 {
        self.core.analysis_rate()
    }

    /// Normalized feature series [0,1] at the analysis rate. Index order:
    /// rms, low, mid, high, onset, centroid. Empty if unknown.
    pub fn feature_series(&self, source_id: &str, feature_idx: u32) -> Vec<f32> {
        self.core
            .feature_series(source_id, feature_idx as usize)
            .map(|s| s.to_vec())
            .unwrap_or_default()
    }

    /// Band spectrum, frame-major `[frame * bands + band]`, 0..1, analysis grid.
    /// `bands` is clamped to 8..=256. Empty for an unknown source.
    pub fn spectrum_series(&mut self, source_id: &str, bands: u32) -> Vec<f32> {
        self.core.spectrum(source_id, bands.clamp(8, 256) as usize).unwrap_or_default()
    }

    /// Pointer / length of a source's mono signal (f32 samples at the project sample rate).
    /// Valid until the engine is dropped or memory is reallocated by loading more audio.
    pub fn source_mono_ptr(&self, source_id: &str) -> *const f32 {
        self.core.source_mono(source_id).map_or(std::ptr::null(), |m| m.as_ptr())
    }
    pub fn source_mono_len(&self, source_id: &str) -> usize {
        self.core.source_mono(source_id).map_or(0, |m| m.len())
    }

    pub fn total_frames(&self) -> u32 {
        self.core.total_frames() as u32
    }

    pub fn element_count(&self) -> u32 {
        self.core.element_count() as u32
    }

    // ---- master audio for the export AudioEncoder (interleaved f32) ----

    pub fn master_sample_rate(&self) -> u32 {
        self.core.master().map_or(0, |m| m.sample_rate)
    }
    pub fn master_channels(&self) -> u32 {
        self.core.master().map_or(0, |m| m.channels as u32)
    }
    pub fn master_frames(&self) -> u32 {
        self.core.master().map_or(0, |m| m.frames() as u32)
    }
    pub fn master_pcm_ptr(&self) -> *const f32 {
        self.core.master().map_or(std::ptr::null(), |m| m.data.as_ptr())
    }
    pub fn master_pcm_len(&self) -> usize {
        self.core.master().map_or(0, |m| m.data.len())
    }
}

/// Decoded GIF held in WASM memory; the renderer pulls frames on demand.
#[wasm_bindgen]
pub struct GifDecoder {
    gif: gif_decode::DecodedGif,
}

#[wasm_bindgen]
impl GifDecoder {
    /// `max_mb` caps total decoded RGBA size.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8], max_mb: u32) -> Result<GifDecoder, JsError> {
        let gif = gif_decode::decode_gif(bytes, max_mb as usize * 1024 * 1024).map_err(js_err)?;
        Ok(GifDecoder { gif })
    }
    pub fn width(&self) -> u32 {
        self.gif.width
    }
    pub fn height(&self) -> u32 {
        self.gif.height
    }
    pub fn frame_count(&self) -> u32 {
        self.gif.frames.len() as u32
    }
    /// Cumulative start times in ms, length frame_count + 1 (last = total duration).
    pub fn timeline_ms(&self) -> Vec<u32> {
        self.gif.timeline_ms()
    }
    /// Straight-alpha RGBA8 for frame `i` (copied out).
    pub fn frame_rgba(&self, i: u32) -> Vec<u8> {
        self.gif.frames.get(i as usize).cloned().unwrap_or_default()
    }
}
