// Routing presets and generated demo visuals.

const conn = (source, feature, element, property, curve, outMin, outMax, combine, attackMs, releaseMs) =>
  ({ source, feature, element, property, curve, outMin, outMax, combine, attackMs, releaseMs, origin: 'user' });

/** Primary element = highest non-negative zIndex, first on ties (same rule as automatic mode, §7). */
export function primaryElement(project) {
  let best = null;
  for (const e of project.elements) {
    if ((e.zIndex ?? 0) < 0) continue;
    if (best === null || (e.zIndex ?? 0) > (best.zIndex ?? 0)) best = e;
  }
  return best;
}

export const PRESETS = {
  punchy: {
    label: 'Punchy — hits make it pop',
    make: (p, hero, bgs, beat) => [
      conn(beat, 'onset', hero, 'scaleX', 'easeOut', 0, 0.35, 'add', 5, 150),
      conn(beat, 'onset', hero, 'scaleY', 'easeOut', 0, 0.35, 'add', 5, 150),
      conn('master', 'rms', hero, 'brightness', 'linear', 0, 0.25, 'add', 20, 250),
    ],
  },
  bouncy: {
    label: 'Bouncy — squash & hop on the beat',
    make: (p, hero, bgs, beat) => [
      conn(beat, 'onset', hero, 'positionY', 'easeOut', 0, -0.08, 'add', 5, 180),
      conn(beat, 'onset', hero, 'scaleY', 'easeOut', 0, 0.18, 'add', 5, 180),
      conn(beat, 'onset', hero, 'scaleX', 'easeOut', 0, -0.1, 'add', 5, 180),
    ],
  },
  dreamy: {
    label: 'Dreamy — slow swell, sway and blur',
    make: (p, hero, bgs) => [
      conn('master', 'rms', hero, 'scale', 'smoothstep', 0, 0.08, 'add', 150, 900),
      conn('master', 'low', hero, 'rotation', 'smoothstep', -0.05, 0.05, 'add', 300, 1200),
      ...bgs.map((b) => conn('master', 'low', b, 'blur', 'linear', 0, 30, 'replace', 200, 1000)),
    ],
  },
  colorful: {
    label: 'Colorful — hue and saturation follow the sound',
    make: (p, hero, bgs, beat) => [
      conn('master', 'centroid', hero, 'hueShift', 'linear', 0, 120, 'add', 300, 1200),
      conn('master', 'high', hero, 'saturation', 'smoothstep', 0, 1.2, 'add', 50, 400),
      conn(beat, 'onset', hero, 'brightness', 'easeOut', 0, 0.4, 'add', 5, 120),
    ],
  },
};

/**
 * Append a preset's connections to `project`. Skips any `replace` connection that
 * would be a second replace on the same (element, property). Returns the count added.
 */
export function applyPreset(project, key) {
  const preset = PRESETS[key];
  if (!preset) throw new Error(`unknown preset '${key}'`);
  const hero = primaryElement(project);
  const bgs = project.elements.filter((e) => (e.zIndex ?? 0) < 0).map((e) => e.id);
  if (!hero && bgs.length === 0) return 0;
  const beat = project.stems.some((s) => s.id === 'drums') ? 'drums' : 'master';
  const taken = new Set(project.connections.filter((c) => c.combine === 'replace').map((c) => `${c.element}.${c.property}`));
  let added = 0;
  for (const c of preset.make(project, hero?.id, bgs, beat)) {
    if (!c.element) continue;
    if (c.combine === 'replace') {
      const k = `${c.element}.${c.property}`;
      if (taken.has(k)) continue;
      taken.add(k);
    }
    project.connections.push(c); added++;
  }
  return added;
}

/** Demo element definitions (paths match demoFiles()). */
export function demoElementDefs(existingIds) {
  const id = (base) => { let x = base; let n = 2; while (existingIds.has(x)) x = `${base}_${n++}`; existingIds.add(x); return x; };
  return [
    { id: id('demo_background'), type: 'static', path: 'demo_background.png', fit: 'cover', zIndex: -1 },
    { id: id('demo_orb'), type: 'static', path: 'demo_orb.png', fit: 'natural', zIndex: 1, base: { positionX: 0.5, positionY: 0.5, scaleX: 1.6, scaleY: 1.6 } },
  ];
}

/** Generate the demo images in the browser so Quick start needs no user artwork. */
export async function demoFiles() {
  const make = (w, h, draw, name) => new Promise((resolve) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    c.toBlob((b) => resolve(new File([b], name, { type: 'image/png' })), 'image/png');
  });
  const bg = await make(1280, 720, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#1b1038'); grad.addColorStop(1, '#5a1f6b');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 140; i++) { g.fillStyle = `rgba(255,255,255,${0.15 + rnd() * 0.5})`; g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2); }
  }, 'demo_background.png');
  const orb = await make(256, 256, (g) => {
    const r = g.createRadialGradient(128, 128, 8, 128, 128, 120);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,120,190,0.95)');
    r.addColorStop(1, 'rgba(255,80,160,0)');
    g.fillStyle = r; g.beginPath(); g.arc(128, 128, 120, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 3; g.beginPath(); g.arc(128, 128, 70, 0, Math.PI * 2); g.stroke();
  }, 'demo_orb.png');
  return { 'demo_background.png': bg, 'demo_orb.png': orb };
}
