import type {
  CountryId, GameState, ProvinceId, War,
} from '../core/types';
import type { ProvinceIndex } from '../map/ProvinceIndex';
import { removeDivision } from '../military/movement';

/**
 * Diplomacy, war and capitulation.
 *
 * Wars are declared between two countries and immediately pull in both sides'
 * factions, because a faction that does not honour its guarantees is not a
 * faction. World tension rises with each aggression and is the gate that lets
 * democracies act -- the mechanism that stops the Allies from pre-empting
 * everything on day one.
 */

/** Political power to start justifying a war goal. */
export const JUSTIFY_COST = 25;
/** Days of justification for a small target, before modifiers. */
export const JUSTIFY_BASE_DAYS = 40;
/** Political power spent on a guarantee. */
export const GUARANTEE_COST = 25;
/** Political power spent improving relations. */
export const IMPROVE_COST = 10;

/** World tension added by a declaration of war. */
export const TENSION_PER_WAR = 12;
/** World tension added when a country is annexed. */
export const TENSION_PER_CAPITULATION = 8;
/** World tension bled off per month of quiet. */
export const TENSION_DECAY_PER_MONTH = 1.5;

export interface DiplomacyContext {
  index: ProvinceIndex;
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export function areAllied(state: GameState, a: CountryId, b: CountryId): boolean {
  if (a === b) return true;
  const fa = state.countries[a].factionId;
  return fa !== null && fa === state.countries[b].factionId;
}

export function atWar(state: GameState, a: CountryId, b: CountryId): boolean {
  return state.countries[a].atWarWith.includes(b);
}

export function opinionOf(state: GameState, from: CountryId, to: CountryId): number {
  return state.countries[from].diplomacy.opinion[to] ?? 0;
}

export function adjustOpinion(
  state: GameState, from: CountryId, to: CountryId, delta: number,
): void {
  const dip = state.countries[from].diplomacy;
  const next = Math.max(-100, Math.min(100, (dip.opinion[to] ?? 0) + delta));
  dip.opinion[to] = next;
}

// ---------------------------------------------------------------------------
// War goals
// ---------------------------------------------------------------------------

export function startJustification(
  state: GameState, aggressor: CountryId, target: CountryId,
): boolean {
  const c = state.countries[aggressor];
  if (aggressor === target || c.capitulated) return false;
  if (atWar(state, aggressor, target)) return false;
  if (areAllied(state, aggressor, target)) return false;
  if (c.diplomacy.justifications.some((j) => j.target === target)) return false;
  if (c.economy.politicalPower < JUSTIFY_COST) return false;

  c.economy.politicalPower -= JUSTIFY_COST;
  // A larger victim takes longer to build a case against.
  const size = Math.max(1, state.countries[target].stats.victoryPoints);
  const scale = 1 + Math.min(2, size / 120);
  c.diplomacy.justifications.push({
    target,
    progress: 0,
    required: Math.round(JUSTIFY_BASE_DAYS * scale),
  });
  return true;
}

export function hasWarGoal(state: GameState, aggressor: CountryId, target: CountryId): boolean {
  const j = state.countries[aggressor].diplomacy.justifications.find((x) => x.target === target);
  return !!j && j.progress >= j.required;
}

export function tickJustificationsDaily(state: GameState): void {
  for (const c of state.countries) {
    if (c.capitulated) continue;
    for (const j of c.diplomacy.justifications) {
      if (j.progress < j.required) j.progress++;
    }
  }
}

// ---------------------------------------------------------------------------
// Declaring war
// ---------------------------------------------------------------------------

function link(state: GameState, a: CountryId, b: CountryId): void {
  if (a === b) return;
  const ca = state.countries[a];
  const cb = state.countries[b];
  if (!ca.atWarWith.includes(b)) ca.atWarWith.push(b);
  if (!cb.atWarWith.includes(a)) cb.atWarWith.push(a);
}

/** Everyone who joins when `country` is attacked: itself plus its faction. */
function sideOf(state: GameState, country: CountryId): CountryId[] {
  const c = state.countries[country];
  if (c.factionId === null) return [country];
  return state.factions[c.factionId].members.filter((id) => !state.countries[id].capitulated);
}

export function declareWar(
  state: GameState, aggressor: CountryId, target: CountryId,
): War | null {
  if (aggressor === target) return null;
  const a = state.countries[aggressor];
  const t = state.countries[target];
  if (a.capitulated || t.capitulated) return null;
  if (atWar(state, aggressor, target)) return null;
  if (areAllied(state, aggressor, target)) return null;

  const attackers = sideOf(state, aggressor);
  const defenders = sideOf(state, target);
  // Guarantors are dragged in as well, which is what makes a guarantee mean
  // something rather than being a decorative diplomatic gesture.
  for (const c of state.countries) {
    if (c.capitulated || defenders.includes(c.id) || attackers.includes(c.id)) continue;
    if (c.diplomacy.guarantees.includes(target)) defenders.push(c.id);
  }

  for (const x of attackers) {
    for (const y of defenders) link(state, x, y);
  }

  const war: War = {
    id: state.nextIds.war++,
    attackers: [...attackers],
    defenders: [...defenders],
    startDay: state.clock.totalDays,
    ended: false,
  };
  state.wars.push(war);

  // Aggression is remembered and it frightens everyone.
  for (const c of state.countries) {
    if (c.id === aggressor) continue;
    adjustOpinion(state, c.id, aggressor, -15);
  }
  state.worldTension = Math.min(100, state.worldTension + TENSION_PER_WAR);

  // The war goal is spent.
  const idx = a.diplomacy.justifications.findIndex((j) => j.target === target);
  if (idx >= 0) a.diplomacy.justifications.splice(idx, 1);

  state.log.push({
    day: state.clock.totalDays,
    kind: 'war',
    text: `${a.name} declares war on ${t.name}`,
    country: aggressor,
  });
  return war;
}

// ---------------------------------------------------------------------------
// Guarantees and factions
// ---------------------------------------------------------------------------

export function guarantee(state: GameState, guarantor: CountryId, target: CountryId): boolean {
  const c = state.countries[guarantor];
  if (guarantor === target || c.capitulated) return false;
  if (c.diplomacy.guarantees.includes(target)) return false;
  if (c.economy.politicalPower < GUARANTEE_COST) return false;
  c.economy.politicalPower -= GUARANTEE_COST;
  c.diplomacy.guarantees.push(target);
  adjustOpinion(state, target, guarantor, 20);
  return true;
}

export function improveRelations(state: GameState, from: CountryId, to: CountryId): boolean {
  const c = state.countries[from];
  if (from === to || c.capitulated) return false;
  if (c.economy.politicalPower < IMPROVE_COST) return false;
  c.economy.politicalPower -= IMPROVE_COST;
  adjustOpinion(state, to, from, 12);
  adjustOpinion(state, from, to, 6);
  return true;
}

export function joinFaction(state: GameState, country: CountryId, factionId: number): boolean {
  const c = state.countries[country];
  const faction = state.factions[factionId];
  if (!faction || c.capitulated) return false;
  if (c.factionId === factionId) return false;
  // A country already fighting cannot join a bloc: doing so would drag every
  // member into a war they did not choose, which is how a single border
  // squabble cascades into a continental war on day sixty.
  if (c.atWarWith.length > 0) return false;
  leaveFaction(state, country);
  c.factionId = factionId;
  faction.members.push(country);

  // Joining a faction at war means joining its wars.
  for (const member of faction.members) {
    if (member === country) continue;
    for (const enemy of state.countries[member].atWarWith) {
      if (!faction.members.includes(enemy)) link(state, country, enemy);
    }
  }
  state.log.push({
    day: state.clock.totalDays,
    kind: 'diplomacy',
    text: `${c.name} joins the ${faction.name}`,
    country,
  });
  return true;
}

export function leaveFaction(state: GameState, country: CountryId): void {
  const c = state.countries[country];
  if (c.factionId === null) return;
  const faction = state.factions[c.factionId];
  const i = faction.members.indexOf(country);
  if (i >= 0) faction.members.splice(i, 1);
  c.factionId = null;
}

// ---------------------------------------------------------------------------
// Capitulation
// ---------------------------------------------------------------------------

/** Fraction of a country's own victory points currently held by its enemies. */
export function occupationRatio(state: GameState, country: CountryId): number {
  let owned = 0;
  let lost = 0;
  for (const p of state.provinces) {
    if (p.owner !== country) continue;
    owned += p.vp;
    if (p.controller !== country) lost += p.vp;
  }
  return owned > 0 ? lost / owned : 1;
}

/**
 * Surrenders a country: its territory passes to whoever beat it, its army is
 * disbanded, and it leaves its faction. Without a hard transfer the map would
 * fill with zombie nations that hold ground but cannot act.
 */
export function capitulate(
  state: GameState, ctx: DiplomacyContext, country: CountryId,
): void {
  const c = state.countries[country];
  if (c.capitulated) return;
  const occupation = occupationRatio(state, country);
  c.capitulated = true;

  // The victor is whichever enemy holds most of the country's victory points.
  const held = new Map<CountryId, number>();
  for (const p of state.provinces) {
    if (p.owner !== country || p.controller === country) continue;
    held.set(p.controller, (held.get(p.controller) ?? 0) + p.vp);
  }
  let victor: CountryId | null = null;
  let best = -1;
  for (const [id, vp] of held) {
    if (vp > best) { best = vp; victor = id; }
  }
  if (victor === null) {
    // Nobody occupies it; fall back to any enemy still standing.
    victor = c.atWarWith.find((id) => !state.countries[id].capitulated) ?? null;
  }

  // Everything the country still holds changes hands. Territory it had occupied
  // reverts to its rightful owner if that owner is still fighting; the rest
  // goes to the victor. Leaving any province under a capitulated controller
  // would strand it: a dead country cannot move, build or be attacked.
  for (let i = 0; i < state.provinces.length; i++) {
    const p = state.provinces[i];
    if (p.controller !== country) continue;
    if (p.owner !== country && !state.countries[p.owner].capitulated) {
      p.controller = p.owner;
    } else if (victor !== null) {
      p.controller = victor;
    } else {
      // No victor and no living owner: hand it back to its owner regardless,
      // so the map never holds a province nobody controls.
      p.controller = p.owner;
    }
  }
  for (let i = 0; i < state.states.length; i++) {
    const st = state.states[i];
    const members: ProvinceId[] = ctx.index.data.states[i].provinces;
    if (members.length === 0) continue;
    const holder = state.provinces[members[0]].controller;
    if (members.every((id) => state.provinces[id].controller === holder)) {
      st.controller = holder;
    }
  }

  for (const d of state.divisions) {
    if (!d.dead && d.owner === country) removeDivision(state, d);
  }
  for (const combat of state.combats) {
    if (combat.ended) continue;
    if (combat.attackerCountry !== country && combat.defenderCountry !== country) continue;
    combat.ended = true;
    // Everyone still pointing at this battle must be released, including the
    // other side's divisions, or they stay locked to a combat that no longer
    // resolves and can never move again.
    for (const id of [...combat.attackers, ...combat.defenders]) {
      const d = state.divisions[id];
      if (d && d.combatId === combat.id) d.combatId = null;
    }
  }

  leaveFaction(state, country);
  c.economy.militaryFactories = 0;
  c.economy.civilianFactories = 0;
  c.economy.dockyards = 0;
  c.productionLines = [];
  c.constructionQueue = [];
  for (const line of c.atWarWith) {
    const other = state.countries[line];
    const i = other.atWarWith.indexOf(country);
    if (i >= 0) other.atWarWith.splice(i, 1);
  }
  c.atWarWith = [];

  state.worldTension = Math.min(100, state.worldTension + TENSION_PER_CAPITULATION);
  state.log.push({
    day: state.clock.totalDays,
    kind: 'capitulation',
    text: `${c.name} capitulates (${Math.round(occupation * 100)}% occupied)`,
    country,
  });
}

/**
 * Checks every country's surrender threshold; runs daily.
 *
 * A nation surrenders when it has lost most of what it is worth *and* its
 * capital has fallen. Requiring both matters: without the capital condition a
 * country folds while its government and core industry are still intact, and
 * the whole of Europe collapses in a single campaigning season. The
 * near-total-occupation clause is the escape hatch for a capital that cannot be
 * reached, so nobody becomes immortal.
 */
export const TOTAL_OCCUPATION = 0.95;

export function tickCapitulationDaily(state: GameState, ctx: DiplomacyContext): void {
  for (const c of state.countries) {
    if (c.capitulated || c.atWarWith.length === 0) continue;
    const ratio = occupationRatio(state, c.id);
    const capitalLost = state.provinces[c.capital]?.controller !== c.id;
    const beaten = (ratio >= c.surrenderLimit && capitalLost) || ratio >= TOTAL_OCCUPATION;
    if (beaten) capitulate(state, ctx, c.id);
  }
  closeSettledWars(state);
}

/** Marks a war over once one side has no belligerents left. */
export function closeSettledWars(state: GameState): void {
  for (const war of state.wars) {
    if (war.ended) continue;
    const liveAttackers = war.attackers.filter((id) => !state.countries[id].capitulated);
    const liveDefenders = war.defenders.filter((id) => !state.countries[id].capitulated);
    if (liveAttackers.length === 0 || liveDefenders.length === 0) war.ended = true;
  }
}

// ---------------------------------------------------------------------------
// World tension
// ---------------------------------------------------------------------------

export function tickTensionMonthly(state: GameState): void {
  const anyWar = state.wars.some((w) => !w.ended);
  if (!anyWar) {
    state.worldTension = Math.max(0, state.worldTension - TENSION_DECAY_PER_MONTH);
  }
}
