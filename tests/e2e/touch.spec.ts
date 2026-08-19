import { expect, test } from '@playwright/test';
import {
  bootGame, cameraState, canvasCentre, openMapPoint, pinch, provinceScreenPos,
  setCamera, swipe, tapAt,
} from './helpers/page';

test.describe('touch input', () => {
  test('boots without errors and reports a sane opening state', async ({ page }) => {
    const errors = await bootGame(page);
    const info = await page.evaluate(() => {
      const g = window.__game!;
      return {
        provinces: g.index.count,
        countries: g.state.countries.length,
        divisions: g.state.divisions.filter((d) => !d.dead).length,
        zoom: g.renderer.camera.zoom,
      };
    });
    expect(errors, errors.join('\n')).toEqual([]);
    expect(info.provinces).toBeGreaterThan(20);
    expect(info.countries).toBeGreaterThan(20);
    expect(info.divisions).toBeGreaterThan(50);
    expect(info.zoom).toBeGreaterThan(0);
  });

  test('one-finger drag pans the camera in the drag direction', async ({ page }) => {
    await bootGame(page);
    await setCamera(page, 0, 0, 0.2);
    const before = await cameraState(page);
    const c = await canvasCentre(page);

    await swipe(page, { x: c.x + 90, y: c.y + 90 }, { x: c.x - 90, y: c.y - 90 });
    await page.waitForTimeout(400);
    const after = await cameraState(page);

    // Dragging content left/up moves the camera right/down.
    expect(after.x).toBeGreaterThan(before.x + 100);
    expect(after.y).toBeGreaterThan(before.y + 100);
    expect(after.zoom).toBeCloseTo(before.zoom, 4);
  });

  test('pinch out zooms in', async ({ page }) => {
    await bootGame(page);
    await setCamera(page, 0, 0, 0.15);
    const c = await openMapPoint(page);
    const before = await cameraState(page);
    await pinch(page, c, 40, 150);
    const after = await cameraState(page);
    expect(after.zoom).toBeGreaterThan(before.zoom * 1.8);
  });

  test('pinch in zooms out', async ({ page }) => {
    await bootGame(page);
    await setCamera(page, 0, 0, 0.45);
    const c = await openMapPoint(page);
    const before = await cameraState(page);
    await pinch(page, c, 150, 40);
    const after = await cameraState(page);
    expect(after.zoom).toBeLessThan(before.zoom * 0.6);
  });

  test('pinch keeps the anchored world point under the fingers', async ({ page }) => {
    await bootGame(page);
    await setCamera(page, 0, 0, 0.25);
    const c = await openMapPoint(page);

    const read = () => page.evaluate((pt) => {
      const g = window.__game!;
      const box = g.renderer.canvas.getBoundingClientRect();
      return {
        x: g.renderer.camera.screenToWorldX(pt.x - box.left),
        y: g.renderer.camera.screenToWorldY(pt.y - box.top),
      };
    }, c);

    const before = await read();
    await pinch(page, c, 50, 160);
    const after = await read();
    expect(Math.abs(after.x - before.x)).toBeLessThan(40);
    expect(Math.abs(after.y - before.y)).toBeLessThan(40);
  });

  test('a violent pinch cannot exceed the zoom limits', async ({ page }) => {
    await bootGame(page);
    const limits = await page.evaluate(() => {
      const cam = window.__game!.renderer.camera;
      return { min: cam.minZoom, max: cam.maxZoom };
    });
    await setCamera(page, 0, 0, limits.max * 0.9);
    const c = await openMapPoint(page);
    await pinch(page, c, 10, 160, 16);
    const after = await cameraState(page);
    expect(after.zoom).toBeLessThanOrEqual(limits.max + 1e-6);
    expect(after.zoom).toBeGreaterThanOrEqual(limits.min - 1e-6);
  });

  test('tapping a province selects it and opens the info sheet', async ({ page }) => {
    await bootGame(page);
    await page.evaluate(() => {
      const g = window.__game!;
      const p = g.index.provinces.find((q) => q.ownerTag === 'FRA')!;
      g.renderer.camera.centerOn(p.centerX, p.centerY);
      g.renderer.camera.zoom = 0.25;
      g.tickFrame(16);
    });
    const pos = await provinceScreenPos(page, 'FRA');
    await tapAt(page, pos.x, pos.y);

    const selected = await page.evaluate(() => window.__game!.selection.province);
    expect(selected).toBe(pos.id);
    await expect(page.locator('.hud-sheet')).toHaveClass(/is-open/);
    await expect(page.locator('.hud-sheet-title')).toHaveText('France');
  });

  test('a drag does not register as a tap', async ({ page }) => {
    await bootGame(page);
    await setCamera(page, 0, 0, 0.2);
    const c = await canvasCentre(page);
    await swipe(page, { x: c.x, y: c.y }, { x: c.x - 150, y: c.y });
    const selected = await page.evaluate(() => window.__game!.selection.province);
    expect(selected).toBeNull();
  });

  test('dragging from a selected friendly stack issues a move order', async ({ page }) => {
    await bootGame(page);

    // Frame Germany and its eastern neighbour, then select the German stack.
    const setup = await page.evaluate(() => {
      const g = window.__game!;
      const ger = g.index.provinces.find((p) => p.ownerTag === 'GER')!;
      const target = g.index.provinces.find((p) => p.ownerTag === 'POL')!;
      g.renderer.camera.centerOn(
        (ger.centerX + target.centerX) / 2,
        (ger.centerY + target.centerY) / 2,
      );
      g.renderer.camera.zoom = 0.22;
      g.tickFrame(16);
      g.selectProvince(ger.id);
      return { from: ger.id, to: target.id, selected: g.selection.divisions.length };
    });
    expect(setup.selected).toBeGreaterThan(0);

    const from = await provinceScreenPos(page, 'GER');
    const to = await provinceScreenPos(page, 'POL');
    await swipe(page, from, to, 16);
    await page.waitForTimeout(200);

    const issued = await page.evaluate(() => {
      const g = window.__game!;
      // The queue drains on the next simulation hour; step one to flush it.
      const seen: unknown[] = [];
      g.onCommand = (_state, cmd) => { seen.push(cmd); };
      g.stepHours(1);
      return seen;
    });
    expect(issued.length).toBeGreaterThan(0);
    expect(issued[0]).toMatchObject({ t: 'moveDivisions', target: setup.to });
  });

  test('map mode buttons recolour without errors', async ({ page }) => {
    const errors = await bootGame(page);
    for (const mode of ['terrain', 'resource', 'supply', 'victory', 'political']) {
      await page.locator(`.hud-mode[data-mode="${mode}"]`).click();
      const active = await page.evaluate(() => window.__game!.renderer.mapMode);
      expect(active).toBe(mode);
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('speed controls drive the clock', async ({ page }) => {
    await bootGame(page, { static: false });
    await page.locator('.hud-pip[data-speed="5"]').click();
    expect(await page.evaluate(() => window.__game!.speed)).toBe(5);

    const before = await page.evaluate(() => window.__game!.state.clock.totalHours);
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => window.__game!.state.clock.totalHours);
    expect(after).toBeGreaterThan(before);

    await page.locator('.hud-pause').click();
    expect(await page.evaluate(() => window.__game!.speed)).toBe(0);
    const paused = await page.evaluate(() => window.__game!.state.clock.totalHours);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__game!.state.clock.totalHours)).toBe(paused);
  });

  test('the page itself never scrolls or browser-zooms', async ({ page }) => {
    await bootGame(page);
    const c = await canvasCentre(page);
    await swipe(page, { x: c.x, y: c.y + 200 }, { x: c.x, y: c.y - 200 });
    await pinch(page, c, 40, 160);
    const scroll = await page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
      visualScale: window.visualViewport?.scale ?? 1,
    }));
    expect(scroll.x).toBe(0);
    expect(scroll.y).toBe(0);
    expect(scroll.visualScale).toBeCloseTo(1, 2);
  });
});
