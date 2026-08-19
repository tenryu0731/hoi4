import { hoursFromDate } from '../time/calendar';
import type { GameState, Outcome } from '../core/types';

/**
 * Victory and defeat.
 *
 * A scenario must always terminate: an AI-versus-AI run that never resolves
 * cannot be tested, and a player who cannot lose is not playing a game. Three
 * conditions cover it -- the player falls, the player's enemies all fall, or
 * the clock runs out and the position is scored.
 */

export const SCENARIO_END_HOURS = hoursFromDate(1948, 1, 1);

/** Everyone the player is fighting, directly or through their faction. */
function enemiesOf(state: GameState, country: number): number[] {
  const out = new Set<number>();
  for (const e of state.countries[country].atWarWith) out.add(e);
  const factionId = state.countries[country].factionId;
  if (factionId !== null) {
    for (const member of state.factions[factionId].members) {
      for (const e of state.countries[member].atWarWith) out.add(e);
    }
  }
  return [...out].filter((id) => !state.countries[id].capitulated);
}

/** Victory points a country and its faction currently hold. */
export function blocScore(state: GameState, country: number): number {
  const c = state.countries[country];
  const members = c.factionId !== null
    ? state.factions[c.factionId].members
    : [country];
  let total = 0;
  for (const id of members) {
    if (state.countries[id].capitulated) continue;
    total += state.countries[id].stats.victoryPointsHeld;
  }
  return total;
}

/** True once the player's own bloc has been a belligerent in some war. */
function playerHasFought(state: GameState, player: number): boolean {
  const c = state.countries[player];
  const bloc = c.factionId !== null
    ? state.factions[c.factionId].members
    : [player];
  return state.wars.some(
    (w) => w.attackers.some((id) => bloc.includes(id) || id === player)
      || w.defenders.some((id) => bloc.includes(id) || id === player),
  );
}

export function evaluateOutcome(state: GameState): Outcome {
  if (state.outcome.status !== 'playing') return state.outcome;

  const player = state.meta.playerCountry;
  const day = state.clock.totalDays;
  const me = state.countries[player];

  if (me.capitulated) {
    return { status: 'defeat', reason: 'capitulated', day };
  }

  // Winning means every enemy of the player's own bloc is out of the war, and
  // that at least one great power has actually fallen. Overrunning Luxembourg
  // leaves you with no enemies too, and it is plainly not victory in Europe.
  const enemies = enemiesOf(state, player);
  const majorDefeated = state.countries.some((c) => c.major && c.capitulated);
  if (playerHasFought(state, player) && enemies.length === 0 && majorDefeated) {
    return {
      status: 'victory',
      reason: 'allEnemiesCapitulated',
      day,
    };
  }

  if (state.clock.totalHours >= SCENARIO_END_HOURS) {
    // Time limit: score the board so the run always terminates.
    const mine = blocScore(state, player);
    let bestEnemy = 0;
    for (const id of enemies) bestEnemy = Math.max(bestEnemy, blocScore(state, id));
    // Deliberately not `enemies.length === 0 || ...`: a nation that never
    // declared war and was never attacked used to be handed the campaign for
    // sitting still, which made "do nothing" the strongest opening.
    if (enemies.length > 0 && mine >= bestEnemy) {
      return { status: 'victory', reason: 'aheadOnPoints', day };
    }
    return { status: 'defeat', reason: 'behindOnPoints', day };
  }

  return { status: 'playing' };
}

/** Applies the outcome to the state once, logging it. */
export function tickVictoryCheck(state: GameState): void {
  if (state.outcome.status !== 'playing') return;
  const outcome = evaluateOutcome(state);
  if (outcome.status === 'playing') return;
  state.outcome = outcome;
  state.log.push({
    day: state.clock.totalDays,
    kind: 'outcome',
    body: { k: 'outcome', status: outcome.status, reason: outcome.reason },
  });
}
