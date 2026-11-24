import { decodePng } from './png.ts';
import { MAX_LOD, TILE_PX } from './window.ts';

export { MAX_LOD };

/** One decoded height tile: quantised elevation per pixel (0 = no data) and its highest value. */
export interface HeightTile {
  level0: Uint16Array;
  maxValue: number;
}

export interface TileIndexJson {
  zoom: number;
  tileSize: number;
  offset: number;
  step: number;
  count: number;
  /** Existing tiles as x-runs per row: { "43961": [[67110, 67125], ...] }. */
  rows: Record<string, [number, number][]>;
}

/** Which tiles exist, so the client never requests one that is not there (a 404 is not free on a static host). */
export class TileIndex {
  readonly zoom: number;
  /** elevation_m = value * step - offset */
  readonly step: number;
  readonly offset: number;
  private rows = new Map<number, [number, number][]>();

  constructor(json: TileIndexJson) {
    this.zoom = json.zoom;
    this.step = json.step;
    this.offset = json.offset;
    for (const [y, runs] of Object.entries(json.rows)) this.rows.set(Number(y), runs);
  }

  has(x: number, y: number): boolean {
    const runs = this.rows.get(y);
    if (!runs) return false;
    for (const [a, b] of runs) if (x >= a && x <= b) return true;
    return false;
  }
}

/** Loads one tile; resolves null when the tile has no data. */
export type TileFetcher = (x: number, y: number, signal: AbortSignal) => Promise<HeightTile | null>;

export function decodeHeightTile(rgba: Uint8Array): HeightTile {
  const level0 = new Uint16Array(TILE_PX * TILE_PX);
  let max = 0;
  for (let i = 0; i < level0.length; i++) {
    const v = (rgba[i * 4]! << 8) | rgba[i * 4 + 1]!;
    level0[i] = v;
    if (v > max) max = v;
  }
  return { level0, maxValue: max };
}

/** The production fetcher: `<base>/<zoom>/<x>/<y>.png`, retried with backoff, decoded without a canvas. */
export function pngFetcher(base: string, zoom: number): TileFetcher {
  return async (x, y, signal) => {
    const url = `${base}/${zoom}/${x}/${y}.png`;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(url, { signal });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`${r.status} ${url}`);
        return decodeHeightTile((await decodePng(await r.arrayBuffer())).data);
      } catch (e) {
        if (signal.aborted || attempt >= 3) throw e;
        await new Promise((res) => setTimeout(res, 300 * 2 ** attempt));
      }
    }
  };
}

interface Pending {
  key: string;
  x: number;
  y: number;
  priority: number;
  resolve: (t: HeightTile | null) => void;
  reject: (e: unknown) => void;
  controller: AbortController;
}

const keyOf = (x: number, y: number) => `${x}/${y}`;

export interface TileSourceOptions {
  /** Decoded tiles kept in memory (128 KB each). */
  cacheSize?: number;
  /** Requests in flight at the same time. */
  concurrency?: number;
}

/** Index + fetcher + a bounded cache + a prioritised request queue. */
export class TileSource {
  readonly index: TileIndex;
  private cache = new Map<string, HeightTile | null>();
  private inflight = new Map<string, Promise<HeightTile | null>>();
  private queue: Pending[] = [];
  private active = 0;
  private readonly cacheSize: number;
  private readonly concurrency: number;

  constructor(index: TileIndex, private fetcher: TileFetcher, options: TileSourceOptions = {}) {
    this.index = index;
    this.cacheSize = options.cacheSize ?? 480;
    this.concurrency = options.concurrency ?? 12;
  }

  static async open(base: string, options?: TileSourceOptions, kind = 'dsm'): Promise<TileSource> {
    const r = await fetch(`${base}/${kind}/index.json`);
    if (!r.ok) throw new Error(`tile index: ${r.status}`);
    const index = new TileIndex((await r.json()) as TileIndexJson);
    return new TileSource(index, pngFetcher(`${base}/${kind}`, index.zoom), options);
  }

  /** The tile if it is already in memory: `null` = known to have no data, `undefined` = not loaded. */
  peek(x: number, y: number): HeightTile | null | undefined {
    if (!this.index.has(x, y)) return null;
    const k = keyOf(x, y);
    if (!this.cache.has(k)) return undefined;
    const v = this.cache.get(k)!;
    this.cache.delete(k); // refresh LRU order
    this.cache.set(k, v);
    return v;
  }

  /** Loads a tile; a lower priority number goes first (use the distance from the map centre). */
  request(x: number, y: number, priority = 0): Promise<HeightTile | null> {
    const cached = this.peek(x, y);
    if (cached !== undefined) return Promise.resolve(cached);
    const k = keyOf(x, y);
    const existing = this.inflight.get(k);
    if (existing) {
      const queued = this.queue.find((p) => p.key === k);
      if (queued && priority < queued.priority) queued.priority = priority;
      return existing;
    }
    const p = new Promise<HeightTile | null>((resolve, reject) => {
      this.queue.push({ key: k, x, y, priority, resolve, reject, controller: new AbortController() });
    });
    this.inflight.set(k, p);
    p.then(
      (t) => this.store(k, t),
      () => undefined,
    ).finally(() => this.inflight.delete(k));
    this.pump();
    return p;
  }

  /** Drops queued (not yet started) requests that `keep` rejects, e.g. tiles the map has since moved away from. */
  cancelQueued(keep: (x: number, y: number) => boolean) {
    const rest: Pending[] = [];
    for (const p of this.queue) {
      if (keep(p.x, p.y)) rest.push(p);
      else p.reject(new DOMException('cancelled', 'AbortError'));
    }
    this.queue = rest;
  }

  get pendingCount(): number {
    return this.queue.length + this.active;
  }

  private store(k: string, t: HeightTile | null) {
    this.cache.set(k, t);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i]!.priority < this.queue[best]!.priority) best = i;
      const job = this.queue.splice(best, 1)[0]!;
      this.active++;
      this.fetcher(job.x, job.y, job.controller.signal).then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}

/** Max-reduced mip chain of one tile: level l holds the maximum over 2^l x 2^l blocks (levels 0..MAX_LOD). */
export function buildTileMips(level0: Uint16Array): Uint16Array[] {
  const levels = [level0];
  let prev = level0;
  let size = TILE_PX;
  for (let l = 1; l <= MAX_LOD; l++) {
    const s = size >> 1;
    const cur = new Uint16Array(s * s);
    for (let y = 0; y < s; y++) {
      const r0 = 2 * y * size;
      const r1 = r0 + size;
      for (let x = 0; x < s; x++) {
        const a = prev[r0 + 2 * x]!;
        const b = prev[r0 + 2 * x + 1]!;
        const c = prev[r1 + 2 * x]!;
        const d = prev[r1 + 2 * x + 1]!;
        cur[y * s + x] = Math.max(a, b, c, d);
      }
    }
    levels.push(cur);
    prev = cur;
    size = s;
  }
  return levels;
}
