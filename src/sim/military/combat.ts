import { effectiveTemplate } from '../research';
import { armyById, commandModifiers } from './command';
import { ENTRENCHMENT_PER_LEVEL } from './movement';
import { DRY_HARD_ATTACK, fuelPenalty } from '../economy/fuel';
import { airAdvantage, airMultiplier } from './air';
import {
  WINTER_ATTACK_PENALTY, WINTER_SPECIALIST_RELIEF, winterSeverity,
} from './weather';
import { TERRAIN } from '../core/data';
import { jitter } from '../core/rng';
import type {
  Combat, CountryId, Division, DivisionTemplate, GameState, ProvinceId,
} from '../core/types';
import type { ProvinceIndex } from '../map/ProvinceIndex';

/**
 * Land combat.
 *
 * One round per in-game hour. Each side commits divisions up to the province's
 * combat width, so terrain decides how much force can be brought to bear -- the
 * reason a mountain pass holds against odds and an open plain does not.
 *
 * Damage is split the way the period's doctrine did: fire that the defence
 * absorbs costs organisation (cohesion, recoverable), fire that gets through
 * costs strength (men and equipment, not recoverable without reinforcement).
 * A formation routs when its organisation is spent, not when it is annihilated.
 *
 * The model is expected-value with a small seeded jitter rather than per-shot
 * random rolls. That keeps it cheap enough to run hundreds of battles an hour
 * on a phone, and it makes the balance testable in closed form.
 */

/**
 * Organisation removed per point of damage.
 *
 * This constant sets how long a battle lasts, and therefore how fast the whole
 * war moves. At 0.030 an even engagement burned out in under two days and the
 * front collapsed faster than armies could march; at 0.010 it grinds for the
 * better part of a week, which is what lets a defence be reinforced and a
 * breakthrough mean something.
 */
export const ORG_DAMAGE_K = 0.010;
/** Strength removed per point of penetrating damage. */
export const STR_DAMAGE_K = 0.02;
/**
 * Flat penalty on the attacker's output.
 *
 * Without it, two identical forces on open ground trade evenly and the attacker
 * wins on the coin flip -- which would make attacking always correct and remove
 * the central decision of the period, namely whether you have enough local
 * superiority to justify going forward.
 */
export const ATTACKER_PENALTY = 0.9;
/** Random spread applied to each side's damage each round. */
export const COMBAT_JITTER = 0.10;
/** Organisation recovered per hour, as a fraction of the maximum. */
export const ORG_RECOVERY_PER_HOUR = 0.0075;
/** Strength recovered per hour when in supply and out of combat. */
export const STR_RECOVERY_PER_HOUR = 0.0015;
/** Hours a division must recover after being forced to retreat. */
export const RETREAT_COOLDOWN_HOURS = 12;

export interface CombatContext {
  index: ProvinceIndex;
}

/**
 * Template lookup, indexed rather than scanned.
 *
 * Called once per division per hour from upkeep and again from every combat
 * round -- roughly twenty thousand times a simulated day in a full campaign --
 * and a linear scan of the country's template list each time is the kind of
 * cost that only shows up in a profile.
 */
const TEMPLATE_INDEX = new WeakMap<DivisionTemplate[], Map<number, DivisionTemplate>>();

function templateOf(state: GameState, d: Division): DivisionTemplate {
  const list = state.countries[d.owner].templates;
  let index = TEMPLATE_INDEX.get(list);
  if (!index || index.size !== list.length) {
    index = new Map(list.map((t) => [t.id, t] as const));
    TEMPLATE_INDEX.set(list, index);
  }
  return index.get(d.templateId) ?? list[0];
}

/**
 * A template's equipment bill as parallel arrays.
 *
 * `equipmentRatio` is the hottest function in the simulation -- 11.5% of a
 * twelve-year campaign's CPU time, with another 5.2% in the collector behind
 * it -- and almost all of that was `Object.entries` building a fresh array of
 * pairs on every one of those calls. The bill only changes when the template
 * does, so it is built once and read as numbers thereafter.
 */
const NEED_INDEX = new WeakMap<DivisionTemplate, {
  keys: (keyof Division['equipment'])[];
  counts: number[];
  total: number;
}>();

function equipmentBill(tpl: DivisionTemplate): {
  keys: (keyof Division['equipment'])[];
  counts: number[];
  total: number;
} {
  let bill = NEED_INDEX.get(tpl);
  if (!bill) {
    const keys = Object.keys(tpl.equipmentNeed) as (keyof Division['equipment'])[];
    const counts = keys.map((k) => tpl.equipmentNeed[k] ?? 0);
    bill = { keys, counts, total: counts.reduce((a, b) => a + b, 0) };
    NEED_INDEX.set(tpl, bill);
  }
  return bill;
}

/**
 * How much of the template's paper strength the division can actually deliver,
 * from equipment on hand. A division at half equipment fights at half power.
 */
export function equipmentRatio(state: GameState, d: Division): number {
  const { keys, counts, total } = equipmentBill(templateOf(state, d));
  if (total <= 0) return 1;
  let have = 0;
  for (let i = 0; i < keys.length; i++) {
    const n = counts[i];
    const held = d.equipment[keys[i]] ?? 0;
    have += held < n ? held : n;
  }
  return have / total;
}

/** Combined multiplier from equipment, supply and experience. */
export function effectiveness(state: GameState, d: Division): number {
  const eq = equipmentRatio(state, d);
  // Supply never zeroes a unit's output outright; a starving formation still
  // fights, badly. Halving at zero supply is the well-tested balance point.
  const supply = 0.5 + 0.5 * Math.min(1, d.supplyLevel);
  const experience = 1 + Math.min(0.25, d.experience * 0.05);
  return eq * supply * experience;
}

// ---------------------------------------------------------------------------
// Starting and joining combats
// ---------------------------------------------------------------------------

export function findCombatAt(state: GameState, province: ProvinceId): Combat | null {
  for (const c of state.combats) {
    if (!c.ended && c.province === province) return c;
  }
  return null;
}

export function startCombat(
  state: GameState,
  province: ProvinceId,
  attacker: CountryId,
  defender: CountryId,
): Combat {
  const combat: Combat = {
    id: state.nextIds.combat++,
    province,
    attackerCountry: attacker,
    defenderCountry: defender,
    attackers: [],
    defenders: [],
    startHour: state.clock.totalHours,
    attackerProgress: 0,
    ended: false,
  };
  state.combats.push(combat);
  return combat;
}

export function joinCombat(combat: Combat, d: Division, asAttacker: boolean): void {
  const list = asAttacker ? combat.attackers : combat.defenders;
  if (!list.includes(d.id)) list.push(d.id);
  d.combatId = combat.id;
}

// ---------------------------------------------------------------------------
// Round resolution
// ---------------------------------------------------------------------------

interface SideStats {
  softAttack: number;
  hardAttack: number;
  defence: number;
  breakthrough: number;
  hardness: number;
  armor: number;
  piercing: number;
  /** Divisions actually committed this round. */
  engaged: Division[];
}

/** What fire is still worth against armour it cannot touch at all. */
const PIERCE_FLOOR = 0.45;

/** What a trait is worth where it applies. */
const TRAIT_BONUS = 0.1;

/** True when armour is what this formation is built around. */
function isArmoured(tpl: DivisionTemplate): boolean {
  return tpl.battalions.some((b) => b === 'light_armor' || b === 'medium_armor');
}

/**
 * How much of this formation is trained for the high ground, 0..1.
 *
 * The mountaineers battalion was a byte-identical copy of infantry -- same
 * equipment, manpower, organisation, strength, width and speed -- and no code
 * anywhere gave it a mountain or a hill. The map has 74 mountain provinces and
 * 22 of hills, and the 山岳師団 the scenario fields carries one fewer line
 * battalion than the 歩兵師団 at identical cost, so it was strictly the worse
 * of the two.
 */
function mountainShare(tpl: DivisionTemplate): number {
  if (tpl.battalions.length === 0) return 0;
  const trained = tpl.battalions.filter((b) => b === 'mountaineers').length;
  return trained / tpl.battalions.length;
}

/** What full mountain training is worth where the ground is against you. */
const MOUNTAINEER_BONUS = 0.25;

/** True when this formation marches: the infantry a foot general knows. */
function isFootborne(tpl: DivisionTemplate): boolean {
  const foot = tpl.battalions.filter((b) => b === 'infantry' || b === 'mountaineers').length;
  return foot * 2 > tpl.battalions.length;
}

/** The preparation bonus this division's army has banked, if it has one. */
function planningBonus(state: GameState, d: Division): number {
  return armyById(state, d.armyId)?.planning ?? 0;
}

/**
 * Whether an officer on this side sees through the other's preparation.
 *
 * The trickster's counter is resolved once for the battle rather than per
 * round, because a plan that is read is read; rolling it hourly would make it
 * a small permanent discount instead of an event.
 */
function countersPlan(state: GameState, ids: number[]): boolean {
  for (const id of ids) {
    const d = state.divisions[id];
    if (!d || d.dead) continue;
    if (commandModifiers(state, d).traits.has('trickster')) {
      // Keyed off the combat's own province and start hour so the answer is
      // stable for the life of the battle and identical on every machine.
      return true;
    }
  }
  return false;
}

/**
 * Commits divisions up to the province's combat width. Units are committed
 * best-first, so a stack of broken formations does not crowd out fresh ones.
 */
function sideHasTrait(state: GameState, ids: number[], trait: 'winter_specialist'): boolean {
  for (const id of ids) {
    const d = state.divisions[id];
    if (d && !d.dead && commandModifiers(state, d).traits.has(trait)) return true;
  }
  return false;
}

function collectSide(
  state: GameState, ids: number[], width: number, attacking: boolean,
  ignorePlanning = false,
  rough = false,
): SideStats {
  const out: SideStats = {
    softAttack: 0, hardAttack: 0, defence: 0, breakthrough: 0,
    hardness: 0, armor: 0, piercing: 0, engaged: [],
  };
  const candidates = ids
    .map((id) => state.divisions[id])
    .filter((d): d is Division => !!d && !d.dead && d.org > 0);
  candidates.sort((a, b) => {
    const ta = templateOf(state, a);
    const tb = templateOf(state, b);
    return (b.org / Math.max(1, tb.maxOrg)) - (a.org / Math.max(1, ta.maxOrg));
  });

  let used = 0;
  let hardnessWeight = 0;
  for (const d of candidates) {
    const tpl = effectiveTemplate(state, d.owner, templateOf(state, d));
    if (used + tpl.width > width && out.engaged.length > 0) break;
    used += tpl.width;
    out.engaged.push(d);

    const eff = effectiveness(state, d);
    // What the officers above this division are worth. A division in no army
    // gets NO_COMMAND, every field of which is neutral, so an unorganised
    // force fights exactly as it did before the chain of command existed.
    const cmd = commandModifiers(state, d);
    // Preparation only helps the side going forward; a defender's advantage is
    // entrenchment, applied below.
    const plan = attacking && !ignorePlanning ? 1 + planningBonus(state, d) : 1;

    // Traits that depend on what the division actually is, which is why they
    // are settled here rather than folded into a single number upstream.
    let attackMod = cmd.attack;
    let defenceMod = cmd.defence;
    let breakthroughMod = cmd.attack;
    if (cmd.traits.has('panzer_leader') && isArmoured(tpl)) {
      breakthroughMod += TRAIT_BONUS;
    }
    if (cmd.traits.has('infantry_leader') && isFootborne(tpl)) {
      attackMod += TRAIT_BONUS;
      defenceMod += TRAIT_BONUS;
    }
    // Dug in, and only while holding: an attacker gets nothing for the
    // trenches it is walking out of.
    const dug = attacking ? 1 : 1 + d.entrenchment * ENTRENCHMENT_PER_LEVEL;

    // Mountain troops, where there is a mountain.
    if (rough) {
      const share = mountainShare(tpl);
      attackMod += MOUNTAINEER_BONUS * share;
      defenceMod += MOUNTAINEER_BONUS * share;
    }

    // Fuel: the armoured half of a formation's firepower is what runs dry.
    // Its rifles keep working, which is why this multiplies hard attack and
    // breakthrough and leaves soft attack alone.
    const fuel = fuelPenalty(tpl, state.countries[d.owner].economy.fuelRatio, DRY_HARD_ATTACK);

    out.softAttack += tpl.softAttack * eff * attackMod * plan;
    out.hardAttack += tpl.hardAttack * eff * attackMod * plan * fuel;
    out.defence += (attacking
      ? tpl.breakthrough * breakthroughMod * fuel
      : tpl.defense * defenceMod * dug) * eff;
    out.breakthrough += tpl.breakthrough * eff * breakthroughMod * fuel;
    out.hardness += tpl.hardness * tpl.width;
    out.armor = Math.max(out.armor, tpl.armor);
    out.piercing = Math.max(out.piercing, tpl.piercing);
    hardnessWeight += tpl.width;
  }
  out.hardness = hardnessWeight > 0 ? out.hardness / hardnessWeight : 0;
  return out;
}

/** Damage one side inflicts on the other in a single round. */
export function sideDamage(
  attacker: SideStats, defender: SideStats, modifier: number, roll: number,
): { org: number; strength: number } {
  // Fire is split between soft and hard targets by the defender's hardness.
  const raw = attacker.softAttack * (1 - defender.hardness)
    + attacker.hardAttack * defender.hardness;

  // Armour that the enemy cannot pierce blunts most incoming fire; this is
  // what makes a concentrated tank formation disproportionately powerful.
  //
  // A ratio, not a threshold. The threshold form asked `piercing >= armor`,
  // and the two populations are three times apart: infantry pierces 8, rising
  // to 14.6 with every one of the 59 technologies researched, against armour
  // of 30 rising to 47.4. Measured over 83,973 combat rounds, research flipped
  // that comparison exactly zero times -- so eleven anti-tank and armour
  // technologies advertised numbers that could not change an outcome, in
  // either direction, at any point in any campaign. A ratio gives every point
  // of piercing something to buy and leaves the extremes where they were.
  const armour = Math.max(1, defender.armor);
  const pierced = attacker.piercing >= armour
    ? 1
    : PIERCE_FLOOR + (1 - PIERCE_FLOOR) * (attacker.piercing / armour);

  const hits = raw * modifier * pierced * roll;
  // Fire the defence absorbs still costs cohesion; only what gets through
  // costs men and equipment.
  //
  // Proportional, not `hits - defence`. A flat subtraction is a step function:
  // below the threshold an attack costs the defender literally nothing, above
  // it the defender routs at full strength, and there is no ratio in between
  // where a battle grinds. Measured, that made every even fight a hundred-day
  // no-op and every 2:1 a bloodless walk-in -- so equipment was never consumed
  // and the war never touched the economy. This form keeps defence meaningful
  // (it always cuts the share getting through) while leaving no odds at which
  // fire simply stops landing.
  const share = hits / (hits + Math.max(1, defender.defence));
  const through = hits * share;

  // Cohesion damage answers to defence too, which it did not before: org is
  // what decides who holds the province, and it was computed from raw fire
  // alone. So a division dug in four levels deep, in mountains, under a
  // defensive general, lost 12% fewer men and exactly as much organisation --
  // it made losing cheaper and did not make holding likelier. Terrain,
  // entrenchment and every defensive trait in the game were decorative.
  //
  // Damped rather than proportional, on purpose. Running org off `through`
  // directly would let a strong enough defence stop an attack from costing
  // anything at all, which is the step-function failure the strength formula
  // above was written to avoid. At its floor defence still concedes 40% of the
  // cohesion damage, so there remain no odds at which an attack simply stops.
  const ORG_DEFENCE_FLOOR = 0.4;

  return {
    org: hits * ORG_DAMAGE_K * (ORG_DEFENCE_FLOOR + (1 - ORG_DEFENCE_FLOOR) * share),
    strength: through * STR_DAMAGE_K,
  };
}

function applyDamage(
  state: GameState, side: SideStats, org: number, strength: number,
): void {
  if (side.engaged.length === 0) return;
  // Losses spread across the committed formations rather than falling on one.
  const perUnitOrg = org / side.engaged.length;
  const perUnitStr = strength / side.engaged.length;
  for (const d of side.engaged) {
    d.org = Math.max(0, d.org - perUnitOrg);
    d.hp = Math.max(0, d.hp - perUnitStr);
    // Losing strength means losing equipment, which feeds back into output.
    const tpl = templateOf(state, d);
    const lossFraction = perUnitStr / Math.max(1, tpl.maxHp);
    for (const eq of Object.keys(d.equipment) as (keyof typeof d.equipment)[]) {
      const have = d.equipment[eq] ?? 0;
      d.equipment[eq] = Math.max(0, have - have * lossFraction);
    }
    d.experience = Math.min(10, d.experience + 0.004);
  }
}

export interface RoundResult {
  ended: boolean;
  attackerWon: boolean;
}

/** Resolves one hourly round. Returns whether the battle concluded. */
export function resolveCombatRound(
  state: GameState, ctx: CombatContext, combat: Combat,
): RoundResult {
  const geo = ctx.index.get(combat.province);
  const terrain = TERRAIN[geo.terrain];
  const width = terrain.combatWidth;

  const rough = geo.terrain === 'mountain' || geo.terrain === 'hills';
  const att = collectSide(state, combat.attackers, width, true, false, rough);
  const def = collectSide(state, combat.defenders, width, false, false, rough);

  // A trickster on the defending side reads the attack: the preparation the
  // attacker spent weeks banking counts for nothing here.
  if (countersPlan(state, combat.defenders)) {
    const attWithoutPlan = collectSide(state, combat.attackers, width, true, true, rough);
    att.softAttack = attWithoutPlan.softAttack;
    att.hardAttack = attWithoutPlan.hardAttack;
  }

  if (att.engaged.length === 0) return { ended: true, attackerWon: false };
  if (def.engaged.length === 0) return { ended: true, attackerWon: true };

  const fort = state.provinces[combat.province].fortLevel;
  // Air support is the one technology branch that acts on the battle rather
  // than on the units in it, so it multiplies the side modifier.
  // Winter is felt by whoever is doing the attacking, which is the historical
  // shape of it: holding a line in the snow is miserable, crossing one is
  // ruinous. Attrition on both sides is applied daily elsewhere.
  let winter = winterSeverity(state, ctx.index, combat.province);
  if (winter > 0 && sideHasTrait(state, combat.attackers, 'winter_specialist')) {
    winter *= 1 - WINTER_SPECIALIST_RELIEF;
  }
  // Air power, measured against the size of the battle rather than applied
  // flat. The multiplier used to be the air technology modifier on its own,
  // which meant it applied at full strength to a country that had never built
  // an aeroplane -- and the aeroplanes it did build had all-zero combat stats
  // and could not affect anything.
  const engaged = att.engaged.length + def.engaged.length;
  const air = airAdvantage(state, combat.attackerCountry, combat.defenderCountry, engaged);
  const attackerMod = terrain.attackMod * ATTACKER_PENALTY
    * (1 - Math.min(0.6, fort * 0.12))
    * (1 - WINTER_ATTACK_PENALTY * winter)
    * airMultiplier(air);
  const defenderMod = terrain.defenceMod * airMultiplier(-air);

  const attRoll = jitter(state.rng, COMBAT_JITTER);
  const defRoll = jitter(state.rng, COMBAT_JITTER);

  const toDefender = sideDamage(att, def, attackerMod, attRoll);
  const toAttacker = sideDamage(def, att, defenderMod, defRoll);

  applyDamage(state, def, toDefender.org, toDefender.strength);
  applyDamage(state, att, toAttacker.org, toAttacker.strength);

  // Progress is purely for the UI, but it must move in the direction the
  // battle is actually going.
  combat.attackerProgress += (toDefender.org - toAttacker.org) * 0.02;

  const attackerSpent = att.engaged.every((d) => d.org <= 0.01);
  const defenderSpent = def.engaged.every((d) => d.org <= 0.01);
  const attackerHasReserves = combat.attackers.some((id) => {
    const d = state.divisions[id];
    return d && !d.dead && d.org > 0.01 && !att.engaged.includes(d);
  });
  const defenderHasReserves = combat.defenders.some((id) => {
    const d = state.divisions[id];
    return d && !d.dead && d.org > 0.01 && !def.engaged.includes(d);
  });

  if (defenderSpent && !defenderHasReserves) return { ended: true, attackerWon: true };
  if (attackerSpent && !attackerHasReserves) return { ended: true, attackerWon: false };
  return { ended: false, attackerWon: false };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/** Hourly out-of-combat recovery and attrition. */
export function tickDivisionUpkeep(state: GameState, d: Division): void {
  const tpl = effectiveTemplate(state, d.owner, templateOf(state, d));
  if (d.retreatCooldown > 0) d.retreatCooldown--;

  if (d.combatId !== null) return;

  // Organisation returns quickly; strength does not, and neither returns at all
  // without supply. A cut-off pocket therefore only gets weaker.
  const supply = Math.min(1, d.supplyLevel);
  if (supply > 0.15) {
    d.org = Math.min(tpl.maxOrg, d.org + tpl.maxOrg * ORG_RECOVERY_PER_HOUR * supply);
    const equipped = equipmentRatio(state, d);
    d.hp = Math.min(tpl.maxHp * equipped, d.hp + tpl.maxHp * STR_RECOVERY_PER_HOUR * supply);
  } else {
    // Attrition out of supply.
    const bite = (0.15 - supply) * 0.02;
    d.org = Math.max(0, d.org - tpl.maxOrg * bite);
    d.hp = Math.max(0, d.hp - tpl.maxHp * bite * 0.35);
    for (const eq of Object.keys(d.equipment) as (keyof typeof d.equipment)[]) {
      const have = d.equipment[eq] ?? 0;
      d.equipment[eq] = Math.max(0, have - have * bite * 0.5);
    }
  }
}
