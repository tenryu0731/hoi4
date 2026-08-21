import { randRange } from '../core/rng';
import { INITIAL_RESISTANCE } from '../economy/occupation';
import { surrenderTolerance } from '../politics/politics';
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

/** Political power an ultimatum costs the power making it. */
export const DEMAND_COST = 55;
/** World tension added when a country is swallowed without a shot fired. */
export const TENSION_PER_ANNEXATION = 9;
/**
 * How many times stronger the demanding bloc must be before a victim gives in.
 *
 * The rolled threshold straddles this: the same ultimatum is accepted in one
 * campaign and refused in another, and a refusal is what turns Munich into a
 * war. An ideological cousin folds far sooner -- Austria in 1938 was not being
 * asked the same question as Czechoslovakia.
 */
export const DEMAND_STRENGTH_RATIO = 3;

/**
 * How much harder a focus presses than a bare ultimatum.
 *
 * Measured at 1: Germany in March 1938 does not clear the bar against Austria
 * -- the ratio of the two blocs is well under three -- so the Anschluss focus
 * completed and nothing happened, which is the bug this is here to fix.
 */
export const FOCUS_PERSUASION = 3.2;

/** A border strip is a smaller thing to ask for than the whole country. */
export const CESSION_EASE = 1.6;

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

/**
 * Combined military strength of a country and everyone obliged to fight beside
 * it. Every decision worth making -- attack, submit, underwrite -- is a
 * comparison of two of these, so it lives here rather than in the AI: the
 * numbers a country reasons about must be the numbers the war actually uses.
 */
export function blocStrength(state: GameState, country: CountryId): number {
  const c = state.countries[country];
  const members = c.factionId !== null ? state.factions[c.factionId].members : [country];
  let total = 0;
  for (const id of members) {
    const m = state.countries[id];
    if (!m.capitulated) total += m.stats.militaryStrength;
  }
  return Math.max(1, total);
}

/** Everyone underwriting `target` who is not already on `against`'s own side. */
export function guarantorsOf(
  state: GameState, target: CountryId, against: CountryId,
): CountryId[] {
  const out: CountryId[] = [];
  for (const c of state.countries) {
    if (c.capitulated || c.id === target || c.id === against) continue;
    if (areAllied(state, c.id, against)) continue;
    if (areAllied(state, c.id, target)) continue;
    if (c.diplomacy.guarantees.includes(target)) out.push(c.id);
  }
  return out;
}

/**
 * Strength that would actually turn up if `against` attacked `target`: the
 * victim's own bloc, plus its guarantors and their blocs.
 *
 * Leaving the guarantors out of this sum is how an AI walks into a world war it
 * had not counted: it prices Poland and gets Poland, France and the Empire.
 */
export function defendingStrength(
  state: GameState, target: CountryId, against: CountryId,
): number {
  let total = blocStrength(state, target);
  const counted = new Set<CountryId>();
  for (const g of guarantorsOf(state, target, against)) {
    const c = state.countries[g];
    const members = c.factionId !== null ? state.factions[c.factionId].members : [g];
    for (const id of members) {
      if (counted.has(id) || state.countries[id].capitulated) continue;
      counted.add(id);
      total += state.countries[id].stats.militaryStrength;
    }
  }
  return Math.max(1, total);
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
    if (!c.diplomacy.guarantees.includes(target)) continue;
    // A guarantor brings its bloc: the United Kingdom did not honour Poland
    // alone, and a guarantee that only binds the signatory is not one the
    // aggressor has any reason to price in.
    for (const member of sideOf(state, c.id)) {
      if (defenders.includes(member) || attackers.includes(member)) continue;
      defenders.push(member);
    }
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
    body: { k: 'warDeclared', attacker: a.tag, defender: t.tag },
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
    body: { k: 'joinedFaction', country: c.tag, faction: faction.name },
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
/**
 * How much of a country's own metropolitan territory is in enemy hands.
 *
 * Core provinces only. Britain's victory points include Egypt and Iraq, and
 * France's include Algeria and Syria, so measuring over everything a country
 * owns meant the entire metropole could be occupied while the ratio stayed
 * under the surrender threshold -- both were unconquerable by construction, and
 * every German win had to come from the 1948 points count rather than from a
 * fall of France.
 */
export function occupationRatio(state: GameState, country: CountryId): number {
  let owned = 0;
  let lost = 0;
  for (const p of state.provinces) {
    if (p.owner !== country || !p.core) continue;
    owned += p.vp;
    if (p.controller !== country) lost += p.vp;
  }
  return owned > 0 ? lost / owned : 1;
}

/**
 * Hands a country over: its territory passes to the victor, its army is
 * disbanded, and it leaves its faction. Without a hard transfer the map would
 * fill with zombie nations that hold ground but cannot act.
 *
 * Shared by the two ways a nation can leave the board -- beaten in the field,
 * or swallowed at the conference table -- because the bookkeeping either way is
 * identical and a second copy of it is a second place to get it wrong.
 */
function absorbCountry(
  state: GameState, ctx: DiplomacyContext, country: CountryId, victor: CountryId | null,
): void {
  const c = state.countries[country];
  c.capitulated = true;

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
      if (st.controller !== holder) {
        st.controller = holder;
        // Territory taken from a beaten country is occupied, not owned: it
        // resists until it is garrisoned. Without this, mass conquest through
        // capitulation -- which is how most territory changes hands -- never
        // raised any resistance at all.
        st.resistance = st.owner === holder ? 0 : INITIAL_RESISTANCE;
      }
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
}

/** Surrenders a country to whoever beat it. */
export function capitulate(
  state: GameState, ctx: DiplomacyContext, country: CountryId,
): void {
  const c = state.countries[country];
  if (c.capitulated) return;
  const occupation = occupationRatio(state, country);

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

  absorbCountry(state, ctx, country, victor);

  state.worldTension = Math.min(100, state.worldTension + TENSION_PER_CAPITULATION);
  state.log.push({
    day: state.clock.totalDays,
    kind: 'capitulation',
    body: { k: 'capitulated', country: c.tag, occupation },
    country,
  });
}

// ---------------------------------------------------------------------------
// Ultimatums
// ---------------------------------------------------------------------------

/**
 * Whether `demander` is even in a position to present an ultimatum.
 *
 * The bar is structural rather than numeric: a great power may lean on an
 * isolated small nation, and on nothing else. Anyone in a bloc, anyone with a
 * guarantor, and anyone big enough to be worth a campaign has to be fought --
 * and a claim the table wanted settled at a conference is simply left standing
 * rather than escalated, which is why underwriting Romania in 1939 keeps the
 * Soviet Union off it instead of provoking the war it was meant to prevent.
 */
export function canDemand(
  state: GameState, demander: CountryId, target: CountryId,
): boolean {
  const a = state.countries[demander];
  const t = state.countries[target];
  if (demander === target || a.capitulated || t.capitulated) return false;
  if (!a.major || t.major) return false;
  if (atWar(state, demander, target) || areAllied(state, demander, target)) return false;
  if (a.atWarWith.length > 0) return false;
  if (t.atWarWith.length > 0) return false;
  if (t.factionId !== null) return false;
  return guarantorsOf(state, target, demander).length === 0;
}

/**
 * Presents an ultimatum. Accepted, the target is annexed without a shot;
 * refused, the demander has spent its political capital and learned that this
 * one will have to be invaded.
 *
 * This is the mechanism the historical sequence turns on. Without it Germany
 * must fight for Austria and Czechoslovakia in 1938 with a peacetime army,
 * which it either loses or wins so slowly that 1939 arrives with the Wehrmacht
 * still in Bohemia -- and the campaign never becomes the war it is about.
 */
export function demandSubmission(
  state: GameState, ctx: DiplomacyContext, demander: CountryId, target: CountryId,
): boolean {
  if (!canDemand(state, demander, target)) return false;
  const a = state.countries[demander];
  if (a.economy.politicalPower < DEMAND_COST) return false;
  a.economy.politicalPower -= DEMAND_COST;

  if (!submits(state, demander, target, 1)) {
    refuse(state, demander, target);
    return false;
  }
  annex(state, ctx, demander, target);
  return true;
}

/**
 * Does the target fold?
 *
 * `persuasion` scales the bar a demand has to clear. An ultimatum bought with
 * political power presses at 1; a national focus presses harder, because what
 * it spends is two months of the whole government's attention and the
 * mobilisation everyone can see behind it.
 */
function submits(
  state: GameState, demander: CountryId, target: CountryId, persuasion: number,
): boolean {
  const a = state.countries[demander];
  const t = state.countries[target];
  const ratio = blocStrength(state, demander) / blocStrength(state, target);
  let threshold = randRange(state.rng, DEMAND_STRENGTH_RATIO * 0.8, DEMAND_STRENGTH_RATIO * 1.25);
  // A government that shares the demander's politics has a faction at home
  // arguing for union; one that does not has to be coerced outright.
  if (t.ideology === a.ideology) threshold *= 0.55;
  // Nobody folds to a power their people already loathe. Opinion is bounded to
  // +/-100, so this swings the bar by a quarter either way.
  threshold *= 1 - opinionOf(state, target, demander) / 400;
  return ratio >= threshold / Math.max(0.05, persuasion);
}

/** Refusal hardens the victim and puts everyone else on notice. */
function refuse(state: GameState, demander: CountryId, target: CountryId): void {
  adjustOpinion(state, target, demander, -30);
  for (const c of state.countries) {
    if (c.id === demander) continue;
    adjustOpinion(state, c.id, demander, -5);
  }
  state.worldTension = Math.min(100, state.worldTension + 3);
}

function annex(
  state: GameState, ctx: DiplomacyContext, demander: CountryId, target: CountryId,
): void {
  const t = state.countries[target];
  absorbCountry(state, ctx, target, demander);
  // Swallowed at the table rather than beaten in the field: the border moves
  // with the flag, so the annexed territory is owned, not merely occupied.
  // Left as occupation it would raise resistance forever and never pay, and
  // the Anschluss did not leave Austria a garrison problem.
  for (const p of state.provinces) {
    if (p.owner === target) { p.owner = demander; p.controller = demander; }
  }
  for (const st of state.states) {
    if (st.owner === target) { st.owner = demander; st.controller = demander; st.resistance = 0; }
  }
  for (const c of state.countries) {
    if (c.id === demander) continue;
    adjustOpinion(state, c.id, demander, -12);
  }
  state.worldTension = Math.min(100, state.worldTension + TENSION_PER_ANNEXATION);
  state.log.push({
    day: state.clock.totalDays,
    kind: 'capitulation',
    body: { k: 'annexed', country: t.tag, by: state.countries[demander].tag },
    country: target,
  });
}

/**
 * The demand a national focus makes: no political power, and it presses much
 * harder than an ordinary ultimatum.
 *
 * Returns whether the target folded. The caller decides what a refusal means
 * -- for the historical focuses it means a war goal, which is exactly what
 * happened when the guarantees were real.
 */
export function focusDemandAnnexation(
  state: GameState, ctx: DiplomacyContext, demander: CountryId, target: CountryId,
): boolean {
  if (!canDemand(state, demander, target)) return false;
  if (!submits(state, demander, target, FOCUS_PERSUASION)) {
    refuse(state, demander, target);
    return false;
  }
  annex(state, ctx, demander, target);
  return true;
}

/**
 * A partial cession: the border strip, not the country.
 *
 * The Sudetenland and Bessarabia were handed over whole states at a time under
 * exactly this kind of pressure, and the state is the tier the map keeps
 * industry and population on -- so a cession moves real weight without ending
 * anyone. Transfers up to `count` of the target's states that touch the
 * demander, nearest the border first.
 */
export function focusDemandCession(
  state: GameState, ctx: DiplomacyContext,
  demander: CountryId, target: CountryId, count: number,
): number {
  if (!canDemand(state, demander, target)) return 0;
  // Ceding a strip is a smaller ask than surrendering the state, so it clears
  // a lower bar than annexation does.
  if (!submits(state, demander, target, FOCUS_PERSUASION * CESSION_EASE)) {
    refuse(state, demander, target);
    return 0;
  }

  // States of the target that touch the demander, biggest first: the demand is
  // for the industrial border districts, not for a moor nobody wants.
  const touching: { id: number; weight: number }[] = [];
  for (let i = 0; i < state.states.length; i++) {
    const st = state.states[i];
    if (st.owner !== target || st.controller !== target) continue;
    const members = ctx.index.data.states[i].provinces;
    const borders = members.some(
      (pid) => ctx.index.provinces[pid]?.neighbors.some(
        (n) => state.provinces[n]?.owner === demander,
      ),
    );
    if (!borders) continue;
    const geo = ctx.index.data.states[i];
    touching.push({ id: i, weight: geo.manpower + st.civilianFactories * 400 });
  }
  touching.sort((a, b) => b.weight - a.weight || a.id - b.id);

  const taken = touching.slice(0, Math.max(0, count));
  if (taken.length === 0) return 0;
  for (const { id } of taken) {
    const st = state.states[id];
    st.owner = demander;
    st.controller = demander;
    st.resistance = 0;
    for (const pid of ctx.index.data.states[id].provinces) {
      const p = state.provinces[pid];
      if (!p) continue;
      p.owner = demander;
      p.controller = demander;
    }
  }
  for (const c of state.countries) {
    if (c.id === demander) continue;
    adjustOpinion(state, c.id, demander, -8);
  }
  state.worldTension = Math.min(100, state.worldTension + TENSION_PER_ANNEXATION * 0.6);
  state.log.push({
    day: state.clock.totalDays,
    kind: 'capitulation',
    body: {
      k: 'ceded',
      country: state.countries[target].tag,
      by: state.countries[demander].tag,
      states: taken.length,
    },
    country: target,
  });
  return taken.length;
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
    // War support moves the line. A nation that believes in the war holds on
    // past the point where one that does not has already asked for terms, so
    // the same map position surrenders a demoralised country and not a
    // determined one.
    const limit = c.surrenderLimit * surrenderTolerance(c);
    const beaten = (ratio >= limit && capitalLost) || ratio >= TOTAL_OCCUPATION;
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
