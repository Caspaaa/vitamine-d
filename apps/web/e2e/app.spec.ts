import { expect, test, type Page } from '@playwright/test';

// Needs the height tiles (`pnpm data:link`, served by `pnpm dev`). Pixel-exact shadow correctness is covered by
// packages/shadow/harness; these tests check that the app wires sun, time, map, search and language together.

const FLAGEY = 'lat=50.8273&lng=4.3722&z=17';

type Debug = { __vitamine: { map: { getCenter(): { lat: number } }; layer: { status: { state: string } } } };

async function openReady(page: Page, search: string, path = '/en/') {
  await page.goto(`${path}?${search}`);
  await page.waitForFunction(() => (window as unknown as Partial<Debug>).__vitamine?.layer?.status?.state === 'ready');
  await page.waitForTimeout(1200); // let the first frame with shadows land
}

const mapPixels = (page: Page) => page.getByRole('application').screenshot();

test('shows shadows, and scrubbing the time changes them', async ({ page }) => {
  await openReady(page, `${FLAGEY}&t=2026-05-20T18:30`);
  const evening = await mapPixels(page);

  await page.getByRole('slider', { name: 'Time of day' }).fill('300'); // morning, sun from the other side
  await page.waitForTimeout(1500);
  const morning = await mapPixels(page);

  expect(evening.equals(morning)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as Debug).__vitamine.layer.status.state)).toBe('ready');
});

test('night means everything in shade, and says so', async ({ page }) => {
  await openReady(page, `${FLAGEY}&t=2026-06-21T23:30`);
  await expect(page.getByText('The sun is below the horizon: everything is in shade.')).toBeVisible();
});

test('the date and time live in the URL, and "Now" drops them', async ({ page }) => {
  await openReady(page, FLAGEY);
  await page.getByLabel('Date').fill('2026-07-14');
  await expect.poll(() => new URL(page.url()).searchParams.get('t')).toMatch(/^2026-07-14T/);
  await page.getByRole('button', { name: 'Now' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has('t')).toBe(false);
});

test('searching an address flies the map there', async ({ page }) => {
  await page.route('https://photon.komoot.io/**', (route) =>
    route.fulfill({
      json: { features: [{ geometry: { coordinates: [4.3722, 50.8273] }, properties: { name: 'Place Eugène Flagey', postcode: '1050', city: 'Ixelles', osm_type: 'N', osm_id: 1 } }] },
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
  await openReady(page, 'lat=50.8467&lng=4.3525&z=16.5');
  await page.getByRole('combobox', { name: 'Search an address' }).fill('Flagey');
  await page.getByRole('option', { name: /Flagey/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Debug).__vitamine.map.getCenter().lat)).toBeCloseTo(50.8273, 2);
});

test('switching language keeps the time and the view', async ({ page }) => {
  await openReady(page, `${FLAGEY}&t=2026-05-20T18:30`);
  await page.getByRole('combobox', { name: 'Language' }).selectOption('fr');
  await page.waitForURL(/\/fr\//);
  expect(page.url()).toContain('t=2026-05-20T18%3A30');
  expect(page.url()).toContain('lat=50.8273');
  await expect(page.getByRole('button', { name: 'Maintenant' })).toBeVisible();
});

test.describe('locate me', () => {
  test.describe('inside Brussels', () => {
    test.use({ permissions: ['geolocation'], geolocation: { latitude: 50.8273, longitude: 4.3722, accuracy: 20 } });

    test('flies to the position', async ({ page }) => {
      await openReady(page, 'lat=50.8467&lng=4.3525&z=16');
      await page.getByRole('button', { name: 'Show my location' }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as Debug).__vitamine.map.getCenter().lat)).toBeCloseTo(50.8273, 2);
    });
  });

  test.describe('outside Brussels', () => {
    test.use({ permissions: ['geolocation'], geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 20 } });

    test('says shadows only cover Brussels, and stays put', async ({ page }) => {
      await openReady(page, 'lat=50.8467&lng=4.3525&z=16');
      await page.getByRole('button', { name: 'Show my location' }).click();
      await expect(page.getByText(/outside Brussels/)).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as Debug).__vitamine.map.getCenter().lat)).toBeCloseTo(50.8467, 2);
    });
  });

  test.describe('permission denied', () => {
    test('asks for an address instead', async ({ page }) => {
      await openReady(page, 'lat=50.8467&lng=4.3525&z=16');
      await page.getByRole('button', { name: 'Show my location' }).click();
      await expect(page.getByText(/Type an address instead/)).toBeVisible();
    });
  });
});
