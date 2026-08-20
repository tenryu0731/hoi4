import { describe, expect, it } from 'vitest';

import { Simulation } from '../../src/sim/Simulation';

import {
  ORG_RECOVERY_PER_HOUR, effectiveness, equipmentRatio, findCombatAt,
  resolveCombatRound, tickDivisionUpkeep,
} from '../../src/sim/military/combat';
import {
  captureProvince, isHostile, movementSpeed, orderMove, placeDivision,
  retreat, tickMilitaryHourly, tickReinforcementDaily,
} from '../../src/sim/military/movement';
import {
  computeSupply, encircledProvinces, supplySources, tickSupplyDaily,
} from '../../src/sim/military/supply';
import { spawnDivision, TEMPLATE_ARMOUR, TEMPLATE_INFANTRY } from '../../src/sim/scenario/europe1936';
import type { Division, GameState, ProvinceId } from '../../src/sim/core/types';
import { makeFixture, type Fixture } from './helpers/fixture';

function ctxOf(f: Fixture) {
  return { index: f.index };
}

/** Puts two countries at war with each other. */
function declareWar(state: GameState, a: number, b: number): void {
  if (!state.countries[a].atWarWith.includes(b)) state.countries[a].atWarWith.push(b);
  if (!state.countries[b].atWarWith.includes(a)) state.countries[b].atWarWith.push(a);
}

function liveDivisions(state: GameState): Division[] {
  return state.divisions.filter((d) => !d.dead);
}

/** Strips every division so a test starts from a clean board. */
function clearArmies(f: Fixture): void {
  for (const d of f.state.divisions) d.dead = true;
  for (const p of f.state.provinces) p.divisions = [];
}

describe('templates', () => {
  it('derives sane stats for the starting templates', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    for (const tpl of ger.templates) {
      expect(tpl.maxOrg).toBeGreaterThan(0);
      expect(tpl.maxHp).toBeGreaterThan(0);
      expect(tpl.softAttack).toBeGreaterThan(0);
      expect(tpl.defense).toBeGreaterThan(0);
      expect(tpl.width).toBeGreaterThan(0);
      expect(tpl.manpowerNeed).toBeGreaterThan(0);
      expect(tpl.speedKmh).toBeGreaterThan(0);
      expect(Object.keys(tpl.equipmentNeed).length).toBeGreaterThan(0);
    }
  });

  it('makes armour harder and faster-hitting than infantry', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const inf = ger.templates[TEMPLATE_INFANTRY];
    const arm = ger.templates[TEMPLATE_ARMOUR];
    expect(arm.hardness).toBeGreaterThan(inf.hardness);
    expect(arm.hardAttack).toBeGreaterThan(inf.hardAttack);
    expect(arm.breakthrough).toBeGreaterThan(inf.breakthrough);
    expect(arm.armor).toBeGreaterThan(inf.armor);
    expect(arm.buildCost).toBeGreaterThan(inf.buildCost);
  });
});

describe('equipment and effectiveness', () => {
  it('scales linearly with equipment on hand', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, ger.capital, 1);
    expect(equipmentRatio(f.state, d)).toBeCloseTo(1, 3);

    for (const k of Object.keys(d.equipment) as (keyof typeof d.equipment)[]) {
      d.equipment[k] = (d.equipment[k] ?? 0) * 0.5;
    }
    expect(equipmentRatio(f.state, d)).toBeCloseTo(0.5, 3);
  });

  it('halves output at zero supply and never goes to zero', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, ger.capital, 1);

    d.supplyLevel = 1;
    const full = effectiveness(f.state, d);
    d.supplyLevel = 0;
    const starved = effectiveness(f.state, d);
    expect(starved).toBeCloseTo(full * 0.5, 5);
    expect(starved).toBeGreaterThan(0);
  });
});

describe('combat resolution', () => {
  /** Sets up N attackers against M defenders in one province. */
  function battle(attackers: number, defenders: number, template = TEMPLATE_INFANTRY) {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const pol = f.country('POL');
    declareWar(f.state, ger.id, pol.id);

    const province = f.provinceOf('POL');
    const combat = {
      id: f.state.nextIds.combat++,
      province,
      attackerCountry: ger.id,
      defenderCountry: pol.id,
      attackers: [] as number[],
      defenders: [] as number[],
      startHour: 0,
      attackerProgress: 0,
      ended: false,
    };
    f.state.combats.push(combat);

    for (let i = 0; i < attackers; i++) {
      const d = spawnDivision(f.state, ger.id, template, province, 1);
      d.combatId = combat.id;
      combat.attackers.push(d.id);
    }
    for (let i = 0; i < defenders; i++) {
      const d = spawnDivision(f.state, pol.id, TEMPLATE_INFANTRY, province, 1);
      d.combatId = combat.id;
      combat.defenders.push(d.id);
    }
    return { f, combat };
  }

  it('does not resolve an even fight within the first day', () => {
    const { f, combat } = battle(3, 3);
    let rounds = 0;
    for (; rounds < 24; rounds++) {
      if (resolveCombatRound(f.state, ctxOf(f), combat).ended) break;
    }
    expect(rounds).toBe(24);
    const attOrg = combat.attackers.reduce((s, id) => s + f.state.divisions[id].org, 0);
    const defOrg = combat.defenders.reduce((s, id) => s + f.state.divisions[id].org, 0);
    expect(attOrg).toBeGreaterThan(0);
    expect(defOrg).toBeGreaterThan(0);
  });

  it('favours the defender when the two sides are equal', () => {
    const { f, combat } = battle(3, 3);
    for (let i = 0; i < 24; i++) {
      if (resolveCombatRound(f.state, ctxOf(f), combat).ended) break;
    }
    const org = (ids: number[]) => ids.reduce((s, id) => s + f.state.divisions[id].org, 0);
    const hp = (ids: number[]) => ids.reduce((s, id) => s + f.state.divisions[id].hp, 0);
    expect(org(combat.defenders)).toBeGreaterThan(org(combat.attackers));
    expect(hp(combat.defenders)).toBeGreaterThan(hp(combat.attackers));
  });

  it('eventually breaks the attacker in an even fight', () => {
    const { f, combat } = battle(3, 3);
    let ended = false;
    let attackerWon = true;
    for (let i = 0; i < 2000 && !ended; i++) {
      const r = resolveCombatRound(f.state, ctxOf(f), combat);
      ended = r.ended;
      attackerWon = r.attackerWon;
    }
    expect(ended).toBe(true);
    expect(attackerWon).toBe(false);
  });

  it('lets a heavy attacker break a lone defender', () => {
    const { f, combat } = battle(8, 1);
    let ended = false;
    let attackerWon = false;
    for (let i = 0; i < 400 && !ended; i++) {
      const r = resolveCombatRound(f.state, ctxOf(f), combat);
      ended = r.ended;
      attackerWon = r.attackerWon;
    }
    expect(ended).toBe(true);
    expect(attackerWon).toBe(true);
  });

  it('lets a dug-in defender repel a weak attack', () => {
    const { f, combat } = battle(1, 6);
    let ended = false;
    let attackerWon = true;
    for (let i = 0; i < 400 && !ended; i++) {
      const r = resolveCombatRound(f.state, ctxOf(f), combat);
      ended = r.ended;
      attackerWon = r.attackerWon;
    }
    expect(ended).toBe(true);
    expect(attackerWon).toBe(false);
  });

  it('makes under-equipped divisions fight measurably worse', () => {
    const strong = battle(4, 4);
    const weak = battle(4, 4);
    for (const id of weak.combat.attackers) {
      const d = weak.f.state.divisions[id];
      for (const k of Object.keys(d.equipment) as (keyof typeof d.equipment)[]) {
        d.equipment[k] = (d.equipment[k] ?? 0) * 0.4;
      }
    }
    for (let i = 0; i < 12; i++) {
      resolveCombatRound(strong.f.state, ctxOf(strong.f), strong.combat);
      resolveCombatRound(weak.f.state, ctxOf(weak.f), weak.combat);
    }
    const defOrg = (b: typeof strong) =>
      b.combat.defenders.reduce((s, id) => s + b.f.state.divisions[id].org, 0);
    expect(defOrg(weak)).toBeGreaterThan(defOrg(strong));
  });

  it('never drives organisation or strength below zero', () => {
    const { f, combat } = battle(10, 1);
    for (let i = 0; i < 200; i++) {
      if (resolveCombatRound(f.state, ctxOf(f), combat).ended) break;
    }
    for (const d of f.state.divisions) {
      expect(d.org).toBeGreaterThanOrEqual(0);
      expect(d.hp).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(d.org)).toBe(true);
      expect(Number.isFinite(d.hp)).toBe(true);
    }
  });

  it('favours the defender in mountains over plains', () => {
    const run = (terrain: 'plains' | 'mountain') => {
      const { f, combat } = battle(4, 2);
      f.index.get(combat.province).terrain = terrain;
      for (let i = 0; i < 20; i++) {
        if (resolveCombatRound(f.state, ctxOf(f), combat).ended) break;
      }
      return combat.defenders.reduce((s, id) => s + f.state.divisions[id].org, 0);
    };
    expect(run('mountain')).toBeGreaterThan(run('plains'));
  });

  it('is deterministic for a given seed', () => {
    const snapshot = () => {
      const { f, combat } = battle(5, 3);
      for (let i = 0; i < 30; i++) {
        if (resolveCombatRound(f.state, ctxOf(f), combat).ended) break;
      }
      return f.state.divisions.map((d) => [d.org.toFixed(6), d.hp.toFixed(6)]);
    };
    expect(snapshot()).toEqual(snapshot());
  });
});

describe('recovery and attrition', () => {
  it('recovers organisation out of combat, up to the maximum', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, ger.capital, 1);
    const tpl = ger.templates[TEMPLATE_INFANTRY];
    d.org = 1;
    d.supplyLevel = 1;

    tickDivisionUpkeep(f.state, d);
    expect(d.org).toBeCloseTo(1 + tpl.maxOrg * ORG_RECOVERY_PER_HOUR, 5);

    for (let i = 0; i < 2000; i++) tickDivisionUpkeep(f.state, d);
    expect(d.org).toBeLessThanOrEqual(tpl.maxOrg + 1e-9);
    expect(d.org).toBeCloseTo(tpl.maxOrg, 3);
  });

  it('does not recover while engaged', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, ger.capital, 1);
    d.org = 5;
    d.combatId = 1;
    tickDivisionUpkeep(f.state, d);
    expect(d.org).toBe(5);
  });

  it('bleeds a division that is out of supply', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, ger.capital, 1);
    d.supplyLevel = 0;
    const org0 = d.org;
    const hp0 = d.hp;
    const eq0 = d.equipment.infantry_equipment ?? 0;
    for (let i = 0; i < 240; i++) tickDivisionUpkeep(f.state, d);
    expect(d.org).toBeLessThan(org0);
    expect(d.hp).toBeLessThan(hp0);
    expect(d.equipment.infantry_equipment ?? 0).toBeLessThan(eq0);
    expect(d.hp).toBeGreaterThanOrEqual(0);
  });
});

describe('movement', () => {
  it('routes between adjacent provinces in one hop', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const from = f.provinceOf('GER');
    const to = f.index.get(from).neighbors[0];
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, from, 1);
    expect(orderMove(f.state, ctxOf(f), d, to)).toBe(true);
    expect(d.path).toEqual([to]);
  });

  it('arrives after the distance has been covered', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const from = f.provinceOf('GER');
    const to = f.index.get(from).neighbors.find(
      (n) => f.state.provinces[n].controller !== ger.id,
    )!;
    // Make the destination friendly so it is a march, not an attack.
    f.state.provinces[to].controller = ger.id;

    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, from, 1);
    d.supplyLevel = 1;
    orderMove(f.state, ctxOf(f), d, to);

    const distance = f.index.distance(from, to);
    const speed = movementSpeed(f.state, ctxOf(f), d, to);
    const expectedHours = Math.ceil(distance / speed);

    for (let h = 0; h < expectedHours - 1; h++) tickMilitaryHourly(f.state, ctxOf(f));
    expect(d.provinceId).toBe(from);
    tickMilitaryHourly(f.state, ctxOf(f));
    tickMilitaryHourly(f.state, ctxOf(f));
    expect(d.provinceId).toBe(to);
    expect(d.path.length).toBe(0);
  });

  it('moves slower through mountains than across plains', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, ger.capital, 1);
    d.supplyLevel = 1;
    const target = f.index.get(ger.capital).neighbors[0];

    f.index.get(target).terrain = 'plains';
    const fast = movementSpeed(f.state, ctxOf(f), d, target);
    f.index.get(target).terrain = 'mountain';
    const slow = movementSpeed(f.state, ctxOf(f), d, target);
    expect(slow).toBeLessThan(fast);
  });

  it('moves slower when out of supply', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, ger.capital, 1);
    const target = f.index.get(ger.capital).neighbors[0];
    d.supplyLevel = 1;
    const supplied = movementSpeed(f.state, ctxOf(f), d, target);
    d.supplyLevel = 0;
    expect(movementSpeed(f.state, ctxOf(f), d, target)).toBeLessThan(supplied);
  });

  it('walks into undefended enemy ground and takes it', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const pol = f.country('POL');
    declareWar(f.state, ger.id, pol.id);

    const from = f.provinceOf('GER');
    const to = f.provinceOf('POL');
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, from, 1);
    d.supplyLevel = 1;
    orderMove(f.state, ctxOf(f), d, to);

    for (let h = 0; h < 24 * 60 && f.state.provinces[to].controller !== ger.id; h++) {
      tickMilitaryHourly(f.state, ctxOf(f));
    }
    expect(f.state.provinces[to].controller).toBe(ger.id);
    expect(d.provinceId).toBe(to);
  });

  it('opens a battle instead of walking into a defended province', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const pol = f.country('POL');
    declareWar(f.state, ger.id, pol.id);

    const from = f.provinceOf('GER');
    const to = f.provinceOf('POL');
    spawnDivision(f.state, pol.id, TEMPLATE_INFANTRY, to, 1);
    const attacker = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, from, 1);
    attacker.supplyLevel = 1;
    orderMove(f.state, ctxOf(f), attacker, to);

    for (let h = 0; h < 24 * 60 && attacker.combatId === null; h++) {
      tickMilitaryHourly(f.state, ctxOf(f));
    }
    expect(attacker.combatId).not.toBeNull();
    expect(findCombatAt(f.state, to)).not.toBeNull();
    expect(f.state.provinces[to].controller).toBe(pol.id);
  });

  it('refuses to move a division whose organisation is spent', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const from = f.provinceOf('GER');
    const to = f.index.get(from).neighbors[0];
    f.state.provinces[to].controller = ger.id;

    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, from, 1);
    orderMove(f.state, ctxOf(f), d, to);
    d.org = 0;
    for (let h = 0; h < 200; h++) tickMilitaryHourly(f.state, ctxOf(f));
    // Organisation recovers eventually, so only the first hours are pinned.
    expect(d.moveProgress).toBeLessThan(1);
  });
});

describe('retreat and destruction', () => {
  it('falls back to a friendly neighbour', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const home = f.provinceOf('GER');
    const front = f.index.get(home).neighbors[0];
    f.state.provinces[front].controller = ger.id;

    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, front, 1);
    retreat(f.state, ctxOf(f), d, front);
    expect(d.dead).toBe(false);
    expect(d.provinceId).not.toBe(front);
    expect(f.state.provinces[d.provinceId].controller).toBe(ger.id);
    expect(d.retreatCooldown).toBeGreaterThan(0);
  });

  it('destroys a division with nowhere to go', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const sov = f.country('SOV');
    declareWar(f.state, ger.id, sov.id);

    const pocket = f.provinceOf('GER');
    for (const nb of f.index.get(pocket).neighbors) {
      f.state.provinces[nb].controller = sov.id;
    }
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, pocket, 1);
    retreat(f.state, ctxOf(f), d, pocket);
    expect(d.dead).toBe(true);
    expect(liveDivisions(f.state).length).toBe(0);
  });

  it('removes a destroyed division from its province roster', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const sov = f.country('SOV');
    declareWar(f.state, ger.id, sov.id);
    const pocket = f.provinceOf('GER');
    for (const nb of f.index.get(pocket).neighbors) f.state.provinces[nb].controller = sov.id;
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, pocket, 1);
    retreat(f.state, ctxOf(f), d, pocket);
    expect(f.state.provinces[pocket].divisions).not.toContain(d.id);
  });
});

describe('supply', () => {
  it('gives the capital full supply and decays with distance', () => {
    const f = makeFixture();
    const sov = f.country('SOV');
    const levels = computeSupply(f.state, f.index, sov.id, supplySources(f.state, f.index, sov.id));
    expect(levels[sov.capital]).toBe(1);
  });

  it('carries supply across a coalition but not beyond it', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const bloc = new Set(f.state.factions[ger.factionId!].members);
    const levels = computeSupply(f.state, f.index, ger.id, supplySources(f.state, f.index, ger.id));
    for (let i = 0; i < levels.length; i++) {
      if (!bloc.has(f.state.provinces[i].controller)) {
        expect(levels[i], `province ${i}`).toBe(0);
      }
    }
    // An ally's ground is inside the network.
    const ita = f.country('ITA');
    expect(levels[ita.capital]).toBeGreaterThan(0);
  });

  it('leaves an unaligned country with nothing once its ports and capital are gone', () => {
    const f = makeFixture();
    const hun = f.country('HUN');       // landlocked and unaligned
    const sov = f.country('SOV');
    expect(hun.factionId).toBeNull();
    for (let i = 0; i < f.state.provinces.length; i++) {
      if (f.state.provinces[i].controller === hun.id) f.state.provinces[i].controller = sov.id;
    }
    const levels = computeSupply(f.state, f.index, hun.id, supplySources(f.state, f.index, hun.id));
    expect(Math.max(...levels)).toBe(0);
  });

  it('leaves peacetime countries fully supplied', () => {
    const f = makeFixture();
    tickSupplyDaily(f.state, f.index);
    for (const p of f.state.provinces) expect(p.supply).toBe(1);
  });

  it('writes supply onto divisions', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    declareWar(f.state, ger.id, pol.id);
    tickSupplyDaily(f.state, f.index);
    for (const d of liveDivisions(f.state)) {
      expect(d.supplyLevel).toBe(f.state.provinces[d.provinceId].supply);
    }
  });

  it('rewards better infrastructure with longer reach', () => {
    // The country-level map gives each nation a single province, so supply has
    // nowhere to propagate. Build a corridor by handing the Soviet Union a
    // chain of its neighbours, then measure how far supply carries down it.
    const measure = (infra: number) => {
      const f = makeFixture();
      const sov = f.country('SOV');
      for (const s of f.state.states) s.infrastructure = infra;

      let cur = sov.capital;
      const chain = [cur];
      for (let i = 0; i < 5; i++) {
        const next = f.index.get(cur).neighbors.find((n) => !chain.includes(n));
        if (next === undefined) break;
        f.state.provinces[next].controller = sov.id;
        chain.push(next);
        cur = next;
      }
      const levels = computeSupply(f.state, f.index, sov.id, supplySources(f.state, f.index, sov.id));
      return { total: levels.reduce((a, b) => a + b, 0), chain };
    };

    const poor = measure(1);
    const rich = measure(5);
    expect(poor.chain.length).toBeGreaterThan(2);
    expect(rich.total).toBeGreaterThan(poor.total);
  });

  it('decays with each province travelled', () => {
    const f = makeFixture();
    const sov = f.country('SOV');
    const neighbour = f.index.get(sov.capital).neighbors[0];
    f.state.provinces[neighbour].controller = sov.id;
    const levels = computeSupply(f.state, f.index, sov.id, supplySources(f.state, f.index, sov.id));
    expect(levels[sov.capital]).toBe(1);
    expect(levels[neighbour]).toBeGreaterThan(0);
    expect(levels[neighbour]).toBeLessThan(1);
  });
});

describe('encirclement', () => {
  it('finds no pocket in a country whose territory is contiguous', () => {
    const f = makeFixture();
    for (const tag of ['POL', 'CZE', 'SOV', 'HUN']) {
      const c = f.country(tag);
      const pocket = encircledProvinces(f.state, f.index, c.id);
      expect([...pocket].map((p) => f.index.get(p).name), tag).toEqual([]);
    }
  });

  it('keeps East Prussia supplied through its own port', () => {
    // The Polish Corridor severed East Prussia from Germany by land, but
    // Koenigsberg is a port, so it is a separate theatre rather than a pocket.
    const f = makeFixture();
    const ger = f.country('GER');
    expect(encircledProvinces(f.state, f.index, ger.id).size).toBe(0);
    const sources = supplySources(f.state, f.index, ger.id);
    expect(sources.length).toBeGreaterThan(1);
    expect(sources.some((s) => s.province === ger.capital)).toBe(true);
  });

  it('encircles a landlocked salient with no route home', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const sov = f.country('SOV');
    declareWar(f.state, ger.id, sov.id);

    // Find an inland province deep in Soviet territory and hand it to Germany,
    // then make sure it is surrounded.
    const target = f.index.provinces.find(
      (p) => p.ownerTag === 'SOV' && !p.coastal && p.neighbors.length >= 3
        && p.neighbors.every((n) => f.index.get(n).ownerTag === 'SOV'),
    )!;
    f.state.provinces[target.id].controller = ger.id;

    const pocket = encircledProvinces(f.state, f.index, ger.id);
    expect(pocket.has(target.id)).toBe(true);

    tickSupplyDaily(f.state, f.index);
    expect(f.state.provinces[target.id].supply).toBe(0);
  });

  it('supplies overseas theatres through a port rather than starving them', () => {
    const f = makeFixture();
    const eng = f.country('ENG');
    const fra = f.country('FRA');
    // Egypt and French North Africa are unreachable overland from London and
    // Paris, but both are coastal and owned, so convoys keep them supplied.
    for (const c of [eng, fra]) {
      const sources = supplySources(f.state, f.index, c.id);
      expect(sources.length, c.tag).toBeGreaterThan(1);
      expect(encircledProvinces(f.state, f.index, c.id).size, c.tag).toBe(0);
    }
  });

  it('detects a province cut off from the capital', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const sov = f.country('SOV');
    declareWar(f.state, ger.id, sov.id);

    // Give Germany a distant province, surrounded by Soviet territory.
    const island: ProvinceId = f.provinceOf('GRE');
    f.state.provinces[island].controller = ger.id;
    for (const nb of f.index.get(island).neighbors) {
      f.state.provinces[nb].controller = sov.id;
    }
    const pocket = encircledProvinces(f.state, f.index, ger.id);
    expect(pocket.has(island)).toBe(true);
    expect(pocket.has(ger.capital)).toBe(false);
  });

  it('starves the units inside a pocket', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const sov = f.country('SOV');
    declareWar(f.state, ger.id, sov.id);

    const island = f.provinceOf('GRE');
    f.state.provinces[island].controller = ger.id;
    for (const nb of f.index.get(island).neighbors) {
      f.state.provinces[nb].controller = sov.id;
    }
    const trapped = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, island, 1);
    const home = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, ger.capital, 1);

    tickSupplyDaily(f.state, f.index);
    expect(trapped.supplyLevel).toBe(0);
    expect(home.supplyLevel).toBeGreaterThan(0);

    const org0 = trapped.org;
    for (let i = 0; i < 240; i++) tickDivisionUpkeep(f.state, trapped);
    expect(trapped.org).toBeLessThan(org0);
  });
});

describe('reinforcement', () => {
  it('draws equipment from the stockpile to refill a division', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, ger.capital, 0.5);
    d.supplyLevel = 1;
    ger.economy.stockpile.infantry_equipment = 100000;

    const before = equipmentRatio(f.state, d);
    for (let i = 0; i < 60; i++) tickReinforcementDaily(f.state);
    expect(equipmentRatio(f.state, d)).toBeGreaterThan(before);
    expect(ger.economy.stockpile.infantry_equipment).toBeLessThan(100000);
  });

  it('cannot reinforce past the template requirement', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, ger.capital, 1);
    for (const k of Object.keys(ger.economy.stockpile) as (keyof typeof ger.economy.stockpile)[]) {
      ger.economy.stockpile[k] = 1e6;
    }
    for (let i = 0; i < 200; i++) tickReinforcementDaily(f.state);
    const tpl = ger.templates[TEMPLATE_INFANTRY];
    for (const [eq, need] of Object.entries(tpl.equipmentNeed) as [keyof typeof d.equipment, number][]) {
      expect(d.equipment[eq] ?? 0).toBeLessThanOrEqual(need + 1e-6);
    }
  });

  it('cannot reinforce from an empty stockpile', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, ger.capital, 0.3);
    for (const k of Object.keys(ger.economy.stockpile) as (keyof typeof ger.economy.stockpile)[]) {
      ger.economy.stockpile[k] = 0;
    }
    const before = equipmentRatio(f.state, d);
    for (let i = 0; i < 50; i++) tickReinforcementDaily(f.state);
    expect(equipmentRatio(f.state, d)).toBeCloseTo(before, 6);
  });
});

describe('territory control', () => {
  it('flips a state only when all of its provinces are taken', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const pol = f.country('POL');
    const province = f.provinceOf('POL');
    const stateId = f.index.get(province).stateId;
    expect(f.state.states[stateId].controller).toBe(pol.id);

    captureProvince(f.state, ctxOf(f), province, ger.id);
    const members = f.index.data.states[stateId].provinces;
    const allTaken = members.every((p) => f.state.provinces[p].controller === ger.id);
    expect(f.state.states[stateId].controller).toBe(allTaken ? ger.id : pol.id);
  });

  it('treats non-belligerents as free to pass', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const swi = f.country('SWI');
    expect(isHostile(f.state, ger.id, swi.id)).toBe(false);
    declareWar(f.state, ger.id, swi.id);
    expect(isHostile(f.state, ger.id, swi.id)).toBe(true);
  });

  it('keeps the province roster consistent when units move', () => {
    const f = makeFixture();
    clearArmies(f);
    const ger = f.country('GER');
    const a = f.provinceOf('GER');
    const b = f.index.get(a).neighbors[0];
    const d = spawnDivision(f.state, ger.id, TEMPLATE_INFANTRY, a, 1);
    expect(f.state.provinces[a].divisions).toContain(d.id);
    placeDivision(f.state, d, b);
    expect(f.state.provinces[a].divisions).not.toContain(d.id);
    expect(f.state.provinces[b].divisions).toContain(d.id);
  });
});

/**
 * Division designer.
 *
 * The command was a stub that accepted and discarded everything, so a player
 * could compose a division and get nothing. These fix the contract the panel
 * relies on: what it previews is what the simulation fights with.
 */
describe('division templates', () => {
  it('adds a designed template that the country can then recruit', () => {
    const f = makeFixture({ seed: 7, playerTag: 'GER' });
    const sim = new Simulation(f.state, f.index);
    const me = f.state.countries[f.state.meta.playerCountry];
    const before = me.templates.length;

    sim.execute({
      t: 'createTemplate', country: me.id, name: '試製師団',
      battalions: ['infantry', 'infantry', 'artillery'], supports: ['engineer'],
    });

    expect(me.templates).toHaveLength(before + 1);
    const tpl = me.templates[me.templates.length - 1];
    expect(tpl.name).toBe('試製師団');
    expect(tpl.battalions).toEqual(['infantry', 'infantry', 'artillery']);
    expect(tpl.softAttack).toBeGreaterThan(0);
    expect(tpl.equipmentNeed.infantry_equipment).toBeGreaterThan(0);
  });

  it('replaces a template of the same name rather than piling up duplicates', () => {
    const f = makeFixture({ seed: 7, playerTag: 'GER' });
    const sim = new Simulation(f.state, f.index);
    const me = f.state.countries[f.state.meta.playerCountry];
    const first = me.templates[0];

    sim.execute({
      t: 'createTemplate', country: me.id, name: first.name,
      battalions: ['medium_armor', 'medium_armor'], supports: [],
    });

    expect(me.templates.filter((t) => t.name === first.name)).toHaveLength(1);
    expect(me.templates[0].battalions).toEqual(['medium_armor', 'medium_armor']);
    // Same id, so divisions already in the field follow the edited template.
    expect(me.templates[0].id).toBe(first.id);
  });

  it('refuses an empty division and caps an absurd one', () => {
    const f = makeFixture({ seed: 7, playerTag: 'GER' });
    const sim = new Simulation(f.state, f.index);
    const me = f.state.countries[f.state.meta.playerCountry];
    const before = me.templates.length;

    sim.execute({ t: 'createTemplate', country: me.id, name: 'x', battalions: [], supports: [] });
    expect(me.templates).toHaveLength(before);

    sim.execute({
      t: 'createTemplate', country: me.id, name: '巨大',
      battalions: new Array(60).fill('infantry'),
      supports: ['engineer', 'engineer', 'recon'],
    });
    const huge = me.templates[me.templates.length - 1];
    expect(huge.battalions.length).toBeLessThanOrEqual(24);
    // Duplicate support companies collapse: they are a modifier, not a stack.
    expect(new Set(huge.supports).size).toBe(huge.supports.length);
  });
});
