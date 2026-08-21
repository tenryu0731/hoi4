import { describe, expect, it } from 'vitest';

import {
  AIR_SUPERIORITY_BONUS, airAdvantage, airMultiplier, airStrength, tickAirDaily,
} from '../../src/sim/military/air';
import { Simulation } from '../../src/sim/Simulation';
import { TimeEngine } from '../../src/sim/time/TimeEngine';
import { makeFixture } from './helpers/fixture';

describe('air power', () => {
  it('is nothing at all without aircraft', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.economy.stockpile.fighter = 0;
    ger.economy.stockpile.cas = 0;
    expect(airStrength(f.state, ger.id)).toBe(0);
  });

  it('does not saturate, so a bigger air force is always worth more', () => {
    // A hard cap on each side made both clip to full coverage and cancel:
    // Britain's 827 points and Germany's 80 measured an advantage of 0.000.
    const f = makeFixture();
    const ger = f.country('GER');
    const eng = f.country('ENG');
    ger.economy.stockpile.fighter = 80;
    eng.economy.stockpile.fighter = 827;
    const small = airAdvantage(f.state, eng.id, ger.id, 10);
    expect(small).toBeGreaterThan(0.3);

    eng.economy.stockpile.fighter = 2000;
    expect(airAdvantage(f.state, eng.id, ger.id, 10)).toBeGreaterThan(small);
  });

  it('is measured against the size of the battle', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const eng = f.country('ENG');
    ger.economy.stockpile.fighter = 0;
    eng.economy.stockpile.fighter = 300;
    // The same air force is worth more over a small battle than a large one.
    const overSmall = airAdvantage(f.state, eng.id, ger.id, 2);
    const overLarge = airAdvantage(f.state, eng.id, ger.id, 40);
    expect(overSmall).toBeGreaterThan(overLarge);
  });

  it('is symmetric: what one side gains the other loses', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const eng = f.country('ENG');
    ger.economy.stockpile.fighter = 100;
    eng.economy.stockpile.fighter = 400;
    const a = airAdvantage(f.state, eng.id, ger.id, 10);
    expect(airAdvantage(f.state, ger.id, eng.id, 10)).toBeCloseTo(-a, 10);
    expect(airMultiplier(a) + airMultiplier(-a)).toBeCloseTo(2, 10);
    expect(airMultiplier(1)).toBeCloseTo(1 + AIR_SUPERIORITY_BONUS, 10);
  });

  it('wears aircraft out only while the country is fighting', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.economy.stockpile.fighter = 1000;
    ger.atWarWith = [];
    tickAirDaily(f.state);
    expect(ger.economy.stockpile.fighter).toBe(1000);

    ger.atWarWith = [f.country('POL').id];
    tickAirDaily(f.state);
    expect(ger.economy.stockpile.fighter).toBeLessThan(1000);
  });

  it('gives aluminium a consumer', () => {
    // Measured before there was an air layer: 211,856 aluminium produced
    // against 10,547 consumed over a campaign -- 95% of Europe's supply fed an
    // item with all-zero combat stats that nothing ever read.
    const f = makeFixture();
    const sim = new Simulation(f.state, f.index);
    const time = new TimeEngine(f.state.clock.totalHours);
    time.on((c) => sim.tick(c));
    time.step(24 * 365 * 3);

    const majors = ['GER', 'ENG', 'FRA'].map((t) => f.country(t));
    const built = majors.reduce((n, c) => n + (c.economy.stockpile.fighter ?? 0), 0);
    expect(built).toBeGreaterThan(0);
    const consumed = majors.reduce((n, c) => n + c.economy.resources.aluminium.consumed, 0);
    expect(consumed).toBeGreaterThan(0);
  }, 60_000);
});
