import type {
  Army, ArmyId, Commander, CommanderId, CountryId, Division, DivisionId, GameState,
  ProvinceId,
} from '../core/types';

/**
 * The chain of command: officers, armies, and what they are worth.
 *
 * The shape follows the real game. Divisions belong to an army; an army belongs
 * to a general; several armies belong to an army group, which belongs to a
 * field marshal. Nothing here moves a division -- movement and combat read the
 * modifiers this module computes and are otherwise unchanged.
 *
 * The rates are the real game's:
 *
 *   attack     +5%   per level, to soft and hard attack
 *   defence    +5%   per level, to defence
 *   logistics  -2.5% per level, to supply consumption
 *   planning   +5%   per level to planning speed, +2% to the planning ceiling
 *
 * A field marshal passes half of all of that to every general beneath him,
 * which is what makes a good field marshal worth more than a good general: his
 * numbers are felt by five armies at once rather than one.
 */

/** Divisions one officer can command before his bonuses start to fade. */
export const COMMAND_LIMIT = 24;
/** What the organiser trait adds to that. */
export const ORGANISER_BONUS = 6;
/** Armies one field marshal can hold. */
export const ARMY_GROUP_LIMIT = 5;
/** Fraction of a field marshal's attributes that reaches his generals. */
export const FIELD_MARSHAL_SHARE = 0.5;

const ATTACK_PER_LEVEL = 0.05;
const DEFENCE_PER_LEVEL = 0.05;
const LOGISTICS_PER_LEVEL = 0.025;
const PLANNING_SPEED_PER_LEVEL = 0.05;
const MAX_PLANNING_PER_LEVEL = 0.02;

/** What a division actually feels from the officers above it. */
export interface CommandModifiers {
  attack: number;
  defence: number;
  /** Multiplier on supply consumption; below 1 is an improvement. */
  supplyUse: number;
  planningSpeed: number;
  /** Added to the ceiling the planning bonus may reach. */
  maxPlanningBonus: number;
  entrenchment: number;
}

export const NO_COMMAND: CommandModifiers = {
  attack: 1, defence: 1, supplyUse: 1, planningSpeed: 1, maxPlanningBonus: 0, entrenchment: 1,
};

/** Lazily created, the way the research and focus runtimes create theirs. */
export function commandState(state: GameState): {
  commanders: Commander[];
  armies: Army[];
} {
  if (!state.commanders) state.commanders = [];
  if (!state.armies) state.armies = [];
  if (state.nextIds.commander === undefined) state.nextIds.commander = 0;
  if (state.nextIds.army === undefined) state.nextIds.army = 0;
  return { commanders: state.commanders, armies: state.armies };
}

export function armyById(state: GameState, id: ArmyId | null): Army | null {
  if (id === null) return null;
  return state.armies?.find((a) => a.id === id) ?? null;
}

export function commanderById(state: GameState, id: CommanderId | null): Commander | null {
  if (id === null) return null;
  return state.commanders?.find((c) => c.id === id) ?? null;
}

/** Every army a country owns, army groups included. */
export function armiesOf(state: GameState, country: CountryId): Army[] {
  return (state.armies ?? []).filter((a) => a.owner === country);
}

/** Officers a country has who are not currently leading anything. */
export function idleCommanders(state: GameState, country: CountryId): Commander[] {
  return (state.commanders ?? []).filter((c) => c.owner === country && c.assignment === null);
}

/** Divisions this officer is responsible for, including through an army group. */
export function commandedDivisions(state: GameState, army: Army): number {
  if (!army.isArmyGroup) return army.divisions.length;
  let n = 0;
  for (const childId of army.children) {
    const child = armyById(state, childId);
    if (child) n += child.divisions.length;
  }
  return n;
}

export function commandLimit(commander: Commander): number {
  const base = COMMAND_LIMIT + (commander.traits.includes('organiser') ? ORGANISER_BONUS : 0);
  // A field marshal is rated on armies, not divisions, so his ceiling is the
  // whole group's worth of them.
  return commander.rank === 'field_marshal' ? base * ARMY_GROUP_LIMIT : base;
}

/**
 * How much of an officer's ability survives the size of his command.
 *
 * Full strength up to the limit, then falling away linearly until it is gone
 * at twice the limit. Piling forty-eight divisions onto one general is allowed
 * -- it just buys nothing, which is the right shape of discouragement: a
 * hard cap would strand divisions with nowhere to go.
 */
export function overloadScale(state: GameState, army: Army, commander: Commander): number {
  const limit = commandLimit(commander);
  const held = commandedDivisions(state, army);
  if (held <= limit) return 1;
  return Math.max(0, 1 - (held - limit) / limit);
}

function applyCommander(
  into: CommandModifiers, c: Commander, scale: number,
): void {
  into.attack += c.attack * ATTACK_PER_LEVEL * scale;
  into.defence += c.defence * DEFENCE_PER_LEVEL * scale;
  into.supplyUse -= c.logistics * LOGISTICS_PER_LEVEL * scale;
  into.planningSpeed += c.planning * PLANNING_SPEED_PER_LEVEL * scale;
  into.maxPlanningBonus += c.planning * MAX_PLANNING_PER_LEVEL * scale;

  // Traits are flat and do not scale with the attribute they resemble; they
  // are the officer's reputation, not his paperwork.
  if (c.traits.includes('logistics_wizard')) into.supplyUse -= 0.2 * scale;
  if (c.traits.includes('defensive_doctrine')) into.entrenchment += 0.3 * scale;
  if (c.traits.includes('fast_planner')) into.planningSpeed += 0.1 * scale;
  if (c.traits.includes('thorough_planner')) into.maxPlanningBonus += 0.5 * into.maxPlanningBonus;
}

/**
 * The modifiers a division gets from its army's general and, above him, from
 * the field marshal of the army group.
 *
 * A division in no army gets nothing. That is deliberate: the difference
 * between an organised army and a pile of divisions has to be visible in the
 * combat numbers or organising is busywork.
 */
export function commandModifiers(state: GameState, division: Division): CommandModifiers {
  const army = armyById(state, division.armyId);
  if (!army) return NO_COMMAND;

  const mods: CommandModifiers = { ...NO_COMMAND };
  const general = commanderById(state, army.commander);
  if (general) applyCommander(mods, general, overloadScale(state, army, general));

  const group = armyById(state, army.parent);
  if (group) {
    const marshal = commanderById(state, group.commander);
    if (marshal) {
      applyCommander(mods, marshal, FIELD_MARSHAL_SHARE * overloadScale(state, group, marshal));
    }
  }
  // Supply relief is capped: no stack of traits and levels may make a division
  // free to feed.
  mods.supplyUse = Math.max(0.35, mods.supplyUse);
  return mods;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

export function createArmy(
  state: GameState, owner: CountryId, name: string, isArmyGroup = false,
): Army {
  const { armies } = commandState(state);
  const army: Army = {
    id: state.nextIds.army!++,
    owner,
    name,
    commander: null,
    divisions: [],
    parent: null,
    children: [],
    isArmyGroup,
    order: null,
    planning: 0,
    frontProvinces: [],
  };
  armies.push(army);
  return army;
}

export function disbandArmy(state: GameState, id: ArmyId): void {
  const army = armyById(state, id);
  if (!army) return;
  for (const d of state.divisions) if (d.armyId === id) d.armyId = null;
  const commander = commanderById(state, army.commander);
  if (commander) commander.assignment = null;
  // Children of a disbanded group are freed, not disbanded with it: the
  // divisions in them are still real and still standing somewhere.
  for (const childId of army.children) {
    const child = armyById(state, childId);
    if (child) child.parent = null;
  }
  const parent = armyById(state, army.parent);
  if (parent) parent.children = parent.children.filter((c) => c !== id);
  state.armies = (state.armies ?? []).filter((a) => a.id !== id);
}

/** Moves divisions into an army, taking them out of whatever held them. */
export function assignDivisions(
  state: GameState, id: ArmyId | null, divisions: DivisionId[],
): void {
  const army = id === null ? null : armyById(state, id);
  if (army?.isArmyGroup) return; // A group holds armies, never divisions.
  for (const divId of divisions) {
    const div = state.divisions.find((d) => d.id === divId);
    if (!div || div.dead) continue;
    if (army && div.owner !== army.owner) continue;
    const old = armyById(state, div.armyId);
    if (old) old.divisions = old.divisions.filter((x) => x !== divId);
    div.armyId = army ? army.id : null;
    if (army && !army.divisions.includes(divId)) army.divisions.push(divId);
  }
}

/** Puts an officer in charge, displacing whoever held the post. */
export function appointCommander(
  state: GameState, armyId: ArmyId, commanderId: CommanderId | null,
): void {
  const army = armyById(state, armyId);
  if (!army) return;
  const previous = commanderById(state, army.commander);
  if (previous) previous.assignment = null;

  const next = commanderById(state, commanderId);
  if (!next || next.owner !== army.owner) {
    army.commander = null;
    return;
  }
  // Rank has to match the post: a general cannot run an army group and a field
  // marshal will not take a single army.
  const wanted = army.isArmyGroup ? 'field_marshal' : 'general';
  if (next.rank !== wanted) return;

  const held = armyById(state, next.assignment);
  if (held) held.commander = null;
  next.assignment = army.id;
  army.commander = next.id;
}

/** Places an army under an army group, or removes it from one with null. */
export function setArmyParent(state: GameState, armyId: ArmyId, groupId: ArmyId | null): void {
  const army = armyById(state, armyId);
  if (!army || army.isArmyGroup) return;
  const old = armyById(state, army.parent);
  if (old) old.children = old.children.filter((c) => c !== armyId);
  army.parent = null;

  if (groupId === null) return;
  const group = armyById(state, groupId);
  if (!group || !group.isArmyGroup || group.owner !== army.owner) return;
  if (group.children.length >= ARMY_GROUP_LIMIT) return;
  group.children.push(armyId);
  army.parent = group.id;
}

/**
 * Officers learn by being in the field, not by existing.
 *
 * Experience accrues from divisions of theirs that are actually in combat, so
 * a reserve army's general stays where he started while the one holding the
 * line improves. Skill compounds: each level costs more than the last.
 */
export function tickCommanderExperienceDaily(state: GameState): void {
  const armies = state.armies;
  if (!armies) return;
  for (const army of armies) {
    const commander = commanderById(state, army.commander);
    if (!commander) continue;
    let fighting = 0;
    const ids = army.isArmyGroup
      ? army.children.flatMap((c) => armyById(state, c)?.divisions ?? [])
      : army.divisions;
    for (const divId of ids) {
      const div = state.divisions.find((d) => d.id === divId);
      if (div && !div.dead && div.combatId !== null) fighting++;
    }
    if (fighting === 0) continue;
    commander.experience += Math.min(fighting, 12) * 0.05;
    const needed = commander.skill * 20;
    if (commander.experience >= needed && commander.skill < 9) {
      commander.experience -= needed;
      commander.skill++;
      // A level raises the attribute the officer has been leaning on, which is
      // the one that is already his best; officers specialise as they age.
      const best = (['attack', 'defence', 'planning', 'logistics'] as const)
        .reduce((a, b) => (commander[a] >= commander[b] ? a : b));
      if (commander[best] < 6) commander[best]++;
    }
  }
}

/** Provinces held by an army's divisions; the anchor for its front. */
export function armyProvinces(state: GameState, army: Army): ProvinceId[] {
  const seen = new Set<ProvinceId>();
  for (const divId of army.divisions) {
    const div = state.divisions.find((d) => d.id === divId);
    if (div && !div.dead) seen.add(div.provinceId);
  }
  return [...seen].sort((a, b) => a - b);
}
