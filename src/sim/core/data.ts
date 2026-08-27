import type {
  BattalionType, BuildingType, EquipmentDef, EquipmentType,
  SupportType, TerrainDef, TerrainType,
} from './types';

/**
 * Balance tables. Numbers are tuned so that a 1936 infantry division costs
 * roughly a month of one military factory, and so that two identical divisions
 * fighting on plains grind to a draw -- both properties are asserted in tests.
 */

export const EQUIPMENT: Record<EquipmentType, EquipmentDef> = {
  infantry_equipment: {
    id: 'infantry_equipment', name: 'Infantry Equipment', cost: 4,
    resources: { steel: 2 },
    softAttack: 3, hardAttack: 0.5, defense: 6, breakthrough: 2,
    armor: 0, piercing: 4, hardness: 0, maxSpeedKmh: 4, supplyUse: 0.07,
  },
  support_equipment: {
    id: 'support_equipment', name: 'Support Equipment', cost: 6,
    resources: { steel: 1, tungsten: 1 },
    softAttack: 1, hardAttack: 0.5, defense: 4, breakthrough: 2,
    armor: 0, piercing: 2, hardness: 0, maxSpeedKmh: 6, supplyUse: 0.05,
  },
  artillery: {
    id: 'artillery', name: 'Artillery', cost: 12,
    resources: { steel: 3, tungsten: 1 },
    softAttack: 25, hardAttack: 3, defense: 12, breakthrough: 6,
    armor: 0, piercing: 8, hardness: 0, maxSpeedKmh: 4, supplyUse: 0.2,
  },
  motorized: {
    id: 'motorized', name: 'Motorised Transport', cost: 10,
    resources: { steel: 2, rubber: 2 },
    softAttack: 4, hardAttack: 1, defense: 7, breakthrough: 6,
    armor: 0, piercing: 5, hardness: 0.2, maxSpeedKmh: 12, supplyUse: 0.15,
  },
  light_armor: {
    id: 'light_armor', name: 'Light Tank', cost: 30,
    resources: { steel: 4, tungsten: 2, rubber: 1 },
    softAttack: 12, hardAttack: 5, defense: 9, breakthrough: 24,
    armor: 12, piercing: 14, hardness: 0.8, maxSpeedKmh: 10, supplyUse: 0.4,
  },
  medium_armor: {
    id: 'medium_armor', name: 'Medium Tank', cost: 60,
    resources: { steel: 6, tungsten: 3, rubber: 2, chromium: 1 },
    softAttack: 24, hardAttack: 18, defense: 14, breakthrough: 40,
    armor: 30, piercing: 36, hardness: 0.9, maxSpeedKmh: 9, supplyUse: 0.6,
  },
  fighter: {
    id: 'fighter', name: 'Fighter', cost: 40,
    resources: { aluminium: 5, rubber: 1 },
    softAttack: 0, hardAttack: 0, defense: 0, breakthrough: 0,
    armor: 0, piercing: 0, hardness: 0, maxSpeedKmh: 0, supplyUse: 0,
  },
  cas: {
    id: 'cas', name: 'Close Air Support', cost: 44,
    resources: { aluminium: 6, rubber: 1 },
    softAttack: 0, hardAttack: 0, defense: 0, breakthrough: 0,
    armor: 0, piercing: 0, hardness: 0, maxSpeedKmh: 0, supplyUse: 0,
  },
  convoy: {
    id: 'convoy', name: 'Convoy', cost: 24,
    resources: { steel: 4 },
    softAttack: 0, hardAttack: 0, defense: 0, breakthrough: 0,
    armor: 0, piercing: 0, hardness: 0, maxSpeedKmh: 0, supplyUse: 0,
  },
};

export const TERRAIN: Record<TerrainType, TerrainDef> = {
  plains:   { id: 'plains',   name: 'Plains',    speed: 1.00, attackMod: 1.00, defenceMod: 1.00, combatWidth: 90 },
  forest:   { id: 'forest',   name: 'Forest',    speed: 0.75, attackMod: 0.85, defenceMod: 1.25, combatWidth: 60 },
  hills:    { id: 'hills',    name: 'Hills',     speed: 0.80, attackMod: 0.80, defenceMod: 1.30, combatWidth: 60 },
  mountain: { id: 'mountain', name: 'Mountains', speed: 0.50, attackMod: 0.60, defenceMod: 1.60, combatWidth: 50 },
  urban:    { id: 'urban',    name: 'Urban',     speed: 0.85, attackMod: 0.70, defenceMod: 1.45, combatWidth: 70 },
  marsh:    { id: 'marsh',    name: 'Marsh',     speed: 0.60, attackMod: 0.70, defenceMod: 1.20, combatWidth: 60 },
  desert:   { id: 'desert',   name: 'Desert',    speed: 0.95, attackMod: 0.95, defenceMod: 1.05, combatWidth: 80 },
};

export interface BattalionDef {
  id: BattalionType;
  name: string;
  /** Equipment required to bring one battalion to full strength. */
  equipment: Partial<Record<EquipmentType, number>>;
  manpower: number;
  org: number;
  hp: number;
  width: number;
  maxSpeedKmh: number;
}

/**
 * How big a division may be.
 *
 * Lived in Simulation.ts, with a second copy in the designer panel that had to
 * be kept in step by hand. They belong beside the battalion table they are
 * limits on.
 */
export const MAX_BATTALIONS = 24;
export const MAX_SUPPORTS = 4;

export const BATTALIONS: Record<BattalionType, BattalionDef> = {
  infantry: {
    id: 'infantry', name: 'Infantry', equipment: { infantry_equipment: 100 },
    manpower: 1000, org: 60, hp: 25, width: 2, maxSpeedKmh: 4,
  },
  motorized: {
    id: 'motorized', name: 'Motorised', equipment: { infantry_equipment: 100, motorized: 50 },
    manpower: 1000, org: 60, hp: 25, width: 2, maxSpeedKmh: 12,
  },
  artillery: {
    id: 'artillery', name: 'Artillery', equipment: { artillery: 36 },
    manpower: 500, org: 10, hp: 6, width: 3, maxSpeedKmh: 4,
  },
  light_armor: {
    id: 'light_armor', name: 'Light Armour', equipment: { light_armor: 50 },
    manpower: 500, org: 10, hp: 20, width: 2, maxSpeedKmh: 10,
  },
  medium_armor: {
    id: 'medium_armor', name: 'Medium Armour', equipment: { medium_armor: 50 },
    manpower: 500, org: 10, hp: 22, width: 2, maxSpeedKmh: 9,
  },
  mountaineers: {
    id: 'mountaineers', name: 'Mountaineers', equipment: { infantry_equipment: 100 },
    manpower: 1000, org: 60, hp: 25, width: 2, maxSpeedKmh: 4,
  },
};

export interface SupportDef {
  id: SupportType;
  name: string;
  equipment: Partial<Record<EquipmentType, number>>;
  manpower: number;
  org: number;
  hp: number;
  softAttack: number;
  defense: number;
  breakthrough: number;
}

export const SUPPORTS: Record<SupportType, SupportDef> = {
  engineer:          { id: 'engineer', name: 'Engineers', equipment: { support_equipment: 20 }, manpower: 300, org: 3, hp: 2, softAttack: 2, defense: 12, breakthrough: 6 },
  recon:             { id: 'recon', name: 'Recon', equipment: { support_equipment: 10, motorized: 10 }, manpower: 300, org: 3, hp: 2, softAttack: 2, defense: 3, breakthrough: 4 },
  artillery_support: { id: 'artillery_support', name: 'Artillery Support', equipment: { artillery: 12, support_equipment: 10 }, manpower: 500, org: 2, hp: 3, softAttack: 18, defense: 6, breakthrough: 4 },
  logistics:         { id: 'logistics', name: 'Logistics', equipment: { support_equipment: 20, motorized: 10 }, manpower: 300, org: 3, hp: 2, softAttack: 0, defense: 4, breakthrough: 0 },
};

export const BUILDING_COST: Record<BuildingType, number> = {
  civilian_factory: 10800,
  military_factory: 7200,
  dockyard: 6400,
  infrastructure: 3000,
  fort: 500,
};

/** Maximum level of each building type a single state may hold. */
export const BUILDING_CAP: Record<BuildingType, number> = {
  civilian_factory: 20,
  military_factory: 20,
  dockyard: 12,
  infrastructure: 5,
  fort: 10,
};

/**
 * Daily output of one factory, in cost units.
 *
 * Tuned against how fast an army should grow: at 5 a major power added roughly
 * one division a quarter, which is far short of the period. At 9, Germany goes
 * from 24 divisions in 1936 to a wartime army, and a civilian factory takes
 * about two months to build.
 */
export const FACTORY_OUTPUT = 9;

/** Base production efficiency a fresh line starts at, and its natural ceiling. */
export const BASE_EFFICIENCY = 0.10;
export const BASE_EFFICIENCY_CAP = 0.50;
/** Fractional approach toward the cap per day at full assignment. */
export const EFFICIENCY_GROWTH = 0.011;

/** How much of a line's resource need can go unmet before efficiency suffers. */
export const MAX_SHORTAGE_PENALTY = 0.5;
