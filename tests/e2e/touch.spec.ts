import { expect, test } from '@playwright/test';
import {
  bootGame, cameraState, canvasCentre, openMapPoint, pinch, provinceScreenPos, provinceScreenPosById,
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
        // A German province that actually holds the player's divisions. Taking
        // the first one by index worked on a 323-province map by luck; at
        // 1,266 it is usually empty, and the premise of the test is a stack.
        const me = g.state.meta.playerCountry;
        const ger = g.index.provinces.find(
          (p) => p.ownerTag === 'GER'
            && g.state.provinces[p.id].divisions.some((d) => g.state.divisions[d].owner === me),
        )!;
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

      const from = await provinceScreenPosById(page, setup.from);
      const to = await provinceScreenPosById(page, setup.to);
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

  test('tapping a unit then a destination issues a move order', async ({ page }) => {
    await bootGame(page);
    await page.addStyleTag({ content: '.hud-sheet { transition: none !important; }' });

    // Frame a stack of the player's own and find where its counter is drawn.
    // The counter is what the player aims at -- it sits above the province
    // centre, so the province's own position is the wrong place to tap.
    // Open the sheet once and leave it open while the shot is framed. Its
    // height is the floor of the visible band, and with it shut the band looks
    // 450px taller than it will be the moment the counter is tapped -- which
    // framed the stack at y=399, underneath the sheet header.
    await page.evaluate(() => {
      const g = window.__game!;
      const s = g.state;
      const me = s.meta.playerCountry;
      const first = g.index.provinces.find(
        (q) => s.provinces[q.id].divisions.some((d) => s.divisions[d].owner === me),
      )!;
      g.selectProvince(first.id);
      g.tickFrame(16);
    });
    await expect(page.locator('.hud-sheet')).toHaveClass(/is-open/);

    const setup = await page.evaluate(() => {
      const g = window.__game!;
      const s = g.state;
      const me = s.meta.playerCountry;
      const from = g.index.provinces.find(
        (q) => s.provinces[q.id].divisions.some((d) => s.divisions[d].owner === me),
      )!;
      g.renderer.camera.centerOn(from.centerX, from.centerY);
      g.renderer.camera.zoom = 1.6;
      g.tickFrame(16);

      // Put the counter in the middle of the strip of map that is actually
      // visible, measured from the HUD rather than guessed as a fraction of
      // the viewport. The top bar and the sheet both change height as chips
      // and captions are added to them, and a counter that ends up under
      // either of them cannot be tapped: framing it at a fixed 30% of the
      // screen put it at y=148, inside the alert row.
      const band = () => {
        const top = document.querySelector('.hud-top')!.getBoundingClientRect();
        const sheet = document.querySelector('.hud-sheet')!.getBoundingClientRect();
        return (top.bottom + sheet.top) / 2;
      };
      // Twice: moving the camera can change which counters are on screen, and
      // the second pass lands on the settled layout.
      for (let pass = 0; pass < 2; pass++) {
        const drawn = g.renderer.units.hitBoxes.find((b) => b.province === from.id);
        const at = drawn ? drawn.y : g.renderer.camera.worldToScreenY(from.centerY);
        g.renderer.camera.y += (at - band()) / g.renderer.camera.zoom;
        for (let i = 0; i < 3; i++) g.tickFrame(16);
      }

      const box = g.renderer.canvas.getBoundingClientRect();
      const boxes = g.renderer.units.hitBoxes;
      const own = boxes.find((b) => b.province === from.id)!;
      // A neighbour far enough from every counter that the tap is unambiguous.
      const clear = (n: number) => {
        const q = g.index.get(n);
        const sx = g.renderer.camera.worldToScreenX(q.centerX);
        const sy = g.renderer.camera.worldToScreenY(q.centerY);
        return boxes.every((b) => Math.abs(sx - b.x) > b.w / 2 + 16
          || Math.abs(sy - b.y) > b.h / 2 + 16);
      };
      const to = g.index.get(from.id).neighbors.find((n) => s.provinces[n] && clear(n))!;
      const t = g.index.get(to);
      // Put the map back the way the player would find it: nothing selected.
      g.selectProvince(null);
      g.tickFrame(16);
      return {
        from: from.id,
        to,
        counter: { x: Math.round(box.left + own.x), y: Math.round(box.top + own.y) },
        dest: {
          x: Math.round(box.left + g.renderer.camera.worldToScreenX(t.centerX)),
          y: Math.round(box.top + g.renderer.camera.worldToScreenY(t.centerY)),
        },
      };
    });

    await tapAt(page, setup.counter.x, setup.counter.y);
    const picked = await page.evaluate(() => ({
      province: window.__game!.selection.province,
      divisions: window.__game!.selection.divisions.length,
    }));
    expect(picked.province).toBe(setup.from);
    expect(picked.divisions).toBeGreaterThan(0);

    // The player has to be told which of the two jobs the next tap will do.
    // One gesture reads the map and commands the army, and the gold ring on
    // the counter also appears when a province is merely being looked at.
    const hint = page.locator('.hud-order');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(`${picked.divisions}個師団`);

    // Nothing may stand between the player and the ground they are aiming at:
    // an earlier version of the map-mode strip lay across the map when a panel
    // was open and swallowed this tap, and the first placement of the banner
    // above sat directly over the counter it was describing.
    for (const point of [setup.dest, setup.counter]) {
      const covering = await page.evaluate((d) => {
        const e = document.elementFromPoint(d.x, d.y);
        return e ? (e.className || e.tagName) : 'none';
      }, point);
      expect(covering, `something is covering ${JSON.stringify(point)}`).toBe('CANVAS');
    }

    await tapAt(page, setup.dest.x, setup.dest.y);
    const orders = await page.evaluate(() => {
      const g = window.__game!;
      return g.selection.divisions.map((d) => g.state.divisions[d].order);
    });
    expect(orders.length).toBeGreaterThan(0);
    for (const order of orders) {
      expect(order).toMatchObject({ kind: 'move', target: setup.to });
    }

    // The stack stays in hand for a second objective, and the counter is how
    // it is put down again.
    await expect(hint).toBeVisible();
    await tapAt(page, setup.counter.x, setup.counter.y);
    await expect(hint).toBeHidden();
    expect(await page.evaluate(() => window.__game!.selection.province)).toBeNull();
  });

  test('orders given while paused take effect', async ({ page }) => {
    await bootGame(page, { static: false });
    await page.locator('.hud-pause').click();

    const setup = await page.evaluate(() => {
      const g = window.__game!;
      const me = g.state.meta.playerCountry;
      const ger = g.index.provinces.find(
        (p) => p.ownerTag === 'GER'
          && g.state.provinces[p.id].divisions.some((d) => g.state.divisions[d].owner === me),
      )!;
      const target = g.index.provinces.find((p) => p.ownerTag === 'POL')!;
      g.renderer.camera.centerOn(
        (ger.centerX + target.centerX) / 2,
        (ger.centerY + target.centerY) / 2,
      );
      g.renderer.camera.zoom = 0.22;
      g.tickFrame(16);
      g.selectProvince(ger.id);
      return { from: ger.id, to: target.id, speed: g.time.speed,
        selected: g.selection.divisions.length };
    });
    expect(setup.speed).toBe(0);
    expect(setup.selected).toBeGreaterThan(0);

    await swipe(page, await provinceScreenPosById(page, setup.from),
      await provinceScreenPosById(page, setup.to), 16);
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
  /**
   * The counter is 10 to 17 CSS pixels tall and is drawn about that far above
   * its province centre, so before the plate was made to win outright the
   * province centre was nearer than the counter centre over the bottom half of
   * every counter. Measured on a lattice over every one of the player's drawn
   * plates: at the zoom the game opens at, 41% of taps that landed on a
   * counter selected the ground instead.
   */
  test('a tap anywhere on a drawn counter takes the unit, not the ground', async ({ page }) => {
    await bootGame(page);
    await page.addStyleTag({ content: '.hud-sheet { transition: none !important; }' });

    const setup = await page.evaluate(() => {
      const g = window.__game!;
      const s = g.state;
      const me = s.meta.playerCountry;
      const home = g.index.provinces.find(
        (q) => s.provinces[q.id].divisions.some((d) => s.divisions[d].owner === me),
      )!;
      g.renderer.camera.centerOn(home.centerX, home.centerY);
      g.renderer.camera.zoom = 0.22;
      g.tickFrame(16);
      g.selectProvince(null);
      g.tickFrame(16);

      const rect = g.renderer.canvas.getBoundingClientRect();
      // The worst case for the old rule: the counter whose own province centre
      // sits closest to the bottom edge of its plate.
      let worst: { x: number; y: number; province: number } | null = null;
      let bestGap = Infinity;
      for (const b of g.renderer.units.hitBoxes) {
        if (b.owner !== me) continue;
        if (b.x < 40 || b.x > rect.width - 80) continue;
        if (b.y < 260 || b.y > rect.height - 220) continue;
        const p = g.index.get(b.province);
        const gap = Math.abs(g.renderer.camera.worldToScreenY(p.centerY) - (b.y + b.h / 2));
        if (gap < bestGap) {
          bestGap = gap;
          worst = {
            x: Math.round(rect.left + b.x),
            y: Math.round(rect.top + b.y + b.h / 2 - 2),
            province: b.province,
          };
        }
      }
      return worst;
    });
    expect(setup, 'no counter of the player’s was framed').not.toBeNull();

    await tapAt(page, setup!.x, setup!.y);
    const picked = await page.evaluate((at) => {
      const g = window.__game!;
      const rect = g.renderer.canvas.getBoundingClientRect();
      const chosen = g.renderer.units.hitBoxes.find(
        (b) => b.province === g.selection.province,
      );
      // Which counter won is the nearest-centre rule's business and is
      // allowed to be a neighbour whose plate also covers the point. What is
      // asserted is that the tap did not fall through to the ground, and that
      // whatever it did pick is drawn under the finger.
      const onPlate = chosen !== undefined
        && Math.abs(rect.left + chosen.x - at.x) <= chosen.w / 2 + 1
        && Math.abs(rect.top + chosen.y - at.y) <= chosen.h / 2 + 1;
      return {
        ordering: g.unitSelected,
        divisions: g.selection.divisions.length,
        onPlate,
      };
    }, { x: setup!.x, y: setup!.y });
    expect(picked.ordering).toBe(true);
    expect(picked.onPlate).toBe(true);
    expect(picked.divisions).toBeGreaterThan(0);
  });

  test('the marquee tool boxes every division inside the rectangle', async ({ page }) => {
    await bootGame(page);

    const setup = await page.evaluate(() => {
      const g = window.__game!;
      const s = g.state;
      const me = s.meta.playerCountry;
      const home = g.index.provinces.find(
        (q) => s.provinces[q.id].divisions.some((d) => s.divisions[d].owner === me),
      )!;
      g.renderer.camera.centerOn(home.centerX, home.centerY);
      g.renderer.camera.zoom = 0.3;
      for (let i = 0; i < 4; i++) g.tickFrame(16);
      g.selectProvince(null);
      g.tickFrame(16);

      const rect = g.renderer.canvas.getBoundingClientRect();
      const top = document.querySelector('.hud-top')!.getBoundingClientRect().bottom;
      const nav = document.querySelector('.hud-nav')!.getBoundingClientRect().top;
      const own = g.renderer.units.hitBoxes.filter(
        (b) => b.owner === me
          && b.x > 40 && b.x < rect.width - 90
          && rect.top + b.y > top + 70 && rect.top + b.y < nav - 70,
      );
      if (own.length < 2) return null;
      own.sort((a, b) => a.y - b.y || a.x - b.x);
      const pick = own.slice(0, Math.min(4, own.length));
      const xs = pick.map((b) => b.x);
      const ys = pick.map((b) => b.y);
      const expected = new Set<number>();
      for (const b of pick) {
        for (const d of s.provinces[b.province].divisions) {
          if (s.divisions[d] && !s.divisions[d].dead && s.divisions[d].owner === me) expected.add(d);
        }
      }
      return {
        from: { x: Math.round(rect.left + Math.min(...xs) - 12), y: Math.round(rect.top + Math.min(...ys) - 12) },
        to: { x: Math.round(rect.left + Math.max(...xs) + 12), y: Math.round(rect.top + Math.max(...ys) + 12) },
        expected: [...expected].sort((a, b) => a - b),
      };
    });
    expect(setup, 'fewer than two of the player’s counters were framed').not.toBeNull();

    // The tool has to be picked up first: an unarmed stroke pans the map, and
    // that is the whole reason the marquee is a button rather than a timing.
    await page.locator('.hud-select-tool').click();
    await expect(page.locator('.hud-select-tool')).toHaveClass(/is-active/);
    await swipe(page, setup!.from, setup!.to, 16, 60);

    await page.waitForFunction(
      (n) => window.__game!.selection.divisions.length >= n,
      setup!.expected.length,
      { timeout: 10_000 },
    );
    const picked = await page.evaluate(() => ({
      ordering: window.__game!.unitSelected,
      divisions: [...window.__game!.selection.divisions].sort((a, b) => a - b),
      marquee: window.__game!.boxSelect,
    }));
    expect(picked.ordering).toBe(true);
    expect(picked.marquee).toBeNull();
    for (const id of setup!.expected) expect(picked.divisions).toContain(id);
    // One rectangle, then the tool puts itself down.
    await expect(page.locator('.hud-select-tool')).not.toHaveClass(/is-active/);
  });

  test('an unarmed drag still pans, however long the finger rests first', async ({ page }) => {
    await bootGame(page);
    await setCamera(page, 0, 0, 0.2);
    const before = await cameraState(page);
    const c = await canvasCentre(page);

    // 700ms of stillness before the stroke. This is what a thumb does on a
    // phone, and it is what a loaded test harness does whether the thumb
    // meant to or not; reading it as a marquee moved the camera 0px.
    await swipe(page, { x: c.x + 90, y: c.y + 90 }, { x: c.x - 90, y: c.y - 90 }, 14, 700);
    await page.waitForTimeout(400);
    const after = await cameraState(page);
    expect(after.x).toBeGreaterThan(before.x + 100);
    expect(after.y).toBeGreaterThan(before.y + 100);
  });

  test('a march can be called off', async ({ page }) => {
    await bootGame(page);
    // Set explicitly rather than by pressing pause: static mode has already
    // stopped the clock, so pressing it would start the game and the division
    // would arrive before the assertion -- at which point the control
    // correctly disappears, because it only exists while something is moving.
    await page.evaluate(() => window.__game!.setSpeed(0));

    const setup = await page.evaluate(() => {
      const g = window.__game!;
      const s = g.state;
      const me = s.meta.playerCountry;
      const div = s.divisions.find((d) => d.owner === me && !d.dead)!;
      const to = g.index.get(div.provinceId).neighbors
        .find((n) => s.provinces[n] !== undefined)!;
      g.selectDivisions([div.id], { centre: false });
      g.issue({ t: 'moveDivisions', divisions: [div.id], target: to });
      return { division: div.id, path: s.divisions[div.id].path.length };
    });
    // The premise: it really is marching.
    expect(setup.path).toBeGreaterThan(0);

    // The control only exists while something is moving, which is the whole
    // reason it is worth having.
    const stop = page.getByRole('button', { name: '移動を中止する' });
    await expect(stop).toBeVisible();
    await stop.click();

    const after = await page.evaluate((id) => {
      const d = window.__game!.state.divisions[id];
      return { path: d.path.length, kind: d.order?.kind ?? null };
    }, setup.division);
    expect(after.path).toBe(0);
    expect(after.kind).not.toBe('move');
    await expect(stop).toBeHidden();
  });

  test('an army can be placed under an army group', async ({ page }) => {
    await bootGame(page);
    await page.addStyleTag({ content: '.hud-sheet { transition: none !important; }' });

    // The scenario already puts the majors' armies under a group, so start by
    // taking this one out again -- otherwise the test proves nothing about
    // the control, which is what the first version of it did.
    const ready = await page.evaluate(() => {
      const g = window.__game!;
      const me = g.state.meta.playerCountry;
      const armies = (g.state.armies ?? []).filter((a) => a.owner === me);
      const army = armies.find((a) => !a.isArmyGroup)!;
      g.issue({ t: 'setArmyParent', country: me, army: army.id, group: null });
      return {
        army: army.id,
        parent: army.parent,
        groups: armies.filter((a) => a.isArmyGroup).length,
      };
    });
    expect(ready.groups).toBeGreaterThan(0);
    expect(ready.parent).toBeNull();

    await page.evaluate(() => window.__game!.openPanel!('command'));
    const head = page.locator('.panel-army-head').first();
    await expect(head).toBeVisible();
    // The chips live inside the expanded card.
    await head.click();
    const chip = page.locator('.panel-chip', { hasText: '軍集団へ' }).first();
    await expect(chip).toBeVisible();
    await chip.click();

    const placed = await page.evaluate((id) => {
      const g = window.__game!;
      const armies = g.state.armies ?? [];
      const army = armies.find((a) => a.id === id)!;
      const group = armies.find((a) => a.id === army.parent);
      return { parent: army.parent, listed: group?.children.includes(id) ?? false };
    }, ready.army);
    // Both ends of the link: a parent pointer with no matching child entry is
    // what makes a hierarchy quietly wrong.
    expect(placed.parent).not.toBeNull();
    expect(placed.listed).toBe(true);
  });

  test('the order bar raises an army from a selection and gives it a front', async ({ page }) => {
    await bootGame(page);

    const chosen = await page.evaluate(() => {
      const g = window.__game!;
      const s = g.state;
      const me = s.meta.playerCountry;
      const held = s.divisions
        .filter((d) => d.owner === me && !d.dead)
        .slice(0, 3)
        .map((d) => d.id);
      g.selectDivisions(held, { centre: false });
      return held;
    });
    expect(chosen.length).toBeGreaterThan(0);

    const bar = page.locator('.hud-order');
    await expect(bar).toHaveClass(/is-on/);

    await page.getByRole('button', { name: '軍へ編成' }).click();
    await page.locator('.hud-order-chip').last().click();

    const raised = await page.evaluate(() => {
      const g = window.__game!;
      const me = g.state.meta.playerCountry;
      const army = g.selection.army;
      const found = (g.state.armies ?? []).find((a) => a.id === army);
      return { army, owner: found?.owner, held: found?.divisions.length ?? 0, me };
    });
    expect(raised.army).not.toBeNull();
    expect(raised.owner).toBe(raised.me);
    expect(raised.held).toBeGreaterThanOrEqual(chosen.length);

    await page.getByRole('button', { name: '戦線を引く' }).click();
    await page.locator('.hud-order-chip').first().click();

    // A day of the battle-plan tick is what turns the order into a line.
    await page.evaluate(() => { window.__game!.stepHours(26); window.__game!.tickFrame(16); });
    const plan = await page.evaluate(() => {
      const g = window.__game!;
      const army = (g.state.armies ?? []).find((a) => a.id === g.selection.army);
      return { kind: army?.order?.kind, front: army?.frontProvinces.length ?? 0 };
    });
    expect(plan.kind).toBe('front');
    expect(plan.front).toBeGreaterThan(0);
  });

  test('a minor can be courted into the faction from the diplomacy panel', async ({ page }) => {
    await bootGame(page);
    await page.addStyleTag({ content: '.hud-sheet { transition: none !important; }' });

    // Political power accrues over months, and the point of this test is the
    // sequence of actions, not the wait. Everything else -- the opinion, the
    // thresholds, the spending -- runs for real.
    const start = await page.evaluate(() => {
      const g = window.__game!;
      const s = g.state;
      const me = s.countries[s.meta.playerCountry];
      me.economy.politicalPower = 400;
      const hun = s.countries.find((c) => c.tag === 'HUN')!;
      return { me: me.id, hun: hun.id, faction: me.factionId };
    });
    expect(start.faction).not.toBeNull();

    await page.evaluate(() => window.__game!.openPanel!('diplomacy'));
    const row = page.locator('.panel-row[data-country]', { hasText: 'ハンガリー' }).first();
    await expect(row).toBeVisible();
    await row.click();

    // The sheet is titled with the country whose relations it is showing.
    await expect(page.locator('.hud-sheet-title')).toHaveText('ハンガリーとの関係');

    // Nobody joins a bloc on day one: the invitation names the number it is
    // waiting on rather than being a dead grey control.
    const invite = page.locator('.panel-row.wide-row', { hasText: '陣営に招待' }).first();
    await expect(invite).toBeDisabled();
    await expect(invite.locator('.panel-row-tag')).toContainText('好感度');

    const opinion = (): Promise<number> => page.evaluate((ids) => {
      const c = window.__game!.state.countries[ids.hun];
      return Math.round(c.diplomacy.opinion[ids.me] ?? 0);
    }, start);
    const before = await opinion();

    // The advertised path, taken entirely through the panel.
    await page.locator('.panel-row.wide-row', { hasText: '独立保障' }).first().click();
    for (let i = 0; i < 4; i++) {
      const improve = page.locator('.panel-row.wide-row', { hasText: '関係改善' }).first();
      await expect(improve).toBeEnabled();
      await improve.click();
    }
    expect(await opinion()).toBeGreaterThan(before);

    await expect(invite).toBeEnabled();
    await invite.click();

    const after = await page.evaluate((ids) => {
      const s = window.__game!.state;
      const me = s.countries[ids.me];
      return {
        faction: s.countries[ids.hun].factionId,
        mine: me.factionId,
        listed: me.factionId !== null
          ? s.factions[me.factionId].members.includes(ids.hun)
          : false,
        power: Math.round(me.economy.politicalPower),
      };
    }, start);
    expect(after.faction).toBe(after.mine);
    expect(after.listed).toBe(true);
    // Every action was paid for: a guarantee, four rounds of diplomacy and the
    // invitation itself.
    expect(after.power).toBeLessThan(400 - 25 - 4 * 10);
  });


  test('a starved project can be pulled to the head of the build queue', async ({ page }) => {
    await bootGame(page);
    await page.addStyleTag({ content: '.hud-sheet { transition: none !important; }' });

    // Three projects is past the end of any 1936 budget: each takes up to
    // fifteen factories and the third gets none.
    const queued = await page.evaluate(() => {
      const g = window.__game!;
      const s = g.state;
      const me = s.countries[s.meta.playerCountry];
      me.constructionQueue.length = 0;
      for (let id = 0; id < s.states.length && me.constructionQueue.length < 3; id++) {
        const st = s.states[id];
        if (!st || st.controller !== me.id) continue;
        g.issue({
          t: 'queueConstruction', country: me.id, kind: 'civilian_factory', state: id,
        });
      }
      return me.constructionQueue.map((x) => x.id);
    });
    expect(queued.length).toBe(3);

    await page.evaluate(() => window.__game!.openPanel!('construction'));
    const rows = page.locator('[data-role="queue"] .panel-row[data-item]');
    await expect(rows).toHaveCount(3);

    // The panel says which of them the factories have actually reached, which
    // is the reason to move one.
    await expect(rows.nth(0)).not.toHaveClass(/is-idle/);
    await expect(rows.last()).toHaveClass(/is-idle/);
    await expect(rows.last().locator('.panel-row-sub')).toContainText('順番待ち');

    // The head of the queue has nowhere to go, so its control is off.
    await expect(rows.nth(0).getByRole('button', { name: /優先する$/ })).toBeDisabled();

    // Two presses take the last project to the front.
    await rows.last().getByRole('button', { name: /優先する$/ }).click();
    await page.locator(`[data-role="queue"] [data-item="${queued[2]}"]`)
      .getByRole('button', { name: /優先する$/ }).click();

    const after = await page.evaluate(() => {
      const me = window.__game!.state.countries[window.__game!.state.meta.playerCountry];
      return me.constructionQueue.map((x) => x.id);
    });
    expect(after).toEqual([queued[2], queued[0], queued[1]]);

    // And the list now draws in the order the factories will work down it.
    const drawn = await rows.evaluateAll(
      (nodes) => nodes.map((n) => Number((n as HTMLElement).dataset.item)),
    );
    expect(drawn).toEqual(after);
    await expect(rows.nth(0)).not.toHaveClass(/is-idle/);
  });


  test('an army can be given a name of its own', async ({ page }) => {
    await bootGame(page);
    await page.addStyleTag({ content: '.hud-sheet { transition: none !important; }' });

    const army = await page.evaluate(() => {
      const g = window.__game!;
      const me = g.state.meta.playerCountry;
      const a = (g.state.armies ?? []).find((x) => x.owner === me && !x.isArmyGroup)!;
      return { id: a.id, name: a.name };
    });

    await page.evaluate(() => window.__game!.openPanel!('command'));
    const card = page.locator(`.panel-focus[data-army="${army.id}"]`);
    await expect(card).toBeVisible();
    // The field lives inside the expanded card.
    await card.locator('.panel-army-head').click();

    const field = card.locator('.panel-input');
    await expect(field).toHaveValue(army.name);
    await field.fill('南方軍集団');
    await card.getByRole('button', { name: '名称変更' }).click();

    const after = await page.evaluate((id) => {
      const a = (window.__game!.state.armies ?? []).find((x) => x.id === id)!;
      return a.name;
    }, army.id);
    expect(after).toBe('南方軍集団');
    expect(after).not.toBe(army.name);
    // And the card is relabelled, not just the state.
    await expect(card.locator('.panel-focus-name').first()).toContainText('南方軍集団');
  });

});
