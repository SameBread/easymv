// Programmatic effects: snow, dust, glitter, sparks, confetti, rain, bubbles and a retro
// pixel fire. Every particle is a PURE FUNCTION of (particle id, time, seed, settings),
// evaluated on the GPU in a single instanced draw per layer:
//   * scrubbing, seeking and exporting always match the preview exactly (no stored state);
//   * a hidden effect costs nothing and has nothing to "catch up" on when it reappears;
//   * integer hashing (pcg) makes the randomness identical on every device.

export const FX_KINDS = {
  snow:      { label: 'Snow',        icon: 'ac_unit',               id: 0, defaults: { count: 400, size: 14, speed: 1, wind: 0.15, c1: '#ffffff', c2: '#cfe8ff', area: [1, 1], blend: 'normal' } },
  dust:      { label: 'Dust',        icon: 'blur_on',               id: 1, defaults: { count: 220, size: 10, speed: 1, wind: 0.1, c1: '#fff1d0', c2: '#ffd9a0', area: [1, 1], blend: 'screen' } },
  glitter:   { label: 'Glitter',     icon: 'auto_awesome',          id: 2, defaults: { count: 160, size: 26, speed: 1, wind: 0, c1: '#fff7c2', c2: '#ff9bd2', area: [1, 1], blend: 'screen' } },
  sparks:    { label: 'Sparks',      icon: 'bolt',                  id: 3, defaults: { count: 220, size: 12, speed: 1, wind: 0, c1: '#ffd166', c2: '#ff3b1f', area: [0.5, 0.8], blend: 'screen', y: 0.9 } },
  confetti:  { label: 'Confetti',    icon: 'celebration',           id: 4, defaults: { count: 180, size: 18, speed: 1, wind: 0.1, c1: '#ff6b9d', c2: '#6bd5ff', area: [1, 1], blend: 'normal' } },
  rain:      { label: 'Rain',        icon: 'water_drop',            id: 5, defaults: { count: 420, size: 16, speed: 1, wind: 0.25, c1: '#bcd7ff', c2: '#7aa7ff', area: [1, 1], blend: 'normal' } },
  bubbles:   { label: 'Bubbles',     icon: 'bubble_chart',          id: 6, defaults: { count: 60, size: 46, speed: 1, wind: 0, c1: '#bfeaff', c2: '#ffffff', area: [1, 1], blend: 'screen' } },
  pixelFire: { label: 'Pixel fire',  icon: 'local_fire_department', id: 7, defaults: { count: 1, size: 10, speed: 1, wind: 0, c1: '#ffe27a', c2: '#c1250e', area: [1, 0.42], blend: 'normal', y: 0.88, pixel: 10 } },
};
export const FX_IDS = Object.keys(FX_KINDS);

export const FX_COMMON = { seed: 1, pixel: 0, fps: 12 };

export function fxSettings(def) {
  const kind = FX_KINDS[def.fx?.kind] ? def.fx.kind : 'snow';
  const f = { ...FX_COMMON, ...FX_KINDS[kind].defaults, ...(def.fx ?? {}), kind };
  f.count = Math.max(1, Math.min(4000, Math.round(f.count)));
  return f;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1], 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const PARTICLE_VERT = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 aQ;
uniform vec2 uCanvas;
uniform vec2 uCenter;
uniform vec2 uArea;
uniform float uTime;
uniform int uKind;
uniform int uCount;
uniform float uDensity;
uniform float uSize;
uniform float uSpeed;
uniform float uWind;
uniform uint uSeed;
uniform vec3 uC1;
uniform vec3 uC2;
uniform float uRot;
uniform float uPixel;
out vec2 vLocal;
out vec3 vRgb;
out float vAlpha;
out float vShape;

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float hash(uint id, uint k) { return float(pcg(id * 9781u + k * 6271u + uSeed * 31u)) / 4294967295.0; }
vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }

void main() {
  uint id = uint(gl_InstanceID);
  if (gl_InstanceID >= uCount || hash(id, 99u) > uDensity) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float t = uTime;
  vec2 A = uArea;
  float h1 = hash(id, 1u), h2 = hash(id, 2u), h3 = hash(id, 3u), h4 = hash(id, 4u), h5 = hash(id, 5u), h6 = hash(id, 6u);
  vec2 pos = vec2(0.0);       // inside the area, px, origin top-left
  vec2 size = vec2(uSize);    // px
  float alpha = 1.0;
  float angle = 0.0;
  float shape = 0.0;          // 0 soft disc, 1 sparkle, 2 rect, 3 ring, 4 streak
  vec3 rgb = mix(uC1, uC2, h6);

  if (uKind == 0) {            // snow
    float sp = (0.5 + h2) * uSpeed * 0.12 * A.y;
    float y = mod(h3 * A.y + t * sp, A.y);
    float sway = sin(t * (0.6 + h4 * 0.8) + h5 * 6.2831) * 0.02 * A.x;
    float x = mod(h1 * A.x + sway + uWind * t * 0.05 * A.x * (0.5 + h2) + A.x * 4.0, A.x);
    pos = vec2(x, y);
    size = vec2(uSize * (0.35 + 0.9 * h2));
    alpha = 0.4 + 0.6 * h2;
  } else if (uKind == 1) {     // dust
    float x = h1 * A.x + sin(t * 0.13 * (1.0 + h2) * uSpeed + h3 * 6.2831) * A.x * 0.04 + uWind * t * 0.01 * A.x;
    float y = h4 * A.y + cos(t * 0.1 * (1.0 + h5) * uSpeed + h6 * 6.2831) * A.y * 0.05 - t * uSpeed * 0.004 * A.y * (0.5 + h2);
    pos = vec2(mod(x + A.x * 4.0, A.x), mod(y + A.y * 4.0, A.y));
    size = vec2(uSize * 0.5 * (0.5 + h3));
    alpha = (0.15 + 0.35 * h2) * (0.5 + 0.5 * sin(t * 0.7 + h6 * 6.2831));
  } else if (uKind == 2) {     // glitter
    pos = vec2(h1 * A.x, h2 * A.y);
    float tw = pow(max(0.0, sin(t * uSpeed * (1.5 + h3 * 3.0) + h4 * 6.2831)), 6.0);
    alpha = tw;
    size = vec2(uSize * (0.5 + h5) * (0.4 + tw * 0.8));
    shape = 1.0;
    angle = 0.7854 * step(0.5, h5);
  } else if (uKind == 3) {     // sparks
    float life = 1.2 + h2 * 1.5;
    float age = mod(t * uSpeed * 0.7 + h3 * life, life) / life;
    vec2 origin = vec2(A.x * 0.5 + (h1 - 0.5) * A.x * 0.15, A.y);
    pos = origin + vec2((h4 - 0.5) * A.x * 0.9 * age + uWind * age * A.x * 0.3, -age * (0.4 + h5 * 0.9) * A.y * 0.9 + age * age * A.y * 0.35);
    alpha = (1.0 - age) * (1.0 - age);
    size = vec2(uSize * (1.0 - age * 0.7) * (0.5 + h6 * 0.8));
    rgb = mix(uC1, uC2, age);
  } else if (uKind == 4) {     // confetti
    float sp = (0.35 + 0.5 * h2) * uSpeed * 0.1 * A.y;
    float y = mod(h3 * A.y + t * sp, A.y);
    float x = mod(h1 * A.x + sin(t * (0.8 + h4) + h5 * 6.2831) * 0.03 * A.x + uWind * t * 0.04 * A.x + A.x * 4.0, A.x);
    pos = vec2(x, y);
    float flutter = abs(cos(t * (1.5 + h4 * 2.0) + h5 * 6.2831));
    size = vec2(uSize * (0.6 + 0.6 * h2), uSize * (0.3 + 0.5 * h2) * (0.25 + 0.75 * flutter));
    angle = t * (1.0 + h4 * 3.0) * (h1 < 0.5 ? 1.0 : -1.0) + h5 * 6.2831;
    shape = 2.0;
    rgb = 0.5 + 0.5 * cos(6.2831 * (h6 + vec3(0.0, 0.33, 0.67)));
    rgb = mix(rgb, mix(uC1, uC2, h6), 0.35);
  } else if (uKind == 5) {     // rain
    float sp = (0.8 + h2 * 0.4) * uSpeed * 1.4 * A.y;
    float y = mod(h3 * A.y + t * sp, A.y);
    float slant = uWind * 0.6;
    float x = mod(h1 * A.x + y * slant + A.x * 4.0, A.x);
    pos = vec2(x, y);
    size = vec2(uSize * 0.18, uSize * 3.5);
    angle = -atan(slant);
    shape = 4.0;
    alpha = 0.3 + 0.5 * h2;
  } else if (uKind == 6) {     // bubbles
    float sp = (0.4 + h2) * uSpeed * 0.05 * A.y;
    float y = A.y - mod(h3 * A.y + t * sp, A.y);
    float x = h1 * A.x + sin(t * (0.8 + h4) + h5 * 6.2831) * A.x * 0.015 + uWind * t * 0.01 * A.x;
    pos = vec2(mod(x + A.x * 4.0, A.x), y);
    size = vec2(uSize * (0.4 + 0.9 * h2));
    shape = 3.0;
    alpha = 0.35 + 0.4 * h6;
  }

  // Lo-fi: snap to a grid, force square pixels, freeze time to a low frame rate.
  if (uPixel > 0.0) {
    pos = (floor(pos / uPixel) + 0.5) * uPixel;
    float s = max(uPixel, floor(max(size.x, size.y) / uPixel + 0.5) * uPixel);
    size = vec2(s); shape = 2.0; angle = 0.0;
  }

  vec2 local = aQ * 2.0 - 1.0;
  vec2 p = uCenter + rot(pos - A * 0.5, uRot) + rot(local * size * 0.5, angle + uRot);
  vLocal = local; vRgb = rgb; vAlpha = alpha; vShape = shape;
  gl_Position = vec4(p.x / uCanvas.x * 2.0 - 1.0, 1.0 - p.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

export const PARTICLE_FRAG = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec3 vRgb;
in float vAlpha;
in float vShape;
uniform float uOpacity;
uniform float uGlow;
out vec4 o;
void main() {
  float d = length(vLocal);
  float a;
  if (vShape < 0.5) a = smoothstep(1.0, 0.15, d);
  else if (vShape < 1.5) {
    float cross = max(exp(-abs(vLocal.x) * 9.0) * exp(-abs(vLocal.y) * 1.3), exp(-abs(vLocal.y) * 9.0) * exp(-abs(vLocal.x) * 1.3));
    a = clamp(cross + smoothstep(0.5, 0.0, d), 0.0, 1.0);
  } else if (vShape < 2.5) a = 1.0;
  else if (vShape < 3.5) a = smoothstep(0.14, 0.0, abs(d - 0.82)) + 0.12 * smoothstep(1.0, 0.0, d);
  else a = smoothstep(1.0, 0.0, abs(vLocal.x)) * smoothstep(1.0, 0.2, abs(vLocal.y));
  a *= vAlpha * uOpacity;
  if (a <= 0.002) discard;
  o = vec4(vRgb * a * uGlow, a);
}`;

export const FIRE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aQ;
uniform vec2 uCanvas;
uniform vec2 uCenter;
uniform vec2 uArea;
uniform float uRot;
out vec2 vPx;
void main() {
  vec2 local = (aQ - 0.5) * uArea;
  float c = cos(uRot), s = sin(uRot);
  vec2 p = vec2(c * local.x - s * local.y, s * local.x + c * local.y) + uCenter;
  vPx = aQ * uArea;
  gl_Position = vec4(p.x / uCanvas.x * 2.0 - 1.0, 1.0 - p.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

// Retro pixel fire: layered value noise scrolled upward, quantised to a handful of colour
// bands on a coarse grid. Stateless (a function of time only) and cheap: the noise is
// evaluated per cell, not per pixel.
export const FIRE_FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec2 vPx;
uniform vec2 uArea;
uniform float uTime;
uniform float uCell;
uniform float uSpeed;
uniform float uWind;
uniform uint uSeed;
uniform vec3 uC1;
uniform vec3 uC2;
uniform float uOpacity;
out vec4 o;
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float hash2(ivec2 p) { return float(pcg(uint(p.x + 4096) * 7919u + uint(p.y + 4096) * 104729u + uSeed * 31u)) / 4294967295.0; }
float vnoise(vec2 p) {
  ivec2 i = ivec2(floor(p)); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + ivec2(1, 0)), f.x), mix(hash2(i + ivec2(0, 1)), hash2(i + ivec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 cells = max(vec2(1.0), floor(uArea / uCell));
  vec2 g = floor(vPx / uCell);
  float x = (g.x + 0.5) / cells.x;
  float y = 1.0 - (g.y + 0.5) / cells.y;                 // 0 at the bottom, 1 at the top
  vec2 q = vec2(g.x * 0.28 + uWind * y * 2.0, g.y * 0.28 - uTime * uSpeed * 2.6);
  float n = vnoise(q) * 0.55 + vnoise(q * 2.1 + 7.3) * 0.3 + vnoise(q * 4.3 + 3.1) * 0.15;
  float edge = 1.0 - pow(abs(x - 0.5) * 2.0, 3.0) * 0.55;
  float heat = ((1.0 - y * 1.12) + (n - 0.5) * 0.95) * edge;
  if (heat < 0.1) discard;
  float level = floor(clamp(heat, 0.0, 1.0) * 5.0) / 4.0;  // 0..1 in 5 bands
  vec3 dark = vec3(0.35, 0.02, 0.02);
  vec3 rgb = level < 0.3 ? mix(dark, uC2, level / 0.3) : level < 0.7 ? mix(uC2, uC1, (level - 0.3) / 0.4) : mix(uC1, vec3(1.0), (level - 0.7) / 0.3);
  o = vec4(rgb * uOpacity, uOpacity);
}`;
