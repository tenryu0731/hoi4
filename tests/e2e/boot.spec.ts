import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Delivery paths.
 *
 * The game reaching a phone is a feature, and it has failed twice in ways the
 * rest of the suite could not see: a boot screen whose static text is identical
 * to its first progress message says nothing when the bundle never runs, and a
 * served build is no use to someone who cannot run a server at all.
 */

const SINGLE_FILE = join(process.cwd(), 'dist-single', 'iron-front.html');

test.describe('boot', () => {
  test('reports a bundle that fails to load instead of hanging', async ({ page }) => {
    // Exactly what a mis-served build looks like to the browser.
    await page.route('**/assets/index-*.js', (route) => route.abort());
    await page.goto('/?static=1');

    const detail = page.locator('.boot-detail');
    await expect(detail).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#boot-status')).toContainText('Could not load the game code');
    expect(await detail.textContent()).toContain('npm run build');
  });

  test('the single-file build runs straight off the filesystem', async ({ page }) => {
    test.skip(!existsSync(SINGLE_FILE), 'run npm run build:single first');

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    // Nothing may be requested over the network: that is the whole point.
    const requested: string[] = [];
    page.on('request', (r) => { if (!r.url().startsWith('file:')) requested.push(r.url()); });

    await page.goto(`${pathToFileURL(SINGLE_FILE).href}?static=1`);
    await page.waitForFunction(() => window.__gameReady === true, null, { timeout: 90_000 });
    await page.waitForTimeout(700);

    expect(errors, errors.join('\n')).toEqual([]);
    expect(requested, requested.join('\n')).toEqual([]);

    // The embedded map and artwork both have to survive the packing.
    const summary = await page.evaluate(() => ({
      provinces: window.__game!.index.provinces.length,
      countries: window.__game!.state.countries.length,
      broken: [...document.querySelectorAll('img')]
        .filter((i) => !i.complete || i.naturalWidth === 0).length,
      images: document.querySelectorAll('img').length,
    }));
    expect(summary.provinces).toBeGreaterThan(300);
    expect(summary.countries).toBe(30);
    expect(summary.images).toBeGreaterThan(5);
    expect(summary.broken).toBe(0);
  });
});
