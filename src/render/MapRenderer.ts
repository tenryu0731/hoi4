import {
  Application, BitmapText, Container, Graphics, Matrix, Sprite, Texture, TilingSprite,
} from 'pixi.js';

import type { Province, ProvinceIndex } from '../sim/map/ProvinceIndex';
import type { CountryId, GameState, ProvinceId } from '../sim/core/types';
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
import { ports } from '../sim/military/ports';
import { isVoyage } from '../sim/military/movement';
import { FONT_PLAN, LabelLayer } from './layers/LabelLayer';
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
 * Below this zoom the province fills are drawn grouped by colour instead of one
 * by one.
 *
 * The picture is identical either way -- the groups carry the same colours the
 * individual fills do -- so the threshold is set by cost alone. Above it the
 * viewport holds few enough provinces that culling does the job; below it the
 * whole map is on screen and one Graphics per province is 4,942 of them where
 * thirty will do.
 */
const COARSE_FILL_ZOOM = 0.34;
/** Colour groups rebuilt per frame, so a capture never costs a whole frame. */
const COARSE_REBUILD_PER_FRAME = 2;

/** On-screen height of a front-line tag, and the size its atlas was built at. */
const PLAN_LABEL_PX = 12;
const PLAN_FONT_PX = 24;

/**
 * How finely a passage is divided when deciding which hulls sail together.
 *
 * Too fine and a corps that embarked over three days smears into a queue of
 * single-ship marks; too coarse and a convoy halfway across snaps back onto
 * one that has only just cast off. Eight is roughly a convoy a day on the
 * Mediterranean crossings the AI actually makes.
 */
const CONVOY_BUCKETS = 8;

/** Half-length of a convoy mark, in screen pixels at any zoom. */
const CONVOY_PX = 10;

/** A convoy under way: where it is, which way it is pointing, and how big. */
interface Lane {
  x: number;
  y: number;
  /** Unit heading, so the hull can be drawn bow-first. */
  ux: number;
  uy: number;
  n: number;
  owner: CountryId;
}

/** A hull seen from above -- blunt stern, pointed bow -- laid along a heading. */
function hull(
  g: Graphics,
  at: (lane: Lane, along: number, across: number, r: number) => { x: number; y: number },
  lane: Lane,
  r: number,
): void {
  const p = [
    at(lane, -1, -0.42, r), at(lane, 0.45, -0.42, r), at(lane, 1, 0, r),
    at(lane, 0.45, 0.42, r), at(lane, -1, 0.42, r),
  ];
  g.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < p.length; i++) g.lineTo(p[i].x, p[i].y);
  g.closePath();
}

/**
 * Which of the map's two tiers an outline belongs to. A province is where a
 * division stands; a state is what gets built in.
 */
export type SelectionScope = 'province' | 'state';

/**
 * One formation's order, reduced to what the map needs to draw it.
 *
 * Deliberately not an `Army`: the renderer has no business knowing what a
 * chain of command is, and the same shape lets a plan be drawn for something
 * that is not an army at all -- a selection of divisions the player has just
 * boxed, before they have been given a formation.
 */
export interface PlanLine {
  owner: CountryId;
  /** Provinces the order covers. */
  provinces: readonly ProvinceId[];
  /** Places an offensive is aimed at; empty for a front or a garrison. */
  targets: readonly ProvinceId[];
  color: number;
  /** Drawn at full strength; the other formations' plans stay quiet. */
  selected: boolean;
  /**
   * Whether the plan is being carried out. A plan that has been drawn but not
   * started is a proposal, and is drawn as one -- faint, with a dashed shaft
   * on its arrows -- so the map says at a glance which armies are moving and
   * which are still banking preparation.
   */
  executing: boolean;
  /** The tag written on the line: which formation, and how many divisions. */
  label: string;
}

export class MapRenderer {
  readonly app: Application;
  readonly camera: Camera;
  readonly index: ProvinceIndex;

  /** Divisions at sea, drawn on the water rather than at either quay. */
  private convoyLayer = new Graphics();

  private world = new Container();
  private oceanSprite!: TilingSprite;
  private oceanDepth!: Sprite;
  private glowLayer = new Container();
  private neutralLand = new Graphics();
  private fillLayer = new Container();
  private provinceFills: Graphics[] = [];
  /**
   * The same fills again, one Graphics per colour instead of one per province.
   *
   * At strategic zoom a province is a few pixels across and every one of them
   * still costs a transform and a batch check each frame: at 4,942 provinces
   * that is 4,942 nodes to see thirty countries. Grouping by colour draws the
   * identical picture out of about thirty. The per-province layer takes back
   * over as soon as the zoom is close enough for the difference to be visible,
   * where culling keeps the count down instead.
   */
  private coarseLayer = new Container();
  private coarseByTint = new Map<number, Graphics>();
  private coarseMembers = new Map<number, Set<number>>();
  private coarseTint: number[] = [];
  private coarseDirty = new Set<number>();
  private fillLayerIndex = 0;
  private lakeLayer = new Graphics();
  private riverLayer = new Graphics();
  private borderLayer = new Graphics();
  private grain!: TilingSprite;
  private selectionLayer = new Graphics();
  private selectScope: SelectionScope = 'province';
  private frontLayer = new Graphics();
  private planLayer = new Graphics();
  private planLabels = new Container();
  private planLabelPool: BitmapText[] = [];
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
    this.fillLayerIndex = this.world.getChildIndex(this.fillLayer);
    this.buildProvinceFills();
    this.world.addChild(this.coarseLayer);
    this.coarseLayer.visible = false;

    this.world.addChild(this.lakeLayer);
    this.world.addChild(this.riverLayer);
    this.buildWater();

    this.world.addChild(this.borderLayer);

    // --- paper grain over everything on the map ---------------------------
    this.grain = new TilingSprite({ texture: createGrainTexture(256), width: 1, height: 1 });
    this.grain.alpha = 0.38;
    stage.addChild(this.grain);

    this.world.addChild(this.frontLayer);
    this.world.addChild(this.planLayer);
    this.world.addChild(this.selectionLayer);
    this.world.addChild(this.cityLayer);

    // Nation display names come from the scenario table rather than the map,
    // which only stores tags.
    const countryNames = new Map<string, string>(NATIONS.map((n) => [n.tag, country(n.tag)]));
    this.labels = new LabelLayer(this.index, countryNames);
    this.world.addChild(this.labels.container);

    this.units = new UnitLayer(this.index);
    this.world.addChild(this.units.container);
    // Front-line tags go over the counters. They name a formation, and a
    // formation is exactly what the counters underneath are part of.
    this.world.addChild(this.convoyLayer);
    this.world.addChild(this.planLabels);
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
    this.coarseTint = new Array(this.provinceFills.length).fill(PALETTE.landBase);
    this.coarseMembers.set(
      PALETTE.landBase,
      new Set(this.provinceFills.map((_, i) => i)),
    );
    this.coarseDirty.add(PALETTE.landBase);
  }

  /**
   * Rebuilds the colour groups whose membership changed.
   *
   * Only the groups: a province changing hands moves it out of one colour and
   * into another, so two groups are redrawn and the other thirty are left
   * alone. Redrawing all of them on every capture would put a hitch into every
   * game day of a war.
   */
  private rebuildCoarse(limit = Infinity): void {
    let budget = limit;
    for (const tint of [...this.coarseDirty]) {
      if (budget-- <= 0) break;
      this.coarseDirty.delete(tint);
      const members = this.coarseMembers.get(tint);
      let g = this.coarseByTint.get(tint);
      if (!members || members.size === 0) {
        if (g) { g.clear(); g.visible = false; }
        continue;
      }
      if (!g) {
        g = new Graphics();
        this.coarseByTint.set(tint, g);
        this.coarseLayer.addChild(g);
      }
      g.clear();
      g.visible = true;
      for (const id of members) {
        for (const ring of this.index.provinces[id].rings) this.traceFloatRing(g, ring);
      }
      g.fill({
        texture: this.reliefTexture,
        color: 0xffffff,
        textureSpace: 'global',
        matrix: new Matrix().scale(1.6, 1.6),
      });
      g.tint = tint;
    }
  }

  private moveToTint(id: ProvinceId, tint: number): void {
    const was = this.coarseTint[id];
    if (was === tint) return;
    this.coarseMembers.get(was)?.delete(id);
    let set = this.coarseMembers.get(tint);
    if (!set) { set = new Set(); this.coarseMembers.set(tint, set); }
    set.add(id);
    this.coarseTint[id] = tint;
    this.coarseDirty.add(was);
    this.coarseDirty.add(tint);
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
  /**
   * Whether harbours are being pointed out.
   *
   * Set while the player is holding the transfer or the assault tool, which is
   * the one moment they need to know where a ship can put in. The rest of the
   * time a port is drawn faintly: it is a fact about the map, not a thing
   * competing with the counters for attention.
   */
  private portsLit = false;

  /** Exposed so a test can assert the harbours are being pointed out. */
  get portsAreLit(): boolean {
    return this.portsLit;
  }

  setPortsLit(lit: boolean): void {
    if (lit === this.portsLit) return;
    this.portsLit = lit;
    if (this.cityLayer.visible && this.lodStep >= 0) {
      this.buildCities(this.camera.zoom, this.lodStep);
    }
  }

  private buildCities(zoom: number, step: number): void {
    const g = this.cityLayer;
    g.clear();
    const u = 1 / Math.max(1e-4, zoom);

    // Harbours, under the towns. A ring rather than a disc, so a port that is
    // also a city reads as both rather than as a bigger city, and in a colour
    // nothing else on the map uses.
    const harbours = ports(this.index);
    const lit = this.portsLit;
    for (const id of harbours) {
      const p = this.index.provinces[id];
      if (!p) continue;
      g.circle(p.centerX, p.centerY, (lit ? 6.4 : 4.6) * u);
    }
    g.stroke({ color: 0x6fd0e0, width: (lit ? 2.4 : 1.4) * u, alpha: lit ? 0.95 : 0.42 });
    if (lit) {
      for (const id of harbours) {
        const p = this.index.provinces[id];
        if (!p) continue;
        g.circle(p.centerX, p.centerY, 2.2 * u);
      }
      g.fill({ color: 0x6fd0e0, alpha: 0.8 });
    }

    // The towns themselves only once the map is close enough to carry them.
    if (step < 2) return;
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

    // Three tiers, drawn thinnest first so the heavier ones cover their ends.
    //
    // Both tiers were already being drawn before this, at 1.0px/0.34 and
    // 1.3px/0.62 -- a third of a pixel apart on a phone, which is no
    // difference at all, and the report was that the map showed provinces and
    // no states. It was showing both, as one undifferentiated mesh. What
    // separates them has to be weight, not alpha: 0.9 / 2.0 / 2.8 px of dark
    // core, each with its own halo, so the eye sorts them without being told.
    const internal = this.internalBorders();
    if (step >= 2) {
      // The finest tier is a hairline with no halo. It is texture: it says
      // "this cell divides further", and it must not compete with the state
      // seam sitting on top of it.
      //
      // Dark, not the mid-tone borderProvince: a stroke this thin lands on
      // less than one physical pixel once px() has scaled it for the LOD
      // band, so the rasteriser hands back a fraction of whatever alpha it
      // was given. At 0.9px of (92,83,67) over Germany's grey the seams were
      // measurably present and visually absent -- 3424 world units of them
      // inside Germany alone, and the screenshot showed three lines.
      for (const line of internal.province) this.tracePolyline(g, line);
      g.stroke({ color: 0x14110c, width: px(0.8), alpha: 0.22, join: 'round' });
    }
    if (step >= 1) {
      // 「プロヴィンスとステートの境目を強調して」. The two tiers have to be
      // told apart at a glance, and at 0.9 against 1.5 pixels they were not:
      // side by side that is a fifth of a pixel of difference once the LOD
      // scaling has been applied. So the seam gets a light halo under it as
      // well as nearly three times the weight -- the same engraving the
      // frontier gets, at half the strength, which puts the three tiers a
      // clear step apart: hairline, seam, frontier.
      //
      // The halo works now because a state boundary is a real polyline again.
      // It could not before: states were groups of provinces and their edges
      // were recovered per-edge from midpoints, so the light stroke drew a
      // lozenge around every two-vertex run and the map read as scale armour.
      // The boundaries now come straight out of the topology as whole arcs.
      const seams = this.index.data.borders.province;
      for (const line of seams) this.tracePolyline(g, line);
      g.stroke({ color: 0xf0e6cf, width: px(3.4), alpha: 0.16, join: 'round', cap: 'round' });
      for (const line of seams) this.tracePolyline(g, line);
      g.stroke({ color: 0x14110c, width: px(2.1), alpha: 0.72, join: 'round', cap: 'round' });
    }

    for (const line of this.index.data.borders.coast) this.tracePolyline(g, line);
    g.stroke({ color: PALETTE.borderCoast, width: px(1.4), alpha: 0.7, join: 'round' });

    // Country borders get a soft light halo first, then the dark line, which is
    // what gives printed political maps their engraved look.
    for (const line of this.index.data.borders.country) this.tracePolyline(g, line);
    g.stroke({ color: 0xf0e6cf, width: px(4.4), alpha: 0.26, join: 'round', cap: 'round' });
    for (const line of this.index.data.borders.country) this.tracePolyline(g, line);
    g.stroke({ color: PALETTE.borderCountry, width: px(2.8), alpha: 0.95, join: 'round', cap: 'round' });

    const rg = this.riverLayer;
    rg.clear();
    if (step >= 2) {
      for (const line of this.index.data.rivers) this.tracePolyline(rg, line);
      rg.stroke({ color: PALETTE.river, width: px(1.3), alpha: 0.55, join: 'round', cap: 'round' });
    }

    // Harbours are drawn a zoom band earlier than towns: choosing where to
    // land is a strategic decision and it is made at strategic zoom.
    this.lodStep = step;
    this.cityLayer.visible = step >= 1;
    if (this.cityLayer.visible) this.buildCities(zoom, step);
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
  setSelection(
    id: ProvinceId | null, ordering = false, scope: SelectionScope = 'province',
    occupied?: Iterable<ProvinceId>,
  ): void {
    this.selected = id;
    this.selectScope = scope;
    this.units.setSelection(id, ordering, occupied);
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
      const tint = this.tintFor(i, state);
      this.provinceFills[i].tint = tint;
      this.moveToTint(i, tint);
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

    const coarse = cam.zoom < COARSE_FILL_ZOOM;
    if (coarse !== this.coarseLayer.visible) {
      this.coarseLayer.visible = coarse;
      // Detached rather than hidden. A hidden container still holds its
      // children, and anything walking the tree -- Pixi's own bookkeeping, the
      // perf harness -- still pays for all 4,942 of them.
      if (coarse) {
        this.rebuildCoarse();
        if (this.fillLayer.parent) this.fillLayer.removeFromParent();
      } else if (!this.fillLayer.parent) {
        this.world.addChildAt(this.fillLayer, this.fillLayerIndex);
      }
    }
    if (coarse) {
      // A few groups a frame: a province changing hands dirties two of them and
      // a group can be a whole country, so redrawing every dirty group the
      // moment it is marked would put the war's own progress into the frame
      // budget. One frame of a stale shade is not visible; a dropped frame is.
      if (this.coarseDirty.size > 0) this.rebuildCoarse(COARSE_REBUILD_PER_FRAME);
    } else {
      this.cullProvinces(cam);
    }

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
      this.drawPlans(state);
      this.drawConvoys(state);
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
   * One army's standing order, as the map has to show it.
   *
   * The simulation already works out which provinces an order covers and
   * re-works it every day as the border moves -- that is what makes a front a
   * standing instruction rather than a list of destinations. None of it was
   * drawn, so the player set an order in a panel and then had no way to see
   * where their army had been told to stand, which is the half of the feature
   * that makes it worth having.
   */
  private plans: readonly PlanLine[] = [];

  /** Kept by reference: the caller builds a fresh array every frame. */
  setPlans(plans: readonly PlanLine[]): void {
    this.plans = plans;
  }

  /**
   * Battle plans, drawn along the ground the order actually covers.
   *
   * A front is the outward face of the provinces the army was given: every arc
   * between one of them and a province that is neither in the plan nor ours.
   * That is the line the army is holding, and it is drawn in the formation's
   * own colour so two armies on one border can be told apart.
   *
   * An offensive additionally gets an arrow per objective, from the middle of
   * its own line to the place it has been aimed at. HOI4 draws these as fat
   * curved arrows; a phone at 0.18 zoom has no room for the curve, so they are
   * straight, and they are drawn under the counters rather than over them.
   */
  private drawPlans(state: GameState): void {
    const g = this.planLayer;
    g.clear();
    const zoom = Math.max(0.02, this.camera.zoom);
    const labels: { text: string; x: number; y: number; color: number }[] = [];
    if (this.plans.length === 0) {
      this.placePlanLabels(labels, zoom);
      return;
    }

    for (const plan of this.plans) {
      if (plan.provinces.length === 0) continue;
      const inPlan = new Set(plan.provinces);
      // Each arc is carried with the centre of the province that holds it, so
      // the teeth below know which way is home without having to ask the map.
      const runs: { pts: number[]; homeX: number; homeY: number }[] = [];
      for (const id of plan.provinces) {
        const p = this.index.provinces[id];
        if (!p) continue;
        for (const nb of p.neighbors) {
          if (inPlan.has(nb)) continue;
          // The outward face only: an arc onto our own rear areas is inside
          // the position, not the edge of it, and drawing those turns the
          // line into a filled-in blob of the army's colour.
          if (state.provinces[nb]?.controller === plan.owner) continue;
          for (const pts of this.sharedBorderCached(Math.min(id, nb), Math.max(id, nb))) {
            runs.push({ pts, homeX: p.centerX, homeY: p.centerY });
          }
        }
      }

      // A proposal reads at about half the weight of an order being carried
      // out, which is enough to see it without mistaking it for troops moving.
      const emphasis = (plan.selected ? 1 : 0.62) * (plan.executing ? 1 : 0.5);
      if (runs.length > 0) {
        for (const r of runs) this.tracePolyline(g, r.pts);
        g.stroke({
          color: plan.color, width: 11 / zoom, alpha: 0.16 * emphasis,
          cap: 'round', join: 'round',
        });
        for (const r of runs) this.tracePolyline(g, r.pts);
        g.stroke({
          color: plan.color, width: 3.6 / zoom, alpha: 0.9 * emphasis,
          cap: 'round', join: 'round',
        });
        // Teeth on the friendly side, the way the reference draws a front.
        // A plain stroke along a border is a border; the comb is what says
        // there is an army standing behind this particular line and which
        // way it is facing.
        for (const r of runs) this.traceTeeth(g, r, zoom);
        g.stroke({
          color: plan.color, width: 2.2 / zoom, alpha: 0.75 * emphasis,
          cap: 'round',
        });
      }

      // A pip on every assigned province, so a plan whose provinces happen to
      // share no outward arc -- a garrison deep in the interior -- is still
      // visible as something the army was told to do.
      const pip = 3.4 / zoom;
      for (const id of plan.provinces) {
        const p = this.index.provinces[id];
        if (!p) continue;
        g.circle(p.centerX, p.centerY, pip);
      }
      g.fill({ color: plan.color, alpha: 0.75 * emphasis });

      for (const target of plan.targets) {
        const to = this.index.provinces[target];
        if (!to) continue;
        const from = this.nearestOf(plan.provinces, to.centerX, to.centerY);
        if (!from) continue;
        this.traceArrow(
          g, from.centerX, from.centerY, to.centerX, to.centerY, zoom, plan.executing,
        );
      }
      if (plan.targets.length > 0) {
        g.stroke({
          color: plan.color, width: 3.2 / zoom, alpha: 0.85 * emphasis,
          cap: 'round', join: 'round',
        });
      }

      const anchor = this.labelAnchor(runs.map((r) => r.pts), plan.provinces);
      if (anchor) labels.push({ text: plan.label, x: anchor.x, y: anchor.y, color: plan.color });
    }

    this.placePlanLabels(labels, zoom);
  }

  /**
   * Nudges a point off the land, along the perpendicular given.
   *
   * The passage is drawn as a straight line between two harbours, and a
   * straight line between two harbours goes over a headland as often as not --
   * a ship drawn inland is worse than no ship. Stepping sideways until the
   * point is over water follows the coast closely enough at map scale, and
   * costs a handful of point-in-province tests per convoy.
   */
  private afloat(
    x: number, y: number, px: number, py: number,
  ): { x: number; y: number } {
    if (this.index.pick(x, y) === null) return { x, y };
    const len = Math.sqrt(px * px + py * py) || 1;
    const ux = px / len;
    const uy = py / len;
    const step = 26;
    for (let i = 1; i <= 8; i++) {
      for (const side of [1, -1]) {
        const nx = x + ux * step * i * side;
        const ny = y + uy * step * i * side;
        if (this.index.pick(nx, ny) === null) return { x: nx, y: ny };
      }
    }
    return { x, y };
  }

  /**
   * Divisions on the water.
   *
   * 「海を移動してる感じ出して」. A division at sea keeps the quay it left as its
   * province -- it has not arrived anywhere, so it cannot be anywhere else --
   * and the counter therefore sat on the coast for the whole crossing, next to
   * the garrison that stayed behind. Nothing on the map said a corps was at
   * sea. This draws the convoy where it actually is: a hull on the line
   * between the two harbours, at the fraction of the passage it has made, with
   * a wake behind it.
   *
   * Its own mark rather than the counter moved, because the counter is a
   * formation standing on ground and this is a formation that is on none.
   */
  private drawConvoys(state: GameState): void {
    const g = this.convoyLayer;
    g.clear();
    const zoom = Math.max(0.02, this.camera.zoom);
    const u = 1 / zoom;

    // One mark per convoy, not per division: twelve divisions crossing together
    // are one convoy. Bucketed coarsely along the passage as well as by lane,
    // so a column that left on successive days reads as the two or three
    // convoys it is rather than as a dozen separate hulls a pixel apart.
    const lanes = new Map<string, Lane>();
    for (const d of state.divisions) {
      if (d.dead || d.path.length === 0) continue;
      const to = d.path[0];
      if (!isVoyage(this.index, d.provinceId, to)) continue;
      const a = this.index.provinces[d.provinceId];
      const b = this.index.provinces[to];
      if (!a || !b) continue;
      const t = Math.round(Math.min(1, Math.max(0, d.moveProgress)) * CONVOY_BUCKETS)
        / CONVOY_BUCKETS;
      const key = `${d.provinceId}:${to}:${t}:${d.owner}`;
      const lane = lanes.get(key);
      if (lane) { lane.n++; continue; }
      const dx = b.centerX - a.centerX;
      const dy = b.centerY - a.centerY;
      const at = this.afloat(
        a.centerX + dx * t, a.centerY + dy * t, dy, -dx,
      );
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      lanes.set(key, { x: at.x, y: at.y, ux: dx / len, uy: dy / len, n: 1, owner: d.owner });
    }
    if (lanes.size === 0) return;

    // Bow-first. The hull used to be drawn pointing east whatever course it
    // was on, so a convoy steaming south read as a shape lying across its own
    // wake rather than as a ship: 「船みたいな謎のもの」. A mark that does not
    // face where it is going is not a ship, it is a smudge.
    const at = (lane: Lane, along: number, across: number, r: number) => ({
      x: lane.x + lane.ux * along * r - lane.uy * across * r,
      y: lane.y + lane.uy * along * r + lane.ux * across * r,
    });
    // A fixed size on screen, as the counters are. The ceiling this replaces
    // was in world units, so it did the opposite of what a ceiling is for:
    // 26km is 11 screen pixels at the zoom the Baltic fills the phone and half
    // a pixel at the zoom Europe does, and the convoys disappeared exactly
    // when the player was looking at the sea they were crossing.
    const size = (lane: Lane) => CONVOY_PX * u * (lane.n > 3 ? 1.15 : 1);

    for (const lane of lanes.values()) {
      const r = size(lane);
      // A wake: two short strokes trailing the hull, which is what says the
      // thing is under way rather than anchored.
      for (const side of [-0.5, 0.5]) {
        const tail = at(lane, side === -0.5 ? -2.2 : -1.7, side, r);
        const head = at(lane, -0.7, side, r);
        g.moveTo(tail.x, tail.y);
        g.lineTo(head.x, head.y);
      }
    }
    g.stroke({ color: 0xd8ecf4, width: 1.6 * u, alpha: 0.5, cap: 'round' });

    // A dark shadow under the hull, so the mark separates from the sea at any
    // zoom instead of dissolving into it.
    for (const lane of lanes.values()) hull(g, at, lane, size(lane) * 1.28);
    g.fill({ color: 0x07100f, alpha: 0.55 });

    for (const lane of lanes.values()) hull(g, at, lane, size(lane));
    // The owner's colour, as on its counters. Filling this in the sea's own
    // shade -- which is what it used to be -- left nothing but the outline,
    // and an outline drifting across the Mediterranean belongs to nobody.
    g.fill({ color: 0x24313a, alpha: 0.95 });

    for (const lane of lanes.values()) {
      const r = size(lane);
      // A deck stripe in the owner's colour: the identity, on a hull small
      // enough that filling the whole thing would read as a coloured blob.
      const tint = rgbToHex(state.countries[lane.owner].color);
      const c1 = at(lane, -0.62, -0.3, r);
      const c2 = at(lane, 0.34, -0.3, r);
      const c3 = at(lane, 0.34, 0.3, r);
      const c4 = at(lane, -0.62, 0.3, r);
      g.moveTo(c1.x, c1.y);
      g.lineTo(c2.x, c2.y);
      g.lineTo(c3.x, c3.y);
      g.lineTo(c4.x, c4.y);
      g.closePath();
      g.fill({ color: tint, alpha: 0.95 });
    }

    for (const lane of lanes.values()) hull(g, at, lane, size(lane));
    g.stroke({ color: 0xe6f2f8, width: 1.3 * u, alpha: 0.95, join: 'round' });
  }

  /**
   * Where a front's tag goes: the middle of its longest continuous run.
   *
   * The longest run rather than the centroid of the provinces, because a front
   * that bends around a salient has a centroid inside enemy territory, and a
   * tag floating over the country it is aimed at reads as a claim on it.
   */
  private labelAnchor(
    runs: readonly number[][], provinces: readonly ProvinceId[],
  ): { x: number; y: number } | null {
    let best: number[] | null = null;
    for (const r of runs) if (!best || r.length > best.length) best = r;
    if (best && best.length >= 4) {
      const mid = Math.floor(best.length / 4) * 2;
      return { x: best[mid], y: best[mid + 1] };
    }
    // A plan with no outward face at all -- an interior garrison -- still has
    // provinces, and its tag belongs over them.
    const p = provinces.length > 0 ? this.index.provinces[provinces[0]] : null;
    return p ? { x: p.centerX, y: p.centerY } : null;
  }

  /**
   * Short strokes on the owning side of the line.
   *
   * The side is chosen per segment against the centre of the province the arc
   * belongs to, which is carried alongside the arc for exactly this. The first
   * version asked pickNearest where each tooth landed -- correct, and a
   * spatial-grid query per tooth per frame for a decoration. The province is
   * already known at the point the arc is collected, and a dot product costs
   * nothing.
   */
  private traceTeeth(
    g: Graphics, run: { pts: number[]; homeX: number; homeY: number }, zoom: number,
  ): void {
    const pts = run.pts;
    const len = 7 / zoom;
    // Teeth roughly every 26 screen pixels, and never on every vertex: the
    // simplified rings put their vertices very unevenly.
    const spacing = 26 / zoom;
    let since = spacing;
    for (let i = 2; i < pts.length - 2; i += 2) {
      const x = pts[i];
      const y = pts[i + 1];
      since += Math.hypot(x - pts[i - 2], y - pts[i - 1]);
      if (since < spacing) continue;
      since = 0;
      const dx = pts[i + 2] - pts[i - 2];
      const dy = pts[i + 3] - pts[i - 1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-3) continue;
      let nx = -dy / d;
      let ny = dx / d;
      // Flip the normal if it points away from the province behind the line.
      if (nx * (run.homeX - x) + ny * (run.homeY - y) < 0) { nx = -nx; ny = -ny; }
      g.moveTo(x, y);
      g.lineTo(x + nx * len, y + ny * len);
    }
  }

  /**
   * The tags themselves, pooled like the counters are.
   *
   * Constant on-screen size: a tag that scaled with the map would be
   * unreadable at the zoom a whole front is visible at, which is the only
   * zoom at which anybody wants to read it.
   */
  private placePlanLabels(
    labels: readonly { text: string; x: number; y: number; color: number }[],
    zoom: number,
  ): void {
    for (let i = 0; i < labels.length; i++) {
      let node = this.planLabelPool[i];
      if (!node) {
        node = new BitmapText({ text: '', style: { fontFamily: FONT_PLAN } });
        node.anchor.set(0.5);
        this.planLabels.addChild(node);
        this.planLabelPool.push(node);
      }
      const l = labels[i];
      if (node.text !== l.text) node.text = l.text;
      node.visible = true;
      node.tint = l.color;
      node.position.set(l.x, l.y);
      node.scale.set(PLAN_LABEL_PX / PLAN_FONT_PX / zoom);
    }
    for (let i = labels.length; i < this.planLabelPool.length; i++) {
      this.planLabelPool[i].visible = false;
    }
  }

  /** The province of `ids` whose centre is closest to a point. */
  private nearestOf(ids: readonly ProvinceId[], x: number, y: number): Province | null {
    let best: Province | null = null;
    let bestDist = Infinity;
    for (const id of ids) {
      const p = this.index.provinces[id];
      if (!p) continue;
      const dx = p.centerX - x;
      const dy = p.centerY - y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }

  /** A straight shaft with a head, in world units, left unstroked. */
  private traceArrow(
    g: Graphics, x0: number, y0: number, x1: number, y1: number, zoom: number,
    solid = true,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-3) return;
    const ux = dx / len;
    const uy = dy / len;
    // Stopped short of the objective so the head does not sit on top of
    // whatever counter is standing in it.
    const head = Math.min(len * 0.35, 22 / zoom);
    const tipX = x1 - ux * head * 0.5;
    const tipY = y1 - uy * head * 0.5;
    const shaft = Math.sqrt((tipX - x0) ** 2 + (tipY - y0) ** 2);
    if (solid) {
      g.moveTo(x0, y0);
      g.lineTo(tipX, tipY);
    } else {
      // A dashed shaft: the plan exists but nobody has been told to walk it.
      const dash = Math.max(6 / zoom, shaft / 24);
      for (let d = 0; d < shaft; d += dash * 2) {
        const e = Math.min(d + dash, shaft);
        g.moveTo(x0 + ux * d, y0 + uy * d);
        g.lineTo(x0 + ux * e, y0 + uy * e);
      }
    }
    g.moveTo(tipX - ux * head + uy * head * 0.55, tipY - uy * head - ux * head * 0.55);
    g.lineTo(tipX, tipY);
    g.lineTo(tipX - ux * head - uy * head * 0.55, tipY - uy * head + ux * head * 0.55);
  }

  /**
   * Seams inside a country, split by which tier they separate.
   *
   * The state tier is not one of them any more. States are now merged out of
   * real administrative units, so the map build knows exactly which arcs sit
   * between two of them and ships them in borders.province -- one unbroken
   * polyline per stretch of state boundary, which is what the tier wanted all
   * along.
   *
   * The province tier is still built here, because a Voronoi seam inside a
   * state exists only in the cells themselves. It is built from whole rings
   * rather than from the runs two provinces agree on. The agreement version
   * drew the map as fish scales, and the measurement says why: the average
   * boundary between two provinces is **2.7 vertices long**, so the mesh was
   * thousands of two-point capsules -- and 28% of neighbouring pairs produced
   * no run at all, leaving holes as well. A ring is a closed loop and needs no
   * agreement with anything, so the tier is simply every outline.
   */
  private internalCache: { province: number[][] } | null = null;

  private internalBorders(): { province: number[][] } {
    if (this.internalCache) return this.internalCache;
    const province: number[][] = [];
    for (const p of this.index.provinces) {
      for (const ring of p.rings) {
        const n = ring.length / 2;
        if (n < 2) continue;
        // The whole outline, as the finest tier.
        const loop: number[] = [];
        for (let i = 0; i <= n; i++) {
          const j = (i % n) * 2;
          loop.push(ring[j], ring[j + 1]);
        }
        province.push(loop);
      }
    }
    this.internalCache = { province };
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
