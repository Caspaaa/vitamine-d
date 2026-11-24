import { TileSource, buildTileMips, MAX_LOD, type HeightTile } from './tiles.ts';
import {
  TILE_PX, WINDOW_PX, WINDOW_TILES, chooseOrigin, intersect, rectContains, rectEquals, slotOf, tilesIn, windowRect, windowShift,
  type TileRect,
} from './window.ts';

const ZOOM = 17;
const WORLD_PX = 2 ** ZOOM * TILE_PX;
/** Above this many leaving tiles it is cheaper to start from a fresh (all-zero) texture than to clear slot by slot. */
const RESET_THRESHOLD = 96;
const ZERO = new Uint16Array(TILE_PX * TILE_PX);

interface Resident {
  x: number;
  y: number;
  max: number;
}

interface Upload {
  x: number;
  y: number;
  tile: HeightTile;
}

const keyOf = (x: number, y: number) => `${x}/${y}`;

/**
 * GPU side of the ring buffer: one R16UI texture of 16 x 16 tile slots with a max-reduced mip chain per tile.
 *
 * Invariant: a slot holds either the tile that currently belongs there or zeros ("no data", never an occluder). Slots
 * are zero-filled the moment their tile leaves the window, so a ray can never read another tile's heights.
 */
export class HeightWindow {
  readonly size = WINDOW_PX;
  /** North-west tile of the window, or null before the first request. */
  origin: [number, number] | null = null;
  /** Highest quantised height among resident tiles (lets the shader stop rays early). */
  maxValue = 1;
  /** Increases whenever the origin or the texture content changed, so cached masks know to recompute. */
  epoch = 0;
  /** Ground metres per pixel (true metres) at the window's latitude. */
  metersPerPx = 1;
  texture: WebGLTexture;

  private residents = new Map<number, Resident>();
  private requested = new Set<string>();
  private uploads: Upload[] = [];
  private lastNeed: TileRect | null = null;
  private retryAt = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    private source: TileSource,
    private onChange: () => void,
  ) {
    this.texture = this.createTexture();
  }

  get step(): number {
    return this.source.index.step;
  }

  /** Window origin in normalised web-mercator coordinates (0..1). */
  get originMerc(): [number, number] {
    const o = this.origin ?? [0, 0];
    return [o[0] / 2 ** ZOOM, o[1] / 2 ** ZOOM];
  }

  get sizeMerc(): number {
    return WINDOW_TILES / 2 ** ZOOM;
  }

  get stats() {
    return { resident: this.residents.size, uploading: this.uploads.length, requesting: this.source.pendingCount };
  }

  /** True while tiles are still on their way (loading or waiting for an upload slot). */
  get busy(): boolean {
    return this.uploads.length > 0 || this.source.pendingCount > 0;
  }

  /** Tell the window which tiles must be available (visible area + ray margin). Cheap when `need` did not change. */
  update(need: TileRect) {
    const now = performance.now();
    if (rectEquals(need, this.lastNeed) && !(this.retryAt && now > this.retryAt)) return;
    this.lastNeed = need;
    this.retryAt = 0;
    if (!this.origin || !rectContains(windowRect(this.origin), need)) this.switchTo(chooseOrigin(need));
    const win = windowRect(this.origin!);
    this.source.cancelQueued((x, y) => {
      const k = intersect(win, need);
      return !!k && x >= k.x0 && x <= k.x1 && y >= k.y0 && y <= k.y1;
    });
    this.schedule(need);
  }

  /** Uploads up to `budget` tiles. Returns whether the texture changed. */
  pump(budget = 6): boolean {
    if (!this.uploads.length || !this.origin) return false;
    const win = windowRect(this.origin);
    const gl = this.gl;
    const prevTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    let done = 0;
    while (this.uploads.length && done < budget) {
      const u = this.uploads.shift()!;
      if (u.x < win.x0 || u.x > win.x1 || u.y < win.y0 || u.y > win.y1) continue; // the window moved on
      const [sx, sy] = slotOf(u.x, u.y);
      const levels = buildTileMips(u.tile.level0);
      for (let l = 0; l <= MAX_LOD; l++) {
        const s = TILE_PX >> l;
        gl.texSubImage2D(gl.TEXTURE_2D, l, sx * s, sy * s, s, s, gl.RED_INTEGER, gl.UNSIGNED_SHORT, levels[l]!);
      }
      this.residents.set(sy * WINDOW_TILES + sx, { x: u.x, y: u.y, max: u.tile.maxValue });
      done++;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.bindTexture(gl.TEXTURE_2D, prevTexture);
    if (done) {
      this.recomputeMax();
      this.epoch++;
    }
    return done > 0;
  }

  dispose() {
    this.gl.deleteTexture(this.texture);
    this.uploads = [];
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, MAX_LOD + 1, gl.R16UI, WINDOW_PX, WINDOW_PX);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, MAX_LOD);
    gl.bindTexture(gl.TEXTURE_2D, prev);
    return t;
  }

  private clearSlot(sx: number, sy: number) {
    const gl = this.gl;
    for (let l = 0; l <= MAX_LOD; l++) {
      const s = TILE_PX >> l;
      gl.texSubImage2D(gl.TEXTURE_2D, l, sx * s, sy * s, s, s, gl.RED_INTEGER, gl.UNSIGNED_SHORT, ZERO.subarray(0, s * s));
    }
  }

  private switchTo(origin: [number, number]) {
    const gl = this.gl;
    const { leaving } = windowShift(this.origin, origin);
    if (!this.origin || leaving.length > RESET_THRESHOLD) {
      gl.deleteTexture(this.texture);
      this.texture = this.createTexture();
      this.residents.clear();
      this.requested.clear();
    } else {
      const prev = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      for (const [x, y] of leaving) {
        const [sx, sy] = slotOf(x, y);
        this.clearSlot(sx, sy);
        this.residents.delete(sy * WINDOW_TILES + sx);
        this.requested.delete(keyOf(x, y));
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.bindTexture(gl.TEXTURE_2D, prev);
    }
    this.origin = origin;
    const win = windowRect(origin);
    this.uploads = this.uploads.filter((u) => u.x >= win.x0 && u.x <= win.x1 && u.y >= win.y0 && u.y <= win.y1);
    const cy = ((origin[1] + WINDOW_TILES / 2) * TILE_PX) / WORLD_PX;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * cy))) * 180) / Math.PI;
    this.metersPerPx = (156543.03392804097 / 2 ** ZOOM) * Math.cos((lat * Math.PI) / 180);
    this.recomputeMax();
    this.epoch++;
  }

  private schedule(need: TileRect) {
    const win = windowRect(this.origin!);
    const area = intersect(win, need);
    if (!area) return;
    const cx = (area.x0 + area.x1) / 2;
    const cy = (area.y0 + area.y1) / 2;
    for (const [x, y] of tilesIn(area)) {
      const k = keyOf(x, y);
      if (this.requested.has(k) || !this.source.index.has(x, y)) continue;
      this.requested.add(k);
      const cached = this.source.peek(x, y);
      if (cached) {
        this.uploads.push({ x, y, tile: cached });
        continue;
      }
      this.source.request(x, y, Math.hypot(x - cx, y - cy)).then(
        (tile) => {
          if (tile) this.uploads.push({ x, y, tile });
          this.onChange();
        },
        (e) => {
          this.requested.delete(k);
          if (!(e instanceof DOMException && e.name === 'AbortError')) {
            this.retryAt = performance.now() + 2000;
            setTimeout(this.onChange, 2100); // nothing else would wake an idle map up to retry
          }
          this.onChange();
        },
      );
    }
    if (this.uploads.length) this.onChange();
  }

  private recomputeMax() {
    let m = 1;
    for (const r of this.residents.values()) if (r.max > m) m = r.max;
    this.maxValue = m;
  }
}
