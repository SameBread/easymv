// Signal meters: draw an analysis-rate feature series as a peak waveform and
// compute the live value for a video frame (same pooling rule as the engine, §3.7).

/** Max-per-column peaks for drawing; preserves transients. */
export function peaksForWidth(series, width) {
  const out = new Float32Array(width);
  const n = series.length;
  if (n === 0 || width <= 0) return out;
  for (let x = 0; x < width; x++) {
    const a = Math.floor((x * n) / width);
    const b = Math.max(a + 1, Math.floor(((x + 1) * n) / width));
    let m = 0;
    for (let i = a; i < Math.min(b, n); i++) if (series[i] > m) m = series[i];
    out[x] = m;
  }
  return out;
}

/** Normalized feature value for a video frame: max over its analysis window. */
export function valueAtFrame(series, rate, fps, frame) {
  const n = series.length;
  if (n === 0) return 0;
  const a = Math.min(n - 1, Math.floor((frame * rate) / fps));
  const b = Math.min(n, Math.max(a + 1, Math.floor(((frame + 1) * rate) / fps)));
  let m = 0;
  for (let i = a; i < b; i++) if (series[i] > m) m = series[i];
  return m;
}

export function isSilent(series) {
  for (let i = 0; i < series.length; i++) if (series[i] > 0) return false;
  return true;
}

/** Cached waveform background (peaks) + per-frame playhead overlay. */
export class Meter {
  constructor(canvas, series, colors) {
    this.canvas = canvas;
    this.series = series;
    this.colors = colors;
    this.bg = null;
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(10, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.bg) return;
    this.canvas.width = w; this.canvas.height = h;
    const bg = document.createElement('canvas'); bg.width = w; bg.height = h;
    const g = bg.getContext('2d');
    const peaks = peaksForWidth(this.series, w);
    g.fillStyle = this.colors.wave;
    for (let x = 0; x < w; x++) {
      const bar = Math.max(1, peaks[x] * (h - 2));
      g.fillRect(x, h - bar, 1, bar);
    }
    this.bg = bg;
  }

  setSeries(series) { this.series = series; this.bg = null; this.resize(); }

  draw(playFrac) {
    this.resize();
    const g = this.canvas.getContext('2d');
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.bg, 0, 0);
    g.fillStyle = this.colors.head;
    g.fillRect(Math.round(playFrac * (this.canvas.width - 2)), 0, 2, this.canvas.height);
  }
}
