# EasyMV

Browser-based automatic music-video generator. Implements design doc v0.5 (v0.4 engine plus the redesigned editor): Rust/WASM audio engine
(`crates/easymv-engine`), JS/WebGL2 renderer, WebCodecs export. Static site, no backend.

## Run

    npm run build:wasm     # needs rust + wasm32-unknown-unknown + wasm-pack
    npm run serve          # http://localhost:8080
    npm run test:rust | test:js | test:render | test:app   (render/app tests need playwright)

`npm run build` assembles `dist/`; `.github/workflows/deploy.yml` builds and deploys to GitHub Pages.

## Layout

| Path | What |
| :-- | :-- |
| `crates/easymv-engine/src/audio.rs` | symphonia decode (gapless), rubato resample, mono downmix, stem fit |
| `.../features.rs` | rms/low/mid/high/onset/centroid, smoothing, P95 norm, max-pool to video rate |
| `.../routing.rs` | curves, combine semantics, compiled pure evaluator (shared smoothed series) |
| `.../automode.rs` | §7 rules; never targets timing (not in the property registry) |
| `.../project.rs` | project model, property registry/clamps, validation, judder hints |
| `.../gif_decode.rs` | `gif` crate, disposal compositing, 0/1 cs → 100 ms |
| `.../lib.rs` | wasm-bindgen surface (`Engine`, `evaluate_batch`, `GifDecoder`, `auto_mode`) |
| `web/js/animation.js` | internal animation clocks, atlas UVs, zip planning, draw plan (pure, unit-tested) |
| `web/js/kinetic.js`, `script.js` | kinetic text engine: outline script → roles, auto layout, springs, transitions (pure, deterministic, no AI); `script` layer + Script panel + Present mode |
| `web/js/fonts.js`, `web/fonts/` | bundled open fonts, optional local-font scan, generic-family migration |
| `web/js/renderer.js` | WebGL2: transform, colour, Kawase blur, blend, LRU texture budget |
| `web/js/exporter.js` | codec probing, deterministic export loop, backpressure, cancel, muxing |
| `web/js/history.js` | undo/redo (snapshots, drag coalescing, labels) |
| `web/js/meters.js`, `interact.js`, `presets.js`, `bundle.js` | signal meters, preview hit-testing/drag maths, routing presets + demo art, `.zip` project bundles |
| `web/js/assets.js`, `engine.js`, `app.js` | loaders, WASM bridge/`FrameView`, UI |

## Using it

- **Quick start** (⚡): pick a song, press the button. It adds generated demo visuals if you have none, analyzes,
  applies Automatic mode and plays. Everything after that is editable.
- **Playback/scrubbing:** play/pause, scrub bar, space bar, and click any **Signals** wave to jump there.
- **Signals:** per-source waveform of any feature (rms/low/mid/high/onset/centroid) with a live value at the
  playhead, so you can see what a connection will react to. Silent sources are flagged.
- **Direct manipulation:** click an element in the preview to select it, drag to move, mouse-wheel / pinch to resize.
  This edits the element's *base* values (routing still adds on top).
- **Presets:** Punchy, Bouncy, Dreamy, Colorful — appended as normal editable connections.
- **Undo/redo** (Ctrl/Cmd+Z, Ctrl+Shift+Z / Ctrl+Y, header buttons): covers every element/routing/frame-rate/resolution
  edit, drag/resize (one step per gesture), presets, automatic mode, and frame reordering. Changing stems
  (add/rename/remove) clears history because connections refer to them. Removed elements stay cached so undo is instant.
- **Bundles:** "Save bundle (.zip)" packs the project and all media; "Open…" restores it and re-analyzes with no
  re-selecting. "Project JSON" saves only the settings.
- **Frame sequences:** thumbnail strip + reorder dialog (drag or arrows); stored as `frameOrder`.
- **Mobile:** resolution presets (incl. vertical), touch-sized controls, wake lock during export, warnings when the
  browser must buffer a large file in memory.

## Resolved open questions (§13)

1. **Batch size:** 32 frames per `evaluate_batch` in export (constant `EXPORT_BATCH`); the engine buffer is
   allocated for 64 (`MAX_BATCH`), and calls are clamped to it. Not benchmarked yet — tune after profiling 1080p60.
2. **Blur framebuffers:** instead of two FBOs per blurred element, the renderer keeps **one ping-pong pair per
   resolution tier** (full for ≤8 px, half for ≤64 px, quarter above), shared by all elements because blurred
   elements are drawn sequentially. GPU cost is fixed (≤ 6 targets) regardless of element count. The quarter tier
   from the doc's fallback is on by default.
3. **Directory upload (`webkitdirectory`):** decided *yes*, via the same extraction path as zips. **Not implemented
   yet** (zip upload plus the reorder dialog covers the use case for now).
4. **Sample rate:** default 44,100 Hz; 48,000 Hz is listed as "(video)" in the selector.

## Deliberate deviations from the document (please review)

- **Onset normalization** uses the 95th percentile of *non-zero* onset values. The thresholded onset series is
  zero on most frames, so the literal whole-series P95 is 0 for sparse hits and would mark a drum stem "silent".
  Other features use the literal formula.
- **Auto-mode blur range** is 0–24 px, not 0–0.5 (blur is in pixels; 0.5 px is invisible). One constant:
  `AUTO_BLUR_MAX_PX`.
- **Analysis hop** is fractional (frame *i* centred at `round(i·sr/rate)`): 44100/200 = 220.5, and truncating to 220
  would drift ~0.7 s over five minutes.
- **Opus is always encoded at 48 kHz** (browser encoders reject other rates); the master is resampled with
  `OfflineAudioContext` for that path. AAC uses the project rate.
- **H.264 level** is picked from resolution × fps (4.1 minimum) so 1080p60 and above still probe correctly.
- **Elements have a `fit` mode** (`cover` for images, `natural` for sprites/GIFs/sequences) so that `scale = 1`
  means something sensible; the document left base size undefined. Elements default to `positionX/Y = 0.5`.
- **Sprite `padding`** means gutter pixels between cells (none on the outer edge); `0` for tightly packed sheets.

## Status — what is and isn't verified

Verified here: 50 Rust tests (decode, resample, features, routing, auto mode, validation, GIF, determinism, feature
export, live base updates); 31 JS tests (animation clocks, atlas math, zip planning, history, meters, hit-testing,
presets, bundles, export helpers); a headless-Chromium **renderer** test (`test:render`); and a headless-Chromium
**whole-UI** test (`test:app`) that drives quick start, undo/redo, drag, presets, reorder, bundle round-trip and
delete — against a *mock* of the WASM module (`web/test/mock-pkg`), so it checks UI wiring, not audio DSP.

**Not verified:** the real `wasm32` build (the authoring sandbox could not download the target — CI builds it),
the app on real audio in a real browser, WebCodecs export, and phones. The **A/V sync test** (§8.3) must be run in a
browser: open `sync-test.html`, download the kit, export, and measure; a measured offset can be applied with
`localStorage['easymv.audioOffsetMs']`.

Not implemented: directory upload; a UI for the A/V offset; undo of audio settings (sample/analysis rate).
Deferred per the design doc: BPM/beat tracking, threading, lyrics, `wgpu`, audio passthrough.


## What is new in v0.5

- **Editor:** Material 3 look, menu bar (File, Edit, View, Layer, Timeline, Audio, Window, Settings, Help), draggable and interchangeable Dockview panels, saved and named workspaces (built-ins Compose, Animate, Captions, Present, Mix; your own are stored in the browser and can be exported and imported as JSON). On a phone: preview on top, bottom navigation, one panel at a time.
- **Layers and Inspector:** Clip Studio style layer list with drag-to-reorder and a typed Order field. Every property row has a keyframe diamond and sound-link chips with a live meter and an editable mapping graph.
- **Signals panel:** your sounds and their six features; drag a feature onto a property to connect it.
- **Timeline:** per-layer visibility bars (hidden layers are not decoded, simulated or drawn), keyframes with hold/linear/smooth, sections, beat snapping. Per property the timeline can override the sound, blend with it (add or multiply) or mix.
- **Visualizer layers:** bars, spikes, dots and waveform wrapped around a line, circle, triangle, square, pentagon, hexagon, star or heart.
- **Effects:** snow, dust, glitter, sparks, confetti, rain, bubbles and retro pixel fire. All are GPU particles that are a pure function of time, so scrubbing and export match the preview. A lo-fi option snaps them to a pixel grid.
- **Closed captions (CC)** (formerly Lyrics): paste words, tap along to time them (hold the tap button to set how long a line stays), start and end time per line, LRC import and export, fonts including your own font file, animations, karaoke highlight and automatic placement that is the same on every run.
- **Script (kinetic text):** write an outline and get animated, automatically laid-out scenes, with no AI. Modes: *Presentation* (own animated backgrounds, Present mode) and *Lyrics over a background* (transparent, word-by-word, lower third, text shadow). Tabs: Write, Timing (tap to sync, start/end per line), Look (style, background, fonts incl. your own file, colours), Scenes (lock layout/transition per scene). Add → Script → Demo gives a Marxism explainer and a song-lyrics example. Converts to and from closed captions and LRC. Engine: `web/js/kinetic.js` (pure and deterministic), text helpers in `web/js/scripttext.js`.

## Tests

    npm run test:rust     # engine
    npm run test:js       # pure modules: animation, shapes, visualizer, lyrics, timeline
    npm run test:render   # WebGL output in headless Chromium (needs playwright)
    npm run test:app      # drives the whole UI against a mock engine (needs playwright)

## v0.7 notes
- Preview works without a song (silent clock); resize/rotate handles; VLC-style transport (start, −10 s, frame, play, +10 s, end, loop, speed; keys Home/End/J/L).
- Effects/visualizers default to *Screen* blend; new overlays always land on top, new pictures above your other pictures.
- Script placement: `::at B2`, `::at left`, `::align`, line `{at=C3}`, word `[text]{size=1.6 color=accent at=A1 delay=.4 motion=pop}`.
- Engine never receives render-only data: `strip()` hides `visualBlend` and sends script layers as `lyrics`; Rust also knows `Script` and `Screen` now (rebuild WASM to pick it up).
