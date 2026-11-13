//! Engine core (no wasm-bindgen types): load audio, analyze, compile routing,
//! evaluate frames. `lib.rs` wraps this for JS.

use crate::audio::{self, Pcm};
use crate::features::{self, N_FEATURES};
use crate::project::*;
use crate::routing::{Router, SourceSeries};

struct Source {
    id: String,
    /// Normalized (P95) feature series on the analysis grid.
    features: Vec<Vec<f32>>,
    silent: [bool; N_FEATURES],
}

pub struct Core {
    sample_rate: u32,
    analysis_rate: u32,
    video_fps: f64,
    master: Option<Pcm>,
    queue: Vec<(String, Vec<f32>)>,
    sources: Vec<Source>,
    load_warnings: Vec<Issue>,
    router: Router,
    output: Vec<f32>,
}

impl Core {
    pub fn new(project: &Project) -> Result<Core, String> {
        let issues = validate(project);
        if let Some(e) = issues.iter().find(|i| i.severity == Severity::Error) {
            return Err(e.message.clone());
        }
        Ok(Core {
            sample_rate: project.sample_rate,
            analysis_rate: project.analysis_rate,
            video_fps: project.video_fps,
            master: None,
            queue: Vec::new(),
            sources: Vec::new(),
            load_warnings: Vec::new(),
            router: Router::default(),
            output: Vec::new(),
        })
    }

    fn load(&self, bytes: Vec<u8>, ext: Option<&str>) -> Result<Pcm, String> {
        let pcm = audio::decode(bytes, ext)?;
        audio::resample(&pcm, self.sample_rate)
    }

    /// Decode + resample the master. Keeps stereo for export; queues a mono
    /// downmix for analysis.
    pub fn load_master(&mut self, bytes: Vec<u8>, ext: Option<&str>) -> Result<(), String> {
        let pcm = self.load(bytes, ext)?;
        let mono = pcm.to_mono();
        self.queue.retain(|(id, _)| id != MASTER_ID);
        self.sources.retain(|s| s.id != MASTER_ID);
        self.queue.insert(0, (MASTER_ID.to_string(), mono));
        self.master = Some(pcm);
        Ok(())
    }

    /// Decode + resample a stem (mono), zero-pad / truncate to the master's length.
    pub fn load_stem(&mut self, id: &str, bytes: Vec<u8>, ext: Option<&str>) -> Result<(), String> {
        if id == MASTER_ID {
            return Err(format!("'{}' is reserved for the master mix", MASTER_ID));
        }
        let master = self.master.as_ref().ok_or("load the master mix before stems")?;
        let master_len = master.frames();
        let master_secs = master.duration_secs();
        let pcm = self.load(bytes, ext)?;
        if audio::mismatch_exceeds_frame(pcm.duration_secs(), master_secs, self.video_fps) {
            let kind = if pcm.duration_secs() < master_secs { "zero-padded" } else { "truncated" };
            self.load_warnings.push(Issue {
                severity: Severity::Warning,
                message: format!(
                    "stem '{}' is {:.2}s but the master is {:.2}s; it will be {} to match.",
                    id,
                    pcm.duration_secs(),
                    master_secs,
                    kind
                ),
            });
        }
        let mono = audio::fit_length(pcm.to_mono(), master_len);
        self.queue.retain(|(q, _)| q != id);
        self.sources.retain(|s| s.id != id);
        self.queue.push((id.to_string(), mono));
        Ok(())
    }

    pub fn analysis_pending(&self) -> usize {
        self.queue.len()
    }

    /// Analyze one queued source. Returns the id analyzed.
    pub fn analysis_step(&mut self) -> Result<Option<String>, String> {
        if self.queue.is_empty() {
            return Ok(None);
        }
        let (id, mono) = self.queue.remove(0);
        let table = features::extract(&mono, self.sample_rate, self.analysis_rate);
        let mut silent = [false; N_FEATURES];
        let mut feats = Vec::with_capacity(N_FEATURES);
        for (i, mut s) in table.series.into_iter().enumerate() {
            silent[i] = features::normalize_p95(&mut s, i == features::F_ONSET);
            feats.push(s);
        }
        self.sources.push(Source { id: id.clone(), features: feats, silent });
        Ok(Some(id))
    }

    pub fn total_frames(&self) -> usize {
        match &self.master {
            Some(m) => ((m.duration_secs() * self.video_fps) - 1e-6).ceil().max(0.0) as usize,
            None => 0,
        }
    }

    pub fn master(&self) -> Option<&Pcm> {
        self.master.as_ref()
    }

    pub fn source_ids(&self) -> Vec<String> {
        self.sources.iter().map(|s| s.id.clone()).collect()
    }

    /// (Re)compile routing for a new project state. Cheap: no re-analysis.
    /// Returns validation warnings (errors abort with `Err`).
    pub fn compile(&mut self, project: &Project) -> Result<Vec<Issue>, String> {
        if self.master.is_none() || !self.queue.is_empty() {
            return Err("audio is not fully analyzed yet".into());
        }
        if project.analysis_rate != self.analysis_rate || project.sample_rate != self.sample_rate {
            return Err("analysisRate / sampleRate changed: create a new engine and re-analyze".into());
        }
        let mut issues = validate(project);
        if let Some(e) = issues.iter().find(|i| i.severity == Severity::Error) {
            return Err(e.message.clone());
        }
        self.video_fps = project.video_fps;

        let total = self.total_frames();
        let series: Vec<SourceSeries> =
            self.sources.iter().map(|s| SourceSeries { id: &s.id, features: &s.features }).collect();
        for c in &project.connections {
            if !self.sources.iter().any(|s| s.id == c.source) {
                return Err(format!("source '{}' has no loaded audio", c.source));
            }
        }
        let router = Router::compile(project, &series, total)?;

        // Warn about connections reading a silent feature (§10.4).
        for c in &project.connections {
            let src = self.sources.iter().find(|s| s.id == c.source).unwrap();
            if let Some(fi) = feature_index(&c.feature) {
                if src.silent[fi] {
                    issues.push(Issue {
                        severity: Severity::Warning,
                        message: format!(
                            "source '{}' is silent for feature '{}'; its connection to {}.{} will have no effect.",
                            c.source, c.feature, c.element, c.property
                        ),
                    });
                }
            }
        }
        issues.extend(self.load_warnings.iter().cloned());

        self.output = vec![0.0; MAX_BATCH * router.element_count * PROPERTY_COUNT];
        self.router = router;
        Ok(issues)
    }

    /// Evaluate `count` frames from `start` into the output buffer. Returns the
    /// number of frames evaluated (clamped to the valid range and MAX_BATCH).
    pub fn evaluate_batch(&mut self, start: usize, count: usize) -> usize {
        let total = self.router.total_frames;
        if start >= total {
            return 0;
        }
        let n = count.min(MAX_BATCH).min(total - start);
        let stride = self.router.element_count * PROPERTY_COUNT;
        for i in 0..n {
            let (a, b) = (i * stride, (i + 1) * stride);
            self.router.evaluate_frame(start + i, &mut self.output[a..b]);
        }
        n
    }

    /// Normalized feature series (analysis grid) for a source.
    pub fn feature_series(&self, id: &str, feature: usize) -> Option<&[f32]> {
        self.sources.iter().find(|s| s.id == id).and_then(|s| s.features.get(feature)).map(|v| v.as_slice())
    }

    pub fn analysis_rate(&self) -> u32 {
        self.analysis_rate
    }

    /// Cheap path for base-value-only edits.
    pub fn update_base(&mut self, project: &Project) -> Result<(), String> {
        self.router.set_base(project)
    }

    pub fn output(&self) -> &[f32] {
        &self.output
    }

    pub fn element_count(&self) -> usize {
        self.router.element_count
    }

    pub fn video_fps(&self) -> f64 {
        self.video_fps
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::tests::make_wav;

    const SR: u32 = 22_050;

    fn click_track(secs: f32, period: f32) -> Vec<f32> {
        let n = (SR as f32 * secs) as usize;
        let mut x = vec![0.0f32; n];
        let mut t = period / 2.0;
        while t < secs - 0.05 {
            let at = (t * SR as f32) as usize;
            for k in 0..150 {
                x[at + k] = if k % 2 == 0 { 0.9 } else { -0.9 };
            }
            t += period;
        }
        x
    }

    fn project(json_extra: &str) -> Project {
        serde_json::from_str(&format!(
            r#"{{ "videoFps": 20, "analysisRate": 200, "sampleRate": {SR},
                 "masterMix": {{"path":"m.wav"}},
                 "stems": [{{"id":"drums","path":"d.wav"}}],
                 "elements": [{{"id":"hero","type":"static","path":"a.png","zIndex":1}}]
                 {json_extra} }}"#
        ))
        .unwrap()
    }

    fn build(p: &Project, master: &[f32], drums: &[f32]) -> Core {
        let mut c = Core::new(p).unwrap();
        c.load_master(make_wav(SR, 1, master), Some("wav")).unwrap();
        c.load_stem("drums", make_wav(SR, 1, drums), Some("wav")).unwrap();
        assert_eq!(c.analysis_pending(), 2);
        while c.analysis_step().unwrap().is_some() {}
        c
    }

    #[test]
    fn end_to_end_drums_drive_scale_while_master_does_not() {
        let secs = 4.0;
        let clicks = click_track(secs, 1.0);
        let silent = vec![0.0; clicks.len()];
        let mut p = project("");
        // master is silent; drums have clicks at 0.5 s, 1.5 s, ...
        p.connections.push(Connection {
            source: "drums".into(),
            feature: "onset".into(),
            element: "hero".into(),
            property: "scaleX".into(),
            curve: Curve::Linear,
            out_min: 0.0,
            out_max: 0.5,
            combine: Combine::Add,
            attack_ms: 0.0,
            release_ms: 50.0,
            threshold: None,
            origin: Origin::User,
        });
        let mut c = build(&p, &silent, &clicks);
        let issues = c.compile(&p).unwrap();
        // The silent master is not connected, so no silent warning, but fine.
        assert!(issues.iter().all(|i| !i.message.contains("silent")));

        assert_eq!(c.total_frames(), 80); // 4 s * 20 fps
        let n = c.evaluate_batch(0, 64);
        assert_eq!(n, 64);
        let n2 = c.evaluate_batch(64, 64);
        assert_eq!(n2, 16); // clamped to remaining

        // The output buffer is reused per batch: re-evaluate batch 0 before reading it.
        assert_eq!(c.evaluate_batch(0, 64), 64);
        let stride = c.element_count() * PROPERTY_COUNT;
        // Click at 0.5 s => video frame ~10. Scale peaks there; frame 5 (0.25 s) quiet.
        let scale_at = |c: &Core, f: usize| c.output()[(f % 64) * stride + 4];
        let peak = (8..13).map(|f| scale_at(&c, f)).fold(0.0f32, f32::max);
        assert!(peak > 1.2, "peak {peak}");
        assert!((scale_at(&c, 4) - 1.0).abs() < 0.01);
    }

    #[test]
    fn silent_source_is_flagged() {
        let clicks = click_track(2.0, 1.0);
        let silent = vec![0.0; clicks.len()];
        let mut p = project("");
        p.connections.push(Connection {
            source: "drums".into(),
            feature: "rms".into(),
            element: "hero".into(),
            property: "opacity".into(),
            curve: Curve::Linear,
            out_min: 0.0,
            out_max: 1.0,
            combine: Combine::Replace,
            attack_ms: 0.0,
            release_ms: 0.0,
            threshold: None,
            origin: Origin::User,
        });
        let mut c = build(&p, &clicks, &silent); // drums stem is silent
        let issues = c.compile(&p).unwrap();
        assert!(issues.iter().any(|i| i.message.contains("silent")));
    }

    #[test]
    fn stem_length_mismatch_warns_and_pads() {
        let master = click_track(2.0, 1.0);
        let short = click_track(1.0, 1.0);
        let p = project("");
        let mut c = Core::new(&p).unwrap();
        c.load_master(make_wav(SR, 1, &master), Some("wav")).unwrap();
        c.load_stem("drums", make_wav(SR, 1, &short), Some("wav")).unwrap();
        while c.analysis_step().unwrap().is_some() {}
        let issues = c.compile(&p).unwrap();
        assert!(issues.iter().any(|i| i.message.contains("zero-padded")));
        assert_eq!(c.total_frames(), 40);
    }

    #[test]
    fn same_inputs_same_outputs() {
        let clicks = click_track(3.0, 0.5);
        let mut p = project("");
        crate::automode::apply(&mut p);
        let mut a = build(&p, &clicks, &clicks);
        let mut b = build(&p, &clicks, &clicks);
        a.compile(&p).unwrap();
        b.compile(&p).unwrap();
        for start in [0usize, 20, 0] {
            a.evaluate_batch(start, 32);
            b.evaluate_batch(start, 32);
            assert_eq!(a.output(), b.output());
        }
    }

    #[test]
    fn recompile_after_routing_change_without_reanalysis() {
        let clicks = click_track(2.0, 1.0);
        let mut p = project("");
        let mut c = build(&p, &clicks, &clicks);
        c.compile(&p).unwrap();
        crate::automode::apply(&mut p);
        c.compile(&p).unwrap();
        assert!(c.evaluate_batch(0, 4) == 4);
        // Changing analysis rate requires a new engine.
        p.analysis_rate = 100;
        assert!(c.compile(&p).is_err());
    }

    #[test]
    fn update_base_changes_output_without_recompile() {
        let clicks = click_track(2.0, 1.0);
        let mut p = project("");
        let mut c = build(&p, &clicks, &clicks);
        c.compile(&p).unwrap();
        c.evaluate_batch(0, 1);
        assert_eq!(c.output()[0], 0.5); // positionX default
        p.elements[0].base.insert("positionX".into(), 0.8);
        c.update_base(&p).unwrap();
        c.evaluate_batch(0, 1);
        assert!((c.output()[0] - 0.8).abs() < 1e-6);
        p.elements.push(p.elements[0].clone());
        assert!(c.update_base(&p).is_err());
    }

    #[test]
    fn feature_series_exposed_and_normalized() {
        let clicks = click_track(2.0, 1.0);
        let p = project("");
        let c = build(&p, &clicks, &clicks);
        let s = c.feature_series("drums", 0).unwrap();
        assert_eq!(s.len(), 400);
        assert!(s.iter().all(|v| (0.0..=1.0).contains(v)));
        assert!(c.feature_series("nope", 0).is_none());
        assert_eq!(c.analysis_rate(), 200);
    }

    #[test]
    fn stem_before_master_is_an_error() {
        let p = project("");
        let mut c = Core::new(&p).unwrap();
        assert!(c.load_stem("drums", make_wav(SR, 1, &[0.0; 100]), Some("wav")).is_err());
    }

    #[test]
    fn invalid_project_rejected_at_new() {
        let mut p = project("");
        p.stems.push(StemDef { id: "master".into(), path: "x".into(), label: None });
        assert!(Core::new(&p).is_err());
    }
}
