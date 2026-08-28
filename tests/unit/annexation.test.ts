import { describe, expect, it } from 'vitest';

import { focusDef, focusTreeFor } from '../../src/sim/focus/focusData';
import { ensureFocus, tickFocusDaily } from '../../src/sim/focus/focus';
import { makeFixture } from './helpers/fixture';
import type { Fixture } from './helpers/fixture';

/**
 * The focuses named for things that happened.
 *
 * The Anschluss, the Sudetenland, Albania, the Baltic ultimatum: every one of
 * them moved a border without a shot being fired, and every one of them used
 * to hand over nothing but a war goal. A focus called オーストリア併合 that
 * leaves Austria on the map is the tree advertising a mechanic it does not
 * have.
 */

function rig(seed = 4): Fixture {
  const f = makeFixture({ seed });
  // Nobody else may pick a focus while one country's is under test: the tree
  // is a timetable, and a second government working through it would move
  // borders this test is measuring.
  for (const c of f.state.countries) c.isAI = false;
  return f;
}

function owned(f: Fixture, tag: string): number {
  const c = f.country(tag);
  let n = 0;
  for (const p of f.state.provinces) if (p.owner === c.id) n++;
  return n;
}

function states(f: Fixture, tag: string): number {
  const c = f.country(tag);
  return f.state.states.filter((s) => s.owner === c.id).length;
}

/**
 * Runs one focus to completion, through the real daily tick rather than by
 * reaching into the effect list: the ordering of effects within a focus is
 * part of what is being tested.
 */
function take(f: Fixture, tag: string, id: string): void {
  const c = f.country(tag);
  const def = focusDef(tag, id);
  expect(def, `${tag} has no focus ${id}`).toBeTruthy();
  const focus = ensureFocus(c);
  focus.current = def!.id;
  focus.progress = def!.days - 1;
  tickFocusDaily(f.state, { index: f.index });
  expect(focus.completed, `${id} did not complete`).toContain(id);
}

describe('the focuses that moved borders', () => {
  it('annexes Austria when Germany takes the Anschluss', () => {
    const f = rig();
    const austria = owned(f, 'AUS');
    const germany = owned(f, 'GER');
    expect(austria).toBeGreaterThan(0);

    take(f, 'GER', 'GER_anschluss');

    expect(owned(f, 'AUS'), 'Austria still owns ground').toBe(0);
    expect(f.country('AUS').capitulated).toBe(true);
    // Annexed, not occupied. The border moved, so the ground is Germany's to
    // build on rather than a garrison problem that resists forever: absorbing
    // a beaten country only changes the controller, and that is the difference
    // between a conquest and a union.
    expect(owned(f, 'GER')).toBe(germany + austria);
    for (const st of f.state.states) {
      if (st.owner === f.country('GER').id) expect(st.resistance).toBe(0);
    }
    expect(f.country('GER').atWarWith, 'and without a war').toEqual([]);
  });

  it('takes the Sudetenland, not Prague, at Munich', () => {
    const f = rig();
    // 「ズデーテン地方は割譲できるようにステートだよ」. The region is a state of
    // its own precisely so this can happen to it: it is the only Czechoslovak
    // state on the German border, and it is the one the focus names.
    const named = (tag: string): string[] => f.index.data.states
      .filter((_, i) => f.state.states[i].owner === f.country(tag).id)
      .map((st) => st.name);
    expect(named('CZE'), 'the Sudetenland is a state').toContain('Sudetenland');

    take(f, 'GER', 'GER_anschluss');
    const before = owned(f, 'CZE');
    const beforeStates = states(f, 'CZE');
    const germanStates = states(f, 'GER');
    expect(beforeStates).toBeGreaterThan(3);

    take(f, 'GER', 'GER_sudetenland');

    expect(named('GER'), 'and Germany now holds it').toContain('Sudetenland');
    expect(named('CZE'), 'while Prague stays Czechoslovak').toContain('Prague');
    expect(owned(f, 'CZE'), 'Czechoslovakia survives Munich').toBeGreaterThan(0);
    expect(owned(f, 'CZE'), 'and loses ground to it').toBeLessThan(before);
    expect(f.country('CZE').capitulated).toBe(false);
    expect(states(f, 'GER')).toBe(germanStates + 1);
    expect(states(f, 'CZE')).toBe(beforeStates - 1);
    expect(f.country('GER').atWarWith).toEqual([]);
  });

  it('finishes Czechoslovakia off with the follow-up focus', () => {
    const f = rig();
    take(f, 'GER', 'GER_anschluss');
    take(f, 'GER', 'GER_sudetenland');
    expect(owned(f, 'CZE')).toBeGreaterThan(0);
    take(f, 'GER', 'GER_prague');
    expect(owned(f, 'CZE')).toBe(0);
  });

  it('leaves a war goal behind when the demand is refused', () => {
    const f = rig();
    const ger = f.country('GER');
    const aus = f.country('AUS');
    // A guarantee is the historical answer to an ultimatum, and the one thing
    // that turns the Anschluss into a campaign.
    f.country('ENG').diplomacy.guarantees.push(aus.id);

    take(f, 'GER', 'GER_anschluss');

    expect(owned(f, 'AUS'), 'a guaranteed Austria is not annexed').toBeGreaterThan(0);
    const claim = ger.diplomacy.justifications.find((j) => j.target === aus.id);
    expect(claim, 'two months of national attention must leave somewhere to go').toBeTruthy();
    expect(claim!.progress).toBe(claim!.required);
  });

  it('annexes the Baltic states on the Soviet ultimatum', () => {
    const f = rig();
    const sizes = ['EST', 'LAT', 'LIT'].map((t) => owned(f, t));
    take(f, 'SOV', 'SOV_baltic_ultimatum');
    for (const tag of ['EST', 'LAT', 'LIT']) {
      expect(owned(f, tag), `${tag} survived the ultimatum`).toBe(0);
    }
    expect(f.country('SOV').atWarWith).toEqual([]);
    expect(sizes.every((n) => n > 0)).toBe(true);
  });

  it('never spends a focus on a demand nobody can act on', () => {
    // Every annex and cede target has to exist in the scenario, or the focus
    // is a two-month programme that completes and does nothing at all.
    const f = makeFixture();
    const tags = new Set(f.state.countries.map((c) => c.tag));
    const missing: string[] = [];
    for (const tag of ['GER', 'SOV', 'ENG', 'FRA', 'ITA', 'GEN']) {
      for (const def of focusTreeFor(tag).focuses) {
        for (const e of def.effects) {
          if ((e.k === 'annex' || e.k === 'cede') && !tags.has(e.target)) {
            missing.push(`${def.id} -> ${e.target}`);
          }
        }
      }
    }
    expect(missing, missing.join(', ')).toEqual([]);
  });
});
