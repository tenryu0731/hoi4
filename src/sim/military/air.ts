import { techModifiers } from '../research';
import type { CountryId, GameState } from '../core/types';

/**
 * Air power, resolved at the country level.
 *
 * There was no air layer at all, and three separate things were dead because
 * of it. `fighter` and `cas` carried all-zero combat stats, so the aircraft
 * countries built could not affect anything. Aluminium was consumed by nothing
 * else -- measured over a campaign, 211,856 produced against 10,547 consumed,
 * 95% of Europe's supply feeding an item with no use. And every air technology
 * fed `airSupport`, a battle multiplier that applied in full whether or not a
 * single aeroplane existed.
 *
 * The AI meanwhile funded fighter lines it could not use: `AIR_SHARE` was 0,
 * but the factory allocator gave the last entry in the mix the rounding
 * remainder, so 2-4% of Europe's military industry went into fighters --
 * 92,000 production units in one campaign, about thirty infantry divisions.
 *
 * This stays country-level rather than modelling wings and air regions: a
 * phone screen has no room for an air map, and the thing that matters on the
 * ground is whether the sky above the battle is yours.
 */

/** Aircraft per division at which a country holds half the sky over a battle. */
const PLANES_PER_DIVISION = 30;

/** What total air superiority is worth to the side that holds it. */
export const AIR_SUPERIORITY_BONUS = 0.25;

/** Daily share of an air fleet lost to accidents and combat while contested. */
const ATTRITION_PER_DAY = 0.004;

/**
 * A country's air strength: aircraft in hand, weighted by what technology has
 * done to them.
 */
export function airStrength(state: GameState, owner: CountryId): number {
  const c = state.countries[owner];
  if (c.capitulated) return 0;
  const planes = (c.economy.stockpile.fighter ?? 0) + (c.economy.stockpile.cas ?? 0) * 0.6;
  return planes * techModifiers(state, owner).airSupport;
}

/**
 * How far one side's air power exceeds the other's over a battle, -1..1.
 *
 * Measured against the size of the ground force, so a hundred fighters mean
 * something to Belgium and nothing to the Soviet Union.
 */
export function airAdvantage(
  state: GameState, attacker: CountryId, defender: CountryId, divisions: number,
): number {
  // A soft curve, not a cap. Capping each side at full coverage made the
  // advantage saturate instantly and cancel: Britain's 827 points of air
  // strength and Germany's 80 both clipped to 1 over a ten-division battle,
  // for a measured advantage of exactly 0.000.
  const need = Math.max(1, divisions) * PLANES_PER_DIVISION;
  const share = (strength: number) => strength / (strength + need);
  return share(airStrength(state, attacker)) - share(airStrength(state, defender));
}

/** The multiplier air power applies to a side's fire. */
export function airMultiplier(advantage: number): number {
  return 1 + AIR_SUPERIORITY_BONUS * advantage;
}

/**
 * Aircraft wear out. Without this a country would accumulate every plane it
 * ever built and air superiority would be decided in 1936.
 */
export function tickAirDaily(state: GameState): void {
  for (const c of state.countries) {
    if (c.capitulated) continue;
    const contested = c.atWarWith.length > 0;
    if (!contested) continue;
    for (const eq of ['fighter', 'cas'] as const) {
      const have = c.economy.stockpile[eq] ?? 0;
      if (have <= 0) continue;
      c.economy.stockpile[eq] = Math.max(0, have - have * ATTRITION_PER_DAY);
    }
  }
}
