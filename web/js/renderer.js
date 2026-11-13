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

    // Unit quad as a triangle strip.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

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
        this._drawElement(it, 1);
      }
    }
  }

  _setBlend(mode) {
    const gl = this.gl;
    if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
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
    this._drawElement(it, 1);
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

  dispose() {
    this.textures.clear();
    this._freeFbos();
  }
}
