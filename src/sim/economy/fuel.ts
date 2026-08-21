import { techModifiers } from '../research';
import type { Country, DivisionTemplate, EquipmentType, GameState } from '../core/types';

/**
 * Fuel.
 *
 * Oil was produced by states and consumed by nothing: not one entry in
 * EQUIPMENT declared it, so `computeResourceOutput` dutifully booked the
 * Soviet Union's 60, Romania's 42 and Britain's 26 every day against a demand
 * that was structurally zero. Ploiesti and Baku were victory points and
 * nothing else, and the synthetic-oil technology granted a generic output
 * bonus on a resource with no use.
 *
 * Fuel makes armour a strategic commitment rather than a free upgrade: a tank
 * division is stronger per width than infantry and always was, and now it also
 * has to be paid for in something Germany has to go and take.
 */

/** Fuel made from one unit of a day's spare oil. */
const FUEL_PER_OIL = 6;
/** What a country can hold without industry to store it in. */
const BASE_CAPACITY = 400;
/** Storage each factory of any kind adds. */
const CAPACITY_PER_FACTORY = 24;

/** Which equipment burns fuel, and how much of it per unit per day. */
const FUEL_USE: Partial<Record<EquipmentType, number>> = {
  motorized: 0.05,
  light_armor: 0.12,
  medium_armor: 0.2,
  fighter: 0.08,
  cas: 0.1,
};

/** A template's daily fuel draw, derived alongside its other stats. */
export function templateFuelUse(equipmentNeed: Partial<Record<EquipmentType, number>>): number {
  let use = 0;
  for (const [eq, count] of Object.entries(equipmentNeed) as [EquipmentType, number][]) {
    use += (FUEL_USE[eq] ?? 0) * count;
  }
  return Math.round(use * 100) / 100;
}

/** Daily draw of a division that is motorised throughout. */
const FULLY_MOTORISED = 16;

/**
 * How much of this formation stops working when the tanks are dry, 0..1.
 *
 * Not a yes-or-no question. Support companies run on trucks, so every template
 * in the game has a non-zero fuel draw -- an infantry division 0.5 a day
 * against a motorised division's 16 and an armoured division's 38.5. Gating
 * the penalty on `fuelUse > 0` therefore crippled the infantry of every
 * country that ran dry, which measured as 100% of every army in Europe being
 * treated as armour. Weighted against a fully motorised division, infantry
 * feels 3% of the shortage and a panzer division feels all of it.
 */
export function fuelShare(tpl: DivisionTemplate): number {
  return Math.min(1, tpl.fuelUse / FULLY_MOTORISED);
}

/** The multiplier a shortage applies to something, given how motorised it is. */
export function fuelPenalty(tpl: DivisionTemplate, ratio: number, floor: number): number {
  return 1 - fuelShare(tpl) * (1 - floor) * (1 - ratio);
}

export function fuelCapacity(c: Country): number {
  const plants = c.economy.civilianFactories + c.economy.militaryFactories + c.economy.dockyards;
  return BASE_CAPACITY + plants * CAPACITY_PER_FACTORY;
}

/**
 * What a dry tank is worth.
 *
 * Not zero: a division out of fuel is not a division that has ceased to exist,
 * it is one that has to be pushed. Halving speed and cutting the armoured
 * half of its firepower is what turns a panzer corps back into slow infantry,
 * which is the shape of the historical problem.
 */
export const DRY_SPEED = 0.5;
export const DRY_HARD_ATTACK = 0.45;

/**
 * How much of its fuel demand this country is actually meeting, 0..1.
 *
 * Read by movement and by combat; stored on the country so both see the same
 * number within a tick and neither has to walk the division list again.
 */
export function fuelRatio(c: Country): number {
  return c.economy.fuelRatio;
}

export function tickFuelDaily(state: GameState): void {
  for (const c of state.countries) {
    if (c.capitulated) continue;
    const eco = c.economy;

    // Oil not spent on equipment production becomes fuel. Refining technology
    // is what decides how much of it survives the trip.
    const oil = eco.resources.oil;
    const spare = Math.max(0, oil.produced - oil.consumed);
    const refining = techModifiers(state, c.id).resourceOutput;
    const room = Math.max(0, fuelCapacity(c) - eco.fuel);
    const made = Math.min(room, spare * FUEL_PER_OIL * refining);
    eco.fuel += made;
    // Booked against the resource, so the economy panel and the resource map
    // mode show oil being used rather than produced into a void.
    if (made > 0) oil.consumed += made / (FUEL_PER_OIL * refining);

    let demand = 0;
    for (const d of state.divisions) {
      if (d.dead || d.owner !== c.id) continue;
      const tpl = c.templates.find((t) => t.id === d.templateId);
      demand += tpl?.fuelUse ?? 0;
    }

    if (demand <= 0) {
      eco.fuelRatio = 1;
      continue;
    }
    const drawn = Math.min(eco.fuel, demand);
    eco.fuel -= drawn;
    eco.fuelRatio = drawn / demand;
  }
}
