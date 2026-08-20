import { ProvinceIndex } from '../sim/map/ProvinceIndex';
import type { MapDataJson } from '../sim/map/MapData';
import { createScenario } from '../sim/scenario/europe1936';
import { Simulation } from '../sim/Simulation';
import { TimeEngine, type Speed } from '../sim/time/TimeEngine';
import { CommandQueue, type Command } from '../sim/core/commands';
import type { GameState, ProvinceId } from '../sim/core/types';
import { MapRenderer } from '../render/MapRenderer';
import type { MapMode } from '../render/palette';
import { TouchController } from '../input/TouchController';

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
  /** Divisions the player has selected for orders. */
  divisions: number[];
}

export class Game {
  readonly index: ProvinceIndex;
  readonly renderer: MapRenderer;
  readonly sim: Simulation;
  readonly time: TimeEngine;
  readonly commands = new CommandQueue();
  readonly input: TouchController;

  state: GameState;
  selection: SelectionState = { province: null, divisions: [] };

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

  private constructor(index: ProvinceIndex, renderer: MapRenderer, state: GameState) {
    this.index = index;
    this.renderer = renderer;
    this.state = state;
    this.sim = new Simulation(state, index);
    this.time = new TimeEngine(state.clock.totalHours);

    this.input = new TouchController(renderer.camera, {
      onTap: (wx, wy) => this.handleTap(wx, wy),
      onLongPress: (wx, wy) => this.handleTap(wx, wy),
      canStartOrderDrag: (wx, wy) => this.canDragFrom(wx, wy),
      onOrderDrag: (phase, fx, fy, tx, ty) => this.handleOrderDrag(phase, fx, fy, tx, ty),
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
      const dt = Math.min(100, now - this.lastFrameTime);
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

  setSpeed(s: Speed): void {
    this.time.speed = s;
  }

  togglePause(): void {
    this.time.speed = this.time.speed === 0 ? 3 : 0;
  }

  setMapMode(mode: MapMode): void {
    this.renderer.setMapMode(mode);
  }

  resize(w: number, h: number): void {
    this.renderer.resize(w, h);
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  private handleTap(worldX: number, worldY: number): void {
    // Touch targets need slack: a fingertip covers roughly 8mm, and coastal
    // provinces are frequently narrower than that on screen.
    const slackWorld = 22 / Math.max(1e-4, this.renderer.camera.zoom);
    const id = this.index.pickNearest(worldX, worldY, slackWorld);
    this.selectProvince(id);
  }

  selectProvince(id: ProvinceId | null): void {
    this.selection.province = id;
    this.selection.divisions = id === null
      ? []
      : this.state.provinces[id].divisions.filter(
          (d) => this.state.divisions[d] && !this.state.divisions[d].dead
            && this.state.divisions[d].owner === this.state.meta.playerCountry,
        );
    this.renderer.setSelection(id);
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
    this.issue({ t: 'moveDivisions', divisions: [...this.selection.divisions], target });
  }

  destroy(): void {
    this.stop();
    this.input.detach();
    this.renderer.destroy();
  }
}
