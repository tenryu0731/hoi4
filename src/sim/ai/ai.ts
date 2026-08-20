import { EQUIPMENT } from '../core/data';
import { rand } from '../core/rng';
import type {
  Country, CountryId, Division, EquipmentType, GameState, Ideology, ProvinceId,
} from '../core/types';
import type { ProvinceIndex } from '../map/ProvinceIndex';
import {
  addProductionLine, canQueueBuilding, queueBuilding, setLineFactories,
} from '../economy/production';
import {
  areAllied, atWar, blocStrength, canDemand, declareWar, defendingStrength,
  DEMAND_COST, demandSubmission, guarantee, guarantorsOf, hasWarGoal, joinFaction,
  occupationRatio, opinionOf, startJustification,
} from '../diplomacy/diplomacy';
import { orderMove } from '../military/movement';
import { canChangeLaw, changeLaw } from '../politics/politics';
import { fuelRatio } from '../economy/fuel';
import { LAW_COST } from '../politics/lawData';
import { spawnDivision, TEMPLATE_ARMOUR, TEMPLATE_INFANTRY } from '../scenario/europe1936';
import {
  dateReached, doctrineFor, monthIndexOf, monthsSince, nowIndex,
  type Claim, type ClaimMethod, type Doctrine,
} from './doctrine';

/**
 * The AI opponent.
 *
 * Every country runs the same three brains -- economy, military, diplomacy --
 * and all of them act by calling exactly the code a human's commands call. That
 * is deliberate: a separate "AI path" is how strategy games end up with an
 * opponent that plays a different game from the player.
 *
 * Cost is controlled by staggering: heavy re-evaluation for a country happens
 * on one day of the week, so the per-tick budget stays flat no matter how many
 * countries are alive.
 */

export interface AIContext {
  index: ProvinceIndex;
}

/** Local superiority the AI wants before it commits to an attack. */
const ATTACK_RATIO = 1.35;
/** Below this organisation fraction a division is pulled back. */
const RETREAT_ORG = 0.25;
/**
 * Divisions a major power wants before it starts a war somebody will contest.
 *
 * The timetable in `doctrine.ts` says when a claim may be acted on; this says
 * whether there is an army to act with. Both are needed: the date alone sends
 * a peacetime army into Poland on schedule and loses it, and the army alone is
 * how the old AI ended up invading Norway in 1936 the moment it could.
 */
const WAR_READY_DIVISIONS = 40;
/** The same bar for a minor power, which cannot field anything like as many. */
const MINOR_WAR_READY_DIVISIONS = 8;
/** Divisions kept in the capital once the shooting starts. */
const CAPITAL_GARRISON = 3;
/**
 * Ceiling on the share of an army that may be tied down holding ground.
 *
 * Without a ceiling a nation with a long coast garrisons itself into paralysis
 * and the war never moves; without a floor under the offensive it never wins
 * one. Sixty per cent is the split that keeps both a front and a spearhead.
 */
const HOLD_FRACTION = 0.6;
/** Share of the spare army that may be committed to a landing overseas. */
const OVERSEAS_FRACTION = 0.25;
/**
 * How long a democracy dragged into a war by a guarantee stands on the
 * defensive before it attacks.
 *
 * This is the Phoney War, and without it the scenario cannot produce 1939.
 * France honoured its guarantee to Poland by declaring war and then not
 * advancing for eight months. An AI France that instead marches on the Rhine
 * the same week leaves Germany fighting two fronts from the first day of the
 * war, and the campaign measurably ends within weeks of the declaration
 * instead of running the length of the scenario.
 */
const PHONEY_WAR_DAYS = 240;
/** A matured war goal is abandoned after this many further days of inaction. */
const STALE_WAR_GOAL_DAYS = 240;
/**
 * How much stronger a coalition an aggressor will take on, by ideology.
 *
 * A single global value cannot produce this scenario. Set it low and nobody
 * ever attacks the Allies, so the war never happens; set it high and every
 * minor power throws itself at a great power. The period's aggressors were
 * genuinely reckless and its democracies genuinely cautious, so the AI models
 * that directly.
 */
const BOLDNESS: Record<Ideology, number> = {
  fascist: 1.7,
  communist: 1.1,
  neutral: 0.7,
  democratic: 0.6,
};
/**
 * How completely a new division must be equipped before it is raised.
 * Raising hollow formations wins nothing and burns the manpower that would have
 * made real ones.
 */
const MIN_EQUIPMENT_TO_RAISE = 0.6;

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------

/** Every equipment type this country's templates actually consume. */
function requiredEquipment(c: Country): Set<EquipmentType> {
  const out = new Set<EquipmentType>();
  for (const tpl of c.templates) {
    for (const eq of Object.keys(tpl.equipmentNeed) as EquipmentType[]) out.add(eq);
  }
  return out;
}

/** Fraction of new divisions the AI wants to be armoured. */
const ARMOUR_FRACTION = 0.2;
/** Share of industry reserved for aircraft, which no ground template consumes. */
/**
 * Share of industry spent on aircraft.
 *
 * Zero: fighters and CAS have no stats and there is no air layer to fly them
 * in, so anything above zero is every nation burning a tenth of its economy on
 * items that cannot affect a single battle.
 */
const AIR_SHARE = 0;

/**
 * Factory allocation, derived from what the army actually eats.
 *
 * Fixed percentage splits look reasonable and behave badly: whichever component
 * is under-funded becomes the binding constraint on every division, and the rest
 * of the industry piles up stock nobody can use. Weighting each line by the
 * production cost of that item per division keeps every component arriving in
 * the proportion the templates consume it.
 */
function desiredMix(c: Country): [EquipmentType, number][] {
  const infantry = c.templates.find((t) => t.id === TEMPLATE_INFANTRY);
  const armour = c.templates.find((t) => t.id === TEMPLATE_ARMOUR);

  const demand = new Map<EquipmentType, number>();
  const add = (tpl: typeof infantry, share: number) => {
    if (!tpl) return;
    for (const [eq, need] of Object.entries(tpl.equipmentNeed) as [EquipmentType, number][]) {
      demand.set(eq, (demand.get(eq) ?? 0) + need * EQUIPMENT[eq].cost * share);
    }
  };
  // Tanks a country cannot fuel are worse than the infantry it did not build:
  // they cost steel and rubber and then move at half speed. A country running
  // dry stops laying down armour until it has taken an oilfield.
  const armourShare = ARMOUR_FRACTION * fuelRatio(c);
  add(infantry, 1 - armourShare);
  add(armour, armourShare);

  // Anything a template needs but the calculation missed still gets a line.
  for (const eq of requiredEquipment(c)) {
    if (!demand.has(eq)) demand.set(eq, 1);
  }

  const total = [...demand.values()].reduce((a, b) => a + b, 0) || 1;
  const ground: [EquipmentType, number][] = [...demand].map(
    ([eq, v]) => [eq, (v / total) * (1 - AIR_SHARE)],
  );
  // Stable order so allocation does not depend on Map insertion history.
  ground.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return [...ground, ['fighter', AIR_SHARE]];
}

export function runEconomyAI(state: GameState, _ctx: AIContext, c: Country): void {
  if (c.capitulated) return;

  // --- production lines ---------------------------------------------------
  const mix = desiredMix(c);
  for (const [equipment] of mix) {
    if (!c.productionLines.some((l) => l.equipment === equipment)) {
      addProductionLine(state, c, equipment);
    }
  }
  const total = c.economy.militaryFactories;
  if (total > 0) {
    // Clear first so reallocation is not blocked by yesterday's assignment.
    for (const line of c.productionLines) line.assignedFactories = 0;

    let assigned = 0;
    // Essential items get a factory even when their share rounds to nothing;
    // producing zero of one component stops every division that needs it.
    const essential = requiredEquipment(c);
    for (let i = 0; i < mix.length; i++) {
      const [equipment, share] = mix[i];
      const line = c.productionLines.find((l) => l.equipment === equipment);
      if (!line) continue;
      const floor = essential.has(equipment) && total >= mix.length ? 1 : 0;
      const want = i === mix.length - 1
        ? Math.max(floor, total - assigned)
        : Math.max(floor, Math.round(total * share));
      setLineFactories(c, line.id, want);
      assigned += line.assignedFactories;
    }
  }

  // --- construction -------------------------------------------------------
  // Keep a shallow queue: a long one just locks the country into decisions it
  // made a year ago.
  if (c.constructionQueue.length >= 3) return;

  const fighting = c.atWarWith.length > 0;
  // Early on, civilian industry compounds; at war, guns win.
  const wantMilitary = fighting
    || c.economy.militaryFactories < c.economy.civilianFactories * 0.5;
  const kind = wantMilitary ? 'military_factory' : 'civilian_factory';

  let bestState = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < state.states.length; i++) {
    const st = state.states[i];
    if (st.controller !== c.id) continue;
    if (!canQueueBuilding(state, c, i, kind)) continue;
    // Prefer developed, safe states: infrastructure speeds the build and a
    // factory on the front line is a gift to the enemy.
    const score = st.infrastructure * 3 + st.manpowerPool / 5000
      - (st.owner === c.id ? 0 : 20);
    if (score > bestScore) { bestScore = score; bestState = i; }
  }
  if (bestState >= 0) queueBuilding(state, c, bestState, kind);
}

// ---------------------------------------------------------------------------
// Recruitment
// ---------------------------------------------------------------------------

export function runRecruitmentAI(state: GameState, _ctx: AIContext, c: Country): void {
  if (c.capitulated) return;
  const home = c.capital;
  if (state.provinces[home]?.controller !== c.id) return;

  // Armour every fifth division, but only if it can actually be equipped.
  // Keying the choice to the division count alone deadlocks: a country that
  // cannot afford a tank never raises the division that would move the count
  // past the armour slot, so it raises nothing at all, forever.
  const wantArmour = c.major && c.stats.divisionCount % 5 === 4
    && fuelRatio(c) > 0.5;
  const order = wantArmour
    ? [TEMPLATE_ARMOUR, TEMPLATE_INFANTRY]
    : [TEMPLATE_INFANTRY, TEMPLATE_ARMOUR];

  for (const templateId of order) {
    const tpl = c.templates.find((t) => t.id === templateId);
    if (!tpl) continue;
    if (c.economy.manpower < tpl.manpowerNeed / 1000) continue;

    let ratio = 1;
    for (const [eq, need] of Object.entries(tpl.equipmentNeed) as [EquipmentType, number][]) {
      ratio = Math.min(ratio, (c.economy.stockpile[eq] ?? 0) / need);
    }
    if (ratio < MIN_EQUIPMENT_TO_RAISE) continue;

    const equipped = Math.min(1, ratio);
    for (const [eq, need] of Object.entries(tpl.equipmentNeed) as [EquipmentType, number][]) {
      c.economy.stockpile[eq] = Math.max(0, (c.economy.stockpile[eq] ?? 0) - need * equipped);
    }
    c.economy.manpower -= tpl.manpowerNeed / 1000;
    spawnDivision(state, c.id, templateId, home, equipped);
    return;
  }
}

// ---------------------------------------------------------------------------
// Military
// ---------------------------------------------------------------------------

interface FrontTarget {
  province: ProvinceId;
  /** Enemy strength standing there. */
  defence: number;
  vp: number;
  /** Only reachable across water: an amphibious operation, not an advance. */
  overseas: boolean;
}

/**
 * Enemy-held provinces adjacent to something this country controls, separated
 * into ground the army can walk onto and ground it would have to land on.
 *
 * The distinction is the difference between a war and a farce. Treating a
 * strait as just another border makes Britain the softest, richest target in
 * Europe, and an AI Germany answers the Polish crisis by shipping thirty-four
 * divisions to England while France strolls into the Ruhr.
 */
function frontTargets(state: GameState, ctx: AIContext, c: Country): FrontTarget[] {
  const byLand = new Set<ProvinceId>();
  const bySea = new Set<ProvinceId>();
  for (let i = 0; i < state.provinces.length; i++) {
    if (state.provinces[i].controller !== c.id) continue;
    const geo = ctx.index.get(i);
    for (const nb of geo.neighbors) {
      if (c.atWarWith.includes(state.provinces[nb].controller)) byLand.add(nb);
    }
    for (const nb of geo.seaNeighbors) {
      if (c.atWarWith.includes(state.provinces[nb].controller)) bySea.add(nb);
    }
  }

  const out: FrontTarget[] = [];
  const add = (nb: ProvinceId, overseas: boolean) => {
    let defence = 0;
    for (const id of state.provinces[nb].divisions) {
      const d = state.divisions[id];
      if (!d || d.dead) continue;
      if (!c.atWarWith.includes(d.owner)) continue;
      const tpl = state.countries[d.owner].templates.find((t) => t.id === d.templateId);
      defence += tpl ? (tpl.defense * d.org) / Math.max(1, tpl.maxOrg) : 0;
    }
    out.push({ province: nb, defence, vp: state.provinces[nb].vp, overseas });
  };
  for (const nb of byLand) add(nb, false);
  for (const nb of bySea) if (!byLand.has(nb)) add(nb, true);
  out.sort((a, b) => a.province - b.province);
  return out;
}

function divisionPower(state: GameState, d: Division): number {
  const tpl = state.countries[d.owner].templates.find((t) => t.id === d.templateId);
  if (!tpl) return 0;
  return (tpl.softAttack + tpl.breakthrough) * (d.org / Math.max(1, tpl.maxOrg));
}

/**
 * Own ground an enemy can actually reach: across a land border, or off the sea.
 *
 * Leaving the sea out of this -- which is what the previous version did, while
 * happily attacking across it -- is why an AI Germany used to lose. It marched
 * its whole army into Poland, the Royal Navy put divisions ashore on an empty
 * North Sea coast, and Berlin fell to a country that had never crossed a land
 * border. A front is every edge the enemy can arrive over.
 */
function threatenedProvinces(state: GameState, ctx: AIContext, c: Country): ProvinceId[] {
  const out: ProvinceId[] = [];
  for (let i = 0; i < state.provinces.length; i++) {
    if (state.provinces[i].controller !== c.id) continue;
    const geo = ctx.index.get(i);
    const reachable = geo.neighbors.some(
      (n) => c.atWarWith.includes(state.provinces[n].controller),
    ) || geo.seaNeighbors.some(
      (n) => c.atWarWith.includes(state.provinces[n].controller),
    );
    if (reachable) out.push(i);
  }
  return out;
}

/**
 * Friendly divisions holding a province that cannot be reassigned anyway --
 * they are locked in a battle for it.
 *
 * Counting the free ones here as well is what used to empty the country: a
 * garrison standing on its own border satisfied the requirement, was therefore
 * never claimed, and marched off with the offensive the same afternoon. Cover
 * has to be spent, not observed.
 */
function committedGarrison(state: GameState, c: Country, province: ProvinceId): number {
  let n = 0;
  for (const id of state.provinces[province].divisions) {
    const d = state.divisions[id];
    if (d && !d.dead && d.owner === c.id && d.combatId !== null) n++;
  }
  return n;
}

/** How many divisions the AI wants standing on a piece of ground it means to keep. */
function requiredGarrison(state: GameState, c: Country, province: ProvinceId): number {
  if (province === c.capital) return CAPITAL_GARRISON;
  return state.provinces[province].vp >= 10 ? 2 : 1;
}

/**
 * Whether this country is fighting a war it has no intention of prosecuting yet.
 *
 * A democracy that declared only because a guarantee obliged it, and whose own
 * soil is untouched, mans its border and waits. It is what the period's
 * democracies actually did, and it is the breathing space the aggressor's whole
 * timetable depends on.
 */
function standingOnTheDefensive(state: GameState, c: Country): boolean {
  if (c.ideology !== 'democratic') return false;
  if (occupationRatio(state, c.id) > 0.01) return false;
  // Dated from the first war it was dragged into, not the most recent: a
  // country that has been fighting for two years does not get another eight
  // months of quiet because somebody declared on it again.
  let joined = Infinity;
  for (const w of state.wars) {
    if (w.ended) continue;
    if (w.attackers.includes(c.id)) return false;   // its own war: fight it
    if (w.defenders.includes(c.id)) joined = Math.min(joined, w.startDay);
  }
  if (joined === Infinity) return false;
  return state.clock.totalDays - joined < PHONEY_WAR_DAYS;
}

export function runMilitaryAI(state: GameState, ctx: AIContext, c: Country): void {
  if (c.capitulated) return;

  const available = state.divisions.filter(
    (d) => !d.dead && d.owner === c.id && d.combatId === null,
  );
  if (available.length === 0) return;

  if (c.atWarWith.length === 0) {
    // At peace, spread out so the borders are not naked when war comes.
    garrisonBorders(state, ctx, c, available);
    return;
  }

  // --- 1. hold the line ----------------------------------------------------
  // A country that throws every division at an offensive leaves its own front
  // wide open, and the war turns into two armies walking past each other into
  // each other's undefended capitals. Cover what can be reached first, attack
  // with what is left over -- and never spend more than HOLD_FRACTION of the
  // army standing still, or the front freezes and nothing is ever decided.
  const cover = threatenedProvinces(state, ctx, c);
  if (state.provinces[c.capital]?.controller === c.id && !cover.includes(c.capital)) {
    cover.push(c.capital);
  }
  cover.sort((a, b) => {
    if (a === c.capital) return -1;
    if (b === c.capital) return 1;
    return state.provinces[b].vp - state.provinces[a].vp || a - b;
  });

  const unassigned = new Set(available.map((d) => d.id));
  let budget = Math.max(1, Math.round(available.length * HOLD_FRACTION));

  for (const province of cover) {
    if (budget <= 0) break;
    let need = requiredGarrison(state, c, province) - committedGarrison(state, c, province);
    while (need > 0 && budget > 0) {
      let best: Division | null = null;
      let bestDist = Infinity;
      for (const d of available) {
        if (!unassigned.has(d.id)) continue;
        const dist = ctx.index.distance(d.provinceId, province);
        if (dist < bestDist) { bestDist = dist; best = d; }
      }
      if (!best) { budget = 0; break; }
      unassigned.delete(best.id);
      budget--;
      need--;
      if (best.provinceId === province) {
        best.path = [];
        best.order = { kind: 'defend' };
        continue;
      }
      // Re-order only when it is not already on its way here. Reissuing the
      // same move every day resets the leg it is part-way through, and a
      // division that restarts its march each morning never arrives; leaving a
      // busy division alone entirely is worse still, because it counts against
      // the cover budget while walking in the opposite direction.
      const heading = best.order?.kind === 'move' ? best.order.target : null;
      if (heading !== province) orderMove(state, ctx, best, province);
    }
  }

  // --- 2. attack with the surplus -----------------------------------------
  const spare = available.filter((d) => unassigned.has(d.id));
  if (spare.length === 0) return;
  if (standingOnTheDefensive(state, c)) {
    for (const d of spare) {
      if (d.path.length > 0) continue;
      d.order = { kind: 'defend' };
    }
    return;
  }

  const targets = frontTargets(state, ctx, c);
  if (targets.length === 0) {
    const enemyCapital = c.atWarWith
      .map((id) => state.countries[id])
      .filter((e) => !e.capitulated)
      .map((e) => e.capital)[0];
    if (enemyCapital !== undefined) {
      for (const d of spare) if (d.path.length === 0) orderMove(state, ctx, d, enemyCapital);
    }
    return;
  }

  // Value a target by what it is worth and how lightly it is held.
  targets.sort((a, b) => (b.vp / (1 + b.defence)) - (a.vp / (1 + a.defence)));
  // A landing is a fraction of the army or it is not a landing, it is an
  // evacuation of the home front.
  let overseasBudget = Math.floor(spare.length * OVERSEAS_FRACTION);

  for (const d of spare) {
    const tpl = c.templates.find((t) => t.id === d.templateId);
    const orgFraction = tpl ? d.org / Math.max(1, tpl.maxOrg) : 1;

    if (orgFraction < RETREAT_ORG) {
      // Spent: hold where it is and recover rather than feed it in piecemeal.
      d.path = [];
      d.order = { kind: 'defend' };
      continue;
    }
    if (d.path.length > 0) continue;

    let chosen: FrontTarget | null = null;
    let chosenDistance = Infinity;
    for (const t of targets) {
      if (t.overseas && overseasBudget <= 0) continue;
      const dist = ctx.index.distance(d.provinceId, t.province);
      const power = divisionPower(state, d) * ATTACK_RATIO;
      // Attack when locally strong, otherwise close up and wait.
      if (power < t.defence && t.defence > 0) continue;
      if (dist < chosenDistance) { chosen = t; chosenDistance = dist; }
    }
    if (!chosen) {
      d.path = [];
      d.order = { kind: 'defend' };
      continue;
    }
    if (chosen.overseas) overseasBudget--;
    orderMove(state, ctx, d, chosen.province);
  }
}

/** Peacetime posture: one division per border province, rest at the capital. */
function garrisonBorders(
  state: GameState, ctx: AIContext, c: Country, mine: Division[],
): void {
  const borders: ProvinceId[] = [];
  for (let i = 0; i < state.provinces.length; i++) {
    if (state.provinces[i].controller !== c.id) continue;
    const geo = ctx.index.get(i);
    if (geo.neighbors.some((n) => state.provinces[n].controller !== c.id)) borders.push(i);
  }
  if (borders.length === 0) return;
  mine.forEach((d, i) => {
    if (d.path.length > 0) return;
    const target = borders[i % borders.length];
    if (d.provinceId !== target) orderMove(state, ctx, d, target);
  });
}

// ---------------------------------------------------------------------------
// Diplomacy
// ---------------------------------------------------------------------------

/**
 * The diplomatic brain reads `doctrine.ts` and nothing else for intent.
 *
 * The rule it replaces scored every neighbour by victory points over strength
 * and attacked the winner. That is a perfectly good greedy heuristic and it
 * produces a campaign in which the Soviet Union invades Norway in 1936, because
 * Norway genuinely is the best-value target on the board. What follows instead
 * asks a different question -- "what does this country want, and is it time
 * yet?" -- and only then checks whether the arithmetic supports it.
 */

/** Members a faction may hold while Europe is still at peace. */
const PEACETIME_FACTION_CAP = 3;
/** And once a general war is under way and neutrality has stopped paying. */
const WARTIME_FACTION_CAP = 7;
/** Opinion a neutral needs of a bloc leader before it will sign on its own. */
const JOIN_OPINION = 55;
/** World tension below which nobody signs anything on their own initiative. */
const JOIN_TENSION = 70;
/** Guarantees one power will carry at once. */
const MAX_GUARANTEES = 8;
/** Days between one power's declarations of war while it is already fighting. */
const SECOND_FRONT_INTERVAL = 200;
/** How far a bloc must outweigh a victim before a mere member may attack it. */
const MEMBER_MARGIN = 4;

/**
 * Tag to country id, cached per state. Tags never change, and this is on the
 * weekly path for every country in Europe.
 */
const TAG_INDEX = new WeakMap<GameState, Map<string, CountryId>>();

function idOfTag(state: GameState, tag: string): CountryId | null {
  let map = TAG_INDEX.get(state);
  if (!map) {
    map = new Map(state.countries.map((c) => [c.tag, c.id]));
    TAG_INDEX.set(state, map);
  }
  return map.get(tag) ?? null;
}

/** True once two great powers stand on opposite sides of a war still being fought. */
function generalWarUnderway(state: GameState): boolean {
  for (const w of state.wars) {
    if (w.ended) continue;
    const live = (ids: CountryId[]) => ids.some(
      (id) => state.countries[id].major && !state.countries[id].capitulated,
    );
    if (live(w.attackers) && live(w.defenders)) return true;
  }
  return false;
}

/**
 * How many months ahead of its own timetable a country runs.
 *
 * Temperament is drawn once per seed at scenario start, so the table gives a
 * March 1938 Anschluss in one campaign and a June one in the next without any
 * of the dates being random.
 */
function scheduleOffset(c: Country): number {
  return Math.round((1 - c.aggression) * 8);
}

/** Months a claim has been actionable; negative while its date is still ahead. */
function claimOverdue(state: GameState, c: Country, claim: Claim): number {
  return monthsSince(state.clock, claim.from) - scheduleOffset(c);
}

/** Anything this country's territory touches, by land or by a short crossing. */
function neighbourCountries(state: GameState, ctx: AIContext, c: Country): Set<CountryId> {
  const out = new Set<CountryId>();
  const mine = c.factionId !== null ? state.factions[c.factionId].members : [c.id];
  const bloc = new Set(mine);
  for (let i = 0; i < state.provinces.length; i++) {
    if (!bloc.has(state.provinces[i].controller)) continue;
    const geo = ctx.index.get(i);
    for (const nb of geo.neighbors) {
      const owner = state.provinces[nb].controller;
      if (!bloc.has(owner)) out.add(owner);
    }
    for (const nb of geo.seaNeighbors) {
      const owner = state.provinces[nb].controller;
      if (!bloc.has(owner)) out.add(owner);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guarantees
// ---------------------------------------------------------------------------

/**
 * The democracies' whole strategy, and the mechanism the war turns on.
 *
 * A guarantee drags the guarantor and its bloc into the victim's war, and the
 * aggressor prices that in before it moves. That is what makes Poland in 1939 a
 * European war rather than a border campaign -- and what makes the same AI
 * leave Austria and Czechoslovakia alone, because nobody underwrote them.
 */
function maintainGuarantees(state: GameState, c: Country, doc: Doctrine): void {
  if (!doc.protects || c.atWarWith.length > 0) return;
  if (c.diplomacy.guarantees.length >= MAX_GUARANTEES) return;
  // Deliberately not gated on world tension as well. The dates in the table are
  // already the schedule -- they are the moment each promise was actually made
  // -- and a second, hidden schedule made of a decaying tension number is how
  // the guarantee to Poland ends up landing a fortnight after the invasion.

  for (const p of doc.protects) {
    if (!dateReached(state.clock, p.from)) continue;
    const target = idOfTag(state, p.target);
    if (target === null) continue;
    const t = state.countries[target];
    if (t.capitulated || t.factionId !== null) continue;
    if (areAllied(state, c.id, target) || atWar(state, c.id, target)) continue;
    if (c.diplomacy.guarantees.includes(target)) continue;
    if (guarantee(state, c.id, target)) return;   // one a week; they are not free
  }
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/** Whether a bloc still looks like the winning side to an outsider. */
function blocIsHolding(state: GameState, leader: CountryId): boolean {
  const own = blocStrength(state, leader);
  let enemy = 0;
  const members = state.countries[leader].factionId !== null
    ? state.factions[state.countries[leader].factionId!].members
    : [leader];
  const counted = new Set<CountryId>();
  for (const m of members) {
    for (const e of state.countries[m].atWarWith) {
      if (counted.has(e) || state.countries[e].capitulated) continue;
      counted.add(e);
      enemy += state.countries[e].stats.militaryStrength;
    }
  }
  return own * 1.5 >= enemy;
}

/**
 * Which bloc, if any, this country signs up to.
 *
 * Two routes in, and the difference is the point. A nation the table names
 * joins its historical patron on its historical date. Everybody else needs a
 * genuine reason -- shared politics, a shared border, real warmth, and a Europe
 * already on fire -- and even then the bloc has a size limit, because a
 * twelve-member alliance assembled in peacetime is not a diplomatic system, it
 * is a scoring function with no brakes.
 */
function considerAlignment(
  state: GameState, ctx: AIContext, c: Country, doc: Doctrine,
): void {
  if (c.factionId !== null || c.atWarWith.length > 0) return;

  if (doc.aligns && dateReached(state.clock, doc.aligns.from)) {
    const leader = idOfTag(state, doc.aligns.leader);
    if (leader !== null && !state.countries[leader].capitulated) {
      const factionId = state.countries[leader].factionId;
      if (factionId !== null && state.factions[factionId].leader === leader
        && blocIsHolding(state, leader)) {
        joinFaction(state, c.id, factionId);
        return;
      }
    }
  }

  if (state.worldTension < JOIN_TENSION) return;
  const cap = generalWarUnderway(state) ? WARTIME_FACTION_CAP : PEACETIME_FACTION_CAP;
  const neighbours = neighbourCountries(state, ctx, c);

  let bestFaction = -1;
  let bestScore = 0;
  for (const faction of state.factions) {
    if (faction.members.length >= cap || faction.members.length === 0) continue;
    const leader = state.countries[faction.leader];
    if (leader.capitulated || leader.id === c.id) continue;
    // Ideology and proximity, not raw size: Sweden does not join a bloc it
    // shares neither politics nor a border with, however rich that bloc is.
    if (leader.ideology !== c.ideology) continue;
    if (!faction.members.some((m) => neighbours.has(m))) continue;
    if (!blocIsHolding(state, leader.id)) continue;
    const score = opinionOf(state, c.id, leader.id);
    if (score >= JOIN_OPINION && score > bestScore) { bestScore = score; bestFaction = faction.id; }
  }
  if (bestFaction >= 0) joinFaction(state, c.id, bestFaction);
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * Whether a war against this target is one the aggressor's bloc could plausibly
 * fight -- counting the guarantors, and counting whoever it is already fighting.
 *
 * A power that has been staring at the same claim for two years talks itself
 * into it: the multiplier grows with how overdue the claim is, which is both
 * how 1939 actually happened and the reason this AI cannot stall forever.
 */
function warIsWinnable(
  state: GameState, c: Country, target: CountryId, overdueMonths: number,
): boolean {
  let boldness = BOLDNESS[c.ideology] * c.aggression;
  boldness *= 1 + Math.min(1, Math.max(0, overdueMonths) / 24);

  let opposing = defendingStrength(state, target, c.id);
  // A second front is added to the bill, not ignored.
  const counted = new Set<CountryId>([target]);
  for (const e of c.atWarWith) {
    if (counted.has(e) || state.countries[e].capitulated) continue;
    counted.add(e);
    opposing += state.countries[e].stats.militaryStrength;
  }
  return blocStrength(state, c.id) * boldness >= opposing;
}

/** Whether this country is free to open a war right now at all. */
function mayOpenWar(state: GameState, c: Country): boolean {
  if (c.atWarWith.length === 0) return true;
  // Already fighting: only a power whose own soil is clear, and which has had
  // time to digest its last conquest, opens another front.
  if (occupationRatio(state, c.id) > 0.02) return false;
  let last = -Infinity;
  for (const w of state.wars) {
    if (w.attackers.includes(c.id)) last = Math.max(last, w.startDay);
  }
  return state.clock.totalDays - last >= SECOND_FRONT_INTERVAL;
}

interface Intent {
  target: CountryId;
  method: ClaimMethod;
  overdue: number;
}

/**
 * The next thing this country wants, from its own table.
 *
 * Claims are read in the order they are written, and the first one whose date
 * has come and whose arithmetic works is the one pursued -- so Germany does not
 * skip Poland for a softer neighbour, but it will move on if Poland has become
 * impossible.
 */
function nextIntent(
  state: GameState, ctx: AIContext, c: Country, doc: Doctrine,
): Intent | null {
  if (!doc.claims) return null;
  const neighbours = neighbourCountries(state, ctx, c);
  const majorWarAllowed = !doc.majorWarFrom || dateReached(state.clock, doc.majorWarFrom);

  for (const claim of doc.claims) {
    const overdue = claimOverdue(state, c, claim);
    if (overdue < 0) continue;
    const target = idOfTag(state, claim.target);
    if (target === null) continue;
    const t = state.countries[target];
    if (t.capitulated) continue;
    if (areAllied(state, c.id, target) || atWar(state, c.id, target)) continue;
    if (t.major && !majorWarAllowed) continue;

    // An ultimatum needs no army and no border -- only isolation on the other
    // side of the table. A claim written as a demand is never escalated into a
    // war of its own: if the victim has found a protector, the claim simply
    // stands. That single rule is the difference between the Soviet Union
    // taking Bessarabia in 1940 and the Soviet Union declaring war on the
    // British Empire over it.
    if (claim.method === 'demand') {
      if (!canDemand(state, c.id, target)) continue;
      if (c.economy.politicalPower < DEMAND_COST) return null;
      return { target, method: 'demand', overdue };
    }
    // A war needs somewhere to march from.
    if (!neighbours.has(target)) continue;
    if (!mayOpenWar(state, c)) continue;
    if (!warIsWinnable(state, c, target, overdue)) continue;
    return { target, method: 'war', overdue };
  }
  return null;
}

/**
 * Late-campaign opportunism.
 *
 * The table runs out, and a scenario in which the surviving powers then sit
 * still until 1948 is not one that resolves. This is the old greedy search with
 * its worst instinct removed: value no longer outranks everything, so the
 * choice falls on a weak, adjacent, ideologically hostile neighbour rather than
 * on whichever country happens to hold the most cities.
 */
function pickOpportunisticTarget(
  state: GameState, ctx: AIContext, c: Country,
): CountryId | null {
  let best: CountryId | null = null;
  let bestScore = 0;
  for (const id of [...neighbourCountries(state, ctx, c)].sort((a, b) => a - b)) {
    const t = state.countries[id];
    if (t.capitulated || id === c.id) continue;
    if (areAllied(state, c.id, id) || atWar(state, c.id, id)) continue;
    if (!warIsWinnable(state, c, id, 0)) continue;

    let score = blocStrength(state, c.id) / defendingStrength(state, id, c.id);
    if (t.ideology === c.ideology) score *= 0.3;
    if (t.factionId !== null) score *= 0.5;
    // Worth something, but not worth walking past three easier wars for.
    score *= 1 + Math.min(1, t.stats.victoryPoints / 300);
    score *= 0.7 + rand(state.rng) * 0.6;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}

/** Drops war goals that events have overtaken. */
function pruneJustifications(state: GameState, c: Country): void {
  c.diplomacy.justifications = c.diplomacy.justifications.filter((j) => {
    const t = state.countries[j.target];
    if (t.capitulated || areAllied(state, c.id, j.target)) return false;
    if (atWar(state, c.id, j.target)) return false;
    // A case that has sat ready for the best part of a year is a case against
    // the wrong country; dropping it lets the AI re-target.
    return j.progress < j.required + STALE_WAR_GOAL_DAYS;
  });
}

export function runDiplomacyAI(state: GameState, ctx: AIContext, c: Country): void {
  if (c.capitulated) return;
  const doc = doctrineFor(c.tag);

  maintainGuarantees(state, c, doc);
  considerAlignment(state, ctx, c, doc);
  pruneJustifications(state, c);

  const faction = c.factionId !== null ? state.factions[c.factionId] : null;
  const isLeader = faction !== null && faction.leader === c.id;
  // Inside a bloc the leader speaks for everyone, with one exception: a member
  // may still collect its own small claims, because Italy taking Albania is
  // exactly the sort of thing the period is made of. It may not pick a fight
  // with a great power -- that decision belongs to the bloc.
  const memberActing = faction !== null && !isLeader;

  // --- act on a war goal that has matured ---------------------------------
  for (const j of c.diplomacy.justifications) {
    if (!hasWarGoal(state, c.id, j.target)) continue;
    if (memberActing && !memberMayAttack(state, c, j.target)) continue;
    if (!mayOpenWar(state, c)) return;
    if (!readyForWar(state, c, j.target, doc)) return;
    // The months of case-building may have changed the odds: the target could
    // have found a guarantor, or rearmed.
    if (!warIsWinnable(state, c, j.target, warGoalOverdue(state, c, doc, j.target))) return;
    declareWar(state, c.id, j.target);
    return;
  }
  if (c.diplomacy.justifications.length > 0) return;

  // --- otherwise pick up the next claim -----------------------------------
  let intent = nextIntent(state, ctx, c, doc);
  if (intent && memberActing && !memberMayAttack(state, c, intent.target)) intent = null;
  if (!intent && !memberActing && canBeOpportunistic(state, c, doc)) {
    const target = pickOpportunisticTarget(state, ctx, c);
    if (target !== null && mayOpenWar(state, c)) intent = { target, method: 'war', overdue: 0 };
  }
  if (!intent) return;

  if (intent.method === 'demand') {
    if (!demandSubmission(state, ctx, c.id, intent.target)) {
      // Refused. The claim stands; it will have to be taken by force.
      startJustification(state, c.id, intent.target);
    }
    return;
  }
  if (!readyForWar(state, c, intent.target, doc)) return;
  startJustification(state, c.id, intent.target);
}

/**
 * Whether a bloc member may start this war on its own account.
 *
 * Every declaration drags the whole faction in, so a member is allowed only the
 * wars its allies would not mind inheriting: never against a great power, and
 * never against anyone the bloc does not overwhelm.
 */
function memberMayAttack(state: GameState, c: Country, target: CountryId): boolean {
  if (state.countries[target].major) return false;
  return blocStrength(state, c.id) >= defendingStrength(state, target, c.id) * MEMBER_MARGIN;
}

/** Months the standing war goal has been overdue, for the boldness ramp. */
function warGoalOverdue(
  state: GameState, c: Country, doc: Doctrine, target: CountryId,
): number {
  const tag = state.countries[target].tag;
  const claim = doc.claims?.find((x) => x.target === tag);
  return claim ? claimOverdue(state, c, claim) : 0;
}

/**
 * The army a country wants before it starts a war it expects to be a war.
 *
 * A soft target that nobody underwrites needs no build-up; a target with a
 * great power behind it does. One flat bar for both is how a great power ends
 * up spending six years arming before it will move on anybody at all.
 */
function readyForWar(
  state: GameState, c: Country, target: CountryId, doc: Doctrine,
): boolean {
  const t = state.countries[target];
  const serious = t.major
    || guarantorsOf(state, target, c.id).some((g) => state.countries[g].major)
    || t.factionId !== null;
  if (!serious) return c.stats.divisionCount >= MINOR_WAR_READY_DIVISIONS;
  const patience = doc.patience ?? 1;
  const bar = (c.major ? WAR_READY_DIVISIONS : MINOR_WAR_READY_DIVISIONS * 2)
    * patience / c.aggression;
  return c.stats.divisionCount >= bar;
}

/** Whether a power has earned the right to improvise once its table is empty. */
function canBeOpportunistic(state: GameState, c: Country, doc: Doctrine): boolean {
  if (c.ideology === 'democratic' || c.ideology === 'neutral') return false;
  if (!c.major && c.factionId === null) return false;
  // Only once the timetable is exhausted, and only late.
  if (nowIndex(state.clock) < monthIndexOf('1942-01')) return false;
  if (!doc.claims) return c.major;
  return doc.claims.every((claim) => {
    const id = idOfTag(state, claim.target);
    return id === null || state.countries[id].capitulated
      || areAllied(state, c.id, id) || atWar(state, c.id, id);
  });
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Runs the AI for the countries whose turn it is today.
 *
 * Economy and recruitment run daily because they are cheap and their cadence is
 * daily anyway. The expensive passes -- retargeting every division, re-reading
 * the diplomatic board -- are spread across the week by country id, except for
 * countries actively at war, which cannot afford to think once a week.
 */
export function tickAIDaily(state: GameState, ctx: AIContext): void {
  const dayOfWeek = state.clock.dayOfWeek;
  for (const c of state.countries) {
    if (c.capitulated || !c.isAI) continue;

    aiMobilise(state, c);
    runEconomyAI(state, ctx, c);
    runRecruitmentAI(state, ctx, c);

    const atWar = c.atWarWith.length > 0;
    if (atWar || c.id % 7 === dayOfWeek) {
      runMilitaryAI(state, ctx, c);
    }
    if (c.id % 7 === dayOfWeek) {
      runDiplomacyAI(state, ctx, c);
    }
  }
}

/**
 * Mobilisation.
 *
 * Without this the laws would be a mechanic only the human player has, and a
 * player who moves to a war economy in 1937 would out-build an AI frozen on
 * civilian economy for the whole campaign. The AI does not plan: it takes the
 * next step whenever it can afford one and the gates allow it, which is what
 * a country under pressure actually does.
 *
 * Political power is kept for laws only above a floor, so passing them never
 * starves the diplomacy the AI also needs power for.
 */
const AI_LAW_RESERVE = 60;

/**
 * Manpower in the bank, in thousands, below which a country starts reaching
 * for a harder conscription law.
 *
 * Conscription is not free industry: the top of that ladder takes 35% of the
 * workforce off the factory floor and a third of the country's stability with
 * it. A country with men to spare that keeps climbing anyway ends up with a
 * large army it cannot equip, which is what an AI taking every step it could
 * afford actually produced -- by 1940 every nation in Europe sat on identical
 * maximum laws at minimum stability.
 */
const MANPOWER_COMFORT = 250;

export function aiMobilise(state: GameState, c: Country): void {
  if (c.capitulated) return;
  if (c.economy.politicalPower < LAW_COST + AI_LAW_RESERVE) return;

  // Industry first and always: factories compound, and the penalties are small.
  if (canChangeLaw(state, c, 'economy', 1).allowed) {
    changeLaw(state, c.id, 'economy', 1);
    return;
  }
  // Men only when short of them. Running out is what justifies the cost.
  if (c.economy.manpower < MANPOWER_COMFORT
    && canChangeLaw(state, c, 'conscription', 1).allowed) {
    changeLaw(state, c.id, 'conscription', 1);
  }
}
