import type { ShadowParams, ShadowProgram } from './shadowProgram';

const COMP_VERT = `#version 300 es
uniform mat4 u_matrix;
uniform vec4 u_rect;   // x0, y0, x1, y1 in atlas pixels
out vec2 v_px;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  v_px = mix(u_rect.xy, u_rect.zw, c);
  gl_Position = u_matrix * vec4(v_px, 0.0, 1.0);
}`;

const COMP_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_mask;
uniform vec4 u_region;   // x0, y0, width, height in atlas pixels
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

export type Rect = [x0: number, y0: number, width: number, height: number];

export interface SmoothOptions {
  /** Blur the mask and soften its edge (otherwise: raw, blocky). */
  smooth: boolean;
  /** Blurred-coverage range mapped to alpha 0..1. Centre 0.5 = exact edge; lone pixels (0.25) vanish below ~0.35. */
  edge: [number, number];
}

// Centred on 0.5 so the contour stays exactly on the true shadow edge (a higher centre shortens shadows: measured up to 0.5 m at 10 deg sun).
export const DEFAULT_SMOOTH: SmoothOptions = { smooth: true, edge: [0.35, 0.65] };

/**
 * Shadow mask pipeline: ray-trace a 0/1 mask for a window of the atlas at the data's own resolution,
 * optionally blur it, then composite it on the map with bilinear filtering.
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
  private lastSmooth = true;
  region: Rect = [0, 0, 0, 0];
  texel = 1;

  constructor(
    private gl: WebGL2RenderingContext,
    private program: ShadowProgram,
  ) {
    this.blurProg = build(gl, BLUR_VERT, BLUR_FRAG);
    this.compProg = build(gl, COMP_VERT, COMP_FRAG);
    this.emptyVao = gl.createVertexArray()!;
    this.raw = this.makeTarget();
    this.blurred = this.makeTarget();
  }

  private makeTarget() {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    const fbo = gl.createFramebuffer()!;
    return { tex, fbo };
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

  private keyFor(region: Rect, texel: number, p: ShadowParams, o: SmoothOptions): string {
    return [region.join(','), texel, p.azimuthDeg.toFixed(3), p.altitudeDeg.toFixed(3), p.bias, p.biasRangeM, p.algo, p.lodScale, o.smooth].join('|');
  }

  /** Forget the cached mask so the next `update` recomputes it (used by the stress test). */
  invalidate() {
    this.key = '';
  }

  /** True when `update` would recompute the mask. */
  stale(region: Rect, texel: number, p: ShadowParams, o: SmoothOptions): boolean {
    return this.keyFor(region, texel, p, o) !== this.key;
  }

  /** Recomputes the mask if the window, sun or settings changed. Returns whether it did. */
  update(region: Rect, texel: number, p: ShadowParams, o: SmoothOptions): boolean {
    const key = this.keyFor(region, texel, p, o);
    if (key === this.key) return false;
    const gl = this.gl;
    const [rx, ry, rw, rh] = region;
    const w = Math.round(rw / texel);
    const h = Math.round(rh / texel);

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const wasEnabled = [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST, gl.CULL_FACE].map((c) => gl.isEnabled(c));
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);

    this.resize(w, h);
    gl.viewport(0, 0, w, h);

    // Pass 1: ray-trace the mask. Texel (i, j) is centred on atlas pixel (rx + (i + 0.5) * texel, ry + (j + 0.5) * texel).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.raw.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const m = new Float32Array([2 / rw, 0, 0, 0, 0, 2 / rh, 0, 0, 0, 0, 1, 0, -2 * (rx / rw) - 1, -2 * (ry / rh) - 1, 0, 1]);
    this.program.drawQuad(m, { ...p, mode: 0, maskOnly: 1 });

    // Pass 2: blur.
    if (o.smooth) {
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
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST, gl.CULL_FACE].forEach((c, i) => (wasEnabled[i] ? gl.enable(c) : gl.disable(c)));

    this.region = region;
    this.texel = texel;
    this.key = key;
    this.lastSmooth = o.smooth;
    return true;
  }

  /** Draws the cached mask. `matrix` maps atlas pixels to clip space. */
  composite(matrix: Float32Array, p: ShadowParams, o: SmoothOptions) {
    const gl = this.gl;
    const [rx, ry, rw, rh] = this.region;
    if (!rw || !rh) return;
    const smooth = this.lastSmooth;
    gl.useProgram(this.compProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, smooth ? this.blurred.tex : this.raw.tex);
    const f = smooth ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.uniform1i(gl.getUniformLocation(this.compProg, 'u_mask'), 0);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.compProg, 'u_matrix'), false, matrix);
    gl.uniform4f(gl.getUniformLocation(this.compProg, 'u_rect'), rx, ry, rx + rw, ry + rh);
    gl.uniform4f(gl.getUniformLocation(this.compProg, 'u_region'), rx, ry, rw, rh);
    const al = p.alpha;
    gl.uniform4f(gl.getUniformLocation(this.compProg, 'u_color'), 0.04 * al, 0.07 * al, 0.2 * al, al);
    gl.uniform2f(gl.getUniformLocation(this.compProg, 'u_edge'), smooth ? o.edge[0] : 0.49, smooth ? o.edge[1] : 0.51);
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
