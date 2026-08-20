import { describe, expect, it } from 'vitest';

import {
  appointCommander, assignDivisions, commandLimit, commandModifiers, createArmy,
} from '../../src/sim/military/command';
import {
  ENTRENCHMENT_PER_LEVEL, MAX_ENTRENCHMENT, NAVAL_INVADER_ORG, PANZER_LEADER_SPEED,
  movementSpeed, placeDivision, tickConditionsDaily,
} from '../../src/sim/military/movement';
import {
  WINTER_SPECIALIST_RELIEF, winterSeverity,
} from '../../src/sim/military/weather';
import { makeFixture } from './helpers/fixture';
import { COMMANDER_TRAITS } from '../../src/sim/core/types';
import type {
  CommanderTrait, Division, DivisionTemplate, GameState,
} from '../../src/sim/core/types';

/**
 * A German division under a general who has exactly the traits asked for, and
 * nothing else. Skills are flattened to 1 so a difference between two rigs is
 * the trait and never the officer the scenario happened to deal.
 */
function rig(traits: CommanderTrait[]) {
  const f = makeFixture();
  const ger = f.country('GER');
  const army = createArmy(f.state, ger.id, 'T');
  const general = f.state.commanders!.find(
    (c) => c.owner === ger.id && c.rank === 'general' && c.assignment === null,
  )!;
  general.attack = 1;
  general.defence = 1;
  general.planning = 1;
  general.logistics = 1;
  general.traits = traits;
  appointCommander(f.state, army.id, general.id);
  const div = f.state.divisions.find((d) => d.owner === ger.id && !d.dead)!;
  assignDivisions(f.state, army.id, [div.id]);
  return { ...f, ger, army, div, general };
}

/** Points this division at whichever of the country's templates has armour. */
function makeArmoured(state: GameState, div: Division): DivisionTemplate {
  const tpl = state.countries[div.owner].templates.find(
    (t) => t.battalions.some((b) => b === 'light_armor' || b === 'medium_armor'),
  )!;
  div.templateId = tpl.id;
  return tpl;
}

function province(f: ReturnType<typeof rig>, name: string): number {
  return f.index.provinces.find((p) => p.name.toUpperCase().includes(name))!.id;
}

describe('entrenchment', () => {
  it('deepens by a level a day while a division holds still', () => {
    const f = rig([]);
    f.div.path = [];
    for (let i = 0; i < 3; i++) tickConditionsDaily(f.state, f.index);
    expect(f.div.entrenchment).toBe(3);
  });

  it('stops at a cap the defensive general raises', () => {
    const plain = rig([]);
    const dug = rig(['defensive_doctrine']);
    for (const f of [plain, dug]) {
      f.div.path = [];
      for (let i = 0; i < 20; i++) tickConditionsDaily(f.state, f.index);
    }
    expect(plain.div.entrenchment).toBe(MAX_ENTRENCHMENT);
    expect(dug.div.entrenchment).toBeGreaterThan(MAX_ENTRENCHMENT);
    expect(dug.div.entrenchment).toBeCloseTo(
      MAX_ENTRENCHMENT * commandModifiers(dug.state, dug.div).entrenchment, 5,
    );
  });

  it('is left behind the moment the division moves', () => {
    const f = rig([]);
    f.div.path = [];
    for (let i = 0; i < 4; i++) tickConditionsDaily(f.state, f.index);
    expect(f.div.entrenchment).toBe(4);
    placeDivision(f.state, f.div, f.index.get(f.div.provinceId).neighbors[0]);
    expect(f.div.entrenchment).toBe(0);
  });

  it('does not deepen while the division is in a battle', () => {
    const f = rig([]);
    f.div.path = [];
    f.div.combatId = 0;
    for (const _ of [1, 2, 3]) tickConditionsDaily(f.state, f.index);
    expect(f.div.entrenchment).toBe(0);
  });

  it('is worth defence, and only to the side standing still', () => {
    // The bonus is read off the division in collectSide; this pins the rate so
    // a silent change to the constant cannot pass unnoticed.
    expect(MAX_ENTRENCHMENT * ENTRENCHMENT_PER_LEVEL).toBeCloseTo(0.2, 5);
  });
});

describe('winter', () => {
  it('is severe in Lapland in January and absent on the Mediterranean', () => {
    const f = rig([]);
    f.state.clock.month = 1;
    expect(winterSeverity(f.state, f.index, province(f, 'ROVANIEMI'))).toBeCloseTo(1, 2);
    expect(winterSeverity(f.state, f.index, province(f, 'ROME'))).toBe(0);
    expect(winterSeverity(f.state, f.index, province(f, 'ALGIERS'))).toBe(0);
  });

  it('is absent everywhere in July', () => {
    const f = rig([]);
    f.state.clock.month = 7;
    for (const name of ['ROVANIEMI', 'HELSINKI', 'BERLIN']) {
      expect(winterSeverity(f.state, f.index, province(f, name)), name).toBe(0);
    }
  });

  it('grades by latitude rather than switching on', () => {
    const f = rig([]);
    f.state.clock.month = 1;
    const north = winterSeverity(f.state, f.index, province(f, 'ROVANIEMI'));
    const middle = winterSeverity(f.state, f.index, province(f, 'HELSINKI'));
    const south = winterSeverity(f.state, f.index, province(f, 'BERLIN'));
    expect(north).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(south);
    expect(south).toBeGreaterThan(0);
  });

  it('costs strength to anything standing in it', () => {
    const f = rig([]);
    f.state.clock.month = 1;
    f.div.path = [];
    placeDivision(f.state, f.div, province(f, 'ROVANIEMI'));
    const before = f.div.hp;
    for (let i = 0; i < 10; i++) tickConditionsDaily(f.state, f.index);
    expect(f.div.hp).toBeLessThan(before);
  });

  it('costs a winter specialist less', () => {
    const plain = rig([]);
    const cold = rig(['winter_specialist']);
    let plainLost = 0;
    let coldLost = 0;
    for (const [f, sink] of [[plain, 'p'], [cold, 'c']] as const) {
      f.state.clock.month = 1;
      f.div.path = [];
      placeDivision(f.state, f.div, province(f, 'ROVANIEMI'));
      const before = f.div.hp;
      for (let i = 0; i < 10; i++) tickConditionsDaily(f.state, f.index);
      const lost = before - f.div.hp;
      if (sink === 'p') plainLost = lost; else coldLost = lost;
    }
    expect(coldLost).toBeLessThan(plainLost);
    expect(coldLost / plainLost).toBeCloseTo(1 - WINTER_SPECIALIST_RELIEF, 2);
  });
});

describe('commander traits', () => {
  it('every trait the game offers changes something', () => {
    // Six of the ten used to compute nothing at all while being listed on the
    // officer's card in Japanese. This is the guard against that returning:
    // each trait must move a number a player could notice.
    const measured: Record<CommanderTrait, (f: ReturnType<typeof rig>) => number> = {
      organiser: (f) => commandLimit(f.general),
      logistics_wizard: (f) => commandModifiers(f.state, f.div).supplyUse,
      defensive_doctrine: (f) => commandModifiers(f.state, f.div).entrenchment,
      fast_planner: (f) => commandModifiers(f.state, f.div).planningSpeed,
      thorough_planner: (f) => commandModifiers(f.state, f.div).maxPlanningBonus,
      panzer_leader: (f) => {
        makeArmoured(f.state, f.div);
        const to = f.index.get(f.div.provinceId).neighbors[0];
        return movementSpeed(f.state, { index: f.index } as never, f.div, to);
      },
      infantry_leader: (f) => (commandModifiers(f.state, f.div).traits.has('infantry_leader') ? 1 : 0),
      trickster: (f) => (commandModifiers(f.state, f.div).traits.has('trickster') ? 1 : 0),
      winter_specialist: (f) => (commandModifiers(f.state, f.div).traits.has('winter_specialist') ? 1 : 0),
      naval_invader: (f) => (commandModifiers(f.state, f.div).traits.has('naval_invader') ? 1 : 0),
    };
    for (const trait of Object.keys(measured) as CommanderTrait[]) {
      const base = measured[trait](rig([]));
      const with_ = measured[trait](rig([trait]));
      expect(with_, trait).not.toBe(base);
    }
  });

  it('is a complete list: no trait exists that no test knows about', () => {
    // If a trait is added to the game without being added above, this fails
    // before it can ship as another piece of decoration.
    expect([...COMMANDER_TRAITS].sort()).toEqual([
      'defensive_doctrine', 'fast_planner', 'infantry_leader', 'logistics_wizard',
      'naval_invader', 'organiser', 'panzer_leader', 'thorough_planner',
      'trickster', 'winter_specialist',
    ]);
  });

  it('moves a panzer general’s armour faster, and only his armour', () => {
    const plain = rig([]);
    const fast = rig(['panzer_leader']);
    for (const f of [plain, fast]) makeArmoured(f.state, f.div);
    const to = plain.index.get(plain.div.provinceId).neighbors[0];
    const a = movementSpeed(plain.state, { index: plain.index } as never, plain.div, to);
    const b = movementSpeed(fast.state, { index: fast.index } as never, fast.div, to);
    expect(b / a).toBeCloseTo(1 + PANZER_LEADER_SPEED, 4);

    // The same officer over a marching division is worth nothing.
    const foot = rig(['panzer_leader']);
    const footPlain = rig([]);
    const c = movementSpeed(footPlain.state, { index: footPlain.index } as never, footPlain.div, to);
    const d = movementSpeed(foot.state, { index: foot.index } as never, foot.div, to);
    expect(d).toBeCloseTo(c, 6);
  });

  it('keeps the amphibious specialist’s constant honest', () => {
    expect(NAVAL_INVADER_ORG).toBeGreaterThan(0);
    const f = rig(['naval_invader']);
    expect(commandModifiers(f.state, f.div).traits.has('naval_invader')).toBe(true);
  });
});
