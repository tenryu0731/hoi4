import { dateReached } from '../ai/doctrine';
import { techDef } from '../research/techData';
import { BUILDING_CAP, FACTORY_OUTPUT } from '../core/data';
import {
  JUSTIFY_BASE_DAYS, adjustOpinion, areAllied,
  focusDemandAnnexation, focusDemandCession,
} from '../diplomacy/diplomacy';
import { recomputeFactories } from '../economy/production';
import type {
  Country, CountryFocus, CountryId, GameState, StateId,
} from '../core/types';
import type { ProvinceIndex } from '../map/ProvinceIndex';
import {
  focusDef, focusTreeFor,
  type FactoryKind, type FocusCondition, type FocusDef, type FocusEffect,
  type ResearchBranch,
} from './focusData';

/**
 * The national focus runtime.
 *
 * A government works on one focus at a time. It takes seventy days by default,
 * it cannot be swapped once begun -- cancelling throws the work away -- and the
 * tree decides what may be begun at all. That is the whole design: the cost of
 * a focus is not political power, it is the two months of national attention
 * that could have gone somewhere else, and the branches that close behind it.
 *
 * Every effect lands on a system that already exists. Nothing here invents a
 * modifier only this module can read, which is why a focus is worth taking:
 * the factory it hands over is the same factory the economy already counts.
 */

export interface FocusContext {
  index: ProvinceIndex;
}

/** Research slots a country may ever hold, matching sim/research. */
const MAX_RESEARCH_SLOTS = 5;

const BRANCHES: readonly ResearchBranch[] = ['infantry', 'armor', 'air', 'industry'];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The focus block, created on first use.
 *
 * The 1936 scenario table predates the focus system and builds countries
 * without one, so every entry point goes through here rather than assuming the
 * field is populated.
 */
const EMPTY_FOCUS: CountryFocus = Object.freeze({
  current: null,
  progress: 0,
  completed: Object.freeze([] as string[]),
  bonuses: Object.freeze({
    research: Object.freeze({ infantry: 0, armor: 0, air: 0, industry: 0 }),
    construction: 0,
    consumerGoodsCap: 1,
    politicalPower: 0,
  }),
}) as CountryFocus;

/**
 * The read-only view of a country's focus block.
 *
 * Everything the UI calls goes through here rather than through `ensureFocus`,
 * because a presentation layer that reads the tree must not be the thing that
 * writes the field into existence.
 */
function readFocus(c: Country): CountryFocus {
  return c.focus ?? EMPTY_FOCUS;
}

export function ensureFocus(c: Country): CountryFocus {
  if (!c.focus) {
    c.focus = {
      current: null,
      progress: 0,
      completed: [],
      bonuses: {
        research: { infantry: 0, armor: 0, air: 0, industry: 0 },
        construction: 0,
        consumerGoodsCap: 1,
        politicalPower: 0,
      },
    };
  }
  return c.focus;
}

/** Tag lookup, cached per state so an effect list is not O(countries). */
const TAG_INDEX = new WeakMap<GameState, Map<string, CountryId>>();

function countryByTag(state: GameState, tag: string): Country | null {
  let table = TAG_INDEX.get(state);
  if (!table) {
    table = new Map<string, CountryId>();
    for (const c of state.countries) table.set(c.tag, c.id);
    TAG_INDEX.set(state, table);
  }
  const id = table.get(tag);
  return id === undefined ? null : state.countries[id];
}

// ---------------------------------------------------------------------------
// The tree: prerequisites, exclusivity, conditions
// ---------------------------------------------------------------------------

/**
 * Exclusivity is symmetric whether or not the data says so twice.
 *
 * A tree that declares the pairing on one side only would otherwise let the
 * player take the branch that stays silent and then the branch that locks it,
 * which is the one thing exclusivity exists to prevent.
 */
const EXCLUSIVE_BY_TREE = new Map<string, Map<string, string[]>>();

function exclusiveTable(tag: string): Map<string, string[]> {
  const tree = focusTreeFor(tag);
  const cached = EXCLUSIVE_BY_TREE.get(tree.tag);
  if (cached) return cached;

  const table = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = table.get(a);
    if (!list) table.set(a, [b]);
    else if (!list.includes(b)) list.push(b);
  };
  for (const def of tree.focuses) {
    for (const other of def.exclusive ?? []) {
      add(def.id, other);
      add(other, def.id);
    }
  }
  EXCLUSIVE_BY_TREE.set(tree.tag, table);
  return table;
}

export function exclusiveWith(tag: string, id: string): string[] {
  return exclusiveTable(tag).get(id) ?? [];
}

/** Why a focus cannot be started, as data. */
export type FocusBlock =
  | { k: 'capitulated' }
  | { k: 'completed' }
  | { k: 'prerequisite'; missing: string[] }
  | { k: 'exclusive'; taken: string[] }
  | { k: 'condition'; condition: FocusCondition }
  | { k: 'inProgress'; focus: string };

function conditionMet(state: GameState, c: Country, cond: FocusCondition): boolean {
  switch (cond.k) {
    case 'date': return dateReached(state.clock, cond.from);
    case 'worldTension': return state.worldTension >= cond.min;
    case 'divisions': return c.stats.divisionCount >= cond.min;
    case 'politicalPower': return c.economy.politicalPower >= cond.min;
    case 'dockyards': return c.economy.dockyards >= cond.min;
    case 'atWar': return c.atWarWith.length > 0;
    case 'atPeace': return c.atWarWith.length === 0;
    case 'countryAlive': {
      const t = countryByTag(state, cond.tag);
      return t !== null && !t.capitulated;
    }
    case 'atWarWith': {
      const t = countryByTag(state, cond.tag);
      return t !== null && c.atWarWith.includes(t.id);
    }
  }
}

/**
 * The single gate. `startFocus`, the AI's pick and the UI's greying-out all
 * ask this one question, so a focus the tree shows as available is by
 * construction a focus the command will accept.
 */
export function focusBlock(state: GameState, c: Country, def: FocusDef): FocusBlock | null {
  const f = readFocus(c);
  if (c.capitulated) return { k: 'capitulated' };
  if (f.completed.includes(def.id)) return { k: 'completed' };

  const taken = exclusiveWith(c.tag, def.id)
    .filter((id) => f.completed.includes(id) || f.current === id);
  if (taken.length > 0) return { k: 'exclusive', taken };

  const missing: string[] = [];
  for (const group of def.prereq ?? []) {
    if (group.some((id) => f.completed.includes(id))) continue;
    for (const id of group) if (!missing.includes(id)) missing.push(id);
  }
  if (missing.length > 0) return { k: 'prerequisite', missing };

  for (const cond of def.requires ?? []) {
    if (!conditionMet(state, c, cond)) return { k: 'condition', condition: cond };
  }

  // Checked last so a locked focus explains what it really needs rather than
  // reporting that the cabinet is busy.
  if (f.current !== null) return { k: 'inProgress', focus: f.current };
  return null;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Begins a focus, if the tree allows it.
 *
 * Returns false rather than throwing, because the same call is made by the
 * player's command, by the AI, and by a UI that may be a frame behind the
 * simulation.
 */
export function startFocus(
  state: GameState, _ctx: FocusContext, country: CountryId, focusId: string,
): boolean {
  const c = state.countries[country];
  if (!c) return false;
  const def = focusDef(c.tag, focusId);
  if (!def) return false;
  const f = ensureFocus(c);
  if (f.current !== null) return false;
  if (focusBlock(state, c, def) !== null) return false;

  f.current = def.id;
  f.progress = 0;
  return true;
}

/**
 * Abandons the current focus. The days already spent are lost, which is what
 * makes committing to one a decision rather than a queue position.
 */
export function cancelFocus(state: GameState, country: CountryId): void {
  const c = state.countries[country];
  if (!c) return;
  const f = ensureFocus(c);
  f.current = null;
  f.progress = 0;
}

/**
 * The AI's pick: the first focus in the tree it is allowed to take.
 *
 * Definition order is historical order, so this is a timetable rather than a
 * search -- the same reasoning as the doctrine table, and for the same reason.
 * An AI scoring focuses by their effects takes the factories every time and
 * never gets round to the Anschluss.
 */
export function autoSelectFocus(
  state: GameState, ctx: FocusContext, c: Country,
): string | null {
  for (const def of focusTreeFor(c.tag).focuses) {
    if (focusBlock(state, c, def) !== null) continue;
    if (startFocus(state, ctx, c.id, def.id)) return def.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Daily tick
// ---------------------------------------------------------------------------

/**
 * One day of work, for every country.
 *
 * Standing bonuses are paid first, then the day is credited, then a finished
 * focus is applied. AI countries that are idle choose here; the player's
 * cabinet stays idle until the player says otherwise, because choosing is the
 * whole of the mechanic.
 */
export function tickFocusDaily(state: GameState, ctx: FocusContext): void {
  for (const c of state.countries) {
    const f = ensureFocus(c);
    if (c.capitulated) {
      f.current = null;
      f.progress = 0;
      continue;
    }

    applyStandingBonuses(state, c, f);

    if (f.current !== null) {
      const def = focusDef(c.tag, f.current);
      if (!def || !stillWorthDoing(state, c, def)) {
        f.current = null;
        f.progress = 0;
      } else {
        f.progress++;
        if (f.progress >= def.days) completeFocus(state, ctx, c, f, def);
      }
    }

    if (f.current === null && c.isAI) autoSelectFocus(state, ctx, c);
  }
}

/**
 * A focus aimed at a country somebody else has already swallowed is dropped.
 * Only that check is re-run: a focus whose date or tension gate has since
 * lapsed carries on, because a government does not abandon a two-month
 * programme because the weather changed.
 */
function stillWorthDoing(state: GameState, c: Country, def: FocusDef): boolean {
  for (const cond of def.requires ?? []) {
    if (cond.k === 'countryAlive' && !conditionMet(state, c, cond)) return false;
  }
  return true;
}

function completeFocus(
  state: GameState, ctx: FocusContext, c: Country, f: CountryFocus, def: FocusDef,
): void {
  f.completed.push(def.id);
  f.current = null;
  f.progress = 0;
  for (const e of def.effects) applyEffect(state, ctx, c, f, e);

  state.log.push({
    day: state.clock.totalDays,
    kind: 'focus',
    // The identifier, not the name: the UI looks the name up in focusData,
    // the same way it does for buildings, equipment and technologies.
    body: { k: 'itemCompleted', country: c.tag, item: def.id },
    country: c.id,
  });
}

// ---------------------------------------------------------------------------
// Standing bonuses
// ---------------------------------------------------------------------------

function applyStandingBonuses(state: GameState, c: Country, f: CountryFocus): void {
  const b = f.bonuses;

  if (b.politicalPower > 0) {
    c.economy.politicalPower = Math.min(999, c.economy.politicalPower + b.politicalPower);
  }
  for (const branch of BRANCHES) {
    if (b.research[branch] > 0) addResearchDays(c, branch, b.research[branch]);
  }
  if (b.construction > 0) addConstructionProgress(state, c, b.construction);
  if (b.consumerGoodsCap < 1 && c.economy.consumerGoodsRatio > b.consumerGoodsCap) {
    // An economy law: the peacetime drift in production.ts pushes the ratio
    // back up every day, and this holds it down every day. Running after the
    // economy is what makes the ceiling stick.
    c.economy.consumerGoodsRatio = b.consumerGoodsCap;
  }
}

/**
 * Research days, paid into the branch the focus advertised.
 *
 * They used to go to whichever slot happened to be busy first. Measured over a
 * campaign, 3,463 bonus days were granted and 283 of them -- 8.2% -- landed in
 * the branch the focus named, so 「機甲研究 +100日分」 usually paid for
 * whatever infantry technology happened to be in slot one. The same days were
 * also paid a second time into a per-branch ledger whose comment claimed
 * production.ts read it; production.ts does not, and neither does anything
 * else, so 11,421 research-days a campaign accumulated into counters with no
 * reader. That ledger is gone.
 *
 * A country researching nothing in the named branch still gets the days -- the
 * intent is to speed up research, and refusing to pay a bonus because the
 * player is between technologies in that branch would be worse than paying it
 * imprecisely.
 */
function addResearchDays(c: Country, branch: ResearchBranch, days: number): void {
  const slots = c.research.active;
  if (!slots) return;
  const inBranch = slots.find(
    (s) => s.tech !== null && techDef(s.tech)?.branch === branch,
  );
  const target = inBranch ?? slots.find((s) => s.tech !== null);
  if (!target) return;
  // Completion stays the research runtime's job, so an overshoot here simply
  // finishes the technology tomorrow.
  target.progress = Math.max(0, target.progress + days);
}

/** An extra crew on the front of the construction queue. */
function addConstructionProgress(state: GameState, c: Country, factories: number): void {
  for (const item of c.constructionQueue) {
    const st = state.states[item.stateId];
    if (!st || st.controller !== c.id) continue;
    const infraBonus = 1 + (st.infrastructure - 1) * 0.1;
    item.progress += factories * FACTORY_OUTPUT * infraBonus;
    return;
  }
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

function applyEffect(
  state: GameState, ctx: FocusContext, c: Country, f: CountryFocus, e: FocusEffect,
): void {
  switch (e.k) {
    case 'politicalPower':
      c.economy.politicalPower = Math.max(0, Math.min(999, c.economy.politicalPower + e.amount));
      return;
    case 'dailyPoliticalPower':
      f.bonuses.politicalPower += e.amount;
      return;
    case 'manpower':
      c.economy.manpower = Math.max(0, c.economy.manpower + e.amount);
      return;
    case 'factory':
      grantBuildings(state, ctx, c, e.building, e.count);
      return;
    case 'buildingSlots':
      grantBuildingSlots(state, ctx, c, e.count);
      return;
    case 'infrastructure':
      grantInfrastructure(state, c, e.states);
      return;
    case 'fort':
      fortify(state, ctx, c, e.level, e.borderWith, e.coastal);
      return;
    case 'research':
      addResearchDays(c, e.branch, e.days);
      return;
    case 'researchSpeed':
      f.bonuses.research[e.branch] += e.amount;
      return;
    case 'researchSlot':
      c.research.slots = Math.min(MAX_RESEARCH_SLOTS, c.research.slots + e.count);
      return;
    case 'constructionSpeed':
      f.bonuses.construction += e.amount;
      return;
    case 'warEconomy':
      f.bonuses.consumerGoodsCap = Math.min(f.bonuses.consumerGoodsCap, e.consumerGoods);
      c.economy.consumerGoodsRatio = Math.min(c.economy.consumerGoodsRatio, e.consumerGoods);
      return;
    case 'equipment':
      c.economy.stockpile[e.equipment] = Math.max(
        0, (c.economy.stockpile[e.equipment] ?? 0) + e.amount,
      );
      return;
    case 'wargoal':
      grantWargoal(state, c, e.target);
      return;
    case 'annex':
      pressDemand(state, c, e.target, (t) => focusDemandAnnexation(state, ctx, c.id, t));
      return;
    case 'cede':
      pressDemand(
        state, c, e.target,
        (t) => focusDemandCession(state, ctx, c.id, t, e.states) > 0,
      );
      return;
    case 'guarantee':
      grantGuarantee(state, c, e.target);
      return;
    case 'opinion':
      applyOpinion(state, c, e.target, e.amount, e.direction ?? 'both');
      return;
    case 'worldTension':
      state.worldTension = Math.max(0, Math.min(100, state.worldTension + e.amount));
      return;
  }
}

// --- industry --------------------------------------------------------------

/** Whether a state can take one more building of this kind. */
function hasRoomFor(state: GameState, ctx: FocusContext, id: StateId, kind: FactoryKind): boolean {
  const st = state.states[id];
  if (kind === 'dockyard') {
    if (st.dockyards >= BUILDING_CAP.dockyard) return false;
    return ctx.index.data.states[id].provinces.some((p) => ctx.index.provinces[p]?.coastal);
  }
  const level = kind === 'civilian_factory' ? st.civilianFactories : st.militaryFactories;
  if (level >= BUILDING_CAP[kind]) return false;
  return st.civilianFactories + st.militaryFactories < st.buildingSlots;
}

function capitalState(ctx: FocusContext, c: Country): StateId | null {
  const p = ctx.index.provinces[c.capital];
  return p ? p.stateId : null;
}

/**
 * Where a granted factory goes.
 *
 * The capital region first, then whichever state has the most room left, then
 * the lowest state id -- a fixed order, so the same focus in the same campaign
 * always builds in the same place.
 */
function pickBuildingState(
  state: GameState, ctx: FocusContext, c: Country, kind: FactoryKind,
): StateId | null {
  const capital = capitalState(ctx, c);
  if (capital !== null && ownedBy(state, capital, c) && hasRoomFor(state, ctx, capital, kind)) {
    return capital;
  }
  let best: StateId | null = null;
  let bestRoom = -1;
  for (let i = 0; i < state.states.length; i++) {
    if (!ownedBy(state, i, c) || !hasRoomFor(state, ctx, i, kind)) continue;
    const st = state.states[i];
    const room = kind === 'dockyard'
      ? BUILDING_CAP.dockyard - st.dockyards
      : st.buildingSlots - st.civilianFactories - st.militaryFactories;
    if (room > bestRoom) {
      bestRoom = room;
      best = i;
    }
  }
  return best;
}

function ownedBy(state: GameState, id: StateId, c: Country): boolean {
  const st = state.states[id];
  return !!st && st.owner === c.id && st.controller === c.id;
}

/** The country's own state the focus falls back on when nothing has room. */
function fallbackState(state: GameState, ctx: FocusContext, c: Country): StateId | null {
  const capital = capitalState(ctx, c);
  if (capital !== null && ownedBy(state, capital, c)) return capital;
  for (let i = 0; i < state.states.length; i++) if (ownedBy(state, i, c)) return i;
  return null;
}

function grantBuildings(
  state: GameState, ctx: FocusContext, c: Country, kind: FactoryKind, count: number,
): void {
  let built = 0;
  for (let n = 0; n < count; n++) {
    let target = pickBuildingState(state, ctx, c, kind);
    if (target === null && kind !== 'dockyard') {
      // A programme that promised factories builds the room for them rather
      // than quietly delivering nothing.
      target = fallbackState(state, ctx, c);
      if (target !== null) state.states[target].buildingSlots++;
    }
    if (target === null) break;
    const st = state.states[target];
    if (kind === 'civilian_factory') st.civilianFactories++;
    else if (kind === 'military_factory') st.militaryFactories++;
    else st.dockyards++;
    built++;
  }
  if (built > 0) recomputeFactories(state, c.id);
}

function grantBuildingSlots(
  state: GameState, ctx: FocusContext, c: Country, count: number,
): void {
  const target = fallbackState(state, ctx, c);
  if (target === null) return;
  state.states[target].buildingSlots += count;
}

/** Raises the least developed states first: roads are worth most where none are. */
function grantInfrastructure(state: GameState, c: Country, states: number): void {
  const candidates: StateId[] = [];
  for (let i = 0; i < state.states.length; i++) {
    if (!ownedBy(state, i, c)) continue;
    if (state.states[i].infrastructure >= BUILDING_CAP.infrastructure) continue;
    candidates.push(i);
  }
  candidates.sort((a, b) => state.states[a].infrastructure - state.states[b].infrastructure || a - b);
  for (let n = 0; n < states && n < candidates.length; n++) {
    const st = state.states[candidates[n]];
    st.infrastructure = Math.min(BUILDING_CAP.infrastructure, st.infrastructure + 1);
  }
}

function fortify(
  state: GameState, ctx: FocusContext, c: Country,
  level: number, borderWith?: string, coastal?: boolean,
): void {
  const target = borderWith ? countryByTag(state, borderWith) : null;
  if (borderWith !== undefined && target === null) return;
  for (let i = 0; i < state.provinces.length; i++) {
    const p = state.provinces[i];
    if (p.owner !== c.id || p.controller !== c.id) continue;
    const geo = ctx.index.provinces[i];
    if (!geo) continue;
    if (coastal && !geo.coastal) continue;
    if (target !== null && !geo.neighbors.some((n) => state.provinces[n]?.owner === target.id)) {
      continue;
    }
    p.fortLevel = Math.min(BUILDING_CAP.fort, p.fortLevel + level);
  }
}

// --- diplomacy -------------------------------------------------------------

/**
 * A war goal, matured on the spot.
 *
 * This is the point of a claim focus: the justification the diplomacy layer
 * would otherwise spend political power and forty-odd days building is what the
 * government has just spent seventy days building instead.
 */
function grantWargoal(state: GameState, c: Country, tag: string): void {
  const t = countryByTag(state, tag);
  if (!t || t.id === c.id || t.capitulated) return;
  if (c.atWarWith.includes(t.id) || areAllied(state, c.id, t.id)) return;

  const existing = c.diplomacy.justifications.find((j) => j.target === t.id);
  if (existing) {
    existing.progress = existing.required;
    return;
  }
  const size = Math.max(1, t.stats.victoryPoints);
  const required = Math.round(JUSTIFY_BASE_DAYS * (1 + Math.min(2, size / 120)));
  c.diplomacy.justifications.push({ target: t.id, progress: required, required });
}

/**
 * Presses a focus's territorial demand, and falls back to a war goal.
 *
 * Every one of these focuses is named for a thing that happened, and every one
 * of them happened because the demand was met. When it is not -- the target is
 * guaranteed, or in a bloc, or big enough to say no -- the focus must still
 * leave the government somewhere to go, or two months of national attention
 * bought nothing at all. A matured war goal is that somewhere: it is what
 * Danzig turned into.
 */
function pressDemand(
  state: GameState, c: Country, tag: string,
  press: (target: CountryId) => boolean,
): void {
  const t = countryByTag(state, tag);
  if (!t || t.id === c.id || t.capitulated) return;
  if (press(t.id)) return;
  grantWargoal(state, c, tag);
}

/** As diplomacy.guarantee, but paid for with the focus rather than with power. */
function grantGuarantee(state: GameState, c: Country, tag: string): void {
  const t = countryByTag(state, tag);
  if (!t || t.id === c.id || t.capitulated) return;
  if (c.diplomacy.guarantees.includes(t.id)) return;
  c.diplomacy.guarantees.push(t.id);
  adjustOpinion(state, t.id, c.id, 20);
}

function applyOpinion(
  state: GameState, c: Country, tag: string, amount: number,
  direction: 'ours' | 'theirs' | 'both',
): void {
  const t = countryByTag(state, tag);
  if (!t || t.id === c.id) return;
  // 'theirs' is how they see us, which is the direction an ultimatum reads.
  if (direction !== 'ours') adjustOpinion(state, t.id, c.id, amount);
  if (direction !== 'theirs') adjustOpinion(state, c.id, t.id, amount);
}

// ---------------------------------------------------------------------------
// The view the UI draws
// ---------------------------------------------------------------------------

export interface FocusView {
  id: string;
  /** Japanese display name. */
  name: string;
  /** Japanese description, one or two sentences. */
  desc: string;
  /** Working days the focus takes. */
  days: number;
  /** Grid position in the tree. */
  x: number;
  y: number;
  /** OR within a group, AND between groups. */
  prerequisites: string[][];
  /** Both directions resolved, so the UI can draw the fork from either side. */
  exclusive: string[];
  completed: boolean;
  current: boolean;
  /** Days of work done; zero unless this is the focus under way. */
  progress: number;
  daysRemaining: number;
  /** 0..1, for a progress bar. */
  fraction: number;
  selectable: boolean;
  /** Why not, as data and as a Japanese sentence. Null when selectable. */
  block: FocusBlock | null;
  blockText: string | null;
  /** Unlock conditions, as data and as Japanese sentences. */
  conditions: FocusCondition[];
  conditionText: string[];
  /** What it does, as data and as Japanese sentences. */
  effects: FocusEffect[];
  effectText: string[];
}

/**
 * The whole tree, in definition order, with everything needed to draw it.
 *
 * Completed and locked focuses are included: a tree that only shows what can be
 * clicked right now is not a tree, and the player choosing between Sea Lion and
 * the Atlantic Wall needs to see both.
 */
export function availableFocuses(state: GameState, country: CountryId): FocusView[] {
  const c = state.countries[country];
  if (!c) return [];
  const f = readFocus(c);
  const tree = focusTreeFor(c.tag);

  return tree.focuses.map((def) => {
    const block = focusBlock(state, c, def);
    const current = f.current === def.id;
    const progress = current ? f.progress : 0;
    return {
      id: def.id,
      name: def.name,
      desc: def.desc,
      days: def.days,
      x: def.x,
      y: def.y,
      prerequisites: (def.prereq ?? []).map((g) => [...g]),
      exclusive: exclusiveWith(c.tag, def.id),
      completed: f.completed.includes(def.id),
      current,
      progress,
      daysRemaining: Math.max(0, def.days - progress),
      fraction: def.days > 0 ? Math.min(1, progress / def.days) : 0,
      selectable: block === null,
      block,
      blockText: block === null ? null : blockText(c, block),
      conditions: def.requires ?? [],
      conditionText: (def.requires ?? []).map(conditionText),
      effects: def.effects,
      effectText: def.effects.map(effectText),
    };
  });
}

/** The focus under way, for a status line. Null when the cabinet is idle. */
export function currentFocus(state: GameState, country: CountryId): FocusView | null {
  const c = state.countries[country];
  if (!c) return null;
  const id = readFocus(c).current;
  if (id === null) return null;
  return availableFocuses(state, country).find((v) => v.id === id) ?? null;
}

/** Ids completed so far, in completion order. */
export function completedFocuses(state: GameState, country: CountryId): string[] {
  const c = state.countries[country];
  return c ? [...readFocus(c).completed] : [];
}

// ---------------------------------------------------------------------------
// Japanese rendering of blocks, conditions and effects
// ---------------------------------------------------------------------------

/**
 * The names are content, so the sentences built out of them are content too.
 *
 * Everywhere else the simulation records a fact and the UI writes the prose.
 * A focus tooltip is the exception for the same reason the focus name is: the
 * text and the data are the same object, and splitting them would put half of
 * the tree in one file and half in another.
 */
const BRANCH_NAME: Record<ResearchBranch, string> = {
  infantry: '歩兵', armor: '機甲', air: '航空', industry: '工業',
};

const BUILDING_NAME: Record<FactoryKind, string> = {
  civilian_factory: '民需工場', military_factory: '軍需工場', dockyard: '造船所',
};

const EQUIPMENT_NAME: Record<string, string> = {
  infantry_equipment: '歩兵装備',
  support_equipment: '支援装備',
  artillery: '火砲',
  motorized: '自動車',
  light_armor: '軽戦車',
  medium_armor: '中戦車',
  fighter: '戦闘機',
  cas: '近接航空支援機',
  convoy: '輸送船団',
};

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function focusName(tag: string, id: string): string {
  return focusDef(tag, id)?.name ?? id;
}

export function conditionText(cond: FocusCondition): string {
  switch (cond.k) {
    case 'date': {
      const year = cond.from.slice(0, 4);
      const month = String(Number(cond.from.slice(5, 7)));
      return `${year}年${month}月以降`;
    }
    case 'worldTension': return `世界緊張度 ${cond.min}% 以上`;
    case 'divisions': return `師団 ${cond.min} 個以上`;
    case 'politicalPower': return `政治力 ${cond.min} 以上`;
    case 'dockyards': return '造船所を保有していること';
    case 'atWar': return '戦争状態にあること';
    case 'atPeace': return '平時であること';
    case 'countryAlive': return `${cond.tag}が存続していること`;
    case 'atWarWith': return `${cond.tag}と交戦中であること`;
  }
}

export function effectText(e: FocusEffect): string {
  switch (e.k) {
    case 'politicalPower': return `政治力 ${signed(e.amount)}`;
    case 'dailyPoliticalPower': return `政治力 ${signed(e.amount)}/日`;
    case 'manpower': return `徴兵可能人口 ${signed(e.amount)}`;
    case 'factory': return `${BUILDING_NAME[e.building]} ${signed(e.count)}`;
    case 'buildingSlots': return `建設スロット ${signed(e.count)}`;
    case 'infrastructure': return `${e.states}州のインフラ +1`;
    case 'fort': {
      if (e.coastal) return `沿岸部の要塞レベル ${signed(e.level)}`;
      if (e.borderWith) return `${e.borderWith}国境の要塞レベル ${signed(e.level)}`;
      return `要塞レベル ${signed(e.level)}`;
    }
    case 'research': return `${BRANCH_NAME[e.branch]}研究 ${signed(e.days)}日分`;
    case 'researchSpeed': return `${BRANCH_NAME[e.branch]}研究速度 ${signed(Math.round(e.amount * 100))}%`;
    case 'researchSlot': return `研究スロット ${signed(e.count)}`;
    case 'constructionSpeed': return `建設速度 +工場${e.amount}基分`;
    case 'warEconomy': return `消費財割合の上限 ${Math.round(e.consumerGoods * 100)}%`;
    case 'equipment': return `${EQUIPMENT_NAME[e.equipment] ?? e.equipment} ${signed(e.amount)}`;
    case 'wargoal': return `${e.target}に対する戦争目標`;
    case 'annex': return `${e.target}を併合（拒まれた場合は戦争目標）`;
    case 'cede': return `${e.target}に${e.states}ステートの割譲を要求`;
    case 'guarantee': return `${e.target}の独立を保証`;
    case 'opinion': return `${e.target}との関係 ${signed(e.amount)}`;
    case 'worldTension': return `世界緊張度 ${signed(e.amount)}%`;
  }
}

export function blockText(c: Country, block: FocusBlock): string {
  switch (block.k) {
    case 'capitulated': return '降伏国は国家方針を進められない';
    case 'completed': return '完了済み';
    case 'inProgress': return `${focusName(c.tag, block.focus)}を実行中`;
    case 'prerequisite':
      return `前提: ${block.missing.map((id) => focusName(c.tag, id)).join('、')}`;
    case 'exclusive':
      return `${block.taken.map((id) => focusName(c.tag, id)).join('、')}と排他`;
    case 'condition':
      return conditionText(block.condition);
  }
}
