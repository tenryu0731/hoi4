import type { GameClock } from '../time/calendar';
import type { ConscriptionLaw, EconomyLaw, TradeLaw } from '../politics/lawData';
import type { RngState } from './rng';

export type CountryId = number;
export type ProvinceId = number;
export type StateId = number;
export type SeaZoneId = number;
export type DivisionId = number;
export type CombatId = number;
export type FactionId = number;
export type WarId = number;
export type CommanderId = number;
export type ArmyId = number;

// ---------------------------------------------------------------------------
// Resources & equipment
// ---------------------------------------------------------------------------

export const RESOURCE_TYPES = [
  'oil', 'steel', 'aluminium', 'tungsten', 'rubber', 'chromium',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const EQUIPMENT_TYPES = [
  'infantry_equipment',
  'support_equipment',
  'artillery',
  'motorized',
  'light_armor',
  'medium_armor',
  'fighter',
  'cas',
  'convoy',
] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export interface EquipmentDef {
  id: EquipmentType;
  name: string;
  /** Production cost in "factory output units". */
  cost: number;
  /** Per-unit resource draw while a line is producing it. */
  resources: Partial<Record<ResourceType, number>>;
  softAttack: number;
  hardAttack: number;
  defense: number;
  breakthrough: number;
  armor: number;
  piercing: number;
  /** Contribution to a battalion's hardness (0..1). */
  hardness: number;
  maxSpeedKmh: number;
  /** Supply consumption contribution. */
  supplyUse: number;
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

export const TERRAIN_TYPES = [
  'plains', 'forest', 'hills', 'mountain', 'urban', 'marsh', 'desert',
] as const;
export type TerrainType = (typeof TERRAIN_TYPES)[number];

export interface TerrainDef {
  id: TerrainType;
  name: string;
  /** Movement speed multiplier. */
  speed: number;
  /** Attacker penalty applied multiplicatively (1 = none). */
  attackMod: number;
  /** Defender bonus multiplier. */
  defenceMod: number;
  /** How many divisions can engage at once. */
  combatWidth: number;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export const BUILDING_TYPES = [
  'civilian_factory', 'military_factory', 'dockyard', 'infrastructure', 'fort',
] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------

export interface ResourceFlow {
  produced: number;
  consumed: number;
  /** Positive = shortfall this tick. */
  deficit: number;
}

export interface Economy {
  civilianFactories: number;
  militaryFactories: number;
  dockyards: number;
  /** Fraction of civilian factories eaten by consumer goods (0..1). */
  consumerGoodsRatio: number;
  stockpile: Record<EquipmentType, number>;
  resources: Record<ResourceType, ResourceFlow>;
  manpower: number;
  politicalPower: number;
  /** Fuel in store; see sim/economy/fuel. */
  fuel: number;
  /**
   * How much of yesterday's fuel demand was met, 0..1.
   *
   * Cached here so movement and combat see the same figure within a tick
   * without either of them walking the division list again.
   */
  fuelRatio: number;
  /** Cached: civilian factories actually available for construction. */
  freeCivilianFactories: number;
}

export interface ProductionLine {
  id: number;
  equipment: EquipmentType;
  assignedFactories: number;
  efficiency: number;
  efficiencyCap: number;
  progress: number;
  priority: 0 | 1 | 2 | 3;
}

export interface ConstructionItem {
  id: number;
  kind: BuildingType;
  stateId: StateId;
  progress: number;
  cost: number;
}

// ---------------------------------------------------------------------------
// Military
// ---------------------------------------------------------------------------

export const BATTALION_TYPES = [
  'infantry', 'motorized', 'artillery', 'light_armor', 'medium_armor', 'mountaineers',
] as const;
export type BattalionType = (typeof BATTALION_TYPES)[number];

export const SUPPORT_TYPES = ['engineer', 'recon', 'artillery_support', 'logistics'] as const;
export type SupportType = (typeof SUPPORT_TYPES)[number];

export interface DivisionTemplate {
  id: number;
  name: string;
  battalions: BattalionType[];
  supports: SupportType[];
  // Derived stats, recomputed whenever the template changes.
  maxOrg: number;
  maxHp: number;
  softAttack: number;
  hardAttack: number;
  defense: number;
  breakthrough: number;
  armor: number;
  piercing: number;
  hardness: number;
  speedKmh: number;
  supplyUse: number;
  /** Daily fuel draw; zero for a formation that marches. */
  fuelUse: number;
  /** Combat width consumed in a battle. */
  width: number;
  equipmentNeed: Partial<Record<EquipmentType, number>>;
  manpowerNeed: number;
  /** Total production cost, used by the AI to compare templates. */
  buildCost: number;
}

/**
 * The four things a country can change about a piece of equipment.
 *
 * Not every type has all four: a rifle has no engine. See VARIANT_MODULES.
 */
export type VariantModule = 'armor' | 'gun' | 'reliability' | 'engine';

/** How many levels a country has put into each module of one equipment type. */
export type EquipmentVariant = Record<VariantModule, number>;

export type UnitOrder =
  | { kind: 'move'; target: ProvinceId }
  | { kind: 'attack'; target: ProvinceId }
  | { kind: 'defend' }
  | { kind: 'garrison'; target: ProvinceId };

export interface Division {
  id: DivisionId;
  owner: CountryId;
  templateId: number;
  provinceId: ProvinceId;
  /**
   * The army this division belongs to, or null while it is unassigned.
   *
   * A division outside an army still fights and still takes orders; it simply
   * has nobody commanding it, so it gets none of a general's bonuses and no
   * planning. That is the same deal the real game offers, and it is what makes
   * putting an army together worth doing rather than a chore.
   */
  armyId: ArmyId | null;
  org: number;
  hp: number;
  experience: number;
  equipment: Partial<Record<EquipmentType, number>>;
  supplyLevel: number;
  order: UnitOrder | null;
  path: ProvinceId[];
  /** 0..1 progress toward the next province in `path`. */
  moveProgress: number;
  combatId: CombatId | null;
  /**
   * Days spent dug in where it stands, in whole levels.
   *
   * Reset the moment the division enters a new province, so ground is only
   * prepared by holding it. This is what makes striking early cheaper than
   * striking late, and what a defensive general is for.
   */
  entrenchment: number;
  /**
   * This division's number within its template: the 12 in 第12歩兵師団.
   *
   * A formation needs a name before an order of battle can be read. Before
   * this, an army of twenty-four was twenty-four rows all reading 歩兵師団,
   * and the only way to tell one from another was the province it stood in --
   * which changes, and is not what a division is called.
   */
  ordinal: number;
  /** Set when the division has been destroyed; kept so ids stay stable. */
  dead: boolean;
  /** Hours the unit must spend recovering before it may attack again. */
  retreatCooldown: number;
}

export interface Combat {
  id: CombatId;
  province: ProvinceId;
  attackerCountry: CountryId;
  defenderCountry: CountryId;
  attackers: DivisionId[];
  defenders: DivisionId[];
  startHour: number;
  /** Accumulated progress toward the attacker winning, purely for the UI. */
  attackerProgress: number;
  ended: boolean;
}

// ---------------------------------------------------------------------------
// Chain of command
// ---------------------------------------------------------------------------

export type CommanderRank = 'general' | 'field_marshal';

/**
 * Declared as a list rather than a bare union so the set exists at runtime and
 * a test can walk it. Six of these once computed nothing at all while being
 * printed on the officer's card, and a union cannot be enumerated to catch
 * that.
 */
export const COMMANDER_TRAITS = [
  'organiser',
  'logistics_wizard',
  'defensive_doctrine',
  'fast_planner',
  'thorough_planner',
  'panzer_leader',
  'infantry_leader',
  'trickster',
  'winter_specialist',
  'naval_invader',
] as const;
export type CommanderTrait = (typeof COMMANDER_TRAITS)[number];

/**
 * A general or a field marshal.
 *
 * Skill is the overall rating and drives how fast the officer learns; the four
 * attributes are what the divisions under him actually feel. The real game's
 * rates, which this follows: attack and defence are +5% each per level,
 * logistics is -2.5% supply use per level, and planning is +5% planning speed
 * and +2% to the ceiling the planning bonus may reach.
 */
export interface Commander {
  id: CommanderId;
  owner: CountryId;
  /** Stable definition id from commanderData, for saves and for tests. */
  defId: string;
  name: string;
  latin: string;
  rank: CommanderRank;
  /** 1..9. */
  skill: number;
  /** 1..6 each. */
  attack: number;
  defence: number;
  planning: number;
  logistics: number;
  traits: CommanderTrait[];
  /**
   * Progress toward the next skill level. Earned by commanding divisions that
   * are in combat, so an officer parked behind the lines never improves.
   */
  experience: number;
  /** The army he leads, or the army group if he is a field marshal. */
  assignment: ArmyId | null;
}

export type ArmyOrder =
  /**
   * Hold the border with a particular enemy. The divisions spread themselves
   * along whichever provinces of ours actually touch theirs, and re-spread as
   * that border moves, which is the whole point: a front is a standing
   * instruction, not a list of destinations.
   */
  | { kind: 'front'; against: CountryId }
  /** Push through the front toward these provinces, using the plan bonus. */
  | { kind: 'offensive'; targets: ProvinceId[] }
  /** Sit on these provinces and keep them. */
  | { kind: 'garrison'; provinces: ProvinceId[] };

/**
 * An army, or -- when its commander is a field marshal -- an army group.
 *
 * An army group holds no divisions of its own. It holds armies, and its field
 * marshal passes half of his attributes down to every general beneath him,
 * which is what makes a good field marshal worth more than a good general.
 */
export interface Army {
  id: ArmyId;
  owner: CountryId;
  name: string;
  commander: CommanderId | null;
  divisions: DivisionId[];
  /** Set when this army sits under an army group. */
  parent: ArmyId | null;
  /** Armies under this one; only ever populated for an army group. */
  children: ArmyId[];
  isArmyGroup: boolean;
  order: ArmyOrder | null;
  /**
   * Accumulated preparation, 0..1 of the ceiling. Grows while the army holds
   * still under an order and drains once it starts moving, so a planned
   * offensive beats an improvised one.
   */
  planning: number;
  /** Provinces the current order has assigned, recomputed as the front moves. */
  frontProvinces: ProvinceId[];
}

// ---------------------------------------------------------------------------
// Diplomacy
// ---------------------------------------------------------------------------

export type Ideology = 'fascist' | 'democratic' | 'communist' | 'neutral';

export interface Faction {
  id: FactionId;
  name: string;
  leader: CountryId;
  members: CountryId[];
}

export interface War {
  id: WarId;
  attackers: CountryId[];
  defenders: CountryId[];
  startDay: number;
  ended: boolean;
}

export interface Justification {
  target: CountryId;
  progress: number;
  required: number;
}

export interface DiplomaticState {
  /** Index-aligned with countries; -100..100. */
  opinion: number[];
  guarantees: CountryId[];
  justifications: Justification[];
}

// ---------------------------------------------------------------------------
// Provinces / states runtime
// ---------------------------------------------------------------------------

export interface ProvinceState {
  owner: CountryId;
  controller: CountryId;
  /** Victory points the province is worth; cached from the map so that stats
   *  can be recomputed without reaching back into ProvinceIndex. */
  vp: number;
  supply: number;
  fortLevel: number;
  /** Divisions currently standing in the province (cache, rebuilt on change). */
  divisions: DivisionId[];
  /** Hours the current attacker has held the province, gates re-capture churn. */
  lastChangeHour: number;
  /**
   * Part of the original owner's metropolitan territory rather than an
   * overseas possession. Fixed at scenario creation and never reassigned:
   * conquering Alsace does not make it German heartland.
   *
   * Surrender is measured over core territory only. Britain's victory points
   * include Egypt and Iraq and France's include Algeria and Syria, so counting
   * everything meant the whole metropole could fall without either reaching
   * its surrender threshold -- they were unconquerable by construction.
   */
  core: boolean;
}

export interface StateRuntime {
  owner: CountryId;
  controller: CountryId;
  /**
   * The provinces this state is made of, in id order.
   *
   * Fixed at scenario creation -- a province never changes which state it
   * belongs to, only who holds it -- and cached here so the economy can reach
   * from a state to its ground without every function that needs to do so
   * having to carry a ProvinceIndex.
   */
  provinces: readonly ProvinceId[];
  civilianFactories: number;
  militaryFactories: number;
  dockyards: number;
  infrastructure: number;
  /**
   * How much of this state is fighting its occupier, 0..1.
   *
   * Zero on home ground by definition; see sim/economy/occupation.
   */
  resistance: number;
  /** Remaining recruitable population, in thousands. */
  manpowerPool: number;
  /** Shared civilian + military factory slots. */
  buildingSlots: number;
}

// ---------------------------------------------------------------------------
// Country
// ---------------------------------------------------------------------------

/** Identifier of a technology in the trees; see sim/research/techData.ts. */
export type TechId = string;

/** One research slot: what it is working on, and how far along it is. */
export interface ResearchSlot {
  /** Technology being researched, or null when the slot is idle. */
  tech: TechId | null;
  /** Research days accumulated toward `required`. */
  progress: number;
  /**
   * Days this technology needs, fixed at the moment research started so the
   * ahead-of-time penalty is locked in rather than shrinking as time passes.
   */
  required: number;
}

export interface ResearchState {
  /** Base slots. Technologies may grant more; see effectiveSlotCount(). */
  slots: number;
  /**
   * Per-slot state. Optional only because the 1936 scenario table predates it:
   * the research runtime creates it on first use.
   */
  active?: ResearchSlot[];
  /** Technologies finished, in completion order. */
  completed?: TechId[];
}

/**
 * National focus progress; see sim/focus.
 *
 * Optional only because the 1936 scenario table predates the focus system --
 * the focus runtime creates it on first use, exactly as the research runtime
 * does with its slots.
 */
export interface CountryFocus {
  /** Focus being worked on, or null when the cabinet is idle. */
  current: string | null;
  /** Days already spent on `current`. Lost if it is cancelled. */
  progress: number;
  /** Focus ids finished, in completion order. */
  completed: string[];
  /** Standing modifiers granted by completed focuses, paid out daily. */
  bonuses: {
    /** Extra research days per day, by branch. */
    research: { infantry: number; armor: number; air: number; industry: number };
    /** Extra construction output, in factory-equivalents. */
    construction: number;
    /** Ceiling held on the consumer-goods share; 1 means no ceiling. */
    consumerGoodsCap: number;
    /** Extra political power per day. */
    politicalPower: number;
  };
}

export interface Country {
  id: CountryId;
  tag: string;
  name: string;
  color: [number, number, number];
  capital: ProvinceId;
  ideology: Ideology;
  /**
   * How firmly the government is in the saddle, 0..1.
   *
   * Spent by conscription laws and by being at war; buys political power and
   * keeps industry off consumer goods.
   */
  stability: number;
  /**
   * How far the nation will follow the government into a war, 0..1.
   *
   * Gates the conscription ladder and sets how much of itself the country
   * will lose before it capitulates.
   */
  warSupport: number;
  /** The ladders every campaign is built around; see sim/politics. */
  laws: {
    conscription: ConscriptionLaw;
    economy: EconomyLaw;
    /**
     * How much of what the country digs up reaches the world market.
     *
     * Optional because the 1936 scenario table predates the market; the
     * politics runtime fills it on first use, the way research and focus do.
     */
    trade?: TradeLaw;
  };
  isAI: boolean;
  major: boolean;
  economy: Economy;
  productionLines: ProductionLine[];
  constructionQueue: ConstructionItem[];
  templates: DivisionTemplate[];
  /**
   * How many divisions this country has ever raised on each template, so the
   * next one can be numbered.
   *
   * Optional because the 1936 scenario table predates it; spawnDivision fills
   * it on first use, the way research and focus fill theirs. Never decremented
   * -- the 12th infantry division stays the 12th after the 4th is destroyed,
   * which is what a formation number is for.
   */
  divisionOrdinals?: Partial<Record<number, number>>;
  /**
   * The mark each equipment type is currently built to; see sim/economy/variants.
   *
   * Optional because the 1936 scenario table predates it, and absent means
   * every type is at its base mark.
   */
  variants?: Partial<Record<EquipmentType, EquipmentVariant>>;
  /**
   * Lessons paid for in blood, spent on equipment marks.
   *
   * Earned only by divisions in combat, so a country at peace has none. That
   * is the pressure that makes the opening years about industry.
   */
  armyExperience?: number;
  research: ResearchState;
  /** National focus state. Created on first use by sim/focus. */
  focus?: CountryFocus;
  diplomacy: DiplomaticState;
  factionId: FactionId | null;
  atWarWith: CountryId[];
  capitulated: boolean;
  /** Fraction of own victory points that may be lost before capitulating. */
  surrenderLimit: number;
  /**
   * Seeded temperament, around 1.0. Scales how eagerly this country picks
   * fights and how large an army it wants first, so two runs of the same
   * scenario with different seeds produce different histories rather than the
   * same script with different dice.
   */
  aggression: number;
  /** Cached each month for UI + AI. */
  stats: {
    victoryPoints: number;
    victoryPointsHeld: number;
    divisionCount: number;
    militaryStrength: number;
  };
}

// ---------------------------------------------------------------------------
// Root state
// ---------------------------------------------------------------------------

/** Why the campaign ended. A code, not prose: the UI writes the sentence. */
export type OutcomeReason =
  | 'capitulated'
  | 'allEnemiesCapitulated'
  | 'aheadOnPoints'
  | 'behindOnPoints';

export type Outcome =
  | { status: 'playing' }
  | { status: 'victory'; reason: OutcomeReason; day: number }
  | { status: 'defeat'; reason: OutcomeReason; day: number };

/**
 * One standing purchase on the world market.
 *
 * The buyer commits civilian factories; each one buys a fixed daily quantity
 * of the resource and moves to the seller's civilian pool for as long as the
 * deal stands. That is the whole trade-off: industry now against materials
 * now, which is the decision Germany could not make and the reason its oil
 * never came right.
 */
export interface TradeDeal {
  id: number;
  buyer: CountryId;
  seller: CountryId;
  resource: ResourceType;
  factories: number;
}

export interface GameState {
  meta: {
    version: number;
    scenario: string;
    seed: number;
    playerCountry: CountryId;
  };
  clock: GameClock;
  rng: RngState;
  countries: Country[];
  provinces: ProvinceState[];
  states: StateRuntime[];
  divisions: Division[];
  combats: Combat[];
  /**
   * Every officer in the world, alive or retired, indexed by id.
   *
   * Optional because the 1936 scenario table predates the chain of command;
   * the command runtime fills it on first use, the way research and focus do.
   */
  commanders?: Commander[];
  /** Armies and army groups, indexed by id. Optional for the same reason. */
  armies?: Army[];
  factions: Faction[];
  wars: War[];
  /**
   * Standing purchases on the world market; see sim/economy/trade.
   *
   * Optional for the same reason the commander and army arrays are: the
   * scenario table predates it.
   */
  trades?: TradeDeal[];
  worldTension: number;
  nextIds: {
    division: number; combat: number; line: number; construction: number;
    war: number; template: number;
    /** Optional for the same reason the arrays above are. */
    commander?: number; army?: number; trade?: number;
  };
  outcome: Outcome;
  /** Ring buffer of player-facing events, newest last. */
  log: GameEvent[];
}

/**
 * What happened, as data rather than as a sentence.
 *
 * The simulation must not know what language the player reads, so it records
 * the facts and the UI writes the prose. Country references are tags because
 * those are stable across the whole program; province references are ids so the
 * UI can look up whatever name it wants to show.
 */
export type GameEventBody =
  | { k: 'warDeclared'; attacker: string; defender: string }
  | { k: 'joinedFaction'; country: string; faction: string }
  | { k: 'capitulated'; country: string; occupation: number }
  | { k: 'annexed'; country: string; by: string }
  | { k: 'ceded'; country: string; by: string; states: number }
  | { k: 'itemCompleted'; country: string; item: string }
  | { k: 'divisionLost'; country: string }
  | { k: 'attack'; attacker: string; defender: string; province: ProvinceId }
  | { k: 'outcome'; status: Outcome['status']; reason: OutcomeReason };

export interface GameEvent {
  day: number;
  kind: 'war' | 'combat' | 'production' | 'construction' | 'research' | 'focus' | 'diplomacy' | 'capitulation' | 'outcome';
  body: GameEventBody;
  /** Optional province to focus the camera on when tapped. */
  province?: ProvinceId;
  country?: CountryId;
}
