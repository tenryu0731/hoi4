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
  declareWar, hasWarGoal, joinFaction, opinionOf, startJustification,
} from '../diplomacy/diplomacy';
import { orderMove } from '../military/movement';
import { spawnDivision, TEMPLATE_ARMOUR, TEMPLATE_INFANTRY } from '../scenario/europe1936';

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
 * Divisions a major power wants before it starts a war.
 *
 * Set too low, the Axis attacks in 1937 with a peacetime army and is gone
 * inside eighteen months. A great power needs time to convert its industry
 * into an army first, which is what the historical build-up years were for.
 */
const WAR_READY_DIVISIONS = 42;
/** The same bar for a minor power, which cannot field anything like as many. */
const MINOR_WAR_READY_DIVISIONS = 10;
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
const AIR_SHARE = 0.09;

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
  add(infantry, 1 - ARMOUR_FRACTION);
  add(armour, ARMOUR_FRACTION);

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

  const atWar = c.atWarWith.length > 0;
  // Early on, civilian industry compounds; at war, guns win.
  const wantMilitary = atWar || c.economy.militaryFactories < c.economy.civilianFactories * 0.5;
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
  const wantArmour = c.major && c.stats.divisionCount % 5 === 4;
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
}

/** Enemy-held provinces adjacent to something this country controls. */
function frontTargets(state: GameState, ctx: AIContext, c: Country): FrontTarget[] {
  const seen = new Set<ProvinceId>();
  const out: FrontTarget[] = [];
  for (let i = 0; i < state.provinces.length; i++) {
    if (state.provinces[i].controller !== c.id) continue;
    const geo = ctx.index.get(i);
    for (const nb of [...geo.neighbors, ...geo.seaNeighbors]) {
      if (seen.has(nb)) continue;
      const controller = state.provinces[nb].controller;
      if (!c.atWarWith.includes(controller)) continue;
      seen.add(nb);
      let defence = 0;
      for (const id of state.provinces[nb].divisions) {
        const d = state.divisions[id];
        if (!d || d.dead) continue;
        if (!c.atWarWith.includes(d.owner)) continue;
        const tpl = state.countries[d.owner].templates.find((t) => t.id === d.templateId);
        defence += tpl ? (tpl.defense * d.org) / Math.max(1, tpl.maxOrg) : 0;
      }
      out.push({ province: nb, defence, vp: state.provinces[nb].vp });
    }
  }
  return out;
}

function divisionPower(state: GameState, d: Division): number {
  const tpl = state.countries[d.owner].templates.find((t) => t.id === d.templateId);
  if (!tpl) return 0;
  return (tpl.softAttack + tpl.breakthrough) * (d.org / Math.max(1, tpl.maxOrg));
}

/** Own provinces that touch enemy-held ground. */
function ownFrontProvinces(state: GameState, ctx: AIContext, c: Country): ProvinceId[] {
  const out: ProvinceId[] = [];
  for (let i = 0; i < state.provinces.length; i++) {
    if (state.provinces[i].controller !== c.id) continue;
    const geo = ctx.index.get(i);
    const touchesEnemy = geo.neighbors.some(
      (n) => c.atWarWith.includes(state.provinces[n].controller),
    );
    if (touchesEnemy) out.push(i);
  }
  return out;
}

/** Friendly divisions currently standing in a province. */
function garrisonStrength(state: GameState, c: Country, province: ProvinceId): number {
  let n = 0;
  for (const id of state.provinces[province].divisions) {
    const d = state.divisions[id];
    if (d && !d.dead && d.owner === c.id) n++;
  }
  return n;
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
  // each other's undefended capitals. Cover the front first, attack with what
  // is left over.
  const front = ownFrontProvinces(state, ctx, c);
  const unassigned = new Set(available.map((d) => d.id));
  const needsCover = front
    .filter((p) => garrisonStrength(state, c, p) < 1)
    .sort((a, b) => state.provinces[b].vp - state.provinces[a].vp);

  for (const province of needsCover) {
    let best: Division | null = null;
    let bestDist = Infinity;
    for (const d of available) {
      if (!unassigned.has(d.id)) continue;
      const dist = ctx.index.distance(d.provinceId, province);
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    if (!best) break;
    unassigned.delete(best.id);
    if (best.provinceId === province) {
      best.path = [];
      best.order = { kind: 'defend' };
    } else if (best.path.length === 0) {
      orderMove(state, ctx, best, province);
    }
  }

  // --- 2. attack with the surplus -----------------------------------------
  const spare = available.filter((d) => unassigned.has(d.id));
  if (spare.length === 0) return;

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

export function runDiplomacyAI(state: GameState, ctx: AIContext, c: Country): void {
  if (c.capitulated) return;

  // --- neutrals pick a side as the world heats up -------------------------
  // The bar is deliberately high. A low threshold makes every minor pile into
  // a bloc within a week of the first shot, which turns any local war into a
  // continental one before anybody has an army.
  if (c.factionId === null && c.atWarWith.length === 0 && state.worldTension > 55) {
    let bestFaction = -1;
    let bestScore = 45;
    for (const faction of state.factions) {
      const leader = state.countries[faction.leader];
      if (leader.capitulated || leader.id === c.id) continue;
      let score = opinionOf(state, c.id, leader.id);
      if (leader.ideology === c.ideology) score += 30;
      // Nobody joins a side that is visibly losing.
      score += Math.min(30, leader.stats.militaryStrength / 400);
      if (score > bestScore) { bestScore = score; bestFaction = faction.id; }
    }
    if (bestFaction >= 0) {
      joinFaction(state, c.id, bestFaction);
      return;
    }
  }

  // --- expansionists start wars -------------------------------------------
  // Faction leaders drive their bloc's strategy; fascist states are aggressive
  // on their own account. Everyone else waits to be attacked.
  const isLeader = c.factionId !== null && state.factions[c.factionId].leader === c.id;
  // Inside a bloc, only the leader speaks. Otherwise a minor member starts a
  // war of its own and its allies inherit it.
  if (c.factionId !== null && !isLeader) return;
  if (!isLeader && c.ideology !== 'fascist') return;
  if (c.ideology === 'democratic' && state.worldTension < 50) return;
  // A minor power needs an army before it goes looking for a war.
  if (!c.major && c.stats.divisionCount < MINOR_WAR_READY_DIVISIONS / c.aggression) return;

  // Fight one war at a time; a second front is how an AI loses.
  if (c.atWarWith.length > 0) return;

  // Act on a justification that has matured -- but only once the army is ready.
  // Building the case takes months, so it starts well before the army does.
  for (const j of c.diplomacy.justifications) {
    if (!hasWarGoal(state, c.id, j.target)) continue;
    if (c.major && c.stats.divisionCount < WAR_READY_DIVISIONS / c.aggression) return;
    // Re-check the odds: the target may have joined a bloc, or rearmed, in the
    // months the case took to build.
    if (!warIsWinnable(state, c.id, j.target)) return;
    declareWar(state, c.id, j.target);
    return;
  }
  if (c.diplomacy.justifications.length > 0) {
    // A case that has sat ready for a year is a case against the wrong country.
    // Dropping it lets the AI re-target instead of waiting out the scenario.
    c.diplomacy.justifications = c.diplomacy.justifications.filter(
      (j) => j.progress < j.required + STALE_WAR_GOAL_DAYS,
    );
    for (const j of c.diplomacy.justifications) j.progress++;
    return;
  }

  // Otherwise pick the softest neighbour worth taking.
  const target = pickExpansionTarget(state, ctx, c);
  if (target !== null) startJustification(state, c.id, target);
}

/** Combined military strength of a country and its faction. */
function blocStrength(state: GameState, country: CountryId): number {
  const c = state.countries[country];
  const members = c.factionId !== null ? state.factions[c.factionId].members : [country];
  let total = 0;
  for (const id of members) {
    const m = state.countries[id];
    if (!m.capitulated) total += m.stats.militaryStrength;
  }
  return Math.max(1, total);
}

/**
 * Whether attacking this target is a war the aggressor's bloc could plausibly
 * win. Without the check the Axis leader picks the richest neighbour on the
 * board -- France -- in 1937, drags in the whole Allied bloc at three to one,
 * and is gone by the summer.
 */
function warIsWinnable(state: GameState, aggressor: CountryId, target: CountryId): boolean {
  const c = state.countries[aggressor];
  const boldness = BOLDNESS[c.ideology] * c.aggression;
  return blocStrength(state, aggressor) * boldness >= blocStrength(state, target);
}

function pickExpansionTarget(
  state: GameState, ctx: AIContext, c: Country,
): CountryId | null {
  const neighbours = new Set<CountryId>();
  for (let i = 0; i < state.provinces.length; i++) {
    if (state.provinces[i].controller !== c.id) continue;
    const geo = ctx.index.get(i);
    for (const nb of [...geo.neighbors, ...geo.seaNeighbors]) {
      const owner = state.provinces[nb].controller;
      if (owner !== c.id) neighbours.add(owner);
    }
  }

  let best: CountryId | null = null;
  let bestScore = -Infinity;
  for (const id of neighbours) {
    const t = state.countries[id];
    if (t.capitulated) continue;
    if (t.factionId !== null && t.factionId === c.factionId) continue;
    if (!warIsWinnable(state, c.id, id)) continue;

    // Value counts for more than weakness. Scoring purely on the ratio makes
    // every AI open by invading Luxembourg, which is optimal and absurd.
    const strength = Math.max(1, t.stats.militaryStrength);
    let score = Math.pow(Math.max(1, t.stats.victoryPoints), 1.5) / Math.pow(strength, 0.5);
    if (t.ideology === c.ideology) score *= 0.4;
    if (t.factionId !== null) score *= 0.35;   // taking on a bloc is expensive
    // Discount by how badly the odds run against the whole opposing coalition,
    // so an isolated neighbour is preferred over the richest one on the board.
    score *= Math.min(1, blocStrength(state, c.id) / blocStrength(state, id));
    // Enough noise that the same scenario played twice takes a different
    // course, rather than replaying one optimal script with different dice.
    score *= 0.6 + rand(state.rng) * 0.85;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
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
