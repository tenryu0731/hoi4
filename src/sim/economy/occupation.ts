import type { GameState, StateRuntime } from '../core/types';

/**
 * Resistance in occupied territory.
 *
 * Conquest was pure profit. `recomputeFactories` counted every factory in a
 * state the moment it flipped, at full value, and `computeResourceOutput` did
 * the same for its mines; the only concession anywhere was a 0.2 multiplier on
 * occupied manpower. So nothing in the game braked a snowball: the country
 * that won the first war won every one after it, and taking France was
 * indistinguishable from building France.
 *
 * Resistance grows in a state whose owner is not its controller, and it is
 * suppressed by troops standing on it. What it costs the occupier is output:
 * a restive province runs its factories and its mines at a fraction of what
 * they are worth. That gives garrisoning a purpose beyond holding ground, and
 * makes a conquest something to be digested rather than banked.
 */

/** Resistance a freshly conquered state starts at. */
export const INITIAL_RESISTANCE = 0.5;
/** Daily growth in a state with nobody standing on it. */
const GROWTH_PER_DAY = 0.01;
/**
 * Daily suppression per division, per province it has to cover.
 *
 * Scaled by the size of the state rather than flat. Flat, one division
 * suppressed at twice the growth rate, so a single formation parked anywhere
 * in occupied France held the whole country quiet -- measured across a
 * seven-year campaign, every occupied state sat at resistance 0.00 and kept
 * 100% of its output, which is the pure-profit conquest this was meant to end.
 * Held at zero growth, a state needs roughly one division per three provinces.
 */
const SUPPRESSION_PER_DIVISION = 0.03;
/** Output an occupied state keeps when resistance is total. */
const MIN_OUTPUT = 0.25;

/** What fraction of this state's output its controller actually collects. */
export function occupiedOutput(s: StateRuntime): number {
  if (s.owner === s.controller) return 1;
  return MIN_OUTPUT + (1 - MIN_OUTPUT) * (1 - s.resistance);
}

export function tickOccupationDaily(state: GameState): void {
  for (const s of state.states) {
    if (s.owner === s.controller) {
      // Home ground never resists; retaking your own land clears it at once.
      s.resistance = 0;
      continue;
    }

    let garrison = 0;
    for (const id of s.provinces) {
      const p = state.provinces[id];
      if (!p || p.controller !== s.controller) continue;
      for (const divId of p.divisions) {
        const d = state.divisions[divId];
        if (d && !d.dead && d.owner === s.controller) garrison++;
      }
    }

    const cover = garrison / Math.max(1, s.provinces.length);
    const change = GROWTH_PER_DAY - cover * SUPPRESSION_PER_DIVISION;
    s.resistance = Math.max(0, Math.min(1, s.resistance + change));
  }
}
