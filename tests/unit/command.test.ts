import { describe, expect, it } from 'vitest';

import {
  ARMY_GROUP_LIMIT, COMMAND_LIMIT, appointCommander, armyById, assignDivisions,
  MAX_ARMIES, commandLimit, commandModifiers, commanderById, createArmy, disbandArmy,
  overloadScale, setArmyParent, tickCommandReinforcementDaily, tickCommanderExperienceDaily,
} from '../../src/sim/military/command';
import {
  BASE_MAX_PLANNING, PLANNING_DECAY_PER_DAY, PLANNING_PER_DAY, frontChain, frontProvinces,
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

    // Evenly, but only among posts that can actually be reached from one
    // another. East Prussia is cut off from the Reich by the Polish Corridor,
    // and now that an army may not march through a neutral country its five
    // posts there are held by the five divisions already in them while the
    // other nineteen mass on the main border: 1,1,1,1,1 and 5,5,5,4. A single
    // flat spread across all nine would mean the corridor was being walked
    // through, which is the thing that should not happen.
    const perProvince = new Map<number, number>();
    for (const id of army.divisions) {
      const d = f.state.divisions.find((x) => x.id === id)!;
      perProvince.set(d.provinceId, (perProvince.get(d.provinceId) ?? 0) + 1);
    }
    const german = (p: number): boolean => f.state.provinces[p].controller === ger.id;
    const theatres: Set<number>[] = [];
    for (const post of army.frontProvinces) {
      if (theatres.some((t) => t.has(post))) continue;
      theatres.push(new Set(f.index.reachable(post, german, { includeSea: false })));
    }
    expect(theatres.length).toBeGreaterThan(1);
    for (const theatre of theatres) {
      const counts = [...perProvince.entries()]
        .filter(([p]) => theatre.has(p))
        .map(([, n]) => n);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    }
  });

  it('leaves a division that is already on the line where it is', () => {
    // 「戦線に穴が空いた時とか」. The assignment used to be recomputed from
    // scratch every day -- every division sorted against every post by
    // distance and crowding -- so a division that arrived yesterday was
    // re-sorted today and sent somewhere else, and its post stood empty while
    // it walked. Measured on a six-province line held by twenty-four
    // divisions: 99 re-orders of a division that was already standing on the
    // line in sixty days, and a hole somewhere on the line on twenty of them.
    //
    // The reference has the same failure and the same workaround: a fallback
    // line is what its players use when they want a line that "doesn't shuffle
    // units", and the shuffling is exactly what opens the gaps.
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    ger.isAI = false;
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    const sim = new Simulation(f.state, f.index);
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id,
      order: { kind: 'line', anchors: frontProvinces(f.state, f.index, ger.id, pol.id) },
    });
    sim.execute({ t: 'declareWar', country: ger.id, target: pol.id });

    const time = new TimeEngine(f.state.clock.totalHours);
    time.on((c) => sim.tick(c));
    time.step(24 * 20);

    const where = new Map<number, number>();
    const at = (id: number) => f.state.divisions.find((d) => d.id === id);
    for (const id of army.divisions) {
      const d = at(id);
      if (d) where.set(id, d.provinceId);
    }
    let churn = 0;
    let holes = 0;
    for (let day = 0; day < 30; day++) {
      time.step(24);
      for (const id of army.divisions) {
        const d = at(id);
        if (!d || d.dead) continue;
        const was = where.get(id);
        if (was !== undefined && army.frontProvinces.includes(was)
          && d.path.length > 0 && d.path[d.path.length - 1] !== was) churn++;
        where.set(id, d.provinceId);
      }
      holes += army.frontProvinces.filter((p) => !f.state.provinces[p].divisions.some(
        (x) => f.state.divisions[x]?.owner === ger.id,
      )).length;
    }
    expect(churn, 'a division standing on the line was sent somewhere else').toBe(0);
    expect(holes, 'a post of the line stood empty').toBe(0);
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

  it('walks a drawn line forward with the army that holds it', () => {
    // 「前線は国ごとの選択じゃなくて自分で国境などに引く」. A drawn line is a list
    // of provinces the finger passed over, and what makes it a front rather
    // than a list is that it moves: what the army works out today is what it
    // anchors on tomorrow.
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    ger.isAI = false;
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    const border = frontProvinces(f.state, f.index, ger.id, pol.id);
    expect(border.length).toBeGreaterThan(1);

    const sim = new Simulation(f.state, f.index);
    // Two provinces of it, as a finger that traced part of the border would
    // give -- the rest of the line has to be worked out, not assumed.
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id,
      order: { kind: 'line', anchors: border.slice(0, 2) },
    });
    const ctx = ctxOf(f);
    tickBattlePlansDaily(f.state, ctx);
    expect(army.frontProvinces.length).toBeGreaterThan(0);
    for (const p of army.frontProvinces) {
      expect(f.state.provinces[p].controller).toBe(ger.id);
      // Every province of it still faces somebody: it is a front, not a list.
      expect(f.index.get(p).neighbors.some(
        (n) => f.state.provinces[n]?.controller !== ger.id,
      )).toBe(true);
    }

    // Take the ground in front of it and the line comes with, without the
    // player redrawing anything. Everything in front, not just the Polish
    // half: on the 1936 map a German border province can face Poland and
    // Czechoslovakia at once, and a post that still faces somebody is a post
    // that has correctly not moved.
    const before = [...army.frontProvinces].sort().join(',');
    for (const p of [...army.frontProvinces]) {
      for (const n of f.index.get(p).neighbors) {
        const held = f.state.provinces[n];
        if (held && held.controller !== ger.id) held.controller = ger.id;
      }
    }
    tickBattlePlansDaily(f.state, ctx);
    expect([...army.frontProvinces].sort().join(',')).not.toBe(before);
    for (const p of army.frontProvinces) {
      expect(f.state.provinces[p].controller).toBe(ger.id);
    }
  });

  it('keeps a line drawn inland where it was drawn', () => {
    // 「国境線じゃないところに戦線引こうとした時とか」. A line traced in the
    // interior faces nobody, and the drift search then returned everything
    // within three hops of it -- which became tomorrow's anchors, so the plan
    // fed itself. Measured before the fix: three provinces in the middle of
    // Germany covered the country inside a week.
    const f = makeFixture();
    const ger = f.country('GER');
    ger.isAI = false;
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    const border = new Set(frontProvinces(f.state, f.index, ger.id, f.country('POL').id));
    const inland = f.index.provinces
      .filter((p) => f.state.provinces[p.id]?.controller === ger.id
        && !border.has(p.id)
        && p.neighbors.every((n) => f.state.provinces[n]?.controller === ger.id))
      .slice(0, 3)
      .map((p) => p.id);
    expect(inland).toHaveLength(3);

    const sim = new Simulation(f.state, f.index);
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id,
      order: { kind: 'line', anchors: inland },
    });
    const ctx = ctxOf(f);
    for (let day = 0; day < 14; day++) tickBattlePlansDaily(f.state, ctx);
    expect([...army.frontProvinces].sort()).toEqual([...inland].sort());
  });

  it('walks a partial line forward one province at a time, keeping its shape', () => {
    // 「国境でも国境の一部だけ引くとか」. Drawing four of the nine provinces of the
    // Polish border and then advancing used to bring the line back two hundred
    // kilometres to the south, half of it behind the front rather than on it:
    // the drift searched three hops out from the whole line and kept whichever
    // border provinces were nearest, and "nearest" over a set has no memory of
    // shape.
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    ger.isAI = false;
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    const border = frontProvinces(f.state, f.index, ger.id, pol.id);
    const drawn = border.slice(5);
    expect(drawn.length).toBeGreaterThan(2);
    expect(drawn.length).toBeLessThan(border.length);

    const sim = new Simulation(f.state, f.index);
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id, order: { kind: 'line', anchors: drawn },
    });
    const ctx = ctxOf(f);
    tickBattlePlansDaily(f.state, ctx);
    // Left alone it is exactly what was drawn -- not the whole border.
    expect(army.frontProvinces).toEqual(drawn);

    // Take the ground in front of it. Every post moves, and every post moves
    // to somewhere it could walk to: one province, not a jump.
    const was = [...army.frontProvinces];
    for (const p of was) {
      for (const n of f.index.get(p).neighbors) {
        if (f.state.provinces[n]?.controller === pol.id) f.state.provinces[n].controller = ger.id;
      }
    }
    tickBattlePlansDaily(f.state, ctx);
    for (const p of army.frontProvinces) {
      expect(f.state.provinces[p].controller).toBe(ger.id);
      const stepped = was.includes(p)
        || was.some((old) => f.index.get(old).neighbors.includes(p));
      expect(stepped, `${p} is not one step from the old line`).toBe(true);
    }
    // And it is still a piece of the border, not the whole of it.
    expect(army.frontProvinces.length).toBeLessThanOrEqual(drawn.length);
  });

  it('builds a contiguous run along the front, and refuses one across a gap', () => {
    // 「実際のhoi4みたいに端から延長したり縮めたり」: dragging an end says how far
    // along the border the line now reaches, and the run between is worked out
    // rather than traced by a finger that cannot be that accurate.
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    const border = frontProvinces(f.state, f.index, ger.id, pol.id);
    const ctx = ctxOf(f);

    const reachable = border.filter(
      (p) => frontChain(f.state, ctx, ger.id, border[0], p).length > 0,
    );
    expect(reachable.length).toBeGreaterThan(1);
    const chain = frontChain(f.state, ctx, ger.id, border[0], reachable[reachable.length - 1]);
    expect(chain[0]).toBe(border[0]);
    expect(chain[chain.length - 1]).toBe(reachable[reachable.length - 1]);
    for (let i = 1; i < chain.length; i++) {
      expect(f.index.get(chain[i - 1]).neighbors).toContain(chain[i]);
    }
    for (const p of chain) expect(f.state.provinces[p].controller).toBe(ger.id);

    // East Prussia's border is a separate run: no line reaches from one to the
    // other, and inventing one would draw a front across the Polish Corridor.
    const cut = border.find(
      (p) => frontChain(f.state, ctx, ger.id, border[0], p).length === 0 && p !== border[0],
    );
    expect(cut, 'the map has a front split by a corridor').toBeDefined();
  });

  it('keeps a drawn line the length it was drawn', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.isAI = false;
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    const border = frontProvinces(f.state, f.index, ger.id, f.country('POL').id);
    const drawn = border.slice(0, 2);
    const sim = new Simulation(f.state, f.index);
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id,
      order: { kind: 'line', anchors: drawn },
    });
    const ctx = ctxOf(f);
    for (let day = 0; day < 30; day++) tickBattlePlansDaily(f.state, ctx);
    // It may move along the border; it may not swallow it.
    expect(army.frontProvinces.length).toBeLessThanOrEqual(drawn.length);
    expect(army.frontProvinces.length).toBeGreaterThan(0);
  });

  it('re-forms a drawn line behind itself when every anchor is lost', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    ger.isAI = false;
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    const border = frontProvinces(f.state, f.index, ger.id, pol.id);
    const sim = new Simulation(f.state, f.index);
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id,
      order: { kind: 'line', anchors: border.slice(0, 3) },
    });
    // Overrun: everything the line was drawn on changes hands.
    for (const p of border.slice(0, 3)) f.state.provinces[p].controller = pol.id;
    tickBattlePlansDaily(f.state, ctxOf(f));
    // A driven-back army re-forms behind the old line rather than losing its
    // plan outright, which is what dropping the order would amount to.
    expect(army.frontProvinces.length).toBeGreaterThan(0);
    for (const p of army.frontProvinces) {
      expect(f.state.provinces[p].controller).toBe(ger.id);
    }
  });

  it('holds an offensive still until the plan is executed', () => {
    // 「将軍のアイコンの上の計画実行ボタン（矢印のあるボタン）をクリックして
    // 軍や軍集団ごとに実行し」 -- drawing a plan and running it are two acts,
    // and if they are one then preparation is never a decision: an army that
    // marches the moment it is given an order can never bank the bonus that
    // the whole planning system exists to pay.
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    ger.isAI = false;
    const target = f.provinceOf('POL');
    const sim = new Simulation(f.state, f.index);
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id,
      order: { kind: 'offensive', targets: [target] },
    });
    // War, so the border rule is not what is holding them.
    sim.execute({ t: 'declareWar', country: ger.id, target: pol.id });
    expect(army.executing).toBe(false);

    const where = new Map(army.divisions.map(
      (id) => [id, f.state.divisions.find((d) => d.id === id)!.provinceId],
    ));
    const ctx = ctxOf(f);
    for (let i = 0; i < 20; i++) tickBattlePlansDaily(f.state, ctx);
    const moved = army.divisions.filter(
      (id) => f.state.divisions.find((d) => d.id === id)!.path.length > 0,
    );
    expect(moved.length).toBe(0);
    // And the waiting is worth something: twenty days of it is twenty days of
    // preparation nobody was collecting before.
    expect(army.planning).toBeGreaterThan(PLANNING_PER_DAY * 10);

    sim.execute({
      t: 'setPlanExecution', country: ger.id, army: army.id, executing: true,
    });
    // Which the order to go does not spend.
    expect(army.planning).toBeGreaterThan(PLANNING_PER_DAY * 10);
    tickBattlePlansDaily(f.state, ctx);
    const going = army.divisions.filter((id) => {
      const d = f.state.divisions.find((x) => x.id === id)!;
      return d.path.length > 0 || d.provinceId !== where.get(id);
    });
    expect(going.length).toBeGreaterThan(0);
  });

  it('keeps an offensive standing on its own line rather than the objective', () => {
    // 攻撃線 is drawn out of a 前線 in the reference: the army holds a line and
    // the arrow springs from it. Drawing the objectives as the front put the
    // army's own line inside the country it was invading.
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    ger.isAI = false;
    const sim = new Simulation(f.state, f.index);
    sim.execute({ t: 'declareWar', country: ger.id, target: pol.id });
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id,
      order: { kind: 'offensive', targets: [pol.capital] },
    });
    tickBattlePlansDaily(f.state, ctxOf(f));

    expect(army.frontProvinces.length).toBeGreaterThan(0);
    for (const p of army.frontProvinces) {
      expect(f.state.provinces[p].controller).toBe(ger.id);
    }
    expect(army.frontProvinces).not.toContain(pol.capital);
  });

  it('halts a plan without throwing away what it prepared', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    const sim = new Simulation(f.state, f.index);
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id,
      order: { kind: 'offensive', targets: [f.provinceOf('POL')] },
    });
    army.planning = 0.24;
    sim.execute({ t: 'setPlanExecution', country: ger.id, army: army.id, executing: true });
    sim.execute({ t: 'setPlanExecution', country: ger.id, army: army.id, executing: false });
    expect(army.executing).toBe(false);
    // The red button stops the advance; it does not erase the plan or the
    // preparation. Only a different order does that.
    expect(army.order).not.toBeNull();
    expect(army.planning).toBeCloseTo(0.24, 5);
  });

  it('starts every army under an army group when the group is executed', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const group = createArmy(f.state, ger.id, 'group', true);
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup && a.id !== group.id)!;
    setArmyParent(f.state, army.id, group.id);
    const sim = new Simulation(f.state, f.index);
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: group.id,
      order: { kind: 'offensive', targets: [f.provinceOf('POL')] },
    });
    // 「軍や軍集団ごとに実行し」: the field marshal's button is a handle on
    // everything beneath him, which is most of the reason to raise a group.
    sim.execute({ t: 'setPlanExecution', country: ger.id, army: group.id, executing: true });
    expect(group.executing).toBe(true);
    expect(army.executing).toBe(true);
  });

  it('drives a spearhead down one corridor instead of across a face', () => {
    // 「1プロヴィンスのみの前線から先鋒の目標を設定した場合。目標のワルシャワ
    // までの経路のみ進攻する計画になる」 -- a spearhead is the same divisions
    // as an offensive arranged as a column, and a column is what cuts a pocket.
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    ger.isAI = false;
    const target = pol.capital;
    const sim = new Simulation(f.state, f.index);
    sim.execute({ t: 'declareWar', country: ger.id, target: pol.id });
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id,
      order: { kind: 'spearhead', target },
    });
    sim.execute({ t: 'setPlanExecution', country: ger.id, army: army.id, executing: true });

    const ctx = ctxOf(f);
    tickBattlePlansDaily(f.state, ctx);
    // The route is a path: every province on it touches the next, and it ends
    // at the objective. An offensive's front is a set of objectives with no
    // such relation between them.
    const route = army.frontProvinces;
    expect(route.length).toBeGreaterThan(1);
    expect(route[route.length - 1]).toBe(target);
    for (let i = 1; i < route.length; i++) {
      expect(f.index.get(route[i - 1]).neighbors).toContain(route[i]);
    }
    // And it is narrower than the offensive over the same ground would be.
    const broad = f.index.provinces
      .filter((p) => f.state.provinces[p.id]?.controller === pol.id).length;
    expect(route.length).toBeLessThan(broad);
  });

  it('stops executing once the objective is taken', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const army = armiesOf(f.state, 'GER').find((a) => !a.isArmyGroup)!;
    ger.isAI = false;
    const held = f.state.divisions.find((d) => army.divisions.includes(d.id))!.provinceId;
    const sim = new Simulation(f.state, f.index);
    sim.execute({
      t: 'setArmyOrder', country: ger.id, army: army.id,
      // Somewhere we already hold: the plan is finished the day it starts.
      order: { kind: 'spearhead', target: held },
    });
    sim.execute({ t: 'setPlanExecution', country: ger.id, army: army.id, executing: true });
    tickBattlePlansDaily(f.state, ctxOf(f));
    // An army left running a finished plan goes on shedding the preparation
    // for the next one, so it stands down by itself.
    expect(army.executing).toBe(false);
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
    // And the front it declared is real, not an empty list -- asked only of
    // the armies that could have one. A campaign whose only wars are between
    // countries with no shared border (this seed reaches 1941 with the Soviet
    // Union at war with Britain and France and nobody's tanks able to reach
    // anybody) has no land front to declare, and an empty list is the right
    // answer there.
    const touching = withOrder.filter((a) => f.state.countries[a.owner].atWarWith.some(
      (enemy) => frontProvinces(f.state, f.index, a.owner, enemy).length > 0,
    ));
    if (touching.length > 0) {
      expect(touching.some((a) => a.frontProvinces.length > 0)).toBe(true);
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
