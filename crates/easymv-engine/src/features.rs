//! Feature extraction (§3.4), smoothing (§3.5), normalization (§3.6) and
//! max-pooling to video rate (§3.7).

use realfft::RealFftPlanner;

pub const N_FEATURES: usize = 6;
pub const FFT_SIZE: usize = 2048;

// Feature indices — must match project::FEATURE_NAMES.
pub const F_RMS: usize = 0;
pub const F_LOW: usize = 1;
pub const F_MID: usize = 2;
pub const F_HIGH: usize = 3;
pub const F_ONSET: usize = 4;
pub const F_CENTROID: usize = 5;

/// Per-source feature series on the analysis grid.
#[derive(Clone, Debug, Default)]
pub struct FeatureTable {
    pub rate: u32,
    pub frames: usize,
    pub series: [Vec<f32>; N_FEATURES],
}

/// Number of analysis frames covering `samples` at `sr` for analysis `rate`.
pub fn analysis_frame_count(samples: usize, sr: u32, rate: u32) -> usize {
    ((samples as f64 / sr as f64) * rate as f64).ceil() as usize
}

/// Extract all raw features from a mono signal.
///
/// Frame `i` is centered at sample `round(i * sr / rate)`. The hop is
/// fractional on purpose: 44100/200 = 220.5, and truncating it would drift the
/// analysis grid by ~0.2% (0.7 s over five minutes) relative to video time.
pub fn extract(mono: &[f32], sr: u32, rate: u32) -> FeatureTable {
    let n_frames = analysis_frame_count(mono.len(), sr, rate);
    let mut table = FeatureTable {
        rate,
        frames: n_frames,
        series: std::array::from_fn(|_| vec![0.0; n_frames]),
    };
    if n_frames == 0 {
        return table;
    }

    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut input = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let mut scratch = fft.make_scratch_vec();

    let hann: Vec<f32> = (0..FFT_SIZE)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / FFT_SIZE as f32).cos())
        .collect();

    let bins = FFT_SIZE / 2 + 1;
    let bin_hz = sr as f32 / FFT_SIZE as f32;
    let nyq = sr as f32 / 2.0;
    let band = |lo: f32, hi: f32| -> (usize, usize) {
        let hi = hi.min(nyq);
        let a = (lo / bin_hz).ceil() as usize;
        let b = ((hi / bin_hz).floor() as usize + 1).min(bins);
        (a.min(b), b)
    };
    let (low_a, low_b) = band(20.0, 250.0);
    let (mid_a, mid_b) = band(250.0, 4000.0);
    let (high_a, high_b) = band(4000.0, 16000.0);

    let mut prev_mag = vec![0.0f32; bins];
    let mut mag = vec![0.0f32; bins];
    let mut flux = vec![0.0f32; n_frames];
    let half = (FFT_SIZE / 2) as i64;
    let len = mono.len() as i64;

    for i in 0..n_frames {
        let center = (i as f64 * sr as f64 / rate as f64).round() as i64;
        let start = center - half;

        // Fill windowed input (zero outside the signal); rms over raw samples.
        let mut sum_sq = 0.0f32;
        for k in 0..FFT_SIZE {
            let idx = start + k as i64;
            let s = if idx >= 0 && idx < len { mono[idx as usize] } else { 0.0 };
            sum_sq += s * s;
            input[k] = s * hann[k];
        }
        table.series[F_RMS][i] = (sum_sq / FFT_SIZE as f32).sqrt();

        fft.process_with_scratch(&mut input, &mut spectrum, &mut scratch)
            .expect("fft size mismatch");

        let mut low = 0.0f32;
        let mut mid = 0.0f32;
        let mut high = 0.0f32;
        let mut mag_sum = 0.0f32;
        let mut weighted = 0.0f32;
        let mut f = 0.0f32;
        for (k, c) in spectrum.iter().enumerate() {
            let p = c.re * c.re + c.im * c.im;
            let m = p.sqrt();
            mag[k] = m;
            if k >= low_a && k < low_b {
                low += p;
            }
            if k >= mid_a && k < mid_b {
                mid += p;
            }
            if k >= high_a && k < high_b {
                high += p;
            }
            mag_sum += m;
            weighted += m * k as f32 * bin_hz;
            if i > 0 {
                let d = m - prev_mag[k];
                if d > 0.0 {
                    f += d;
                }
            }
        }
        table.series[F_LOW][i] = low;
        table.series[F_MID][i] = mid;
        table.series[F_HIGH][i] = high;
        table.series[F_CENTROID][i] = if mag_sum > 1e-9 { weighted / mag_sum } else { 0.0 };
        flux[i] = f;
        std::mem::swap(&mut prev_mag, &mut mag);
    }

    table.series[F_ONSET] = adaptive_threshold(&flux, rate);
    table
}

/// Positive spectral flux with an adaptive threshold: subtract a centered
/// moving mean (±0.1 s) scaled by 1.5, floor at zero. Offline, so non-causal.
fn adaptive_threshold(flux: &[f32], rate: u32) -> Vec<f32> {
    let n = flux.len();
    let w = ((rate as f32 * 0.1).round() as usize).max(1);
    let mut prefix = vec![0.0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + flux[i] as f64;
    }
    (0..n)
        .map(|i| {
            let a = i.saturating_sub(w);
            let b = (i + w + 1).min(n);
            let mean = ((prefix[b] - prefix[a]) / (b - a) as f64) as f32;
            (flux[i] - 1.5 * mean).max(0.0)
        })
        .collect()
}

/// 95th-percentile normalization in place. Returns `true` if the series is
/// silent (P95 == 0), in which case every value is set to 0.
///
/// `positive_only`: take the percentile over strictly positive samples only.
/// Used for `onset`: the adaptive threshold zeroes most frames, so when hits
/// occupy under 5% of the grid the whole-series P95 is 0 and the feature would
/// be wrongly declared silent. (Deviation from the literal §3.6 formula.)
pub fn normalize_p95(series: &mut [f32], positive_only: bool) -> bool {
    if series.is_empty() {
        return true;
    }
    let mut sorted: Vec<f32> = series
        .iter()
        .copied()
        .filter(|v| v.is_finite() && (!positive_only || *v > 0.0))
        .collect();
    if sorted.is_empty() {
        series.iter_mut().for_each(|v| *v = 0.0);
        return true;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let idx = ((sorted.len() - 1) as f64 * 0.95).round() as usize;
    let p95 = sorted[idx];
    if p95 <= 0.0 {
        series.iter_mut().for_each(|v| *v = 0.0);
        return true;
    }
    for v in series.iter_mut() {
        *v = if v.is_finite() { (*v / p95).clamp(0.0, 1.0) } else { 0.0 };
    }
    false
}

/// One-pole attack/release envelope follower (§3.5).
pub fn smooth(series: &[f32], attack_ms: f32, release_ms: f32, rate: u32) -> Vec<f32> {
    let alpha = |ms: f32| -> f32 {
        if ms <= 0.0 {
            1.0
        } else {
            1.0 - (-1.0 / (ms * rate as f32 / 1000.0)).exp()
        }
    };
    let a_att = alpha(attack_ms);
    let a_rel = alpha(release_ms);
    let mut out = Vec::with_capacity(series.len());
    let mut env = series.first().copied().unwrap_or(0.0);
    for (i, &v) in series.iter().enumerate() {
        if i == 0 {
            env = v;
        } else if v > env {
            env += (v - env) * a_att;
        } else {
            env += (v - env) * a_rel;
        }
        out.push(env);
    }
    out
}

/// Max-pool an analysis-rate series to video rate (§3.7).
/// `a_start = floor(f*rate/fps)`, `a_end = floor((f+1)*rate/fps)` (exclusive).
/// If the window is empty (video fps > analysis rate) the sample at `a_start`
/// is used so every frame still has a value.
pub fn pool_to_video(series: &[f32], rate: u32, video_fps: f64, total_frames: usize) -> Vec<f32> {
    let n = series.len();
    (0..total_frames)
        .map(|f| {
            if n == 0 {
                return 0.0;
            }
            let a = ((f as f64 * rate as f64) / video_fps).floor() as usize;
            let b = (((f + 1) as f64 * rate as f64) / video_fps).floor() as usize;
            let a = a.min(n - 1);
            let b = b.min(n).max(a + 1);
            series[a..b].iter().copied().fold(0.0f32, f32::max)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;

    fn sine(freq: f32, secs: f32, amp: f32) -> Vec<f32> {
        (0..(SR as f32 * secs) as usize)
            .map(|i| (i as f32 * freq * std::f32::consts::TAU / SR as f32).sin() * amp)
            .collect()
    }

    #[test]
    fn frame_count_matches_duration() {
        assert_eq!(analysis_frame_count(SR as usize, SR, 200), 200);
        assert_eq!(analysis_frame_count(SR as usize * 3, SR, 100), 300);
    }

    #[test]
    fn low_sine_lands_in_low_band() {
        let t = extract(&sine(100.0, 1.0, 0.5), SR, 200);
        let mid = 100;
        assert!(t.series[F_LOW][mid] > 100.0 * t.series[F_MID][mid]);
        assert!(t.series[F_LOW][mid] > 100.0 * t.series[F_HIGH][mid]);
        assert!(t.series[F_RMS][mid] > 0.3 && t.series[F_RMS][mid] < 0.4);
    }

    #[test]
    fn high_sine_lands_in_high_band_with_high_centroid() {
        let t = extract(&sine(8000.0, 1.0, 0.5), SR, 200);
        let mid = 100;
        assert!(t.series[F_HIGH][mid] > 100.0 * t.series[F_LOW][mid]);
        let c = t.series[F_CENTROID][mid];
        assert!((c - 8000.0).abs() < 200.0, "centroid {c}");
    }

    #[test]
    fn click_track_produces_onsets_near_clicks() {
        // 1 click per second, 3 seconds. Click at sample 0.5s, 1.5s, 2.5s.
        let mut x = vec![0.0f32; SR as usize * 3];
        for s in [0.5f32, 1.5, 2.5] {
            let at = (s * SR as f32) as usize;
            for k in 0..200 {
                x[at + k] = if k % 2 == 0 { 0.9 } else { -0.9 };
            }
        }
        let t = extract(&x, SR, 200);
        let onset = &t.series[F_ONSET];
        for s in [0.5f32, 1.5, 2.5] {
            let c = (s * 200.0) as usize;
            let peak = onset[c.saturating_sub(10)..c + 10].iter().cloned().fold(0.0, f32::max);
            assert!(peak > 0.0, "no onset near {s}s");
        }
        // Far from clicks: quiet.
        assert!(onset[50] < 1e-3 && onset[250] < 1e-3);
    }

    #[test]
    fn silent_source_normalizes_to_zero() {
        let t = extract(&vec![0.0; SR as usize], SR, 200);
        let mut s = t.series[F_RMS].clone();
        assert!(normalize_p95(&mut s, false));
        assert!(s.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn p95_normalization_is_robust_to_outlier() {
        let mut s: Vec<f32> = vec![1.0; 99];
        s.push(1000.0); // single outlier transient
        normalize_p95(&mut s, false);
        assert!((s[0] - 1.0).abs() < 1e-6);
        assert_eq!(s[99], 1.0); // clamped
    }

    #[test]
    fn sparse_onsets_survive_normalization() {
        // 3 hits in 800 frames: whole-series P95 is 0, positive-only P95 is not.
        let mut s = vec![0.0f32; 800];
        s[100] = 0.2;
        s[400] = 0.4;
        s[700] = 0.3;
        let mut literal = s.clone();
        assert!(normalize_p95(&mut literal, false)); // literal spec: "silent"
        assert!(!normalize_p95(&mut s, true));
        assert!(s[400] > 0.9 && s[100] > 0.3);
    }

    #[test]
    fn smoothing_attack_and_release() {
        let mut x = vec![0.0f32; 400];
        for v in &mut x[100..200] {
            *v = 1.0;
        }
        let y = smooth(&x, 10.0, 100.0, 200);
        // 10 ms attack = 2 frames at 200 Hz: close to 1 within a few frames.
        assert!(y[105] > 0.9);
        // Release is slow: still well above 0 shortly after the drop.
        assert!(y[205] > 0.5);
        assert!(y[399] < 0.05);
        // Zero ms = passthrough.
        let z = smooth(&x, 0.0, 0.0, 200);
        assert_eq!(z, x);
    }

    #[test]
    fn max_pool_preserves_transients() {
        let mut s = vec![0.0f32; 200];
        s[3] = 1.0; // single-sample transient in analysis grid
        let v = pool_to_video(&s, 200, 30.0, 30);
        // Frame 0 covers analysis [0,6): must contain the transient.
        assert_eq!(v[0], 1.0);
        assert_eq!(v[1], 0.0);
        // Pooling is a pure function of frame index.
        assert_eq!(v, pool_to_video(&s, 200, 30.0, 30));
    }

    #[test]
    fn pool_handles_video_rate_above_analysis_rate() {
        let s = vec![0.5f32; 100];
        let v = pool_to_video(&s, 100, 240.0, 240);
        assert!(v.iter().all(|x| (*x - 0.5).abs() < 1e-6));
    }
}
