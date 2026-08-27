import { ProvinceIndex } from '../sim/map/ProvinceIndex';
import type { MapDataJson } from '../sim/map/MapData';
import { createScenario } from '../sim/scenario/europe1936';
import { Simulation } from '../sim/Simulation';
import { TimeEngine, type Speed } from '../sim/time/TimeEngine';
import { CommandQueue, type Command } from '../sim/core/commands';
import type { GameState, ProvinceId } from '../sim/core/types';
import { MapRenderer, type PlanLine, type SelectionScope } from '../render/MapRenderer';
import type { MapMode } from '../render/palette';
import { TouchController } from '../input/TouchController';
import { ZOOM_AGGREGATE_STATES } from '../render/layers/UnitLayer';
import {
  planTransport, sealiftCapacity, type TransportBlock,
} from '../sim/military/movement';
import { nextArmyName } from '../sim/military/command';
import { UI } from '../ui/strings';

/**
 * The tools on the battle-plan bar.
 *
 * `front`, `offensive` and `garrison` are painted -- a stroke along the ground
 * they cover. `spearhead` and `invade` are aimed: one province is the target,
 * and a stroke would be four ways of saying the same thing.
 */
export type PlanTool = 'front' | 'offensive' | 'garrison' | 'spearhead' | 'invade' | null;

/** Tools drawn with a stroke rather than a tap. */
const PAINTED = new Set<PlanTool>(['front', 'offensive', 'garrison']);

/** Tools that take a single objective from a tap. */
const AIMED = new Set<PlanTool>(['spearhead', 'invade']);

/**
 * Composition root. Owns the loop and wires the three halves of the program
 * together: the deterministic simulation, the renderer, and input.
 *
 * The loop is deliberately simple -- `advance` decides how many simulation
 * hours the elapsed real time paid for, and rendering happens exactly once per
 * animation frame regardless. Nothing here may reach into GameState directly;
 * mutations go through the command queue so a replay of the same commands
 * reproduces the same game.
 */

export interface GameOptions {
  canvasParent: HTMLElement;
  mapData: MapDataJson;
  seed?: number;
  playerTag?: string;
  /** Freezes all animation so screenshots are byte-comparable. */
  staticMode?: boolean;
  resolution?: number;
}

export interface SelectionState {
  province: ProvinceId | null;
  /**
   * Which tier the player is asking about.
   *
   * The map has two, and they answer different questions: a province is where
   * a division stands and what it marches through; a state is what holds the
   * factories, the resources and the building slots. Tapping the ground picks
   * a province; the panel can widen the same tap to the state it belongs to,
   * and the outline on the map follows.
   */
  scope: SelectionScope;
  /**
   * Divisions under orders.
   *
   * Not "whatever is standing in the selected province": a stack tap fills it
   * from a province, an army fills it from a formation, and the garrison list
   * fills it one division at a time. What moves is what is in here.
   */
  divisions: number[];
  /** The army the selection came from, when it came from one. */
  army: number | null;
}

export class Game {
  readonly index: ProvinceIndex;
  readonly renderer: MapRenderer;
  readonly sim: Simulation;
  readonly time: TimeEngine;
  readonly commands = new CommandQueue();
  readonly input: TouchController;

  state: GameState;
  selection: SelectionState = { province: null, scope: 'province', divisions: [], army: null };

  /** Milliseconds the last frame took, for display-only easing in the HUD. */
  lastFrameMs = 16.667;
  private rafId = 0;
  private lastFrameTime = 0;
  private running = false;
  private listeners: (() => void)[] = [];

  /**
   * Opens a HUD panel. Installed by the HUD; the simulation never calls it.
   * Panels that are not nav destinations -- the designer, the province sheet --
   * are reached from inside another panel, which needs a way to say so.
   */
  openPanel?: (id: string | null) => void;

  /** Set by the order-drag gesture so the HUD can draw a preview arrow. */
  dragOrder: {
    fromX: number; fromY: number; toX: number; toY: number;
    /** Province under the finger, or null where the drop would do nothing. */
    target: ProvinceId | null;
  } | null = null;

  /**
   * The marquee being dragged, in screen space, so the HUD can draw it.
   *
   * Screen space rather than world: it is a rubber band on the glass, not a
   * region of the map, and a band drawn in world coordinates would stretch and
   * shear if the camera moved under the finger.
   */
  boxSelect: { x0: number; y0: number; x1: number; y1: number } | null = null;

  /**
   * Whether the next stroke on the map draws a marquee instead of panning.
   *
   * A tool the player picks up, not a gesture inferred from timing. The first
   * attempt read a press that had become a hold and then moved as a marquee,
   * which is the same shape as the ordinary way a thumb pans -- rest, then
   * drag -- and it took panning away outright: measured, a drag that should
   * have moved the camera 100px moved it 0. There is no modifier key on a
   * phone, so the modifier has to be a button.
   *
   * It disarms itself after one rectangle. A mode the player has to remember
   * to leave is a mode they will be stuck in.
   */
  boxSelectArmed = false;

  /**
   * Whether the rectangle being drawn raises a formation instead of selecting.
   *
   * 「下の追加から範囲選択して未所属、他の軍に所属してる師団を新たに一つの軍に
   * できたりとか、今一個ずつタップで編成に加えてる」. Boxing and then forming
   * were two separate acts with a menu between them, so building an army out
   * of odds and ends meant tapping each division in. The ＋ on the officer
   * strip sets this, and the box that follows is the army.
   */
  boxRaisesArmy = false;

  /**
   * The battle-plan tool the player has picked up, or null.
   *
   * The reference has a 「戦闘計画」 toolbar along the foot of the screen and a
   * plan is drawn by dragging on the map with one of its tools held. Picking
   * one up here does the same thing: the next stroke paints instead of panning.
   */
  planTool: PlanTool = null;

  /** Provinces the current stroke has passed over, in the order they were hit. */
  planDraft: ProvinceId[] = [];

  /** Set while a stroke is in progress, so the map can draw what is being drawn. */
  planPainting = false;

  private constructor(index: ProvinceIndex, renderer: MapRenderer, state: GameState) {
    this.index = index;
    this.renderer = renderer;
    this.state = state;
    this.sim = new Simulation(state, index);
    this.time = new TimeEngine(state.clock.totalHours);

    this.input = new TouchController(renderer.camera, {
      onTap: (wx, wy, sx, sy) => this.handleTap(wx, wy, sx, sy),
      onLongPress: (wx, wy, sx, sy) => this.handleTap(wx, wy, sx, sy),
      canStartOrderDrag: (wx, wy) => this.canDragFrom(wx, wy),
      onOrderDrag: (phase, fx, fy, tx, ty) => this.handleOrderDrag(phase, fx, fy, tx, ty),
      canStartBoxSelect: () => this.boxSelectArmed,
      onBoxSelect: (phase, x0, y0, x1, y1) => this.handleBoxSelect(phase, x0, y0, x1, y1),
      canStartPaint: () => this.planTool !== null && PAINTED.has(this.planTool),
      onPaint: (phase, wx, wy) => this.handlePaint(phase, wx, wy),
      onCameraChange: () => { /* camera is read every frame; nothing to invalidate */ },
    });
    this.input.attach(renderer.canvas);

    this.time.on((ctx) => this.sim.tick(ctx));
  }

  static async create(opts: GameOptions): Promise<Game> {
    const index = ProvinceIndex.load(opts.mapData);
    const state = createScenario(index, { seed: opts.seed, playerTag: opts.playerTag });
    const renderer = await MapRenderer.create({
      canvasParent: opts.canvasParent,
      index,
      staticMode: opts.staticMode,
      resolution: opts.resolution,
    });
    const game = new Game(index, renderer, state);
    game.focusOnPlayer();
    return game;
  }

  /**
   * Opens on the player's own country rather than the whole theatre. Fitting
   * all of Europe into a portrait phone leaves the map a postage stamp adrift
   * in ocean, which is a poor first impression and a poor default.
   */
  focusOnPlayer(): void {
    const me = this.state.countries[this.state.meta.playerCountry];
    const home = this.index.provinces.filter(
      (p) => this.state.provinces[p.id].owner === me.id,
    );
    const capital = this.index.get(me.capital);
    let minX = capital.bbox[0], minY = capital.bbox[1];
    let maxX = capital.bbox[2], maxY = capital.bbox[3];
    for (const p of home) {
      // Only count territory near the capital, so overseas holdings do not drag
      // the opening view out into the Atlantic.
      if (Math.hypot(p.centerX - capital.centerX, p.centerY - capital.centerY) > 1400) continue;
      minX = Math.min(minX, p.bbox[0]);
      minY = Math.min(minY, p.bbox[1]);
      maxX = Math.max(maxX, p.bbox[2]);
      maxY = Math.max(maxY, p.bbox[3]);
    }
    // Show the neighbourhood, not just the nation: a grand strategy map is
    // about who you border.
    const padX = (maxX - minX) * 0.55;
    const padY = (maxY - minY) * 0.55;
    this.renderer.camera.fit({
      minX: minX - padX, maxX: maxX + padX,
      minY: minY - padY, maxY: maxY + padY,
    }, 0.02);
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      // Clamped generously, not tightly. At 100ms this was a second clock:
      // any frame slower than 10fps handed the simulation less time than had
      // actually passed, so on a phone that dipped the date crawled and the
      // speed control appeared to do nothing. TimeEngine already caps a single
      // step at a second and caps catch-up ticks, which is where that job
      // belongs; this only needs to stop `now` jumping after a backgrounded tab.
      const dt = Math.min(500, now - this.lastFrameTime);
      this.lastFrameTime = now;
      this.tickFrame(dt);
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** One frame of work. Exposed so tests can drive the loop deterministically. */
  tickFrame(dtMs: number): void {
    this.lastFrameMs = dtMs;
    this.time.advance(dtMs);
    this.input.update(dtMs);
    this.renderer.setDragOrder(this.dragOrder);
    this.renderer.setPlans(this.planLines());
    // Harbours are pointed out while a tool that needs one is in hand.
    this.renderer.setPortsLit(this.planTool === 'invade');
    this.renderer.update(dtMs, this.state);
    for (const fn of this.listeners) fn();
  }

  /** Advances the simulation by whole hours, bypassing real time. */
  stepHours(hours: number): void {
    this.time.step(hours);
  }

  onFrame(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  issue(cmd: Command): void {
    this.commands.push(cmd);
    // Applied at once, not on the next simulation hour. Deferring looks
    // identical while the clock runs and is fatal while paused: no hour ever
    // elapses, so the queue is never read and the order is silently swallowed
    // -- and pausing to give orders is how this genre is played. Every
    // mutation still reaches the simulation only through `execute`, and the
    // same seed with the same order sequence still reproduces the same game.
    this.drainCommands();
  }

  private drainCommands(): void {
    const cmds = this.commands.drain();
    if (cmds.length === 0) return;
    for (const cmd of cmds) {
      this.sim.execute(cmd);
      this.onCommand?.(this.state, cmd);
    }
  }

  /** Test hook: observes commands after the simulation has applied them. */
  onCommand: ((state: GameState, cmd: Command) => void) | null = null;

  /** True once the scenario has resolved one way or the other. */
  get finished(): boolean {
    return this.state.outcome.status !== 'playing';
  }

  // -------------------------------------------------------------------------
  // Speed & view
  // -------------------------------------------------------------------------

  get speed(): Speed {
    return this.time.speed;
  }

  /** The speed the clock runs at when unpaused; survives a pause. */
  private resumeSpeed: Exclude<Speed, 0> = 3;

  /** Choose the speed to resume at without leaving the pause. */
  pauseAt(s: Exclude<Speed, 0>): void {
    this.resumeSpeed = s;
  }

  /** What the speed control should read, paused or not. */
  get chosenSpeed(): Exclude<Speed, 0> {
    return this.time.speed === 0 ? this.resumeSpeed : this.time.speed;
  }

  setSpeed(s: Speed): void {
    if (s !== 0) this.resumeSpeed = s;
    this.time.speed = s;
  }

  togglePause(): void {
    // Resume at the speed the player chose, not at a constant. Pausing at 5 to
    // read a battle and coming back at 3 is a speed change the player did not
    // ask for, and they have no way to tell it happened.
    if (this.time.speed === 0) {
      this.time.speed = this.resumeSpeed;
    } else {
      this.resumeSpeed = this.time.speed;
      this.time.speed = 0;
    }
  }

  setMapMode(mode: MapMode): void {
    this.renderer.setMapMode(mode);
  }

  resize(w: number, h: number): void {
    this.renderer.resize(w, h);
  }

  /**
   * A colour per formation, so two armies on one border are two lines.
   *
   * Not the national colour: every one of these plans belongs to the same
   * nation, and drawing them all in it would answer a question nobody asked
   * while hiding the one that was. Assigned by position in the country's own
   * list rather than by army id, so disbanding the second army does not
   * recolour the third.
   *
   * None of them is near the pale gold of a movement arrow (0xf2d98a). An
   * amber in this list read as the same object as the arrows converging on
   * it, and a front line the player cannot tell from the marching orders
   * heading toward it is not showing them anything.
   */
  /** The stroke in progress, in the reference's own pale plan blue. */
  private static readonly PLAN_DRAFT_COLOR = 0x9fe8ff;

  private static readonly PLAN_COLORS = [
    0x5ec8ff, 0xff7a5c, 0x7fe07f, 0xc79bff, 0x2fd6c0, 0xff5ca8,
  ];

  /** The player's standing orders, as lines the map can draw. */
  private planLines(): PlanLine[] {
    const me = this.state.meta.playerCountry;
    const armies = (this.state.armies ?? []).filter(
      (a) => a.owner === me && !a.isArmyGroup,
    );
    const out: PlanLine[] = [];
    // What the finger is drawing right now, ahead of any of the standing
    // orders: a stroke the player cannot see as they make it is a stroke they
    // cannot correct.
    if (this.planPainting && this.planDraft.length > 0) {
      out.push({
        owner: me,
        provinces: [...this.planDraft],
        targets: this.planTool === 'offensive' ? [this.planDraft[this.planDraft.length - 1]] : [],
        color: Game.PLAN_DRAFT_COLOR,
        selected: true,
        executing: true,
        label: UI.planDrafting,
      });
    }
    for (let i = 0; i < armies.length; i++) {
      const army = armies[i];
      if (army.frontProvinces.length === 0) continue;
      // Counted live rather than taken from army.divisions.length: a
      // formation that has lost half its divisions is still carrying them on
      // its books, and the tag on the line has to say what is actually there.
      const strength = army.divisions.reduce(
        (n, id) => n + (this.state.divisions[id]?.dead === false ? 1 : 0), 0,
      );
      const kind = army.order?.kind;
      // A spearhead's objective is the one place it is driving at; an
      // offensive's are the several it is spread across. Both draw as arrows,
      // and the spearhead's frontProvinces are its corridor, so the arrow runs
      // along the route rather than across open ground.
      const targets = army.order === null ? []
        : army.order.kind === 'offensive' ? army.order.targets
        : army.order.kind === 'spearhead' ? [army.order.target]
        : [];
      out.push({
        owner: me,
        provinces: army.frontProvinces,
        targets,
        color: Game.PLAN_COLORS[i % Game.PLAN_COLORS.length],
        label: kind === 'offensive'
          ? UI.planOffensive(army.name, strength)
          : kind === 'spearhead'
            ? UI.planSpearhead(army.name, strength)
            : UI.planLabel(army.name, strength),
        executing: army.executing === true,
        // With nothing selected every plan is drawn at full strength: the
        // player is looking at the whole board. Selecting one is what pushes
        // the others back.
        selected: this.selection.army === null || this.selection.army === army.id,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /**
   * Tap a unit, then tap where it should go.
   *
   * The old interaction was tap the province, then drag out of it -- which
   * meant finding a province you had already selected, keeping your finger
   * inside a target the size of a fingernail, and dragging without the gesture
   * being read as a pan. Tapping the counter is aiming at the thing that is
   * actually drawn, and the second tap can land anywhere. Dragging still works.
   */
  private handleTap(worldX: number, worldY: number, screenX: number, screenY: number): void {
    const mine = this.state.meta.playerCountry;
    // Touch targets need slack: a fingertip covers roughly 8mm, and coastal
    // provinces are frequently narrower than that on screen.
    const slackWorld = 22 / Math.max(1e-4, this.renderer.camera.zoom);
    const id = this.index.pickNearest(worldX, worldY, slackWorld);

    // A tool that is aimed rather than drawn takes the tap outright: a
    // spearhead has one objective and a landing has one beach, and a stroke
    // would be four ways of saying the same thing. Painted tools fall through
    // -- a stroke is what those are for -- so a tap with one held is just a
    // tap, and the player can still read the ground while holding a pen.
    if (id !== null && AIMED.has(this.planTool)) {
      const tool = this.planTool;
      this.planDraft = [id];
      if (tool === 'invade') { this.orderInvasion(id); return; }
      this.commitPlanDraft();
      return;
    }

    const hit = this.renderer.units.pickCounter(screenX, screenY);

    // Counter or ground? Both are under the same finger -- a counter is drawn
    // lifted above its province centre, so its box overhangs its neighbours --
    // and outside the plate the nearer of the two in screen space is the one
    // being aimed at. Testing the counter first instead made its box win every
    // tap inside 18px of it, which at map scale spans three provinces: with a
    // stack selected there was then no way to name a destination next to it,
    // because the tap kept landing back on the stack.
    //
    // A tap on the counter's own box is exempt from that arbitration, and has
    // to be. The counter is 20 to 27 pixels tall and is lifted roughly its own
    // height above its province centre, so the province centre is the nearer
    // of the two over most of the counter's lower half: the player pressed the
    // unit, saw the province sheet open instead, and pressed harder. Measured
    // on a lattice over every one of the player's drawn counters, at the zoom
    // the game opens at, 41% of taps that landed on a counter selected the
    // ground. That was the whole of "the divisions are hard to tap".
    let takeCounter = hit !== null && hit.owner === mine;
    if (takeCounter && !hit!.inside && id !== null && id !== hit!.province) {
      const p = this.index.get(id);
      const dx = this.renderer.camera.worldToScreenX(p.centerX) - screenX;
      const dy = this.renderer.camera.worldToScreenY(p.centerY) - screenY;
      const hx = hit!.x - screenX;
      const hy = hit!.y - screenY;
      if (dx * dx + dy * dy < hx * hx + hy * hy) takeCounter = false;
    }

    if (takeCounter) {
      // Tapping the stack you already have selected puts it down again.
      if (this.ordering && this.selection.province === hit!.province) {
        this.unitSelected = false;
        this.selectProvince(null);
        return;
      }
      this.selectProvince(hit!.province);
      this.unitSelected = this.selection.divisions.length > 0;
      return;
    }

    if (this.ordering && id !== null && id !== this.selection.province) {
      this.sendTo(id);
      // The stack stays selected, as it does in the real game, so a second
      // objective can be given without hunting for the counter again.
      return;
    }

    this.unitSelected = false;
    this.selectProvince(id);
  }

  private ordering = false;

  /**
   * Whether the current selection is a stack under orders rather than a
   * province being looked at. Only a tap on the player's own counter sets it,
   * and the counter is drawn differently while it holds, because on a touch
   * screen the same gesture reads the map and commands the army.
   */
  get unitSelected(): boolean {
    return this.ordering;
  }

  set unitSelected(on: boolean) {
    if (this.ordering === on) return;
    this.ordering = on;
    this.pushSelection();
  }

  private pushSelection(): void {
    this.renderer.setSelection(this.selection.province, this.ordering, this.selection.scope);
  }

  /** Divisions of the player's that are alive and standing in this province. */
  private garrisonOf(id: ProvinceId | null): number[] {
    if (id === null) return [];
    return this.state.provinces[id].divisions.filter(
      (d) => this.state.divisions[d] && !this.state.divisions[d].dead
        && this.state.divisions[d].owner === this.state.meta.playerCountry,
    );
  }

  selectProvince(id: ProvinceId | null): void {
    this.selection.province = id;
    this.selection.divisions = this.garrisonOf(id);
    this.selection.army = null;
    if (id === null) this.selection.scope = 'province';
    this.pushSelection();
  }

  /**
   * Widens or narrows what the outline and the panel are talking about,
   * without changing which province was tapped.
   */
  setSelectionScope(scope: SelectionScope): void {
    if (this.selection.scope === scope) return;
    this.selection.scope = scope;
    this.pushSelection();
  }

  /**
   * Puts a named set of divisions under orders, whatever they belong to.
   *
   * This is what makes a formation something you can move rather than a note
   * in a panel: an army selected here marches as an army, and the map centres
   * on it so the next tap has somewhere to land.
   */
  selectDivisions(divisions: number[], opts: { army?: number | null; centre?: boolean } = {}): void {
    const live = divisions.filter((d) => {
      const div = this.state.divisions[d];
      return div && !div.dead && div.owner === this.state.meta.playerCountry;
    });
    this.selection.divisions = live;
    this.selection.army = opts.army ?? null;
    if (live.length > 0) {
      const at = this.state.divisions[live[0]].provinceId;
      this.selection.province = at;
      this.selection.scope = 'province';
      if (opts.centre !== false) {
        const p = this.index.get(at);
        this.renderer.camera.centerOn(p.centerX, p.centerY);
      }
    }
    this.ordering = live.length > 0;
    this.pushSelection();
  }

  /**
   * Rubber-band selection.
   *
   * The counters are what is picked, not the provinces: the player is drawing
   * a box around units they can see, and a province with nothing in it inside
   * the same box is not part of what they meant. Everything the box catches
   * that is theirs goes under orders at once, which is the difference between
   * moving an army and tapping nineteen counters.
   */
  private handleBoxSelect(
    phase: 'start' | 'move' | 'end' | 'cancel',
    x0: number, y0: number, x1: number, y1: number,
  ): void {
    if (phase === 'cancel') {
      this.boxSelect = null;
      this.boxSelectArmed = false;
      this.boxRaisesArmy = false;
      return;
    }
    this.boxSelect = { x0, y0, x1, y1 };
    if (phase !== 'end') return;
    this.boxSelect = null;
    this.boxSelectArmed = false;
    const raising = this.boxRaisesArmy;
    this.boxRaisesArmy = false;

    const divisions = this.divisionsInRect(x0, y0, x1, y1);
    if (divisions.length === 0) {
      // An empty box is a deselect, not a no-op: it is how the player puts
      // everything down without hunting for the cancel button.
      this.unitSelected = false;
      this.selectProvince(null);
      return;
    }
    // The camera stays where the player put it. Centring on the first
    // division would move the map out from under a box they just finished
    // drawing, which is the one moment they are certain where things are.
    this.forceShouldOpen = true;
    if (raising && this.raiseArmy(divisions)) return;
    this.selectDivisions(divisions, { army: this.armyOf(divisions), centre: false });
  }

  /**
   * One stroke of a plan tool.
   *
   * Every province the finger crosses joins the draft, in order, with no
   * duplicates: a stroke that doubles back over itself is the player being
   * careful, not the player asking for the same province twice. Which
   * provinces are eligible depends on the tool -- a front is drawn on our own
   * ground, an offensive on somebody else's -- so a finger that wanders across
   * the border while tracing a line does not put half the line in Poland.
   */
  private handlePaint(phase: 'start' | 'move' | 'end' | 'cancel', wx: number, wy: number): void {
    if (phase === 'cancel') {
      this.planDraft = [];
      this.planPainting = false;
      this.planTool = null;
      return;
    }
    if (phase === 'start') {
      this.planDraft = [];
      this.planPainting = true;
    }
    if (phase === 'move' || phase === 'start') {
      const id = this.index.pickNearest(wx, wy);
      if (id !== null && this.paintable(id) && !this.planDraft.includes(id)) {
        this.planDraft.push(id);
      }
      return;
    }
    // Released. The draft becomes the order, and the tool is put down: a mode
    // the player has to remember to leave is a mode they get stuck in.
    this.commitPlanDraft();
  }

  /**
   * Ships the selection to a province across the water.
   *
   * 「湾から軍を海上輸送できるように」. The crossing itself has been in the
   * simulation since naval movement was gated -- a route may cross a sea link,
   * it costs shipping, and a country with no dockyards cannot make one -- but
   * there was no way to ask for one except by tapping a beach and hoping the
   * pathfinder felt like going that way. This asks for it outright, and says
   * how many bottoms are free to carry it.
   */
  orderInvasion(target: ProvinceId): void {
    this.planTool = null;
    this.planDraft = [];
    this.sendTo(target);
  }

  /**
   * Why the last order could not be carried out, for the interface to say.
   *
   * Only set when something actually went wrong, and cleared by whoever reads
   * it. Every way a sea crossing can fail has a different answer -- march
   * inland to a quay, take a harbour first, or build some ships -- and an
   * order that silently does nothing is the worst of the three.
   */
  transportBlock: TransportBlock | null = null;

  /**
   * Asks the selection list to fold itself away.
   *
   * Set when an order has been given, cleared by the list when it reads it.
   * The list stands over the left of the map, and the map is what the player
   * taps next -- this is the same lesson the map-mode strip and the order bar
   * both taught: a panel that eats a tap meant for the ground underneath it is
   * worse than no panel.
   */
  forceShouldShut = false;

  /**
   * Asks the selection list to open itself.
   *
   * Set only by a rectangle. Tapping a counter says "I know what this is and I
   * want to order it", and the next thing that happens is a tap on the ground;
   * drawing a rectangle asks "what did I catch?", and the next thing that
   * happens is reading the answer. The list is the answer to the second
   * question and an obstacle to the first, so it opens for one and not the
   * other.
   */
  forceShouldOpen = false;

  /**
   * Sends the selection somewhere, by whatever road or sea lane exists.
   *
   * 「陸続きじゃない所に師団移動出したら勝手に港を経由するように、海上輸送は
   * 作戦じゃない」. The routing is `orderMove`'s business -- land, then a
   * harbour, then a strait -- so this is only the part the map has to do:
   * issue it, then look at whether anybody actually set off, and say why not
   * when nobody did.
   */
  sendTo(target: ProvinceId): void {
    const divisions = [...this.selection.divisions];
    if (divisions.length === 0) return;
    this.issue({ t: 'moveDivisions', divisions, target });
    // The list of what is selected is an editor, and the editing is over: the
    // player has said where these are going. It folds to its header so the
    // ground it was standing on is ground again.
    this.forceShouldShut = true;
    const moving = divisions.some((id) => {
      const d = this.state.divisions[id];
      return d && (d.path.length > 0 || d.provinceId === target);
    });
    if (moving) return;
    const first = this.state.divisions[divisions[0]];
    if (!first) return;
    this.transportBlock = planTransport(
      this.state, this.index, first.owner, first.provinceId, target,
    ).block;
  }

  /** How many more divisions this country can put to sea right now. */
  sealiftFree(): number {
    const me = this.state.meta.playerCountry;
    let afloat = 0;
    for (const d of this.state.divisions) {
      if (d.dead || d.owner !== me || d.path.length === 0) continue;
      if (this.index.isSeaLink(d.provinceId, d.path[0])) afloat++;
    }
    return Math.max(0, sealiftCapacity(this.state, me) - afloat);
  }

  /** Whether the tool in hand may be drawn over this province. */
  private paintable(id: ProvinceId): boolean {
    const me = this.state.meta.playerCountry;
    const controller = this.state.provinces[id]?.controller;
    return this.planTool === 'offensive' ? controller !== me : controller === me;
  }

  /**
   * Turns the stroke into a standing order for the selected army.
   *
   * Public so the toolbar can commit a tool that is aimed rather than painted,
   * and so a plan drawn with nothing selected can say so instead of vanishing.
   */
  commitPlanDraft(): boolean {
    const tool = this.planTool;
    const drawn = this.planDraft;
    this.planPainting = false;
    this.planDraft = [];
    this.planTool = null;
    if (tool === null || drawn.length === 0) return false;

    // Whose plan is it? The selected army, or -- when the selection is a set of
    // divisions from several armies or from none -- a formation raised on the
    // spot to carry it. Discarding the stroke instead is what made redrawing
    // feel unreliable: a line traced over a mixed selection did nothing at all,
    // with nothing on screen to say why.
    let army = this.selection.army;
    if (army === null) {
      if (this.selection.divisions.length === 0) return false;
      if (!this.raiseArmy([...this.selection.divisions])) return false;
      army = this.selection.army;
      if (army === null) return false;
    }
    const me = this.state.meta.playerCountry;
    const order = tool === 'front'
      ? { kind: 'line' as const, anchors: drawn, span: drawn.length }
      : tool === 'offensive' ? { kind: 'offensive' as const, targets: drawn }
        : tool === 'garrison' ? { kind: 'garrison' as const, provinces: drawn }
          : { kind: 'spearhead' as const, target: drawn[0] };
    this.issue({ t: 'setArmyOrder', country: me, army, order });
    return true;
  }

  /**
   * Raises a formation and puts these divisions in it.
   *
   * Whatever they belonged to before: unassigned, or another army. Moving a
   * division between armies is what `assignDivisions` does, and the point of
   * doing it in one act is that a new army is usually made out of pieces of
   * old ones.
   *
   * The command bus does not hand back what it made, so the formation is
   * identified by difference rather than by "the highest id": the army ceiling
   * can refuse the command, and taking the newest existing army then would
   * quietly put the divisions somewhere the player did not ask for.
   */
  raiseArmy(divisions: readonly number[]): boolean {
    if (divisions.length === 0) return false;
    const me = this.state.meta.playerCountry;
    const mine = (): number[] => (this.state.armies ?? [])
      .filter((a) => a.owner === me && !a.isArmyGroup)
      .map((a) => a.id);
    const before = new Set(mine());
    this.issue({ t: 'createArmy', country: me, name: nextArmyName(this.state, me) });
    const raised = mine().find((id) => !before.has(id));
    if (raised === undefined) return false;
    this.issue({ t: 'assignDivisions', country: me, army: raised, divisions: [...divisions] });
    this.selectDivisions([...divisions], { army: raised, centre: false });
    return true;
  }

  /** The player's divisions whose counters fall inside a screen rectangle. */
  private divisionsInRect(x0: number, y0: number, x1: number, y1: number): number[] {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const mine = this.state.meta.playerCountry;
    const out: number[] = [];
    // Below the aggregation zoom one counter stands for a whole state, so what
    // the box caught is the state, not the province the counter is anchored
    // in. Reading only the anchor here selected one province's garrison out of
    // a plate the player had drawn a box around because it represented five.
    const aggregated = this.renderer.camera.zoom < ZOOM_AGGREGATE_STATES;
    for (const box of this.renderer.units.hitBoxes) {
      if (box.owner !== mine) continue;
      if (box.x < minX || box.x > maxX || box.y < minY || box.y > maxY) continue;
      const members = aggregated
        ? (this.index.data.states[this.index.get(box.province).stateId]?.provinces
          ?? [box.province])
        : [box.province];
      for (const province of members) {
        for (const id of this.garrisonOf(province)) out.push(id);
      }
    }
    return out;
  }

  /** The army every one of these divisions belongs to, or null if they differ. */
  armyOf(divisions: readonly number[]): number | null {
    let army: number | null = null;
    for (const id of divisions) {
      const div = this.state.divisions[id];
      if (!div) continue;
      if (div.armyId === null) return null;
      if (army === null) army = div.armyId;
      else if (army !== div.armyId) return null;
    }
    return army;
  }

  private canDragFrom(worldX: number, worldY: number): boolean {
    const slackWorld = 22 / Math.max(1e-4, this.renderer.camera.zoom);
    const id = this.index.pickNearest(worldX, worldY, slackWorld);
    if (id === null) return false;
    // Dragging only starts on a province the player already selected and that
    // actually holds their units, so ordinary map panning is never stolen.
    if (this.selection.province !== id) return false;
    return this.selection.divisions.length > 0;
  }

  private handleOrderDrag(
    phase: 'start' | 'move' | 'end' | 'cancel',
    fromX: number, fromY: number, toX: number, toY: number,
  ): void {
    if (phase === 'cancel') {
      this.dragOrder = null;
      return;
    }
    const slackWorld = 22 / Math.max(1e-4, this.renderer.camera.zoom);
    const target = this.index.pickNearest(toX, toY, slackWorld);
    this.dragOrder = { fromX, fromY, toX, toY, target };
    if (phase !== 'end') return;
    this.dragOrder = null;

    if (target === null || this.selection.divisions.length === 0) return;
    this.sendTo(target);
  }

  destroy(): void {
    this.stop();
    this.input.detach();
    this.renderer.destroy();
  }
}
