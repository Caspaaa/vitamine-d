import { MAX_LOD } from './tiles.ts';
import type { HeightWindow } from './heightWindow.ts';
import { WINDOW_PX } from './window.ts';

export interface ShadowParams {
  /** Compass bearing of the sun, degrees clockwise from north. */
  azimuthDeg: number;
  /** Refraction-corrected sun altitude in degrees (<= 0: night, everything is in shade). */
  altitudeDeg: number;
  /** Height tolerance (quantised units) that absorbs LiDAR noise; it fades out over `biasRangeM` so real shadows stay exact. */
  bias: number;
  /** Distance in metres over which the tolerance fades to zero. */
  biasRangeM: number;
  /** Ray-traversal step budget per pixel. */
  maxIter: number;
  /** Opacity of the shadow overlay. */
  alpha: number;
}

export const DEFAULT_PARAMS: ShadowParams = {
  azimuthDeg: 180,
  altitudeDeg: 30,
  bias: 2,
  biasRangeM: 6,
  maxIter: 192,
  alpha: 0.5,
};

const VERT = `#version 300 es
in vec2 a_px;
uniform mat4 u_matrix;
out vec2 v_px;
void main() {
  v_px = a_px;
  gl_Position = u_matrix * vec4(a_px, 0.0, 1.0);
}`;

// Exact hierarchical traversal (spike S1) over a ring-buffer window. v_px and all cell indices are relative to the
// window's north-west corner; u_origin (world pixels, a multiple of 256) turns them into ring-buffer slots.
const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D u_height;
uniform vec2 u_dir;         // unit vector in pixel space (+x east, +y south) pointing toward the sun
uniform float u_rise;       // quantised height units gained per pixel travelled along the ray
uniform float u_maxValue;   // highest quantised height in the window
uniform float u_bias;
uniform float u_biasRange;  // pixels
uniform ivec2 u_origin;     // world pixel of the window's north-west corner
uniform int u_maxIter;

const int SIZE = ${WINDOW_PX};
const int MAX_LOD = ${MAX_LOD};

in vec2 v_px;
out vec4 outColor;

ivec2 slot(ivec2 cell, int lod) {
  return (cell + (u_origin >> lod)) & ivec2((SIZE >> lod) - 1);
}

// Move q along u_dir to just inside the next cell of size cs. The coordinate of the crossed axis is snapped past the
// boundary: nudging along the ray is not enough for near axis-aligned rays, where the step in the minor axis falls
// below float32 resolution and the ray would get stuck on the boundary.
vec2 nextCell(vec2 q, float cs) {
  vec2 cell = floor(q / cs) * cs;
  float tx = u_dir.x > 0.0 ? (cell.x + cs - q.x) / u_dir.x : (u_dir.x < 0.0 ? (cell.x - q.x) / u_dir.x : 1e9);
  float ty = u_dir.y > 0.0 ? (cell.y + cs - q.y) / u_dir.y : (u_dir.y < 0.0 ? (cell.y - q.y) / u_dir.y : 1e9);
  vec2 n = q + u_dir * min(tx, ty);
  if (tx <= ty) n.x = u_dir.x > 0.0 ? cell.x + cs + 0.001 : cell.x - 0.001;
  if (ty <= tx) n.y = u_dir.y > 0.0 ? cell.y + cs + 0.001 : cell.y - 0.001;
  return n;
}

// 0 = lit, 1 = shadowed, 2 = ran out of iterations before reaching a verdict (treated as lit).
int occluded(float h0) {
  float sMax = (u_maxValue - h0) / u_rise;
  vec2 q = nextCell(v_px, 1.0);   // leave our own pixel first
  int lod = 0;
  for (int i = 0; i < 4096; i++) {
    if (i >= u_maxIter) return 2;
    float s = dot(q - v_px, u_dir);
    if (s >= sMax) return 0;
    float cs = float(1 << lod);
    ivec2 ci = ivec2(floor(q / cs));
    int lsize = SIZE >> lod;
    if (ci.x < 0 || ci.y < 0 || ci.x >= lsize || ci.y >= lsize) return 0;   // left the window
    float cellMax = float(texelFetch(u_height, slot(ci, lod), lod).r);
    // Ray height where it enters the cell (the lowest point of the ray inside it). The bias absorbs LiDAR noise next to
    // the start pixel and fades out, so it cannot shorten long shadows.
    float rayH = h0 + u_bias * max(0.0, 1.0 - s / u_biasRange) + u_rise * s;
    if (cellMax <= rayH) {
      q = nextCell(q, cs);
      lod = min(lod + 1, MAX_LOD);
    } else if (lod == 0) {
      return 1;
    } else {
      lod--;
    }
  }
  return 2;
}

void main() {
  ivec2 p0 = ivec2(floor(v_px));
  if (p0.x < 0 || p0.y < 0 || p0.x >= SIZE || p0.y >= SIZE) discard;
  float h0 = float(texelFetch(u_height, slot(p0, 0), 0).r);
  if (h0 < 1.0) { outColor = vec4(0.0); return; }     // no data: nothing to say about this pixel
  if (u_rise <= 0.0) { outColor = vec4(1.0); return; } // sun below the horizon
  outColor = occluded(h0) == 1 ? vec4(1.0) : vec4(0.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error');
  return sh;
}

/** Traces the 0/1 shadow mask for a rectangle of the height window. */
export class ShadowProgram {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor(private gl: WebGL2RenderingContext) {
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link error');
    this.program = program;
    for (const name of ['u_matrix', 'u_height', 'u_dir', 'u_rise', 'u_maxValue', 'u_bias', 'u_biasRange', 'u_origin', 'u_maxIter']) {
      this.u[name] = gl.getUniformLocation(program, name);
    }
    const s = WINDOW_PX;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, s, 0, 0, s, 0, s, s, 0, s, s]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_px');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Draws the window-sized quad with `matrix` (window pixels -> clip space); the caller's viewport crops it to a region. */
  drawMask(matrix: Float32Array, p: ShadowParams, win: HeightWindow) {
    const gl = this.gl;
    if (!win.origin) return;
    const az = (p.azimuthDeg * Math.PI) / 180;
    const rise = (Math.tan((p.altitudeDeg * Math.PI) / 180) * win.metersPerPx) / win.step;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, win.texture);
    gl.uniform1i(this.u.u_height!, 0);
    gl.uniformMatrix4fv(this.u.u_matrix!, false, matrix);
    gl.uniform2f(this.u.u_dir!, Math.sin(az), -Math.cos(az));
    gl.uniform1f(this.u.u_rise!, p.altitudeDeg > 0 ? rise : 0);
    gl.uniform1f(this.u.u_maxValue!, win.maxValue);
    gl.uniform1f(this.u.u_bias!, p.bias);
    gl.uniform1f(this.u.u_biasRange!, p.biasRangeM / win.metersPerPx);
    gl.uniform2i(this.u.u_origin!, win.origin[0] * 256, win.origin[1] * 256);
    gl.uniform1i(this.u.u_maxIter!, p.maxIter);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
  }
}
