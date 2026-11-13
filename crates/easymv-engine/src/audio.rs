//! Decode (symphonia), resample (rubato), downmix, and stem alignment (§3.2).

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use symphonia::core::audio::sample::Sample;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;

/// Interleaved f32 PCM.
#[derive(Clone, Debug)]
pub struct Pcm {
    pub sample_rate: u32,
    pub channels: usize,
    pub data: Vec<f32>,
}

impl Pcm {
    pub fn frames(&self) -> usize {
        if self.channels == 0 { 0 } else { self.data.len() / self.channels }
    }
    pub fn duration_secs(&self) -> f64 {
        self.frames() as f64 / self.sample_rate as f64
    }

    /// Average all channels to mono.
    pub fn to_mono(&self) -> Vec<f32> {
        if self.channels == 1 {
            return self.data.clone();
        }
        let inv = 1.0 / self.channels as f32;
        self.data.chunks_exact(self.channels).map(|f| f.iter().sum::<f32>() * inv).collect()
    }
}

/// Decode any supported container/codec to interleaved f32 PCM.
/// `ext_hint` is an optional file extension ("wav", "mp3", ...).
pub fn decode(bytes: Vec<u8>, ext_hint: Option<&str>) -> Result<Pcm, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mss = MediaSourceStream::new(Box::new(cursor), MediaSourceStreamOptions::default());

    let mut hint = Hint::new();
    if let Some(ext) = ext_hint {
        hint.with_extension(ext.trim_start_matches('.'));
    }

    let fmt_opts = FormatOptions::default();

    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, fmt_opts, MetadataOptions::default())
        .map_err(|e| format!("unrecognized audio format: {e}"))?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| "no audio track found".to_string())?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|c| c.audio())
        .ok_or_else(|| "audio track has no codec parameters".to_string())?;

    let mut decoder = symphonia::default::get_codecs()
        // Gapless: strip encoder delay/padding where the container reports it.
        .make_audio_decoder(params, &AudioDecoderOptions::default().gapless(true))
        .map_err(|e| format!("unsupported audio codec: {e}"))?;

    let mut data: Vec<f32> = Vec::new();
    let mut scratch: Vec<f32> = Vec::new();
    let mut rate = 0u32;
    let mut channels = 0usize;

    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(SymError::IoError(_)) => break,
            Err(e) => return Err(format!("audio read error: {e}")),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                let spec = buf.spec();
                if rate == 0 {
                    rate = spec.rate();
                    channels = spec.channels().count();
                }
                scratch.resize(buf.samples_interleaved(), f32::MID);
                buf.copy_to_slice_interleaved(&mut scratch);
                data.extend_from_slice(&scratch);
            }
            Err(SymError::DecodeError(_)) => continue, // skip corrupt packet
            Err(SymError::IoError(_)) => break,
            Err(e) => return Err(format!("audio decode error: {e}")),
        }
    }

    if rate == 0 || channels == 0 || data.is_empty() {
        return Err("decoded no audio samples".into());
    }
    Ok(Pcm { sample_rate: rate, channels, data })
}

/// Resample to `target_rate` with the FFT resampler (fixed ratio, offline).
pub fn resample(pcm: &Pcm, target_rate: u32) -> Result<Pcm, String> {
    if pcm.sample_rate == target_rate {
        return Ok(pcm.clone());
    }
    let frames = pcm.frames();
    let mut rs = Fft::<f32>::new(
        pcm.sample_rate as usize,
        target_rate as usize,
        1024,
        pcm.channels,
        FixedSync::Both,
    )
    .map_err(|e| format!("resampler init failed: {e}"))?;

    let input = InterleavedSlice::new(&pcm.data, pcm.channels, frames)
        .map_err(|e| format!("resampler input error: {e}"))?;
    let out = rs
        .process_all(&input, frames, None)
        .map_err(|e| format!("resampling failed: {e}"))?;
    let data = out.take_data();
    Ok(Pcm { sample_rate: target_rate, channels: pcm.channels, data })
}

/// Zero-pad or truncate to exactly `len` samples (§3.2 stem validation).
pub fn fit_length(mut mono: Vec<f32>, len: usize) -> Vec<f32> {
    mono.resize(len, 0.0);
    mono
}

/// Duration mismatch beyond one video frame (seconds) worth warning about.
pub fn mismatch_exceeds_frame(a_secs: f64, b_secs: f64, video_fps: f64) -> bool {
    (a_secs - b_secs).abs() > 1.0 / video_fps
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Build a minimal 16-bit PCM WAV file in memory.
    pub fn make_wav(sample_rate: u32, channels: u16, samples: &[f32]) -> Vec<u8> {
        let mut pcm: Vec<u8> = Vec::with_capacity(samples.len() * 2);
        for s in samples {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            pcm.extend_from_slice(&v.to_le_bytes());
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&(sample_rate * channels as u32 * 2).to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        out.extend_from_slice(&pcm);
        out
    }

    #[test]
    fn decodes_wav_roundtrip() {
        let sr = 22_050u32;
        let samples: Vec<f32> =
            (0..sr as usize).map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / sr as f32).sin() * 0.5).collect();
        let wav = make_wav(sr, 1, &samples);
        let pcm = decode(wav, Some("wav")).unwrap();
        assert_eq!(pcm.sample_rate, sr);
        assert_eq!(pcm.channels, 1);
        assert_eq!(pcm.frames(), samples.len());
        assert!((pcm.data[100] - samples[100]).abs() < 1e-3);
    }

    #[test]
    fn stereo_downmix() {
        let wav = make_wav(8000, 2, &[0.5, -0.5, 0.25, 0.25]);
        let pcm = decode(wav, Some("wav")).unwrap();
        let mono = pcm.to_mono();
        assert_eq!(mono.len(), 2);
        assert!(mono[0].abs() < 1e-3);
        assert!((mono[1] - 0.25).abs() < 1e-3);
    }

    #[test]
    fn resample_changes_length_proportionally() {
        let sr = 22_050u32;
        let samples: Vec<f32> =
            (0..sr as usize).map(|i| (i as f32 * 1000.0 * std::f32::consts::TAU / sr as f32).sin() * 0.5).collect();
        let pcm = Pcm { sample_rate: sr, channels: 1, data: samples };
        let out = resample(&pcm, 44_100).unwrap();
        let expected = 44_100usize;
        assert!((out.frames() as i64 - expected as i64).abs() < 64, "got {}", out.frames());
    }

    #[test]
    fn fit_length_pads_and_truncates() {
        assert_eq!(fit_length(vec![1.0, 2.0], 4), vec![1.0, 2.0, 0.0, 0.0]);
        assert_eq!(fit_length(vec![1.0, 2.0, 3.0], 2), vec![1.0, 2.0]);
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(decode(vec![1, 2, 3, 4, 5, 6, 7, 8], None).is_err());
    }
}
