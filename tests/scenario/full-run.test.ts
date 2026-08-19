import { describe, expect, it } from 'vitest';

import { Simulation } from '../../src/sim/Simulation';
import { TimeEngine } from '../../src/sim/time/TimeEngine';
import { checkInvariants } from '../../src/sim/core/invariants';
import { formatDate } from '../../src/sim/time/calendar';
import { SCENARIO_END_HOURS } from '../../src/sim/scenario/victory';
import type { GameState } from '../../src/sim/core/types';
import { makeFixture } from '../unit/helpers/fixture';

/**
 * Headless full-scenario runs.
 *
 * This is the test that actually answers "can you play this from start to
 * finish without it falling over". No browser: the simulation is DOM-free by
 * construction, so 1936 to 1948 runs in a few seconds and the invariants can be
 * checked every single month rather than at the end.
 */

interface RunResult {
  state: GameState;
  hours: number;
  invariantErrors: string[];
  monthsChecked: number;
  wallMs: number;
  maxDivisions: number;
}

function runScenario(opts: {
  seed: number;
  playerTag: string;
  maxHours?: number;
  checkInvariantsMonthly?: boolean;
  /**
   * Drive the player's country with the AI too. Without this the player's
   * nation sits inert for twelve years, which exercises far less of the
   * simulation than a genuine all-sides campaign.
   */
  allAI?: boolean;
}): RunResult {
  const f = makeFixture({ seed: opts.seed, playerTag: opts.playerTag });
  if (opts.allAI !== false) {
    for (const c of f.state.countries) c.isAI = true;
  }
  const sim = new Simulation(f.state, f.index);
  const time = new TimeEngine(f.state.clock.totalHours);

  const invariantErrors: string[] = [];
  let monthsChecked = 0;
  let maxDivisions = 0;

  time.on((ctx) => {
    sim.tick(ctx);
    if (!ctx.newMonth) return;
    monthsChecked++;
    const live = f.state.divisions.filter((d) => !d.dead).length;
    if (live > maxDivisions) maxDivisions = live;
    if (opts.checkInvariantsMonthly !== false && invariantErrors.length === 0) {
      const errs = checkInvariants(f.state, f.index.count);
      if (errs.length) {
        invariantErrors.push(`${formatDate(ctx.clock)}: ${errs.join('; ')}`);
      }
    }
  });

  const limit = opts.maxHours ?? SCENARIO_END_HOURS + 24;
  const t0 = Date.now();
  while (time.hours < limit && f.state.outcome.status === 'playing') {
    time.step(24);
  }
  return {
    state: f.state,
    hours: time.hours,
    invariantErrors,
    monthsChecked,
    wallMs: Date.now() - t0,
    maxDivisions,
  };
}

describe('full scenario', () => {
  it('plays Europe 1936 to a decided outcome without breaking its invariants', () => {
    const r = runScenario({ seed: 20250101, playerTag: 'GER' });
    const wars = r.state.log.filter((e) => e.kind === 'war').map((e) => `${e.day}: ${e.text}`);
    console.log(`wars:\n  ${wars.slice(0, 14).join('\n  ')}`);

    console.log(
      `outcome=${r.state.outcome.status}` +
      ` reason=${'reason' in r.state.outcome ? r.state.outcome.reason : '-'}` +
      ` date=${formatDate(r.state.clock)}` +
      ` wars=${r.state.wars.length}` +
      ` capitulated=${r.state.countries.filter((c) => c.capitulated).length}` +
      ` divisions=${r.state.divisions.filter((d) => !d.dead).length}` +
      ` peakDivisions=${r.maxDivisions}` +
      ` months=${r.monthsChecked}` +
      ` wall=${r.wallMs}ms`,
    );

    expect(r.invariantErrors, r.invariantErrors.join('\n')).toEqual([]);
    expect(r.state.outcome.status).not.toBe('playing');
    expect(r.monthsChecked).toBeGreaterThan(12);
  });

  it('terminates for every playable major power', () => {
    const results: string[] = [];
    for (const tag of ['GER', 'FRA', 'ENG', 'SOV', 'ITA']) {
      const r = runScenario({ seed: 4242, playerTag: tag });
      results.push(
        `${tag}: ${r.state.outcome.status} at ${formatDate(r.state.clock)}` +
        ` (${r.state.countries.filter((c) => c.capitulated).length} capitulations)`,
      );
      expect(r.invariantErrors, `${tag}\n${r.invariantErrors.join('\n')}`).toEqual([]);
      expect(r.state.outcome.status, tag).not.toBe('playing');
    }
    console.log(results.join('\n'));
  });

  it('produces the same history from the same seed', () => {
    const digest = () => {
      const r = runScenario({ seed: 99, playerTag: 'GER', checkInvariantsMonthly: false });
      return {
        outcome: r.state.outcome,
        hours: r.hours,
        controllers: r.state.provinces.map((p) => p.controller),
        capitulated: r.state.countries.map((c) => c.capitulated),
        divisions: r.state.divisions.filter((d) => !d.dead).length,
      };
    };
    expect(digest()).toEqual(digest());
  });

  it('diverges when the seed changes', () => {
    const a = runScenario({ seed: 1, playerTag: 'GER', checkInvariantsMonthly: false });
    const b = runScenario({ seed: 2, playerTag: 'GER', checkInvariantsMonthly: false });
    const same = a.state.provinces.every((p, i) => p.controller === b.state.provinces[i].controller);
    expect(same).toBe(false);
  });

  it('always reaches a war and at least one capitulation', () => {
    const r = runScenario({ seed: 20250101, playerTag: 'GER' });
    expect(r.state.wars.length).toBeGreaterThan(0);
    expect(r.state.countries.filter((c) => c.capitulated).length).toBeGreaterThan(0);
  });

  it('moves the front: territory actually changes hands', () => {
    const before = makeFixture({ seed: 20250101, playerTag: 'GER' });
    const r = runScenario({ seed: 20250101, playerTag: 'GER' });
    let changed = 0;
    for (let i = 0; i < r.state.provinces.length; i++) {
      if (r.state.provinces[i].controller !== before.state.provinces[i].controller) changed++;
    }
    const fraction = changed / r.state.provinces.length;
    console.log(`${changed}/${r.state.provinces.length} provinces changed hands`);
    expect(fraction).toBeGreaterThan(0.05);
  });

  it('lets a passive player lose ground to an active world', () => {
    // With the player's own country inert, the campaign must still run and
    // resolve rather than stalling on a nation that never issues an order.
    const r = runScenario({ seed: 20250101, playerTag: 'GER', allAI: false });
    expect(r.invariantErrors, r.invariantErrors.join('\n')).toEqual([]);
    expect(r.state.outcome.status).not.toBe('playing');
  });

  it('leaves no army belonging to a capitulated country', () => {
    const r = runScenario({ seed: 7, playerTag: 'SOV' });
    for (const d of r.state.divisions) {
      if (d.dead) continue;
      expect(r.state.countries[d.owner].capitulated, `division ${d.id}`).toBe(false);
    }
  });

  it('keeps every province under a living controller', () => {
    const r = runScenario({ seed: 11, playerTag: 'FRA' });
    for (let i = 0; i < r.state.provinces.length; i++) {
      const controller = r.state.countries[r.state.provinces[i].controller];
      expect(controller.capitulated, `province ${i}`).toBe(false);
    }
  });

  it('never lets division count run away', () => {
    const r = runScenario({ seed: 5, playerTag: 'GER', checkInvariantsMonthly: false });
    // Europe cannot field an unbounded army: the manpower and equipment gates
    // must hold across twelve simulated years.
    expect(r.maxDivisions).toBeLessThan(3000);
  });

  it('simulates a full campaign fast enough to be practical', () => {
    const r = runScenario({ seed: 3, playerTag: 'ENG', checkInvariantsMonthly: false });
    const days = r.hours / 24;
    const perDay = r.wallMs / days;
    console.log(
      `simulated ${days.toFixed(0)} days in ${r.wallMs}ms (${perDay.toFixed(2)}ms/day)`,
    );
    // At speed 5 the game runs about 60 in-game days a minute; a day must cost
    // far less than the 16ms frame that has to contain it.
    expect(perDay).toBeLessThan(16);
  });
});
