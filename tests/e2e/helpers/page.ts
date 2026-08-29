import type { Page } from '@playwright/test';
import type { Game } from '../../../src/app/Game';

declare global {
  interface Window {
    __game?: Game;
    __gameReady?: boolean;
  }
}

export interface BootOptions {
  /** Freeze animation so screenshots are reproducible. */
  static?: boolean;
  country?: string;
  seed?: number;
}

export async function bootGame(page: Page, opts: BootOptions = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  const params = new URLSearchParams();
  if (opts.static !== false) params.set('static', '1');
  if (opts.country) params.set('country', opts.country);
  if (opts.seed !== undefined) params.set('seed', String(opts.seed));

  await page.goto(`/?${params.toString()}`);
  await page.waitForFunction(() => window.__gameReady === true, null, { timeout: 90_000 });
  // Let the first LOD build and the boot overlay finish fading.
  await page.waitForTimeout(700);
  return errors;
}

/**
 * Drives the camera over a place on the Earth, so screenshots do not depend on
 * the default framing, which shifts whenever the map data is rebuilt.
 *
 * Longitude and latitude rather than render units, so that changing the
 * projection reframes a scene instead of pointing it at open ocean. It did
 * exactly that once: the scenes held Lambert coordinates, the map became
 * cylindrical, and `germany-close` re-recorded itself as an empty stretch of
 * the Atlantic.
 *
 * The requested position is then allowed to settle: when the map is smaller
 * than the viewport on an axis, the camera springs back to the centre of that
 * axis, and a test that measured before the spring finished would blame the
 * drift on whatever gesture it ran next.
 */
export async function setCamera(
  page: Page, lon: number, lat: number, zoom: number,
): Promise<void> {
  await page.evaluate(({ x: lo, y: la, z }) => {
    const g = window.__game!;
    const pr = g.index.data.projection;
    const latOf = (row: number): number => {
      const v = pr.latV0 + row * pr.latVStep;
      let out = 0;
      for (const c of pr.latPoly) out = out * v + c;
      return out;
    };
    // The polynomial only runs one way, so it is inverted by bisection over
    // the rows the map holds.
    let loRow = 0;
    let hiRow = 4000;
    for (let i = 0; i < 60; i++) {
      const mid = (loRow + hiRow) / 2;
      if (latOf(mid) > la) loRow = mid; else hiRow = mid;
    }
    const cx = ((lo - pr.lon0) / pr.lonStep) * pr.quantum * pr.scale;
    const cy = ((loRow + hiRow) / 2) * pr.quantum * pr.scale;
    g.renderer.camera.zoom = z;
    g.renderer.camera.x = cx;
    g.renderer.camera.y = cy;
    g.renderer.camera.velocityX = 0;
    g.renderer.camera.velocityY = 0;
    for (let i = 0; i < 60; i++) g.tickFrame(16.667);
  }, { x: lon, y: lat, z: zoom });
  await page.waitForTimeout(120);
}

/**
 * Stops the animation loop so a capture is reproducible.
 *
 * While requestAnimationFrame is running, the number of frames that elapse
 * between setting the camera and taking the screenshot varies from run to run.
 * The camera spring advances on each of those frames, so the view drifts by a
 * fraction of a pixel -- enough to flip a label that sits exactly on a
 * collision boundary, and enough to fail a byte-comparison.
 */
export async function freezeLoop(page: Page): Promise<void> {
  await page.evaluate(() => window.__game!.stop());
}

export async function cameraState(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(() => {
    const c = window.__game!.renderer.camera;
    return { x: c.x, y: c.y, zoom: c.zoom };
  });
}

/** Centre of the map canvas in CSS pixels. */
export async function canvasCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('#map-root canvas').boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A gesture anchor clear of every interactive HUD element.
 *
 * The map-mode bar and the top bar accept pointer events, so a wide pinch
 * centred on the canvas puts one contact on a button and the gesture never
 * reaches the map. Anchoring low and left keeps both contacts on the map.
 */
export async function openMapPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('#map-root canvas').boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  return { x: box.x + box.width * 0.4, y: box.y + box.height * 0.74 };
}

/**
 * Two-finger pinch via CDP.
 *
 * Playwright's touchscreen API only supports a single tap, so multi-touch has
 * to go through raw Input.dispatchTouchEvent. Each step moves both contacts
 * symmetrically about the centre.
 *
 * Chromium's touch emulation only honours one multi-touch sequence per page:
 * a second two-point touchStart delivers just one pointerdown, whatever ids or
 * spacing it is given. Tests therefore perform at most one pinch per page.
 */
const sessions = new WeakMap<Page, Promise<import('@playwright/test').CDPSession>>();

function touchSession(page: Page) {
  let s = sessions.get(page);
  if (!s) {
    s = page.context().newCDPSession(page);
    sessions.set(page, s);
  }
  return s;
}

export async function pinch(
  page: Page,
  centre: { x: number; y: number },
  fromRadius: number,
  toRadius: number,
  steps = 12,
): Promise<void> {
  const client = await touchSession(page);
  const pts = (r: number) => [
    { x: centre.x - r, y: centre.y, id: 1 },
    { x: centre.x + r, y: centre.y, id: 2 },
  ];

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: pts(fromRadius),
  });
  for (let i = 1; i <= steps; i++) {
    const r = fromRadius + ((toRadius - fromRadius) * i) / steps;
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: pts(r),
    });
    await page.waitForTimeout(16);
  }
  // CDP requires touchEnd to carry an empty point list; it lifts every contact.
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
}

/** Single-finger drag with intermediate move events, so the FSM sees a pan. */
export async function swipe(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 14,
  holdMs = 0,
): Promise<void> {
  const client = await touchSession(page);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
  });
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 1 }],
    });
    await page.waitForTimeout(12);
  }
  // The lifted point has to be named. An empty touchEnd leaves Chrome to
  // synthesise the pointerup's coordinates, and it does not always choose the
  // last touch position -- which made the drag-to-order test fail about one
  // run in three with the selection intact and no order issued, because the
  // release was being read at a point off the map.
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [{ x: to.x, y: to.y, id: 1 }],
  });
}

/** Taps a screen point using the touch pipeline rather than a synthetic click. */
export async function tapAt(
  page: Page, x: number, y: number, holdMs = 60,
): Promise<void> {
  const client = await touchSession(page);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x, y, id: 1 }],
  });
  await page.waitForTimeout(holdMs);
  // The lifted point is named, for the same reason it is in `swipe`: an empty
  // touchEnd leaves Chromium to invent the release coordinates.
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd', touchPoints: [{ x, y, id: 1 }],
  });
  await page.waitForTimeout(120);
}

/** Screen position of a specific province's centre, in CSS pixels. */
export async function provinceScreenPosById(
  page: Page, id: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate((pid) => {
    const g = window.__game!;
    const p = g.index.get(pid);
    const box = g.renderer.canvas.getBoundingClientRect();
    return {
      x: box.left + g.renderer.camera.worldToScreenX(p.centerX),
      y: box.top + g.renderer.camera.worldToScreenY(p.centerY),
    };
  }, id);
}

/** Screen position of a province centre, in CSS pixels. */
export async function provinceScreenPos(
  page: Page, tag: string,
): Promise<{ x: number; y: number; id: number }> {
  return page.evaluate((t) => {
    const g = window.__game!;
    const p = g.index.provinces.find((q) => q.ownerTag === t)!;
    const box = g.renderer.canvas.getBoundingClientRect();
    return {
      x: box.left + g.renderer.camera.worldToScreenX(p.centerX),
      y: box.top + g.renderer.camera.worldToScreenY(p.centerY),
      id: p.id,
    };
  }, tag);
}
