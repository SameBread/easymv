// Shape presets for the visualizer: the outline the sound is wrapped AROUND (not the
// shape of the wave itself). Every shape is a path on the unit scale (radius 1,
// centred on the origin, y pointing down like canvas pixels) that can be sampled at N
// evenly spaced points, each with an outward normal.
//
// Pure and deterministic, so previews and exports always agree.

export const SHAPES = {
  line:     { label: 'Line',      closed: false, icon: 'horizontal_rule' },
  circle:   { label: 'Circle',    closed: true,  icon: 'radio_button_unchecked' },
  triangle: { label: 'Triangle',  closed: true,  icon: 'change_history' },
  square:   { label: 'Square',    closed: true,  icon: 'square' },
  pentagon: { label: 'Pentagon',  closed: true,  icon: 'pentagon' },
  hexagon:  { label: 'Hexagon',   closed: true,  icon: 'hexagon' },
  star:     { label: 'Star',      closed: true,  icon: 'star' },
  heart:    { label: 'Heart',     closed: true,  icon: 'favorite' },
};
export const SHAPE_IDS = Object.keys(SHAPES);

const TAU = Math.PI * 2;

/** Regular polygon vertices, first vertex at the top, clockwise on screen. */
function polygon(n, inner = null) {
  const pts = [];
  const count = inner ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * TAU) / count;
    const r = inner && i % 2 === 1 ? inner : 1;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

/** Densify a closed or open polyline so arc-length sampling is accurate. */
function densify(pts, closed, perEdge = 24) {
  const out = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i]; const b = pts[(i + 1) % pts.length];
    for (let k = 0; k < perEdge; k++) out.push([a[0] + ((b[0] - a[0]) * k) / perEdge, a[1] + ((b[1] - a[1]) * k) / perEdge]);
  }
  if (!closed) out.push(pts[pts.length - 1]);
  return out;
}

function outline(shape) {
  switch (shape) {
    case 'line': return densify([[-1, 0], [1, 0]], false, 64);
    case 'circle': {
      const pts = [];
      for (let i = 0; i < 256; i++) { const a = -Math.PI / 2 + (i * TAU) / 256; pts.push([Math.cos(a), Math.sin(a)]); }
      return pts;
    }
    case 'triangle': return densify(polygon(3).map(([x, y]) => [x, y + 0.25]), true); // re-centred so it looks balanced
    case 'square': return densify([[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]], true);
    case 'pentagon': return densify(polygon(5), true);
    case 'hexagon': return densify(polygon(6), true);
    case 'star': return densify(polygon(5, 0.45), true);
    case 'heart': {
      const pts = [];
      for (let i = 0; i < 256; i++) {
        const t = (i * TAU) / 256;
        const x = 16 * Math.sin(t) ** 3;
        const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        pts.push([x / 17, y / 17 + 0.05]);
      }
      return pts; // t increasing runs clockwise on screen from the top notch
    }
    default: throw new Error(`unknown shape '${shape}'`);
  }
}

const cache = new Map();

/** Dense outline + cumulative arc length, cached per shape. */
function dense(shape) {
  let d = cache.get(shape);
  if (!d) {
    const pts = outline(shape);
    const closed = SHAPES[shape].closed;
    const cum = [0];
    const m = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < m; i++) {
      const a = pts[i]; const b = pts[(i + 1) % pts.length];
      cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    d = { pts, cum, closed, total: cum[cum.length - 1] };
    cache.set(shape, d);
  }
  return d;
}

/**
 * Sample `n` points evenly by arc length. Closed shapes do not repeat the first point;
 * open shapes include both ends. Returns flat arrays x[], y[], nx[], ny[] (unit outward
 * normal, softened across corners by averaging the tangent over a small window).
 */
export function sampleShape(shape, n) {
  const { pts, cum, closed, total } = dense(shape);
  const x = new Float32Array(n); const y = new Float32Array(n);
  const nx = new Float32Array(n); const ny = new Float32Array(n);
  const m = pts.length;
  const at = (s) => {
    // position on the path at arc length s
    if (closed) s = ((s % total) + total) % total; else s = Math.min(total, Math.max(0, s));
    let lo = 0; let hi = cum.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const a = pts[lo % m]; const b = pts[(lo + 1) % m];
    const seg = cum[lo + 1] - cum[lo] || 1;
    const f = (s - cum[lo]) / seg;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  const win = total * 0.012; // tangent window: rounds corners slightly so bars fan out nicely
  for (let i = 0; i < n; i++) {
    const s = closed ? (i / n) * total : n === 1 ? 0 : (i / (n - 1)) * total;
    const p = at(s);
    const a = at(s - win); const b = at(s + win);
    let tx = b[0] - a[0]; let ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    x[i] = p[0]; y[i] = p[1];
    nx[i] = ty; ny[i] = -tx; // rotate tangent by -90 degrees: outward for clockwise paths
  }
  return { x, y, nx, ny, closed };
}

/** Ordered shape ids with labels, for menus. */
export const shapeList = () => SHAPE_IDS.map((id) => ({ id, ...SHAPES[id] }));
