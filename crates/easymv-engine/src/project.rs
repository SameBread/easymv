//! Project file model (§6), property registry (§5.3) and validation (§5.4).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub const PROPERTY_COUNT: usize = 16;
pub const MAX_BATCH: usize = 64;

/// Property registry. The ORDER IS THE ENGINE CONTRACT (§5.3).
pub const PROPERTY_NAMES: [&str; PROPERTY_COUNT] = [
    "positionX", "positionY", "rotation", "scale", "scaleX", "scaleY", "mirrorX", "mirrorY",
    "opacity", "hueShift", "saturation", "brightness", "contrast", "blur", "anchorX", "anchorY",
];

const TAU: f32 = std::f32::consts::PI * 2.0;

pub const PROPERTY_CLAMPS: [(f32, f32); PROPERTY_COUNT] = [
    (-1.0, 2.0),
    (-1.0, 2.0),
    (-TAU, TAU),
    (0.01, 10.0),
    (0.01, 10.0),
    (0.01, 10.0),
    (0.0, 1.0),
    (0.0, 1.0),
    (0.0, 1.0),
    (0.0, 360.0),
    (0.0, 4.0),
    (0.0, 4.0),
    (0.0, 4.0),
    (0.0, 200.0),
    (0.0, 1.0),
    (0.0, 1.0),
];

/// Default base value when an element does not specify one.
pub const PROPERTY_DEFAULTS: [f32; PROPERTY_COUNT] = [
    0.5, 0.5, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.5, 0.5,
];

pub fn property_index(name: &str) -> Option<usize> {
    PROPERTY_NAMES.iter().position(|p| *p == name)
}

pub const FEATURE_NAMES: [&str; 6] = ["rms", "low", "mid", "high", "onset", "centroid"];

pub fn feature_index(name: &str) -> Option<usize> {
    FEATURE_NAMES.iter().position(|p| *p == name)
}

pub const MASTER_ID: &str = "master";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssetRef {
    pub path: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StemDef {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ElementType {
    Static,
    SpriteSheet,
    Gif,
    FrameSequence,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum LoopMode {
    Once,
    #[default]
    Loop,
    PingPong,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum VisualBlend {
    #[default]
    Normal,
    Add,
    Multiply,
}

/// How an element's intrinsic size maps to the canvas at `scale == 1`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FitMode {
    /// 1 source pixel = 1 canvas pixel (default for sprites, GIFs, sequences).
    Natural,
    /// Scale uniformly to fit inside the canvas.
    Contain,
    /// Scale uniformly to cover the canvas (default for static images).
    Cover,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ElementDef {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ElementType,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub zip_path: Option<String>,
    #[serde(default)]
    pub frame_width: Option<u32>,
    #[serde(default)]
    pub frame_height: Option<u32>,
    #[serde(default)]
    pub columns: Option<u32>,
    #[serde(default)]
    pub rows: Option<u32>,
    #[serde(default)]
    pub frame_count: Option<u32>,
    #[serde(default)]
    pub internal_fps: Option<f64>,
    #[serde(default)]
    pub loop_mode: LoopMode,
    #[serde(default)]
    pub interpolate: bool,
    #[serde(default)]
    pub padding: Option<u32>,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub z_index: i32,
    #[serde(default)]
    pub visual_blend: VisualBlend,
    #[serde(default)]
    pub fit: Option<FitMode>,
    #[serde(default)]
    pub frame_order: Option<Vec<u32>>,
    #[serde(default)]
    pub base: HashMap<String, f32>,
}

impl ElementDef {
    pub fn base_vector(&self) -> [f32; PROPERTY_COUNT] {
        let mut out = PROPERTY_DEFAULTS;
        for (k, v) in &self.base {
            if let Some(i) = property_index(k) {
                out[i] = *v;
            }
        }
        out
    }
    pub fn is_animated(&self) -> bool {
        self.kind != ElementType::Static
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Curve {
    Linear,
    EaseIn,
    EaseOut,
    Smoothstep,
    Threshold,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Combine {
    Replace,
    Add,
    Multiply,
    Max,
    Min,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    #[default]
    User,
    Auto,
}

fn default_curve() -> Curve {
    Curve::Linear
}
fn default_combine() -> Combine {
    Combine::Add
}
fn default_out_max() -> f32 {
    1.0
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub source: String,
    pub feature: String,
    pub element: String,
    pub property: String,
    #[serde(default = "default_curve")]
    pub curve: Curve,
    #[serde(default)]
    pub out_min: f32,
    #[serde(default = "default_out_max")]
    pub out_max: f32,
    #[serde(default = "default_combine")]
    pub combine: Combine,
    #[serde(default)]
    pub attack_ms: f32,
    #[serde(default)]
    pub release_ms: f32,
    #[serde(default)]
    pub threshold: Option<f32>,
    #[serde(default)]
    pub origin: Origin,
}

fn default_video_fps() -> f64 {
    30.0
}
fn default_analysis_rate() -> u32 {
    200
}
fn default_sample_rate() -> u32 {
    44_100
}
fn default_resolution() -> [u32; 2] {
    [1920, 1080]
}
fn default_version() -> u32 {
    4
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default = "default_video_fps")]
    pub video_fps: f64,
    #[serde(default = "default_analysis_rate")]
    pub analysis_rate: u32,
    #[serde(default = "default_sample_rate")]
    pub sample_rate: u32,
    #[serde(default = "default_resolution")]
    pub resolution: [u32; 2],
    pub master_mix: AssetRef,
    #[serde(default)]
    pub stems: Vec<StemDef>,
    #[serde(default)]
    pub elements: Vec<ElementDef>,
    #[serde(default)]
    pub connections: Vec<Connection>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Serialize, Clone, Debug)]
pub struct Issue {
    pub severity: Severity,
    pub message: String,
}

impl Issue {
    fn err(m: impl Into<String>) -> Self {
        Issue { severity: Severity::Error, message: m.into() }
    }
    fn warn(m: impl Into<String>) -> Self {
        Issue { severity: Severity::Warning, message: m.into() }
    }
}

/// Nearest smooth video-fps suggestions for an internal fps (§4.9).
pub fn judder_suggestions(internal_fps: f64) -> &'static [u32] {
    match internal_fps.round() as i64 {
        12 => &[24, 48, 60],
        15 => &[30, 60],
        24 => &[24, 48, 72],
        25 => &[25, 50],
        _ => &[],
    }
}

fn is_multiple(video_fps: f64, internal_fps: f64) -> bool {
    if internal_fps <= 0.0 {
        return false;
    }
    let r = video_fps / internal_fps;
    (r - r.round()).abs() < 1e-6 && r.round() >= 1.0
}

/// Validate structure and cross references. Errors reject the project.
pub fn validate(p: &Project) -> Vec<Issue> {
    let mut out = Vec::new();

    if !(p.video_fps.is_finite() && p.video_fps > 0.0 && p.video_fps <= 240.0) {
        out.push(Issue::err(format!("videoFps must be in (0, 240], got {}", p.video_fps)));
    }
    if !(100..=1000).contains(&p.analysis_rate) {
        out.push(Issue::err(format!("analysisRate must be 100..1000 Hz, got {}", p.analysis_rate)));
    }
    if !(8_000..=192_000).contains(&p.sample_rate) {
        out.push(Issue::err(format!("sampleRate must be 8000..192000 Hz, got {}", p.sample_rate)));
    }
    if p.resolution[0] == 0 || p.resolution[1] == 0 {
        out.push(Issue::err("resolution must be non-zero"));
    }

    // Stems
    let mut stem_ids: HashSet<&str> = HashSet::new();
    for s in &p.stems {
        if s.id == MASTER_ID {
            out.push(Issue::err(format!("stem id '{}' is reserved for the master mix", MASTER_ID)));
        }
        if !stem_ids.insert(s.id.as_str()) {
            out.push(Issue::err(format!("duplicate stem id '{}'", s.id)));
        }
    }

    // Elements
    let mut element_ids: HashSet<&str> = HashSet::new();
    for e in &p.elements {
        if !element_ids.insert(e.id.as_str()) {
            out.push(Issue::err(format!("duplicate element id '{}'", e.id)));
        }
        validate_element(e, p.video_fps, &mut out);
    }

    // Connections
    let mut replace_seen: HashSet<(&str, &str)> = HashSet::new();
    for (i, c) in p.connections.iter().enumerate() {
        let tag = format!("connection #{} ({} {} -> {}.{})", i, c.source, c.feature, c.element, c.property);
        if c.source != MASTER_ID && !stem_ids.contains(c.source.as_str()) {
            out.push(Issue::err(format!("{}: unknown source '{}'", tag, c.source)));
        }
        if feature_index(&c.feature).is_none() {
            out.push(Issue::err(format!("{}: unknown feature '{}'", tag, c.feature)));
        }
        if !element_ids.contains(c.element.as_str()) {
            out.push(Issue::err(format!("{}: unknown element '{}'", tag, c.element)));
        }
        if property_index(&c.property).is_none() {
            out.push(Issue::err(format!("{}: unknown property '{}'", tag, c.property)));
        }
        if !c.out_min.is_finite() || !c.out_max.is_finite() {
            out.push(Issue::err(format!("{}: outMin/outMax must be finite", tag)));
        }
        if c.attack_ms < 0.0 || c.release_ms < 0.0 || !c.attack_ms.is_finite() || !c.release_ms.is_finite() {
            out.push(Issue::err(format!("{}: attackMs/releaseMs must be >= 0", tag)));
        }
        if c.curve == Curve::Threshold && c.threshold.is_none() {
            out.push(Issue::err(format!("{}: curve 'threshold' requires a threshold value", tag)));
        }
        if c.combine == Combine::Replace && !replace_seen.insert((c.element.as_str(), c.property.as_str())) {
            out.push(Issue::err(format!(
                "multiple 'replace' connections target {}.{} (at most one allowed)",
                c.element, c.property
            )));
        }
    }
    out
}

fn validate_element(e: &ElementDef, video_fps: f64, out: &mut Vec<Issue>) {
    let id = &e.id;
    match e.kind {
        ElementType::Static | ElementType::Gif => {
            if e.path.as_deref().map_or(true, str::is_empty) {
                out.push(Issue::err(format!("element '{}': 'path' is required", id)));
            }
        }
        ElementType::SpriteSheet => {
            if e.path.as_deref().map_or(true, str::is_empty) {
                out.push(Issue::err(format!("element '{}': 'path' is required", id)));
            }
            let (fw, fh, c, r, n) = (e.frame_width, e.frame_height, e.columns, e.rows, e.frame_count);
            if fw.unwrap_or(0) == 0 || fh.unwrap_or(0) == 0 || c.unwrap_or(0) == 0 || r.unwrap_or(0) == 0 || n.unwrap_or(0) == 0 {
                out.push(Issue::err(format!(
                    "element '{}': spriteSheet requires non-zero frameWidth, frameHeight, columns, rows, frameCount",
                    id
                )));
            } else if n.unwrap() > c.unwrap() * r.unwrap() {
                out.push(Issue::err(format!(
                    "element '{}': frameCount {} exceeds columns x rows ({} x {})",
                    id, n.unwrap(), c.unwrap(), r.unwrap()
                )));
            }
        }
        ElementType::FrameSequence => {
            if e.zip_path.as_deref().map_or(true, str::is_empty) {
                out.push(Issue::err(format!("element '{}': 'zipPath' is required", id)));
            }
        }
    }
    if matches!(e.kind, ElementType::SpriteSheet | ElementType::FrameSequence) {
        match e.internal_fps {
            Some(f) if f.is_finite() && f > 0.0 => {
                if !is_multiple(video_fps, f) {
                    let sug = judder_suggestions(f);
                    let hint = if sug.is_empty() {
                        String::new()
                    } else {
                        format!(
                            " Smooth video fps for {} fps animation: {}.",
                            f,
                            sug.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(", ")
                        )
                    };
                    out.push(Issue::warn(format!(
                        "element '{}': video fps {} is not a multiple of internalFps {}; animation will judder.{}",
                        id, video_fps, f, hint
                    )));
                }
            }
            _ => out.push(Issue::err(format!("element '{}': internalFps must be > 0", id))),
        }
    }
    if e.interpolate {
        out.push(Issue::warn(format!(
            "element '{}': crossfading hand-drawn frames can produce ghosting.",
            id
        )));
    }
    if let Some(order) = &e.frame_order {
        let mut seen = HashSet::new();
        for &i in order {
            if !seen.insert(i) {
                out.push(Issue::err(format!("element '{}': frameOrder contains duplicate index {}", id, i)));
                break;
            }
        }
        if let Some(&m) = order.iter().max() {
            if m as usize >= order.len() {
                out.push(Issue::err(format!("element '{}': frameOrder must be a permutation of 0..N-1", id)));
            }
        }
    }
    for (k, v) in &e.base {
        if property_index(k).is_none() {
            out.push(Issue::err(format!("element '{}': unknown base property '{}'", id, k)));
        } else if !v.is_finite() {
            out.push(Issue::err(format!("element '{}': base.{} must be finite", id, k)));
        }
    }
}

pub fn has_errors(issues: &[Issue]) -> bool {
    issues.iter().any(|i| i.severity == Severity::Error)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn sample_project() -> Project {
        serde_json::from_str(
            r#"{
              "version": 4, "videoFps": 24, "analysisRate": 200, "sampleRate": 44100,
              "resolution": [1280, 720],
              "masterMix": { "path": "master.wav" },
              "stems": [ { "id": "drums", "path": "drums.wav" } ],
              "elements": [
                { "id": "chibi", "type": "spriteSheet", "path": "c.png", "frameWidth": 128, "frameHeight": 128,
                  "columns": 8, "rows": 4, "frameCount": 12, "internalFps": 12, "zIndex": 1 },
                { "id": "bg", "type": "static", "path": "bg.jpg", "zIndex": 0 }
              ],
              "connections": [
                { "source": "drums", "feature": "onset", "element": "chibi", "property": "scaleX",
                  "curve": "easeOut", "outMin": 0, "outMax": 0.2, "combine": "add",
                  "attackMs": 10, "releaseMs": 200 }
              ]
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn sample_is_valid() {
        let p = sample_project();
        assert!(!has_errors(&validate(&p)));
    }

    #[test]
    fn rejects_reserved_and_duplicates() {
        let mut p = sample_project();
        p.stems.push(StemDef { id: "master".into(), path: "x".into(), label: None });
        p.stems.push(StemDef { id: "drums".into(), path: "y".into(), label: None });
        p.elements.push(p.elements[0].clone());
        let issues = validate(&p);
        let msgs: Vec<_> = issues.iter().map(|i| i.message.as_str()).collect();
        assert!(msgs.iter().any(|m| m.contains("reserved")));
        assert!(msgs.iter().any(|m| m.contains("duplicate stem id")));
        assert!(msgs.iter().any(|m| m.contains("duplicate element id")));
    }

    #[test]
    fn rejects_double_replace_and_bad_targets() {
        let mut p = sample_project();
        let mut c = p.connections[0].clone();
        c.combine = Combine::Replace;
        p.connections = vec![c.clone(), c.clone()];
        p.connections.push(Connection { element: "nope".into(), property: "bogus".into(), ..c });
        let issues = validate(&p);
        let msgs: Vec<_> = issues.iter().map(|i| i.message.as_str()).collect();
        assert!(msgs.iter().any(|m| m.contains("multiple 'replace'")));
        assert!(msgs.iter().any(|m| m.contains("unknown element")));
        assert!(msgs.iter().any(|m| m.contains("unknown property")));
    }

    #[test]
    fn sprite_framecount_checked() {
        let mut p = sample_project();
        p.elements[0].frame_count = Some(99);
        assert!(has_errors(&validate(&p)));
    }

    #[test]
    fn judder_warning_with_suggestion() {
        let mut p = sample_project();
        p.video_fps = 30.0; // 12 does not divide 30
        let issues = validate(&p);
        let w = issues.iter().find(|i| i.severity == Severity::Warning && i.message.contains("judder")).unwrap();
        assert!(w.message.contains("24, 48, 60"));
        p.video_fps = 24.0;
        assert!(!validate(&p).iter().any(|i| i.message.contains("judder")));
    }

    #[test]
    fn property_layout_is_stable() {
        assert_eq!(PROPERTY_NAMES.len(), PROPERTY_COUNT);
        assert_eq!(property_index("positionX"), Some(0));
        assert_eq!(property_index("scale"), Some(3));
        assert_eq!(property_index("blur"), Some(13));
        assert_eq!(property_index("anchorY"), Some(15));
    }
}
