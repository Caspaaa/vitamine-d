/**
 * The shadow engine's height window is a ring buffer of 16 x 16 tile slots (4096 x 4096 pixels, about 3.1 km at z17).
 * Tile (x, y) always lives in slot (x mod 16, y mod 16). The window "origin" is the tile in its north-west corner, so
 * panning only has to upload the tiles that enter. This file is the pure bookkeeping, with no WebGL.
 */

export const WINDOW_TILES = 16;
export const TILE_PX = 256;
export const WINDOW_PX = WINDOW_TILES * TILE_PX;
/** Mip levels per tile above the full resolution (256 -> 2 pixels): each level is the max over 2^l x 2^l blocks. */
export const MAX_LOD = 7;

/** Inclusive rectangle of tile coordinates. */
export interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type TileCoord = readonly [x: number, y: number];

export function rectContains(outer: TileRect, inner: TileRect): boolean {
  return inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
}

export function rectEquals(a: TileRect | null, b: TileRect | null): boolean {
  return !!a && !!b && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

export function rectSize(r: TileRect): [number, number] {
  return [r.x1 - r.x0 + 1, r.y1 - r.y0 + 1];
}

export function shrink(r: TileRect, n: number): TileRect {
  return { x0: r.x0 + n, y0: r.y0 + n, x1: r.x1 - n, y1: r.y1 - n };
}

export function windowRect(origin: TileCoord): TileRect {
  return { x0: origin[0], y0: origin[1], x1: origin[0] + WINDOW_TILES - 1, y1: origin[1] + WINDOW_TILES - 1 };
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Slot of a tile in the ring buffer. */
export function slotOf(tx: number, ty: number): [number, number] {
  return [mod(tx, WINDOW_TILES), mod(ty, WINDOW_TILES)];
}

/** Window origin that centres `need` (a window wider than 16 tiles is centred and simply cannot cover all of it). */
export function chooseOrigin(need: TileRect): [number, number] {
  const [w, h] = rectSize(need);
  return [need.x0 - Math.floor((WINDOW_TILES - w) / 2), need.y0 - Math.floor((WINDOW_TILES - h) / 2)];
}

export function* tilesIn(r: TileRect): Generator<[number, number]> {
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) yield [x, y];
}

export function intersect(a: TileRect, b: TileRect): TileRect | null {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x0 <= r.x1 && r.y0 <= r.y1 ? r : null;
}

/** Tiles that leave and enter when the window moves from one origin to another. */
export function windowShift(from: TileCoord | null, to: TileCoord): { leaving: [number, number][]; entering: [number, number][] } {
  const next = windowRect(to);
  if (!from) return { leaving: [], entering: [...tilesIn(next)] };
  const prev = windowRect(from);
  const leaving = [...tilesIn(prev)].filter(([x, y]) => x < next.x0 || x > next.x1 || y < next.y0 || y > next.y1);
  const entering = [...tilesIn(next)].filter(([x, y]) => x < prev.x0 || x > prev.x1 || y < prev.y0 || y > prev.y1);
  return { leaving, entering };
}

/** World pixel (z17) -> tile coordinate. */
export const tileOf = (px: number) => Math.floor(px / TILE_PX);

/** Tile rectangle covering a world-pixel rectangle. */
export function tileRectOfPx(x0: number, y0: number, x1: number, y1: number): TileRect {
  return { x0: tileOf(x0), y0: tileOf(y0), x1: tileOf(x1 - 1e-6), y1: tileOf(y1 - 1e-6) };
}
