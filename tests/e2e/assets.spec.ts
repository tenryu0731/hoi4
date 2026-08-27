import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { bootGame } from './helpers/page';
import { EQUIPMENT_TYPES } from '../../src/sim/core/types';

/**
 * Asset budget and load time.
 *
 * A budget that is not measured is not a budget. These thresholds are set well
 * above what the generated set actually costs, so they catch a regression --
 * someone dropping in a bitmap flag sheet -- rather than tracking noise.
 */

const BUDGET = {
  /** Every generated asset, uncompressed. */
  totalAssetBytes: 300 * 1024,
  /**
   * The baked map, uncompressed on disk.
   *
   * It has grown twice. First when provinces stopped being invented and became
   * cells of the world's real administrative units; then again when their
   * number was matched to the reference's, which is 4,351 provinces inside 425
   * states. 2.1 MB flat is 571 KB gzipped, and GitHub Pages -- what actually
   * serves this -- gzips. The preview server the first-load budget below is
   * measured against does not, which is why that number is the larger of the
   * two.
   */
  mapBytes: 2400 * 1024,
  /** Largest single asset. */
  largestAssetBytes: 8 * 1024,
  /** Wall time from navigation to a playable game, on a mobile viewport. */
  bootMs: 12_000,
  /**
   * Network bytes for the whole first load, off the uncompressed preview
   * server. A real host gzips: the same load is about 1 MB from GitHub Pages,
   * of which 571 KB is the map.
   */
  firstLoadBytes: 4 * 1024 * 1024,
};

interface Manifest {
  counts: Record<string, number>;
  totalBytes: number;
  totalGzipBytes: number;
  assets: { path: string; bytes: number; gzipBytes: number }[];
}

test.describe('assets', () => {
  test('the generated set stays inside its size budget', () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'public', 'assets', 'manifest.json'), 'utf8'),
    ) as Manifest;

    const largest = manifest.assets.reduce((a, b) => (a.bytes > b.bytes ? a : b));
    console.log(
      `assets: ${manifest.assets.length} files, ` +
      `${(manifest.totalBytes / 1024).toFixed(1)} KB ` +
      `(${(manifest.totalGzipBytes / 1024).toFixed(1)} KB gzipped), ` +
      `largest ${largest.path} at ${largest.bytes} B`,
    );

    expect(manifest.totalBytes).toBeLessThan(BUDGET.totalAssetBytes);
    expect(largest.bytes).toBeLessThan(BUDGET.largestAssetBytes);
    // The inventory itself is part of the contract: a missing flag is a broken
    // top bar, and a missing unit icon is a blank counter.
    expect(manifest.counts.flags).toBeGreaterThanOrEqual(30);
    expect(manifest.counts.resourceIcons).toBe(6);
    expect(manifest.counts.unitIcons).toBeGreaterThanOrEqual(12);
    expect(manifest.counts.uiIcons).toBeGreaterThanOrEqual(14);
    // One silhouette per equipment type. A missing one is a production row
    // with a hole in it where the thing being built should be.
    expect(manifest.counts.equipmentIcons).toBe(EQUIPMENT_TYPES.length);
  });

  test('the baked map stays inside its size budget', () => {
    const bytes = readFileSync(join(process.cwd(), 'public', 'data', 'map.json')).byteLength;
    console.log(`map.json: ${(bytes / 1024).toFixed(0)} KB`);
    expect(bytes).toBeLessThan(BUDGET.mapBytes);
  });

  test('boots quickly and pulls a reasonable amount over the wire', async ({ page }) => {
    // Body sizes rather than content-length: the preview server serves most
    // responses chunked, so the header is absent and would report near zero.
    let transferred = 0;
    const failures: string[] = [];
    const pending: Promise<void>[] = [];
    page.on('response', (res) => {
      if (res.status() >= 400) failures.push(`${res.status()} ${res.url()}`);
      pending.push(
        res.body().then((b) => { transferred += b.byteLength; }).catch(() => {}),
      );
    });

    const started = Date.now();
    const errors = await bootGame(page);
    const bootMs = Date.now() - started;
    await Promise.all(pending);

    console.log(
      `boot: ${bootMs}ms, ${(transferred / 1024).toFixed(0)} KB transferred`,
    );
    expect(failures, failures.join('\n')).toEqual([]);
    expect(errors, errors.join('\n')).toEqual([]);
    expect(bootMs).toBeLessThan(BUDGET.bootMs);
    expect(transferred).toBeLessThan(BUDGET.firstLoadBytes);
  });

  test('every flag, icon and unit symbol the UI asks for exists', async ({ page }) => {
    const missing: string[] = [];
    page.on('response', (res) => {
      if (res.status() === 404) missing.push(res.url());
    });
    await bootGame(page);

    // Touch every panel so their icons and images are requested.
    for (const panel of ['production', 'construction', 'army', 'diplomacy']) {
      await page.locator(`.hud-nav-btn[data-panel="${panel}"]`).click();
      await page.waitForTimeout(150);
    }

    // And every nation's flag, which the top bar swaps in per player country.
    const tags = await page.evaluate(() =>
      window.__game!.state.countries.map((c) => c.tag));
    for (const tag of tags) {
      const ok = await page.evaluate(async (t) => {
        const res = await fetch(`assets/flags/${t}.svg`);
        return res.ok;
      }, tag);
      expect(ok, `flag for ${tag}`).toBe(true);
    }

    expect(missing, missing.join('\n')).toEqual([]);
  });
});
