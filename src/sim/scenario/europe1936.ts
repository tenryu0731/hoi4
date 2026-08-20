import { hoursFromDate, clockFromHours } from '../time/calendar';
import { createRng, randRange } from '../core/rng';
import { BATTALIONS, EQUIPMENT, SUPPORTS, BASE_EFFICIENCY, BASE_EFFICIENCY_CAP } from '../core/data';
import {
  EQUIPMENT_TYPES, RESOURCE_TYPES,
  type BattalionType, type Country, type CountryId, type Division,
  type DivisionTemplate, type EquipmentType, type Economy, type GameState,
  type ProvinceState, type ResourceType, type StateRuntime, type SupportType,
} from '../core/types';
import type { ProvinceIndex } from '../map/ProvinceIndex';
import { NATIONS, NATION_BY_TAG, type NationDef } from './nations';

/**
 * Builds the opening position of the Europe 1936 scenario from the baked map
 * plus the nation table. Everything here is deterministic: the same map and the
 * same seed always produce byte-identical state.
 */

export interface ScenarioOptions {
  seed?: number;
  /** Tag of the country the human plays. */
  playerTag?: string;
}

export const FACTION_AXIS = 0;
export const FACTION_ALLIES = 1;
export const FACTION_COMINTERN = 2;

/** Divisions the AI keeps per faction leader before it starts a war. */
export const SCENARIO_END = { year: 1948, month: 1, day: 1 };

// ---------------------------------------------------------------------------
// Division templates
// ---------------------------------------------------------------------------

export function deriveTemplate(
  id: number,
  name: string,
  battalions: BattalionType[],
  supports: SupportType[],
): DivisionTemplate {
  let maxOrg = 0;
  let maxHp = 0;
  let softAttack = 0;
  let hardAttack = 0;
  let defense = 0;
  let breakthrough = 0;
  let armor = 0;
  let piercing = 0;
  let hardnessNum = 0;
  let hardnessDen = 0;
  let speed = Infinity;
  let supplyUse = 0;
  let width = 0;
  let manpowerNeed = 0;
  let buildCost = 0;
  const equipmentNeed: Partial<Record<EquipmentType, number>> = {};

  const addEquipment = (eq: EquipmentType, count: number) => {
    equipmentNeed[eq] = (equipmentNeed[eq] ?? 0) + count;
    const def = EQUIPMENT[eq];
    softAttack += def.softAttack * count * 0.01;
    hardAttack += def.hardAttack * count * 0.01;
    defense += def.defense * count * 0.01;
    breakthrough += def.breakthrough * count * 0.01;
    armor = Math.max(armor, def.armor);
    piercing = Math.max(piercing, def.piercing);
    hardnessNum += def.hardness * count;
    hardnessDen += count;
    supplyUse += def.supplyUse * count * 0.01;
    buildCost += def.cost * count;
  };

  for (const b of battalions) {
    const def = BATTALIONS[b];
    maxOrg += def.org;
    maxHp += def.hp;
    width += def.width;
    manpowerNeed += def.manpower;
    speed = Math.min(speed, def.maxSpeedKmh);
    for (const [eq, count] of Object.entries(def.equipment) as [EquipmentType, number][]) {
      addEquipment(eq, count);
    }
  }
  for (const s of supports) {
    const def = SUPPORTS[s];
    maxOrg += def.org;
    maxHp += def.hp;
    manpowerNeed += def.manpower;
    softAttack += def.softAttack;
    defense += def.defense;
    breakthrough += def.breakthrough;
    for (const [eq, count] of Object.entries(def.equipment) as [EquipmentType, number][]) {
      addEquipment(eq, count);
    }
  }

  // Organisation is the average across battalions, not the sum: a division does
  // not become more resilient simply by stapling more units together.
  const unitCount = Math.max(1, battalions.length + supports.length);
  maxOrg = maxOrg / unitCount;

  return {
    id, name, battalions, supports,
    maxOrg: Math.round(maxOrg * 10) / 10,
    maxHp: Math.round(maxHp * 10) / 10,
    softAttack: Math.round(softAttack * 10) / 10,
    hardAttack: Math.round(hardAttack * 10) / 10,
    defense: Math.round(defense * 10) / 10,
    breakthrough: Math.round(breakthrough * 10) / 10,
    armor, piercing,
    hardness: hardnessDen > 0 ? Math.round((hardnessNum / hardnessDen) * 100) / 100 : 0,
    speedKmh: speed === Infinity ? 4 : speed,
    supplyUse: Math.round(supplyUse * 100) / 100,
    width,
    equipmentNeed,
    manpowerNeed,
    buildCost: Math.round(buildCost),
  };
}

export const TEMPLATE_INFANTRY = 0;
export const TEMPLATE_MOTORISED = 1;
export const TEMPLATE_ARMOUR = 2;
export const TEMPLATE_MOUNTAIN = 3;

function defaultTemplates(): DivisionTemplate[] {
  return [
    deriveTemplate(TEMPLATE_INFANTRY, '歩兵師団',
      ['infantry', 'infantry', 'infantry', 'infantry', 'infantry', 'infantry', 'artillery'],
      ['engineer', 'recon']),
    deriveTemplate(TEMPLATE_MOTORISED, '自動車化師団',
      ['motorized', 'motorized', 'motorized', 'motorized', 'motorized', 'motorized', 'artillery'],
      ['engineer', 'recon', 'logistics']),
    deriveTemplate(TEMPLATE_ARMOUR, '機甲師団',
      ['medium_armor', 'medium_armor', 'medium_armor', 'motorized', 'motorized', 'motorized'],
      ['engineer', 'recon', 'logistics']),
    deriveTemplate(TEMPLATE_MOUNTAIN, '山岳師団',
      ['mountaineers', 'mountaineers', 'mountaineers', 'mountaineers', 'mountaineers', 'artillery'],
      ['engineer', 'recon']),
  ];
}

// ---------------------------------------------------------------------------
// Scenario construction
// ---------------------------------------------------------------------------

function emptyEconomy(n: NationDef): Economy {
  const stockpile = {} as Record<EquipmentType, number>;
  for (const e of EQUIPMENT_TYPES) stockpile[e] = 0;
  const resources = {} as Economy['resources'];
  for (const r of RESOURCE_TYPES) resources[r] = { produced: 0, consumed: 0, deficit: 0 };

  return {
    civilianFactories: n.civilianFactories,
    militaryFactories: n.militaryFactories,
    dockyards: n.dockyards,
    // A peacetime economy sinks most of its civilian industry into consumer
    // goods; war economy laws claw that back later.
    consumerGoodsRatio: n.major ? 0.3 : 0.35,
    stockpile,
    resources,
    manpower: Math.round(n.population * 1000 * 1.5),
    politicalPower: 25,
    freeCivilianFactories: 0,
  };
}

export function createScenario(index: ProvinceIndex, opts: ScenarioOptions = {}): GameState {
  const seed = opts.seed ?? 20250101;
  const playerTag = opts.playerTag ?? 'GER';

  // Temperaments are drawn before anything else so they depend only on the
  // seed, not on how many countries the map happens to contain.
  const temperamentRng = createRng(seed ^ 0x5bf03635);

  const tags = [...new Set(index.provinces.map((p) => p.ownerTag))];
  // Order countries by the nation table so ids are stable across map rebuilds.
  const orderedTags = NATIONS.map((n) => n.tag).filter((t) => tags.includes(t));
  const idOf = new Map<string, CountryId>(orderedTags.map((t, i) => [t, i]));

  const countries: Country[] = orderedTags.map((tag, id) => {
    const n = NATION_BY_TAG.get(tag)!;
    const capitalCity = index.data.cities.find((c) => c.capitalOf === tag);
    const capital = capitalCity ? capitalCity.province : index.provinces.findIndex((p) => p.ownerTag === tag);
    return {
      id, tag, name: n.name, color: n.color,
      capital,
      ideology: n.ideology,
      isAI: tag !== playerTag,
      major: n.major,
      economy: emptyEconomy(n),
      productionLines: [],
      constructionQueue: [],
      templates: defaultTemplates(),
      research: {
        slots: n.major ? 3 : 2,
        levels: { infantry: 0, armor: 0, air: 0, industry: 0 },
        progress: { infantry: 0, armor: 0, air: 0, industry: 0 },
      },
      diplomacy: {
        opinion: new Array(orderedTags.length).fill(0),
        guarantees: [],
        justifications: [],
      },
      factionId: null,
      atWarWith: [],
      capitulated: false,
      surrenderLimit: n.major ? 0.75 : 0.6,
      aggression: randRange(temperamentRng, 0.78, 1.28),
      stats: { victoryPoints: 0, victoryPointsHeld: 0, divisionCount: 0, militaryStrength: 0 },
    };
  });

  const provinces: ProvinceState[] = index.provinces.map((p) => {
    const owner = idOf.get(p.ownerTag)!;
    return {
      owner, controller: owner,
      vp: p.vp,
      supply: 1,
      fortLevel: 0,
      divisions: [],
      lastChangeHour: 0,
    };
  });

  const states: StateRuntime[] = index.data.states.map((s) => {
    const owner = idOf.get(s.ownerTag)!;
    return {
      owner, controller: owner,
      civilianFactories: s.civilianFactories,
      militaryFactories: s.militaryFactories,
      dockyards: s.dockyards,
      infrastructure: s.infrastructure,
      manpowerPool: s.manpower,
      buildingSlots: s.buildingSlots,
    };
  });

  const startHours = hoursFromDate(1936, 1, 1);
  const state: GameState = {
    meta: { version: 1, scenario: 'europe1936', seed, playerCountry: idOf.get(playerTag) ?? 0 },
    clock: clockFromHours(startHours),
    rng: createRng(seed),
    countries,
    provinces,
    states,
    divisions: [],
    combats: [],
    factions: [
      { id: FACTION_AXIS, name: 'Axis', leader: idOf.get('GER') ?? 0, members: [] },
      { id: FACTION_ALLIES, name: 'Allies', leader: idOf.get('ENG') ?? 0, members: [] },
      { id: FACTION_COMINTERN, name: 'Comintern', leader: idOf.get('SOV') ?? 0, members: [] },
    ],
    wars: [],
    worldTension: 0,
    // Templates start past the four the scenario deals so a player-designed
    // division can never collide with one every country already has.
    nextIds: { division: 0, combat: 0, line: 0, construction: 0, war: 0, template: 100 },
    outcome: { status: 'playing' },
    log: [],
  };

  // --- factions ------------------------------------------------------------
  joinFactionAtStart(state, idOf, 'GER', FACTION_AXIS);
  joinFactionAtStart(state, idOf, 'ITA', FACTION_AXIS);
  joinFactionAtStart(state, idOf, 'ENG', FACTION_ALLIES);
  joinFactionAtStart(state, idOf, 'FRA', FACTION_ALLIES);
  joinFactionAtStart(state, idOf, 'SOV', FACTION_COMINTERN);

  // --- opening opinions ----------------------------------------------------
  for (const c of countries) {
    for (const other of countries) {
      if (c.id === other.id) continue;
      let op = 0;
      if (c.ideology === other.ideology) op += 25;
      if (c.factionId !== null && c.factionId === other.factionId) op += 50;
      if (c.ideology === 'fascist' && other.ideology === 'communist') op -= 40;
      if (c.ideology === 'communist' && other.ideology === 'fascist') op -= 40;
      if (c.ideology === 'democratic' && other.ideology === 'fascist') op -= 20;
      c.diplomacy.opinion[other.id] = op;
    }
  }

  // --- starting armies -----------------------------------------------------
  for (const c of countries) {
    const n = NATION_BY_TAG.get(c.tag)!;
    const home = index.provinces.filter((p) => provinces[p.id].owner === c.id);
    if (home.length === 0) continue;
    for (let i = 0; i < n.startingDivisions; i++) {
      // Spread the starting army over the nation's provinces, capital first.
      const province = i === 0 ? c.capital : home[i % home.length].id;
      const templateId = pickStartingTemplate(n, i);
      spawnDivision(state, c.id, templateId, province, 1);
    }
  }

  // --- starting production -------------------------------------------------
  for (const c of countries) {
    const mil = c.economy.militaryFactories;
    if (mil <= 0) continue;
    // Every default template carries a recon company, and recon needs
    // motorised transport, so a country without a motorised line can never
    // raise a single division however many rifles it stockpiles.
    const rifles = Math.max(1, Math.round(mil * 0.5));
    const support = Math.max(1, Math.round(mil * 0.15));
    const guns = Math.max(1, Math.round(mil * 0.2));
    const split: [EquipmentType, number][] = [
      ['infantry_equipment', rifles],
      ['support_equipment', support],
      ['artillery', guns],
      ['motorized', Math.max(1, mil - rifles - support - guns)],
    ];
    for (const [eq, factories] of split) {
      if (factories <= 0) continue;
      c.productionLines.push({
        id: state.nextIds.line++,
        equipment: eq,
        assignedFactories: factories,
        efficiency: BASE_EFFICIENCY + 0.2,
        efficiencyCap: BASE_EFFICIENCY_CAP,
        progress: 0,
        priority: 1,
      });
    }
    // A small opening stockpile so early divisions are not empty shells.
    c.economy.stockpile.infantry_equipment = n_equipmentStock(c);
    c.economy.stockpile.support_equipment = Math.round(n_equipmentStock(c) * 0.1);
    c.economy.stockpile.artillery = Math.round(n_equipmentStock(c) * 0.08);
  }

  recomputeCountryStats(state);
  return state;
}

function n_equipmentStock(c: Country): number {
  return Math.round(c.economy.militaryFactories * 300 + 500);
}

function pickStartingTemplate(n: NationDef, i: number): number {
  if (n.terrain === 'mountain' && i % 4 === 3) return TEMPLATE_MOUNTAIN;
  if (n.major && i % 8 === 7) return TEMPLATE_ARMOUR;
  if (n.major && i % 8 === 5) return TEMPLATE_MOTORISED;
  return TEMPLATE_INFANTRY;
}

function joinFactionAtStart(
  state: GameState, idOf: Map<string, CountryId>, tag: string, faction: number,
): void {
  const id = idOf.get(tag);
  if (id === undefined) return;
  state.countries[id].factionId = faction;
  state.factions[faction].members.push(id);
}

// ---------------------------------------------------------------------------
// Division helpers shared with the military subsystem
// ---------------------------------------------------------------------------

export function spawnDivision(
  state: GameState,
  owner: CountryId,
  templateId: number,
  provinceId: number,
  equipmentRatio = 1,
): Division {
  const tpl = state.countries[owner].templates.find((t) => t.id === templateId)!;
  const equipment: Partial<Record<EquipmentType, number>> = {};
  for (const [eq, need] of Object.entries(tpl.equipmentNeed) as [EquipmentType, number][]) {
    equipment[eq] = Math.round(need * equipmentRatio);
  }
  const div: Division = {
    id: state.nextIds.division++,
    owner,
    templateId,
    provinceId,
    org: tpl.maxOrg,
    hp: tpl.maxHp * equipmentRatio,
    experience: 0,
    equipment,
    supplyLevel: 1,
    order: null,
    path: [],
    moveProgress: 0,
    combatId: null,
    dead: false,
    retreatCooldown: 0,
  };
  state.divisions.push(div);
  state.provinces[provinceId].divisions.push(div.id);
  return div;
}

export function recomputeCountryStats(state: GameState): void {
  for (const c of state.countries) {
    c.stats.victoryPoints = 0;
    c.stats.victoryPointsHeld = 0;
    c.stats.divisionCount = 0;
    c.stats.militaryStrength = 0;
  }
  for (const p of state.provinces) {
    state.countries[p.owner].stats.victoryPoints += p.vp;
    state.countries[p.controller].stats.victoryPointsHeld += p.vp;
  }
  for (const d of state.divisions) {
    if (d.dead) continue;
    const c = state.countries[d.owner];
    c.stats.divisionCount++;
    const tpl = c.templates.find((t) => t.id === d.templateId);
    if (tpl) c.stats.militaryStrength += (d.hp / Math.max(1, tpl.maxHp)) * (tpl.softAttack + tpl.defense);
  }
}

/** Total resource output a country currently controls. */
export function controlledResources(
  state: GameState,
  index: ProvinceIndex,
  country: CountryId,
): Record<ResourceType, number> {
  const out = {} as Record<ResourceType, number>;
  for (const r of RESOURCE_TYPES) out[r] = 0;
  index.data.states.forEach((s, i) => {
    if (state.states[i].controller !== country) return;
    for (const [r, v] of Object.entries(s.resources) as [ResourceType, number][]) {
      out[r] += v;
    }
  });
  return out;
}
