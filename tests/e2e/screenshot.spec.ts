import { expect, test } from '@playwright/test';
import { bootGame, freezeLoop, setCamera } from './helpers/page';
import { compareToBaseline, describeDiff } from './helpers/imageDiff';

/**
 * Visual regression.
 *
 * Every scene is captured in static mode, which freezes the ocean scroll, the
 * selection pulse and the combat flash, so a matching render is byte-stable.
 * The camera is set explicitly rather than left at the default framing, which
 * would shift whenever the map is rebuilt and make every diff a false alarm.
 *
 * Run with UPDATE_SNAPSHOTS=1 to re-baseline after an intentional visual change.
 */

const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

/** A tile counts as changed above this fraction of differing pixels. */
const TILE_THRESHOLD = 0.02;
/** How many 32px tiles may change before a scene is considered regressed. */
const MAX_HOT_TILES = 4;

interface Scene {
  name: string;
  /** Where to point the camera, in degrees. */
  lon: number;
  lat: number;
  zoom: number;
  setup?: (page: import('@playwright/test').Page) => Promise<void>;
}

const SCENES: Scene[] = [
  { name: 'europe-wide', lon: 12.2, lat: 52.7, zoom: 0.055 },
  { name: 'central-europe', lon: 10.7, lat: 51.3, zoom: 0.18 },
  { name: 'germany-close', lon: 12.5, lat: 52.0, zoom: 0.42 },
  { name: 'mediterranean', lon: 16.4, lat: 43.7, zoom: 0.12 },
  { name: 'scandinavia', lon: 16.0, lat: 60.8, zoom: 0.12 },
  {
    name: 'terrain-mode',
    lon: 10.7, lat: 51.3, zoom: 0.18,
    setup: async (page) => {
      await page.evaluate(() => window.__game!.setMapMode('terrain'));
    },
  },
  {
    name: 'resource-mode',
    lon: 10.7, lat: 51.3, zoom: 0.18,
    setup: async (page) => {
      await page.evaluate(() => window.__game!.setMapMode('resource'));
    },
  },
  {
    name: 'province-selected',
    lon: 10.7, lat: 51.3, zoom: 0.22,
    setup: async (page) => {
      await page.evaluate(() => {
        const g = window.__game!;
        const fra = g.index.provinces.find((p) => p.ownerTag === 'FRA')!;
        g.selectProvince(fra.id);
      });
    },
  },
];

test.describe('visual regression', () => {
  for (const scene of SCENES) {
    test(`scene: ${scene.name}`, async ({ page }) => {
      const errors = await bootGame(page, { seed: 20250101 });
      await freezeLoop(page);
      await setCamera(page, scene.lon, scene.lat, scene.zoom);
      await scene.setup?.(page);
      // Two settled frames: one to apply the change, one to draw it.
      await page.evaluate(() => {
        const g = window.__game!;
        g.tickFrame(16.667);
        g.tickFrame(16.667);
      });
      await page.waitForTimeout(200);

      const shot = await page.screenshot({ animations: 'disabled' });
      const result = compareToBaseline(scene.name, shot, {
        tileThreshold: TILE_THRESHOLD,
        update: UPDATE,
      });
      console.log(describeDiff(scene.name, result));

      expect(errors, errors.join('\n')).toEqual([]);
      if (result.status === 'created') {
        test.info().annotations.push({ type: 'baseline', description: 'created' });
        return;
      }
      expect(result.status, `${scene.name} viewport changed`).not.toBe('size-changed');
      expect(
        result.hotTiles.length,
        `${describeDiff(scene.name, result)}\n  diff image: ${result.diffPath ?? 'n/a'}`,
      ).toBeLessThanOrEqual(MAX_HOT_TILES);
    });
  }

  test('the same seed renders identically twice', async ({ page }) => {
    await bootGame(page, { seed: 4242 });
    await freezeLoop(page);
    await setCamera(page, 10.7, 51.3, 0.18);
    const first = await page.screenshot({ animations: 'disabled' });

    await page.reload();
    await page.waitForFunction(() => window.__gameReady === true, null, { timeout: 90_000 });
    await page.waitForTimeout(700);
    await freezeLoop(page);
    await setCamera(page, 10.7, 51.3, 0.18);
    const second = await page.screenshot({ animations: 'disabled' });

    const r = compareToBaseline('determinism-check', second, {
      update: true,
    });
    expect(r.status).toBe('created');
    // Compare the two runs against each other rather than a stored baseline.
    const cmp = compareToBaseline('determinism-check', first, { tileThreshold: TILE_THRESHOLD });
    console.log(describeDiff('determinism', cmp));
    expect(cmp.hotTiles.length).toBe(0);
  });
});
