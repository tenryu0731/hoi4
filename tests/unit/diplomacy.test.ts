import { describe, expect, it } from 'vitest';

import { Simulation } from '../../src/sim/Simulation';
import {
  GUARANTEE_COST, IMPROVE_COST, INVITE_COST, INVITE_OPINION,
  canLeaveFaction, declareWar, guarantee, improveRelations, inviteBlock, inviteToFaction,
  joinableFactions, opinionOf,
} from '../../src/sim/diplomacy/diplomacy';
import { makeFixture } from './helpers/fixture';
import type { Fixture } from './helpers/fixture';

/**
 * Faction diplomacy.
 *
 * Five of the diplomacy layer's six commands -- improving relations,
 * guaranteeing independence, inviting into a faction, joining one, leaving one
 * -- had no caller anywhere in the game. This is the half of the panel that
 * does not end in an invasion, so these tests are about the one question it
 * turns on: whether a country will follow you into your wars, and what it
 * takes to make it willing.
 */

function rig(seed = 7): Fixture {
  const f = makeFixture({ seed });
  // The AI must not run: a government working through its focus tree moves
  // opinions and borders that these tests are measuring.
  for (const c of f.state.countries) c.isAI = false;
  return f;
}

/** Political power enough that nothing under test fails for want of it. */
function fund(f: Fixture, tag: string, amount = 400): void {
  f.country(tag).economy.politicalPower = amount;
}

describe('faction invitations', () => {
  it('is refused until the country thinks well enough of you', () => {
    const f = rig();
    const ger = f.country('GER');
    const hun = f.country('HUN');
    fund(f, 'GER');

    // Hungary opens at ideology alone, which is nowhere near the bar.
    expect(opinionOf(f.state, hun.id, ger.id)).toBeLessThan(INVITE_OPINION);
    expect(inviteBlock(f.state, ger.id, hun.id)).toBe('opinion');
    expect(inviteToFaction(f.state, ger.id, hun.id)).toBe(false);
    expect(hun.factionId).toBeNull();
  });

  it('is reached by guaranteeing and courting, and costs what it costs', () => {
    const f = rig();
    const ger = f.country('GER');
    const hun = f.country('HUN');
    fund(f, 'GER');

    // The advertised path: a guarantee is worth +20 to the country it
    // protects, each round of diplomacy +12. If this ever stops arriving at
    // the bar, the sheet is offering an action that leads nowhere.
    guarantee(f.state, ger.id, hun.id);
    let rounds = 0;
    while (opinionOf(f.state, hun.id, ger.id) < INVITE_OPINION && rounds < 20) {
      improveRelations(f.state, ger.id, hun.id);
      rounds++;
    }
    expect(rounds).toBeLessThanOrEqual(4);
    expect(inviteBlock(f.state, ger.id, hun.id)).toBeNull();

    const before = ger.economy.politicalPower;
    expect(inviteToFaction(f.state, ger.id, hun.id)).toBe(true);
    expect(ger.economy.politicalPower).toBeCloseTo(before - INVITE_COST, 6);
    expect(hun.factionId).toBe(ger.factionId);
    expect(f.state.factions[ger.factionId!].members).toContain(hun.id);
  });

  it('spends nothing when the answer would have been no', () => {
    const f = rig();
    const ger = f.country('GER');
    const hun = f.country('HUN');
    fund(f, 'GER', 100);
    const before = ger.economy.politicalPower;
    expect(inviteToFaction(f.state, ger.id, hun.id)).toBe(false);
    expect(ger.economy.politicalPower).toBe(before);
  });

  it('may only be sent by the bloc leader', () => {
    const f = rig();
    const ita = f.country('ITA');
    const hun = f.country('HUN');
    fund(f, 'ITA');
    // Italy is in the Axis but does not lead it.
    expect(ita.factionId).not.toBeNull();
    guarantee(f.state, ita.id, hun.id);
    for (let i = 0; i < 6; i++) improveRelations(f.state, ita.id, hun.id);
    expect(opinionOf(f.state, hun.id, ita.id)).toBeGreaterThanOrEqual(INVITE_OPINION);
    expect(inviteBlock(f.state, ita.id, hun.id)).toBe('notLeader');
  });

  it('will not drag a country out of a war it is already fighting', () => {
    const f = rig();
    const ger = f.country('GER');
    const hun = f.country('HUN');
    const sov = f.country('SOV');
    fund(f, 'GER');
    guarantee(f.state, ger.id, hun.id);
    for (let i = 0; i < 4; i++) improveRelations(f.state, ger.id, hun.id);
    expect(inviteBlock(f.state, ger.id, hun.id)).toBeNull();

    declareWar(f.state, sov.id, hun.id);
    expect(inviteBlock(f.state, ger.id, hun.id)).toBe('targetAtWar');
  });

  it('reports a country already spoken for', () => {
    const f = rig();
    const ger = f.country('GER');
    expect(inviteBlock(f.state, ger.id, f.country('ITA').id)).toBe('alreadyIn');
    expect(inviteBlock(f.state, ger.id, f.country('ENG').id)).toBe('otherFaction');
  });
});

describe('leaving and joining a bloc', () => {
  it('does not let a bloc leader walk out of its own bloc', () => {
    const f = rig();
    const ger = f.country('GER');
    expect(canLeaveFaction(f.state, ger.id)).toBe(false);

    const sim = new Simulation(f.state, f.index);
    sim.execute({ t: 'leaveFaction', country: ger.id });
    expect(ger.factionId).not.toBeNull();
    // And the bloc still has someone to speak for it.
    expect(f.state.factions[ger.factionId!].members).toContain(ger.id);
  });

  it('lets a member leave', () => {
    const f = rig();
    const ita = f.country('ITA');
    expect(canLeaveFaction(f.state, ita.id)).toBe(true);
    const axis = f.state.factions[ita.factionId!];
    const sim = new Simulation(f.state, f.index);
    sim.execute({ t: 'leaveFaction', country: ita.id });
    expect(ita.factionId).toBeNull();
    expect(axis.members).not.toContain(ita.id);
  });

  it('refuses an uninvited country that nobody would have asked in', () => {
    const f = rig();
    const hun = f.country('HUN');
    const axis = f.state.factions.find((x) => x.name === 'Axis')!;
    expect(joinableFactions(f.state, hun.id)).not.toContain(axis.id);

    const sim = new Simulation(f.state, f.index);
    sim.execute({ t: 'joinFaction', country: hun.id, faction: axis.id });
    expect(hun.factionId).toBeNull();
  });

  it('admits one the leader would have asked in', () => {
    const f = rig();
    const ger = f.country('GER');
    const hun = f.country('HUN');
    fund(f, 'HUN');
    // Walking in uninvited is the mirror of being invited: an invitation asks
    // whether the country thinks well of the bloc, and an application asks
    // whether the bloc thinks well of the country. So it is Hungary that has
    // to do the courting here.
    guarantee(f.state, hun.id, ger.id);
    for (let i = 0; i < 4; i++) improveRelations(f.state, hun.id, ger.id);

    const axis = f.state.factions[ger.factionId!];
    expect(joinableFactions(f.state, hun.id)).toContain(axis.id);
    const sim = new Simulation(f.state, f.index);
    sim.execute({ t: 'joinFaction', country: hun.id, faction: axis.id });
    expect(hun.factionId).toBe(axis.id);
  });
});

describe('the instruments the invitation depends on', () => {
  it('charges for a guarantee and for each round of diplomacy', () => {
    const f = rig();
    const ger = f.country('GER');
    const hun = f.country('HUN');
    fund(f, 'GER', GUARANTEE_COST + IMPROVE_COST);

    expect(guarantee(f.state, ger.id, hun.id)).toBe(true);
    expect(ger.diplomacy.guarantees).toContain(hun.id);
    expect(improveRelations(f.state, ger.id, hun.id)).toBe(true);
    expect(ger.economy.politicalPower).toBeCloseTo(0, 6);
    // Nothing left to spend, so nothing more happens.
    expect(improveRelations(f.state, ger.id, hun.id)).toBe(false);
    expect(guarantee(f.state, ger.id, f.country('POL').id)).toBe(false);
  });

  it('does not guarantee the same country twice', () => {
    const f = rig();
    const ger = f.country('GER');
    const hun = f.country('HUN');
    fund(f, 'GER');
    expect(guarantee(f.state, ger.id, hun.id)).toBe(true);
    expect(guarantee(f.state, ger.id, hun.id)).toBe(false);
    expect(ger.diplomacy.guarantees.filter((x) => x === hun.id).length).toBe(1);
  });
});
