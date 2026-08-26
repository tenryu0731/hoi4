import { RESOURCE_TYPES } from '../core/types';
import { TRADE } from '../politics/lawData';
import { areAllied, atWar } from '../diplomacy/diplomacy';
import { computeResourceOutput } from './production';
import type { ProvinceIndex } from '../map/ProvinceIndex';
import type {
  Country, CountryId, GameState, ResourceType, TradeDeal,
} from '../core/types';
import type { TradeLaw } from '../politics/lawData';

/**
 * The world market.
 *
 * 「石油永久に不足するんだが？貿易制度欲しい」-- and it was: Germany's states
 * hold no oil at all, so a German campaign ran its armour on nothing from 1936
 * to the end and no mechanic in the game could change that. Every other major
 * had the same problem with something. A map that hands a country an ore it
 * has none of is only half an economy; the other half is being able to buy it.
 *
 * The deal is HOI4's, and it is a good one: civilian factories for materials.
 * The buyer commits factories, each of which buys a fixed daily quantity; those
 * factories leave the buyer's construction pool and join the seller's for as
 * long as the deal stands. So an import programme is paid for in the same
 * currency as a building programme, and choosing one is refusing the other.
 */

/**
 * Resources one committed civilian factory buys per day.
 *
 * HOI4's number, and the ratio that matters is the one against what a factory
 * *spends*: a military factory building rifles draws 2 steel a day here, the
 * same as it does there, so eight units is one traded factory keeping four
 * military ones fed. This was 2, which made it one for one -- 「貿易の民需に
 * 対する貿易品の量少ない」, and correctly so: committing a quarter of the
 * German civilian industry bought a quarter of the German military industry,
 * which is not a trade anyone would sign.
 *
 * It was 2 for a real reason, which is fixed below rather than paid for here.
 * A deal used to have to be a whole multiple of this rate, and the sellers on
 * this map are small -- the world's tungsten in 1936 is 13.9 units a day split
 * between six countries offering 1.3, 3.6, 1.2, 1.2, 0.8 and 2.4. Rounding
 * each of those down to a multiple of 8 leaves nothing, and rounding down to a
 * multiple of 2 left 6 of the 13.9. So the rate went down until the rounding
 * stopped hurting, and the trade went with it. `dealUnits` now ships whatever
 * the seller actually has instead, so the rate is free to be the right one.
 */
export const RESOURCE_PER_FACTORY = 8;

/**
 * The smallest share of a full load worth committing a factory to.
 *
 * A factory buys the rate or the seller's remainder, whichever is smaller, so
 * every producer is technically a seller now. A quarter-load is the line
 * between an offer and a rounding error: below it the panel does not list the
 * row and the AI does not cross the road, and above it the scarce resources --
 * whose producers are all small on this map -- stay reachable.
 */
export const MIN_TRADE_LOAD = 0.25;

export interface TradeContext {
  index: ProvinceIndex;
}

export function tradeLawOf(c: Country): TradeLaw {
  return c.laws.trade ?? 'export_focus';
}

export function exportShare(c: Country): number {
  return TRADE[tradeLawOf(c)].exportShare;
}

export function tradesOf(state: GameState): TradeDeal[] {
  if (!state.trades) state.trades = [];
  return state.trades;
}

function nextTradeId(state: GameState): number {
  const id = state.nextIds.trade ?? 1;
  state.nextIds.trade = id + 1;
  return id;
}

// ---------------------------------------------------------------------------
// What is on the market
// ---------------------------------------------------------------------------

/**
 * Whether goods can move between two countries at all.
 *
 * Being at war ends a trade, and so does being in a bloc at war with the other
 * side -- which is the blockade, modelled where it actually bites: Germany can
 * buy Romanian oil and Soviet ore in 1939 and cannot buy anything from the
 * Empire, and that is most of why the historical answer to its fuel problem
 * was a pact with Moscow rather than a purchase order.
 */
export function canTradeWith(state: GameState, buyer: CountryId, seller: CountryId): boolean {
  if (buyer === seller) return false;
  const a = state.countries[buyer];
  const b = state.countries[seller];
  if (!a || !b || a.capitulated || b.capitulated) return false;
  if (atWar(state, buyer, seller)) return false;
  // A neutral may sell to both sides; a belligerent may not sell to the enemy
  // of its own allies.
  for (const enemy of a.atWarWith) {
    if (areAllied(state, seller, enemy)) return false;
  }
  for (const enemy of b.atWarWith) {
    if (areAllied(state, buyer, enemy)) return false;
  }
  return true;
}

/**
 * What the seller digs up, before anyone buys any of it.
 *
 * Cached for the day. The underlying sum walks all 253 states, and the market
 * asks this question once per seller per resource per shopper: measured, the
 * uncached version took a simulated day from 12ms to 27ms, past the 16ms a
 * frame has to contain. What it depends on -- who controls which state, the
 * trade law, refining technology -- changes at most once a day, so a day is
 * exactly how long the answer is good for.
 */
const OUTPUT_CACHE = new WeakMap<GameState, {
  day: number;
  byCountry: Map<CountryId, Record<ResourceType, number>>;
}>();

export function tradableOutput(
  state: GameState, ctx: TradeContext, seller: CountryId,
): Record<ResourceType, number> {
  let cache = OUTPUT_CACHE.get(state);
  if (!cache || cache.day !== state.clock.totalDays) {
    cache = { day: state.clock.totalDays, byCountry: new Map() };
    OUTPUT_CACHE.set(state, cache);
  }
  const hit = cache.byCountry.get(seller);
  if (hit) return hit;

  const own = computeResourceOutput(state, ctx.index, seller);
  const share = exportShare(state.countries[seller]);
  const out = {} as Record<ResourceType, number>;
  for (const r of RESOURCE_TYPES) out[r] = own[r] * share;
  cache.byCountry.set(seller, out);
  return out;
}

/** Units of one resource this seller has still to sell today. */
export function availableFrom(
  state: GameState, ctx: TradeContext, seller: CountryId, resource: ResourceType,
): number {
  const pool = tradableOutput(state, ctx, seller)[resource];
  return Math.max(0, pool - soldBy(state, ctx, seller, resource));
}

/**
 * Units of one resource already promised to buyers.
 *
 * Bounded by the pool, because a promise larger than the mine is not a
 * promise: the deals share out what there is, oldest first, and the ones past
 * the end of it ship nothing.
 */
export function soldBy(
  state: GameState, ctx: TradeContext, seller: CountryId, resource: ResourceType,
): number {
  let want = 0;
  for (const d of tradesOf(state)) {
    if (d.seller === seller && d.resource === resource) want += d.factories * RESOURCE_PER_FACTORY;
  }
  return Math.min(tradableOutput(state, ctx, seller)[resource], want);
}

/**
 * What each standing deal actually ships today.
 *
 * A deal is priced in whole factories and paid in whatever the seller has: the
 * last factory of a purchase gets the remainder rather than nothing, which is
 * what lets the rate be HOI4's on a map whose miners are a tenth the size.
 * Shared out in list order so a seller whose output falls breaks its newest
 * promises rather than its oldest -- the same rule the daily trim already used.
 */
export function dealUnits(state: GameState, ctx: TradeContext): Map<number, number> {
  const out = new Map<number, number>();
  const claimed = new Map<string, number>();
  for (const d of tradesOf(state)) {
    const key = `${d.seller}:${d.resource}`;
    const used = claimed.get(key) ?? 0;
    const pool = tradableOutput(state, ctx, d.seller)[d.resource];
    const units = Math.max(0, Math.min(d.factories * RESOURCE_PER_FACTORY, pool - used));
    claimed.set(key, used + units);
    out.set(d.id, units);
  }
  return out;
}

/**
 * The part of a seller's output no state buying agency will take.
 *
 * Thirty AI governments shopping every week from 1936 clear the entire world
 * market before a player has opened the panel once: measured in April 1937,
 * every producer of every resource had between 0 and 1.8 units a day left,
 * all of it below what one factory buys, so the market read 「売り手がいません」
 * under all six headings for the rest of the campaign. Long-term contracts and
 * neutral shipping keep a share of every producer's output on the open market,
 * and this is that share. It is not a player privilege: it is reserved against
 * the AI, so a late-arriving AI buyer finds it too.
 */
export const OPEN_MARKET_SHARE = 0.3;

/** What an AI buyer is allowed to take from this seller today. */
export function availableToAI(
  state: GameState, ctx: TradeContext, seller: CountryId, resource: ResourceType,
): number {
  const pool = tradableOutput(state, ctx, seller)[resource];
  const cap = pool * (1 - OPEN_MARKET_SHARE);
  return Math.max(0, cap - soldBy(state, ctx, seller, resource));
}

/** Civilian factories the buyer has committed to the market. */
export function factoriesCommitted(state: GameState, buyer: CountryId): number {
  let n = 0;
  for (const d of tradesOf(state)) if (d.buyer === buyer) n += d.factories;
  return n;
}

/** Civilian factories buyers have handed this seller. */
export function factoriesEarned(state: GameState, seller: CountryId): number {
  let n = 0;
  for (const d of tradesOf(state)) if (d.seller === seller) n += d.factories;
  return n;
}

/** Daily imports and exports, by resource: what ships, not what was ordered. */
export function tradeFlow(
  state: GameState, ctx: TradeContext, country: CountryId,
): { imports: Record<ResourceType, number>; exports: Record<ResourceType, number> } {
  const imports = {} as Record<ResourceType, number>;
  const exports = {} as Record<ResourceType, number>;
  for (const r of RESOURCE_TYPES) { imports[r] = 0; exports[r] = 0; }
  const shipped = dealUnits(state, ctx);
  for (const d of tradesOf(state)) {
    const units = shipped.get(d.id) ?? 0;
    if (d.buyer === country) imports[d.resource] += units;
    if (d.seller === country) exports[d.resource] += units;
  }
  return { imports, exports };
}

// ---------------------------------------------------------------------------
// Opening and closing deals
// ---------------------------------------------------------------------------

/**
 * How many factories the buyer could still commit to this seller's resource.
 *
 * Bounded by three things at once: what the seller has left on the market,
 * what the buyer has spare after consumer goods and its existing purchases,
 * and whether the two are on speaking terms at all.
 */
export function maxPurchase(
  state: GameState, ctx: TradeContext,
  buyer: CountryId, seller: CountryId, resource: ResourceType,
): number {
  if (!canTradeWith(state, buyer, seller)) return 0;
  // Rounded up, not down: the factory that takes a seller's last three units
  // is a worse deal than one that takes eight, but it is a deal, and rounding
  // it away is what made the scarce resources untradeable at any rate above
  // two. The panel shows what will actually ship, so the choice is visible.
  const supply = Math.ceil(availableFrom(state, ctx, seller, resource) / RESOURCE_PER_FACTORY);
  const spare = Math.floor(state.countries[buyer].economy.freeCivilianFactories);
  return Math.max(0, Math.min(supply, spare));
}

/**
 * Commits factories to a purchase, merging into an existing deal for the same
 * seller and resource so the market does not fill with duplicate lines.
 */
export function openTrade(
  state: GameState, ctx: TradeContext,
  buyer: CountryId, seller: CountryId, resource: ResourceType, factories: number,
): boolean {
  const want = Math.floor(factories);
  if (want <= 0) return false;
  const allowed = Math.min(want, maxPurchase(state, ctx, buyer, seller, resource));
  if (allowed <= 0) return false;

  const list = tradesOf(state);
  const existing = list.find(
    (d) => d.buyer === buyer && d.seller === seller && d.resource === resource,
  );
  if (existing) existing.factories += allowed;
  else list.push({ id: nextTradeId(state), buyer, seller, resource, factories: allowed });
  // The factory leaves the construction pool the moment it is committed, not
  // at the next daily tick: a panel that lets the player spend the same
  // factory twice in one day is a panel that lies.
  state.countries[buyer].economy.freeCivilianFactories -= allowed;
  return true;
}

/** Releases factories from a deal; removes it when nothing is left. */
export function closeTrade(
  state: GameState, buyer: CountryId, seller: CountryId,
  resource: ResourceType, factories: number,
): boolean {
  const list = tradesOf(state);
  const i = list.findIndex(
    (d) => d.buyer === buyer && d.seller === seller && d.resource === resource,
  );
  if (i < 0) return false;
  const deal = list[i];
  const give = Math.min(deal.factories, Math.max(1, Math.floor(factories)));
  deal.factories -= give;
  state.countries[buyer].economy.freeCivilianFactories += give;
  if (deal.factories <= 0) list.splice(i, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Daily tick
// ---------------------------------------------------------------------------

/**
 * Keeps standing deals honest: a war, a capitulation or a lost oilfield all
 * end a purchase, and a seller whose output has fallen cannot go on shipping
 * what it no longer digs up.
 *
 * Runs before the economy, so the day's resource supply already reflects it.
 */
export function tickTradeDaily(state: GameState, ctx: TradeContext): void {
  const list = tradesOf(state);
  if (list.length === 0) return;

  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (!canTradeWith(state, d.buyer, d.seller)) { list.splice(i, 1); continue; }
    if (d.factories <= 0) { list.splice(i, 1); continue; }
  }

  // Hand back factories a deal is no longer using. What each deal ships is
  // already bounded by the seller's pool, so a mine that halves does not break
  // the contract -- it just delivers less. What it must not do is go on
  // charging the buyer for factories that bring nothing home, so each deal is
  // cut to the factories its actual delivery needs, and one that delivers
  // nothing is struck out below.
  const shipped = dealUnits(state, ctx);
  for (const d of list) {
    const units = shipped.get(d.id) ?? 0;
    const needed = Math.ceil(units / RESOURCE_PER_FACTORY);
    if (needed < d.factories) {
      state.countries[d.buyer].economy.freeCivilianFactories += d.factories - needed;
      d.factories = needed;
    }
  }

  // A buyer cannot hold more factories on the market than it owns.
  for (const c of state.countries) {
    const committed = factoriesCommitted(state, c.id);
    const owned = c.economy.civilianFactories + factoriesEarned(state, c.id);
    if (committed <= owned) continue;
    let excess = committed - owned;
    for (let i = list.length - 1; i >= 0 && excess > 0; i--) {
      const d = list[i];
      if (d.buyer !== c.id) continue;
      const take = Math.min(d.factories, excess);
      d.factories -= take;
      excess -= take;
    }
  }

  for (let i = list.length - 1; i >= 0; i--) if (list[i].factories <= 0) list.splice(i, 1);
}
