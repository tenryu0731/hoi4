import { atWar } from '../diplomacy/diplomacy';
import type { ProvinceIndex } from '../map/ProvinceIndex';
import type {
  Army, CountryId, Division, GameState, ProvinceId,
} from '../core/types';
import { armyById, commandModifiers, commanderById, overloadScale } from './command';
import { orderMove, type MilitaryContext } from './movement';

/**
 * Battle plans: front lines, offensives, and the bonus for having thought
 * about it first.
 *
 * A front line is a standing instruction rather than a list of destinations.
 * The army is told which enemy to face; every day it works out which of our
 * provinces actually touch theirs and spreads itself along them, and it does
 * that again as the border moves. This is the difference between ordering an
 * army and ordering forty divisions one at a time, and it is most of why the
 * real game is playable at all.
 *
 * The preparation numbers are the real game's: 2% of bonus a day, a ceiling of
 * 30% before an officer's planning attribute raises it, 1% a day lost while
 * the plan is executing.
 */

/** Bonus accumulated per day while an army sits on its plan. */
export const PLANNING_PER_DAY = 0.02;
/** Ceiling before a commander's planning attribute raises it. */
export const BASE_MAX_PLANNING = 0.3;
/** Bonus shed per day once the army is moving under its own plan. */
export const PLANNING_DECAY_PER_DAY = 0.01;

/**
 * Provinces of ours that touch the enemy: the line itself.
 *
 * Computed from control rather than ownership, because a front follows who is
 * standing where, not whose name is on the deed.
 */
export function frontProvinces(
  state: GameState, index: ProvinceIndex, owner: CountryId, against: CountryId,
): ProvinceId[] {
  const out: ProvinceId[] = [];
  for (const province of index.provinces) {
    const here = state.provinces[province.id];
    if (!here || here.controller !== owner) continue;
    for (const nb of province.neighbors) {
      const there = state.provinces[nb];
      if (there && there.controller === against) { out.push(province.id); break; }
    }
  }
  return out;
}

/**
 * Where the front would be if the enemy is not named -- against everyone we
 * are at war with. This is what an army ordered to "hold the line" gets.
 */
export function hostileFront(
  state: GameState, index: ProvinceIndex, owner: CountryId,
): ProvinceId[] {
  const out: ProvinceId[] = [];
  for (const province of index.provinces) {
    const here = state.provinces[province.id];
    if (!here || here.controller !== owner) continue;
    for (const nb of province.neighbors) {
      const there = state.provinces[nb];
      if (there && there.controller !== owner && atWar(state, owner, there.controller)) {
        out.push(province.id);
        break;
      }
    }
  }
  return out;
}

/**
 * Hands out the front's provinces to the army's divisions.
 *
 * Each division goes to the nearest unclaimed one, nearest first, so a line
 * fills from wherever the army already is rather than crossing over itself.
 * Divisions left over once every province has a holder double up on the ones
 * that matter most -- the provinces worth victory points.
 */
export function assignToFront(
  state: GameState, ctx: MilitaryContext, army: Army, front: ProvinceId[],
): void {
  if (front.length === 0) return;
  const divisions = army.divisions
    .map((id) => state.divisions.find((d) => d.id === id))
    .filter((d): d is NonNullable<typeof d> =>
      !!d && !d.dead && d.combatId === null && !d.detached);
  if (divisions.length === 0) return;

  // Sorted by victory points so the doubling-up lands on what is worth holding,
  // and by id after that so the assignment is the same on every machine.
  const ranked = [...front].sort((a, b) => {
    const va = state.provinces[a]?.vp ?? 0;
    const vb = state.provinces[b]?.vp ?? 0;
    return vb - va || a - b;
  });

  const taken = new Map<ProvinceId, number>();
  for (const div of divisions) {
    let best: ProvinceId | null = null;
    let bestCost = Infinity;
    for (const target of ranked) {
      // Prefer an empty post; only stack once every post has somebody.
      const load = taken.get(target) ?? 0;
      const from = ctx.index.get(div.provinceId);
      const to = ctx.index.get(target);
      const distance = Math.hypot(from.centerX - to.centerX, from.centerY - to.centerY);
      const cost = distance + load * 4000;
      if (cost < bestCost) { bestCost = cost; best = target; }
    }
    if (best === null) continue;
    taken.set(best, (taken.get(best) ?? 0) + 1);
    reorder(state, ctx, div, best);
  }
}

/**
 * Pushes an army at its objectives.
 *
 * Every division is sent at the nearest target rather than being spread over
 * them: an offensive that divides itself between two objectives takes neither.
 */
export function pressOffensive(
  state: GameState, ctx: MilitaryContext, army: Army, targets: ProvinceId[],
): void {
  const live = targets.filter((t) => {
    const p = state.provinces[t];
    return p && p.controller !== army.owner;
  });
  if (live.length === 0) return;
  for (const id of army.divisions) {
    const div = state.divisions.find((d) => d.id === id);
    if (!div || div.dead || div.combatId !== null || div.detached) continue;
    let best = live[0];
    let bestCost = Infinity;
    const from = ctx.index.get(div.provinceId);
    for (const target of live) {
      const to = ctx.index.get(target);
      const distance = Math.hypot(from.centerX - to.centerX, from.centerY - to.centerY);
      if (distance < bestCost) { bestCost = distance; best = target; }
    }
    reorder(state, ctx, div, best);
  }
}

/**
 * Sends a division somewhere, unless it is already on its way there.
 *
 * This guard is the whole reason a standing order works at all. orderMove
 * resets moveProgress, and these plans are re-issued every day: re-ordering a
 * division that is already walking to the same province throws away the
 * progress it made yesterday, so anything more than a day's march away is
 * never reached. Measured before the guard, a German army told to hold the
 * Polish border had three divisions in motion on day 5 and the same three on
 * day 20, having gone nowhere.
 */
function reorder(
  state: GameState, ctx: MilitaryContext, div: Division, target: ProvinceId,
): void {
  if (div.provinceId === target) return;
  if (div.order?.kind === 'move' && div.order.target === target && div.path.length > 0) return;
  orderMove(state, ctx, div, target);
}

/** The ceiling this army's planning may reach, with its officers' help. */
export function maxPlanning(state: GameState, army: Army): number {
  const first = army.divisions[0];
  const div = first === undefined ? null : state.divisions.find((d) => d.id === first);
  const mods = div ? commandModifiers(state, div) : null;
  return BASE_MAX_PLANNING + (mods?.maxPlanningBonus ?? 0);
}

/** How fast this army prepares, with its officers' help. */
function planningSpeed(state: GameState, army: Army): number {
  const commander = commanderById(state, army.commander);
  if (!commander) return 1;
  const scale = overloadScale(state, army, commander);
  const fast = commander.traits.includes('fast_planner') ? 0.1 : 0;
  return 1 + (commander.planning * 0.05 + fast) * scale;
}

/**
 * One day of every army's standing orders.
 *
 * Re-spreads fronts, presses offensives, and moves the planning bar. Runs
 * daily rather than hourly because a front that re-forms every hour thrashes:
 * divisions would spend the whole war walking between two adjacent provinces
 * as the line wobbled.
 */
export function tickBattlePlansDaily(state: GameState, ctx: MilitaryContext): void {
  const armies = state.armies;
  if (!armies) return;

  for (const army of armies) {
    if (army.isArmyGroup) {
      // A group has no divisions; it passes its order to the armies under it.
      for (const childId of army.children) {
        const child = armyById(state, childId);
        if (child && army.order && !child.order) child.order = army.order;
      }
      continue;
    }
    if (army.divisions.length === 0) {
      army.planning = 0;
      army.frontProvinces = [];
      continue;
    }
    if (!army.order) {
      // An army with no plan still digs in, at half the rate and with no help
      // finding the line. This is not decoration: the AI gives orders to
      // divisions directly and never sets an army order, so without it the
      // planning bonus would be a mechanic only the human player could ever
      // have, and every battle in the game would be tilted by up to 45%
      // toward whoever happened to be reading the screen.
      army.frontProvinces = [];
      accruePlanning(state, army, 0.5);
      continue;
    }

    // An AI army declares its front so that the preparation and the front
    // bookkeeping are real, but keeps moving its own divisions: its loop is
    // tuned around garrison budgets and re-order suppression this spreader
    // does not model, and two controllers issuing movement on the same day
    // would leave divisions walking back and forth.
    const spread = !state.countries[army.owner].isAI;

    let front: ProvinceId[] = [];
    switch (army.order.kind) {
      case 'front':
        front = frontProvinces(state, ctx.index, army.owner, army.order.against);
        // A named enemy we no longer touch anywhere leaves the army facing
        // whoever else is shooting at us, rather than standing idle.
        if (front.length === 0) front = hostileFront(state, ctx.index, army.owner);
        if (spread) assignToFront(state, ctx, army, front);
        break;
      case 'garrison':
        front = army.order.provinces.filter((p) => state.provinces[p]?.controller === army.owner);
        if (spread) assignToFront(state, ctx, army, front);
        break;
      case 'offensive':
        front = army.order.targets;
        if (spread) pressOffensive(state, ctx, army, front);
        break;
    }
    army.frontProvinces = front;

    accruePlanning(state, army, 1);
  }
}

/**
 * Moves the preparation bar for one army.
 *
 * Grows while the army holds and drains while it executes. "Executing" is
 * measured by how many divisions are actually walking, which is the honest
 * signal: an army repositioning along its own line is not preparing, whatever
 * its orders say.
 */
function accruePlanning(state: GameState, army: Army, rate: number): void {
  const moving = army.divisions.reduce((n, id) => {
    const div = state.divisions.find((d) => d.id === id);
    return n + (div && !div.dead && div.path.length > 0 ? 1 : 0);
  }, 0);
  if (moving > army.divisions.length / 2) {
    army.planning = Math.max(0, army.planning - PLANNING_DECAY_PER_DAY);
    return;
  }
  const ceiling = maxPlanning(state, army) * rate;
  army.planning = Math.min(
    ceiling, army.planning + PLANNING_PER_DAY * planningSpeed(state, army) * rate,
  );
}
