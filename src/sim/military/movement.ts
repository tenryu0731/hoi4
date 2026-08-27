import { effectiveTemplate, techModifiers } from '../research';
import { commandModifiers } from './command';
import { nearestUsablePort } from './ports';
import { DRY_SPEED, fuelPenalty } from '../economy/fuel';
import { INITIAL_RESISTANCE } from '../economy/occupation';
import {
  WINTER_ATTRITION_PER_DAY, WINTER_SPECIALIST_RELIEF, winterSeverity,
} from './weather';

/** Levels a division may dig in to before a defensive general raises the cap. */
export const MAX_ENTRENCHMENT = 4;
/** What a panzer general adds to the speed of the armour he leads. */
export const PANZER_LEADER_SPEED = 0.1;
/** What an amphibious specialist adds to the order his men land in. */
export const NAVAL_INVADER_ORG = 0.3;
/** Defence added per level dug in. */
export const ENTRENCHMENT_PER_LEVEL = 0.05;
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

/**
 * Whether an army may set foot in a province at all.
 *
 * Three grounds and no others: it is ours, it belongs to somebody in our bloc,
 * or we are at war with whoever holds it -- and that last one is an attack,
 * not a visit.
 *
 * Nothing checked this before, so a division could march into any neutral
 * country in peacetime and stand there. 「平時に非同盟国の領土に師団を置ける
 * のはおかしい」 is exactly right: a border is the first thing a country has,
 * and a map where armies drift across them has no diplomacy in it -- there is
 * no reason to declare war on Belgium if you can simply walk through it.
 *
 * A treaty of passage would be the fuller answer and is a bigger feature; a
 * bloc is the version of it this game already models.
 */
export function hasAccess(state: GameState, country: CountryId, province: ProvinceId): boolean {
  const controller = state.provinces[province]?.controller;
  if (controller === undefined || controller === country) return true;
  if (isHostile(state, country, controller)) return true;
  const c = state.countries[country];
  const other = state.countries[controller];
  return c.factionId !== null && c.factionId === other.factionId;
}

// ---------------------------------------------------------------------------
// Province occupancy bookkeeping
// ---------------------------------------------------------------------------

export function placeDivision(state: GameState, d: Division, province: ProvinceId): void {
  // Ground is only prepared by holding it. Everything a division dug is left
  // behind the moment it steps into the next province, which is the whole
  // reason entrenchment favours the side that does not have to move.
  if (d.provinceId !== province) d.entrenchment = 0;
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
    if (isVoyage(ctx.index, d.provinceId, d.path[0])) n++;
  }
  return n;
}

/**
 * True when this step of a route is made by ship.
 *
 * Two provinces that touch across water is a strait crossing -- an assault, or
 * a ferry. Two provinces that do not touch at all can only be a voyage: the
 * pathfinder never produces such a step, so the only thing that puts one in a
 * route is `orderTransport`, and this is how the rest of the code finds it
 * again without a second field to keep in step with the path.
 */
export function isVoyage(index: ProvinceIndex, from: ProvinceId, to: ProvinceId): boolean {
  return index.isSeaLink(from, to) || !index.areAdjacent(from, to);
}

/**
 * Speed over water, in the same units the land march uses.
 *
 * The ship's speed, not the men's: a motorised division does not cross the
 * Mediterranean faster than a foot one. Ten knots is what a wartime convoy
 * made, which on this map's scale is about 440km a day -- a little over twice
 * the 210 a marching division covers.
 */
const NAVAL_TRANSPORT_KMH = 18;

/** True when any step of this route crosses water. */
function routeCrossesSea(ctx: MilitaryContext, from: ProvinceId, path: ProvinceId[]): boolean {
  let prev = from;
  for (const step of path) {
    if (isVoyage(ctx.index, prev, step)) return true;
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
    // A border is a wall unless there is a reason for it not to be. Checked on
    // the route as well as the destination: marching *through* a neutral is
    // the same trespass as stopping in one.
    blocked: (id) => !hasAccess(state, d.owner, id),
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

/**
 * Reasons a transfer by sea cannot be arranged.
 *
 * Named rather than boolean, because "it did not work" is not something a
 * player can act on and each of these has a different answer: march inland
 * first, take a harbour, or build some ships.
 */
export type TransportBlock =
  | 'ok'
  /** Nowhere on this side of the water to embark from. */
  | 'noPortHere'
  /** Nowhere at the far end to put in at. */
  | 'noPortThere'
  /** Both harbours are the same one, so this is a march. */
  | 'sameCoast'
  /** No hulls: a power with no dockyards and no convoys cannot lift anybody. */
  | 'noShipping'
  /** The destination cannot be reached on foot from the harbour that serves it. */
  | 'noRoad';

/**
 * Ships a division from one harbour to another.
 *
 * 「強襲上陸とは別に港を経由して移動できるように」. Three legs: march to the
 * quay, sail, march inland. Only the middle one is a voyage, and the route
 * stores it as a step between two provinces that do not touch -- which is
 * exactly what a voyage is, and is how the hourly tick recognises one without
 * having to be told.
 *
 * Distinct from an assault in both directions. A transfer may only put in at a
 * harbour we or an ally hold, so it cannot take ground; and because nobody is
 * shooting at the quay, the men walk off in the order they walked on.
 */
export function planTransport(
  state: GameState, index: ProvinceIndex, owner: CountryId,
  from: ProvinceId, target: ProvinceId,
): { block: TransportBlock; path: ProvinceId[] } {
  const no = (block: TransportBlock) => ({ block, path: [] as ProvinceId[] });
  if (target === from) return no('sameCoast');
  if (sealiftCapacity(state, owner) <= 0) return no('noShipping');

  const embark = nearestUsablePort(state, index, owner, from);
  if (embark === null) return no('noPortHere');
  const debark = nearestUsablePort(state, index, owner, target);
  if (debark === null) return no('noPortThere');
  // Same harbour at both ends: the two places are on one coast and the
  // division should walk. Saying so is more use than sailing it in a circle.
  if (embark === debark) return no('sameCoast');

  const land = (a: ProvinceId, b: ProvinceId): ProvinceId[] | null => {
    if (a === b) return [a];
    return index.path(a, b, {
      allowSea: false,
      blocked: (id) => !hasAccess(state, owner, id),
      cost: (id) => 1 / TERRAIN[index.get(id).terrain].speed,
    });
  };
  const toQuay = land(from, embark);
  if (!toQuay) return no('noPortHere');
  const inland = land(debark, target);
  if (!inland) return no('noRoad');

  // march ++ voyage ++ march. The first element of each leg is where the
  // previous one ended, so it is dropped.
  return { block: 'ok', path: [...toQuay.slice(1), debark, ...inland.slice(1)] };
}

export function orderTransport(
  state: GameState, ctx: MilitaryContext, d: Division, target: ProvinceId,
): TransportBlock {
  if (d.dead) return 'sameCoast';
  const { block, path } = planTransport(state, ctx.index, d.owner, d.provinceId, target);
  if (block !== 'ok') return block;
  d.path = path;
  d.moveProgress = 0;
  d.order = { kind: 'move', target };
  return 'ok';
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
  //
  // Every hour, not once the list passes some length. The threshold version
  // only swept at more than 64 open records, which never happens once a war
  // winds down, so ended battles accumulated and stayed: measured at the end
  // of a ten-year campaign, five combats had been sitting closed since 1942
  // with no live participant on either side, and mid-war the list carried
  // about thirty-three of them on any given day. Nothing reads an ended
  // combat -- findCombatAt and the invariants both skip them -- so this cost
  // no correctness, but it made state.combats useless as a measure of how
  // much fighting was going on, which is exactly what it was reached for.
  let live = 0;
  for (const c of state.combats) if (!c.ended) live++;
  if (live !== state.combats.length) {
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
      // Everything up to and including the province just taken, rather than
      // that province wherever it appears. Filtering could splice a hole in
      // the middle of a route, and a route with a hole in it now reads as a
      // voyage -- `isVoyage` calls any step between provinces that do not
      // touch a crossing by sea, because that is the only thing that produces
      // one.
      const taken = winner.path.indexOf(combat.province);
      if (taken >= 0) winner.path = winner.path.slice(taken + 1);
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

/**
 * Writes a capture into the ledger every open war keeps.
 *
 * The peace conference divides a beaten country by what each of the winners
 * actually did, and this is where "what it did" is measured. Victory points
 * rather than provinces, because a coalition partner who took the capital has
 * a different claim from one who took a fortnight of empty steppe.
 *
 * Kept here rather than in the diplomacy layer because that layer already
 * reaches into this one, and a capture is a thing the map does.
 */
function creditCapture(
  state: GameState, ctx: MilitaryContext,
  province: ProvinceId, from: CountryId, by: CountryId,
): void {
  if (from === by) return;
  const vp = ctx.index.get(province).vp;
  if (vp <= 0) return;
  for (const w of state.wars) {
    if (w.ended) continue;
    const asAttacker = w.attackers.includes(by);
    const asDefender = w.defenders.includes(by);
    if (!asAttacker && !asDefender) continue;
    const other = asAttacker ? w.defenders : w.attackers;
    if (!other.includes(from)) continue;
    if (!w.contribution) w.contribution = {};
    w.contribution[by] = (w.contribution[by] ?? 0) + vp;
  }
}

export function captureProvince(
  state: GameState, ctx: MilitaryContext, province: ProvinceId, by: CountryId,
): void {
  const p = state.provinces[province];
  if (p.controller === by) return;
  creditCapture(state, ctx, province, p.controller, by);
  p.controller = by;
  p.lastChangeHour = state.clock.totalHours;
  p.fortLevel = 0;

  // A state changes hands only when every one of its provinces does.
  const stateId = ctx.index.get(province).stateId;
  const members = ctx.index.data.states[stateId].provinces;
  if (members.every((id) => state.provinces[id].controller === by)) {
    const st = state.states[stateId];
    if (st.controller !== by) {
      st.controller = by;
      // Ground taken from someone else starts restive; ground you are taking
      // back is your own, and settles the moment you hold it.
      st.resistance = st.owner === by ? 0 : INITIAL_RESISTANCE;
    }
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
  // Mountain troops give back part of what the ground takes: the terrain
  // penalty is what they are trained against.
  const trained = tpl.battalions.length === 0 ? 0
    : tpl.battalions.filter((b) => b === 'mountaineers').length / tpl.battalions.length;
  const rough = geo.terrain === 'mountain' || geo.terrain === 'hills';
  const terrainSpeed = rough
    ? terrain.speed + (1 - terrain.speed) * trained
    : terrain.speed;
  const factor = Math.max(MIN_SPEED_FACTOR, terrainSpeed * infraFactor * supplyFactor);
  // A panzer general gets his armour moving faster than the book says, which
  // is the only thing the trait is famous for.
  const cmd = commandModifiers(state, d);
  const led = cmd.traits.has('panzer_leader')
    && tpl.battalions.some((b) => b === 'light_armor' || b === 'medium_armor')
    ? 1 + PANZER_LEADER_SPEED : 1;
  // A dry tank has to be pushed. Only formations that burn fuel feel this.
  const dry = fuelPenalty(tpl, state.countries[d.owner].economy.fuelRatio, DRY_SPEED);
  return tpl.speedKmh * factor * KM_PER_HOUR_SCALE * led * dry;
}

function advanceMovement(state: GameState, ctx: MilitaryContext, d: Division): void {
  if (d.path.length === 0) return;
  const tpl = effectiveTemplate(state, d.owner, templateOf(state, d));
  if (d.org < tpl.maxOrg * MIN_ORG_TO_MOVE || d.retreatCooldown > 0) return;

  const next = d.path[0];
  // The border may have closed since the order was given -- a war ended, an
  // ally left the bloc -- and a march that was legal on Monday is a trespass
  // on Tuesday. Stop at the frontier rather than walking through it.
  if (!hasAccess(state, d.owner, next)) {
    d.path = [];
    d.moveProgress = 0;
    d.order = { kind: 'defend' };
    return;
  }
  // Shipping is a live resource: a division waits on the quay until a hull is
  // free, which is what stops an entire army crossing in one tide.
  const crossing = isVoyage(ctx.index, d.provinceId, next);
  if (crossing && d.moveProgress === 0
      && sealiftInUse(state, ctx, d.owner) >= sealiftCapacity(state, d.owner)) {
    return;
  }
  const distance = Math.max(1, ctx.index.distance(d.provinceId, next));
  // A ship's speed over water, the division's own on land: a motorised
  // division does not cross the Mediterranean faster than a foot one.
  const kmThisHour = crossing ? NAVAL_TRANSPORT_KMH : movementSpeed(state, ctx, d, next);
  d.moveProgress += kmThisHour / distance;
  if (d.moveProgress < 1) return;

  d.moveProgress = 0;
  const controller = state.provinces[next].controller;
  // Ashore, and disorganised -- but only where somebody is holding the beach.
  // Without a penalty an amphibious assault would be strictly better than a
  // land attack, because it arrives where the enemy is not; applied to every
  // crossing, putting a corps down at one of our own quays wrecked it as
  // thoroughly as storming a defended shore. 「強襲上陸とは別に港を経由して
  // 移動できるように」: an assault is a landing under fire, a transfer is a
  // gangway, and only the first of them costs the men their order.
  if (crossing && isHostile(state, d.owner, controller)) {
    const tplNow = effectiveTemplate(state, d.owner, templateOf(state, d));
    // An officer who has done this before lands his men in better order.
    const practised = commandModifiers(state, d).traits.has('naval_invader')
      ? 1 + NAVAL_INVADER_ORG : 1;
    const kept = Math.min(
      0.9, LANDING_ORG_KEPT * techModifiers(state, d.owner).landingOrg * practised,
    );
    d.org = Math.min(d.org, tplNow.maxOrg * kept);
  }

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
/**
 * A day of digging, and a day of winter.
 *
 * Entrenchment grows a level a day while a division holds still and is not in
 * a battle -- men under fire are not improving their positions -- to a cap the
 * defensive-doctrine trait raises. Winter takes strength off anything standing
 * in the cold, which is the reason the date on the clock matters when you
 * choose to start something.
 */
export function tickConditionsDaily(
  state: GameState, index: ProvinceIndex,
): void {
  for (const d of state.divisions) {
    if (d.dead) continue;
    const mods = commandModifiers(state, d);

    if (d.combatId === null && d.path.length === 0) {
      const cap = MAX_ENTRENCHMENT * mods.entrenchment;
      d.entrenchment = Math.min(cap, d.entrenchment + 1);
    }

    let winter = winterSeverity(state, index, d.provinceId);
    if (winter > 0) {
      if (mods.traits.has('winter_specialist')) winter *= 1 - WINTER_SPECIALIST_RELIEF;
      const tpl = effectiveTemplate(state, d.owner, templateOf(state, d));
      const bite = WINTER_ATTRITION_PER_DAY * winter;
      d.hp = Math.max(0, d.hp - tpl.maxHp * bite);
      d.org = Math.max(0, d.org - tpl.maxOrg * bite * 0.5);
    }
  }
}

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
