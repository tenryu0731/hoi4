import { expect, test } from '@playwright/test';

/**
 * Delivery paths.
 *
 * The game reaching a phone is a feature: a boot screen whose static text is
 * identical to its first progress message says nothing when the bundle never
 * runs at all, so a failed load and a slow one used to look identical.
 */

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
});
