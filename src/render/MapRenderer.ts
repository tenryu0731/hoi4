import {
  Application, Container, Graphics, Matrix, Sprite, Texture, TilingSprite,
} from 'pixi.js';

import type { ProvinceIndex } from '../sim/map/ProvinceIndex';
import type { GameState, ProvinceId } from '../sim/core/types';
import { Camera } from './Camera';
import {
  PALETTE, RESOURCE_RAMP, SUPPLY_RAMP, TERRAIN_COLOR, VICTORY_RAMP,
  type MapMode, mix, ramp, rgbToHex, shade,
} from './palette';
import {
  createGrainTexture, createOceanTexture, createReliefTexture, createVerticalRamp,
} from './textures';
import { LabelLayer } from './layers/LabelLayer';
import { UnitLayer } from './layers/UnitLayer';

/**
 * Draws the map.
 *
 * The scene splits into three cost classes:
 *   - static geometry, built once (province fills, borders, rivers, coastlines);
 *   - zoom-dependent geometry, rebuilt only when the zoom crosses an LOD step;
 *   - per-frame work (camera transform, unit counters, selection pulse).
 *
 * Province fills are white Graphics that carry the relief texture, and colour
 * comes from `.tint`. Recolouring the whole political map is then just N tint
 * writes with no retriangulation, which is what makes map-mode switching and
 * conquest updates free.
 */

export interface MapRendererOptions {
  canvasParent: HTMLElement;
  index: ProvinceIndex;
  /** Capped at 2: beyond that mobile GPUs lose more to fill rate than they gain. */
  resolution?: number;
  /** Disables animation for deterministic screenshots. */
  staticMode?: boolean;
}

/** Zoom thresholds at which line weights and label sets change. */
const LOD_STEPS = [0.045, 0.075, 0.13, 0.24, 0.45, 0.9];

export class MapRenderer {
  readonly app: Application;
  readonly camera: Camera;
  readonly index: ProvinceIndex;

  private world = new Container();
  private oceanSprite!: TilingSprite;
  private oceanDepth!: Sprite;
  private glowLayer = new Container();
  private neutralLand = new Graphics();
  private fillLayer = new Container();
  private provinceFills: Graphics[] = [];
  private lakeLayer = new Graphics();
  private riverLayer = new Graphics();
  private borderLayer = new Graphics();
  private grain!: TilingSprite;
  private selectionLayer = new Graphics();
  private frontLayer = new Graphics();
  private cityLayer = new Graphics();
  private labels!: LabelLayer;
  private units!: UnitLayer;

  private reliefTexture!: Texture;
  private mode: MapMode = 'political';
  private selected: ProvinceId | null = null;
  private hovered: ProvinceId | null = null;
  private lodStep = -1;
  private elapsed = 0;
  private staticMode: boolean;
  private lastTintKey: string[] = [];

  /**
   * Frame timings for the perf harness, newest last.
   *
   * Scene and draw are recorded separately because they are bounded by
   * different hardware. `sceneTimes` is the game's own per-frame work -- the
   * part a faster GPU cannot rescue -- while `drawTimes` is dominated by
   * rasterisation, which on a real phone is done by the GPU and in a headless
   * software renderer is not.
   */
  readonly sceneTimes: number[] = [];
  readonly drawTimes: number[] = [];
  readonly frameTimes: number[] = [];

  private constructor(app: Application, index: ProvinceIndex, staticMode: boolean) {
    this.app = app;
    this.index = index;
    this.staticMode = staticMode;
    const [minX, minY, maxX, maxY] = index.bounds;
    this.camera = new Camera({ minX, minY, maxX, maxY });
  }

  static async create(opts: MapRendererOptions): Promise<MapRenderer> {
    const app = new Application();
    const resolution = Math.min(opts.resolution ?? window.devicePixelRatio ?? 1, 2);
    await app.init({
      background: PALETTE.oceanDeep,
      antialias: false,
      resolution,
      autoDensity: true,
      // One renderer path keeps the shader behaviour identical between a phone
      // and the headless Chromium the visual tests run in.
      preference: 'webgl',
      powerPreference: 'high-performance',
      width: Math.max(1, opts.canvasParent.clientWidth),
      height: Math.max(1, opts.canvasParent.clientHeight),
      autoStart: false,
    });
    opts.canvasParent.appendChild(app.canvas);

    const r = new MapRenderer(app, opts.index, opts.staticMode ?? false);
    r.build();
    // app.screen is the logical (CSS pixel) rect; renderer.width is already
    // logical too, so dividing it by the resolution would halve the viewport.
    r.resize(app.screen.width, app.screen.height);
    r.camera.fit({
      minX: opts.index.bounds[0], minY: opts.index.bounds[1],
      maxX: opts.index.bounds[2], maxY: opts.index.bounds[3],
    });
    return r;
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas as HTMLCanvasElement;
  }

  // -------------------------------------------------------------------------
  // Scene construction
  // -------------------------------------------------------------------------

  private build(): void {
    const stage = this.app.stage;
    this.reliefTexture = createReliefTexture(512);

    // --- ocean: screen space, so it stays sharp at every zoom --------------
    this.oceanSprite = new TilingSprite({
      texture: createOceanTexture(256),
      width: 1, height: 1,
    });
    this.oceanSprite.tint = PALETTE.oceanMid;
    stage.addChild(this.oceanSprite);

    this.oceanDepth = new Sprite(createVerticalRamp([
      [0, 'rgba(8,20,34,0.42)'],
      [0.45, 'rgba(8,20,34,0.0)'],
      [1, 'rgba(4,12,22,0.48)'],
    ]));
    this.oceanDepth.alpha = 0.85;
    stage.addChild(this.oceanDepth);

    stage.addChild(this.world);

    // --- coastal halo ------------------------------------------------------
    this.world.addChild(this.glowLayer);
    this.buildCoastGlow();

    // --- land --------------------------------------------------------------
    this.world.addChild(this.neutralLand);
    this.buildNeutralLand();

    this.world.addChild(this.fillLayer);
    this.buildProvinceFills();

    this.world.addChild(this.lakeLayer);
    this.world.addChild(this.riverLayer);
    this.buildWater();

    this.world.addChild(this.borderLayer);

    // --- paper grain over everything on the map ---------------------------
    this.grain = new TilingSprite({ texture: createGrainTexture(256), width: 1, height: 1 });
    this.grain.alpha = 0.38;
    stage.addChild(this.grain);

    this.world.addChild(this.frontLayer);
    this.world.addChild(this.selectionLayer);
    this.world.addChild(this.cityLayer);

    this.labels = new LabelLayer(this.index);
    this.world.addChild(this.labels.container);

    this.units = new UnitLayer(this.index);
    this.world.addChild(this.units.container);
  }

  /**
   * A halo in the water around every landmass. Drawn as three progressively
   * thinner strokes rather than a blur filter: a filter would need a
   * full-screen render target every frame, which is the single most expensive
   * thing you can do on a mobile GPU.
   */
  private buildCoastGlow(): void {
    const passes: [number, number][] = [[46, 0.16], [16, 0.24]];
    for (const [width, alpha] of passes) {
      const g = new Graphics();
      for (const ring of this.index.data.land) {
        this.tracePolygon(g, ring);
      }
      g.stroke({ color: PALETTE.coastGlow, width, alpha, join: 'round', cap: 'round' });
      this.glowLayer.addChild(g);
    }
  }

  private buildNeutralLand(): void {
    const g = this.neutralLand;
    for (const ring of this.index.data.land) this.tracePolygon(g, ring);
    g.fill({
      texture: this.reliefTexture,
      color: PALETTE.neutralLand,
      textureSpace: 'global',
      matrix: new Matrix().scale(1.6, 1.6),
    });
  }

  private buildProvinceFills(): void {
    for (const p of this.index.provinces) {
      const g = new Graphics();
      // Outer rings and holes in one path: the even-odd winding Pixi applies to
      // a single fill() call punches enclaves out correctly.
      for (let i = 0; i < p.rings.length; i++) {
        this.traceFloatRing(g, p.rings[i]);
      }
      g.fill({
        texture: this.reliefTexture,
        color: 0xffffff,
        textureSpace: 'global',
        matrix: new Matrix().scale(1.6, 1.6),
      });
      g.tint = PALETTE.landBase;
      this.fillLayer.addChild(g);
      this.provinceFills.push(g);
    }
    this.lastTintKey = new Array(this.provinceFills.length).fill('');
  }

  private buildWater(): void {
    for (const ring of this.index.data.lakes) this.tracePolygon(this.lakeLayer, ring);
    this.lakeLayer.fill({ color: PALETTE.lake });
    this.lakeLayer.stroke({ color: shade(PALETTE.lake, 0.7), width: 3, alpha: 0.7 });
  }

  /**
   * Redraws the city markers at the given zoom.
   *
   * Sizes are in world units derived from a target pixel size rather than
   * applying a scale to the layer: scaling a Graphics scales its coordinates
   * too, which would drag every city towards the world origin.
   */
  private buildCities(zoom: number): void {
    const g = this.cityLayer;
    g.clear();
    const u = 1 / Math.max(1e-4, zoom);
    for (const c of this.index.data.cities) {
      if (c.capitalOf) {
        g.star(c.x, c.y, 5, 7 * u, 3.2 * u);
        g.fill({ color: 0xf6e3a8 });
        g.stroke({ color: 0x3a2c15, width: 1.4 * u });
      } else if (c.vp >= 12) {
        g.circle(c.x, c.y, 3.6 * u);
        g.fill({ color: 0xf0e6cf });
        g.stroke({ color: 0x3a2c15, width: 1.2 * u });
      } else if (c.vp >= 5) {
        g.circle(c.x, c.y, 2.4 * u);
        g.fill({ color: 0xcbbfa4 });
        g.stroke({ color: 0x3a2c15, width: 1 * u });
      }
    }
  }

  private tracePolygon(g: Graphics, flat: number[]): void {
    if (flat.length < 6) return;
    g.moveTo(flat[0], flat[1]);
    for (let i = 2; i < flat.length; i += 2) g.lineTo(flat[i], flat[i + 1]);
    g.closePath();
  }

  private traceFloatRing(g: Graphics, ring: Float32Array): void {
    if (ring.length < 6) return;
    g.moveTo(ring[0], ring[1]);
    for (let i = 2; i < ring.length; i += 2) g.lineTo(ring[i], ring[i + 1]);
    g.closePath();
  }

  // -------------------------------------------------------------------------
  // Level of detail
  // -------------------------------------------------------------------------

  private lodFor(zoom: number): number {
    let step = 0;
    while (step < LOD_STEPS.length && zoom >= LOD_STEPS[step]) step++;
    return step;
  }

  /**
   * Rebuilds strokes so their on-screen weight stays roughly constant. Line
   * widths live in world units, so a fixed width would vanish when zoomed out
   * and turn into slabs when zoomed in. Rebuilding only on LOD changes keeps
   * this off the per-frame budget.
   */
  private rebuildForLod(step: number): void {
    const zoom = LOD_STEPS[Math.min(step, LOD_STEPS.length - 1)] ?? this.camera.zoom;
    const px = (screenPx: number) => screenPx / zoom;

    const g = this.borderLayer;
    g.clear();

    const showProvince = step >= 3 && this.index.data.borders.province.length > 0;
    if (showProvince) {
      for (const line of this.index.data.borders.province) this.tracePolyline(g, line);
      g.stroke({ color: PALETTE.borderProvince, width: px(0.9), alpha: 0.45, join: 'round' });
    }

    for (const line of this.index.data.borders.coast) this.tracePolyline(g, line);
    g.stroke({ color: PALETTE.borderCoast, width: px(1.4), alpha: 0.7, join: 'round' });

    // Country borders get a soft light halo first, then the dark line, which is
    // what gives printed political maps their engraved look.
    for (const line of this.index.data.borders.country) this.tracePolyline(g, line);
    g.stroke({ color: 0xf0e6cf, width: px(4.2), alpha: 0.3, join: 'round', cap: 'round' });
    for (const line of this.index.data.borders.country) this.tracePolyline(g, line);
    g.stroke({ color: PALETTE.borderCountry, width: px(2.0), alpha: 0.92, join: 'round', cap: 'round' });

    const rg = this.riverLayer;
    rg.clear();
    if (step >= 2) {
      for (const line of this.index.data.rivers) this.tracePolyline(rg, line);
      rg.stroke({ color: PALETTE.river, width: px(1.3), alpha: 0.55, join: 'round', cap: 'round' });
    }

    this.cityLayer.visible = step >= 2;
    if (this.cityLayer.visible) this.buildCities(zoom);
    this.labels.setLod(step, zoom);
    this.units.setZoom(zoom);
  }

  private tracePolyline(g: Graphics, flat: number[]): void {
    if (flat.length < 4) return;
    g.moveTo(flat[0], flat[1]);
    for (let i = 2; i < flat.length; i += 2) g.lineTo(flat[i], flat[i + 1]);
  }

  // -------------------------------------------------------------------------
  // Colouring
  // -------------------------------------------------------------------------

  setMapMode(mode: MapMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.lastTintKey.fill('');
  }

  get mapMode(): MapMode {
    return this.mode;
  }

  setSelection(id: ProvinceId | null): void {
    this.selected = id;
  }

  setHover(id: ProvinceId | null): void {
    this.hovered = id;
  }

  get selection(): ProvinceId | null {
    return this.selected;
  }

  /** Recolours province fills from the current game state, skipping no-ops. */
  refreshColors(state: GameState | null): void {
    const provinces = this.index.provinces;
    for (let i = 0; i < provinces.length; i++) {
      const key = this.tintKeyFor(i, state);
      if (key === this.lastTintKey[i]) continue;
      this.lastTintKey[i] = key;
      this.provinceFills[i].tint = this.tintFor(i, state);
    }
  }

  private tintKeyFor(id: ProvinceId, state: GameState | null): string {
    if (!state) return `${this.mode}:static`;
    const p = state.provinces[id];
    switch (this.mode) {
      case 'political': return `p${p.controller}:${p.owner}`;
      case 'supply': return `s${Math.round(p.supply * 20)}`;
      case 'terrain': return 't';
      case 'resource': return 'r';
      case 'victory': return `v${p.controller}`;
    }
  }

  private tintFor(id: ProvinceId, state: GameState | null): number {
    const geo = this.index.provinces[id];
    switch (this.mode) {
      case 'terrain':
        return TERRAIN_COLOR[geo.terrain] ?? PALETTE.landBase;
      case 'resource': {
        const st = this.index.data.states[geo.stateId];
        const total = Object.values(st.resources).reduce((s, v) => s + (v ?? 0), 0);
        return ramp(Math.min(1, total / 45), RESOURCE_RAMP);
      }
      case 'supply':
        return state ? ramp(state.provinces[id].supply, SUPPLY_RAMP) : PALETTE.landBase;
      case 'victory':
        return ramp(Math.min(1, geo.vp / 60), VICTORY_RAMP);
      case 'political':
      default: {
        if (!state) return PALETTE.landBase;
        const p = state.provinces[id];
        const base = rgbToHex(state.countries[p.controller].color);
        // Occupied territory reads as a washed-out version of the occupier's
        // colour, so the front line is legible without a separate map mode.
        return p.controller === p.owner ? base : mix(base, 0x6a6a6a, 0.42);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  resize(w: number, h: number): void {
    const width = Math.max(1, Math.round(w));
    const height = Math.max(1, Math.round(h));
    if (this.app.screen.width !== width || this.app.screen.height !== height) {
      this.app.renderer.resize(width, height);
    }
    this.camera.resize(width, height);
    this.oceanSprite.width = width;
    this.oceanSprite.height = height;
    this.oceanDepth.width = width;
    this.oceanDepth.height = height;
    this.grain.width = width;
    this.grain.height = height;
  }

  /** Advances animation and pushes camera state into the scene graph. */
  update(dtMs: number, state: GameState | null): void {
    const t0 = performance.now();
    this.elapsed += dtMs;

    const cam = this.camera;
    const step = this.lodFor(cam.zoom);
    if (step !== this.lodStep) {
      this.lodStep = step;
      this.rebuildForLod(step);
    }

    this.cullProvinces(cam);

    this.world.scale.set(cam.zoom);
    this.world.position.set(
      cam.viewportW / 2 - cam.x * cam.zoom,
      cam.viewportH / 2 - cam.y * cam.zoom,
    );

    // Ocean and grain live in screen space; scrolling their tile offsets with
    // the camera makes them feel attached to the world without any geometry.
    this.oceanSprite.tilePosition.set(
      -cam.x * cam.zoom * 0.5 + (this.staticMode ? 0 : this.elapsed * 0.004),
      -cam.y * cam.zoom * 0.5 + (this.staticMode ? 0 : this.elapsed * 0.002),
    );
    this.oceanSprite.tileScale.set(1 + cam.zoom * 0.4);
    this.grain.tilePosition.set(-cam.x * cam.zoom, -cam.y * cam.zoom);

    this.refreshColors(state);
    this.drawSelection();
    let reserved: readonly { x: number; y: number; w: number; h: number }[] = [];
    if (state) {
      reserved = this.units.update(state, cam, this.staticMode ? 0 : this.elapsed);
      this.drawFrontline(state);
    }
    this.labels.update(cam, reserved);

    const t1 = performance.now();
    this.app.render();
    const t2 = performance.now();

    this.sceneTimes.push(t1 - t0);
    this.drawTimes.push(t2 - t1);
    this.frameTimes.push(t2 - t0);
    if (this.frameTimes.length > 1200) {
      this.sceneTimes.shift();
      this.drawTimes.shift();
      this.frameTimes.shift();
    }
  }

  /**
   * Hides province fills outside the viewport. Pixi has no automatic culling
   * for Graphics, so without this every province pays a transform and batch
   * check each frame even when it is on another continent.
   */
  private cullProvinces(cam: Camera): void {
    const v = cam.visibleRect();
    const pad = 40 / Math.max(1e-4, cam.zoom);
    const minX = v.minX - pad, maxX = v.maxX + pad;
    const minY = v.minY - pad, maxY = v.maxY + pad;
    const provinces = this.index.provinces;
    for (let i = 0; i < provinces.length; i++) {
      const b = provinces[i].bbox;
      this.provinceFills[i].visible =
        b[2] >= minX && b[0] <= maxX && b[3] >= minY && b[1] <= maxY;
    }
  }

  private drawSelection(): void {
    const g = this.selectionLayer;
    g.clear();
    const zoom = Math.max(0.02, this.camera.zoom);
    const pulse = this.staticMode ? 1 : 0.75 + 0.25 * Math.sin(this.elapsed / 260);

    if (this.hovered !== null && this.hovered !== this.selected) {
      const p = this.index.provinces[this.hovered];
      for (const ring of p.rings) this.traceFloatRing(g, ring);
      g.stroke({ color: 0xffffff, width: 2.2 / zoom, alpha: 0.4, join: 'round' });
    }
    if (this.selected !== null) {
      const p = this.index.provinces[this.selected];
      for (const ring of p.rings) this.traceFloatRing(g, ring);
      g.stroke({ color: PALETTE.selection, width: 6 / zoom, alpha: 0.35 * pulse, join: 'round' });
      for (const ring of p.rings) this.traceFloatRing(g, ring);
      g.stroke({ color: PALETTE.selection, width: 2.4 / zoom, alpha: 0.95, join: 'round' });
    }
  }

  private drawFrontline(state: GameState): void {
    const g = this.frontLayer;
    g.clear();
    if (state.wars.length === 0) return;
    const zoom = Math.max(0.02, this.camera.zoom);
    const view = this.camera.visibleRect();

    for (const p of this.index.provinces) {
      if (p.centerX < view.minX || p.centerX > view.maxX) continue;
      if (p.centerY < view.minY || p.centerY > view.maxY) continue;
      const me = state.provinces[p.id].controller;
      for (const nb of p.neighbors) {
        if (nb < p.id) continue;
        const other = state.provinces[nb].controller;
        if (me === other) continue;
        if (!state.countries[me].atWarWith.includes(other)) continue;
        const q = this.index.provinces[nb];
        g.moveTo(p.centerX, p.centerY);
        g.lineTo(q.centerX, q.centerY);
      }
    }
    g.stroke({ color: PALETTE.frontline, width: 2.5 / zoom, alpha: 0.55, cap: 'round' });
  }

  /** Percentile helper for the perf harness. */
  static percentile(values: readonly number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  }

  resetTimings(): void {
    this.sceneTimes.length = 0;
    this.drawTimes.length = 0;
    this.frameTimes.length = 0;
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }
}
