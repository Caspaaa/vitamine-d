import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import type { HeightAtlas } from './atlas';
import { DEFAULT_SMOOTH, ShadowMask, type Rect, type SmoothOptions } from './shadowMask';
import { DEFAULT_PARAMS, ShadowProgram, type ShadowParams } from './shadowProgram';

/** Column-major 4x4 multiply: returns a * b. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

const SNAP = 64; // atlas pixels; window edges snap to this so panning doesn't recompute every frame
const MARGIN = 192; // atlas pixels of extra window around the viewport
const MAX_MASK = 2048; // mask texels per side

const mercX = (lng: number) => (lng + 180) / 360;
const mercY = (lat: number) => (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;

/** MapLibre custom layer that paints cast shadows from the height atlas. */
export class ShadowLayer implements CustomLayerInterface {
  readonly id = 'vitamine-shadows';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  params: ShadowParams = { ...DEFAULT_PARAMS };
  options: SmoothOptions = { ...DEFAULT_SMOOTH };
  /** false = draw straight from the ray-tracer at screen resolution (first version, for comparison). */
  useMask = true;
  /** Stress test: repeat the mask computation this many times per recomputed frame (measures phone headroom). */
  stress = 1;
  private program: ShadowProgram | null = null;
  private mask: ShadowMask | null = null;
  private map: MapLibreMap | null = null;
  info = '';

  constructor(private atlas: HeightAtlas) {}

  get gpuMs(): number | null {
    return this.program?.gpuMs ?? null;
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.program = new ShadowProgram(gl, this.atlas);
    this.mask = new ShadowMask(gl, this.program);
  }

  onRemove() {
    this.mask?.dispose();
    this.program?.dispose();
    this.mask = null;
    this.program = null;
  }

  update(patch: Partial<ShadowParams>) {
    Object.assign(this.params, patch);
    this.map?.triggerRepaint();
  }

  setOptions(patch: Partial<SmoothOptions>) {
    Object.assign(this.options, patch);
    this.map?.triggerRepaint();
  }

  /** Visible part of the atlas in atlas pixels, or null when the map doesn't show it. */
  private visibleRect(): Rect | null {
    const a = this.atlas;
    const b = this.map!.getBounds();
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    const toPx = (m: number, o: number) => ((m - o) / a.sizeMerc) * a.size;
    const x0 = Math.max(0, toPx(mercX(sw.lng), a.originMerc[0]));
    const x1 = Math.min(a.size, toPx(mercX(ne.lng), a.originMerc[0]));
    const y0 = Math.max(0, toPx(mercY(ne.lat), a.originMerc[1]));
    const y1 = Math.min(a.size, toPx(mercY(sw.lat), a.originMerc[1]));
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    return [x0, y0, x1 - x0, y1 - y0];
  }

  /** Atlas pixels per device pixel at the map centre (MapLibre world = 512 * 2^zoom css pixels). */
  private atlasPxPerDevicePx(): number {
    const a = this.atlas;
    const canvas = this.map!.getCanvas();
    const pr = canvas.width / Math.max(1, canvas.clientWidth);
    return a.size / a.sizeMerc / (512 * 2 ** this.map!.getZoom()) / pr;
  }

  private chooseWindow(need: Rect): { region: Rect; texel: number } {
    const a = this.atlas;
    let texel = 2 ** Math.floor(Math.log2(Math.max(1, this.atlasPxPerDevicePx())));
    const cached = this.mask!.region;
    const contains = (r: Rect) => need[0] >= r[0] && need[1] >= r[1] && need[0] + need[2] <= r[0] + r[2] && need[1] + need[3] <= r[1] + r[3];
    if (this.mask!.texel === texel && contains(cached) && cached[2] > 0) return { region: cached, texel };

    const snapDown = (v: number) => Math.max(0, Math.floor((v - MARGIN) / SNAP) * SNAP);
    const snapUp = (v: number) => Math.min(a.size, Math.ceil((v + MARGIN) / SNAP) * SNAP);
    const x0 = snapDown(need[0]), y0 = snapDown(need[1]);
    const x1 = snapUp(need[0] + need[2]), y1 = snapUp(need[1] + need[3]);
    while (Math.max(x1 - x0, y1 - y0) / texel > MAX_MASK && texel < SNAP) texel *= 2;
    return { region: [x0, y0, x1 - x0, y1 - y0], texel };
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (!this.program || !this.mask) return;
    this.program.poll();
    const a = this.atlas;
    // atlas pixel -> normalised mercator, composed in float64 on the CPU so that
    // high zoom levels don't lose precision before the float32 upload.
    const pxToMerc = new Float64Array([
      a.sizeMerc / a.size, 0, 0, 0,
      0, a.sizeMerc / a.size, 0, 0,
      0, 0, 1, 0,
      a.originMerc[0], a.originMerc[1], 0, 1,
    ]);
    const matrix = new Float32Array(mul(options.defaultProjectionData.mainMatrix, pxToMerc));

    if (!this.useMask || this.params.mode === 1 || this.params.mode === 2) {
      this.program.draw(matrix, { ...this.params, maskOnly: 0 });
      this.info = 'direct (no mask)';
      return;
    }

    const need = this.visibleRect();
    if (!need) return;
    const { region, texel } = this.chooseWindow(need);
    const timed = this.mask.stale(region, texel, this.params, this.options);
    if (timed) this.program.beginTimer();
    this.mask.update(region, texel, this.params, this.options);
    if (timed) {
      for (let i = 1; i < this.stress; i++) {
        this.mask.invalidate();
        this.mask.update(region, texel, this.params, this.options);
      }
    }
    this.mask.composite(matrix, this.params, this.options);
    if (timed) this.program.endTimer();
    const [mw, mh] = this.mask.size;
    this.info = `mask ${mw}×${mh} (1 texel = ${texel} data px)${this.options.smooth ? ', smoothed' : ', raw'}${this.stress > 1 ? `, STRESS ×${this.stress}` : ''}`;
  }
}
