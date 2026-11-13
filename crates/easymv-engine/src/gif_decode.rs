//! GIF decoding with disposal-method compositing (§4.5, §10.5).

use gif::{ColorOutput, DecodeOptions, DisposalMethod, MemoryLimit};

/// GIF frames at or under 1 cs are treated as 10 cs (100 ms), matching browsers.
pub fn normalize_delay_cs(cs: u16) -> u32 {
    if cs <= 1 { 10 } else { cs as u32 }
}

pub struct DecodedGif {
    pub width: u32,
    pub height: u32,
    /// Fully composited RGBA8 frames (straight alpha), `width*height*4` each.
    pub frames: Vec<Vec<u8>>,
    /// Per-frame delay in milliseconds (after browser normalization).
    pub delays_ms: Vec<u32>,
}

impl DecodedGif {
    /// Prefix sums of delays: `timeline[i]` = start time (ms) of frame `i`;
    /// last element is the total duration. Length = frames + 1.
    pub fn timeline_ms(&self) -> Vec<u32> {
        let mut t = Vec::with_capacity(self.delays_ms.len() + 1);
        let mut acc = 0u32;
        t.push(0);
        for d in &self.delays_ms {
            acc += d;
            t.push(acc);
        }
        t
    }
}

/// Decode to composited RGBA frames. `max_bytes` caps total decoded size.
pub fn decode_gif(bytes: &[u8], max_bytes: usize) -> Result<DecodedGif, String> {
    let mut opts = DecodeOptions::new();
    opts.set_color_output(ColorOutput::RGBA);
    opts.set_memory_limit(MemoryLimit::Bytes(
        std::num::NonZeroU64::new(256 * 1024 * 1024).unwrap(),
    ));
    let mut dec = opts.read_info(bytes).map_err(|e| format!("invalid GIF: {e}"))?;
    let (w, h) = (dec.width() as usize, dec.height() as usize);
    if w == 0 || h == 0 {
        return Err("GIF has zero size".into());
    }
    let frame_bytes = w * h * 4;

    let mut canvas = vec![0u8; frame_bytes]; // transparent black
    let mut frames: Vec<Vec<u8>> = Vec::new();
    let mut delays = Vec::new();
    let mut total = 0usize;

    while let Some(frame) = dec.read_next_frame().map_err(|e| format!("GIF decode error: {e}"))? {
        total += frame_bytes;
        if total > max_bytes {
            return Err(format!(
                "GIF too large: decoded frames exceed {} MB",
                max_bytes / (1024 * 1024)
            ));
        }
        let (fl, ft, fw, fh) = (frame.left as usize, frame.top as usize, frame.width as usize, frame.height as usize);
        let dispose = frame.dispose;
        let before = if dispose == DisposalMethod::Previous { Some(canvas.clone()) } else { None };

        // Blit: opaque source pixels overwrite; fully transparent leave canvas.
        for y in 0..fh {
            let cy = ft + y;
            if cy >= h {
                break;
            }
            for x in 0..fw {
                let cx = fl + x;
                if cx >= w {
                    break;
                }
                let s = (y * fw + x) * 4;
                if frame.buffer[s + 3] != 0 {
                    let d = (cy * w + cx) * 4;
                    canvas[d..d + 4].copy_from_slice(&frame.buffer[s..s + 4]);
                }
            }
        }

        frames.push(canvas.clone());
        delays.push(normalize_delay_cs(frame.delay) * 10);

        // Apply disposal for the NEXT frame.
        match dispose {
            DisposalMethod::Background => {
                for y in 0..fh {
                    let cy = ft + y;
                    if cy >= h {
                        break;
                    }
                    for x in 0..fw {
                        let cx = fl + x;
                        if cx >= w {
                            break;
                        }
                        let d = (cy * w + cx) * 4;
                        canvas[d..d + 4].copy_from_slice(&[0, 0, 0, 0]);
                    }
                }
            }
            DisposalMethod::Previous => {
                if let Some(b) = before {
                    canvas = b;
                }
            }
            DisposalMethod::Any | DisposalMethod::Keep => {}
        }
    }

    if frames.is_empty() {
        return Err("GIF contains no frames".into());
    }
    Ok(DecodedGif { width: w as u32, height: h as u32, frames, delays_ms: delays })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gif::{Encoder, Frame, Repeat};

    fn make_gif(delays_cs: &[u16]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut enc = Encoder::new(&mut buf, 4, 4, &[]).unwrap();
            enc.set_repeat(Repeat::Infinite).unwrap();
            for (i, d) in delays_cs.iter().enumerate() {
                let px: Vec<u8> = (0..16).flat_map(|_| [(i * 60) as u8, 0, 0, 255]).collect();
                let mut f = Frame::from_rgba(4, 4, &mut px.clone());
                f.delay = *d;
                enc.write_frame(&f).unwrap();
            }
        }
        buf
    }

    #[test]
    fn zero_and_one_cs_become_100ms() {
        assert_eq!(normalize_delay_cs(0), 10);
        assert_eq!(normalize_delay_cs(1), 10);
        assert_eq!(normalize_delay_cs(2), 2);
        assert_eq!(normalize_delay_cs(7), 7);
    }

    #[test]
    fn decodes_frames_delays_and_timeline() {
        let g = decode_gif(&make_gif(&[0, 5, 20]), 64 << 20).unwrap();
        assert_eq!((g.width, g.height, g.frames.len()), (4, 4, 3));
        assert_eq!(g.delays_ms, vec![100, 50, 200]);
        assert_eq!(g.timeline_ms(), vec![0, 100, 150, 350]);
        assert_eq!(g.frames[0].len(), 64);
    }

    #[test]
    fn size_cap_enforced() {
        assert!(decode_gif(&make_gif(&[5, 5, 5]), 100).is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode_gif(&[0, 1, 2, 3], 1 << 20).is_err());
    }
}
