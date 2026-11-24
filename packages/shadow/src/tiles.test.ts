import { describe, expect, it } from 'vitest';
import { TileIndex, TileSource, buildTileMips, decodeHeightTile, type HeightTile, type TileFetcher } from './tiles.ts';

const tile = (v: number): HeightTile => ({ level0: new Uint16Array(65536).fill(v), maxValue: v });
const index = new TileIndex({ zoom: 17, tileSize: 256, offset: 10, step: 0.25, count: 5, rows: { '10': [[1, 3]], '11': [[2, 3]] } });

describe('tile index', () => {
  it('knows which tiles exist', () => {
    expect(index.has(1, 10) && index.has(3, 10) && index.has(2, 11)).toBe(true);
    expect(index.has(4, 10)).toBe(false);
    expect(index.has(1, 11)).toBe(false);
    expect(index.has(1, 12)).toBe(false);
  });
});

describe('tile source', () => {
  it('answers peek() for known-empty tiles without fetching and caches loaded ones', async () => {
    let calls = 0;
    const src = new TileSource(index, async (x) => (calls++, tile(x)), {});
    expect(src.peek(9, 9)).toBeNull(); // not in the index: known to be empty
    expect(src.peek(1, 10)).toBeUndefined(); // exists, not loaded yet
    expect((await src.request(1, 10))!.maxValue).toBe(1);
    expect(src.peek(1, 10)!.maxValue).toBe(1);
    await src.request(1, 10);
    expect(calls).toBe(1);
  });

  it('shares one request between callers', async () => {
    let calls = 0;
    const src = new TileSource(index, async () => (calls++, tile(5)), {});
    await Promise.all([src.request(2, 10), src.request(2, 10), src.request(2, 10)]);
    expect(calls).toBe(1);
  });

  it('starts the lowest priority number first and never exceeds the concurrency', async () => {
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const fetcher: TileFetcher = async (x) => {
      started.push(x);
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return tile(x);
    };
    const src = new TileSource(index, fetcher, { concurrency: 1 });
    const all = [src.request(1, 10, 3), src.request(2, 10, 1), src.request(3, 10, 2)];
    await Promise.all(all);
    expect(started).toEqual([1, 2, 3]); // (1, 10) was already running; the queued two ran in priority order
    expect(peak).toBe(1);
  });

  it('cancels queued requests that are no longer wanted', async () => {
    const src = new TileSource(index, async (x) => (await new Promise((r) => setTimeout(r, 5)), tile(x)), { concurrency: 1 });
    const a = src.request(1, 10, 0);
    const b = src.request(2, 10, 1);
    const c = src.request(3, 10, 2);
    src.cancelQueued((x) => x === 3);
    await expect(b).rejects.toThrow('cancelled');
    expect((await a)!.maxValue).toBe(1);
    expect((await c)!.maxValue).toBe(3);
  });

  it('forgets the oldest tiles beyond the cache size', async () => {
    const src = new TileSource(index, async (x, y) => tile(x * 10 + (y - 10)), { cacheSize: 2 });
    await src.request(1, 10);
    await src.request(2, 10);
    await src.request(3, 10);
    expect(src.peek(1, 10)).toBeUndefined();
    expect(src.peek(3, 10)).toBeDefined();
  });
});

describe('height tiles', () => {
  it('decodes the two bytes per pixel the pipeline writes', () => {
    const rgba = new Uint8Array(65536 * 4);
    rgba.set([0x01, 0x40, 0, 255], 0); // 0x0140 = 320 = 70 m with offset 10 and step 0.25
    rgba.set([0x00, 0x00, 0, 255], 4); // no data
    const t = decodeHeightTile(rgba);
    expect(t.level0[0]).toBe(320);
    expect(t.level0[1]).toBe(0);
    expect(t.maxValue).toBe(320);
  });

  it('builds a max-reduced mip chain whose top level is the tile maximum', () => {
    const l0 = new Uint16Array(65536);
    l0[12345] = 777;
    l0[3] = 500;
    const mips = buildTileMips(l0);
    expect(mips.length).toBe(8);
    expect(mips.map((m) => m.length)).toEqual([65536, 16384, 4096, 1024, 256, 64, 16, 4]);
    expect(Math.max(...mips[7]!)).toBe(777);
    // each level-1 texel is the max of its 2 x 2 block
    expect(mips[1]![Math.floor(12345 / 256 / 2) * 128 + Math.floor((12345 % 256) / 2)]).toBe(777);
    expect(mips[1]![1]).toBe(500);
  });
});
