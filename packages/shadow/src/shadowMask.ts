import type { ShadowParams, ShadowProgram } from './shadowProgram.ts';
import type { HeightWindow } from './heightWindow.ts';

const COMP_VERT = `#version 300 es
uniform mat4 u_matrix;
uniform vec4 u_rect;   // x0, y0, x1, y1 in window pixels
out vec2 v_px;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  v_px = mix(u_rect.xy, u_rect.zw, c);
  gl_Position = u_matrix * vec4(v_px, 0.0, 1.0);
}`;

const COMP_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_mask;
uniform vec4 u_region;   // x0, y0, width, height in window pixels
uniform vec4 u_color;    // premultiplied shadow colour
uniform vec2 u_edge;     // coverage thresholds
in vec2 v_px;
out vec4 outColor;
void main() {
  vec2 uv = (v_px - u_region.xy) / u_region.zw;
  float m = texture(u_mask, uv).r;
  outColor = u_color * smoothstep(u_edge.x, u_edge.y, m);
}`;

const BLUR_VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// 3x3 binomial blur: a lone lit pixel becomes 0.25 and a 1-pixel line 0.5, so a higher threshold removes them.
const BLUR_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform ivec2 u_size;
out vec4 outColor;
float at(ivec2 p) { return texelFetch(u_src, clamp(p, ivec2(0), u_size - 1), 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float s = 4.0 * at(p)
    + 2.0 * (at(p + ivec2(1, 0)) + at(p - ivec2(1, 0)) + at(p + ivec2(0, 1)) + at(p - ivec2(0, 1)))
    + (at(p + ivec2(1, 1)) + at(p + ivec2(-1, 1)) + at(p + ivec2(1, -1)) + at(p + ivec2(-1, -1)));
  outColor = vec4(vec3(s / 16.0), 1.0);
}`;

function build(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const make = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error');
    return sh;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

/** A rectangle of the window in window pixels. */
export type Rect = [x0: number, y0: number, width: number, height: number];

/** Blurred-coverage range mapped to alpha 0..1. Centred on 0.5 so the contour stays on the true edge (spike S1). */
export const EDGE: [number, number] = [0.35, 0.65];

/**
 * Shadow mask pipeline: ray-trace a 0/1 mask for a region of the window at the data's own resolution, blur it, then
 * composite it on the map with bilinear filtering. The result is cached until the sun, the view or the data changes.
 */
export class ShadowMask {
  private raw: { tex: WebGLTexture; fbo: WebGLFramebuffer };
  private blurred: { tex: WebGLTexture; fbo: WebGLFramebuffer };
  private width = 0;
  private height = 0;
  private blurProg: WebGLProgram;
  private compProg: WebGLProgram;
  private emptyVao: WebGLVertexArrayObject;
  private key = '';
  /** Region and sampling of the cached mask, in window pixels. */
  region: Rect = [0, 0, 0, 0];
  texel = 1;
  /** Window origin and data epoch the cached mask was computed for. */
  origin: [number, number] | null = null;
  epoch = -1;

  constructor(
    private gl: WebGL2RenderingContext,
    private program: ShadowProgram,
  ) {
    this.blurProg = build(gl, BLUR_VERT, BLUR_FRAG);
    this.compProg = build(gl, COMP_VERT, COMP_FRAG);
    this.emptyVao = gl.createVertexArray()!;
    this.raw = { tex: gl.createTexture()!, fbo: gl.createFramebuffer()! };
    this.blurred = { tex: gl.createTexture()!, fbo: gl.createFramebuffer()! };
  }

  get size(): [number, number] {
    return [this.width, this.height];
  }

  private resize(w: number, h: number) {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    for (const t of [this.raw, this.blurred]) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    }
    this.width = w;
    this.height = h;
  }

  private keyFor(win: HeightWindow, region: Rect, texel: number, p: ShadowParams): string {
    return [win.epoch, region.join(','), texel, p.azimuthDeg.toFixed(3), p.altitudeDeg.toFixed(3), p.bias, p.biasRangeM, p.maxIter].join('|');
  }

  /** True when `update` would recompute the mask. */
  stale(win: HeightWindow, region: Rect, texel: number, p: ShadowParams): boolean {
    return this.keyFor(win, region, texel, p) !== this.key;
  }

  /** Recomputes the mask if the region, sun or data changed. Returns whether it did. */
  update(win: HeightWindow, region: Rect, texel: number, p: ShadowParams): boolean {
    const key = this.keyFor(win, region, texel, p);
    if (key === this.key) return false;
    const gl = this.gl;
    const [rx, ry, rw, rh] = region;
    const w = Math.max(1, Math.round(rw / texel));
    const h = Math.max(1, Math.round(rh / texel));

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const prevTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const toggles = [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST, gl.CULL_FACE];
    const wasEnabled = toggles.map((c) => gl.isEnabled(c));
    for (const c of toggles) gl.disable(c);

    this.resize(w, h);
    gl.viewport(0, 0, w, h);

    // Pass 1: ray-trace. Texel (i, j) is centred on window pixel (rx + (i + 0.5) * texel, ry + (j + 0.5) * texel).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.raw.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const m = new Float32Array([2 / rw, 0, 0, 0, 0, 2 / rh, 0, 0, 0, 0, 1, 0, -2 * (rx / rw) - 1, -2 * (ry / rh) - 1, 0, 1]);
    this.program.drawMask(m, p, win);

    // Pass 2: blur.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurred.fbo);
    gl.useProgram(this.blurProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.raw.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(gl.getUniformLocation(this.blurProg, 'u_src'), 0);
    gl.uniform2i(gl.getUniformLocation(this.blurProg, 'u_size'), w, h);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);
    gl.bindTexture(gl.TEXTURE_2D, prevTexture);
    toggles.forEach((c, i) => (wasEnabled[i] ? gl.enable(c) : gl.disable(c)));

    this.region = region;
    this.texel = texel;
    this.key = key;
    this.origin = win.origin;
    this.epoch = win.epoch;
    return true;
  }

  /** Test helper: the raw (unblurred) 0/1 mask as one byte per texel. Reading data back is fine for tests, never for decoding data. */
  debugReadRaw(): Uint8Array {
    const gl = this.gl;
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.raw.fbo);
    const rgba = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    const out = new Uint8Array(this.width * this.height);
    for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4]! > 127 ? 1 : 0;
    return out;
  }

  /** Draws the cached mask. `matrix` maps window pixels to clip space. */
  composite(matrix: Float32Array, alpha: number) {
    const gl = this.gl;
    const [rx, ry, rw, rh] = this.region;
    if (!rw || !rh) return;
    gl.useProgram(this.compProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.blurred.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(this.compProg, 'u_mask'), 0);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.compProg, 'u_matrix'), false, matrix);
    gl.uniform4f(gl.getUniformLocation(this.compProg, 'u_rect'), rx, ry, rx + rw, ry + rh);
    gl.uniform4f(gl.getUniformLocation(this.compProg, 'u_region'), rx, ry, rw, rh);
    gl.uniform4f(gl.getUniformLocation(this.compProg, 'u_color'), 0.04 * alpha, 0.07 * alpha, 0.2 * alpha, alpha);
    gl.uniform2f(gl.getUniformLocation(this.compProg, 'u_edge'), EDGE[0], EDGE[1]);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    for (const t of [this.raw, this.blurred]) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    gl.deleteProgram(this.blurProg);
    gl.deleteProgram(this.compProg);
    gl.deleteVertexArray(this.emptyVao);
  }
}
