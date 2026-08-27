import { describe, expect, it } from 'vitest';

import { Simulation } from '../../src/sim/Simulation';
import {
  GUARANTEE_COST, IMPROVE_COST, INVITE_COST, INVITE_OPINION,
  canLeaveFaction, capitulate, declareWar, guarantee, improveRelations, inviteBlock,
  inviteToFaction, joinableFactions, opinionOf,
} from '../../src/sim/diplomacy/diplomacy';
import { captureProvince } from '../../src/sim/military/movement';
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

describe('the peace conference', () => {
  /** Everything one country owns, handed to another as an occupier. */
  function occupy(f: Fixture, ownerTag: string, byTag: string, share = 1): void {
    const owner = f.country(ownerTag);
    const by = f.country(byTag);
    let n = 0;
    for (const p of f.state.provinces) {
      if (!p || p.owner !== owner.id) continue;
      n++;
      if (n % Math.round(1 / share) !== 0) continue;
      p.controller = by.id;
    }
  }

  it('divides a beaten country by what each winner took off it', () => {
    const f = rig();
    const ger = f.country('GER');
    const ita = f.country('ITA');
    const pol = f.country('POL');
    // Italy is in the Axis, so a German war is an Italian war too.
    declareWar(f.state, ger.id, pol.id);
    expect(ita.atWarWith).toContain(pol.id);
    occupy(f, 'POL', 'GER');

    const war = f.state.wars.find((w) => w.defenders.includes(pol.id))!;
    // Stated rather than played out, so the test is about the rule.
    war.contribution = { [ger.id]: 300, [ita.id]: 100 };

    capitulate(f.state, { index: f.index }, pol.id);

    const polish = f.state.states
      .map((st, id) => ({ st, id }))
      .filter((x) => x.st && x.st.owner === pol.id);
    expect(polish.length).toBeGreaterThan(3);
    const share = (id: number): number =>
      polish.filter((x) => x.st.controller === id).length;

    // Both of them get something, and the one that did more gets more.
    expect(share(ger.id)).toBeGreaterThan(0);
    expect(share(ita.id)).toBeGreaterThan(0);
    expect(share(ger.id)).toBeGreaterThan(share(ita.id));
    expect(share(ger.id) + share(ita.id)).toBe(polish.length);
  });

  it('gives a coalition partner who did nothing nothing', () => {
    const f = rig();
    const ger = f.country('GER');
    const ita = f.country('ITA');
    const pol = f.country('POL');
    declareWar(f.state, ger.id, pol.id);
    occupy(f, 'POL', 'GER');
    const war = f.state.wars.find((w) => w.defenders.includes(pol.id))!;
    war.contribution = { [ger.id]: 300 };

    capitulate(f.state, { index: f.index }, pol.id);

    const polish = f.state.states.filter((st) => st && st.owner === pol.id);
    expect(polish.every((st) => st.controller === ger.id)).toBe(true);
    expect(ita.capitulated).toBe(false);
  });

  it('leaves no state pointing at a country that no longer exists', () => {
    const f = rig();
    const ger = f.country('GER');
    const pol = f.country('POL');
    const cze = f.country('CZE');
    // Poland has taken a piece of Czechoslovakia, then loses its own war.
    declareWar(f.state, pol.id, cze.id);
    occupy(f, 'CZE', 'POL');
    declareWar(f.state, ger.id, pol.id);
    occupy(f, 'POL', 'GER');

    capitulate(f.state, { index: f.index }, pol.id);

    for (const st of f.state.states) {
      if (!st) continue;
      expect(f.state.countries[st.controller].capitulated, `state of ${st.owner}`).toBe(false);
    }
    for (const p of f.state.provinces) {
      if (!p) continue;
      expect(f.state.countries[p.controller].capitulated).toBe(false);
    }
  });

  it('counts a capture into the ledger of the war it was made in', () => {
    const f = rig();
    const ger = f.country('GER');
    const pol = f.country('POL');
    declareWar(f.state, ger.id, pol.id);
    const war = f.state.wars.find((w) => w.defenders.includes(pol.id))!;
    expect(war.contribution?.[ger.id] ?? 0).toBe(0);

    const target = f.state.provinces.findIndex((p) => p && p.owner === pol.id);
    const vp = f.index.get(target).vp;
    captureProvince(f.state, { index: f.index }, target, ger.id);
    expect(war.contribution?.[ger.id] ?? 0).toBe(vp);

    // And not into a war neither side is fighting.
    const other = f.state.wars.find((w) => w !== war);
    expect(other?.contribution?.[ger.id] ?? 0).toBe(0);
  });
});
