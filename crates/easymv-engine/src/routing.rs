//! Routing matrix: curves (§5.1), combine semantics (§5.2), compiled evaluator.

use crate::features::{pool_to_video, smooth};
use crate::project::*;
use std::collections::HashMap;

pub fn apply_curve(curve: Curve, x: f32, threshold: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    match curve {
        Curve::Linear => x,
        Curve::EaseIn => x * x,
        Curve::EaseOut => 1.0 - (1.0 - x) * (1.0 - x),
        Curve::Smoothstep => 3.0 * x * x - 2.0 * x * x * x,
        Curve::Threshold => {
            if x > threshold {
                1.0
            } else {
                0.0
            }
        }
    }
}

#[derive(Clone, Debug)]
struct CompiledConn {
    slot: usize, // element_idx * PROPERTY_COUNT + property_idx
    series: usize, // index into `pooled`
    curve: Curve,
    out_min: f32,
    out_max: f32,
    combine: Combine,
    threshold: f32,
}

#[derive(Clone, Debug)]
struct CompiledTrack {
    slot: usize,
    mode: TrackMode,
    mix: f32,
    hold_only: bool,
    keys: Vec<Key>,
}

impl CompiledTrack {
    fn value(&self, frame: usize) -> f32 {
        let f = frame as u32;
        let k = &self.keys;
        if f <= k[0].f {
            return k[0].v;
        }
        let last = k.len() - 1;
        if f >= k[last].f {
            return k[last].v;
        }
        // largest i with k[i].f <= f
        let i = k.partition_point(|x| x.f <= f) - 1;
        let (a, b) = (k[i], k[i + 1]);
        let interp = if self.hold_only { Interp::Hold } else { a.interp };
        match interp {
            Interp::Hold => a.v,
            Interp::Linear => {
                let t = (f - a.f) as f32 / (b.f - a.f) as f32;
                a.v + (b.v - a.v) * t
            }
            Interp::Smooth => {
                let t = (f - a.f) as f32 / (b.f - a.f) as f32;
                let t = t * t * (3.0 - 2.0 * t);
                a.v + (b.v - a.v) * t
            }
        }
    }
}

const VISIBLE: usize = 16;

/// Immutable, pure evaluator over cached video-rate series.
#[derive(Clone, Debug, Default)]
pub struct Router {
    pub element_count: usize,
    pub total_frames: usize,
    base: Vec<f32>, // element_count * PROPERTY_COUNT
    pooled: Vec<Vec<f32>>,
    replaces: Vec<CompiledConn>,
    others: Vec<CompiledConn>,
    /// One optional track per slot (element_count * PROPERTY_COUNT).
    tracks: Vec<Option<CompiledTrack>>,
}

/// Normalized feature series for one source, indexed by feature.
pub struct SourceSeries<'a> {
    pub id: &'a str,
    pub features: &'a [Vec<f32>],
}

impl Router {
    /// Compile connections. Smoothing is executed here exactly once per unique
    /// `(source, feature, attackMs, releaseMs)` tuple and max-pooled to video
    /// rate; identical tuples share one series (§3.5).
    pub fn compile(
        project: &Project,
        sources: &[SourceSeries],
        total_frames: usize,
    ) -> Result<Router, String> {
        let elem_idx: HashMap<&str, usize> =
            project.elements.iter().enumerate().map(|(i, e)| (e.id.as_str(), i)).collect();
        let src_idx: HashMap<&str, usize> =
            sources.iter().enumerate().map(|(i, s)| (s.id, i)).collect();

        let mut base = Vec::with_capacity(project.elements.len() * PROPERTY_COUNT);
        for e in &project.elements {
            base.extend_from_slice(&e.base_vector());
        }

        let mut cache: HashMap<(usize, usize, u32, u32), usize> = HashMap::new();
        let mut pooled: Vec<Vec<f32>> = Vec::new();
        let mut replaces = Vec::new();
        let mut others = Vec::new();

        for c in &project.connections {
            let ei = *elem_idx.get(c.element.as_str()).ok_or_else(|| format!("unknown element '{}'", c.element))?;
            let pi = property_index(&c.property).ok_or_else(|| format!("unknown property '{}'", c.property))?;
            let si = *src_idx.get(c.source.as_str()).ok_or_else(|| format!("unknown source '{}'", c.source))?;
            let fi = feature_index(&c.feature).ok_or_else(|| format!("unknown feature '{}'", c.feature))?;

            let key = (si, fi, c.attack_ms.to_bits(), c.release_ms.to_bits());
            let series = *cache.entry(key).or_insert_with(|| {
                let raw = &sources[si].features[fi];
                // `rate` is implied by series length / duration; supplied via project.
                let smoothed = smooth(raw, c.attack_ms, c.release_ms, project.analysis_rate);
                pooled.push(pool_to_video(&smoothed, project.analysis_rate, project.video_fps, total_frames));
                pooled.len() - 1
            });

            let cc = CompiledConn {
                slot: ei * PROPERTY_COUNT + pi,
                series,
                curve: c.curve,
                out_min: c.out_min,
                out_max: c.out_max,
                combine: c.combine,
                threshold: c.threshold.unwrap_or(0.5),
            };
            if c.combine == Combine::Replace {
                replaces.push(cc);
            } else {
                others.push(cc);
            }
        }

        let mut tracks: Vec<Option<CompiledTrack>> = vec![None; project.elements.len() * PROPERTY_COUNT];
        for t in &project.tracks {
            let ei = *elem_idx.get(t.element.as_str()).ok_or_else(|| format!("unknown element '{}'", t.element))?;
            let pi = property_index(&t.property).ok_or_else(|| format!("unknown property '{}'", t.property))?;
            if t.keys.is_empty() {
                return Err(format!("track {}.{} has no keys", t.element, t.property));
            }
            tracks[ei * PROPERTY_COUNT + pi] = Some(CompiledTrack {
                slot: ei * PROPERTY_COUNT + pi,
                mode: t.mode,
                mix: t.mix.clamp(0.0, 1.0),
                hold_only: pi == VISIBLE,
                keys: t.keys.clone(),
            });
        }

        Ok(Router { element_count: project.elements.len(), total_frames, base, pooled, replaces, others, tracks })
    }

    /// Replace base values without recompiling (used for live drag/scale edits).
    pub fn set_base(&mut self, project: &Project) -> Result<(), String> {
        if project.elements.len() != self.element_count {
            return Err("element count changed: recompile instead".into());
        }
        self.base.clear();
        for e in &project.elements {
            self.base.extend_from_slice(&e.base_vector());
        }
        Ok(())
    }

    pub fn unique_series(&self) -> usize {
        self.pooled.len()
    }

    #[inline]
    fn value(&self, c: &CompiledConn, frame: usize) -> f32 {
        let x = self.pooled[c.series][frame];
        let t = apply_curve(c.curve, x, c.threshold);
        c.out_min + (c.out_max - c.out_min) * t
    }

    /// Apply the audio pipeline for one slot starting from `start`.
    fn audio_slot(&self, slot: usize, start: f32, frame: usize) -> f32 {
        let mut a = start;
        for c in self.replaces.iter().filter(|c| c.slot == slot) {
            a = self.value(c, frame);
        }
        for c in self.others.iter().filter(|c| c.slot == slot) {
            let v = self.value(c, frame);
            match c.combine {
                Combine::Add => a += v,
                Combine::Multiply => a *= v,
                Combine::Max => a = a.max(v),
                Combine::Min => a = a.min(v),
                Combine::Replace => unreachable!(),
            }
        }
        a
    }

    /// Final (clamped) value of one slot.
    fn slot_value(&self, slot: usize, frame: usize) -> f32 {
        let base = self.base[slot];
        let v = match &self.tracks[slot] {
            None => self.audio_slot(slot, base, frame),
            Some(t) => {
                let tl = t.value(frame);
                match t.mode {
                    TrackMode::Override => tl,
                    TrackMode::Add => self.audio_slot(slot, tl, frame),
                    TrackMode::Multiply => tl * self.audio_slot(slot, 1.0, frame),
                    TrackMode::Mix => {
                        let a = self.audio_slot(slot, base, frame);
                        a + (tl - a) * t.mix
                    }
                }
            }
        };
        let pi = slot % PROPERTY_COUNT;
        let (lo, hi) = PROPERTY_CLAMPS[pi];
        if v.is_finite() { v.clamp(lo, hi) } else { PROPERTY_DEFAULTS[pi].clamp(lo, hi) }
    }

    /// Evaluate one frame into `out` (len == element_count * PROPERTY_COUNT).
    /// Pure: depends only on `frame` and the compiled state.
    /// Order per property: base -> timeline -> audio connections -> clamp.
    /// The `visible` slot is evaluated first; a hidden element skips all other work.
    pub fn evaluate_frame(&self, frame: usize, out: &mut [f32]) {
        debug_assert_eq!(out.len(), self.element_count * PROPERTY_COUNT);
        let frame = frame.min(self.total_frames.saturating_sub(1));
        for e in 0..self.element_count {
            let o = e * PROPERTY_COUNT;
            let vis = self.slot_value(o + VISIBLE, frame);
            if vis < 0.5 {
                for p in 0..PROPERTY_COUNT {
                    let (lo, hi) = PROPERTY_CLAMPS[p];
                    let b = self.base[o + p];
                    out[o + p] = if b.is_finite() { b.clamp(lo, hi) } else { PROPERTY_DEFAULTS[p].clamp(lo, hi) };
                }
                out[o + VISIBLE] = 0.0;
                continue;
            }
            for p in 0..PROPERTY_COUNT {
                out[o + p] = if p == VISIBLE { vis } else { self.slot_value(o + p, frame) };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(conns: Vec<Connection>) -> Project {
        let mut p: Project = serde_json::from_str(
            r#"{ "videoFps": 10, "analysisRate": 100, "masterMix": {"path":"m.wav"},
                 "elements": [ { "id":"e", "type":"static", "path":"a.png",
                                 "base": { "scaleX": 1.0, "opacity": 0.9 } } ] }"#,
        )
        .unwrap();
        p.connections = conns;
        p
    }

    fn conn(combine: Combine, out_min: f32, out_max: f32, prop: &str) -> Connection {
        Connection {
            source: "master".into(),
            feature: "rms".into(),
            element: "e".into(),
            property: prop.into(),
            curve: Curve::Linear,
            out_min,
            out_max,
            combine,
            attack_ms: 0.0,
            release_ms: 0.0,
            threshold: None,
            origin: Origin::User,
        }
    }

    // 100 analysis frames @100 Hz = 1 s; 10 video frames. rms ramps 0..1.
    fn ramp_features() -> Vec<Vec<f32>> {
        let mut f: Vec<Vec<f32>> = vec![vec![0.0; 100]; 6];
        f[0] = (0..100).map(|i| i as f32 / 99.0).collect();
        f
    }

    fn eval(p: &Project, frame: usize) -> Vec<f32> {
        let feats = ramp_features();
        let src = [SourceSeries { id: "master", features: &feats }];
        let r = Router::compile(p, &src, 10).unwrap();
        let mut out = vec![0.0; r.element_count * PROPERTY_COUNT];
        r.evaluate_frame(frame, &mut out);
        out
    }

    #[test]
    fn curves() {
        assert_eq!(apply_curve(Curve::Linear, 0.5, 0.0), 0.5);
        assert_eq!(apply_curve(Curve::EaseIn, 0.5, 0.0), 0.25);
        assert_eq!(apply_curve(Curve::EaseOut, 0.5, 0.0), 0.75);
        assert_eq!(apply_curve(Curve::Smoothstep, 0.5, 0.0), 0.5);
        assert_eq!(apply_curve(Curve::Threshold, 0.6, 0.5), 1.0);
        assert_eq!(apply_curve(Curve::Threshold, 0.4, 0.5), 0.0);
    }

    #[test]
    fn add_starts_from_base() {
        let p = project(vec![conn(Combine::Add, 0.0, 0.2, "scaleX")]);
        let last = eval(&p, 9);
        // base 1.0 + max-pooled ramp ~1.0 * 0.2
        assert!((last[4] - 1.2).abs() < 1e-3, "{}", last[4]);
        let first = eval(&p, 0);
        assert!(first[4] < 1.05);
    }

    #[test]
    fn replace_ignores_base() {
        let p = project(vec![conn(Combine::Replace, 0.8, 1.2, "opacity")]);
        let o = eval(&p, 0);
        assert!(o[8] >= 0.8 && o[8] < 0.85); // base 0.9 ignored, then clamped to [0,1]
        let o = eval(&p, 9);
        assert_eq!(o[8], 1.0); // 1.2 clamped to opacity max
    }

    #[test]
    fn multiply_max_min_apply_in_order() {
        let p = project(vec![
            conn(Combine::Replace, 2.0, 2.0, "scaleY"),
            conn(Combine::Multiply, 0.5, 0.5, "scaleY"),
            conn(Combine::Max, 1.5, 1.5, "scaleY"),
            conn(Combine::Min, 1.2, 1.2, "scaleY"),
        ]);
        // 2.0 * 0.5 = 1.0 -> max(1.0, 1.5) = 1.5 -> min(1.5, 1.2) = 1.2
        assert!((eval(&p, 3)[5] - 1.2).abs() < 1e-6);
    }

    #[test]
    fn clamps_to_property_range() {
        let p = project(vec![conn(Combine::Add, 0.0, 100.0, "scaleX")]);
        assert_eq!(eval(&p, 9)[4], 10.0);
        let p = project(vec![conn(Combine::Add, 0.0, -100.0, "scaleX")]);
        assert_eq!(eval(&p, 9)[4], 0.01);
    }

    #[test]
    fn identical_tuples_share_one_series() {
        let p = project(vec![
            conn(Combine::Add, 0.0, 0.1, "scaleX"),
            conn(Combine::Add, 0.0, 0.2, "scaleY"),
            Connection { attack_ms: 50.0, ..conn(Combine::Add, 0.0, 0.2, "rotation") },
        ]);
        let feats = ramp_features();
        let src = [SourceSeries { id: "master", features: &feats }];
        let r = Router::compile(&p, &src, 10).unwrap();
        assert_eq!(r.unique_series(), 2);
    }

    #[test]
    fn evaluation_is_pure_and_order_independent() {
        let p = project(vec![conn(Combine::Add, 0.0, 0.2, "scaleX")]);
        let feats = ramp_features();
        let src = [SourceSeries { id: "master", features: &feats }];
        let r = Router::compile(&p, &src, 10).unwrap();
        let mut fwd = Vec::new();
        for f in 0..10 {
            let mut o = vec![0.0; PROPERTY_COUNT];
            r.evaluate_frame(f, &mut o);
            fwd.push(o);
        }
        for f in (0..10).rev() {
            let mut o = vec![0.0; PROPERTY_COUNT];
            r.evaluate_frame(f, &mut o);
            assert_eq!(o, fwd[f]);
        }
    }

    #[test]
    fn out_of_range_frame_clamps() {
        let p = project(vec![conn(Combine::Add, 0.0, 0.2, "scaleX")]);
        assert_eq!(eval(&p, 9), eval(&p, 1000));
    }

    fn tproject(track_json: &str, conns: Vec<Connection>) -> Project {
        let mut p = project(conns);
        p.tracks = vec![serde_json::from_str(track_json).unwrap()];
        p
    }

    #[test]
    fn interpolation_hold_linear_smooth() {
        let keys = |i: &str| format!(
            r#"{{"element":"e","property":"positionX","keys":[{{"f":2,"v":0.2,"interp":"{i}"}},{{"f":6,"v":0.6}}]}}"#
        );
        let hold = tproject(&keys("hold"), vec![]);
        let lin = tproject(&keys("linear"), vec![]);
        let sm = tproject(&keys("smooth"), vec![]);
        assert!((eval(&hold, 0)[0] - 0.2).abs() < 1e-6); // before first key
        assert!((eval(&hold, 5)[0] - 0.2).abs() < 1e-6);
        assert!((eval(&hold, 6)[0] - 0.6).abs() < 1e-6);
        assert!((eval(&hold, 9)[0] - 0.6).abs() < 1e-6); // after last key
        assert!((eval(&lin, 4)[0] - 0.4).abs() < 1e-6);
        assert!((eval(&sm, 4)[0] - 0.4).abs() < 1e-6); // midpoint
        assert!((eval(&sm, 3)[0] - (0.2 + 0.4 * 0.15625)).abs() < 1e-6); // t=.25 -> 0.15625
    }

    #[test]
    fn track_modes_against_audio() {
        // rms ramp 0..1; connection adds 0..0.2 to scaleX. Track holds 3.0 (override etc.)
        let track = |m: &str| format!(
            r#"{{"element":"e","property":"scaleX","mode":"{m}","mix":0.25,"keys":[{{"f":0,"v":3.0}}]}}"#
        );
        let c = || vec![conn(Combine::Add, 0.0, 0.2, "scaleX")];
        let audio = eval(&project(c()), 9)[4]; // 1.0 + 0.2 = 1.2
        assert!((audio - 1.2).abs() < 1e-3);
        assert_eq!(eval(&tproject(&track("override"), c()), 9)[4], 3.0);
        assert!((eval(&tproject(&track("add"), c()), 9)[4] - 3.2).abs() < 1e-3);
        // multiply: factor = 1.0 + 0.2 = 1.2 -> 3.6
        assert!((eval(&tproject(&track("multiply"), c()), 9)[4] - 3.6).abs() < 1e-3);
        // mix 0.25: 1.2 + (3.0 - 1.2) * .25 = 1.65
        assert!((eval(&tproject(&track("mix"), c()), 9)[4] - 1.65).abs() < 1e-3);
        // no connections: just the timeline value
        assert_eq!(eval(&tproject(&track("add"), vec![]), 4)[4], 3.0);
    }

    #[test]
    fn visible_track_is_hold_only_and_short_circuits() {
        let tr = r#"{"element":"e","property":"visible","keys":[{"f":0,"v":1.0,"interp":"smooth"},{"f":5,"v":0.0},{"f":8,"v":1.0}]}"#;
        let p = tproject(tr, vec![conn(Combine::Add, 0.0, 0.2, "scaleX")]);
        for f in 0..5 {
            assert_eq!(eval(&p, f)[16], 1.0, "frame {f}");
        }
        let hidden = eval(&p, 6);
        assert_eq!(hidden[16], 0.0);
        // other props = clamped base: connection ignored (scaleX base 1.0), opacity base 0.9
        assert_eq!(hidden[4], 1.0);
        assert!((hidden[8] - 0.9).abs() < 1e-6);
        assert!(hidden.iter().all(|v| v.is_finite()));
        assert_eq!(eval(&p, 9)[16], 1.0);
        assert!(eval(&p, 9)[4] > 1.15);
    }

    #[test]
    fn evaluation_with_tracks_is_order_independent() {
        let tr = r#"{"element":"e","property":"rotation","mode":"add","keys":[{"f":1,"v":0.0},{"f":8,"v":2.0,"interp":"smooth"}]}"#;
        let p = tproject(tr, vec![conn(Combine::Add, 0.0, 0.3, "rotation")]);
        let fwd: Vec<_> = (0..10).map(|f| eval(&p, f)).collect();
        for f in (0..10).rev() {
            assert_eq!(eval(&p, f), fwd[f]);
        }
    }
}
