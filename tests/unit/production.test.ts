import { describe, expect, it } from 'vitest';

import {
  addProductionLine, buildingLevel, canQueueBuilding, computeResourceOutput,
  freeCivilianFactories, queueBuilding, recomputeFactories, setLineFactories,
  tickEconomyDaily,
} from '../../src/sim/economy/production';
import {
  BASE_EFFICIENCY, BUILDING_CAP, BUILDING_COST, EQUIPMENT, FACTORY_OUTPUT,
} from '../../src/sim/core/data';
import { RESOURCE_TYPES, type EquipmentType } from '../../src/sim/core/types';
import { lawEffects } from '../../src/sim/politics/politics';
import { makeFixture } from './helpers/fixture';

function runDays(f: ReturnType<typeof makeFixture>, days: number): void {
  for (let i = 0; i < days; i++) tickEconomyDaily(f.state, { index: f.index });
}

describe('resource output', () => {
  it('sums only the states a country controls', () => {
    const f = makeFixture();
    const rom = f.country('ROM');
    const before = computeResourceOutput(f.state, f.index, rom.id);
    expect(before.oil).toBeGreaterThan(0);

    // Hand every Romanian state to Germany.
    const ger = f.country('GER');
    for (const s of f.state.states) if (s.controller === rom.id) s.controller = ger.id;

    expect(computeResourceOutput(f.state, f.index, rom.id).oil).toBe(0);
    expect(computeResourceOutput(f.state, f.index, ger.id).oil)
      .toBeGreaterThanOrEqual(before.oil);
  });

  it('reports non-negative flows for every resource', () => {
    const f = makeFixture();
    runDays(f, 5);
    for (const c of f.state.countries) {
      for (const r of RESOURCE_TYPES) {
        const flow = c.economy.resources[r];
        expect(flow.produced).toBeGreaterThanOrEqual(0);
        expect(flow.consumed).toBeGreaterThanOrEqual(0);
        expect(flow.deficit).toBeGreaterThanOrEqual(0);
        expect(flow.consumed).toBeLessThanOrEqual(flow.produced + 1e-9);
      }
    }
  });
});

describe('factory accounting', () => {
  it('derives factory totals from controlled states', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    recomputeFactories(f.state, ger.id);
    let expected = 0;
    for (const s of f.state.states) if (s.controller === ger.id) expected += s.civilianFactories;
    expect(ger.economy.civilianFactories).toBe(expected);
  });

  it('never leaves more factories assigned than the country owns', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const line = ger.productionLines[0];
    setLineFactories(ger, line.id, 999);
    const assigned = ger.productionLines.reduce((s, l) => s + l.assignedFactories, 0);
    expect(assigned).toBeLessThanOrEqual(ger.economy.militaryFactories);
  });

  it('strips factories from low-priority lines when industry is lost', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const sov = f.country('SOV');
    ger.productionLines.forEach((l, i) => { l.priority = (i === 0 ? 3 : 0) as 0 | 3; });
    setLineFactories(ger, ger.productionLines[0].id, ger.economy.militaryFactories);

    for (const s of f.state.states) if (s.controller === ger.id) s.controller = sov.id;
    recomputeFactories(f.state, ger.id);

    expect(ger.economy.militaryFactories).toBe(0);
    const assigned = ger.productionLines.reduce((s, l) => s + l.assignedFactories, 0);
    expect(assigned).toBe(0);
  });

  it('reserves consumer goods before construction', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.economy.civilianFactories = 20;
    ger.economy.consumerGoodsRatio = 0.3;
    expect(freeCivilianFactories(ger)).toBe(14);

    ger.economy.consumerGoodsRatio = 1;
    expect(freeCivilianFactories(ger)).toBe(0);

    ger.economy.consumerGoodsRatio = 0;
    expect(freeCivilianFactories(ger)).toBe(20);
  });
});

describe('equipment production', () => {
  it('matches the closed-form output when resources are plentiful', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    // One line, fixed efficiency, no research, no shortage.
    ger.productionLines = [];
    ger.research.levels.industry = 0;
    const line = addProductionLine(f.state, ger, 'infantry_equipment');
    line.efficiency = 0.4;
    line.efficiencyCap = 0.4;   // pinned, so growth cannot move it
    setLineFactories(ger, line.id, 10);
    ger.economy.stockpile.infantry_equipment = 0;

    // Give it a resource surplus so allocation is never the limiting factor.
    for (const s of f.state.states) {
      if (s.controller === ger.id) continue;
      s.controller = ger.id;
    }
    recomputeFactories(f.state, ger.id);
    setLineFactories(ger, line.id, 10);

    const days = 50;
    runDays(f, days);

    // The economy law is part of the closed form now: a mobilised economy gets
    // more out of the same plant, and conscription takes hands off the floor.
    const laws = lawEffects(ger);
    const perDay = 10 * FACTORY_OUTPUT * 0.4 * laws.output * laws.factoryStaffing;
    const expected = Math.floor((perDay * days) / EQUIPMENT.infantry_equipment.cost);
    expect(ger.economy.stockpile.infantry_equipment).toBeGreaterThanOrEqual(expected - 1);
    expect(ger.economy.stockpile.infantry_equipment).toBeLessThanOrEqual(expected + 1);
  });

  it('produces nothing with no factories assigned', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.productionLines = [];
    const line = addProductionLine(f.state, ger, 'artillery');
    setLineFactories(ger, line.id, 0);
    ger.economy.stockpile.artillery = 0;
    runDays(f, 30);
    expect(ger.economy.stockpile.artillery).toBe(0);
  });

  it('grows efficiency toward the cap and never past it', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.productionLines = [];
    const line = addProductionLine(f.state, ger, 'infantry_equipment');
    setLineFactories(ger, line.id, 5);
    expect(line.efficiency).toBeCloseTo(BASE_EFFICIENCY, 6);

    runDays(f, 10);
    const after10 = line.efficiency;
    expect(after10).toBeGreaterThan(BASE_EFFICIENCY);

    runDays(f, 2000);
    expect(line.efficiency).toBeLessThanOrEqual(line.efficiencyCap + 1e-9);
    expect(line.efficiency).toBeGreaterThan(line.efficiencyCap * 0.95);
  });

  it('decays efficiency on an idle line', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.productionLines = [];
    const line = addProductionLine(f.state, ger, 'infantry_equipment');
    setLineFactories(ger, line.id, 5);
    runDays(f, 200);
    const peak = line.efficiency;

    setLineFactories(ger, line.id, 0);
    runDays(f, 20);
    expect(line.efficiency).toBeLessThan(peak);
    expect(line.efficiency).toBeGreaterThanOrEqual(BASE_EFFICIENCY);
  });

  it('slows a line that cannot get its resources', () => {
    const build = (rubberAvailable: boolean) => {
      const g = makeFixture();
      const c = g.country('GER');
      c.productionLines = [];
      c.research.levels.industry = 0;
      const l = addProductionLine(g.state, c, 'motorized');   // needs steel + rubber
      l.efficiency = 0.4;
      l.efficiencyCap = 0.4;
      setLineFactories(c, l.id, 10);
      c.economy.stockpile.motorized = 0;

      // Rubber only reaches Germany through the Dutch East Indies trade, which
      // this scenario models as Dutch state output.
      if (rubberAvailable) {
        const hol = g.state.countries.find((x) => x.tag === 'HOL')!;
        for (const s of g.state.states) if (s.controller === hol.id) s.controller = c.id;
      }
      for (let i = 0; i < 40; i++) tickEconomyDaily(g.state, { index: g.index });
      return c.economy.stockpile.motorized;
    };

    expect(build(false)).toBeLessThan(build(true));
  });

  it('serves higher-priority lines first when a resource is scarce', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.productionLines = [];
    const high = addProductionLine(f.state, ger, 'medium_armor');
    const low = addProductionLine(f.state, ger, 'medium_armor');
    high.priority = 3;
    low.priority = 0;
    high.efficiency = low.efficiency = 0.4;
    high.efficiencyCap = low.efficiencyCap = 0.4;
    const half = Math.floor(ger.economy.militaryFactories / 2);
    setLineFactories(ger, high.id, half);
    setLineFactories(ger, low.id, half);
    ger.economy.stockpile.medium_armor = 0;

    runDays(f, 60);
    // Both lines have the same factories; only priority separates them.
    expect(high.efficiency).toBeGreaterThanOrEqual(low.efficiency);
  });
});

describe('construction', () => {
  it('completes a factory after the expected number of days', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.constructionQueue = [];
    ger.economy.consumerGoodsRatio = 0;
    recomputeFactories(f.state, ger.id);

    const stateId = f.index.get(ger.capital).stateId;
    const before = buildingLevel(f.state, stateId, 'military_factory');
    expect(queueBuilding(f.state, ger, stateId, 'military_factory')).toBe(true);

    const infra = f.state.states[stateId].infrastructure;
    const perDay = Math.min(15, freeCivilianFactories(ger)) * FACTORY_OUTPUT
      * (1 + (infra - 1) * 0.1) * lawEffects(ger).construction;
    const expectedDays = Math.ceil(BUILDING_COST.military_factory / perDay);

    runDays(f, expectedDays - 1);
    expect(buildingLevel(f.state, stateId, 'military_factory')).toBe(before);
    runDays(f, 2);
    expect(buildingLevel(f.state, stateId, 'military_factory')).toBe(before + 1);
    expect(ger.constructionQueue.length).toBe(0);
  });

  it('builds nothing without free civilian factories', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.constructionQueue = [];
    const stateId = f.index.get(ger.capital).stateId;
    queueBuilding(f.state, ger, stateId, 'civilian_factory');
    // Consumer goods drift back toward the peacetime target each day, so pin
    // the ratio rather than setting it once.
    for (let i = 0; i < 200; i++) {
      ger.economy.consumerGoodsRatio = 1;
      tickEconomyDaily(f.state, { index: f.index });
    }
    expect(ger.constructionQueue.length).toBe(1);
    expect(ger.constructionQueue[0].progress).toBe(0);
  });

  it('follows the economy law rather than the war, and takes months to do it', () => {
    // This used to assert that the consumer-goods share fell on its own the
    // moment a war started and rose again when it ended. That behaviour is
    // gone on purpose: mobilising the economy is the player's decision now,
    // and a country that never passes a law never mobilises however long it
    // fights.
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');

    ger.atWarWith.push(pol.id);
    runDays(f, 400);
    expect(ger.economy.consumerGoodsRatio)
      .toBeCloseTo(lawEffects(ger).consumerGoods, 2);

    // Passing one moves it, over months rather than overnight.
    ger.economy.politicalPower = 999;
    ger.laws.economy = 'war_economy';
    const target = lawEffects(ger).consumerGoods;
    runDays(f, 5);
    expect(ger.economy.consumerGoodsRatio).toBeGreaterThan(target);
    runDays(f, 200);
    expect(ger.economy.consumerGoodsRatio).toBeCloseTo(target, 2);
    expect(freeCivilianFactories(ger)).toBeGreaterThan(0);
  });

  it('shares one slot pool between civilian and military factories', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.constructionQueue = [];
    const stateId = f.index.get(ger.capital).stateId;
    const st = f.state.states[stateId];
    st.buildingSlots = st.civilianFactories + st.militaryFactories + 1;

    expect(canQueueBuilding(f.state, ger, stateId, 'military_factory')).toBe(true);
    expect(queueBuilding(f.state, ger, stateId, 'military_factory')).toBe(true);
    // The single free slot is now spoken for, for either kind.
    expect(canQueueBuilding(f.state, ger, stateId, 'military_factory')).toBe(false);
    expect(canQueueBuilding(f.state, ger, stateId, 'civilian_factory')).toBe(false);
  });

  it('caps dockyards and infrastructure independently', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.constructionQueue = [];
    const stateId = f.index.get(ger.capital).stateId;
    f.state.states[stateId].infrastructure = BUILDING_CAP.infrastructure;
    expect(canQueueBuilding(f.state, ger, stateId, 'infrastructure')).toBe(false);

    f.state.states[stateId].dockyards = BUILDING_CAP.dockyard;
    expect(canQueueBuilding(f.state, ger, stateId, 'dockyard')).toBe(false);
  });

  it('never starts a scenario with a state already over its slot budget', () => {
    const f = makeFixture();
    for (let i = 0; i < f.state.states.length; i++) {
      const st = f.state.states[i];
      expect(
        st.civilianFactories + st.militaryFactories,
        `state ${f.index.data.states[i].name}`,
      ).toBeLessThanOrEqual(st.buildingSlots);
    }
  });

  it('stops building in a state that has been overrun', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const sov = f.country('SOV');
    ger.constructionQueue = [];
    ger.economy.consumerGoodsRatio = 0;
    const stateId = f.index.get(ger.capital).stateId;
    queueBuilding(f.state, ger, stateId, 'civilian_factory');

    runDays(f, 20);
    const progressed = ger.constructionQueue[0].progress;
    expect(progressed).toBeGreaterThan(0);

    f.state.states[stateId].controller = sov.id;
    runDays(f, 20);
    expect(ger.constructionQueue[0].progress).toBe(progressed);
  });
});

describe('manpower and political power', () => {
  it('accrues manpower from controlled states', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const before = ger.economy.manpower;
    runDays(f, 30);
    expect(ger.economy.manpower).toBeGreaterThan(before);
  });

  it('yields far less manpower from occupied territory', () => {
    const home = makeFixture();
    const occupied = makeFixture();
    const gerHome = home.country('GER');
    const gerOcc = occupied.country('GER');
    for (const s of occupied.state.states) {
      if (s.controller === gerOcc.id) s.owner = occupied.country('POL').id;
    }
    const beforeHome = gerHome.economy.manpower;
    const beforeOcc = gerOcc.economy.manpower;
    for (let i = 0; i < 60; i++) {
      tickEconomyDaily(home.state, { index: home.index });
      tickEconomyDaily(occupied.state, { index: occupied.index });
    }
    const gainHome = gerHome.economy.manpower - beforeHome;
    const gainOcc = gerOcc.economy.manpower - beforeOcc;
    expect(gainOcc).toBeLessThan(gainHome * 0.5);
    expect(gainOcc).toBeGreaterThan(0);
  });

  it('accrues political power and caps it', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    runDays(f, 2000);
    expect(ger.economy.politicalPower).toBeLessThanOrEqual(999);
    expect(ger.economy.politicalPower).toBeGreaterThan(100);
  });

  it('skips capitulated countries entirely', () => {
    const f = makeFixture();
    const pol = f.country('POL');
    pol.capitulated = true;
    const before = { ...pol.economy.stockpile };
    runDays(f, 30);
    for (const k of Object.keys(before) as EquipmentType[]) {
      expect(pol.economy.stockpile[k]).toBe(before[k]);
    }
  });
});

describe('determinism', () => {
  it('produces identical economies from identical inputs', () => {
    const a = makeFixture({ seed: 777 });
    const b = makeFixture({ seed: 777 });
    for (let i = 0; i < 120; i++) {
      tickEconomyDaily(a.state, { index: a.index });
      tickEconomyDaily(b.state, { index: b.index });
    }
    const snap = (f: ReturnType<typeof makeFixture>) =>
      f.state.countries.map((c) => ({
        stock: c.economy.stockpile,
        mp: c.economy.manpower,
        pp: c.economy.politicalPower,
        lines: c.productionLines.map((l) => [l.efficiency, l.progress]),
      }));
    expect(snap(a)).toEqual(snap(b));
  });
});
