import {
  BASE_EFFICIENCY, BASE_EFFICIENCY_CAP, BUILDING_CAP, BUILDING_COST,
  EFFICIENCY_GROWTH, EQUIPMENT, FACTORY_OUTPUT, MAX_SHORTAGE_PENALTY,
} from '../core/data';
import {
  RESOURCE_TYPES,
  type BuildingType, type Country, type CountryId, type GameState,
  type ProductionLine, type ResourceType, type StateId,
} from '../core/types';
import type { ProvinceIndex } from '../map/ProvinceIndex';

/**
 * The economic engine.
 *
 * One daily pass per country, in a fixed order:
 *   1. resources produced by the states it controls
 *   2. consumer goods skimmed off civilian industry
 *   3. resource demand from every production line, met by priority
 *   4. equipment output, with efficiency growing toward its cap
 *   5. construction progress from the free civilian factories
 *   6. conscription
 *
 * Everything is deterministic and order-independent within a step: demand for
 * the whole day is computed before any of it is met, so a line's allocation
 * never depends on where it sits in the array beyond its declared priority.
 */

/** Political power accrued per day. */
const POLITICAL_POWER_PER_DAY = 1;
/** Fraction of a state's population that becomes recruitable each year. */
const CONSCRIPTION_RATE = 0.025;
/** Manpower is stored in thousands; this converts the annual rate to daily. */
const DAILY_CONSCRIPTION = CONSCRIPTION_RATE / 365;

export interface EconomyContext {
  index: ProvinceIndex;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** Sums the resource output of every state a country currently controls. */
export function computeResourceOutput(
  state: GameState, index: ProvinceIndex, country: CountryId,
): Record<ResourceType, number> {
  const out = {} as Record<ResourceType, number>;
  for (const r of RESOURCE_TYPES) out[r] = 0;
  const staticStates = index.data.states;
  for (let i = 0; i < staticStates.length; i++) {
    if (state.states[i].controller !== country) continue;
    const res = staticStates[i].resources;
    for (const r of RESOURCE_TYPES) {
      const v = res[r];
      if (v) out[r] += v;
    }
  }
  return out;
}

/** Resource cost of running one factory on this line for a day. */
export function lineResourceDemand(line: ProductionLine): Partial<Record<ResourceType, number>> {
  const def = EQUIPMENT[line.equipment];
  const out: Partial<Record<ResourceType, number>> = {};
  for (const [r, v] of Object.entries(def.resources) as [ResourceType, number][]) {
    out[r] = v * line.assignedFactories;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Factory accounting
// ---------------------------------------------------------------------------

/** Recomputes factory totals from the states a country controls. */
export function recomputeFactories(state: GameState, country: CountryId): void {
  const c = state.countries[country];
  let civ = 0;
  let mil = 0;
  let dock = 0;
  for (const s of state.states) {
    if (s.controller !== country) continue;
    civ += s.civilianFactories;
    mil += s.militaryFactories;
    dock += s.dockyards;
  }
  c.economy.civilianFactories = civ;
  c.economy.militaryFactories = mil;
  c.economy.dockyards = dock;

  // Lines cannot keep factories the country no longer owns.
  let assigned = 0;
  for (const line of c.productionLines) assigned += line.assignedFactories;
  if (assigned > mil) {
    let excess = assigned - mil;
    // Take from the lowest priority first, then from the largest line.
    const order = [...c.productionLines].sort(
      (a, b) => a.priority - b.priority || b.assignedFactories - a.assignedFactories,
    );
    for (const line of order) {
      if (excess <= 0) break;
      const take = Math.min(line.assignedFactories, excess);
      line.assignedFactories -= take;
      excess -= take;
    }
  }
}

/** Civilian factories left for construction after consumer goods. */
export function freeCivilianFactories(c: Country): number {
  const consumed = Math.ceil(c.economy.civilianFactories * c.economy.consumerGoodsRatio);
  return Math.max(0, c.economy.civilianFactories - consumed);
}

// ---------------------------------------------------------------------------
// Daily tick
// ---------------------------------------------------------------------------

export function tickEconomyDaily(state: GameState, ctx: EconomyContext): void {
  for (const c of state.countries) {
    if (c.capitulated) continue;
    recomputeFactories(state, c.id);
    tickCountryEconomy(state, ctx, c);
  }
}

/** Consumer-goods share a country settles at, by whether it is fighting. */
const CONSUMER_GOODS_TARGET = { peace: 0.32, war: 0.15 };
/** How fast the economy is allowed to shift, per day. */
const CONSUMER_GOODS_DRIFT = 0.002;

function tickCountryEconomy(state: GameState, ctx: EconomyContext, c: Country): void {
  const eco = c.economy;

  // A country at war converts its economy over months, not overnight. The
  // freed civilian factories are what let a wartime power out-build a
  // peacetime one, and the drift is what makes mobilising cost time.
  const target = c.atWarWith.length > 0
    ? CONSUMER_GOODS_TARGET.war
    : CONSUMER_GOODS_TARGET.peace;
  if (eco.consumerGoodsRatio > target) {
    eco.consumerGoodsRatio = Math.max(target, eco.consumerGoodsRatio - CONSUMER_GOODS_DRIFT);
  } else if (eco.consumerGoodsRatio < target) {
    eco.consumerGoodsRatio = Math.min(target, eco.consumerGoodsRatio + CONSUMER_GOODS_DRIFT / 2);
  }

  // --- 1. resource supply -------------------------------------------------
  const produced = computeResourceOutput(state, ctx.index, c.id);

  // --- 2. resource demand -------------------------------------------------
  const demand = {} as Record<ResourceType, number>;
  for (const r of RESOURCE_TYPES) demand[r] = 0;
  for (const line of c.productionLines) {
    if (line.assignedFactories <= 0) continue;
    const need = lineResourceDemand(line);
    for (const [r, v] of Object.entries(need) as [ResourceType, number][]) {
      demand[r] += v;
    }
  }

  // --- 3. allocation ------------------------------------------------------
  // Highest priority is served first. A line that cannot get everything it
  // needs runs at reduced efficiency rather than stopping, which matches how a
  // war economy actually degrades.
  const remaining = { ...produced };
  const satisfaction = new Map<number, number>();
  const byPriority = [...c.productionLines].sort((a, b) => b.priority - a.priority || a.id - b.id);

  for (const line of byPriority) {
    if (line.assignedFactories <= 0) {
      satisfaction.set(line.id, 1);
      continue;
    }
    const need = lineResourceDemand(line);
    let worst = 1;
    for (const [r, v] of Object.entries(need) as [ResourceType, number][]) {
      if (v <= 0) continue;
      const got = Math.min(v, Math.max(0, remaining[r]));
      worst = Math.min(worst, got / v);
    }
    for (const [r, v] of Object.entries(need) as [ResourceType, number][]) {
      remaining[r] = Math.max(0, remaining[r] - v * worst);
    }
    satisfaction.set(line.id, worst);
  }

  for (const r of RESOURCE_TYPES) {
    const consumed = Math.min(produced[r], demand[r]);
    eco.resources[r].produced = produced[r];
    eco.resources[r].consumed = consumed;
    eco.resources[r].deficit = Math.max(0, demand[r] - produced[r]);
  }

  // --- 4. equipment output ------------------------------------------------
  const outputBonus = 1 + c.research.levels.industry * 0.1;
  for (const line of c.productionLines) {
    const factories = line.assignedFactories;
    if (factories <= 0) {
      // An idle line loses efficiency; restarting it is not free.
      line.efficiency = Math.max(BASE_EFFICIENCY, line.efficiency - 0.01);
      continue;
    }
    const sat = satisfaction.get(line.id) ?? 1;
    const shortagePenalty = 1 - (1 - sat) * MAX_SHORTAGE_PENALTY;

    const output = factories * FACTORY_OUTPUT * line.efficiency * outputBonus * shortagePenalty;
    line.progress += output;

    const cost = EQUIPMENT[line.equipment].cost;
    if (cost > 0 && line.progress >= cost) {
      const made = Math.floor(line.progress / cost);
      line.progress -= made * cost;
      eco.stockpile[line.equipment] += made;
    }

    // Efficiency approaches its cap asymptotically, slowed by shortages.
    const cap = Math.min(line.efficiencyCap, BASE_EFFICIENCY_CAP + c.research.levels.industry * 0.08);
    line.efficiencyCap = cap;
    line.efficiency += (cap - line.efficiency) * EFFICIENCY_GROWTH * shortagePenalty;
    if (line.efficiency > cap) line.efficiency = cap;
  }

  // --- 5. construction ----------------------------------------------------
  eco.freeCivilianFactories = freeCivilianFactories(c);
  tickConstruction(state, c);

  // --- 6. manpower and political power ------------------------------------
  let pool = 0;
  for (const s of state.states) {
    if (s.controller !== c.id) continue;
    // Occupied territory yields far less than the home population.
    const factor = s.owner === c.id ? 1 : 0.2;
    pool += s.manpowerPool * factor;
  }
  eco.manpower += pool * DAILY_CONSCRIPTION;
  eco.politicalPower = Math.min(999, eco.politicalPower + POLITICAL_POWER_PER_DAY);
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Spends the free civilian factories down the queue. Each item takes at most
 * `MAX_FACTORIES_PER_ITEM`, so a long queue makes progress on several fronts
 * instead of stalling behind one enormous project.
 */
const MAX_FACTORIES_PER_ITEM = 15;

export function tickConstruction(state: GameState, c: Country): void {
  let available = c.economy.freeCivilianFactories;
  if (available <= 0 || c.constructionQueue.length === 0) return;

  const finished: number[] = [];
  for (const item of c.constructionQueue) {
    if (available <= 0) break;
    const st = state.states[item.stateId];
    // A state lost to the enemy stops building.
    if (!st || st.controller !== c.id) continue;

    const used = Math.min(available, MAX_FACTORIES_PER_ITEM);
    available -= used;
    const infraBonus = 1 + (st.infrastructure - 1) * 0.1;
    item.progress += used * FACTORY_OUTPUT * infraBonus;
    if (item.progress >= item.cost) finished.push(item.id);
  }

  if (finished.length === 0) return;
  for (const id of finished) {
    const idx = c.constructionQueue.findIndex((i) => i.id === id);
    if (idx < 0) continue;
    const item = c.constructionQueue[idx];
    applyBuilding(state, item.stateId, item.kind);
    c.constructionQueue.splice(idx, 1);
    state.log.push({
      day: state.clock.totalDays,
      kind: 'construction',
      body: { k: 'itemCompleted', country: c.tag, item: item.kind },
      country: c.id,
    });
  }
  recomputeFactories(state, c.id);
}

function applyBuilding(state: GameState, stateId: StateId, kind: BuildingType): void {
  const st = state.states[stateId];
  switch (kind) {
    case 'civilian_factory': st.civilianFactories++; break;
    case 'military_factory': st.militaryFactories++; break;
    case 'dockyard': st.dockyards++; break;
    case 'infrastructure': st.infrastructure = Math.min(BUILDING_CAP.infrastructure, st.infrastructure + 1); break;
    case 'fort': break;   // forts live on provinces, handled by the military layer
  }
}

/** Current level of a building type in a state, for cap checks. */
export function buildingLevel(state: GameState, stateId: StateId, kind: BuildingType): number {
  const st = state.states[stateId];
  switch (kind) {
    case 'civilian_factory': return st.civilianFactories;
    case 'military_factory': return st.militaryFactories;
    case 'dockyard': return st.dockyards;
    case 'infrastructure': return st.infrastructure;
    case 'fort': return 0;
  }
}

/** Levels already queued but not yet built, so the cap is not overshot. */
export function queuedLevel(c: Country, stateId: StateId, kind: BuildingType): number {
  let n = 0;
  for (const item of c.constructionQueue) {
    if (item.stateId === stateId && item.kind === kind) n++;
  }
  return n;
}

/**
 * Whether a state has room for another building of this kind.
 *
 * Civilian and military factories compete for one pool of slots sized by the
 * state's population, which is what makes industrial expansion a real choice
 * rather than a formality. Dockyards and infrastructure have their own limits.
 */
export function canQueueBuilding(
  state: GameState, c: Country, stateId: StateId, kind: BuildingType,
  slots?: number,
): boolean {
  const st = state.states[stateId];
  if (!st || st.controller !== c.id) return false;

  if (kind === 'civilian_factory' || kind === 'military_factory') {
    const used = st.civilianFactories + st.militaryFactories
      + queuedLevel(c, stateId, 'civilian_factory')
      + queuedLevel(c, stateId, 'military_factory');
    return used < (slots ?? st.buildingSlots);
  }
  const current = buildingLevel(state, stateId, kind) + queuedLevel(c, stateId, kind);
  return current < BUILDING_CAP[kind];
}

export function queueBuilding(
  state: GameState, c: Country, stateId: StateId, kind: BuildingType,
): boolean {
  if (!canQueueBuilding(state, c, stateId, kind)) return false;
  c.constructionQueue.push({
    id: state.nextIds.construction++,
    kind,
    stateId,
    progress: 0,
    cost: BUILDING_COST[kind],
  });
  return true;
}

// ---------------------------------------------------------------------------
// Production line management
// ---------------------------------------------------------------------------

export function addProductionLine(
  state: GameState, c: Country, equipment: ProductionLine['equipment'],
): ProductionLine {
  const line: ProductionLine = {
    id: state.nextIds.line++,
    equipment,
    assignedFactories: 0,
    efficiency: BASE_EFFICIENCY,
    efficiencyCap: BASE_EFFICIENCY_CAP,
    progress: 0,
    priority: 1,
  };
  c.productionLines.push(line);
  return line;
}

/** Assigns factories to a line, capped by what the country actually has spare. */
export function setLineFactories(c: Country, lineId: number, factories: number): void {
  const line = c.productionLines.find((l) => l.id === lineId);
  if (!line) return;
  const others = c.productionLines.reduce(
    (s, l) => s + (l.id === lineId ? 0 : l.assignedFactories), 0,
  );
  const spare = Math.max(0, c.economy.militaryFactories - others);
  line.assignedFactories = Math.max(0, Math.min(Math.floor(factories), spare));
}

export function removeProductionLine(c: Country, lineId: number): void {
  const i = c.productionLines.findIndex((l) => l.id === lineId);
  if (i >= 0) c.productionLines.splice(i, 1);
}

/** Equipment a country can spare after keeping its divisions supplied. */
export function stockpileOf(c: Country, equipment: ProductionLine['equipment']): number {
  return c.economy.stockpile[equipment] ?? 0;
}
