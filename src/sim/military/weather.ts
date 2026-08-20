import type { ProvinceIndex } from '../map/ProvinceIndex';
import type { GameState, ProvinceId } from '../core/types';

/**
 * Winter.
 *
 * The single most famous thing about this theatre is that armies which walked
 * east in summer stopped moving in December, and the game had no way to
 * express it: every province was the same temperature in every month, so the
 * Arctic was a slightly slower kind of Belgium and there was no reason to care
 * what the date was when you started.
 *
 * Severity is latitude times season. Latitude comes straight from the map --
 * this projection puts north at negative Y, so Rovaniemi sits at -1974 and
 * Rome at +836 -- and the season from the month. Nothing here is a weather
 * simulation; it is the one seasonal fact that changes how the war is fought.
 */

/** Y at which winter bites hardest; everything past it is equally Arctic. */
const ARCTIC_Y = -1800;
/** Y at which winter stops being a factor at all. */
const TEMPERATE_Y = 100;

/** How much of winter each month carries, indexed from January. */
const SEASON = [1, 1, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.5, 1];

/** Attrition per day at full severity, as a fraction of strength. */
export const WINTER_ATTRITION_PER_DAY = 0.012;
/** Attack penalty at full severity. */
export const WINTER_ATTACK_PENALTY = 0.3;
/** What the winter specialist takes off the severity his divisions feel. */
export const WINTER_SPECIALIST_RELIEF = 0.3;

/** 0 in a Mediterranean summer, 1 in Lapland in January. */
export function winterSeverity(
  state: GameState, index: ProvinceIndex, province: ProvinceId,
): number {
  const season = SEASON[state.clock.month - 1] ?? 0;
  if (season === 0) return 0;
  const y = index.get(province).centerY;
  if (y >= TEMPERATE_Y) return 0;
  const cold = Math.min(1, (TEMPERATE_Y - y) / (TEMPERATE_Y - ARCTIC_Y));
  return cold * season;
}
