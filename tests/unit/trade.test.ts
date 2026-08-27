import { describe, expect, it } from 'vitest';

import { Simulation } from '../../src/sim/Simulation';
import { TimeEngine } from '../../src/sim/time/TimeEngine';
import {
  OPEN_MARKET_SHARE, RESOURCE_PER_FACTORY, availableFrom, availableToAI, canTradeWith,
  closeTrade, exportShare, factoriesCommitted, factoriesEarned, maxPurchase, openTrade,
  tickTradeDaily, tradeFlow, tradesOf,
} from '../../src/sim/economy/trade';
import { declareWar, joinFaction } from '../../src/sim/diplomacy/diplomacy';
import { tickEconomyDaily } from '../../src/sim/economy/production';
import { makeFixture } from './helpers/fixture';
import type { Fixture } from './helpers/fixture';

/**
 * The market.
 *
 * 「石油永久に不足するんだが？貿易制度欲しい」-- Germany's states hold no oil at
 * all, so before this existed a German campaign ran its armour dry from 1936
 * to the end with no mechanic anywhere in the game that could change it.
 */

function rig(seed = 11): Fixture {
  const f = makeFixture({ seed, playerTag: 'GER' });
  for (const c of f.state.countries) c.isAI = false;
  return f;
}

describe('the world market', () => {
  it('turns civilian factories into resources', () => {
    const f = rig();
    const ger = f.country('GER');
    const rom = f.country('ROM');
    tickEconomyDaily(f.state, { index: f.index });
    const civBefore = ger.economy.civilianFactories;
    const romBefore = rom.economy.civilianFactories;

    const ctx = { index: f.index };
    const pool = availableFrom(f.state, ctx, rom.id, 'oil');
    expect(pool).toBeGreaterThan(0);
    expect(openTrade(f.state, ctx, ger.id, rom.id, 'oil', 3)).toBe(true);

    // A factory buys the rate or the seller's remainder, whichever is smaller.
    // Romania is a small producer, so three factories take everything it has
    // on the market rather than three times the rate.
    const shipped = Math.min(3 * RESOURCE_PER_FACTORY, pool);
    expect(tradeFlow(f.state, ctx, ger.id).imports.oil).toBeCloseTo(shipped, 5);
    expect(tradeFlow(f.state, ctx, rom.id).exports.oil).toBeCloseTo(shipped, 5);
    expect(factoriesCommitted(f.state, ger.id)).toBe(3);
    expect(factoriesEarned(f.state, rom.id)).toBe(3);

    // The factory works for the seller until the deal ends. That is the whole
    // trade -- industry now against materials now -- and if it were free there
    // would be no decision to make.
    tickEconomyDaily(f.state, { index: f.index });
    expect(ger.economy.civilianFactories).toBe(civBefore - 3);
    expect(rom.economy.civilianFactories).toBe(romBefore + 3);
  });

  it('gives a country with no oilfields fuel it could not otherwise have', () => {
    const f = rig();
    const ger = f.country('GER');
    const rom = f.country('ROM');
    const ctx = { index: f.index };
    tickEconomyDaily(f.state, ctx);
    expect(ger.economy.resources.oil.produced).toBe(0);

    const pool = availableFrom(f.state, ctx, rom.id, 'oil');
    openTrade(f.state, ctx, ger.id, rom.id, 'oil', 4);
    tickEconomyDaily(f.state, ctx);
    expect(ger.economy.resources.oil.produced)
      .toBeCloseTo(Math.min(4 * RESOURCE_PER_FACTORY, pool), 5);
    expect(ger.economy.resources.oil.produced).toBeGreaterThan(0);
  });

  it('will not sell more than the trade law puts on the market', () => {
    const f = rig();
    const ctx = { index: f.index };
    // The free-factory count is cached by the economy tick, and a buyer with
    // nothing cached cannot commit anything.
    tickEconomyDaily(f.state, ctx);
    const rom = f.country('ROM');
    const pool = availableFrom(f.state, ctx, rom.id, 'oil');
    // Buying the lot leaves nothing behind, and the next buyer is told so.
    // Rounded up, because the last factory takes the remainder rather than
    // leaving it stranded -- which is the whole reason the rate can be 8.
    const all = Math.ceil(pool / RESOURCE_PER_FACTORY);
    openTrade(f.state, ctx, f.country('GER').id, rom.id, 'oil', all);
    expect(availableFrom(f.state, ctx, rom.id, 'oil')).toBe(0);
    expect(openTrade(f.state, ctx, f.country('ITA').id, rom.id, 'oil', 1)).toBe(false);

    // However many factories are pointed at it, a mine ships what it digs up.
    expect(tradeFlow(f.state, ctx, rom.id).exports.oil).toBeCloseTo(pool, 5);

    // And the share is the trade law's, not the whole of production.
    expect(exportShare(rom)).toBeGreaterThan(0);
    expect(exportShare(rom)).toBeLessThan(1);
  });

  it('lets one factory take a remainder too small for a full load', () => {
    const f = rig();
    const ctx = { index: f.index };
    tickEconomyDaily(f.state, ctx);
    const rom = f.country('ROM');
    const pool = availableFrom(f.state, ctx, rom.id, 'oil');
    // A seller with less than one factory-load left. This is the case the old
    // rate existed to avoid: at 8 units a factory and a floor, the world's
    // tungsten -- six producers offering 1.3, 3.6, 1.2, 1.2, 0.8 and 2.4 --
    // was untradeable in its entirety.
    const nearlyAll = Math.floor(pool / RESOURCE_PER_FACTORY);
    if (nearlyAll > 0) {
      openTrade(f.state, ctx, f.country('GER').id, rom.id, 'oil', nearlyAll);
    }
    const left = availableFrom(f.state, ctx, rom.id, 'oil');
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(RESOURCE_PER_FACTORY);

    expect(maxPurchase(f.state, ctx, f.country('ITA').id, rom.id, 'oil')).toBeGreaterThan(0);
    expect(openTrade(f.state, ctx, f.country('ITA').id, rom.id, 'oil', 1)).toBe(true);
    expect(tradeFlow(f.state, ctx, f.country('ITA').id).imports.oil).toBeCloseTo(left, 5);
  });

  it('hands back a factory a shrunken deal is no longer using', () => {
    const f = rig();
    const ctx = { index: f.index };
    tickEconomyDaily(f.state, ctx);
    const ger = f.country('GER');
    const rom = f.country('ROM');
    const pool = availableFrom(f.state, ctx, rom.id, 'oil');
    const bought = Math.ceil(pool / RESOURCE_PER_FACTORY);
    expect(openTrade(f.state, ctx, ger.id, rom.id, 'oil', bought)).toBe(true);

    // Romania loses most of its wells. The contract is not broken -- it simply
    // ships less -- but the factories it no longer needs go back to Germany
    // rather than sitting on the market buying nothing.
    for (const st of f.state.states) {
      if (st && st.controller === rom.id) st.controller = f.country('SOV').id;
    }
    const free = ger.economy.freeCivilianFactories;
    // What a country has on the market is cached for the day it was computed,
    // so the loss is not visible until the calendar moves.
    f.state.clock.totalDays += 1;
    tickTradeDaily(f.state, ctx);
    const deal = f.state.trades!.find((d) => d.buyer === ger.id && d.seller === rom.id);
    expect(deal?.factories ?? 0).toBeLessThan(bought);
    expect(ger.economy.freeCivilianFactories).toBeGreaterThan(free);
  });

  it('keeps part of every producer open to a buyer who arrives late', () => {
    const f = rig();
    const ctx = { index: f.index };
    const rom = f.country('ROM');
    const pool = availableFrom(f.state, ctx, rom.id, 'oil');
    const forAI = availableToAI(f.state, ctx, rom.id, 'oil');
    expect(forAI).toBeCloseTo(pool * (1 - OPEN_MARKET_SHARE), 5);
    expect(forAI).toBeLessThan(pool);
  });

  it('ends a deal when the two countries go to war', () => {
    const f = rig();
    const ctx = { index: f.index };
    const ger = f.country('GER');
    const sov = f.country('SOV');
    tickEconomyDaily(f.state, ctx);
    openTrade(f.state, ctx, ger.id, sov.id, 'oil', 2);
    expect(tradesOf(f.state).length).toBe(1);

    declareWar(f.state, ger.id, sov.id);
    expect(canTradeWith(f.state, ger.id, sov.id)).toBe(false);

    const sim = new Simulation(f.state, f.index);
    const time = new TimeEngine(f.state.clock.totalHours);
    time.on((c) => sim.tick(c));
    time.step(24);
    expect(tradesOf(f.state).length).toBe(0);
  });

  it('will not sell to the enemy of an ally', () => {
    const f = rig();
    const ger = f.country('GER');
    const eng = f.country('ENG');
    const fra = f.country('FRA');
    const allies = f.state.factions.find((x) => x.name === 'Allies')!;
    joinFaction(f.state, eng.id, allies.id);
    joinFaction(f.state, fra.id, allies.id);
    expect(canTradeWith(f.state, ger.id, eng.id)).toBe(true);

    declareWar(f.state, ger.id, fra.id);

    // Britain never declared anything, but its bloc is at war with Germany --
    // which is the blockade, modelled where it actually bites, and most of why
    // the historical answer to the fuel problem was a pact with Moscow rather
    // than a purchase order to London.
    expect(canTradeWith(f.state, ger.id, fra.id)).toBe(false);
    expect(canTradeWith(f.state, ger.id, eng.id)).toBe(false);
    // Neutrals still sell to both sides.
    expect(canTradeWith(f.state, ger.id, f.country('ROM').id)).toBe(true);
  });

  it('hands the factories back when a purchase is closed', () => {
    const f = rig();
    const ctx = { index: f.index };
    const ger = f.country('GER');
    const rom = f.country('ROM');
    tickEconomyDaily(f.state, ctx);
    const before = ger.economy.civilianFactories;

    openTrade(f.state, ctx, ger.id, rom.id, 'oil', 2);
    tickEconomyDaily(f.state, ctx);
    expect(ger.economy.civilianFactories).toBe(before - 2);

    closeTrade(f.state, ger.id, rom.id, 'oil', 2);
    tickEconomyDaily(f.state, ctx);
    expect(ger.economy.civilianFactories).toBe(before);
    expect(tradesOf(f.state).length).toBe(0);
  });

  it('never lets a country commit factories it does not have', () => {
    const f = rig();
    const ctx = { index: f.index };
    const alb = f.country('ALB');
    tickEconomyDaily(f.state, ctx);
    const spare = Math.floor(alb.economy.freeCivilianFactories);
    openTrade(f.state, ctx, alb.id, f.country('SOV').id, 'oil', spare + 50);
    expect(factoriesCommitted(f.state, alb.id)).toBeLessThanOrEqual(spare);
  });
});
