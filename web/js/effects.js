// Programmatic effects: snow, rain, sparks, fireflies, fireworks... Every particle is a PURE FUNCTION of
// (particle id, time, seed, settings), evaluated on the GPU in a single instanced draw per layer:
//   * scrubbing, seeking and exporting always match the preview exactly (no stored state);
//   * a hidden effect costs nothing and has nothing to "catch up" on when it reappears;
//   * integer hashing (pcg) makes the randomness identical on every device.
// Scripted events (gusts, speed changes, bursts, flashes: see fxscript.js) reach the shader as a few numbers per frame:
// the integrated "phase" (time scaled by speed) and wind displacement, the current wind, a tint and a flash. Nothing is stored.
//
// grav: +1 things that fall (a downdraft speeds them up), -1 things that rise, 0 neither.
// burst: how a scripted burst looks for this effect: { shape (see PARTICLE_FRAG), rainbow }.

export const FX_KINDS = {
  snow:      { label: 'Snow',        icon: 'ac_unit',               id: 0,  grav: 1,  burst: { shape: 0 }, defaults: { count: 400, size: 14, speed: 1, wind: 0.15, c1: '#ffffff', c2: '#cfe8ff', area: [1, 1], blend: 'normal' } },
  dust:      { label: 'Dust',        icon: 'blur_on',               id: 1,  grav: 0,  burst: { shape: 0 }, defaults: { count: 220, size: 10, speed: 1, wind: 0.1, c1: '#fff1d0', c2: '#ffd9a0', area: [1, 1], blend: 'screen' } },
  glitter:   { label: 'Glitter',     icon: 'auto_awesome',          id: 2,  grav: 0,  burst: { shape: 1 }, defaults: { count: 160, size: 26, speed: 1, wind: 0, c1: '#fff7c2', c2: '#ff9bd2', area: [1, 1], blend: 'screen' } },
  sparks:    { label: 'Sparks',      icon: 'bolt',                  id: 3,  grav: 0,  burst: { shape: 0 }, defaults: { count: 220, size: 12, speed: 1, wind: 0, c1: '#ffd166', c2: '#ff3b1f', area: [0.5, 0.8], blend: 'screen', y: 0.9 } },
  confetti:  { label: 'Confetti',    icon: 'celebration',           id: 4,  grav: 1,  burst: { shape: 2, rainbow: 1 }, defaults: { count: 180, size: 18, speed: 1, wind: 0.1, c1: '#ff6b9d', c2: '#6bd5ff', area: [1, 1], blend: 'normal' } },
  rain:      { label: 'Rain',        icon: 'water_drop',            id: 5,  grav: 1,  burst: { shape: 0 }, defaults: { count: 420, size: 16, speed: 1, wind: 0.25, c1: '#bcd7ff', c2: '#7aa7ff', area: [1, 1], blend: 'normal' } },
  bubbles:   { label: 'Bubbles',     icon: 'bubble_chart',          id: 6,  grav: -1, burst: { shape: 3 }, defaults: { count: 60, size: 46, speed: 1, wind: 0, c1: '#bfeaff', c2: '#ffffff', area: [1, 1], blend: 'screen' } },
  pixelFire: { label: 'Pixel fire',  icon: 'local_fire_department', id: 7,  grav: 0,  burst: { shape: 2 }, defaults: { count: 1, size: 10, speed: 1, wind: 0, c1: '#ffe27a', c2: '#c1250e', area: [1, 0.42], blend: 'normal', y: 0.88, pixel: 10 } },
  fireflies: { label: 'Fireflies',   icon: 'flare',                 id: 8,  grav: 0,  burst: { shape: 0 }, defaults: { count: 70, size: 22, speed: 1, wind: 0, c1: '#f2ff7a', c2: '#9dff5c', area: [1, 1], blend: 'screen' } },
  stars:     { label: 'Starfield',   icon: 'star',                  id: 9,  grav: 0,  burst: { shape: 1 }, defaults: { count: 320, size: 24, speed: 1, wind: 0, c1: '#ffffff', c2: '#bcd0ff', area: [1, 1], blend: 'screen' } },
  embers:    { label: 'Embers',      icon: 'whatshot',              id: 10, grav: -1, burst: { shape: 0 }, defaults: { count: 150, size: 14, speed: 1, wind: 0.1, c1: '#ffb347', c2: '#d4290e', area: [1, 1], blend: 'screen' } },
  leaves:    { label: 'Leaves',      icon: 'eco',                   id: 11, grav: 1,  burst: { shape: 6 }, defaults: { count: 60, size: 34, speed: 1, wind: 0.2, c1: '#e8892b', c2: '#b3361f', area: [1, 1], blend: 'normal' } },
  petals:    { label: 'Petals',      icon: 'local_florist',         id: 12, grav: 1,  burst: { shape: 7 }, defaults: { count: 90, size: 24, speed: 1, wind: 0.2, c1: '#ffc2d6', c2: '#fff0f5', area: [1, 1], blend: 'normal' } },
  bokeh:     { label: 'Bokeh',       icon: 'lens_blur',             id: 13, grav: 0,  burst: { shape: 8 }, defaults: { count: 40, size: 90, speed: 1, wind: 0, c1: '#ffd9a0', c2: '#ff9bd2', area: [1, 1], blend: 'screen' } },
  hearts:    { label: 'Hearts',      icon: 'favorite',              id: 14, grav: -1, burst: { shape: 5 }, defaults: { count: 36, size: 38, speed: 1, wind: 0, c1: '#ff5c8a', c2: '#ffa3c4', area: [1, 1], blend: 'normal' } },
  smoke:     { label: 'Smoke',       icon: 'cloud',                 id: 15, grav: -1, burst: { shape: 0 }, defaults: { count: 70, size: 130, speed: 1, wind: 0.1, c1: '#9aa0aa', c2: '#4b4f58', area: [0.6, 0.9], blend: 'normal', y: 0.95 } },
  warp:      { label: 'Warp speed',  icon: 'rocket_launch',         id: 16, grav: 0,  burst: { shape: 4 }, defaults: { count: 320, size: 22, speed: 1, wind: 0, c1: '#aee0ff', c2: '#ffffff', area: [1, 1], blend: 'screen' } },
  matrix:    { label: 'Digital rain', icon: 'view_column',          id: 17, grav: 1,  burst: { shape: 9 }, defaults: { count: 150, size: 14, speed: 1, wind: 0, c1: '#7dffa0', c2: '#1fbf5a', area: [1, 1], blend: 'screen' } },
  fireworks: { label: 'Fireworks',   icon: 'sunny',                 id: 18, grav: 0,  burst: { shape: 0, rainbow: 1 }, defaults: { count: 600, size: 17, speed: 1, wind: 0, c1: '#ffd166', c2: '#ff5c8a', area: [1, 1], blend: 'screen' } },
  ripples:   { label: 'Ripples',     icon: 'radio_button_unchecked', id: 19, grav: 0, burst: { shape: 3 }, defaults: { count: 26, size: 40, speed: 1, wind: 0, c1: '#7fe9ff', c2: '#ffffff', area: [1, 1], blend: 'screen' } },
};
export const FX_IDS = Object.keys(FX_KINDS);

export const FX_COMMON = { seed: 1, pixel: 0, fps: 12, windY: 0, turb: 1, script: '' };

export function fxSettings(def) {
  const kind = FX_KINDS[def.fx?.kind] ? def.fx.kind : 'snow';
  const f = { ...FX_COMMON, ...FX_KINDS[kind].defaults, ...(def.fx ?? {}), kind };
  f.count = Math.max(1, Math.min(4000, Math.round(f.count)));
  f.windY = Math.max(-2, Math.min(2, Number(f.windY) || 0));
  f.turb = Math.max(0, Math.min(4, Number.isFinite(Number(f.turb)) ? Number(f.turb) : 1));
  f.script = typeof f.script === 'string' ? f.script : '';
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
uniform int uKind;          // 0..19 effects, 30 = scripted burst, 31 = flash
uniform int uCount;
uniform float uDensity;
uniform float uSize;
uniform uint uSeed;
uniform vec3 uC1;
uniform vec3 uC2;
uniform float uRot;
uniform float uPixel;
uniform float uPhase;       // time scaled by speed (integrated, so speed changes never jump)
uniform vec2 uWindD;        // wind displacement so far (integrated wind)
uniform vec2 uLean;         // wind right now
uniform float uTurb;        // how much things sway
uniform vec4 uTint;         // colour wash (rgb, amount)
uniform vec4 uBurstA;       // age s, life s, origin x, origin y (0..1)
uniform vec4 uBurstB;       // spread, power, angle (< -9: all around), shape
uniform vec2 uBurstC;       // rainbow, seed
uniform vec4 uFlash;        // rgb, amount
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
float hashS(uint a, uint k) { return float(pcg(a * 2654435761u + k * 6271u + uSeed * 31u)) / 4294967295.0; }
vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
vec3 palette(float h) { return 0.5 + 0.5 * cos(6.2831 * (h + vec3(0.0, 0.33, 0.67))); }

void main() {
  uint id = uint(gl_InstanceID);
  bool special = uKind >= 30;
  if (gl_InstanceID >= uCount || (!special && hash(id, 99u) > uDensity)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float P = uPhase;
  vec2 A = uArea;
  float h1 = hash(id, 1u), h2 = hash(id, 2u), h3 = hash(id, 3u), h4 = hash(id, 4u), h5 = hash(id, 5u), h6 = hash(id, 6u);
  vec2 pos = vec2(0.0);       // inside the area, px, origin top-left
  vec2 size = vec2(uSize);    // px
  float alpha = 1.0;
  float angle = 0.0;
  float shape = 0.0;          // 0 soft disc, 1 sparkle, 2 rect, 3 ring, 4 streak, 5 heart, 6 leaf, 7 petal, 8 bokeh, 9 trail
  vec3 rgb = mix(uC1, uC2, h6);
  float T = uTurb;

  if (uKind == 0) {            // snow
    float sp = (0.5 + h2) * 0.12 * A.y;
    float y = mod(h3 * A.y + P * sp + uWindD.y * 0.05 * A.y * (0.5 + h2), A.y);
    float sway = sin(P * (0.6 + h4 * 0.8) + h5 * 6.2831) * 0.02 * A.x * T;
    float x = mod(h1 * A.x + sway + uWindD.x * 0.05 * A.x * (0.5 + h2), A.x);
    pos = vec2(x, y);
    size = vec2(uSize * (0.35 + 0.9 * h2));
    alpha = 0.4 + 0.6 * h2;
  } else if (uKind == 1) {     // dust
    float x = h1 * A.x + sin(P * 0.13 * (1.0 + h2) + h3 * 6.2831) * A.x * 0.04 * T + uWindD.x * 0.01 * A.x;
    float y = h4 * A.y + cos(P * 0.1 * (1.0 + h5) + h6 * 6.2831) * A.y * 0.05 * T - P * 0.004 * A.y * (0.5 + h2) + uWindD.y * 0.01 * A.y;
    pos = vec2(mod(x, A.x), mod(y, A.y));
    size = vec2(uSize * 0.5 * (0.5 + h3));
    alpha = (0.15 + 0.35 * h2) * (0.5 + 0.5 * sin(P * 0.7 + h6 * 6.2831));
  } else if (uKind == 2) {     // glitter
    pos = vec2(h1 * A.x, h2 * A.y);
    float tw = pow(max(0.0, sin(P * (1.5 + h3 * 3.0) + h4 * 6.2831)), 6.0);
    alpha = tw;
    size = vec2(uSize * (0.5 + h5) * (0.4 + tw * 0.8));
    shape = 1.0;
    angle = 0.7854 * step(0.5, h5);
  } else if (uKind == 3) {     // sparks
    float life = 1.2 + h2 * 1.5;
    float age = mod(P * 0.7 + h3 * life, life) / life;
    vec2 origin = vec2(A.x * 0.5 + (h1 - 0.5) * A.x * 0.15, A.y);
    pos = origin + vec2((h4 - 0.5) * A.x * 0.9 * age + uLean.x * age * A.x * 0.3, -age * (0.4 + h5 * 0.9) * A.y * 0.9 + age * age * A.y * 0.35 + uLean.y * age * A.y * 0.2);
    alpha = (1.0 - age) * (1.0 - age);
    size = vec2(uSize * (1.0 - age * 0.7) * (0.5 + h6 * 0.8));
    rgb = mix(uC1, uC2, age);
  } else if (uKind == 4) {     // confetti
    float sp = (0.35 + 0.5 * h2) * 0.1 * A.y;
    float y = mod(h3 * A.y + P * sp + uWindD.y * 0.04 * A.y, A.y);
    float x = mod(h1 * A.x + sin(P * (0.8 + h4) + h5 * 6.2831) * 0.03 * A.x * T + uWindD.x * 0.04 * A.x, A.x);
    pos = vec2(x, y);
    float flutter = abs(cos(P * (1.5 + h4 * 2.0) + h5 * 6.2831));
    size = vec2(uSize * (0.6 + 0.6 * h2), uSize * (0.3 + 0.5 * h2) * (0.25 + 0.75 * flutter));
    angle = P * (1.0 + h4 * 3.0) * (h1 < 0.5 ? 1.0 : -1.0) + h5 * 6.2831;
    shape = 2.0;
    rgb = palette(h6);
    rgb = mix(rgb, mix(uC1, uC2, h6), 0.35);
  } else if (uKind == 5) {     // rain: the whole curtain leans with the wind
    float sp = (0.8 + h2 * 0.4) * 1.4 * A.y;
    float y = mod(h3 * A.y + P * sp, A.y);
    float slant = uLean.x * 0.6;
    float x = mod(h1 * A.x + (y - A.y * 0.5) * slant + A.x * 4.0, A.x);
    pos = vec2(x, y);
    size = vec2(uSize * 0.18, uSize * 3.5);
    angle = -atan(slant);
    shape = 4.0;
    alpha = 0.3 + 0.5 * h2;
  } else if (uKind == 6) {     // bubbles
    float sp = (0.4 + h2) * 0.05 * A.y;
    float y = A.y - mod(h3 * A.y + P * sp - uWindD.y * 0.01 * A.y, A.y);
    float x = h1 * A.x + sin(P * (0.8 + h4) + h5 * 6.2831) * A.x * 0.015 * T + uWindD.x * 0.01 * A.x;
    pos = vec2(mod(x, A.x), y);
    size = vec2(uSize * (0.4 + 0.9 * h2));
    shape = 3.0;
    alpha = 0.35 + 0.4 * h6;
  } else if (uKind == 8) {     // fireflies
    float x = h1 * A.x + sin(P * 0.17 * (1.0 + h2) + h3 * 6.2831) * A.x * 0.07 * T + cos(P * 0.11 * (1.0 + h5) + h6 * 3.0) * A.x * 0.03 * T + uWindD.x * 0.01 * A.x;
    float y = h4 * A.y + cos(P * 0.14 * (1.0 + h3) + h2 * 6.2831) * A.y * 0.09 * T + sin(P * 0.09 * (1.0 + h6) + h1 * 5.0) * A.y * 0.04 * T + uWindD.y * 0.01 * A.y;
    pos = vec2(mod(x, A.x), mod(y, A.y));
    float blink = pow(0.5 + 0.5 * sin(P * (0.5 + h4 * 0.9) * 1.3 + h5 * 6.2831), 2.5);
    size = vec2(uSize * (0.6 + 0.8 * h2) * (0.7 + 0.5 * blink));
    alpha = 0.08 + 0.92 * blink;
  } else if (uKind == 9) {     // starfield
    float drift = (0.2 + h3) * 0.01;
    float x = mod(h1 * A.x + (uWindD.x * 0.01 + P * 0.002) * A.x * (0.2 + h3), A.x);
    float y = mod(h2 * A.y + uWindD.y * 0.01 * A.y * (0.2 + h3), A.y);
    pos = vec2(x, y);
    float tw = 0.55 + 0.45 * sin(P * (1.0 + h3 * 3.0) + h4 * 6.2831);
    bool big = h5 > 0.93;
    size = vec2(uSize * (big ? 1.5 : 0.12 + 0.5 * h5 * h5));
    shape = big ? 1.0 : 0.0;
    alpha = (0.25 + 0.75 * h2) * tw;
    rgb = mix(uC1, uC2, h6 * h6);
    drift += 0.0;
  } else if (uKind == 10) {    // embers
    float sp = (0.25 + 0.55 * h2) * 0.11 * A.y;
    float r = mod(h3 * A.y + P * sp - uWindD.y * 0.04 * A.y, A.y);
    float age = r / A.y;
    float x = h1 * A.x + sin(P * (0.9 + h4) + h5 * 6.2831) * A.x * 0.025 * T * (0.4 + age) + uWindD.x * 0.05 * A.x * (0.4 + age);
    pos = vec2(mod(x, A.x), A.y - r);
    size = vec2(uSize * (1.0 - 0.8 * age) * (0.4 + 0.8 * h6));
    alpha = (1.0 - age) * (0.6 + 0.4 * sin(P * 8.0 * (0.5 + h2) + h5 * 6.2831));
    rgb = mix(uC1, uC2, age);
  } else if (uKind == 11 || uKind == 12) {   // leaves, petals
    bool leaf = uKind == 11;
    float sp = (leaf ? 0.3 + 0.4 * h2 : 0.2 + 0.3 * h2) * 0.09 * A.y;
    float y = mod(h3 * A.y + P * sp + uWindD.y * 0.04 * A.y, A.y);
    float x = mod(h1 * A.x + sin(P * (0.5 + h4 * 0.6) + h5 * 6.2831) * (leaf ? 0.06 : 0.09) * A.x * T + uWindD.x * 0.06 * A.x * (0.5 + h2), A.x);
    pos = vec2(x, y);
    angle = sin(P * (0.7 + h4) + h5 * 6.2831) * 1.1 + h1 * 6.2831;
    size = vec2(uSize * (0.7 + 0.6 * h2));
    size.x *= 0.35 + 0.65 * abs(cos(P * (0.9 + h4 * 1.2) + h5 * 6.2831));
    shape = leaf ? 6.0 : 7.0;
    rgb = mix(uC1, uC2, h6) * (0.75 + 0.5 * h3);
    alpha = 0.95;
  } else if (uKind == 13) {    // bokeh
    float x = h1 * A.x + sin(P * 0.07 * (1.0 + h2) + h3 * 6.2831) * A.x * 0.05 * T + uWindD.x * 0.004 * A.x;
    float y = h4 * A.y + cos(P * 0.06 * (1.0 + h5) + h6 * 6.2831) * A.y * 0.05 * T + uWindD.y * 0.004 * A.y;
    pos = vec2(mod(x, A.x), mod(y, A.y));
    size = vec2(uSize * (0.4 + 1.2 * h2 * h2) * (1.0 + 0.12 * sin(P * 0.5 + h4 * 6.2831)));
    alpha = (0.06 + 0.2 * h5) * (0.6 + 0.4 * sin(P * 0.4 + h6 * 6.2831));
    shape = 8.0;
  } else if (uKind == 14) {    // hearts
    float sp = (0.25 + 0.4 * h2) * 0.08 * A.y;
    float r = mod(h3 * A.y + P * sp - uWindD.y * 0.04 * A.y, A.y);
    float age = r / A.y;
    float x = h1 * A.x + sin(P * (0.6 + h4 * 0.7) + h5 * 6.2831) * A.x * 0.04 * T + uWindD.x * 0.05 * A.x * (0.5 + h2);
    pos = vec2(mod(x, A.x), A.y - r);
    size = vec2(uSize * (0.5 + 0.6 * h2));
    angle = sin(P * (0.8 + h4) + h5 * 6.2831) * 0.35;
    alpha = 1.0 - pow(age, 3.0);
    shape = 5.0;
  } else if (uKind == 15) {    // smoke
    float age = fract(h3 + P * (0.04 + 0.04 * h2));
    pos = vec2(A.x * (0.5 + (h1 - 0.5) * 0.3) + (h4 - 0.5) * A.x * 0.1 * age + (uLean.x * A.x * 0.3 + sin(P * 0.5 + h5 * 6.2831) * A.x * 0.03 * T) * age, A.y * (1.0 - age * 0.85) + uLean.y * A.y * 0.1 * age);
    size = vec2(uSize * (0.5 + 1.8 * age));
    alpha = sin(age * 3.1416) * 0.3 * (0.5 + h6);
    rgb = mix(uC1, uC2, age);
  } else if (uKind == 16) {    // warp speed: streaks rushing out from the centre
    float ang = h1 * 6.2831;
    float r = fract(h3 + P * (0.18 + 0.25 * h2));
    float rr = r * r;
    float dist = rr * 0.75 * length(A);
    pos = A * 0.5 + vec2(cos(ang), sin(ang)) * dist + uLean * A * 0.05 * rr;
    size = vec2(uSize * 0.12 * (0.5 + rr * 2.0), uSize * (0.5 + rr * 9.0));
    angle = ang - 1.5708;
    shape = 4.0;
    alpha = smoothstep(0.0, 0.15, r) * (0.2 + 0.8 * rr) * (1.0 - smoothstep(0.92, 1.0, r));
  } else if (uKind == 17) {    // digital rain
    float cols = max(1.0, floor(A.x / (uSize * 0.9)));
    float col = floor(h1 * cols);
    float hc = hash(uint(col) + 5000u, 7u);
    float x = (col + 0.5) / cols * A.x;
    float sp = (0.5 + hc * 1.2) * 0.5 * A.y;
    float y = mod(h3 * A.y * 1.6 + P * sp + uWindD.y * 0.05 * A.y, A.y * 1.6) - 0.3 * A.y;
    pos = vec2(x + uWindD.x * 0.0, y);
    size = vec2(uSize * 0.55, uSize * (4.0 + hc * 8.0));
    shape = 9.0;
    alpha = 0.4 + 0.6 * h2;
  } else if (uKind == 18) {    // fireworks: shells rise, burst, fall
    uint per = uint(max(8.0, float(uCount) / 12.0));
    uint shell = id / per; uint j = id - shell * per;
    float cyc = P / 3.2 + hashS(shell, 11u);
    float ci = floor(cyc); float u = fract(cyc);
    uint s2 = shell * 977u + uint(ci) * 131u;
    vec2 c = vec2(A.x * (0.15 + 0.7 * hashS(s2, 1u)), A.y * (0.15 + 0.4 * hashS(s2, 2u)));
    vec3 col = mix(palette(hashS(s2, 3u)), uC1, 0.15);
    if (u < 0.3) {
      float k = u / 0.3;
      if (j != 0u) { alpha = 0.0; } else { pos = vec2(c.x + sin(k * 9.0) * A.x * 0.004, mix(A.y, c.y, 1.0 - (1.0 - k) * (1.0 - k))); size = vec2(uSize * 0.8); alpha = 1.0; rgb = vec3(1.0, 0.9, 0.7); }
    } else if (j == 0u) { alpha = 0.0; }
    else {
      float a = (u - 0.3) / 0.7;
      float jj = float(j) / float(per);
      float ang = jj * 6.2831 * 2.0 + hashS(s2, 4u) * 6.2831;
      float ring = mod(float(j), 2.0) < 1.0 ? 1.0 : 0.62;
      float sp = (0.7 + 0.3 * hash(j, 8u)) * 0.26 * A.y * ring;
      pos = c + vec2(cos(ang), sin(ang)) * sp * (1.0 - pow(1.0 - a, 2.0)) * 1.6 + vec2(uLean.x * a * A.x * 0.1, A.y * 0.2 * a * a);
      alpha = pow(1.0 - a, 1.6) * (0.65 + 0.35 * sin(P * 24.0 + float(j)));
      size = vec2(uSize * (1.0 - 0.5 * a));
      rgb = col;
    }
  } else if (uKind == 19) {    // ripples
    float rate = 0.3 / (0.5 + h2);
    float cyc = P * rate + h3;
    float age = fract(cyc);
    uint ci = uint(max(0.0, floor(cyc)));
    pos = vec2(hashS(id * 131u + ci * 7u, 1u) * A.x, hashS(id * 131u + ci * 7u, 2u) * A.y);
    size = vec2(uSize * (0.2 + age * 3.5));
    alpha = (1.0 - age) * (1.0 - age) * 0.7;
    shape = 3.0;
  } else if (uKind == 30) {    // scripted burst
    float a = uBurstA.x / uBurstA.y;
    float ang = uBurstB.z < -9.0 ? hashS(id, 41u) * 6.2831 : uBurstB.z + (hashS(id, 41u) - 0.5) * 6.2831 * uBurstB.x;
    float v = (0.25 + 0.75 * hashS(id, 42u)) * uBurstB.y * 0.55 * A.y;
    float ty = uBurstA.x;
    float dist = v * (1.0 - exp(-3.2 * a)) / 3.2 * uBurstA.y;
    pos = vec2(uBurstA.z * A.x, uBurstA.w * A.y) + vec2(cos(ang), sin(ang)) * dist + vec2(uLean.x * A.x * 0.05 * a, 0.5 * 0.22 * A.y * ty * ty);
    alpha = pow(max(0.0, 1.0 - a), 1.5);
    size = vec2(uSize * (0.3 + 0.9 * hashS(id, 43u)) * (1.0 - 0.6 * a));
    shape = uBurstB.w;
    angle = hashS(id, 44u) * 6.2831 + ty * 3.0;
    rgb = uBurstC.x > 0.5 ? palette(hashS(id, 45u)) : mix(uC1, uC2, a);
    if (shape > 1.5 && shape < 2.5) size.y *= 0.45;
  } else if (uKind == 31) {    // flash
    if (id > 0u) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    pos = A * 0.5; size = A * 1.02; shape = 2.0; rgb = uFlash.rgb; alpha = uFlash.a;
  }

  if (uKind < 30 && uTint.a > 0.0) rgb = mix(rgb, uTint.rgb, uTint.a);
  if (uKind == 30 && uTint.a > 0.0) rgb = mix(rgb, uTint.rgb, uTint.a * 0.5);

  // Lo-fi: snap to a grid, force square pixels, freeze time to a low frame rate.
  if (uPixel > 0.0 && uKind < 31) {
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
  else if (vShape < 4.5) a = smoothstep(1.0, 0.0, abs(vLocal.x)) * smoothstep(1.0, 0.2, abs(vLocal.y));
  else if (vShape < 5.5) {                                   // heart
    vec2 q = vec2(vLocal.x * 1.25, -vLocal.y * 1.25 + 0.15);
    float f = pow(q.x * q.x + q.y * q.y - 1.0, 3.0) - q.x * q.x * q.y * q.y * q.y;
    a = 1.0 - smoothstep(-0.02, 0.05, f);
    a *= 0.75 + 0.25 * smoothstep(0.2, -0.6, vLocal.y);
  } else if (vShape < 6.5) {                                 // leaf: pointed ellipse with a vein
    float w = 0.62 * pow(max(0.0, 1.0 - vLocal.y * vLocal.y), 0.7);
    a = smoothstep(w, w - 0.12, abs(vLocal.x)) * step(abs(vLocal.y), 1.0);
    a *= 1.0 - 0.35 * smoothstep(0.07, 0.0, abs(vLocal.x));
  } else if (vShape < 7.5) {                                 // petal: a teardrop
    float t = (vLocal.y * 0.5 + 0.5);
    float w = 0.8 * pow(sin(clamp(t, 0.0, 1.0) * 3.1416), 0.7) * (0.45 + 0.55 * t);
    a = smoothstep(w, w - 0.15, abs(vLocal.x)) * step(abs(vLocal.y), 1.0);
  } else if (vShape < 8.5) a = smoothstep(1.0, 0.9, d) * (0.35 + 0.65 * smoothstep(0.7, 0.95, d));   // bokeh
  else a = smoothstep(1.0, 0.0, abs(vLocal.x)) * pow(clamp((vLocal.y + 1.0) * 0.5, 0.0, 1.0), 2.5);   // trail, bright at the bottom end
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
uniform float uPhase;
uniform float uCell;
uniform vec2 uLean;
uniform float uTurb;
uniform vec4 uTint;
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
  vec2 q = vec2(g.x * 0.28 + uLean.x * y * 2.0, g.y * 0.28 - uPhase * 2.6);
  float n = vnoise(q) * 0.55 + vnoise(q * 2.1 + 7.3) * 0.3 + vnoise(q * 4.3 + 3.1) * 0.15;
  float edge = 1.0 - pow(abs(x - 0.5) * 2.0, 3.0) * 0.55;
  float heat = ((1.0 - y * 1.12) + (n - 0.5) * 0.95 * uTurb) * edge;
  if (heat < 0.1) discard;
  float level = floor(clamp(heat, 0.0, 1.0) * 5.0) / 4.0;  // 0..1 in 5 bands
  vec3 dark = vec3(0.35, 0.02, 0.02);
  vec3 rgb = level < 0.3 ? mix(dark, uC2, level / 0.3) : level < 0.7 ? mix(uC2, uC1, (level - 0.3) / 0.4) : mix(uC1, vec3(1.0), (level - 0.7) / 0.3);
  rgb = mix(rgb, uTint.rgb, uTint.a);
  o = vec4(rgb * uOpacity, uOpacity);
}`;
