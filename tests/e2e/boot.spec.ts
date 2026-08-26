import { expect, test } from '@playwright/test';

/**
 * Delivery paths.
 *
 * The game reaching a phone is a feature: a boot screen whose static text is
 * identical to its first progress message says nothing when the bundle never
 * runs at all, so a failed load and a slow one used to look identical.
 */

test.describe('boot', () => {
  test('recovers once from a stale chunk, then reports instead of hanging', async ({ page }) => {
    // Exactly what a returning visitor sees after a deploy: the page they have
    // cached asks for a chunk whose content hash no longer exists.
    let served = 0;
    await page.route('**/assets/index-*.js', (route) => {
      served++;
      return route.abort();
    });

    await page.goto('/?static=1');

    const detail = page.locator('.boot-detail');
    await expect(detail).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#boot-status')).toContainText('読み込めませんでした');

    // One reload, not a loop. Each document asks for the entry chunk once, so
    // two requests is one retry -- and the count is what to assert on, not the
    // page's load events: the guard calls reload() from a parse-time script
    // error, which cancels the first document before it ever reaches `load`.
    expect(served, 'should retry exactly once').toBe(2);
    await page.waitForTimeout(1500);
    expect(served, 'and then stop, rather than refresh forever').toBe(2);

    // And it names the real cause. It used to claim the page was a development
    // entry point serving TypeScript, which is false for a hashed build
    // artefact and sent the reader to look at the build pipeline.
    const text = await detail.textContent();
    expect(text).toContain('古いページ');
    expect(text).not.toContain('npm run build');
  });

  test('recovers when the chunk comes back, as after a deploy settles', async ({ page }) => {
    let first = true;
    await page.route('**/assets/index-*.js', (route) => {
      if (first) { first = false; return route.abort(); }
      return route.continue();
    });
    await page.goto('/?static=1');
    // No message at all: the reload found the current chunk and the game ran.
    await page.waitForFunction(() => window.__gameReady === true, null, { timeout: 60_000 });
    await expect(page.locator('.boot-detail')).toHaveCount(0);
  });
});
