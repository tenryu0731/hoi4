import { effectiveTemplate, techModifiers } from '../research';
import { TERRAIN } from '../core/data';
import type {
  CountryId, Division, DivisionTemplate, GameState, ProvinceId,
} from '../core/types';
import type { ProvinceIndex } from '../map/ProvinceIndex';
import {
  RETREAT_COOLDOWN_HOURS, findCombatAt, joinCombat, resolveCombatRound,
  startCombat, tickDivisionUpkeep,
} from './combat';

/**
 * Movement, orders, and the hourly military tick.
 *
 * A division holds a path and creeps along the current leg each hour. Speed
 * comes from the slowest battalion in the template, scaled by terrain,
 * infrastructure and supply -- so an armoured spearhead outruns its trains and
 * then crawls, which is the behaviour the period demands.
 */

/**
 * Marching speed is not road speed.
 *
 * Provinces here average 223km between centres -- HOI4's are a quarter of that
 * -- so the scale has to be read against this map, not against a doctrine
 * table. At 2.2 a foot division covers roughly 210km/day and crosses a typical
 * province in under a day; at the 0.5 this used to be, a single hop took two
 * and a half in-game days and nineteen real seconds, and an order looked
 * exactly like an order that had been ignored.
 */
const KM_PER_HOUR_SCALE = 2.2;
/** Nobody moves slower than this fraction of their nominal speed. */
const MIN_SPEED_FACTOR = 0.15;
/** A division may not move while its organisation is below this fraction. */
const MIN_ORG_TO_MOVE = 0.10;

export interface MilitaryContext {
  index: ProvinceIndex;
}

function templateOf(state: GameState, d: Division): DivisionTemplate {
  const c = state.countries[d.owner];
  return c.templates.find((t) => t.id === d.templateId) ?? c.templates[0];
}

export function isHostile(state: GameState, a: CountryId, b: CountryId): boolean {
  if (a === b) return false;
  return state.countries[a].atWarWith.includes(b);
}

/** True when `country` may stand in the province without a fight. */
export function canEnterFreely(state: GameState, country: CountryId, province: ProvinceId): boolean {
  const controller = state.provinces[province].controller;
  return controller === country || !isHostile(state, country, controller);
}

// ---------------------------------------------------------------------------
// Province occupancy bookkeeping
// ---------------------------------------------------------------------------

export function placeDivision(state: GameState, d: Division, province: ProvinceId): void {
  const from = state.provinces[d.provinceId];
  if (from) {
    const i = from.divisions.indexOf(d.id);
    if (i >= 0) from.divisions.splice(i, 1);
  }
  d.provinceId = province;
  const to = state.provinces[province];
  if (!to.divisions.includes(d.id)) to.divisions.push(d.id);
}

export function removeDivision(state: GameState, d: Division): void {
  const p = state.provinces[d.provinceId];
  if (p) {
    const i = p.divisions.indexOf(d.id);
    if (i >= 0) p.divisions.splice(i, 1);
  }
  d.dead = true;
  d.combatId = null;
  d.path = [];
  d.order = null;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Naval capability
// ---------------------------------------------------------------------------

/**
 * Divisions a single dockyard can keep in transit.
 *
 * Crossing water used to be a pathfinding *cost* rather than a capability, so
 * a foot infantry division walked the English Channel in under a day with no
 * transports and no naval preparation, and Britain fell in about a fortnight
 * to an army that had strolled there. A crossing now needs shipping, and a
 * power with no dockyards cannot make one at all.
 */
const DIVISIONS_PER_DOCKYARD = 0.8;

/** Convoys in the stockpile needed to lift one more division beyond that. */
const CONVOYS_PER_DIVISION = 40;

/** Hard ceiling, so a naval superpower still cannot move its whole army at once. */
const MAX_SEALIFT = 24;

/**
 * Fraction of organisation a division keeps when it steps ashore.
 *
 * A landing is the most disorganised thing an army does, and without a penalty
 * an amphibious assault is strictly better than a land attack -- it arrives
 * where the enemy is not.
 */
const LANDING_ORG_KEPT = 0.35;

/** How many divisions this country can have at sea at once. */
export function sealiftCapacity(state: GameState, owner: CountryId): number {
  const c = state.countries[owner];
  const fromYards = c.economy.dockyards * DIVISIONS_PER_DOCKYARD;
  const fromConvoys = (c.economy.stockpile.convoy ?? 0) / CONVOYS_PER_DIVISION;
  const m = techModifiers(state, owner);
  return Math.min(MAX_SEALIFT, Math.floor((fromYards + fromConvoys) * m.sealift));
}

/** Divisions of this country currently mid-crossing. */
function sealiftInUse(state: GameState, ctx: MilitaryContext, owner: CountryId): number {
  let n = 0;
  for (const d of state.divisions) {
    if (d.dead || d.owner !== owner || d.path.length === 0) continue;
    if (ctx.index.isSeaLink(d.provinceId, d.path[0])) n++;
  }
  return n;
}

/** True when any step of this route crosses water. */
function routeCrossesSea(ctx: MilitaryContext, from: ProvinceId, path: ProvinceId[]): boolean {
  let prev = from;
  for (const step of path) {
    if (ctx.index.isSeaLink(prev, step)) return true;
    prev = step;
  }
  return false;
}

/**
 * Routes a division toward a target. Enemy-held provinces are passable -- the
 * unit will attack into them -- but cost far more, so the pathfinder prefers to
 * go around a strongpoint when a flank exists.
 */
export function orderMove(
  state: GameState, ctx: MilitaryContext, d: Division, target: ProvinceId,
): boolean {
  if (d.dead || target === d.provinceId) {
    d.path = [];
    d.order = null;
    return false;
  }
  const path = ctx.index.path(d.provinceId, target, {
    allowSea: true,
    seaMultiplier: 6,
    cost: (id) => {
      const terrain = TERRAIN[ctx.index.get(id).terrain];
      const hostile = isHostile(state, d.owner, state.provinces[id].controller);
      return (1 / terrain.speed) * (hostile ? 3.5 : 1);
    },
  });
  if (!path || path.length < 2) {
    d.path = [];
    return false;
  }
  // Refused outright rather than left queueing on a beach forever: a power with
  // no shipping has no business being given an overseas order at all.
  if (routeCrossesSea(ctx, d.provinceId, path.slice(1))
      && sealiftCapacity(state, d.owner) <= 0) {
    d.path = [];
    return false;
  }
  d.path = path.slice(1);
  d.moveProgress = 0;
  d.order = { kind: 'move', target };
  return true;
}

export function stopDivision(d: Division): void {
  d.path = [];
  d.moveProgress = 0;
  d.order = { kind: 'defend' };
}

// ---------------------------------------------------------------------------
// Hourly tick
// ---------------------------------------------------------------------------

export function tickMilitaryHourly(state: GameState, ctx: MilitaryContext): void {
  // 1. Resolve every ongoing battle first, so a division that loses this hour
  //    retreats before it gets a chance to move.
  resolveCombats(state, ctx);

  // 2. Movement and upkeep.
  for (const d of state.divisions) {
    if (d.dead) continue;
    if (d.combatId === null) advanceMovement(state, ctx, d);
    tickDivisionUpkeep(state, d);
  }

  // 3. Prune finished battles.
  if (state.combats.length > 64) {
    state.combats = state.combats.filter((c) => !c.ended);
  }
}

function resolveCombats(state: GameState, ctx: MilitaryContext): void {
  for (const combat of state.combats) {
    if (combat.ended) continue;

    // Drop dead or departed participants.
    combat.attackers = combat.attackers.filter((id) => {
      const d = state.divisions[id];
      return d && !d.dead && d.combatId === combat.id;
    });
    combat.defenders = combat.defenders.filter((id) => {
      const d = state.divisions[id];
      return d && !d.dead && d.combatId === combat.id && d.provinceId === combat.province;
    });

    if (combat.attackers.length === 0) {
      endCombat(state, ctx, combat, false);
      continue;
    }
    if (combat.defenders.length === 0) {
      endCombat(state, ctx, combat, true);
      continue;
    }

    const result = resolveCombatRound(state, ctx, combat);
    if (result.ended) endCombat(state, ctx, combat, result.attackerWon);
  }
}

function endCombat(
  state: GameState, ctx: MilitaryContext, combat: Combat_, attackerWon: boolean,
): void {
  combat.ended = true;
  const attackers = combat.attackers.map((id) => state.divisions[id]).filter(Boolean);
  const defenders = combat.defenders.map((id) => state.divisions[id]).filter(Boolean);

  for (const d of [...attackers, ...defenders]) if (d) d.combatId = null;

  if (attackerWon) {
    for (const d of defenders) if (d) retreat(state, ctx, d, combat.province);
    // The first attacker still standing takes the ground.
    const winner = attackers.find((d) => d && !d.dead && d.org > 0);
    if (winner) {
      captureProvince(state, ctx, combat.province, combat.attackerCountry);
      placeDivision(state, winner, combat.province);
      winner.moveProgress = 0;
      winner.path = winner.path.filter((p) => p !== combat.province);
    }
  } else {
    for (const d of attackers) {
      if (!d) continue;
      d.path = [];
      d.moveProgress = 0;
      d.retreatCooldown = RETREAT_COOLDOWN_HOURS;
      d.order = { kind: 'defend' };
    }
  }
}

type Combat_ = GameState['combats'][number];

/**
 * Pushes a beaten division to an adjacent province its side still holds. With
 * nowhere to go it is destroyed -- which is what makes an encirclement lethal
 * rather than merely inconvenient.
 */
export function retreat(
  state: GameState, ctx: MilitaryContext, d: Division, from: ProvinceId,
): void {
  const options = retreatOptions(state, ctx, d, from);
  if (options.length === 0) {
    removeDivision(state, d);
    state.log.push({
      day: state.clock.totalDays,
      kind: 'combat',
      body: { k: 'divisionLost', country: state.countries[d.owner].tag },
      province: from,
      country: d.owner,
    });
    return;
  }
  // Fall back toward the best-supplied neighbour.
  let best = options[0];
  for (const opt of options) {
    if (state.provinces[opt].supply > state.provinces[best].supply) best = opt;
  }
  placeDivision(state, d, best);
  d.path = [];
  d.moveProgress = 0;
  d.retreatCooldown = RETREAT_COOLDOWN_HOURS;
  d.order = { kind: 'defend' };
}

function retreatOptions(
  state: GameState, ctx: MilitaryContext, d: Division, from: ProvinceId,
): ProvinceId[] {
  const geo = ctx.index.get(from);
  const out: ProvinceId[] = [];
  for (const nb of geo.neighbors) {
    if (state.provinces[nb].controller === d.owner) out.push(nb);
    else if (!isHostile(state, d.owner, state.provinces[nb].controller)) out.push(nb);
  }
  return out;
}

export function captureProvince(
  state: GameState, ctx: MilitaryContext, province: ProvinceId, by: CountryId,
): void {
  const p = state.provinces[province];
  if (p.controller === by) return;
  p.controller = by;
  p.lastChangeHour = state.clock.totalHours;
  p.fortLevel = 0;

  // A state changes hands only when every one of its provinces does.
  const stateId = ctx.index.get(province).stateId;
  const members = ctx.index.data.states[stateId].provinces;
  if (members.every((id) => state.provinces[id].controller === by)) {
    state.states[stateId].controller = by;
  }
}

// ---------------------------------------------------------------------------
// Movement integration
// ---------------------------------------------------------------------------

export function movementSpeed(
  state: GameState, ctx: MilitaryContext, d: Division, into: ProvinceId,
): number {
  const tpl = effectiveTemplate(state, d.owner, templateOf(state, d));
  const geo = ctx.index.get(into);
  const terrain = TERRAIN[geo.terrain];
  const infra = state.states[geo.stateId]?.infrastructure ?? 1;
  const infraFactor = 0.6 + (infra / 5) * 0.6;
  const supplyFactor = 0.5 + 0.5 * Math.min(1, d.supplyLevel);
  const factor = Math.max(MIN_SPEED_FACTOR, terrain.speed * infraFactor * supplyFactor);
  return tpl.speedKmh * factor * KM_PER_HOUR_SCALE;
}

function advanceMovement(state: GameState, ctx: MilitaryContext, d: Division): void {
  if (d.path.length === 0) return;
  const tpl = effectiveTemplate(state, d.owner, templateOf(state, d));
  if (d.org < tpl.maxOrg * MIN_ORG_TO_MOVE || d.retreatCooldown > 0) return;

  const next = d.path[0];
  // Shipping is a live resource: a division waits on the quay until a hull is
  // free, which is what stops an entire army crossing in one tide.
  const crossing = ctx.index.isSeaLink(d.provinceId, next);
  if (crossing && d.moveProgress === 0
      && sealiftInUse(state, ctx, d.owner) >= sealiftCapacity(state, d.owner)) {
    return;
  }
  const distance = Math.max(1, ctx.index.distance(d.provinceId, next));
  const kmThisHour = movementSpeed(state, ctx, d, next);
  d.moveProgress += kmThisHour / distance;
  if (d.moveProgress < 1) return;

  d.moveProgress = 0;
  if (crossing) {
    // Ashore, and disorganised. Without this an amphibious assault is strictly
    // better than a land attack, because it arrives where the enemy is not.
    const tplNow = effectiveTemplate(state, d.owner, templateOf(state, d));
    const kept = Math.min(0.9, LANDING_ORG_KEPT * techModifiers(state, d.owner).landingOrg);
    d.org = Math.min(d.org, tplNow.maxOrg * kept);
  }
  const controller = state.provinces[next].controller;

  if (isHostile(state, d.owner, controller)) {
    // Contested: join or open a battle instead of walking in.
    const defenders = state.provinces[next].divisions
      .map((id) => state.divisions[id])
      .filter((x) => x && !x.dead && x.owner !== d.owner && isHostile(state, d.owner, x.owner));

    if (defenders.length === 0) {
      // Undefended enemy ground is simply taken.
      captureProvince(state, ctx, next, d.owner);
      placeDivision(state, d, next);
      d.path.shift();
      if (d.path.length === 0) d.order = { kind: 'defend' };
      return;
    }
    let combat = findCombatAt(state, next);
    if (!combat || combat.attackerCountry !== d.owner) {
      combat = startCombat(state, next, d.owner, controller);
      for (const def of defenders) joinCombat(combat, def!, false);
      state.log.push({
        day: state.clock.totalDays,
        kind: 'combat',
        body: {
          k: 'attack',
          attacker: state.countries[d.owner].tag,
          defender: state.countries[controller].tag,
          province: next,
        },
        province: next,
        country: d.owner,
      });
    }
    joinCombat(combat, d, true);
    return;
  }

  placeDivision(state, d, next);
  d.path.shift();
  if (d.path.length === 0) d.order = { kind: 'defend' };
}

// ---------------------------------------------------------------------------
// Reinforcement
// ---------------------------------------------------------------------------

/**
 * Tops divisions up from the national stockpile. Runs daily: a unit that has
 * been mauled slowly returns to strength as factories deliver, which is the
 * link between the economy and the front.
 */
export function tickReinforcementDaily(state: GameState): void {
  for (const d of state.divisions) {
    if (d.dead) continue;
    const c = state.countries[d.owner];
    if (c.capitulated) continue;
    const tpl = c.templates.find((t) => t.id === d.templateId);
    if (!tpl) continue;
    // Units in supply and out of contact absorb replacements fastest.
    const rate = d.combatId !== null ? 0.01 : 0.05 * Math.max(0.2, d.supplyLevel);

    for (const [eq, need] of Object.entries(tpl.equipmentNeed) as [keyof typeof tpl.equipmentNeed, number][]) {
      const have = d.equipment[eq] ?? 0;
      if (have >= need) continue;
      const wanted = Math.min(need - have, need * rate);
      const stock = c.economy.stockpile[eq] ?? 0;
      const taken = Math.min(wanted, stock);
      if (taken <= 0) continue;
      d.equipment[eq] = have + taken;
      c.economy.stockpile[eq] = stock - taken;
    }
  }
}
