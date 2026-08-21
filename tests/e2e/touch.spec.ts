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
    // The sheet is titled with the place, and names its owner underneath.
    const expected = await page.evaluate((id) => window.__game!.index.get(id).name, pos.id);
    await expect(page.locator('.hud-sheet-title')).toHaveText(expected);
    await expect(page.locator('.panel-sub')).toContainText('フランス');
  });

  test('a slow tap still selects', async ({ page }) => {
    // A thumb resting for a third of a second is an ordinary tap, not a
    // gesture. This used to fall between the tap deadline and the hold timer
    // and register as nothing at all.
    await bootGame(page);
    await page.evaluate(() => {
      const g = window.__game!;
      const p = g.index.provinces.find((q) => q.ownerTag === 'FRA')!;
      g.renderer.camera.centerOn(p.centerX, p.centerY);
      g.renderer.camera.zoom = 0.25;
      g.tickFrame(16);
    });
    const pos = await provinceScreenPos(page, 'FRA');
    await tapAt(page, pos.x, pos.y, 360);

    expect(await page.evaluate(() => window.__game!.selection.province)).toBe(pos.id);
    await expect(page.locator('.hud-sheet')).toHaveClass(/is-open/);
  });

  test('a drag does not register as a tap', async ({ page }) => {
    await bootGame(page);
    await setCamera(page, 0, 0, 0.2);
    const c = await canvasCentre(page);
    await swipe(page, { x: c.x, y: c.y }, { x: c.x - 150, y: c.y });
    const selected = await page.evaluate(() => window.__game!.selection.province);
    expect(selected).toBeNull();
  });

  /*
   * Retried, and only this one.
   *
   * Chromium's synthetic touch delivery under SwiftShader drops a gesture once
   * the suite has been running for ten minutes. Measured: with the framing
   * asserted, this test passes 10 of 10 repeats on its own and fails roughly
   * once per full-suite run, at which point the controller has recorded no
   * press at all -- no drag phase, no camera movement -- while the selection is
   * intact and both endpoints hit the canvas well clear of the HUD. Retrying by
   * hand inside the test made it worse, because the first gesture sometimes
   * does arrive and pans the camera, leaving the second one's coordinates
   * stale. Playwright's own retry starts from a fresh page and does not have
   * that problem.
   *
   * The retry is scoped here rather than set globally so that a genuine
   * regression anywhere else still fails on the first run.
   */

  test.describe('the drag order', () => {
    test.describe.configure({ retries: 2 });

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
      // Both ends have to be on the map before the finger goes down. The
      // gesture's geometry is what decides this test: at zoom 0.42 the target
      // province leaves the viewport and seven runs in ten fail, and at 0.22 the
      // margins are thin enough to fail about one in ten. Asserting the framing
      // turns a flake into a message that says which end was off.
      const frame = await page.evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
        top: document.querySelector('.hud-top')!.getBoundingClientRect().bottom,
        nav: document.querySelector('.hud-nav')!.getBoundingClientRect().top,
      }));
      const onMap = (pt: { x: number; y: number }) => pt.x > 24 && pt.x < frame.w - 24
        && pt.y > frame.top + 24 && pt.y < frame.nav - 24;
      expect(onMap(from), `drag start ${JSON.stringify(from)} is off the map ${JSON.stringify(frame)}`)
        .toBe(true);
      expect(onMap(to), `drag end ${JSON.stringify(to)} is off the map ${JSON.stringify(frame)}`)
        .toBe(true);

      // A deliberate press, then the stroke: the order candidacy is decided at
      // press time, and moving in the same millisecond as the press races it.
      await swipe(page, from, to, 24, 150);

      // Waits for the order rather than a fixed delay: it is applied
      // synchronously when the gesture ends, but the events themselves arrive
      // late under a full-suite load.
      await page.waitForFunction((target) => {
        const g = window.__game!;
        return g.selection.divisions.length > 0
          && g.selection.divisions.every((d) => {
            const order = g.state.divisions[d].order;
            return order?.kind === 'move' && order.target === target;
          });
      }, setup.to, { timeout: 10_000 });

      // The order must be live on the divisions without the clock being stepped.
      // Pausing to give orders is how this genre is played, and a queue that is
      // only read on the hour never runs at all while the game is paused.
      const ordered = await page.evaluate(() => {
        const g = window.__game!;
        return g.selection.divisions.map((d) => g.state.divisions[d].order);
      });
      expect(ordered.length).toBeGreaterThan(0);
      for (const order of ordered) {
        expect(order).toMatchObject({ kind: 'move', target: setup.to });
      }
    });
  });

  test('orders given while paused take effect', async ({ page }) => {
    await bootGame(page, { static: false });
    await page.locator('.hud-pause').click();

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
      return { to: target.id, speed: g.time.speed, selected: g.selection.divisions.length };
    });
    expect(setup.speed).toBe(0);
    expect(setup.selected).toBeGreaterThan(0);

    await swipe(page, await provinceScreenPos(page, 'GER'), await provinceScreenPos(page, 'POL'), 16);
    await page.waitForTimeout(300);

    const state = await page.evaluate(() => {
      const g = window.__game!;
      const d = g.state.divisions[g.selection.divisions[0]];
      return { order: d.order, path: d.path.length, hours: g.time.hours };
    });
    expect(state.order).toMatchObject({ kind: 'move', target: setup.to });
    expect(state.path).toBeGreaterThan(0);
  });

  test('map mode buttons recolour without errors', async ({ page }) => {
    const errors = await bootGame(page);
    for (const mode of ['state', 'terrain', 'resource', 'supply', 'victory', 'political']) {
      await page.locator(`.hud-mode[data-mode="${mode}"]`).click();
      const active = await page.evaluate(() => window.__game!.renderer.mapMode);
      expect(active).toBe(mode);
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('speed controls drive the clock', async ({ page }) => {
    await bootGame(page, { static: false });
    // Step up to the top of the range; the stepper clamps rather than wrapping.
    const faster = page.locator('.hud-step').last();
    for (let i = 0; i < 6; i++) await faster.click();
    expect(await page.evaluate(() => window.__game!.speed)).toBe(5);
    await expect(page.locator('.hud-speed-v')).toHaveText('5');

    const before = await page.evaluate(() => window.__game!.state.clock.totalHours);
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => window.__game!.state.clock.totalHours);
    expect(after).toBeGreaterThan(before);

    await page.locator('.hud-pause').click();
    expect(await page.evaluate(() => window.__game!.speed)).toBe(0);
    const paused = await page.evaluate(() => window.__game!.state.clock.totalHours);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__game!.state.clock.totalHours)).toBe(paused);

    // Resuming returns the speed the player chose, not a constant.
    await page.locator('.hud-pause').click();
    expect(await page.evaluate(() => window.__game!.speed)).toBe(5);
  });

  test('every control in the top bar is thumb-sized and on screen', async ({ page }) => {
    await bootGame(page);
    const bad = await page.evaluate(() => {
      const w = window.innerWidth;
      const out: string[] = [];
      for (const b of document.querySelectorAll<HTMLElement>('.hud-btn')) {
        const r = b.getBoundingClientRect();
        if (r.width < 44 || r.height < 44) out.push(`small ${r.width}x${r.height}`);
        if (r.left < 0 || r.right > w) out.push(`offscreen ${r.left}..${r.right} of ${w}`);
      }
      // The bar must not lie across the row of figures underneath it.
      const top = document.querySelector('.hud-top')!.getBoundingClientRect();
      const modes = document.querySelector('.hud-modes')!.getBoundingClientRect();
      if (modes.top < top.bottom) out.push(`modes overlap top bar by ${top.bottom - modes.top}`);
      return out;
    });
    expect(bad, bad.join('\n')).toEqual([]);
  });

  test('a finger can scroll a panel that is taller than the sheet', async ({ page }) => {
    await bootGame(page);
    // The sheet's open transition never advances in this headless browser --
    // the document timeline only ticks when something forces a composite, and
    // nothing here does -- so the panel would still be below the fold when the
    // swipe was dispatched, and the gesture would land outside the viewport.
    // Removing the transition puts it where a player would see it; the
    // animation is not what this test is about.
    await page.addStyleTag({ content: '.hud-sheet { transition: none !important; }' });
    await page.evaluate(() => window.__game!.openPanel!('research'));
    const box = (await page.locator('.hud-sheet-body').boundingBox())!;
    expect(box.y).toBeLessThan(page.viewportSize()!.height - 100);
    const overflows = await page.evaluate(() => {
      const b = document.querySelector('.hud-sheet-body')!;
      return b.scrollHeight - b.clientHeight;
    });
    expect(overflows).toBeGreaterThan(80);

    await swipe(
      page,
      { x: box.x + box.width / 2, y: box.y + box.height - 30 },
      { x: box.x + box.width / 2, y: box.y + 30 },
    );
    await page.waitForTimeout(300);
    const scrolled = await page.evaluate(
      () => document.querySelector('.hud-sheet-body')!.scrollTop,
    );
    expect(scrolled).toBeGreaterThan(40);
  });

  test('the alert row names a real problem and opens where it is fixed', async ({ page }) => {
    await bootGame(page);
    await page.addStyleTag({ content: '.hud-sheet { transition: none !important; }' });
    // A fresh 1936 Germany has idle factories, idle research slots and no
    // national focus running. Before the row existed, nothing on screen said
    // so, and a player who touched nothing sat at 26 factories until 1942.
    const alerts = page.locator('.hud-alert');
    expect(await alerts.count()).toBeGreaterThanOrEqual(3);

    const small = await alerts.evaluateAll((ns) => ns
      .map((n) => n.getBoundingClientRect())
      .filter((r) => r.width < 44 || r.height < 36)
      .map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`));
    expect(small, small.join(',')).toEqual([]);

    await alerts.first().click();
    await expect(page.locator('.hud-sheet')).toHaveClass(/is-open/);

    // Fixing the condition clears the chip.
    const before = await alerts.count();
    await page.evaluate(() => {
      const g = window.__game!;
      const me = g.state.countries[g.state.meta.playerCountry];
      const st = g.index.get(me.capital).stateId;
      g.issue({ t: 'queueConstruction', country: me.id, state: st, kind: 'civilian_factory' });
      g.tickFrame(16.667);
    });
    await expect(alerts).toHaveCount(before - 1);
  });

  test('the panel zoom changes the size of what is in the sheet', async ({ page }) => {
    await bootGame(page);
    await page.evaluate(() => window.__game!.openPanel!('research'));
    const rowHeight = () =>
      page.evaluate(() => document.querySelector('.panel-focus')!.getBoundingClientRect().height);
    const at100 = await rowHeight();
    for (let i = 0; i < 4; i++) await page.locator('.hud-sheet-zoom').last().click();
    await expect(page.locator('.hud-sheet-zoom-v')).toHaveText('140%');
    expect(await rowHeight()).toBeGreaterThan(at100 * 1.2);
    for (let i = 0; i < 8; i++) await page.locator('.hud-sheet-zoom').first().click();
    // Clamped, not wrapped: pressing minus past the floor must not jump to max.
    await expect(page.locator('.hud-sheet-zoom-v')).toHaveText('80%');
    expect(await rowHeight()).toBeLessThan(at100);
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
