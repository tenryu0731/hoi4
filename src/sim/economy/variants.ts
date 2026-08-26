import { EQUIPMENT } from '../core/data';
import { EQUIPMENT_TYPES } from '../core/types';
import type {
  Country, CountryId, DivisionTemplate, EquipmentType, EquipmentVariant, GameState,
  VariantModule,
} from '../core/types';

/**
 * Equipment marks: the player's own hand on what the factories turn out.
 *
 * The reference screenshot's Create Variant window has four steppers -- armour,
 * main gun, reliability, engine -- a silhouette, and a readout of what each
 * change does to the equipment's numbers and to what it costs to build. That
 * is the whole feature, and it is the second axis of equipment quality next to
 * research: research decides what your industry *can* build, a variant decides
 * what you have told it to build.
 *
 * The model here is one mark per equipment type per country, rather than
 * HOI4's named variants sitting side by side in the production list. The
 * reason is the stockpile: this simulation counts rifles, not rifles-of-a-
 * particular-mark, so two marks in the depot at once would have nothing to
 * distinguish them once a division drew from it. One mark per type says "your
 * factories have retooled", which plays the same way and is true of the state
 * the simulation actually keeps.
 */

/** How far one module may be pushed. */
export const MAX_VARIANT_LEVEL = 5;

/**
 * Army experience one level of one module costs.
 *
 * Measured against how fast experience actually accrues (see
 * `tickArmyExperienceDaily`): a country in continuous heavy fighting earns
 * roughly 12 a day, so a single level is a bit under two days of war and
 * maxing one module is a fortnight of it. A country at peace earns nothing
 * and cannot upgrade at all, which is the point -- these are lessons, and
 * they are learned by being shot at.
 */
export const VARIANT_LEVEL_XP = 20;

/** What one level of each module does. All multiplicative, all per level. */
const PER_LEVEL = {
  /** Thicker plate. */
  armor: 0.18,
  /** A bigger gun: both kinds of attack, and the ability to punch through. */
  gunSoft: 0.10,
  gunHard: 0.14,
  gunPiercing: 0.12,
  /** A machine that breaks down less needs less to keep it running. */
  reliabilitySupply: -0.07,
  /** More power. */
  engineSpeed: 0.08,
  /** Every module costs the same to build in. */
  cost: 0.12,
} as const;

/**
 * Which modules an equipment type actually has.
 *
 * A rifle has no engine and a truck has no main gun. Offering every stepper
 * on every type would be four controls of which two do nothing, and a control
 * that does nothing is worse than no control -- it says the design space is
 * bigger than it is.
 */
export const VARIANT_MODULES: Record<EquipmentType, readonly VariantModule[]> = {
  infantry_equipment: ['gun', 'reliability'],
  support_equipment: ['reliability'],
  artillery: ['gun', 'reliability'],
  motorized: ['reliability', 'engine'],
  light_armor: ['armor', 'gun', 'reliability', 'engine'],
  medium_armor: ['armor', 'gun', 'reliability', 'engine'],
  fighter: ['gun', 'reliability', 'engine'],
  cas: ['gun', 'reliability', 'engine'],
  convoy: ['reliability', 'engine'],
};

const ZERO: EquipmentVariant = { armor: 0, gun: 0, reliability: 0, engine: 0 };

/** Lazily created, the way the research and focus runtimes create theirs. */
export function variantsOf(c: Country): Partial<Record<EquipmentType, EquipmentVariant>> {
  if (!c.variants) c.variants = {};
  return c.variants;
}

export function variantOf(c: Country, eq: EquipmentType): EquipmentVariant {
  return c.variants?.[eq] ?? ZERO;
}

/** True when this module exists on this equipment and has room to grow. */
export function canUpgrade(
  c: Country, eq: EquipmentType, module: VariantModule, step: 1 | -1,
): boolean {
  if (!VARIANT_MODULES[eq].includes(module)) return false;
  const next = variantOf(c, eq)[module] + step;
  if (next < 0 || next > MAX_VARIANT_LEVEL) return false;
  // Stepping back is free and refunds nothing: a design decision is not a
  // purchase, and undoing one does not un-learn the lesson that paid for it.
  if (step === -1) return true;
  return (c.armyExperience ?? 0) >= VARIANT_LEVEL_XP;
}

export function upgradeVariant(
  state: GameState, owner: CountryId, eq: EquipmentType, module: VariantModule, step: 1 | -1,
): boolean {
  const c = state.countries[owner];
  if (!c || c.capitulated) return false;
  if (!canUpgrade(c, eq, module, step)) return false;
  const table = variantsOf(c);
  const current = table[eq] ?? { ...ZERO };
  table[eq] = { ...current, [module]: current[module] + step };
  if (step === 1) c.armyExperience = (c.armyExperience ?? 0) - VARIANT_LEVEL_XP;
  return true;
}

/** How many levels this country has put into an equipment type, in total. */
export function variantMark(c: Country, eq: EquipmentType): number {
  const v = variantOf(c, eq);
  return v.armor + v.gun + v.reliability + v.engine;
}

/** Multiplier on what one unit of this equipment costs to build. */
export function variantCostMultiplier(c: Country, eq: EquipmentType): number {
  return 1 + variantMark(c, eq) * PER_LEVEL.cost;
}

/**
 * What a country's marks add to a template, as deltas.
 *
 * Deltas rather than multipliers, and computed from the template's own
 * equipment bill, because a division mixes types: a tank division carries
 * medium armour and lorries, and a gun upgrade on the tanks must not scale
 * the rifles its motorised infantry are holding. `deriveTemplate` builds the
 * equipment-derived part of every stat as a sum over exactly this bill, so
 * the same sum with `(multiplier - 1)` in it is the exact difference the
 * marks make -- and it leaves the flat support-company bonuses alone, which
 * is right, because no variant touches them.
 */
export interface VariantDelta {
  softAttack: number;
  hardAttack: number;
  piercing: number;
  armor: number;
  supplyUse: number;
  /** Multiplier, not a delta: speed is a minimum over battalions, not a sum. */
  speed: number;
  /** Multiplier on the build cost, weighted by what the bill is made of. */
  cost: number;
}

const NO_DELTA: VariantDelta = {
  softAttack: 0, hardAttack: 0, piercing: 0, armor: 0, supplyUse: 0, speed: 1, cost: 1,
};

export function variantDelta(c: Country, tpl: DivisionTemplate): VariantDelta {
  if (!c.variants) return NO_DELTA;
  let softAttack = 0;
  let hardAttack = 0;
  let piercing = 0;
  let supplyUse = 0;
  let bestArmor = 0;
  let baseArmor = 0;
  let speed = 1;
  let cost = 0;
  let bill = 0;

  for (const eq of EQUIPMENT_TYPES) {
    const count = tpl.equipmentNeed[eq] ?? 0;
    if (count === 0) continue;
    const v = c.variants[eq];
    const def = EQUIPMENT[eq];
    bill += count;
    if (!v) {
      // Still counts toward the armour maximum and the cost weighting: an
      // un-upgraded type can be the one setting the template's armour.
      bestArmor = Math.max(bestArmor, def.armor);
      baseArmor = Math.max(baseArmor, def.armor);
      cost += count;
      continue;
    }
    // The same 0.01 scaling deriveTemplate uses when it sums these.
    softAttack += def.softAttack * count * 0.01 * (PER_LEVEL.gunSoft * v.gun);
    hardAttack += def.hardAttack * count * 0.01 * (PER_LEVEL.gunHard * v.gun);
    piercing += 0;
    supplyUse += def.supplyUse * count * 0.01 * (PER_LEVEL.reliabilitySupply * v.reliability);
    baseArmor = Math.max(baseArmor, def.armor);
    bestArmor = Math.max(bestArmor, def.armor * (1 + PER_LEVEL.armor * v.armor));
    // Piercing and armour are maxima over the bill rather than sums, so they
    // are handled outside the accumulation.
    speed = Math.max(speed, 1 + PER_LEVEL.engineSpeed * v.engine);
    cost += count * (1 + PER_LEVEL.cost * variantMark(c, eq));
  }

  // Piercing, like armour, is the best thing in the division rather than the
  // sum of everything in it.
  let bestPiercing = 0;
  let basePiercing = 0;
  for (const eq of EQUIPMENT_TYPES) {
    const count = tpl.equipmentNeed[eq] ?? 0;
    if (count === 0) continue;
    const def = EQUIPMENT[eq];
    const v = c.variants[eq];
    basePiercing = Math.max(basePiercing, def.piercing);
    bestPiercing = Math.max(
      bestPiercing, def.piercing * (1 + PER_LEVEL.gunPiercing * (v?.gun ?? 0)),
    );
  }
  piercing = bestPiercing - basePiercing;

  return {
    softAttack,
    hardAttack,
    piercing,
    armor: bestArmor - baseArmor,
    supplyUse,
    speed,
    cost: bill > 0 ? cost / bill : 1,
  };
}

/**
 * One unit of this equipment, as the country currently builds it.
 *
 * The equipment's own numbers, not a division's -- which is what the reference
 * window shows, and the right scope: a mark is a decision about a machine, and
 * the machine is the same machine whatever formation ends up holding it.
 * Exported so the panel never re-derives the per-level constants and drifts
 * from what the simulation applies.
 */
export interface VariantStats {
  softAttack: number;
  hardAttack: number;
  armor: number;
  piercing: number;
  maxSpeedKmh: number;
  supplyUse: number;
  cost: number;
}

export function variantStats(c: Country, eq: EquipmentType): VariantStats {
  const def = EQUIPMENT[eq];
  const v = variantOf(c, eq);
  return {
    softAttack: def.softAttack * (1 + PER_LEVEL.gunSoft * v.gun),
    hardAttack: def.hardAttack * (1 + PER_LEVEL.gunHard * v.gun),
    armor: def.armor * (1 + PER_LEVEL.armor * v.armor),
    piercing: def.piercing * (1 + PER_LEVEL.gunPiercing * v.gun),
    maxSpeedKmh: def.maxSpeedKmh * (1 + PER_LEVEL.engineSpeed * v.engine),
    supplyUse: def.supplyUse * (1 + PER_LEVEL.reliabilitySupply * v.reliability),
    cost: def.cost * variantCostMultiplier(c, eq),
  };
}

/** The same equipment at its base mark, for the panel to show the change from. */
export function baseStats(eq: EquipmentType): VariantStats {
  const def = EQUIPMENT[eq];
  return {
    softAttack: def.softAttack,
    hardAttack: def.hardAttack,
    armor: def.armor,
    piercing: def.piercing,
    maxSpeedKmh: def.maxSpeedKmh,
    supplyUse: def.supplyUse,
    cost: def.cost,
  };
}

/**
 * Army experience, earned by being in a war rather than by having an army.
 *
 * HOI4 gates its template edits and its variants behind this for a reason: a
 * design change is a lesson, and lessons are learned from what went wrong last
 * week. A country at peace in 1936 has nothing to learn and cannot upgrade,
 * which is exactly the pressure that makes the opening years about industry
 * and the middle years about equipment.
 *
 * Counted from divisions actually in combat, capped per country per day so a
 * hundred-division front does not hand out a hundred divisions' worth: past a
 * point it is the same war being fought in more places.
 */
export const XP_PER_FIGHTING_DIVISION = 0.6;
export const XP_PER_DAY_CAP = 12;
/** Nobody carries an unlimited backlog of lessons. */
export const MAX_ARMY_EXPERIENCE = 900;

export function tickArmyExperienceDaily(state: GameState): void {
  const fighting = new Map<CountryId, number>();
  for (const d of state.divisions) {
    if (d.dead || d.combatId === null) continue;
    fighting.set(d.owner, (fighting.get(d.owner) ?? 0) + 1);
  }
  for (const [owner, n] of fighting) {
    const c = state.countries[owner];
    if (!c || c.capitulated) continue;
    const gain = Math.min(XP_PER_DAY_CAP, n * XP_PER_FIGHTING_DIVISION);
    c.armyExperience = Math.min(MAX_ARMY_EXPERIENCE, (c.armyExperience ?? 0) + gain);
  }
}
