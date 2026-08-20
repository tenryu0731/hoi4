import { describe, expect, it } from 'vitest';

import {
  CONSCRIPTION, CONSCRIPTION_LAWS, ECONOMY, ECONOMY_LAWS, LAW_COST,
} from '../../src/sim/politics/lawData';
import {
  canChangeLaw, changeLaw, lawEffects, lawIndex, politicalPowerPerDay,
  surrenderTolerance, tension, tickPoliticsDaily,
} from '../../src/sim/politics/politics';
import { makeFixture } from './helpers/fixture';
import type { Country } from '../../src/sim/core/types';

const noOccupation = (_id: number) => 0;

describe('law ladders', () => {
  it('is a complete list on both ladders: every rung is known to the tests', () => {
    // The guard against a law being added that modifies nothing, which is the
    // failure mode this project keeps having to go back and delete.
    expect([...CONSCRIPTION_LAWS]).toEqual([
      'disarmed', 'volunteer', 'limited', 'extensive',
      'service_by_requirement', 'all_adults', 'scraping_the_barrel',
    ]);
    expect([...ECONOMY_LAWS]).toEqual([
      'undisturbed_isolation', 'isolation', 'civilian', 'early_mobilisation',
      'partial_mobilisation', 'war_economy', 'total_mobilisation',
    ]);
  });

  it('every rung differs from the one below it in something a player feels', () => {
    for (let i = 1; i < CONSCRIPTION_LAWS.length; i++) {
      const low = CONSCRIPTION[CONSCRIPTION_LAWS[i - 1]];
      const high = CONSCRIPTION[CONSCRIPTION_LAWS[i]];
      expect(high.fraction, CONSCRIPTION_LAWS[i]).toBeGreaterThan(low.fraction);
      expect(high.factoryPenalty).toBeGreaterThanOrEqual(low.factoryPenalty);
    }
    for (let i = 1; i < ECONOMY_LAWS.length; i++) {
      const low = ECONOMY[ECONOMY_LAWS[i - 1]];
      const high = ECONOMY[ECONOMY_LAWS[i]];
      expect(high.consumerGoods, ECONOMY_LAWS[i]).toBeLessThan(low.consumerGoods);
      expect(high.construction).toBeGreaterThan(low.construction);
      expect(high.output).toBeGreaterThan(low.output);
    }
  });

  it('costs political power, and refuses when there is none', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.economy.politicalPower = LAW_COST - 1;
    expect(canChangeLaw(f.state, ger, 'conscription', -1).reason).toBe('cost');
    expect(changeLaw(f.state, ger.id, 'conscription', -1)).toBe(false);

    ger.economy.politicalPower = LAW_COST + 10;
    const before = lawIndex(ger, 'conscription');
    expect(changeLaw(f.state, ger.id, 'conscription', -1)).toBe(true);
    expect(lawIndex(ger, 'conscription')).toBe(before - 1);
    expect(ger.economy.politicalPower).toBe(10);
  });

  it('stops at both ends of a ladder', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.economy.politicalPower = 9999;
    ger.laws.conscription = 'disarmed';
    expect(canChangeLaw(f.state, ger, 'conscription', -1).reason).toBe('end');
    ger.laws.economy = 'total_mobilisation';
    expect(canChangeLaw(f.state, ger, 'economy', 1).reason).toBe('end');
  });

  it('gates conscription on war support and economy on tension', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.economy.politicalPower = 9999;

    ger.laws.conscription = 'extensive';
    ger.warSupport = 0;
    expect(canChangeLaw(f.state, ger, 'conscription', 1).reason).toBe('war_support');
    ger.warSupport = 1;
    expect(canChangeLaw(f.state, ger, 'conscription', 1).allowed).toBe(true);

    ger.laws.economy = 'civilian';
    f.state.worldTension = 0;
    expect(canChangeLaw(f.state, ger, 'economy', 1).reason).toBe('tension');
    f.state.worldTension = 100;
    expect(canChangeLaw(f.state, ger, 'economy', 1).allowed).toBe(true);
  });

  it('reads world tension on the scale it is actually stored in', () => {
    // It is kept 0..100. Read as though it were 0..1 it saturates every gate
    // and every war-support target the moment any war starts.
    const f = makeFixture();
    f.state.worldTension = 50;
    expect(tension(f.state)).toBeCloseTo(0.5, 6);
    f.state.worldTension = 100;
    expect(tension(f.state)).toBe(1);
  });

  it('keeps total mobilisation for countries that are actually at war', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.economy.politicalPower = 9999;
    ger.laws.economy = 'war_economy';
    f.state.worldTension = 100;
    expect(canChangeLaw(f.state, ger, 'economy', 1).reason).toBe('needs_war');
    ger.atWarWith.push(f.country('POL').id);
    expect(canChangeLaw(f.state, ger, 'economy', 1).allowed).toBe(true);
  });

  it('will not let a democracy mobilise like a dictatorship in peacetime', () => {
    const f = makeFixture();
    const eng = f.country('ENG');
    eng.economy.politicalPower = 9999;
    eng.warSupport = 1;
    f.state.worldTension = 100;
    eng.laws.conscription = 'limited';
    expect(canChangeLaw(f.state, eng, 'conscription', 1).reason).toBe('democracy');
    // Being at war settles the argument.
    eng.atWarWith.push(f.country('GER').id);
    expect(canChangeLaw(f.state, eng, 'conscription', 1).allowed).toBe(true);
  });

  it('always allows standing back down', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.economy.politicalPower = 9999;
    ger.warSupport = 0;
    f.state.worldTension = 0;
    expect(canChangeLaw(f.state, ger, 'conscription', -1).allowed).toBe(true);
    expect(canChangeLaw(f.state, ger, 'economy', -1).allowed).toBe(true);
  });
});

describe('what the laws are worth', () => {
  it('turns the economy law into the consumer-goods share', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.stability = 1;
    for (const law of ECONOMY_LAWS) {
      ger.laws.economy = law;
      expect(lawEffects(ger).consumerGoods, law).toBeCloseTo(ECONOMY[law].consumerGoods, 6);
    }
  });

  it('makes an unstable country waste industry on itself', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.laws.economy = 'civilian';
    ger.stability = 1;
    const steady = lawEffects(ger).consumerGoods;
    ger.stability = 0;
    expect(lawEffects(ger).consumerGoods).toBeGreaterThan(steady);
  });

  it('takes hands off the factory floor as conscription rises', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.laws.conscription = 'volunteer';
    const light = lawEffects(ger).factoryStaffing;
    ger.laws.conscription = 'scraping_the_barrel';
    const heavy = lawEffects(ger).factoryStaffing;
    expect(heavy).toBeLessThan(light);
    expect(lawEffects(ger).conscriptionFraction)
      .toBeGreaterThan(CONSCRIPTION.volunteer.fraction);
  });

  it('buys political power with stability', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.stability = 0;
    const poor = politicalPowerPerDay(ger);
    ger.stability = 1;
    expect(politicalPowerPerDay(ger)).toBeGreaterThan(poor);
  });

  it('makes a determined nation harder to knock out', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.warSupport = 0;
    const brittle = surrenderTolerance(ger);
    ger.warSupport = 1;
    expect(surrenderTolerance(ger)).toBeGreaterThan(brittle);
  });
});

describe('stability and war support over time', () => {
  const run = (
    f: ReturnType<typeof makeFixture>, days: number,
    occ: (id: number) => number = noOccupation,
  ) => {
    for (let i = 0; i < days; i++) tickPoliticsDaily(f.state, occ);
  };

  it('leaves a quiet democracy stable and unwilling to fight', () => {
    const f = makeFixture();
    const eng = f.country('ENG');
    f.state.worldTension = 0;
    run(f, 400);
    expect(eng.stability).toBeGreaterThan(0.6);
    expect(eng.warSupport).toBeLessThan(0.25);
  });

  it('is being invaded, not being at war, that makes a nation total-war', () => {
    const f = makeFixture();
    const quiet = f.country('FRA');
    const overrun = f.country('POL');
    for (const c of [quiet, overrun]) c.atWarWith.push(f.country('GER').id);
    f.state.worldTension = 40;
    run(f, 400, (id: number) => (id === overrun.id ? 0.8 : 0));
    expect(overrun.warSupport).toBeGreaterThan(quiet.warSupport + 0.2);
    // And it costs the invaded government its grip.
    expect(overrun.stability).toBeLessThan(quiet.stability);
  });

  it('never leaves either figure outside 0..1', () => {
    const f = makeFixture();
    f.state.worldTension = 100;
    for (const c of f.state.countries) {
      c.laws.conscription = 'scraping_the_barrel';
      if (c.id !== 0) c.atWarWith.push(0);
    }
    run(f, 800, (_id: number) => 1);
    for (const c of f.state.countries as Country[]) {
      expect(c.stability, c.tag).toBeGreaterThanOrEqual(0);
      expect(c.stability, c.tag).toBeLessThanOrEqual(1);
      expect(c.warSupport, c.tag).toBeGreaterThanOrEqual(0);
      expect(c.warSupport, c.tag).toBeLessThanOrEqual(1);
    }
  });
});
