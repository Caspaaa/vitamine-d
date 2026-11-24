import { expect, test } from '@playwright/test';

// The harness renders a synthetic world through the real ring buffer and shader (harness/main.ts) and records its checks.
test('GPU shadow engine: analytic wall shadow across the ring wrap, window shifts, no ghosts, mirrored sun, night', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __results?: unknown }).__results !== undefined);
  const results = await page.evaluate(() => (window as unknown as { __results: Record<string, unknown> }).__results);

  expect(results.error).toBeUndefined();
  expect(results, JSON.stringify(results)).toMatchObject({
    A_ok: true, // wall shadow length within 1.5 px of the analytic value, across the slot 15 → 0 wrap
    B_ok: true, // identical mask after the window shifted by 4 tiles
    C_ok: true, // identical mask after a full reset
    D_ok: true, // no ghost shadow from tiles that left the window
    E_ok: true, // sun in the east mirrors the shadow
    F_nightAllShade: true,
    ALL_OK: true,
  });
});
