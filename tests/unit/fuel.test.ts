import { describe, expect, it } from 'vitest';

import {
  DRY_HARD_ATTACK, DRY_SPEED, fuelCapacity, fuelPenalty, fuelRatio, fuelShare,
  templateFuelUse, tickFuelDaily,
} from '../../src/sim/economy/fuel';
import { movementSpeed } from '../../src/sim/military/movement';
import { Simulation } from '../../src/sim/Simulation';
import { TimeEngine } from '../../src/sim/time/TimeEngine';
import { canTradeWith, maxPurchase, openTrade, tradeFlow } from '../../src/sim/economy/trade';
import { computeResourceOutput } from '../../src/sim/economy/production';
import { makeFixture } from './helpers/fixture';

describe('fuel', () => {
  it('is drawn by what actually burns it', () => {
    expect(templateFuelUse({ infantry_equipment: 600 })).toBe(0);
    expect(templateFuelUse({ motorized: 320 })).toBeGreaterThan(0);
    expect(templateFuelUse({ medium_armor: 150 }))
      .toBeGreaterThan(templateFuelUse({ light_armor: 150 }));
  });

  it('weights the shortage by how motorised a formation is', () => {
    // Support companies run on trucks, so every template in the game has a
    // non-zero draw. Gating the penalty on "draw > 0" crippled the infantry of
    // any country that ran dry -- measured as 100% of every army in Europe
    // being treated as armour.
    const f = makeFixture();
    const ger = f.country('GER');
    const foot = ger.templates.find((t) => t.name.includes('歩兵'))!;
    const tank = ger.templates.find((t) => t.name.includes('機甲'))!;
    expect(foot.fuelUse).toBeGreaterThan(0);
    expect(fuelShare(foot)).toBeLessThan(0.1);
    expect(fuelShare(tank)).toBe(1);

    expect(fuelPenalty(foot, 0, DRY_SPEED)).toBeGreaterThan(0.95);
    expect(fuelPenalty(tank, 0, DRY_SPEED)).toBeCloseTo(DRY_SPEED, 6);
    // A full tank is untouched whatever it is made of.
    expect(fuelPenalty(tank, 1, DRY_HARD_ATTACK)).toBe(1);
  });

  it('turns spare oil into fuel and books it against the resource', () => {
    const f = makeFixture();
    const sov = f.country('SOV');
    sov.economy.fuel = 0;
    sov.economy.resources.oil.produced = 60;
    sov.economy.resources.oil.consumed = 0;
    tickFuelDaily(f.state);
    expect(sov.economy.fuel).toBeGreaterThan(0);
    // Oil that became fuel is oil that was used; the resource panel and the
    // resource map mode both read this figure.
    expect(sov.economy.resources.oil.consumed).toBeGreaterThan(0);
  });

  it('never stores more than the country can hold', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.economy.fuel = fuelCapacity(ger);
    ger.economy.resources.oil.produced = 9999;
    ger.economy.resources.oil.consumed = 0;
    tickFuelDaily(f.state);
    expect(ger.economy.fuel).toBeLessThanOrEqual(fuelCapacity(ger));
  });

  it('runs a country dry when it has no oil, and only then', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    for (const c of f.state.countries) c.economy.resources.oil.produced = 0;
    ger.economy.fuel = 0;
    tickFuelDaily(f.state);
    expect(fuelRatio(ger)).toBeLessThan(1);

    ger.economy.fuel = 99999;
    tickFuelDaily(f.state);
    expect(fuelRatio(ger)).toBe(1);
  });

  it('slows the armour of a country that has run out', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const tank = ger.templates.find((t) => t.name.includes('機甲'))!;
    const div = f.state.divisions.find((d) => d.owner === ger.id && !d.dead)!;
    div.templateId = tank.id;
    const to = f.index.get(div.provinceId).neighbors[0];
    const ctx = { index: f.index } as never;

    ger.economy.fuelRatio = 1;
    const full = movementSpeed(f.state, ctx, div, to);
    ger.economy.fuelRatio = 0;
    const dry = movementSpeed(f.state, ctx, div, to);
    expect(dry / full).toBeCloseTo(DRY_SPEED, 4);
  });

  it('makes the countries with no wells depend on somebody else for fuel', () => {
    // The historical shape of the thing: Germany and Italy have no oil of
    // their own, the Soviet Union and Romania do.
    //
    // This used to assert flatly that both of them ran dry, which stopped
    // being true the moment a traded factory bought a useful quantity: two
    // years in, Italy imports 24 a day on three factories and is comfortable
    // while Germany imports nothing and is empty. Comfort has to be *paid
    // for* -- that is the claim worth holding, and it holds however the
    // campaign happens to fall out.
    const f = makeFixture();
    const sim = new Simulation(f.state, f.index);
    const time = new TimeEngine(f.state.clock.totalHours);
    time.on((c) => sim.tick(c));
    time.step(24 * 365 * 2);

    const ctx = { index: f.index };
    const ratio = (tag: string) => fuelRatio(f.country(tag));
    const wells = (tag: string) => computeResourceOutput(f.state, f.index, f.country(tag).id).oil;
    const bought = (tag: string) => tradeFlow(f.state, ctx, f.country(tag).id).imports.oil;

    for (const tag of ['GER', 'ITA']) {
      expect(wells(tag), tag).toBe(0);
      if (ratio(tag) >= 0.5) expect(bought(tag), `${tag} is comfortable`).toBeGreaterThan(0);
    }
    // Not vacuous: somebody on that list is actually going without.
    expect(Math.min(ratio('GER'), ratio('ITA'))).toBeLessThan(0.5);

    expect(wells('SOV')).toBeGreaterThan(0);
    expect(wells('ROM')).toBeGreaterThan(0);
    expect(ratio('SOV')).toBe(1);
    expect(ratio('ROM')).toBe(1);
  }, 60_000);

  it('lets a country with no wells buy some of its way out of the shortage', () => {
    // The other half, tested directly rather than left to whether the AI
    // happens to shop. Some of the way, not all of it: by 1938 the rest of
    // Europe has already contracted for the oil, and everything still on the
    // market is 4.8 a day between every seller who will deal with Germany --
    // which measures out at a fuel ratio of 0.00 before and 0.167 after. That
    // is the right shape for this one. Germany's fuel problem was not a
    // problem it could shop its way out of either.
    const f = makeFixture();
    const sim = new Simulation(f.state, f.index);
    const time = new TimeEngine(f.state.clock.totalHours);
    time.on((c) => sim.tick(c));
    time.step(24 * 365 * 2);

    const ctx = { index: f.index };
    const ger = f.country('GER');
    const before = fuelRatio(ger);
    expect(before).toBeLessThan(0.1);

    let factories = 0;
    for (const seller of f.state.countries) {
      if (seller.id === ger.id || !canTradeWith(f.state, ger.id, seller.id)) continue;
      const take = maxPurchase(f.state, ctx, ger.id, seller.id, 'oil');
      if (take > 0 && openTrade(f.state, ctx, ger.id, seller.id, 'oil', take)) factories += take;
    }
    expect(factories).toBeGreaterThan(0);
    expect(tradeFlow(f.state, ctx, ger.id).imports.oil).toBeGreaterThan(0);

    time.step(24 * 60);
    expect(fuelRatio(ger)).toBeGreaterThan(before + 0.1);
  }, 60_000);
});
