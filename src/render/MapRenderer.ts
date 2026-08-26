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
import { NATIONS } from '../sim/scenario/nations';
import { supplyCapacity } from '../sim/military/supply';
import { LabelLayer } from './layers/LabelLayer';
import { UnitLayer, type DragOrder } from './layers/UnitLayer';
import { country } from '../ui/strings';

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

/**
 * Which of the map's two tiers an outline belongs to. A province is where a
 * division stands; a state is what gets built in.
 */
export type SelectionScope = 'province' | 'state';

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
  private selectScope: SelectionScope = 'province';
  private frontLayer = new Graphics();
  private cityLayer = new Graphics();
  /** Exposed for the visual-determinism probe in the e2e suite. */
  labels!: LabelLayer;
  /** Public so input can ask which counter a tap landed on. */
  units!: UnitLayer;

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

    // Nation display names come from the scenario table rather than the map,
    // which only stores tags.
    const countryNames = new Map<string, string>(NATIONS.map((n) => [n.tag, country(n.tag)]));
    this.labels = new LabelLayer(this.index, countryNames);
    this.world.addChild(this.labels.container);

    this.units = new UnitLayer(this.index);
    this.world.addChild(this.units.container);
    this.world.addChild(this.labels.topContainer);
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

    // Province seams first, then the state seams over them: the two tiers are
    // the whole shape of the game -- provinces are what a division stands in
    // and states are what a factory is built in -- and until now neither was
    // drawn, so a country read as one flat slab of colour.
    const internal = this.internalBorders();
    if (step >= 2) {
      for (const line of internal.province) this.tracePolyline(g, line);
      g.stroke({ color: 0x0f0d09, width: px(1.0), alpha: 0.34, join: 'round' });
    }
    if (step >= 1) {
      // A halo under the state seam, as the country border gets: the fills
      // either side are the same colour, so a dark line alone has nothing to
      // separate it from and reads as a scratch rather than a boundary.
      for (const line of internal.state) this.tracePolyline(g, line);
      g.stroke({ color: 0xf0e6cf, width: px(2.6), alpha: 0.22, join: 'round', cap: 'round' });
      for (const line of internal.state) this.tracePolyline(g, line);
      g.stroke({ color: 0x0f0d09, width: px(1.3), alpha: 0.62, join: 'round', cap: 'round' });
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

  /** The in-progress order drag, so the map can show where it would land. */
  setDragOrder(drag: DragOrder | null): void {
    this.units.setDrag(drag);
  }

  setMapMode(mode: MapMode): void {
    this.units.setNeutral(mode !== 'political');
    if (this.mode === mode) return;
    this.mode = mode;
    this.lastTintKey.fill('');
  }

  get mapMode(): MapMode {
    return this.mode;
  }

  /**
   * What the outline is drawn around.
   *
   * `scope` is the difference between the two tiers the map has: a province is
   * where a division stands and a state is what gets built in, and a player
   * asking about one is not asking about the other. At province scope only the
   * tapped province is outlined; at state scope every province of its state is,
   * which is the only way to see on the map how far a state reaches.
   */
  setSelection(id: ProvinceId | null, ordering = false, scope: SelectionScope = 'province'): void {
    this.selected = id;
    this.selectScope = scope;
    this.units.setSelection(id, ordering);
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

  /** The richest province on the map, so the victory ramp has a real top. */
  private get maxVp(): number {
    if (this.maxVpCache === 0) {
      for (const p of this.index.provinces) {
        if (p.vp > this.maxVpCache) this.maxVpCache = p.vp;
      }
      this.maxVpCache = Math.max(1, this.maxVpCache);
    }
    return this.maxVpCache;
  }

  private maxVpCache = 0;

  private tintKeyFor(id: ProvinceId, state: GameState | null): string {
    if (!state) return `${this.mode}:static`;
    const p = state.provinces[id];
    switch (this.mode) {
      case 'political': return `p${p.controller}:${p.owner}`;
      case 'state': return `st${p.controller}:${this.index.provinces[id].stateId}`;
      case 'supply': return `s${Math.round(p.supply * 20)}:${this.index.provinces[id].stateId}`;
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
      case 'supply': {
        // Capacity times shortage. Shortage alone is a wartime quantity -- a
        // country at peace is at full supply everywhere -- so on its own this
        // mode was a single flat colour over the whole map until the first war
        // broke out, four years into a twelve-year campaign. Multiplying by
        // what the roads can carry means the mode always shows the logistics
        // network, and shows the war eating into it once there is one.
        const capacity = supplyCapacity(this.index, id);
        const shortage = state ? state.provinces[id].supply : 1;
        return ramp(capacity * shortage, SUPPLY_RAMP);
      }
      case 'victory':
        // Against the largest prize on the map, on a square-root curve. The
        // divisor used to be a flat 60 while the richest province on the board
        // is worth 34, so the whole map lived in the bottom half of the ramp
        // -- and since two thirds of provinces are worth 1 to 5, they lived in
        // the bottom twelfth of it and were indistinguishable. The curve
        // spends the ramp where the provinces actually are.
        return ramp(Math.sqrt(geo.vp / this.maxVp), VICTORY_RAMP);
      case 'state': {
        // Every state a distinguishable shade of whoever holds it. Provinces
        // of one state share a tone, so the administrative tier reads as
        // patches rather than having to be inferred from the seams.
        if (!state) return PALETTE.landBase;
        const p = state.provinces[id];
        const base = rgbToHex(state.countries[p.controller].color);
        // A cheap integer hash, not a random: the map must look the same on
        // every machine and across every reload.
        const h = (geo.stateId * 2654435761) >>> 0;
        // Signed, so half the states lift and half sink. Mixing in one
        // direction only crushed every German state toward black, because
        // Germany's own colour is already dark; the darkening side is also
        // gentler than the lightening one for the same reason.
        const t = (((h >>> 8) & 0xff) / 255 - 0.5) * 0.9;
        return t >= 0 ? mix(base, 0xf2ead8, t) : mix(base, 0x14120e, -t * 0.7);
      }
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
      reserved = this.units.update(state, cam, this.staticMode ? 0 : this.elapsed,
        this.staticMode ? 1e6 : dtMs);
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
      const chosen = this.index.provinces[this.selected];
      const members = this.selectScope === 'state'
        ? (this.index.data.states[chosen.stateId]?.provinces ?? [this.selected])
        : [this.selected];
      const trace = (): void => {
        for (const id of members) {
          const p = this.index.provinces[id];
          if (!p) continue;
          for (const ring of p.rings) this.traceFloatRing(g, ring);
        }
      };
      trace();
      g.stroke({ color: PALETTE.selection, width: 6 / zoom, alpha: 0.35 * pulse, join: 'round' });
      trace();
      g.stroke({ color: PALETTE.selection, width: 2.4 / zoom, alpha: 0.95, join: 'round' });
    }
  }

  /**
   * The front, drawn on the ground it actually runs along.
   *
   * This used to join province centroids with straight sticks, which is a
   * debug view of the adjacency graph rather than a front line -- it cut across
   * territory, ignored the coast, and at any realistic zoom was not findable on
   * screen. The boundary two provinces share is recoverable from the map's arc
   * topology, so the line can follow the real border.
   *
   * Two passes: a wide soft band that reads as pressure at a glance, and a hard
   * line on top that says exactly where the boundary is. The shared geometry is
   * cached per pair, because it only changes when a province changes hands.
   */
  private drawFrontline(state: GameState): void {
    const g = this.frontLayer;
    g.clear();
    if (state.wars.length === 0) return;
    const zoom = Math.max(0.02, this.camera.zoom);
    const view = this.camera.visibleRect();
    const pad = 60 / zoom;

    const runs: number[][] = [];
    for (const p of this.index.provinces) {
      if (p.centerX < view.minX - pad || p.centerX > view.maxX + pad) continue;
      if (p.centerY < view.minY - pad || p.centerY > view.maxY + pad) continue;
      const me = state.provinces[p.id]?.controller;
      if (me === undefined) continue;
      for (const nb of p.neighbors) {
        // Each boundary belongs to exactly one of its two provinces, so it is
        // walked once however many times the pair comes up.
        if (nb < p.id) continue;
        const other = state.provinces[nb]?.controller;
        if (other === undefined || me === other) continue;
        if (!state.countries[me].atWarWith.includes(other)) continue;
        runs.push(...this.sharedBorderCached(p.id, nb));
      }
    }
    if (runs.length === 0) return;

    for (const r of runs) this.tracePolyline(g, r);
    g.stroke({ color: PALETTE.frontline, width: 10 / zoom, alpha: 0.2, cap: 'round', join: 'round' });
    for (const r of runs) this.tracePolyline(g, r);
    g.stroke({ color: PALETTE.frontline, width: 3.2 / zoom, alpha: 0.95, cap: 'round', join: 'round' });
  }

  /**
   * Seams inside a country, split by which tier they separate.
   *
   * The baked map carries none of these: classifyBorders in the map build
   * decides what an arc separates from provinceOfUnit, which maps the source
   * geometry to pre-subdivision ids, so after --subdivide every arc inside a
   * country looks internal to one province and borders.province ships empty.
   * Rather than reach back into the build, they are recovered here from the
   * ring vertices two provinces share -- the same routine the front line uses
   * -- and cached, since neither tier changes for the life of the map.
   */
  private internalCache: { province: number[][]; state: number[][] } | null = null;

  private internalBorders(): { province: number[][]; state: number[][] } {
    if (this.internalCache) return this.internalCache;
    const province: number[][] = [];
    const stateSeams: number[][] = [];
    for (const p of this.index.provinces) {
      for (const nb of p.neighbors) {
        // Each seam belongs to exactly one of its two provinces.
        if (nb <= p.id) continue;
        const other = this.index.provinces[nb];
        if (!other) continue;
        const runs = this.sharedBorderCached(p.id, nb);
        if (other.stateId === p.stateId) province.push(...runs);
        else stateSeams.push(...runs);
      }
    }
    this.internalCache = { province, state: stateSeams };
    return this.internalCache;
  }

  private frontCache = new Map<number, number[][]>();

  private sharedBorderCached(a: ProvinceId, b: ProvinceId): number[][] {
    const key = a * 100_000 + b;
    let runs = this.frontCache.get(key);
    if (runs === undefined) {
      runs = this.index.sharedBorder(a, b);
      this.frontCache.set(key, runs);
    }
    return runs;
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
