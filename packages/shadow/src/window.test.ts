import { describe, expect, it } from 'vitest';
import {
  WINDOW_TILES, chooseOrigin, intersect, rectContains, shrink, slotOf, tileRectOfPx, windowRect, windowShift, type TileRect,
} from './window.ts';

const rect = (x0: number, y0: number, x1: number, y1: number): TileRect => ({ x0, y0, x1, y1 });

describe('ring buffer slots', () => {
  it('maps tiles to slots modulo 16, also for large coordinates', () => {
    expect(slotOf(0, 0)).toEqual([0, 0]);
    expect(slotOf(15, 16)).toEqual([15, 0]);
    expect(slotOf(67110, 43961)).toEqual([67110 % 16, 43961 % 16]);
  });

  it('gives every tile of any 16 x 16 window its own slot', () => {
    const seen = new Set<string>();
    const o = windowRect([67113, 43970]);
    for (let y = o.y0; y <= o.y1; y++) for (let x = o.x0; x <= o.x1; x++) seen.add(slotOf(x, y).join(','));
    expect(seen.size).toBe(WINDOW_TILES * WINDOW_TILES);
  });
});

describe('window origin', () => {
  it('centres the needed rectangle', () => {
    const need = rect(100, 200, 109, 211); // 10 x 12 tiles
    const o = chooseOrigin(need);
    expect(o).toEqual([97, 198]);
    expect(rectContains(windowRect(o), need)).toBe(true);
    expect(need.x0 - o[0]).toBe(o[0] + 15 - need.x1); // equal slack left and right (3 and 3)
  });

  it('keeps a full-width need inside the window and copes with a need that is too wide', () => {
    expect(rectContains(windowRect(chooseOrigin(rect(5, 5, 20, 20))), rect(5, 5, 20, 20))).toBe(true);
    const o = chooseOrigin(rect(0, 0, 19, 4)); // 20 wide: cannot fit, so it is centred (tiles 2..17 of 0..19) and must not throw
    expect(o[0]).toBe(2);
  });
});

describe('window shift', () => {
  it('lists the tiles that leave and enter, and they share slots one to one', () => {
    const { leaving, entering } = windowShift([100, 100], [103, 100]);
    expect(leaving.length).toBe(3 * 16);
    expect(entering.length).toBe(3 * 16);
    expect(new Set(leaving.map(([x, y]) => slotOf(x, y).join(','))).size).toBe(leaving.length);
    expect(new Set(entering.map(([x, y]) => slotOf(x, y).join(','))).size).toBe(entering.length);
    for (const [x, y] of entering) expect(leaving.some(([lx, ly]) => slotOf(lx, ly).join() === slotOf(x, y).join())).toBe(true);
  });

  it('treats the first window as all entering and a far jump as everything leaving', () => {
    expect(windowShift(null, [5, 5]).entering.length).toBe(256);
    const far = windowShift([0, 0], [1000, 1000]);
    expect(far.leaving.length).toBe(256);
    expect(far.entering.length).toBe(256);
  });

  it('is a no-op for the same origin', () => {
    expect(windowShift([7, 8], [7, 8])).toEqual({ leaving: [], entering: [] });
  });
});

describe('rectangles', () => {
  it('intersects and shrinks', () => {
    expect(intersect(rect(0, 0, 5, 5), rect(4, 4, 9, 9))).toEqual(rect(4, 4, 5, 5));
    expect(intersect(rect(0, 0, 1, 1), rect(3, 3, 4, 4))).toBeNull();
    expect(shrink(rect(0, 0, 9, 9), 1)).toEqual(rect(1, 1, 8, 8));
  });

  it('converts world pixels to the tiles they touch', () => {
    expect(tileRectOfPx(0, 0, 256, 256)).toEqual(rect(0, 0, 0, 0)); // an exact tile does not touch the next
    expect(tileRectOfPx(255.5, 0, 256.5, 1)).toEqual(rect(0, 0, 1, 0));
    expect(tileRectOfPx(300, 600, 700, 700)).toEqual(rect(1, 2, 2, 2));
  });
});
