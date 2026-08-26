import { describe, expect, it } from 'vitest';

import {
  MAX_VARIANT_LEVEL, VARIANT_LEVEL_XP, VARIANT_MODULES, XP_PER_FIGHTING_DIVISION,
  baseStats, canUpgrade, tickArmyExperienceDaily, upgradeVariant, variantCostMultiplier,
  variantMark, variantStats,
} from '../../src/sim/economy/variants';
import { effectiveTemplate } from '../../src/sim/research';
import { TEMPLATE_ARMOUR, TEMPLATE_INFANTRY } from '../../src/sim/scenario/europe1936';
import { makeFixture } from './helpers/fixture';

/**
 * Equipment marks.
 *
 * The thing worth testing is not that the numbers move -- it is that the
 * numbers the *fight* reads move. A design panel that changes a field nobody
 * consults is the failure mode this whole feature has to avoid.
 */

describe('equipment marks', () => {
  it('offers only the modules an equipment type actually has', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    // A rifle has no engine and no armour plate.
    expect(VARIANT_MODULES.infantry_equipment).not.toContain('engine');
    expect(canUpgrade(ger, 'infantry_equipment', 'engine', 1)).toBe(false);
    // A tank has all four.
    expect([...VARIANT_MODULES.medium_armor].sort())
      .toEqual(['armor', 'engine', 'gun', 'reliability']);
  });

  it('cannot be raised without experience, and experience is only won in combat', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    expect(ger.armyExperience ?? 0).toBe(0);
    expect(canUpgrade(ger, 'infantry_equipment', 'gun', 1)).toBe(false);
    expect(upgradeVariant(f.state, ger.id, 'infantry_equipment', 'gun', 1)).toBe(false);

    // A day of peace earns nothing, however large the army.
    tickArmyExperienceDaily(f.state);
    expect(ger.armyExperience ?? 0).toBe(0);

    // A day with divisions in combat does.
    const mine = f.state.divisions.filter((d) => !d.dead && d.owner === ger.id).slice(0, 4);
    expect(mine.length).toBe(4);
    for (const d of mine) d.combatId = 1;
    tickArmyExperienceDaily(f.state);
    expect(ger.armyExperience).toBeCloseTo(4 * XP_PER_FIGHTING_DIVISION, 6);
  });

  it('charges experience to go up and refunds nothing on the way back down', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.armyExperience = VARIANT_LEVEL_XP * 3;

    expect(upgradeVariant(f.state, ger.id, 'medium_armor', 'armor', 1)).toBe(true);
    expect(ger.armyExperience).toBe(VARIANT_LEVEL_XP * 2);
    expect(variantMark(ger, 'medium_armor')).toBe(1);

    expect(upgradeVariant(f.state, ger.id, 'medium_armor', 'armor', -1)).toBe(true);
    expect(variantMark(ger, 'medium_armor')).toBe(0);
    expect(ger.armyExperience).toBe(VARIANT_LEVEL_XP * 2);
  });

  it('stops at the ceiling', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.armyExperience = VARIANT_LEVEL_XP * 20;
    for (let i = 0; i < MAX_VARIANT_LEVEL; i++) {
      expect(upgradeVariant(f.state, ger.id, 'light_armor', 'gun', 1)).toBe(true);
    }
    expect(canUpgrade(ger, 'light_armor', 'gun', 1)).toBe(false);
    expect(upgradeVariant(f.state, ger.id, 'light_armor', 'gun', 1)).toBe(false);
  });

  it('changes the equipment the panel shows, and what it costs to build', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    ger.armyExperience = VARIANT_LEVEL_XP * 4;
    const before = variantStats(ger, 'medium_armor');
    expect(before).toEqual(baseStats('medium_armor'));

    upgradeVariant(f.state, ger.id, 'medium_armor', 'armor', 1);
    upgradeVariant(f.state, ger.id, 'medium_armor', 'gun', 1);
    const after = variantStats(ger, 'medium_armor');

    expect(after.armor).toBeGreaterThan(before.armor);
    expect(after.softAttack).toBeGreaterThan(before.softAttack);
    expect(after.piercing).toBeGreaterThan(before.piercing);
    // The trade the whole feature turns on: a better tank comes off the line
    // more slowly.
    expect(after.cost).toBeGreaterThan(before.cost);
    expect(variantCostMultiplier(ger, 'medium_armor')).toBeGreaterThan(1);
  });

  it('reaches the numbers combat actually reads', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const tpl = ger.templates[TEMPLATE_ARMOUR];
    const before = effectiveTemplate(f.state, ger.id, tpl);

    ger.armyExperience = VARIANT_LEVEL_XP * 6;
    upgradeVariant(f.state, ger.id, 'medium_armor', 'gun', 1);
    upgradeVariant(f.state, ger.id, 'medium_armor', 'armor', 1);
    const after = effectiveTemplate(f.state, ger.id, tpl);

    expect(after.hardAttack).toBeGreaterThan(before.hardAttack);
    expect(after.armor).toBeGreaterThan(before.armor);
  });

  it('does not serve a template cached before the factories retooled', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const tpl = ger.templates[TEMPLATE_ARMOUR];
    ger.armyExperience = VARIANT_LEVEL_XP * 6;

    // The first mark, and then a read, so the cache holds an entry. Without
    // this the first read returns early -- no technology, no marks -- and
    // never caches, which is why asserting on a cold cache does not test the
    // stamp at all. Checked by removing `marks` from the key: this is the
    // assertion that then fails, and the one above still passes.
    upgradeVariant(f.state, ger.id, 'medium_armor', 'gun', 1);
    const once = effectiveTemplate(f.state, ger.id, tpl);

    upgradeVariant(f.state, ger.id, 'medium_armor', 'gun', 1);
    const twice = effectiveTemplate(f.state, ger.id, tpl);
    expect(twice.hardAttack).toBeGreaterThan(once.hardAttack);
  });

  it('leaves the equipment a template does not carry alone', () => {
    const f = makeFixture();
    const ger = f.country('GER');
    const foot = ger.templates[TEMPLATE_INFANTRY];
    const before = effectiveTemplate(f.state, ger.id, foot);

    // The infantry division carries no tanks, so a tank mark must not touch it.
    ger.armyExperience = VARIANT_LEVEL_XP * 5;
    for (let i = 0; i < 5; i++) {
      upgradeVariant(f.state, ger.id, 'medium_armor', 'gun', 1);
    }
    const after = effectiveTemplate(f.state, ger.id, foot);
    expect(after.softAttack).toBeCloseTo(before.softAttack, 6);
    expect(after.hardAttack).toBeCloseTo(before.hardAttack, 6);
  });
});
