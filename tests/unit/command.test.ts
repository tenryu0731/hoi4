import { describe, expect, it } from 'vitest';

import {
  ARMY_GROUP_LIMIT, COMMAND_LIMIT, appointCommander, armyById, assignDivisions,
  MAX_ARMIES, commandLimit, commandModifiers, commanderById, createArmy, disbandArmy,
  overloadScale, setArmyParent, tickCommandReinforcementDaily, tickCommanderExperienceDaily,
} from '../../src/sim/military/command';
import {
  BASE_MAX_PLANNING, PLANNING_DECAY_PER_DAY, PLANNING_PER_DAY, frontProvinces,
  tickBattlePlansDaily,
} from '../../src/sim/military/frontline';
import { COMMANDERS, commandersFor } from '../../src/sim/military/commanderData';
import { checkInvariants } from '../../src/sim/core/invariants';
import { Simulation } from '../../src/sim/Simulation';
import { TimeEngine } from '../../src/sim/time/TimeEngine';
import { spawnDivision } from '../../src/sim/scenario/europe1936';
import { makeFixture, type Fixture } from './helpers/fixture';
import type { Army, Commander, GameState } from '../../src/sim/core/types';

/**
 * Invariant failures about the chain of command only.
 *
 * A fresh scenario trips a production invariant on hour zero -- factories are
 * assigned before the first economy tick reconciles them -- and that is not
 * what these tests are about. Filtering keeps a real regression here from
 * being masked by an unrelated one, and an unrelated one from failing these.
 */
function commandErrors(state: GameState, provinces: number): string[] {
  return checkInvariants(state, provinces).filter(
    (e) => /army|commander|division \d+/.test(e),
  );
}

function ctxOf(f: Fixture) {
  return { index: f.index, state: f.state, rng: f.state.rng };
}

function armiesOf(state: GameState, tag: string): Army[] {
  const c = state.countries.find((x) => x.tag === tag)!;
  return (state.armies ?? []).filter((a) => a.owner === c.id);
}

describe('the officer roster', () => {
  it('covers every country on the map', () => {
    const f = makeFixture();
    for (const country of f.state.countries) {
      const mine = f.state.commanders!.filter((c) => c.owner === country.id);
      expect(mine.length, `${country.tag} has no officers`).toBeGreaterThan(0);
    }
  });

  it('keeps every rating inside the range the modifiers assume', () => {
    for (const c of COMMANDERS) {
      expect(c.skill, c.id).toBeGreaterThanOrEqual(1);
      expect(c.skill, c.id).toBeLessThanOrEqual(9);
      for (const k of ['attack', 'defence', 'planning', 'logistics'] as const) {
        expect(c[k], `${c.id}.${k}`).toBeGreaterThanOrEqual(1);
        expect(c[k], `${c.id}.${k}`).toBeLessThanOrEqual(6);
      }
    }
  });

  it('gives nobody a duplicate identity', () => {
    expect(new Set(COMMANDERS.map((c) => c.id)).size).toBe(COMMANDERS.length);
  });

  it('has at most one field marshal per country in the starting posts', () => {
    const f = makeFixture();
    for (const country of f.state.countries) {
      const groups = (f.state.armies ?? [])
        .filter((a) => a.owner === country.id && a.isArmyGroup);
      expect(groups.length, country.tag).toBeLessThanOrEqual(1);
      if (groups.length === 1) {
        const marshal = commanderById(f.state, groups[0].commander);
        expect(marshal?.rank, country.tag).toBe('field_marshal');
      }
    }
  });
});

describe('the chain of command', () => {
  it('starts every division under somebody', () => {
    const f = makeFixture();
    const loose = f.state.divisions.filter((d) => !d.dead && d.armyId === null);
    expect(loose).toEqual([]);
  });

  it('pays a division nothing when it has no army', () => {
    const f = makeFixture();
    const div = f.state.divisions.find((d) => !d.dead)!;
    assignDivisions(f.state, null, [div.id]);
    const mods = commandModifiers(f.state, div);
    expect(mods).toEqual({
      attack: 1, defence: 1, supplyUse: 1, planningSpeed: 1, maxPlanningBonus: 0, entrenchment: 1,
      traits: new Set(),
    });
  });

  it('turns a general’s attributes into the numbers his divisions fight with', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const army = createArmy(f.state, ger.id, 'test');
    const general = f.state.commanders!.find(
      (c) => c.owner === ger.id && c.rank === 'general' && c.assignment === null,
    )!;
    // Pin the ratings so the test states the rates rather than reading them
    // back out of the data table.
    general.attack = 4; general.defence = 2; general.logistics = 3; general.planning = 5;
    general.traits = [];
    appointCommander(f.state, army.id, general.id);
    const div = f.state.divisions.find((d) => d.owner === ger.id && !d.dead)!;
    assignDivisions(f.state, army.id, [div.id]);

    const mods = commandModifiers(f.state, div);
    expect(mods.attack).toBeCloseTo(1.2, 5);          // 4 x 5%
    expect(mods.defence).toBeCloseTo(1.1, 5);         // 2 x 5%
    expect(mods.supplyUse).toBeCloseTo(1 - 0.075, 5); // 3 x 2.5%
    expect(mods.planningSpeed).toBeCloseTo(1.25, 5);  // 5 x 5%
    expect(mods.maxPlanningBonus).toBeCloseTo(0.1, 5); // 5 x 2%
  });

  it('passes half of a field marshal’s ability to the generals beneath him', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const army = createArmy(f.state, ger.id, 'army');
    const group = createArmy(f.state, ger.id, 'group', true);
    const general = f.state.commanders!.find(
      (c) => c.owner === ger.id && c.rank === 'general' && c.assignment === null,
    )!;
    const marshal = f.state.commanders!.find(
      (c) => c.owner === ger.id && c.rank === 'field_marshal' && c.assignment === null,
    )!;
    general.attack = 2; general.defence = 1; general.planning = 1; general.logistics = 1;
    general.traits = [];
    marshal.attack = 4; marshal.defence = 1; marshal.planning = 1; marshal.logistics = 1;
    marshal.traits = [];
    appointCommander(f.state, army.id, general.id);
    appointCommander(f.state, group.id, marshal.id);
    setArmyParent(f.state, army.id, group.id);

    const div = f.state.divisions.find((d) => d.owner === ger.id && !d.dead)!;
    assignDivisions(f.state, army.id, [div.id]);
    // 2 x 5% from the general, plus half of 4 x 5% from the marshal.
    expect(commandModifiers(f.state, div).attack).toBeCloseTo(1.2, 5);
  });

  it('refuses a general an army group and a field marshal a single army', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const army = createArmy(f.state, ger.id, 'army');
    const group = createArmy(f.state, ger.id, 'group', true);
    const general = f.state.commanders!.find(
      (c) => c.owner === ger.id && c.rank === 'general' && c.assignment === null,
    )!;
    const marshal = f.state.commanders!.find(
      (c) => c.owner === ger.id && c.rank === 'field_marshal' && c.assignment === null,
    )!;
    appointCommander(f.state, group.id, general.id);
    appointCommander(f.state, army.id, marshal.id);
    expect(group.commander).toBeNull();
    expect(army.commander).toBeNull();
  });

  it('fades a general’s bonuses as his command outgrows him, reaching nothing at double', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const army = createArmy(f.state, ger.id, 'test');
    const general = f.state.commanders!.find(
      (c) => c.owner === ger.id && c.rank === 'general' && c.assignment === null,
    )!;
    general.traits = [];
    appointCommander(f.state, army.id, general.id);
    const limit = commandLimit(general);
    expect(limit).toBe(COMMAND_LIMIT);

    const pool = f.state.divisions.filter((d) => d.owner === ger.id && !d.dead);
    assignDivisions(f.state, army.id, pool.slice(0, limit).map((d) => d.id));
    expect(overloadScale(f.state, army, general)).toBe(1);

    army.divisions = new Array(limit * 2).fill(0).map((_, i) => i);
    expect(overloadScale(f.state, army, general)).toBe(0);
    army.divisions = new Array(Math.round(limit * 1.5)).fill(0).map((_, i) => i);
    expect(overloadScale(f.state, army, general)).toBeCloseTo(0.5, 2);
  });

  it('never lets one officer hold two posts', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const a = createArmy(f.state, ger.id, 'a');
    const b = createArmy(f.state, ger.id, 'b');
    const general = f.state.commanders!.find(
      (c) => c.owner === ger.id && c.rank === 'general' && c.assignment === null,
    )!;
    appointCommander(f.state, a.id, general.id);
    appointCommander(f.state, b.id, general.id);
    expect(a.commander).toBeNull();
    expect(b.commander).toBe(general.id);
    expect(commandErrors(f.state, f.index.count)).toEqual([]);
  });

  it('caps an army group at five armies', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const group = createArmy(f.state, ger.id, 'group', true);
    const made = new Array(ARMY_GROUP_LIMIT + 2).fill(0)
      .map((_, i) => createArmy(f.state, ger.id, `a${i}`));
    for (const a of made) setArmyParent(f.state, a.id, group.id);
    expect(group.children.length).toBe(ARMY_GROUP_LIMIT);
  });

  it('frees divisions and the commander when an army is disbanded', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    const held = [...army.divisions];
    const commander = army.commander!;
    disbandArmy(f.state, army.id);
    expect(armyById(f.state, army.id)).toBeNull();
    for (const id of held) {
      expect(f.state.divisions.find((d) => d.id === id)!.armyId).toBeNull();
    }
    expect(commanderById(f.state, commander)!.assignment).toBeNull();
    expect(commandErrors(f.state, f.index.count)).toEqual([]);
    expect(ger.id).toBeGreaterThanOrEqual(0);
  });
});

describe('battle plans', () => {
  it('spreads an army evenly along the border it is told to hold', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    army.order = { kind: 'front', against: pol.id };

    const front = frontProvinces(f.state, f.index, ger.id, pol.id);
    expect(front.length).toBeGreaterThan(0);

    const sim = new Simulation(f.state, f.index);
    const time = new TimeEngine(f.state.clock.totalHours);
    time.on((c) => sim.tick(c));
    time.step(24 * 30);

    const standing = army.divisions.filter((id) => {
      const d = f.state.divisions.find((x) => x.id === id)!;
      return army.frontProvinces.includes(d.provinceId);
    });
    // Every division reaches the line. This is the regression that matters:
    // re-issuing a move each day resets the leg in progress, so anything more
    // than a day's march away never arrives at all.
    expect(standing.length).toBe(army.divisions.length);

    const perProvince = new Map<number, number>();
    for (const id of army.divisions) {
      const d = f.state.divisions.find((x) => x.id === id)!;
      perProvince.set(d.provinceId, (perProvince.get(d.provinceId) ?? 0) + 1);
    }
    const counts = [...perProvince.values()];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('leaves a hand-given order alone instead of marching the division back', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    army.order = { kind: 'front', against: pol.id };

    const sim = new Simulation(f.state, f.index);
    const time = new TimeEngine(f.state.clock.totalHours);
    time.on((c) => sim.tick(c));
    // Let the plan take hold first, so the divisions are somewhere the plan
    // chose rather than where the scenario left them.
    time.step(24 * 20);

    // One division, sent somewhere the plan would never send it.
    const moved = f.state.divisions.find(
      (d) => army.divisions.includes(d.id) && d.combatId === null && !d.dead,
    )!;
    const home = ger.capital;
    expect(moved.provinceId).not.toBe(home);
    sim.execute({ t: 'moveDivisions', divisions: [moved.id], target: home });
    expect(moved.detached).toBe(true);

    // The plan runs every day and used to reclaim it inside one: measured with
    // a whole army sent to Berlin, nine had arrived and by the next morning
    // none of them were there any more.
    time.step(24 * 40);
    expect(moved.provinceId).toBe(home);
    expect(moved.detached).toBe(true);

    // The rest of the army is still the plan's business.
    const onPlan = army.divisions.filter((id) => {
      const d = f.state.divisions.find((x) => x.id === id)!;
      return !d.detached && army.frontProvinces.includes(d.provinceId);
    });
    expect(onPlan.length).toBeGreaterThan(0);
  });

  it('takes the whole formation back the moment the army is given orders', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    army.order = { kind: 'front', against: pol.id };
    const sim = new Simulation(f.state, f.index);

    const div = f.state.divisions.find((d) => army.divisions.includes(d.id) && !d.dead)!;
    sim.execute({ t: 'moveDivisions', divisions: [div.id], target: ger.capital });
    expect(div.detached).toBe(true);

    // Re-issuing the order it already has is what the 計画に復帰 chip sends, so
    // it has to be enough on its own -- and it must not throw the preparation
    // away, because nothing about the plan changed.
    army.planning = 0.2;
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id, order: { ...army.order },
    });
    expect(div.detached).toBe(false);
    expect(army.planning).toBeCloseTo(0.2, 5);
  });

  it('puts a division back under command when it changes army', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    const div = f.state.divisions.find((d) => army.divisions.includes(d.id) && !d.dead)!;
    const sim = new Simulation(f.state, f.index);
    sim.execute({ t: 'moveDivisions', divisions: [div.id], target: ger.capital });
    expect(div.detached).toBe(true);

    const other = createArmy(f.state, ger.id, 'test');
    assignDivisions(f.state, other.id, [div.id]);
    expect(div.detached).toBe(false);
  });

  it('accumulates preparation while still and sheds it once moving', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const army = createArmy(f.state, ger.id, 'test');
    const div = f.state.divisions.find((d) => d.owner === ger.id && !d.dead)!;
    assignDivisions(f.state, army.id, [div.id]);
    army.order = { kind: 'garrison', provinces: [div.provinceId] };

    const ctx = ctxOf(f);
    tickBattlePlansDaily(f.state, ctx);
    expect(army.planning).toBeCloseTo(PLANNING_PER_DAY, 5);

    for (let i = 0; i < 60; i++) tickBattlePlansDaily(f.state, ctx);
    expect(army.planning).toBeGreaterThanOrEqual(BASE_MAX_PLANNING);
    const peak = army.planning;

    div.path = [div.provinceId + 1];
    tickBattlePlansDaily(f.state, ctx);
    expect(army.planning).toBeCloseTo(peak - PLANNING_DECAY_PER_DAY, 5);
  });

  it('holds an unplanned army to half the preparation of a planned one', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const planned = createArmy(f.state, ger.id, 'planned');
    const idle = createArmy(f.state, ger.id, 'idle');
    const pool = f.state.divisions.filter((d) => d.owner === ger.id && !d.dead);
    assignDivisions(f.state, planned.id, [pool[0].id]);
    assignDivisions(f.state, idle.id, [pool[1].id]);
    planned.order = { kind: 'garrison', provinces: [pool[0].provinceId] };

    const ctx = ctxOf(f);
    for (let i = 0; i < 80; i++) tickBattlePlansDaily(f.state, ctx);
    expect(idle.planning).toBeCloseTo(planned.planning / 2, 3);
  });

  it('throws the preparation away when the order changes', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    const sim = new Simulation(f.state, f.index);
    army.planning = 0.25;
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id,
      order: { kind: 'offensive', targets: [0] },
    });
    expect(army.planning).toBe(0);
  });
});

describe('the AI in the chain of command', () => {
  it('declares a front for its armies instead of leaving them planless', () => {
    // Measured before this existed, over four ten-year campaigns: 0 of 128,783
    // army-days carried an order, so every AI formation was pinned to the
    // half-rate planning fallback at a mean of 0.193. A preparation bonus the
    // human collects at twice the rate is a difficulty setting nobody chose.
    const f = makeFixture();
    const sim = new Simulation(f.state, f.index);
    const time = new TimeEngine(f.state.clock.totalHours);
    time.on((c) => sim.tick(c));
    time.step(24 * 365 * 5);

    const aiArmies = (f.state.armies ?? []).filter(
      (a) => !a.isArmyGroup && a.divisions.length > 0 && f.state.countries[a.owner].isAI,
    );
    expect(aiArmies.length).toBeGreaterThan(4);
    const withOrder = aiArmies.filter((a) => a.order !== null);
    expect(withOrder.length / aiArmies.length).toBeGreaterThan(0.8);
    // And the front it declared is real, not an empty list.
    const atWar = withOrder.filter((a) => f.state.countries[a.owner].atWarWith.length > 0);
    if (atWar.length > 0) {
      expect(atWar.some((a) => a.frontProvinces.length > 0)).toBe(true);
    }
  }, 90_000);
});

describe('reinforcements', () => {
  it('folds a division that belongs to nobody into an army with room', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    // Make room, then set a division loose.
    const div = f.state.divisions.find((d) => d.id === army.divisions[0])!;
    assignDivisions(f.state, null, [div.id]);
    expect(div.armyId).toBeNull();

    tickCommandReinforcementDaily(f.state);
    expect(div.armyId).not.toBeNull();
    expect(commandErrors(f.state, f.index.count)).toEqual([]);
    expect(ger.id).toBeGreaterThanOrEqual(0);
  });

  it('raises a new army when every existing one is full', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const before = armiesOf(f.state, 'GER').filter((a) => !a.isArmyGroup).length;
    // Germany starts with one full army; a fresh division has nowhere to go.
    const home = f.state.divisions.find((d) => d.owner === ger.id && !d.dead)!;
    spawnDivision(f.state, ger.id, home.templateId, home.provinceId, 1);
    tickCommandReinforcementDaily(f.state);
    const after = armiesOf(f.state, 'GER').filter((a) => !a.isArmyGroup);
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].commander).not.toBeNull();
    expect(commandErrors(f.state, f.index.count)).toEqual([]);
  });

  it('never leaves a division uncommanded once the war is running', () => {
    const f = makeFixture();
    const sim = new Simulation(f.state, f.index);
    const time = new TimeEngine(f.state.clock.totalHours);
    time.on((c) => sim.tick(c));
    time.step(24 * 400);
    // Before this pass existed, 32% of the Soviet army and 48% of the British
    // were commanded by nobody after four hundred days.
    const loose = f.state.divisions.filter((d) => !d.dead && d.armyId === null);
    expect(loose.length).toBe(0);
    expect(commandErrors(f.state, f.index.count)).toEqual([]);
  }, 60_000);

  it('keeps the number of armies bounded however long the war runs', () => {
    const f = makeFixture();
    const sim = new Simulation(f.state, f.index);
    const time = new TimeEngine(f.state.clock.totalHours);
    time.on((c) => sim.tick(c));
    time.step(24 * 900);
    for (const country of f.state.countries) {
      const mine = (f.state.armies ?? [])
        .filter((a) => a.owner === country.id && !a.isArmyGroup);
      expect(mine.length, country.tag).toBeLessThanOrEqual(MAX_ARMIES);
    }
  }, 90_000);
});

describe('officers in the field', () => {
  it('promotes only the ones whose divisions are fighting', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const fighting = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    const idle = createArmy(f.state, ger.id, 'idle');
    // Germany starts with one army holding everything, so the reserve has to
    // be taken out of it rather than found lying around.
    const spare = f.state.divisions.find((d) => d.id === fighting.divisions[0])!;
    assignDivisions(f.state, idle.id, [spare.id]);
    const general = f.state.commanders!.find(
      (c) => c.owner === ger.id && c.rank === 'general' && c.assignment === null,
    )!;
    appointCommander(f.state, idle.id, general.id);

    for (const id of fighting.divisions) {
      const d = f.state.divisions.find((x) => x.id === id)!;
      d.combatId = 1;
    }
    const busy = commanderById(f.state, fighting.commander) as Commander;
    const before = busy.experience;

    tickCommanderExperienceDaily(f.state);
    expect(busy.experience).toBeGreaterThan(before);
    expect(general.experience).toBe(0);
  });
});

describe('the roster table itself', () => {
  it('answers for a tag it does not know without throwing', () => {
    expect(commandersFor('ZZZ')).toEqual([]);
  });
});
