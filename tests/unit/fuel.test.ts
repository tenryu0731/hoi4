import { describe, expect, it } from 'vitest';

import {
  DRY_HARD_ATTACK, DRY_SPEED, fuelCapacity, fuelPenalty, fuelRatio, fuelShare,
  templateFuelUse, tickFuelDaily,
} from '../../src/sim/economy/fuel';
import { movementSpeed } from '../../src/sim/military/movement';
import { Simulation } from '../../src/sim/Simulation';
import { TimeEngine } from '../../src/sim/time/TimeEngine';
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

  it('leaves Germany short and the oil powers comfortable', () => {
    // The historical shape of the thing: Germany and Italy have no oil of
    // their own, the Soviet Union, Romania and Britain do.
    const f = makeFixture();
    const sim = new Simulation(f.state, f.index);
    const time = new TimeEngine(f.state.clock.totalHours);
    time.on((c) => sim.tick(c));
    time.step(24 * 365 * 2);

    const ratio = (tag: string) => fuelRatio(f.country(tag));
    expect(ratio('GER')).toBeLessThan(0.5);
    expect(ratio('ITA')).toBeLessThan(0.5);
    expect(ratio('SOV')).toBe(1);
    expect(ratio('ROM')).toBe(1);
  }, 60_000);
});
