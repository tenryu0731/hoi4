import { expect, test } from '@playwright/test';
import { bootGame, setCamera } from './helpers/page';

/**
 * Frame-time budget.
 *
 * This container has no GPU: Chromium runs WebGL through SwiftShader, a
 * software rasteriser. Wall-clock frame time here is therefore dominated by
 * CPU rasterisation that a real phone does on dedicated hardware, and gating on
 * it would measure the harness rather than the game.
 *
 * What *is* representative is the work the game itself does each frame:
 * simulation ticks, scene-graph updates, culling, label placement and draw-call
 * submission. That is the number the budget is set on. Rasterisation cost is
 * bounded separately by keeping draw calls and geometry low, which the test
 * also asserts.
 */

/** CPU work per frame, in milliseconds. */
const BUDGET = {
  p50: 16.6,
  p95: 24,
  p99: 33.3,   // 30fps floor
};

interface PerfSample {
  scene: number[];
  draw: number[];
  wall: number[];
}

test.describe('performance', () => {
  test('sustains the per-frame CPU budget on a busy scene', async ({ page }) => {
    const errors = await bootGame(page, { static: false });

    // A representative scene: mid zoom over central Europe with the whole
    // starting order of battle on screen and the clock running fast.
    await page.evaluate(() => {
      const g = window.__game!;
      const ger = g.index.provinces.find((p) => p.ownerTag === 'GER')!;
      g.renderer.camera.centerOn(ger.centerX, ger.centerY);
      g.renderer.camera.zoom = 0.16;
      g.setSpeed(4);
      for (let i = 0; i < 30; i++) g.tickFrame(16.667);
      g.renderer.resetTimings();
    });

    const sample: PerfSample = await page.evaluate(async () => {
      const g = window.__game!;
      const wall: number[] = [];
      const FRAMES = 150;
      // Pan and zoom while measuring: a static camera skips the LOD rebuilds
      // and label reflow that dominate a real session.
      let last = performance.now();
      for (let i = 0; i < FRAMES; i++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        const now = performance.now();
        wall.push(now - last);
        last = now;
        const t = i / FRAMES;
        g.renderer.camera.x += Math.sin(t * Math.PI * 4) * 12;
        g.renderer.camera.y += Math.cos(t * Math.PI * 3) * 8;
        g.renderer.camera.zoom = 0.10 + 0.14 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));
      }
      return {
        scene: [...g.renderer.sceneTimes],
        draw: [...g.renderer.drawTimes],
        wall,
      };
    });

    const pct = (arr: number[], p: number) => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    };

    // Discard the first frames: they carry one-off LOD builds.
    const scene = sample.scene.slice(10);
    const draw = sample.draw.slice(10);
    const wall = sample.wall.slice(10);
    const stats = {
      frames: scene.length,
      scene_p50: +pct(scene, 50).toFixed(2),
      scene_p95: +pct(scene, 95).toFixed(2),
      scene_p99: +pct(scene, 99).toFixed(2),
      scene_max: +Math.max(...scene).toFixed(2),
      draw_p50: +pct(draw, 50).toFixed(1),
      wall_p50: +pct(wall, 50).toFixed(1),
    };
    console.log('per-frame game work (ms):', JSON.stringify(stats));
    console.log(
      `  implied CPU-bound fps: p50 ${(1000 / stats.scene_p50).toFixed(0)}` +
      ` p95 ${(1000 / stats.scene_p95).toFixed(0)} p99 ${(1000 / stats.scene_p99).toFixed(0)}`,
    );
    console.log(
      `  rasterisation p50 ${stats.draw_p50}ms / wall p50 ${stats.wall_p50}ms:` +
      ' SwiftShader software rendering, not representative of a mobile GPU.',
    );

    expect(stats.frames).toBeGreaterThan(100);
    expect(errors, errors.join('\n')).toEqual([]);
    expect(stats.scene_p50).toBeLessThanOrEqual(BUDGET.p50);
    expect(stats.scene_p95).toBeLessThanOrEqual(BUDGET.p95);
    expect(stats.scene_p99).toBeLessThanOrEqual(BUDGET.p99);
  });

  test('keeps the scene graph small enough for a mobile GPU', async ({ page }) => {
    await bootGame(page);
    await setCamera(page, -300, -200, 0.16);

    const scene = await page.evaluate(() => {
      const g = window.__game!;
      let nodes = 0;
      let visible = 0;
      const walk = (c: { visible: boolean; children?: unknown[] }) => {
        nodes++;
        if (c.visible) visible++;
        for (const child of (c.children ?? []) as { visible: boolean; children?: unknown[] }[]) {
          walk(child);
        }
      };
      walk(g.renderer.app.stage as never);
      return {
        nodes,
        visible,
        provinces: g.index.count,
        divisions: g.state.divisions.filter((d) => !d.dead).length,
      };
    });
    console.log('scene graph:', JSON.stringify(scene));

    // Pixi batches aggressively, but every visible node still costs a transform
    // update and a batch check each frame. Keep the ceiling well under the
    // point where that becomes the frame's dominant cost.
    expect(scene.visible).toBeLessThan(1400);
    expect(scene.nodes).toBeLessThan(3000);
  });

  test('recolouring the whole map is cheap', async ({ page }) => {
    await bootGame(page);
    const timings = await page.evaluate(() => {
      const g = window.__game!;
      const modes = ['terrain', 'resource', 'victory', 'supply', 'political'] as const;
      const out: number[] = [];
      for (const m of modes) {
        const t0 = performance.now();
        g.setMapMode(m);
        g.renderer.refreshColors(g.state);
        out.push(performance.now() - t0);
      }
      return out;
    });
    console.log('map-mode switch (ms):', timings.map((t) => t.toFixed(2)).join(' '));
    // Tinting must not retriangulate: a full switch has to fit in one frame.
    expect(Math.max(...timings)).toBeLessThan(16);
  });
});
