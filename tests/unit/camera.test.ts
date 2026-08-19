import { describe, expect, it } from 'vitest';
import { Camera } from '../../src/render/Camera';

/**
 * Camera behaviour is pure arithmetic, so it is tested here rather than through
 * the browser. Inertia and spring-back in particular are frame-rate sensitive
 * and would be flaky measured through a software-rasterised headless page.
 */

const BOUNDS = { minX: -3000, minY: -2500, maxX: 3000, maxY: 2500 };

function makeCamera(w = 412, h = 869): Camera {
  const c = new Camera(BOUNDS);
  c.resize(w, h);
  return c;
}

describe('Camera projection', () => {
  it('round-trips world and screen coordinates', () => {
    const c = makeCamera();
    c.x = 120;
    c.y = -340;
    c.zoom = 0.25;
    for (const [wx, wy] of [[0, 0], [500, -800], [-2200, 1900]]) {
      const sx = c.worldToScreenX(wx);
      const sy = c.worldToScreenY(wy);
      expect(c.screenToWorldX(sx)).toBeCloseTo(wx, 6);
      expect(c.screenToWorldY(sy)).toBeCloseTo(wy, 6);
    }
  });

  it('puts the camera position at the centre of the viewport', () => {
    const c = makeCamera(400, 800);
    c.x = 50;
    c.y = 60;
    c.zoom = 0.3;
    expect(c.worldToScreenX(50)).toBeCloseTo(200, 6);
    expect(c.worldToScreenY(60)).toBeCloseTo(400, 6);
  });

  it('reports the visible rectangle consistently with the projection', () => {
    const c = makeCamera(400, 800);
    c.x = 0;
    c.y = 0;
    c.zoom = 0.2;
    const r = c.visibleRect();
    expect(r.minX).toBeCloseTo(c.screenToWorldX(0), 6);
    expect(r.maxX).toBeCloseTo(c.screenToWorldX(400), 6);
    expect(r.minY).toBeCloseTo(c.screenToWorldY(0), 6);
    expect(r.maxY).toBeCloseTo(c.screenToWorldY(800), 6);
  });
});

describe('Camera zoom', () => {
  it('keeps the anchored world point under the same screen point', () => {
    const c = makeCamera();
    c.x = -400;
    c.y = 200;
    c.zoom = 0.15;
    const anchorScreen = { x: 90, y: 640 };
    const worldBefore = {
      x: c.screenToWorldX(anchorScreen.x),
      y: c.screenToWorldY(anchorScreen.y),
    };
    c.zoomAt(anchorScreen.x, anchorScreen.y, 2.4);
    expect(c.screenToWorldX(anchorScreen.x)).toBeCloseTo(worldBefore.x, 4);
    expect(c.screenToWorldY(anchorScreen.y)).toBeCloseTo(worldBefore.y, 4);
    expect(c.zoom).toBeCloseTo(0.36, 6);
  });

  it('clamps to the zoom range and does not move when clamped', () => {
    const c = makeCamera();
    c.zoom = c.maxZoom;
    const before = { x: c.x, y: c.y };
    c.zoomAt(100, 100, 4);
    expect(c.zoom).toBe(c.maxZoom);
    expect(c.x).toBe(before.x);
    expect(c.y).toBe(before.y);

    c.zoom = c.minZoom;
    c.zoomAt(100, 100, 0.1);
    expect(c.zoom).toBe(c.minZoom);
  });

  it('derives a minimum zoom that shows the whole map', () => {
    const c = makeCamera(400, 800);
    const fitX = 400 / (BOUNDS.maxX - BOUNDS.minX);
    const fitY = 800 / (BOUNDS.maxY - BOUNDS.minY);
    expect(c.minZoom).toBeCloseTo(Math.min(fitX, fitY) * 0.85, 6);
    expect(c.maxZoom).toBeGreaterThan(c.minZoom);
  });

  it('fit() frames a rectangle inside the viewport', () => {
    const c = makeCamera(400, 800);
    const rect = { minX: -1000, maxX: 1000, minY: -500, maxY: 500 };
    c.fit(rect);
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeCloseTo(0, 6);
    const v = c.visibleRect();
    expect(v.minX).toBeLessThanOrEqual(rect.minX + 1e-6);
    expect(v.maxX).toBeGreaterThanOrEqual(rect.maxX - 1e-6);
  });
});

describe('Camera panning', () => {
  it('moves the world opposite to the screen drag', () => {
    const c = makeCamera();
    c.x = 0;
    c.y = 0;
    c.zoom = 0.2;
    c.panByScreen(-100, -50);
    expect(c.x).toBeCloseTo(500, 6);
    expect(c.y).toBeCloseTo(250, 6);
  });

  it('hard clamp keeps the camera within bounds plus overscroll', () => {
    const c = makeCamera(400, 800);
    c.zoom = 0.5;
    c.x = 99999;
    c.y = 99999;
    c.clampHard();
    const slackX = (BOUNDS.maxX - BOUNDS.minX) * c.overscroll;
    const slackY = (BOUNDS.maxY - BOUNDS.minY) * c.overscroll;
    expect(c.x).toBeLessThanOrEqual(BOUNDS.maxX + slackX);
    expect(c.y).toBeLessThanOrEqual(BOUNDS.maxY + slackY);
  });

  it('centres an axis when the map is narrower than the viewport', () => {
    const c = makeCamera(400, 800);
    c.zoom = c.minZoom * 0.99;   // zoomed out past a full fit
    c.x = 2000;
    c.y = 2000;
    c.clampHard();
    expect(c.x).toBeCloseTo((BOUNDS.minX + BOUNDS.maxX) / 2, 6);
    expect(c.y).toBeCloseTo((BOUNDS.minY + BOUNDS.maxY) / 2, 6);
  });
});

describe('Camera inertia', () => {
  it('glides after release and comes to rest', () => {
    const c = makeCamera();
    c.zoom = 0.2;
    c.x = 0;
    c.y = 0;
    c.velocityX = -30;
    c.velocityY = 0;

    const first = c.x;
    c.update(16.667, false);
    const afterOne = c.x;
    expect(afterOne).toBeGreaterThan(first);

    for (let i = 0; i < 400; i++) c.update(16.667, false);
    expect(c.velocityX).toBe(0);
    const resting = c.x;
    c.update(16.667, false);
    expect(c.x).toBe(resting);
  });

  it('does not glide while a finger is still down', () => {
    const c = makeCamera();
    c.zoom = 0.2;
    c.x = 0;
    c.velocityX = -30;
    c.update(16.667, true);
    expect(c.x).toBe(0);
    expect(c.velocityX).toBe(-30);
  });

  it('springs back when dragged past the overscroll limit', () => {
    const c = makeCamera(400, 800);
    c.zoom = 0.5;
    c.y = 0;
    c.x = BOUNDS.maxX + 5000;
    const start = c.x;
    c.update(16.667, false);
    expect(c.x).toBeLessThan(start);
    for (let i = 0; i < 300; i++) c.update(16.667, false);
    const slackX = (BOUNDS.maxX - BOUNDS.minX) * c.overscroll;
    expect(c.x).toBeLessThanOrEqual(BOUNDS.maxX + slackX + 1);
  });

  it('takes the same number of steps regardless of how dt is delivered', () => {
    const run = (dt: number, frames: number) => {
      const c = makeCamera();
      c.zoom = 0.2;
      c.x = 0;
      c.velocityX = -30;
      for (let i = 0; i < frames; i++) c.update(dt, false);
      return c.x;
    };
    // 4 sub-steps per frame is the cap, so 16.7ms x 4 matches 66.7ms x 1.
    expect(run(66.7, 10)).toBeCloseTo(run(16.667, 40), 6);
  });
});
