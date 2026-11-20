// JS/WebGL2 renderer (§9). 2D textured quads with transform, color filters,
// Kawase blur, and per-element visual blend. Premultiplied alpha throughout.
//
// Interface used by preview and export:
//   const r = new Renderer(canvas, { width, height, budgetMB });
//   await r.prepare(plan);   // make sure every needed texture is on the GPU (async decode on miss)
//   r.draw(plan);            // synchronous draw into the canvas
//
// `plan` comes from animation.buildPlan().

import { P, defaultFit, fitSize } from './animation.js';
import { visSettings, visAmplitudes, buildVisual, hexToRgb, adjustRgb } from './visualizer.js';
import { fxSettings, FX_KINDS, hexToRgb as fxRgb, PARTICLE_VERT, PARTICLE_FRAG, FIRE_VERT, FIRE_FRAG } from './effects.js';
import { lyricsSettings, activeLines, lineEnd, highlightFraction, placeLine } from './lyrics.js';
import { ensureFont, measureLine, drawLine } from './textcanvas.js';
import { compileFor, scriptFonts } from './script.js';
import { renderVector, vectorSettings, vectorKey } from './vectorlayer.js';
import { frameAt } from './kinetic.js';
import { familyCss, nearestWeight, migrateFont, loadBundled, isBundled } from './fonts.js';

const VERT = `#version 300 es
in vec2 aQ;
uniform vec2 uCanvas;
uniform vec2 uPos;
uniform vec2 uSize;
uniform float uRot;
uniform vec2 uAnchor;
uniform vec2 uMirror;
uniform vec4 uRect;
out vec2 vUV;
void main() {
  vec2 local = (aQ - uAnchor) * uMirror * uSize;
  float c = cos(uRot), s = sin(uRot);
  vec2 p = vec2(c * local.x - s * local.y, s * local.x + c * local.y) + uPos;
  vUV = mix(uRect.xy, uRect.zw, aQ);
  gl_Position = vec4(p.x / uCanvas.x * 2.0 - 1.0, 1.0 - p.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uOpacity;
uniform float uHue;   // radians
uniform float uSat;
uniform float uBri;
uniform float uCon;
out vec4 o;
vec3 hueRotate(vec3 c, float a) {
  vec3 k = vec3(0.57735026);
  float cs = cos(a), sn = sin(a);
  return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
}
void main() {
  vec4 t = texture(uTex, vUV);               // premultiplied
  vec3 rgb = t.a > 0.0 ? t.rgb / t.a : vec3(0.0);
  rgb = hueRotate(rgb, uHue);
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, uSat);
  rgb *= uBri;
  rgb = (rgb - 0.5) * uCon + 0.5;
  rgb = clamp(rgb, 0.0, 1.0);
  float a = t.a * uOpacity;
  o = vec4(rgb * a, a);                      // premultiplied out
}`;

const FS_VERT = `#version 300 es
in vec2 aQ;
out vec2 vUV;
void main() { vUV = aQ; gl_Position = vec4(aQ * 2.0 - 1.0, 0.0, 1.0); }`;

// Kawase: 4 bilinear taps at the corners of a square whose half-size grows per pass.
const KAWASE_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uOffset;
out vec4 o;
void main() {
  vec2 d = (uOffset + 0.5) * uTexel;
  o = 0.25 * (texture(uTex, vUV + vec2(-d.x, -d.y)) + texture(uTex, vUV + vec2(d.x, -d.y)) +
              texture(uTex, vUV + vec2(-d.x,  d.y)) + texture(uTex, vUV + vec2(d.x,  d.y)));
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uOpacity;
out vec4 o;
void main() { o = texture(uTex, vUV) * uOpacity; }`;

const VIS_VERT = `#version 300 es
layout(location = 0) in vec2 aP;
layout(location = 1) in vec4 aC;
uniform vec2 uCanvas;
uniform vec2 uPos;
uniform vec2 uScale;
uniform float uRot;
uniform vec2 uMirror;
out vec4 vC;
void main() {
  vec2 l = aP * uMirror * uScale;
  float c = cos(uRot), s = sin(uRot);
  vec2 p = vec2(c * l.x - s * l.y, s * l.x + c * l.y) + uPos;
  vC = aC;
  gl_Position = vec4(p.x / uCanvas.x * 2.0 - 1.0, 1.0 - p.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

const VIS_FRAG = `#version 300 es
precision highp float;
in vec4 vC;
uniform float uOpacity;
out vec4 o;
void main() { float a = vC.a * uOpacity; o = vec4(vC.rgb * a, a); }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader error: ${gl.getShaderInfoLog(s)}`);
  return s;
}

function program(gl, vs, fs, uniforms) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aQ');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link error: ${gl.getProgramInfoLog(p)}`);
  const u = {};
  for (const n of uniforms) u[n] = gl.getUniformLocation(p, n);
  return { p, u };
}

/** Choose the working scale and Kawase pass count for a blur radius in canvas px (§9.4). */
export function blurPlan(radiusPx) {
  const scale = radiusPx <= 8 ? 1 : radiusPx <= 64 ? 0.5 : 0.25;
  const r = radiusPx * scale;
  const passes = Math.max(1, Math.min(12, Math.ceil(Math.sqrt(2 * r))));
  return { scale, passes };
}

class TextureCache {
  constructor(gl, budgetBytes) {
    this.gl = gl;
    this.budget = budgetBytes;
    this.map = new Map(); // key -> { tex, bytes }   (Map order == LRU order)
    this.used = 0;
  }
  has(key) { return this.map.has(key); }
  touch(key) {
    const e = this.map.get(key);
    if (e) { this.map.delete(key); this.map.set(key, e); }
    return e?.tex ?? null;
  }
  put(key, tex, bytes, pinned) {
    this.map.set(key, { tex, bytes });
    this.used += bytes;
    for (const [k, e] of this.map) {
      if (this.used <= this.budget) break;
      if (k === key || pinned.has(k)) continue; // never evict what this frame needs
      this.gl.deleteTexture(e.tex);
      this.used -= e.bytes;
      this.map.delete(k);
    }
  }
  clear() {
    for (const e of this.map.values()) this.gl.deleteTexture(e.tex);
    this.map.clear();
    this.used = 0;
  }
  /** Drop all textures of one asset (e.g. when an element is removed or replaced). */
  dropPrefix(prefix) {
    for (const [k, e] of this.map) {
      if (k.startsWith(prefix)) { this.gl.deleteTexture(e.tex); this.used -= e.bytes; this.map.delete(k); }
    }
  }
}

export class Renderer {
  constructor(canvas, { width, height, budgetMB = 512 } = {}) {
    this.canvas = canvas;
    this.width = width ?? canvas.width;
    this.height = height ?? canvas.height;
    canvas.width = this.width;
    canvas.height = this.height;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;

    this.elem = program(gl, VERT, FRAG, [
      'uCanvas', 'uPos', 'uSize', 'uRot', 'uAnchor', 'uMirror', 'uRect',
      'uTex', 'uOpacity', 'uHue', 'uSat', 'uBri', 'uCon',
    ]);
    this.kawase = program(gl, FS_VERT, KAWASE_FRAG, ['uTex', 'uTexel', 'uOffset']);
    this.comp = program(gl, FS_VERT, COMPOSITE_FRAG, ['uTex', 'uOpacity']);
    this.visProg = program(gl, VIS_VERT, VIS_FRAG, ['uCanvas', 'uPos', 'uScale', 'uRot', 'uMirror', 'uOpacity']);
    this.fxProg = program(gl, PARTICLE_VERT, PARTICLE_FRAG, [
      'uCanvas', 'uCenter', 'uArea', 'uTime', 'uKind', 'uCount', 'uDensity', 'uSize', 'uSpeed', 'uWind',
      'uSeed', 'uC1', 'uC2', 'uRot', 'uPixel', 'uOpacity', 'uGlow']);
    this.fireProg = program(gl, FIRE_VERT, FIRE_FRAG, [
      'uCanvas', 'uCenter', 'uArea', 'uRot', 'uTime', 'uCell', 'uSpeed', 'uWind', 'uSeed', 'uC1', 'uC2', 'uOpacity']);

    // Unit quad as a triangle strip.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // dynamic geometry for visualizers
    this.visVao = gl.createVertexArray();
    gl.bindVertexArray(this.visVao);
    this.visBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.visBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.bindVertexArray(this.vao);

    this.audio = null;        // { fps, spectrum(src, bands), pcm(src) } supplied by the app
    this.avoid = [];          // normalised rects lyrics should keep clear of
    this.textTex = new Map(); // text raster cache (LRU by insertion order)
    this.textMeasure = new Map();
    this.textures = new TextureCache(gl, budgetMB * 1024 * 1024);
    this.fboTiers = new Map(); // scale -> { w, h, a:{fbo,tex}, b:{fbo,tex} }
    this.nearest = new Set(); // asset ids sampled with NEAREST
  }

  get usage() { return { used: this.textures.used, budget: this.textures.budget }; }
  setBudgetMB(mb) { this.textures.budget = mb * 1024 * 1024; }

  setSize(width, height) {
    this.width = width; this.height = height;
    this.canvas.width = width; this.canvas.height = height;
    this._freeFbos();
  }

  _freeFbos() {
    const gl = this.gl;
    for (const t of this.fboTiers.values()) {
      for (const s of [t.a, t.b]) { gl.deleteFramebuffer(s.fbo); gl.deleteTexture(s.tex); }
    }
    this.fboTiers.clear();
  }

  _makeTarget(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fbo, tex };
  }

  _tier(scale) {
    let t = this.fboTiers.get(scale);
    if (!t) {
      const w = Math.max(1, Math.round(this.width * scale));
      const h = Math.max(1, Math.round(this.height * scale));
      t = { w, h, a: this._makeTarget(w, h), b: this._makeTarget(w, h) };
      this.fboTiers.set(scale, t);
    }
    return t;
  }

  // ---------- textures ----------

  static key(asset, texIdx) { return `${asset.def.id}#${texIdx}`; }

  /** Ensure every texture needed by `plan` is on the GPU. Async only on a cache miss. */
  async prepare(plan) {
    const pinned = new Set();
    for (const it of plan) if (it.kind === 'lyrics') await this._prepareLyrics(it);
    for (const it of plan) if (it.kind === 'script') await this._prepareScript(it);
    for (const it of plan) if (it.kind === 'vector') await this._prepareVector(it);
    plan = plan.filter((it) => it.kind === 'image');
    for (const it of plan) {
      pinned.add(Renderer.key(it.asset, it.asset.textureIndex(it.frameA)));
      if (it.frameB != null) pinned.add(Renderer.key(it.asset, it.asset.textureIndex(it.frameB)));
    }
    for (const it of plan) {
      for (const f of it.frameB != null ? [it.frameA, it.frameB] : [it.frameA]) {
        const ti = it.asset.textureIndex(f);
        const key = Renderer.key(it.asset, ti);
        if (this.textures.has(key)) { this.textures.touch(key); continue; }
        const src = await it.asset.textureSource(ti);
        this._upload(key, it.asset, ti, src, pinned);
      }
    }
  }

  _upload(key, asset, texIdx, src, pinned) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    let w; let h;
    if (src.image) {
      // ImageBitmaps were created premultiplied.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      w = src.image.width; h = src.image.height;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src.image);
      src.image.close?.();
    } else {
      // Straight-alpha RGBA (GIF): let GL premultiply.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      w = src.width; h = src.height;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.data);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    const filter = asset.def.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.put(key, tex, w * h * 4, pinned);
  }

  dropAsset(id) { this.textures.dropPrefix(`${id}#`); }

  // ---------- drawing ----------

  draw(plan) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);

    for (const it of plan) {
      const blur = it.props[P.blur];
      if (blur > 0.25) this._drawBlurred(it, blur);
      else {
        this._setBlend(it.visualBlend);
        this._drawLayer(it);
      }
    }
  }

  _drawLayer(it) {
    switch (it.kind) {
      case 'visualizer': this._drawVisualizer(it); break;
      case 'effect': this._drawEffect(it); break;
      case 'lyrics': this._drawLyrics(it); break;
      case 'script': this._drawScript(it); break;
      case 'vector': this._drawVector(it); break;
      default: this._drawElement(it, 1);
    }
    this.gl.bindVertexArray(this.vao);
  }

  _setBlend(mode) {
    const gl = this.gl;
    if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
    else if (mode === 'screen') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else if (mode === 'multiply') gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied "over"
  }

  /** Draw the element quad(s) into the currently bound target. */
  _drawElement(it, opacityScale) {
    const gl = this.gl;
    const { asset, props } = it;
    const def = asset.def;
    const [bw, bh] = fitSize(defaultFit(def), asset.width, asset.height, this.width, this.height);
    const sc = props[P.scale];
    const u = this.elem.u;

    gl.useProgram(this.elem.p);
    gl.uniform2f(u.uCanvas, this.width, this.height);
    gl.uniform2f(u.uPos, props[P.positionX] * this.width, props[P.positionY] * this.height);
    gl.uniform2f(u.uSize, bw * sc * props[P.scaleX], bh * sc * props[P.scaleY]);
    gl.uniform1f(u.uRot, props[P.rotation]);
    gl.uniform2f(u.uAnchor, props[P.anchorX], props[P.anchorY]);
    gl.uniform2f(u.uMirror, props[P.mirrorX] >= 0.5 ? -1 : 1, props[P.mirrorY] >= 0.5 ? -1 : 1);
    gl.uniform1f(u.uHue, (props[P.hueShift] * Math.PI) / 180);
    gl.uniform1f(u.uSat, props[P.saturation]);
    gl.uniform1f(u.uBri, props[P.brightness]);
    gl.uniform1f(u.uCon, props[P.contrast]);
    gl.uniform1i(u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);

    const passes = it.frameB != null
      ? [[it.frameA, 1], [it.frameB, it.mix]] // crossfade (§4.7): alpha-blend A then B
      : [[it.frameA, 1]];
    for (const [frame, w] of passes) {
      const tex = this.textures.touch(Renderer.key(asset, asset.textureIndex(frame)));
      if (!tex) continue; // not prepared; skip rather than draw garbage
      const r = asset.uvRect(frame);
      gl.uniform4f(u.uRect, r[0], r[1], r[2], r[3]);
      gl.uniform1f(u.uOpacity, props[P.opacity] * w * opacityScale);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  _drawBlurred(it, radius) {
    const gl = this.gl;
    const { scale, passes } = blurPlan(radius);
    const tier = this._tier(scale);

    // 1. Render the element (colour-adjusted, opacity 1) into target A at working res.
    gl.bindFramebuffer(gl.FRAMEBUFFER, tier.a.fbo);
    gl.viewport(0, 0, tier.w, tier.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const saved = it.props[P.opacity];
    it.props[P.opacity] = 1;
    this._drawLayer(it);
    it.props[P.opacity] = saved;

    // 2. Kawase ping-pong.
    gl.disable(gl.BLEND);
    gl.useProgram(this.kawase.p);
    gl.uniform1i(this.kawase.u.uTex, 0);
    gl.uniform2f(this.kawase.u.uTexel, 1 / tier.w, 1 / tier.h);
    let src = tier.a;
    let dst = tier.b;
    for (let i = 0; i < passes; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, tier.w, tier.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1f(this.kawase.u.uOffset, i);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      [src, dst] = [dst, src];
    }

    // 3. Composite (upsampled by the linear filter) with opacity + visual blend.
    gl.enable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    this._setBlend(it.visualBlend);
    gl.useProgram(this.comp.p);
    gl.uniform1i(this.comp.u.uTex, 0);
    gl.uniform1f(this.comp.u.uOpacity, saved);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---------- generated layers ----------

  _drawVisualizer(it) {
    const gl = this.gl;
    const { props, asset } = it;
    const vis = visSettings(asset.def);
    const fps = this.audio?.fps ?? 30;
    const amps = visAmplitudes(vis, {
      spec: this.audio?.spectrum(vis.source, vis.bands) ?? null,
      pcm: this.audio?.pcm(vis.source) ?? null,
      fps, frame: it.frame,
    });
    const adj = (hex) => adjustRgb(hexToRgb(hex), props[P.hueShift], props[P.saturation], props[P.brightness], props[P.contrast]);
    const geo = buildVisual(vis, amps, {
      minDim: Math.min(this.width, this.height), time: it.time,
      colors: [adj(vis.color1), adj(vis.color2)], intensity: props[P.intensity],
    });
    if (!geo.vertexCount) return;
    const inter = new Float32Array(geo.vertexCount * 6);
    for (let i = 0; i < geo.vertexCount; i++) {
      inter[i * 6] = geo.pos[i * 2]; inter[i * 6 + 1] = geo.pos[i * 2 + 1];
      inter.set(geo.col.subarray(i * 4, i * 4 + 4), i * 6 + 2);
    }
    const { p, u } = this.visProg;
    gl.useProgram(p);
    gl.uniform2f(u.uCanvas, this.width, this.height);
    gl.uniform2f(u.uPos, props[P.positionX] * this.width, props[P.positionY] * this.height);
    const sc = props[P.scale];
    gl.uniform2f(u.uScale, sc * props[P.scaleX], sc * props[P.scaleY]);
    gl.uniform1f(u.uRot, props[P.rotation]);
    gl.uniform2f(u.uMirror, props[P.mirrorX] >= 0.5 ? -1 : 1, props[P.mirrorY] >= 0.5 ? -1 : 1);
    gl.uniform1f(u.uOpacity, props[P.opacity]);
    gl.bindVertexArray(this.visVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.visBuf);
    gl.bufferData(gl.ARRAY_BUFFER, inter, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, geo.vertexCount);
  }

  _drawEffect(it) {
    const gl = this.gl;
    const { props, asset } = it;
    const fx = fxSettings(asset.def);
    const kind = FX_KINDS[fx.kind];
    const minDim = Math.min(this.width, this.height);
    const sc = props[P.scale];
    const area = [fx.area[0] * this.width * sc * props[P.scaleX], fx.area[1] * this.height * sc * props[P.scaleY]];
    const adj = (hex) => adjustRgb(fxRgb(hex), props[P.hueShift], props[P.saturation], props[P.brightness], props[P.contrast]);
    const c1 = adj(fx.c1); const c2 = adj(fx.c2);
    const pixelPx = fx.pixel > 0 || fx.kind === 'pixelFire' ? Math.max(1, Math.round((fx.pixel || fx.size) * (minDim / 1080))) : 0;
    const t = pixelPx > 0 ? Math.floor(it.time * fx.fps) / fx.fps : it.time;
    const sizePx = fx.size * (minDim / 1080);
    const cx = props[P.positionX] * this.width; const cy = props[P.positionY] * this.height;
    const density = Math.min(1, props[P.intensity]);
    const glow = Math.max(1, props[P.intensity]);
    if (fx.kind === 'pixelFire') {
      const { p, u } = this.fireProg;
      gl.useProgram(p);
      gl.uniform2f(u.uCanvas, this.width, this.height);
      gl.uniform2f(u.uCenter, cx, cy);
      gl.uniform2f(u.uArea, area[0], area[1]);
      gl.uniform1f(u.uRot, props[P.rotation]);
      gl.uniform1f(u.uTime, t);
      gl.uniform1f(u.uCell, pixelPx);
      gl.uniform1f(u.uSpeed, fx.speed);
      gl.uniform1f(u.uWind, fx.wind);
      gl.uniform1ui(u.uSeed, fx.seed >>> 0);
      gl.uniform3fv(u.uC1, c1); gl.uniform3fv(u.uC2, c2);
      gl.uniform1f(u.uOpacity, props[P.opacity]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }
    const { p, u } = this.fxProg;
    gl.useProgram(p);
    gl.uniform2f(u.uCanvas, this.width, this.height);
    gl.uniform2f(u.uCenter, cx, cy);
    gl.uniform2f(u.uArea, area[0], area[1]);
    gl.uniform1f(u.uTime, t);
    gl.uniform1i(u.uKind, kind.id);
    gl.uniform1i(u.uCount, fx.count);
    gl.uniform1f(u.uDensity, density);
    gl.uniform1f(u.uSize, sizePx);
    gl.uniform1f(u.uSpeed, fx.speed);
    gl.uniform1f(u.uWind, fx.wind);
    gl.uniform1ui(u.uSeed, fx.seed >>> 0);
    gl.uniform3fv(u.uC1, c1); gl.uniform3fv(u.uC2, c2);
    gl.uniform1f(u.uRot, props[P.rotation]);
    gl.uniform1f(u.uPixel, pixelPx);
    gl.uniform1f(u.uOpacity, props[P.opacity]);
    gl.uniform1f(u.uGlow, glow);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, fx.count);
  }

  // ---------- script (kinetic text) ----------

  async _prepareScript(it) {
    const def = it.asset.def;
    const total = this.duration ?? 60;
    for (const f of scriptFonts(def)) {
      const m = migrateFont(f);
      if (isBundled(m)) await loadBundled(m).catch(() => {});
      if (document.fonts) for (const w of [400, 700, 800]) await document.fonts.load(`${nearestWeight(m, w)} 40px ${familyCss(m)}`, 'Aa').catch(() => []);
    }
    const c = compileFor(def, this.width, this.height, total);
    let pulse = 0;
    try {
      const sp = this.audio?.spectrum('master', 4);
      if (sp && sp.length) pulse = Math.min(1, Math.max(0, (sp[0] + (sp[1] ?? 0)) / 2));
    } catch { /* no audio */ }
    const f = frameAt(c, it.time, { pulse: pulse * (def.script?.pulse ?? 1) });
    for (const pass of f.passes) for (const r of pass.runs) {
      const px = Math.max(8, Math.round(r.size));
      const sh = r.shadow ? Math.round(r.shadow * 10) / 10 : 0;
      const sk = r.st ? `${r.st.i ? 'i' : ''}${r.st.u ? 'u' : ''}${r.st.s ? 's' : ''}` : '';
      r.key = `scr|${r.text}|${r.font}|${r.weight}|${r.color}|${px}|${sh}|${sk}`;
      if (this.textTex.has(r.key)) { const e = this.textTex.get(r.key); this.textTex.delete(r.key); this.textTex.set(r.key, e); continue; }
      const font = migrateFont(r.font);
      const g = document.createElement('canvas').getContext('2d');
      const css = `${r.st?.i ? 'italic ' : ''}${nearestWeight(font, r.weight)} ${px}px ${familyCss(font)}`;
      g.font = css;
      const pad = Math.ceil(px * (0.2 + 0.35 * sh));
      const w = Math.ceil(g.measureText(r.text).width + pad * 2); const h = Math.ceil(px * 1.3 + pad * 2);
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const k = cv.getContext('2d'); k.font = css; k.textAlign = 'center'; k.textBaseline = 'middle'; k.fillStyle = r.color;
      if (sh > 0) { k.shadowColor = 'rgba(0,0,0,0.75)'; k.shadowBlur = px * 0.22 * sh + 1; k.shadowOffsetY = px * 0.05 * sh; }
      k.fillText(r.text, w / 2, h / 2 + px * 0.04);
      if (sh > 0.3) k.fillText(r.text, w / 2, h / 2 + px * 0.04);
      if (r.st?.u || r.st?.s) {   // underline / strike-through, drawn as rules so they match the glyph colour and weight
        const tw = g.measureText(r.text).width; const th = Math.max(1, px * 0.06);
        k.shadowColor = 'transparent';
        if (r.st.u) k.fillRect(w / 2 - tw / 2, h / 2 + px * 0.36, tw, th);
        if (r.st.s) k.fillRect(w / 2 - tw / 2, h / 2 - th / 2 + px * 0.04, tw, th);
      }
      this._uploadText(r.key, cv);
    }
    it.scr = f;
  }

  _drawScript(it) {
    if (!it.scr) return;
    const gl = this.gl; const { props } = it;
    const vp = gl.getParameter(gl.VIEWPORT); const k = vp[2] / this.width;
    // placement: the whole script block can be moved / scaled / rotated like any other layer
    const W = this.width; const H = this.height; const cx = W / 2; const cy = H / 2;
    const tx = (props[P.positionX] - 0.5) * W; const ty = (props[P.positionY] - 0.5) * H;
    const ssx = props[P.scale] * props[P.scaleX]; const ssy = props[P.scale] * props[P.scaleY];
    const rot = props[P.rotation]; const cr = Math.cos(rot); const sr = Math.sin(rot);
    const ident = tx === 0 && ty === 0 && ssx === 1 && ssy === 1 && rot === 0;
    const xf = (x, y) => { const dx = (x - cx) * ssx; const dy = (y - cy) * ssy; return [cx + tx + cr * dx - sr * dy, cy + ty + sr * dx + cr * dy]; };
    for (const pass of it.scr.passes) {
      const rects = ident ? pass.scissors : (rot === 0 ? pass.scissors?.map(([x0, y0, x1, y1]) => { const a = xf(x0, y0); const b = xf(x1, y1); return [a[0], a[1], b[0], b[1]]; }) : null);
      const run = () => {
        const g = pass.geo;
        if (g.n) {
          const inter = new Float32Array(g.n * 6);
          for (let i = 0; i < g.n; i++) { const [px, py] = ident ? [g.pos[i * 2], g.pos[i * 2 + 1]] : xf(g.pos[i * 2], g.pos[i * 2 + 1]); inter[i * 6] = px; inter[i * 6 + 1] = py; inter.set(g.col.subarray(i * 4, i * 4 + 4), i * 6 + 2); }
          const { p, u } = this.visProg;
          gl.useProgram(p);
          gl.uniform2f(u.uCanvas, this.width, this.height);
          gl.uniform2f(u.uPos, 0, 0); gl.uniform2f(u.uScale, 1, 1); gl.uniform1f(u.uRot, 0); gl.uniform2f(u.uMirror, 1, 1);
          gl.uniform1f(u.uOpacity, props[P.opacity]);
          gl.bindVertexArray(this.visVao);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.visBuf);
          gl.bufferData(gl.ARRAY_BUFFER, inter, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.TRIANGLES, 0, g.n);
          gl.bindVertexArray(this.vao);
        }
        for (const r of pass.runs) {
          const e = this.textTex.get(r.key); if (!e || r.alpha <= 0.001) continue;
          const sc = r.size / Math.max(8, Math.round(r.size));
          const [qx, qy] = ident ? [r.x, r.y] : xf(r.x, r.y);
          this._quad(e.tex, 1, r.clip, qx, qy, e.w * sc * r.sx * ssx, e.h * sc * r.sy * ssy, r.rot + rot, props, props[P.opacity] * r.alpha);
        }
      };
      if (rects) {
        gl.enable(gl.SCISSOR_TEST);
        for (const [x0, y0, x1, y1] of rects) {
          if (x1 <= x0 || y1 <= y0) continue;
          gl.scissor(Math.floor(x0 * k), Math.floor((this.height - y1) * k), Math.ceil((x1 - x0) * k), Math.ceil((y1 - y0) * k));
          run();
        }
        gl.disable(gl.SCISSOR_TEST);
      } else run();
    }
  }

  // ---------- shape / chart / table layers ----------

  async _prepareVector(it) {
    const def = it.asset.def;
    const st = vectorSettings(def);
    if (document.fonts) { const f = migrateFont(st.font || 'Inter'); if (isBundled(f)) await loadBundled(f).catch(() => {}); for (const w of [400, 700]) await document.fonts.load(`${nearestWeight(f, w)} 24px ${familyCss(f)}`, 'Aa').catch(() => []); }
    const step = def.type === 'shape' ? 20 : 40;
    const prog = Math.round(Math.max(0, Math.min(1, it.props[P.intensity])) * step) / step;
    const key = vectorKey(def, this.width, this.height, prog);
    if (!this.textTex.has(key)) {
      if (prog <= 0) { it.vec = null; return; }
      const r = renderVector(def, this.width, this.height, prog);
      this._uploadText(key, r.canvas);
      this.textTex.get(key).pad = r.pad;
    } else { const e = this.textTex.get(key); this.textTex.delete(key); this.textTex.set(key, e); }
    it.vec = key;
  }

  _drawVector(it) {
    const e = it.vec && this.textTex.get(it.vec); if (!e) return;
    const { props } = it;
    const W = this.width; const H = this.height;
    const cx = props[P.positionX] * W; const cy = props[P.positionY] * H;
    const sx = props[P.scale] * props[P.scaleX] * (props[P.mirrorX] >= 0.5 ? -1 : 1); const sy = props[P.scale] * props[P.scaleY] * (props[P.mirrorY] >= 0.5 ? -1 : 1);
    this._quad(e.tex, 1, 1, cx, cy, e.w * sx, e.h * sy, props[P.rotation], props, props[P.opacity]);
  }

  // ---------- lyrics ----------

  _textKey(def, lyr, i, hi) {
    const s = lyr.style;
    return `${def.id}|${i}|${this.height}|${this.width}|${hi ? 1 : 0}|${lyr.lines[i].text}|${s.font}|${s.size}|${s.weight}|${s.italic}|${s.color}|${s.hiColor}|${s.outline}|${s.outlineColor}|${s.shadow}|${s.align}|${s.maxWidth}`;
  }

  _uploadText(key, canvas) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textTex.set(key, { tex, w: canvas.width, h: canvas.height });
    while (this.textTex.size > 96) {
      const [k, e] = this.textTex.entries().next().value;
      gl.deleteTexture(e.tex); this.textTex.delete(k);
    }
  }

  async _prepareLyrics(it) {
    const def = it.asset.def;
    const lyr = lyricsSettings(def);
    await ensureFont(lyr.style, this.height);
    const active = activeLines(lyr, it.time);
    for (const a of active) {
      for (const hi of lyr.style.karaoke !== 'off' ? [false, true] : [false]) {
        const key = this._textKey(def, lyr, a.i, hi);
        if (this.textTex.has(key)) { const e = this.textTex.get(key); this.textTex.delete(key); this.textTex.set(key, e); continue; }
        const mkey = key.replace('|1|', '|0|');
        let m = this.textMeasure.get(mkey);
        if (!m) {
          m = measureLine(lyr.lines[a.i].text, lyr.style, this.height, this.width);
          this.textMeasure.set(mkey, m);
          if (this.textMeasure.size > 400) this.textMeasure.delete(this.textMeasure.keys().next().value);
        }
        this._uploadText(key, drawLine(m, lyr.style, hi));
      }
    }
    it.lyr = { lyr, active };
  }

  _drawLyrics(it) {
    if (!it.lyr) return;
    const { props, asset } = it;
    const def = asset.def;
    const { lyr, active } = it.lyr;
    const W = this.width; const H = this.height;
    const sc = props[P.scale] * props[P.scaleX];
    for (const a of active) {
      const base = this.textTex.get(this._textKey(def, lyr, a.i, false));
      if (!base) continue;
      const place = placeLine(lyr.layout, a.i, { w: base.w / W, h: base.h / H }, this.avoid);
      const pos = a.line.pos ?? place;
      const cx = (pos.x + (props[P.positionX] - 0.5)) * W + a.dx * base.h;
      const cy = (pos.y + (props[P.positionY] - 0.5)) * H + a.dy * base.h * 0.6;
      const rot = props[P.rotation] + ((place.tilt ?? 0) * Math.PI) / 180;
      const w = base.w * sc * a.scale; const h = base.h * props[P.scale] * props[P.scaleY] * a.scale;
      const op = props[P.opacity] * a.alpha;
      const end = lineEnd(lyr.lines, a.i);
      const fill = highlightFraction(a.line, it.time, end, lyr.style.karaoke);
      this._quad(base.tex, 1, a.reveal, cx, cy, w, h, rot, props, op);
      if (fill > 0 && lyr.style.karaoke !== 'off') {
        const hi = this.textTex.get(this._textKey(def, lyr, a.i, true));
        if (hi) this._quad(hi.tex, 1, Math.min(fill, a.reveal), cx, cy, w, h, rot, props, op);
      }
    }
  }

  /** Draw a texture clipped to its left `frac` fraction, centred on (cx, cy) before clipping. */
  _quad(tex, _unused, frac, cx, cy, w, h, rot, props, opacity) {
    if (frac <= 0) return;
    const gl = this.gl;
    const u = this.elem.u;
    const c = Math.cos(rot); const s = Math.sin(rot);
    const off = -(w * (1 - frac)) / 2;
    gl.useProgram(this.elem.p);
    gl.uniform2f(u.uCanvas, this.width, this.height);
    gl.uniform2f(u.uPos, cx + c * off, cy + s * off);
    gl.uniform2f(u.uSize, w * frac, h);
    gl.uniform1f(u.uRot, rot);
    gl.uniform2f(u.uAnchor, 0.5, 0.5);
    gl.uniform2f(u.uMirror, 1, 1);
    gl.uniform4f(u.uRect, 0, 0, frac, 1);
    gl.uniform1f(u.uHue, (props[P.hueShift] * Math.PI) / 180);
    gl.uniform1f(u.uSat, props[P.saturation]);
    gl.uniform1f(u.uBri, props[P.brightness]);
    gl.uniform1f(u.uCon, props[P.contrast]);
    gl.uniform1f(u.uOpacity, opacity);
    gl.uniform1i(u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    for (const e of this.textTex.values()) this.gl.deleteTexture(e.tex);
    this.textTex.clear();
    this.textures.clear();
    this._freeFbos();
  }
}
