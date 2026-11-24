import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { HeightWindow } from './heightWindow.ts';
import { ShadowMask, type Rect } from './shadowMask.ts';
import { DEFAULT_PARAMS, ShadowProgram, type ShadowParams } from './shadowProgram.ts';
import type { TileSource } from './tiles.ts';
import { TILE_PX, WINDOW_PX, tileRectOfPx } from './window.ts';

const ZOOM = 17;
const WORLD_PX = 2 ** ZOOM * TILE_PX;
const SNAP = 64; // world pixels; mask edges snap to this so panning does not recompute every frame
const MASK_MARGIN = 128; // world pixels of extra mask around the visible area
const MAX_MASK = 2048; // mask texels per side

/** Column-major 4x4 multiply: returns a * b. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

const mercX = (lng: number) => (lng + 180) / 360;
const mercY = (lat: number) => (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
/** Ground metres per z17 pixel at a latitude. */
const metersPerPx = (lat: number) => (156543.03392804097 / 2 ** ZOOM) * Math.cos((lat * Math.PI) / 180);

export type ShadowState = 'loading' | 'ready' | 'zoomed-out' | 'error';

export interface ShadowStatus {
  state: ShadowState;
  /** Tiles resident on the GPU / still being fetched or uploaded. */
  resident: number;
  pending: number;
}

export interface ShadowLayerOptions {
  source: TileSource;
  /** Below this map zoom no shadows are drawn (the window cannot cover a wider view). */
  minZoom?: number;
  /** Shadows can only be computed from occluders inside the loaded window; rays are cut at this distance. */
  rayMarginM?: number;
  onStatus?: (s: ShadowStatus) => void;
}

/** MapLibre custom layer that paints cast shadows from a streaming window of height tiles. */
export class ShadowLayer implements CustomLayerInterface {
  readonly id = 'vitamine-shadows';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  params: ShadowParams = { ...DEFAULT_PARAMS };
  private program: ShadowProgram | null = null;
  private mask: ShadowMask | null = null;
  private window: HeightWindow | null = null;
  private map: MapLibreMap | null = null;
  private status: ShadowStatus = { state: 'loading', resident: 0, pending: 0 };
  private readonly minZoom: number;
  private readonly rayMarginM: number;

  constructor(private options: ShadowLayerOptions) {
    this.minZoom = options.minZoom ?? 15;
    this.rayMarginM = options.rayMarginM ?? 500;
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.program = new ShadowProgram(gl);
    this.mask = new ShadowMask(gl, this.program);
    this.window = new HeightWindow(gl, this.options.source, () => this.map?.triggerRepaint());
  }

  onRemove() {
    this.mask?.dispose();
    this.program?.dispose();
    this.window?.dispose();
    this.mask = this.program = this.window = null;
  }

  update(patch: Partial<ShadowParams>) {
    Object.assign(this.params, patch);
    this.map?.triggerRepaint();
  }

  private setStatus(state: ShadowState) {
    const w = this.window;
    const next: ShadowStatus = { state, resident: w?.stats.resident ?? 0, pending: (w?.stats.uploading ?? 0) + (w?.stats.requesting ?? 0) };
    const s = this.status;
    if (s.state === next.state && s.resident === next.resident && s.pending === next.pending) return;
    this.status = next;
    this.options.onStatus?.(next);
  }

  /** Visible ground in world pixels, limited to a square around the map centre that the window can serve. */
  private visibleWorld(): [number, number, number, number] {
    const map = this.map!;
    const b = map.getBounds();
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    const c = map.getCenter();
    const mpp = metersPerPx(c.lat);
    const radius = (((WINDOW_PX / TILE_PX - 1) * TILE_PX) / 2) - this.rayMarginM / mpp - MASK_MARGIN - SNAP;
    const cx = mercX(c.lng) * WORLD_PX;
    const cy = mercY(c.lat) * WORLD_PX;
    return [
      Math.max(cx - radius, mercX(sw.lng) * WORLD_PX),
      Math.max(cy - radius, mercY(ne.lat) * WORLD_PX),
      Math.min(cx + radius, mercX(ne.lng) * WORLD_PX),
      Math.min(cy + radius, mercY(sw.lat) * WORLD_PX),
    ];
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    const map = this.map;
    const win = this.window;
    if (!map || !win || !this.program || !this.mask) return;
    win.pump();
    if (win.stats.uploading > 0) map.triggerRepaint();

    if (map.getZoom() < this.minZoom) return this.setStatus('zoomed-out');

    const [vx0, vy0, vx1, vy1] = this.visibleWorld();
    const rayPx = this.rayMarginM / metersPerPx(map.getCenter().lat);
    const mx0 = Math.floor((vx0 - MASK_MARGIN) / SNAP) * SNAP;
    const my0 = Math.floor((vy0 - MASK_MARGIN) / SNAP) * SNAP;
    const mx1 = Math.ceil((vx1 + MASK_MARGIN) / SNAP) * SNAP;
    const my1 = Math.ceil((vy1 + MASK_MARGIN) / SNAP) * SNAP;
    win.update(tileRectOfPx(mx0 - rayPx, my0 - rayPx, mx1 + rayPx, my1 + rayPx));
    if (!win.origin) return this.setStatus('loading');
    const ox = win.origin[0] * TILE_PX;
    const oy = win.origin[1] * TILE_PX;

    // Mask region in window pixels, kept inside the window.
    const x0 = Math.max(0, mx0 - ox);
    const y0 = Math.max(0, my0 - oy);
    const x1 = Math.min(WINDOW_PX, mx1 - ox);
    const y1 = Math.min(WINDOW_PX, my1 - oy);
    if (x1 - x0 < 1 || y1 - y0 < 1) return this.setStatus('loading');

    const canvas = map.getCanvas();
    const pixelRatio = canvas.width / Math.max(1, canvas.clientWidth);
    let texel = 2 ** Math.floor(Math.log2(Math.max(1, WORLD_PX / (512 * 2 ** map.getZoom()) / pixelRatio)));
    while (Math.max(x1 - x0, y1 - y0) / texel > MAX_MASK && texel < SNAP) texel *= 2;

    // Keep the cached region while it still covers what is visible (panning a little must not recompute).
    const cached = this.mask.region;
    const same = this.mask.origin?.[0] === win.origin[0] && this.mask.origin?.[1] === win.origin[1] && this.mask.texel === texel;
    const vis: Rect = [vx0 - ox, vy0 - oy, vx1 - vx0, vy1 - vy0];
    const covered = same && cached[2] > 0 && vis[0] >= cached[0] && vis[1] >= cached[1] && vis[0] + vis[2] <= cached[0] + cached[2] && vis[1] + vis[3] <= cached[1] + cached[3];
    const region: Rect = covered ? cached : [x0, y0, x1 - x0, y1 - y0];

    this.mask.update(win, region, texel, this.params);

    // window pixel -> normalised mercator, composed in float64 so high zoom levels do not lose precision before the upload
    const [mx, my] = win.originMerc;
    const k = win.sizeMerc / WINDOW_PX;
    const pxToMerc = new Float64Array([k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1, 0, mx, my, 0, 1]);
    const matrix = new Float32Array(mul(options.defaultProjectionData.mainMatrix, pxToMerc));
    this.mask.composite(matrix, this.params.alpha);
    this.setStatus(win.busy ? 'loading' : 'ready');
  }
}
