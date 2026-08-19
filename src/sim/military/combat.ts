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

/** Organisation removed per point of absorbed damage. */
export const ORG_DAMAGE_K = 0.030;
/** Strength removed per point of penetrating damage. */
export const STR_DAMAGE_K = 0.045;
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
export const ORG_RECOVERY_PER_HOUR = 0.010;
/** Strength recovered per hour when in supply and out of combat. */
export const STR_RECOVERY_PER_HOUR = 0.0015;
/** Hours a division must recover after being forced to retreat. */
export const RETREAT_COOLDOWN_HOURS = 12;

export interface CombatContext {
  index: ProvinceIndex;
}

function templateOf(state: GameState, d: Division): DivisionTemplate {
  const c = state.countries[d.owner];
  return c.templates.find((t) => t.id === d.templateId) ?? c.templates[0];
}

/**
 * How much of the template's paper strength the division can actually deliver,
 * from equipment on hand. A division at half equipment fights at half power.
 */
export function equipmentRatio(state: GameState, d: Division): number {
  const tpl = templateOf(state, d);
  const need = tpl.equipmentNeed;
  let total = 0;
  let have = 0;
  for (const [eq, n] of Object.entries(need) as [keyof typeof need, number][]) {
    total += n;
    have += Math.min(n, d.equipment[eq] ?? 0);
  }
  return total > 0 ? have / total : 1;
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

/**
 * Commits divisions up to the province's combat width. Units are committed
 * best-first, so a stack of broken formations does not crowd out fresh ones.
 */
function collectSide(
  state: GameState, ids: number[], width: number, attacking: boolean,
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
    const tpl = templateOf(state, d);
    if (used + tpl.width > width && out.engaged.length > 0) break;
    used += tpl.width;
    out.engaged.push(d);

    const eff = effectiveness(state, d);
    out.softAttack += tpl.softAttack * eff;
    out.hardAttack += tpl.hardAttack * eff;
    out.defence += (attacking ? tpl.breakthrough : tpl.defense) * eff;
    out.breakthrough += tpl.breakthrough * eff;
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
  const pierced = attacker.piercing >= defender.armor ? 1 : 0.45;

  const hits = raw * modifier * pierced * roll;
  // Fire the defence absorbs still costs cohesion; only what gets through
  // costs men and equipment. Organisation therefore falls at the same rate for
  // both sides in an even fight, and the side that is bleeding strength loses
  // the grind -- because lost strength means lost equipment, which feeds back
  // into how hard it can hit next round.
  const through = Math.max(0, hits - defender.defence);

  return {
    org: hits * ORG_DAMAGE_K,
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

  const att = collectSide(state, combat.attackers, width, true);
  const def = collectSide(state, combat.defenders, width, false);

  if (att.engaged.length === 0) return { ended: true, attackerWon: false };
  if (def.engaged.length === 0) return { ended: true, attackerWon: true };

  const fort = state.provinces[combat.province].fortLevel;
  const attackerMod = terrain.attackMod * ATTACKER_PENALTY * (1 - Math.min(0.6, fort * 0.12));
  const defenderMod = terrain.defenceMod;

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
  const tpl = templateOf(state, d);
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
