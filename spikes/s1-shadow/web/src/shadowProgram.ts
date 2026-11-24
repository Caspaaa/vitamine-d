import { MAX_LOD, type HeightAtlas } from './atlas';

export interface ShadowParams {
  /** Compass bearing of the sun, degrees clockwise from north. */
  azimuthDeg: number;
  /** Refraction-corrected sun altitude in degrees. */
  altitudeDeg: number;
  /** Height tolerance (quantised units) that absorbs surface noise: it fades out linearly over `biasRangeM`. */
  bias: number;
  /** Distance in metres over which the tolerance fades to zero, so real shadows from walls stay exact. */
  biasRangeM: number;
  /** Distance (in pixels) below which the full-resolution height is used; larger = more exact, slower. */
  lodScale: number;
  /** Debug view: 0 = shadows, 1 = height. */
  mode: number;
  /** 0 = fixed steps with mip LOD (first version), 1 = exact hierarchical cell skipping. */
  algo: number;
  /** 1 = write a plain 0/1 shadow mask (for the smoothing pipeline) instead of a coloured overlay. */
  maskOnly: number;
  /** Ray-traversal step budget per pixel. */
  maxIter: number;
  alpha: number;
}

export const DEFAULT_PARAMS: ShadowParams = {
  azimuthDeg: 180,
  altitudeDeg: 30,
  bias: 2,
  biasRangeM: 6,
  lodScale: 16,
  mode: 0,
  algo: 1,
  maskOnly: 0,
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

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D u_height;
uniform vec2 u_dir;        // unit vector in pixel space (+x east, +y south) pointing toward the sun
uniform float u_rise;      // quantised height units gained per pixel travelled along the ray
uniform float u_maxValue;  // highest quantised height in the atlas
uniform float u_bias;
uniform float u_biasRange;  // pixels
uniform float u_lodScale;
uniform int u_size;
uniform int u_maxLod;
uniform int u_mode;
uniform int u_maskOnly;
uniform int u_algo;
uniform int u_maxIter;        // 0 = fixed steps with mip LOD, 1 = exact hierarchical cell skipping
uniform vec4 u_color;      // premultiplied shadow colour

in vec2 v_px;
out vec4 outColor;

// Move q along u_dir to just inside the next cell of size cs. The coordinate of the crossed axis is snapped
// past the boundary: nudging along the ray is not enough for near axis-aligned rays, where the step in the
// minor axis falls below float32 resolution and the ray would get stuck on the boundary.
vec2 nextCell(vec2 q, float cs) {
  vec2 cell = floor(q / cs) * cs;
  float tx = u_dir.x > 0.0 ? (cell.x + cs - q.x) / u_dir.x : (u_dir.x < 0.0 ? (cell.x - q.x) / u_dir.x : 1e9);
  float ty = u_dir.y > 0.0 ? (cell.y + cs - q.y) / u_dir.y : (u_dir.y < 0.0 ? (cell.y - q.y) / u_dir.y : 1e9);
  vec2 n = q + u_dir * min(tx, ty);
  if (tx <= ty) n.x = u_dir.x > 0.0 ? cell.x + cs + 0.001 : cell.x - 0.001;
  if (ty <= tx) n.y = u_dir.y > 0.0 ? cell.y + cs + 0.001 : cell.y - 0.001;
  return n;
}

// Returns 0 = lit, 1 = shadowed, 2 = ran out of iterations before reaching a verdict.
int occludedHierarchical(float h0) {
  float sMax = (u_maxValue - h0) / u_rise;
  vec2 q = nextCell(v_px, 1.0);   // leave our own pixel first
  int lod = 0;
  for (int i = 0; i < 4096; i++) {
    if (i >= u_maxIter) return 2;
    float s = dot(q - v_px, u_dir);
    if (s >= sMax) return 0;
    float cs = float(1 << lod);
    ivec2 ci = ivec2(floor(q / cs));
    int lsize = u_size >> lod;
    if (ci.x < 0 || ci.y < 0 || ci.x >= lsize || ci.y >= lsize) return 0;
    float cellMax = float(texelFetch(u_height, ci, lod).r);
    // Ray height where it enters the cell (the lowest point of the ray inside it).
    // The bias absorbs LiDAR noise next to the start pixel and fades out, so it can't shorten long shadows.
    float rayH = h0 + u_bias * max(0.0, 1.0 - s / u_biasRange) + u_rise * s;
    if (cellMax <= rayH) {
      q = nextCell(q, cs);
      lod = min(lod + 1, u_maxLod);
    } else if (lod == 0) {
      return 1;
    } else {
      lod--;
    }
  }
  return 2;
}

int occludedFixedStep(float h0) {
  float s = 0.75;
  for (int i = 0; i < 400; i++) {
    float ray = h0 + u_bias * max(0.0, 1.0 - s / u_biasRange) + u_rise * s;
    if (ray >= u_maxValue) break;
    int lod = clamp(int(floor(log2(max(s / u_lodScale, 1.0)))), 0, u_maxLod);
    ivec2 qi = ivec2(floor(v_px + u_dir * s)) >> lod;
    int lsize = u_size >> lod;
    if (qi.x < 0 || qi.y < 0 || qi.x >= lsize || qi.y >= lsize) break;
    if (float(texelFetch(u_height, qi, lod).r) > ray) return 1;
    s += max(1.0, 0.5 * float(1 << lod));
  }
  return 0;
}

void main() {
  ivec2 p0 = ivec2(floor(v_px));
  if (p0.x < 0 || p0.y < 0 || p0.x >= u_size || p0.y >= u_size) discard;
  float h0 = float(texelFetch(u_height, p0, 0).r);
  if (h0 < 1.0) { outColor = vec4(0.0); return; }   // no LiDAR coverage: nothing to say about this pixel

  if (u_mode == 1) {
    float t = clamp((h0 - 40.0) / 400.0, 0.0, 1.0);
    outColor = vec4(vec3(t), 1.0);
    return;
  }
  if (u_rise <= 0.0) { outColor = u_maskOnly == 1 ? vec4(1.0) : u_color; return; }   // sun below the horizon

  int r = u_algo == 1 ? occludedHierarchical(h0) : occludedFixedStep(h0);
  if (u_mode == 2) {   // debug: red = ran out of iterations, dark = shadow, clear = lit
    outColor = r == 2 ? vec4(1.0, 0.0, 0.0, 1.0) : (r == 1 ? vec4(0.0, 0.0, 0.0, 0.6) : vec4(0.0));
    return;
  }
  bool shadow = r == 1;
  outColor = shadow ? (u_maskOnly == 1 ? vec4(1.0) : u_color) : vec4(0.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error');
  return sh;
}

export class ShadowProgram {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private texture: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pending: WebGLQuery[] = [];
  /** Rolling GPU time of the shadow draw in milliseconds (null if the browser has no timer queries). */
  gpuMs: number | null = null;

  constructor(
    private gl: WebGL2RenderingContext,
    private atlas: HeightAtlas,
  ) {
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link error');
    this.program = program;
    for (const name of ['u_matrix', 'u_height', 'u_dir', 'u_rise', 'u_maxValue', 'u_bias', 'u_biasRange', 'u_lodScale', 'u_size', 'u_maxLod', 'u_mode', 'u_maskOnly', 'u_algo', 'u_maxIter', 'u_color']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }

    const s = atlas.size;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, s, 0, 0, s, 0, s, s, 0, s, s]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_px');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    atlas.levels.forEach((data, level) => {
      const ls = s >> level;
      gl.texImage2D(gl.TEXTURE_2D, level, gl.R16UI, ls, ls, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, data);
    });
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, MAX_LOD);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  /** Draws the full-atlas quad with `matrix` (atlas pixel coordinates -> clip space), timing it on the GPU. */
  draw(matrix: Float32Array, p: ShadowParams) {
    this.beginTimer();
    this.drawQuad(matrix, p);
    this.endTimer();
  }

  /** Same as `draw` without GPU timing, so several passes can share one timer (queries cannot nest). */
  drawQuad(matrix: Float32Array, p: ShadowParams) {
    const gl = this.gl;
    const a = this.atlas;
    const az = (p.azimuthDeg * Math.PI) / 180;
    const rise = (Math.tan((p.altitudeDeg * Math.PI) / 180) * a.metersPerPx) / a.step;

    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniforms.u_height, 0);
    gl.uniformMatrix4fv(this.uniforms.u_matrix, false, matrix);
    gl.uniform2f(this.uniforms.u_dir, Math.sin(az), -Math.cos(az));
    gl.uniform1f(this.uniforms.u_rise, p.altitudeDeg > 0 ? rise : 0);
    gl.uniform1f(this.uniforms.u_maxValue, a.maxValue);
    gl.uniform1f(this.uniforms.u_bias, p.bias);
    gl.uniform1f(this.uniforms.u_biasRange, p.biasRangeM / a.metersPerPx);
    gl.uniform1f(this.uniforms.u_lodScale, p.lodScale);
    gl.uniform1i(this.uniforms.u_size, a.size);
    gl.uniform1i(this.uniforms.u_maxLod, MAX_LOD);
    gl.uniform1i(this.uniforms.u_mode, p.mode);
    gl.uniform1i(this.uniforms.u_maskOnly, p.maskOnly);
    gl.uniform1i(this.uniforms.u_algo, p.algo);
    gl.uniform1i(this.uniforms.u_maxIter, p.maxIter);
    const al = p.alpha;
    gl.uniform4f(this.uniforms.u_color, 0.04 * al, 0.07 * al, 0.2 * al, al);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  private activeQuery: WebGLQuery | null = null;

  beginTimer() {
    const ext = this.timerExt;
    if (!ext || this.pending.length >= 4 || this.activeQuery) return;
    this.activeQuery = this.gl.createQuery()!;
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT, this.activeQuery);
  }

  endTimer() {
    const ext = this.timerExt;
    if (ext && this.activeQuery) {
      this.gl.endQuery(ext.TIME_ELAPSED_EXT);
      this.pending.push(this.activeQuery);
      this.activeQuery = null;
    }
    this.collectTimers();
  }

  /** Collects finished GPU timer queries; call once per frame. */
  poll() {
    this.collectTimers();
  }

  private collectTimers() {
    const gl = this.gl;
    const ext = this.timerExt;
    if (!ext) return;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
        this.gpuMs = this.gpuMs === null ? ms : this.gpuMs * 0.9 + ms * 0.1;
      }
      gl.deleteQuery(q);
      this.pending.shift();
    }
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.texture);
  }
}
