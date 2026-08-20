import { clockFromHours, type GameClock } from './calendar';

export type Speed = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Real milliseconds required to advance one in-game hour, per speed step.
 *
 * Speed 0 is paused. Speed 1 is a day every 24 seconds, for the hour either
 * side of a declaration; speed 5 is about a week a second, which puts the
 * twelve-year campaign inside a ten-minute sitting. The old top speed was
 * 16ms/hour -- a month every twelve seconds, half an hour for a campaign --
 * which on a phone reads as the fast-forward being broken rather than fast.
 *
 * The simulation costs roughly 2ms per game-day, so even the top step spends
 * under 2% of a second's compute on the model; the ladder is bounded by what
 * a player can follow, not by what the machine can do.
 */
export const MS_PER_HOUR: readonly number[] = [Infinity, 1000, 300, 100, 30, 6];

/**
 * Hard cap on catch-up work in one frame. Without it a stalled tab returns and
 * tries to simulate hours of game time in a single frame, which then stalls
 * again -- the classic death spiral.
 */
export const MAX_CATCHUP_TICKS = 240;

export interface TickContext {
  clock: GameClock;
  /** True on the first hour of a new day (hour === 0). */
  newDay: boolean;
  newWeek: boolean;
  newMonth: boolean;
  newYear: boolean;
}

export type TickListener = (ctx: TickContext) => void;

/**
 * Owns the simulation clock and decides *when* work happens. It never touches
 * game state itself -- listeners do. Rendering is deliberately decoupled: the
 * renderer reads `alpha` to interpolate between the last two ticks.
 */
export class TimeEngine {
  private totalHours: number;
  private accumulatorMs = 0;
  private listeners: TickListener[] = [];
  private _speed: Speed = 0;
  private _lastTickCount = 0;

  constructor(startHours = 0) {
    this.totalHours = startHours;
  }

  get clock(): GameClock {
    return clockFromHours(this.totalHours);
  }

  get hours(): number {
    return this.totalHours;
  }

  get speed(): Speed {
    return this._speed;
  }

  set speed(v: Speed) {
    if (v === this._speed) return;
    this._speed = v;
    // Drop partial progress so a speed change never rolls a tick early or late.
    this.accumulatorMs = 0;
  }

  get paused(): boolean {
    return this._speed === 0;
  }

  /** Fraction of the way to the next tick, for render-side interpolation. */
  get alpha(): number {
    if (this._speed === 0) return 0;
    const per = MS_PER_HOUR[this._speed];
    return Math.min(1, this.accumulatorMs / per);
  }

  /** Ticks executed during the most recent `advance` call. */
  get lastTickCount(): number {
    return this._lastTickCount;
  }

  on(listener: TickListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Consumes real elapsed time and runs the ticks it has paid for. */
  advance(dtMs: number): number {
    this._lastTickCount = 0;
    if (this._speed === 0 || dtMs <= 0) return 0;

    // Clamp pathological dt (tab was backgrounded) before it enters the budget.
    this.accumulatorMs += Math.min(dtMs, 1000);
    const per = MS_PER_HOUR[this._speed];

    let ticks = 0;
    while (this.accumulatorMs >= per && ticks < MAX_CATCHUP_TICKS) {
      this.accumulatorMs -= per;
      this.tickOnce();
      ticks++;
    }
    if (ticks >= MAX_CATCHUP_TICKS) this.accumulatorMs = 0;

    this._lastTickCount = ticks;
    return ticks;
  }

  /** Advances exactly n hours, ignoring real time. Used by tests and headless runs. */
  step(hours: number): void {
    for (let i = 0; i < hours; i++) this.tickOnce();
  }

  private tickOnce(): void {
    this.totalHours++;
    const clock = clockFromHours(this.totalHours);
    const newDay = clock.hour === 0;
    const ctx: TickContext = {
      clock,
      newDay,
      newWeek: newDay && clock.dayOfWeek === 0,
      newMonth: newDay && clock.day === 1,
      newYear: newDay && clock.day === 1 && clock.month === 1,
    };
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](ctx);
  }
}
