import { describe, expect, it } from 'vitest';

import {
  INITIAL_RESISTANCE, occupiedOutput, tickOccupationDaily,
} from '../../src/sim/economy/occupation';
import { recomputeFactories } from '../../src/sim/economy/production';
import { makeFixture } from './helpers/fixture';

/** Hands a state to somebody who does not own it. */
function occupy(f: ReturnType<typeof makeFixture>, stateIndex: number, byTag: string) {
  const st = f.state.states[stateIndex];
  st.controller = f.country(byTag).id;
  st.resistance = INITIAL_RESISTANCE;
  return st;
}

describe('occupied territory', () => {
  it('never resists on home ground', () => {
    const f = makeFixture();
    const home = f.state.states.find((s) => s.owner === s.controller)!;
    home.resistance = 0.9;
    tickOccupationDaily(f.state);
    expect(home.resistance).toBe(0);
    expect(occupiedOutput(home)).toBe(1);
  });

  it('grows restive when nobody is standing on it', () => {
    const f = makeFixture();
    const idx = f.state.states.findIndex((s) => f.state.countries[s.owner].tag === 'POL');
    const st = occupy(f, idx, 'GER');
    for (const id of st.provinces) f.state.provinces[id].divisions = [];
    const before = st.resistance;
    for (let d = 0; d < 20; d++) tickOccupationDaily(f.state);
    expect(st.resistance).toBeGreaterThan(before);
  });

  it('is put down by a garrison, and needs enough of one', () => {
    const f = makeFixture();
    // A state with room in it. Suppression is per division per province, so on
    // a two-province state one division genuinely is a garrison and the first
    // half of this test would be asserting the opposite of the rule.
    const idx = f.state.states.reduce(
      (best, s, i, all) => (f.state.countries[s.owner].tag === 'POL'
        && s.provinces.length > (all[best]?.provinces.length ?? 0) ? i : best),
      -1,
    );
    const st = occupy(f, idx, 'GER');
    const ger = f.country('GER');

    // One division over a whole state is not a garrison: measured flat, a
    // single formation anywhere in occupied France held the entire country
    // quiet, which is the pure-profit conquest this exists to end.
    const mine = f.state.divisions.filter((d) => d.owner === ger.id && !d.dead);
    for (const id of st.provinces) f.state.provinces[id].divisions = [];
    f.state.provinces[st.provinces[0]].divisions = [mine[0].id];
    mine[0].provinceId = st.provinces[0];
    for (const id of st.provinces) f.state.provinces[id].controller = ger.id;
    const thin = st.resistance;
    for (let d = 0; d < 20; d++) tickOccupationDaily(f.state);
    expect(st.resistance).toBeGreaterThanOrEqual(thin);

    // Enough of one does put it down.
    st.resistance = INITIAL_RESISTANCE;
    st.provinces.forEach((id, i) => {
      const d = mine[i % mine.length];
      d.provinceId = id;
      f.state.provinces[id].divisions = [d.id];
    });
    for (let d = 0; d < 30; d++) tickOccupationDaily(f.state);
    expect(st.resistance).toBeLessThan(INITIAL_RESISTANCE);
  });

  it('costs the occupier output, and the home country nothing', () => {
    const f = makeFixture();
    const idx = f.state.states.findIndex((s) => f.state.countries[s.owner].tag === 'POL');
    const st = occupy(f, idx, 'GER');
    st.civilianFactories = 10;
    const ger = f.country('GER');

    st.resistance = 0;
    recomputeFactories(f.state, ger.id);
    const quiet = ger.economy.civilianFactories;

    st.resistance = 1;
    recomputeFactories(f.state, ger.id);
    expect(ger.economy.civilianFactories).toBeLessThan(quiet);
    expect(occupiedOutput(st)).toBeLessThan(1);
    expect(occupiedOutput(st)).toBeGreaterThan(0);
  });
});
