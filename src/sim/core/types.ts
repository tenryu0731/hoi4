import type { GameClock } from '../time/calendar';
import type { RngState } from './rng';

export type CountryId = number;
export type ProvinceId = number;
export type StateId = number;
export type SeaZoneId = number;
export type DivisionId = number;
export type CombatId = number;
export type FactionId = number;
export type WarId = number;

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
  /** Combat width consumed in a battle. */
  width: number;
  equipmentNeed: Partial<Record<EquipmentType, number>>;
  manpowerNeed: number;
  /** Total production cost, used by the AI to compare templates. */
  buildCost: number;
}

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
  supply: number;
  fortLevel: number;
  /** Divisions currently standing in the province (cache, rebuilt on change). */
  divisions: DivisionId[];
  /** Hours the current attacker has held the province, gates re-capture churn. */
  lastChangeHour: number;
}

export interface StateRuntime {
  owner: CountryId;
  controller: CountryId;
  civilianFactories: number;
  militaryFactories: number;
  dockyards: number;
  infrastructure: number;
  /** Remaining recruitable population, in thousands. */
  manpowerPool: number;
}

// ---------------------------------------------------------------------------
// Country
// ---------------------------------------------------------------------------

export interface ResearchState {
  slots: number;
  /** Simplified tech: a single research level per branch, raising modifiers. */
  levels: { infantry: number; armor: number; air: number; industry: number };
  progress: { infantry: number; armor: number; air: number; industry: number };
}

export interface Country {
  id: CountryId;
  tag: string;
  name: string;
  color: [number, number, number];
  capital: ProvinceId;
  ideology: Ideology;
  isAI: boolean;
  major: boolean;
  economy: Economy;
  productionLines: ProductionLine[];
  constructionQueue: ConstructionItem[];
  templates: DivisionTemplate[];
  research: ResearchState;
  diplomacy: DiplomaticState;
  factionId: FactionId | null;
  atWarWith: CountryId[];
  capitulated: boolean;
  /** Fraction of own victory points that may be lost before capitulating. */
  surrenderLimit: number;
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

export type Outcome =
  | { status: 'playing' }
  | { status: 'victory'; reason: string; day: number }
  | { status: 'defeat'; reason: string; day: number };

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
  factions: Faction[];
  wars: War[];
  worldTension: number;
  nextIds: { division: number; combat: number; line: number; construction: number; war: number };
  outcome: Outcome;
  /** Ring buffer of player-facing events, newest last. */
  log: GameEvent[];
}

export interface GameEvent {
  day: number;
  kind: 'war' | 'combat' | 'production' | 'construction' | 'diplomacy' | 'capitulation' | 'outcome';
  text: string;
  /** Optional province to focus the camera on when tapped. */
  province?: ProvinceId;
  country?: CountryId;
}
