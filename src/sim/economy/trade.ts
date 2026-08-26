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
 * HOI4 uses 8, but its world holds an order of magnitude more of everything --
 * its Germany mines around 500 steel where this one mines 41. At 8 the whole
 * world's tradable oil was four factories' worth, and the leftovers after the
 * first buyer were unsellable: measured in 1937, Italy faced a 20-a-day oil
 * deficit with 19 spare factories and five willing sellers offering 1.6, 4.5,
 * 2.5, 2.0 and 1.0 -- every one of them below the granularity, so it bought
 * nothing at all for six years. Two is the same trade scaled to this map.
 */
export const RESOURCE_PER_FACTORY = 2;

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
  return Math.max(0, pool - soldBy(state, seller, resource));
}

/** Units of one resource already promised to buyers. */
export function soldBy(state: GameState, seller: CountryId, resource: ResourceType): number {
  let sold = 0;
  for (const d of tradesOf(state)) {
    if (d.seller === seller && d.resource === resource) sold += d.factories * RESOURCE_PER_FACTORY;
  }
  return sold;
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
  return Math.max(0, cap - soldBy(state, seller, resource));
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

/** Daily imports and exports, by resource. */
export function tradeFlow(
  state: GameState, country: CountryId,
): { imports: Record<ResourceType, number>; exports: Record<ResourceType, number> } {
  const imports = {} as Record<ResourceType, number>;
  const exports = {} as Record<ResourceType, number>;
  for (const r of RESOURCE_TYPES) { imports[r] = 0; exports[r] = 0; }
  for (const d of tradesOf(state)) {
    const units = d.factories * RESOURCE_PER_FACTORY;
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
  const supply = Math.floor(availableFrom(state, ctx, seller, resource) / RESOURCE_PER_FACTORY);
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

  // Trim each seller back to what it can actually ship, oldest deal first: a
  // country that loses its mines breaks its newest promises, not its oldest.
  for (const seller of state.countries) {
    const pools = tradableOutput(state, ctx, seller.id);
    for (const r of RESOURCE_TYPES) {
      let budget = pools[r];
      for (const d of list) {
        if (d.seller !== seller.id || d.resource !== r) continue;
        const affordable = Math.floor(budget / RESOURCE_PER_FACTORY);
        if (d.factories > affordable) d.factories = Math.max(0, affordable);
        budget -= d.factories * RESOURCE_PER_FACTORY;
      }
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
