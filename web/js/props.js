// Property registry for the UI: labels, ranges, units and groupings. The order and
// names mirror the engine's property list (animation.js PROPERTY_NAMES).

const DEG = 180 / Math.PI;

export const PROPS = [
  { name: 'positionX', label: 'Position X', group: 'Transform', min: -1, max: 2, step: 0.1, mul: 100, suffix: '%', def: 0.5 },
  { name: 'positionY', label: 'Position Y', group: 'Transform', min: -1, max: 2, step: 0.1, mul: 100, suffix: '%', def: 0.5 },
  { name: 'rotation', label: 'Rotation', group: 'Transform', min: -6.2832, max: 6.2832, step: 0.5, mul: DEG, suffix: '°', def: 0 },
  { name: 'scale', label: 'Scale', group: 'Transform', min: 0.01, max: 10, step: 0.01, mul: 1, suffix: '×', def: 1 },
  { name: 'scaleX', label: 'Scale X', group: 'Transform', min: 0.01, max: 10, step: 0.01, mul: 1, suffix: '×', def: 1, advanced: true },
  { name: 'scaleY', label: 'Scale Y', group: 'Transform', min: 0.01, max: 10, step: 0.01, mul: 1, suffix: '×', def: 1, advanced: true },
  { name: 'mirrorX', label: 'Mirror X', group: 'Transform', min: 0, max: 1, step: 1, mul: 1, suffix: '', def: 0, advanced: true, toggle: true },
  { name: 'mirrorY', label: 'Mirror Y', group: 'Transform', min: 0, max: 1, step: 1, mul: 1, suffix: '', def: 0, advanced: true, toggle: true },
  { name: 'opacity', label: 'Opacity', group: 'Look', min: 0, max: 1, step: 0.5, mul: 100, suffix: '%', def: 1 },
  { name: 'hueShift', label: 'Hue shift', group: 'Look', min: 0, max: 360, step: 1, mul: 1, suffix: '°', def: 0 },
  { name: 'saturation', label: 'Saturation', group: 'Look', min: 0, max: 4, step: 0.01, mul: 100, suffix: '%', def: 1 },
  { name: 'brightness', label: 'Brightness', group: 'Look', min: 0, max: 4, step: 0.01, mul: 100, suffix: '%', def: 1 },
  { name: 'contrast', label: 'Contrast', group: 'Look', min: 0, max: 4, step: 0.01, mul: 100, suffix: '%', def: 1 },
  { name: 'blur', label: 'Blur', group: 'Look', min: 0, max: 200, step: 0.5, mul: 1, suffix: 'px', def: 0 },
  { name: 'anchorX', label: 'Anchor X', group: 'Transform', min: 0, max: 1, step: 0.1, mul: 100, suffix: '%', def: 0.5, advanced: true },
  { name: 'anchorY', label: 'Anchor Y', group: 'Transform', min: 0, max: 1, step: 0.1, mul: 100, suffix: '%', def: 0.5, advanced: true },
  { name: 'visible', label: 'Visible', group: 'Layer', min: 0, max: 1, step: 1, mul: 1, suffix: '', def: 1, toggle: true },
  { name: 'intensity', label: 'Intensity', group: 'Layer', min: 0, max: 4, step: 0.01, mul: 100, suffix: '%', def: 1 },
];

export const PROP_BY_NAME = Object.fromEntries(PROPS.map((p) => [p.name, p]));

/** Properties that make sense for each layer type (others are hidden in the Inspector). */
export function propsFor(type) {
  const skip = new Set();
  if (type === 'visualizer') ['anchorX', 'anchorY'].forEach((n) => skip.add(n));
  if (type === 'effect') ['anchorX', 'anchorY', 'mirrorX', 'mirrorY', 'hueShift'].forEach((n) => skip.add(n));
  if (type === 'lyrics') ['anchorX', 'anchorY', 'mirrorX', 'mirrorY'].forEach((n) => skip.add(n));
  if (type !== 'visualizer' && type !== 'effect') skip.add('intensity');
  return PROPS.filter((p) => !skip.has(p.name));
}

export const toUi = (p, v) => v * p.mul;
export const fromUi = (p, v) => v / p.mul;
export const fmtValue = (p, v) => {
  const x = v * p.mul;
  const d = p.mul >= 100 ? 0 : Math.abs(x) >= 100 ? 0 : 2;
  return `${Number(x.toFixed(d))}${p.suffix}`;
};

export const FEATURES = ['rms', 'low', 'mid', 'high', 'onset', 'centroid'];
export const FEATURE_LABELS = { rms: 'Volume', low: 'Low (bass)', mid: 'Mid', high: 'High (treble)', onset: 'Hits / beats', centroid: 'Brightness' };
export const CURVES = ['linear', 'easeIn', 'easeOut', 'smoothstep', 'threshold'];
export const COMBINES = { add: 'Add', multiply: 'Multiply', replace: 'Set', max: 'Max', min: 'Min' };
