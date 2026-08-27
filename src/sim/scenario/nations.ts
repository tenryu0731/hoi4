import type { Ideology, ResourceType, TerrainType } from '../core/types';

/**
 * The 1936 political map of Europe, expressed as aggregations of present-day
 * Natural Earth admin-0 units.
 *
 * Natural Earth ships modern borders, so several 1936 states have to be
 * reassembled (Czechoslovakia, Yugoslavia, the Soviet Union) and a few modern
 * states have to be handed to their 1936 owner (Bessarabia to Romania, Libya to
 * Italy, the Maghreb to France). Where a 1936 border cut through what is now a
 * single admin-0 unit -- East Prussia is the notable case -- the country-level
 * map cannot express it; those are corrected at province granularity.
 */

export interface NationDef {
  tag: string;
  name: string;
  /** Natural Earth ADM0_A3 codes that make up this nation in 1936. */
  members: string[];
  /** Political map colour. */
  color: [number, number, number];
  /** Capital city name as it appears in ne_50m_populated_places. */
  capital: string;
  /** Fallback capital position if the city lookup misses. */
  capitalLonLat: [number, number];
  terrain: TerrainType;
  /** Population in millions, circa 1936, used to derive the manpower pool. */
  population: number;
  /** Starting building levels. */
  civilianFactories: number;
  militaryFactories: number;
  dockyards: number;
  infrastructure: number;
  /** Annual resource output, in game units per day. */
  resources: Partial<Record<ResourceType, number>>;
  ideology: Ideology;
  major: boolean;
  /** Divisions fielded at scenario start. */
  startingDivisions: number;
}

export const NATIONS: NationDef[] = [
  {
    tag: 'GER', name: 'Germany', members: ['DEU'],
    color: [0x7e, 0x8b, 0x98], capital: 'Berlin', capitalLonLat: [13.4, 52.52],
    terrain: 'plains', population: 67.8,
    civilianFactories: 26, militaryFactories: 18, dockyards: 8, infrastructure: 5,
    resources: { steel: 44, aluminium: 12, chromium: 4 },
    ideology: 'fascist', major: true, startingDivisions: 24,
  },
  {
    tag: 'SOV', name: 'Soviet Union', members: ['RUS', 'UKR', 'BLR'],
    color: [0xc4, 0x44, 0x3a], capital: 'Moscow', capitalLonLat: [37.62, 55.75],
    terrain: 'plains', population: 168.0,
    civilianFactories: 40, militaryFactories: 22, dockyards: 6, infrastructure: 3,
    // Baku and Grozny. Sixty was never enough to fuel the army the Soviet
    // economy raises here -- it read as self-sufficient only while a rounding
    // slip in the map build inflated it to sixty-four. In 1936 the Soviet
    // Union pumped roughly two and a half times what Romania did, which is the
    // proportion the reference uses too, so it is the proportion used here.
    resources: { oil: 98, steel: 60, aluminium: 20, tungsten: 12, chromium: 24 },
    ideology: 'communist', major: true, startingDivisions: 32,
  },
  {
    tag: 'ENG', name: 'United Kingdom',
    members: ['GBR', 'IMN', 'JEY', 'GGY', 'MLT', 'CYP', 'EGY', 'ISR', 'PSE', 'JOR', 'IRQ'],
    color: [0xb0, 0x65, 0x5a], capital: 'London', capitalLonLat: [-0.13, 51.51],
    terrain: 'plains', population: 47.0,
    civilianFactories: 34, militaryFactories: 12, dockyards: 20, infrastructure: 5,
    resources: { oil: 26, steel: 32, aluminium: 8, rubber: 32, tungsten: 6, chromium: 6 },
    ideology: 'democratic', major: true, startingDivisions: 14,
  },
  {
    tag: 'FRA', name: 'France', members: ['FRA', 'MCO', 'DZA', 'MAR', 'TUN', 'SYR', 'LBN'],
    color: [0x52, 0x85, 0xc4], capital: 'Paris', capitalLonLat: [2.35, 48.86],
    terrain: 'plains', population: 41.5,
    civilianFactories: 24, militaryFactories: 10, dockyards: 10, infrastructure: 5,
    resources: { steel: 26, aluminium: 14, tungsten: 4, chromium: 4 },
    ideology: 'democratic', major: true, startingDivisions: 18,
  },
  {
    tag: 'ITA', name: 'Italy', members: ['ITA', 'SMR', 'VAT', 'LBY'],
    color: [0x74, 0xa4, 0x68], capital: 'Rome', capitalLonLat: [12.5, 41.9],
    terrain: 'hills', population: 42.5,
    civilianFactories: 18, militaryFactories: 10, dockyards: 10, infrastructure: 4,
    resources: { steel: 10, aluminium: 8 },
    ideology: 'fascist', major: true, startingDivisions: 16,
  },
  {
    tag: 'POL', name: 'Poland', members: ['POL'],
    color: [0xcf, 0x90, 0xb0], capital: 'Warsaw', capitalLonLat: [21.01, 52.23],
    terrain: 'plains', population: 33.0,
    civilianFactories: 10, militaryFactories: 6, dockyards: 2, infrastructure: 3,
    resources: { steel: 18, chromium: 2 },
    ideology: 'neutral', major: false, startingDivisions: 12,
  },
  {
    tag: 'CZE', name: 'Czechoslovakia', members: ['CZE', 'SVK'],
    color: [0x9d, 0x92, 0xd4], capital: 'Prague', capitalLonLat: [14.42, 50.09],
    terrain: 'hills', population: 15.2,
    civilianFactories: 10, militaryFactories: 8, dockyards: 0, infrastructure: 5,
    resources: { steel: 14, tungsten: 2 },
    ideology: 'democratic', major: false, startingDivisions: 8,
  },
  {
    tag: 'YUG', name: 'Yugoslavia', members: ['SRB', 'HRV', 'BIH', 'SVN', 'MNE', 'MKD', 'KOS'],
    color: [0x8a, 0xc4, 0xae], capital: 'Belgrade', capitalLonLat: [20.46, 44.82],
    terrain: 'mountain', population: 15.4,
    civilianFactories: 6, militaryFactories: 3, dockyards: 1, infrastructure: 2,
    resources: { steel: 6, aluminium: 10, chromium: 4 },
    ideology: 'neutral', major: false, startingDivisions: 7,
  },
  {
    tag: 'ROM', name: 'Romania', members: ['ROU', 'MDA'],
    color: [0xdc, 0xb2, 0x64], capital: 'Bucharest', capitalLonLat: [26.1, 44.44],
    terrain: 'plains', population: 19.5,
    civilianFactories: 8, militaryFactories: 4, dockyards: 1, infrastructure: 2,
    resources: { oil: 42, steel: 6 },
    ideology: 'neutral', major: false, startingDivisions: 8,
  },
  {
    tag: 'HUN', name: 'Hungary', members: ['HUN'],
    color: [0xb8, 0x7c, 0x52], capital: 'Budapest', capitalLonLat: [19.04, 47.5],
    terrain: 'plains', population: 9.1,
    civilianFactories: 5, militaryFactories: 3, dockyards: 0, infrastructure: 3,
    resources: { steel: 4, aluminium: 12 },
    ideology: 'fascist', major: false, startingDivisions: 5,
  },
  {
    tag: 'AUS', name: 'Austria', members: ['AUT'],
    color: [0xe4, 0xca, 0xa2], capital: 'Vienna', capitalLonLat: [16.37, 48.21],
    terrain: 'mountain', population: 6.8,
    civilianFactories: 5, militaryFactories: 2, dockyards: 0, infrastructure: 4,
    resources: { steel: 6, tungsten: 2 },
    ideology: 'fascist', major: false, startingDivisions: 3,
  },
  {
    tag: 'BUL', name: 'Bulgaria', members: ['BGR'],
    color: [0x8f, 0xa9, 0x68], capital: 'Sofia', capitalLonLat: [23.32, 42.7],
    terrain: 'mountain', population: 6.3,
    civilianFactories: 4, militaryFactories: 2, dockyards: 0, infrastructure: 2,
    resources: { steel: 2, chromium: 4 },
    ideology: 'neutral', major: false, startingDivisions: 4,
  },
  {
    tag: 'GRE', name: 'Greece', members: ['GRC'],
    color: [0x68, 0xb4, 0xd8], capital: 'Athens', capitalLonLat: [23.73, 37.98],
    terrain: 'mountain', population: 7.0,
    civilianFactories: 4, militaryFactories: 2, dockyards: 2, infrastructure: 2,
    resources: { steel: 2, aluminium: 6, chromium: 2 },
    ideology: 'neutral', major: false, startingDivisions: 4,
  },
  {
    tag: 'ALB', name: 'Albania', members: ['ALB'],
    color: [0xc0, 0x54, 0x54], capital: 'Tirana', capitalLonLat: [19.82, 41.33],
    terrain: 'mountain', population: 1.0,
    civilianFactories: 1, militaryFactories: 0, dockyards: 0, infrastructure: 1,
    resources: { chromium: 6 },
    ideology: 'neutral', major: false, startingDivisions: 1,
  },
  {
    tag: 'TUR', name: 'Turkey', members: ['TUR'],
    color: [0xd6, 0x76, 0x60], capital: 'Ankara', capitalLonLat: [32.86, 39.93],
    terrain: 'mountain', population: 16.2,
    civilianFactories: 6, militaryFactories: 3, dockyards: 2, infrastructure: 2,
    resources: { steel: 6, chromium: 16 },
    ideology: 'neutral', major: false, startingDivisions: 7,
  },
  {
    tag: 'SPR', name: 'Spain', members: ['ESP', 'AND'],
    color: [0xe4, 0xc6, 0x55], capital: 'Madrid', capitalLonLat: [-3.7, 40.42],
    terrain: 'hills', population: 25.0,
    civilianFactories: 10, militaryFactories: 4, dockyards: 4, infrastructure: 3,
    resources: { steel: 12, tungsten: 6, chromium: 2 },
    ideology: 'democratic', major: false, startingDivisions: 8,
  },
  {
    tag: 'POR', name: 'Portugal', members: ['PRT'],
    color: [0x54, 0xa0, 0x7e], capital: 'Lisbon', capitalLonLat: [-9.14, 38.72],
    terrain: 'hills', population: 7.2,
    civilianFactories: 3, militaryFactories: 1, dockyards: 2, infrastructure: 2,
    resources: { tungsten: 12 },
    ideology: 'fascist', major: false, startingDivisions: 3,
  },
  {
    tag: 'SWI', name: 'Switzerland', members: ['CHE', 'LIE'],
    color: [0xe4, 0x70, 0x70], capital: 'Bern', capitalLonLat: [7.45, 46.95],
    terrain: 'mountain', population: 4.1,
    civilianFactories: 6, militaryFactories: 2, dockyards: 0, infrastructure: 5,
    resources: { aluminium: 4 },
    ideology: 'democratic', major: false, startingDivisions: 4,
  },
  {
    tag: 'BEL', name: 'Belgium', members: ['BEL'],
    color: [0xec, 0xd3, 0x70], capital: 'Brussels', capitalLonLat: [4.35, 50.85],
    terrain: 'plains', population: 8.3,
    civilianFactories: 8, militaryFactories: 3, dockyards: 2, infrastructure: 5,
    resources: { steel: 8 },
    ideology: 'democratic', major: false, startingDivisions: 4,
  },
  {
    tag: 'HOL', name: 'Netherlands', members: ['NLD'],
    color: [0xf4, 0xa4, 0x50], capital: 'Amsterdam', capitalLonLat: [4.9, 52.37],
    terrain: 'marsh', population: 8.6,
    civilianFactories: 8, militaryFactories: 2, dockyards: 4, infrastructure: 5,
    resources: { oil: 4, rubber: 12 },
    ideology: 'democratic', major: false, startingDivisions: 3,
  },
  {
    tag: 'LUX', name: 'Luxembourg', members: ['LUX'],
    color: [0x90, 0xcc, 0xe4], capital: 'Luxembourg', capitalLonLat: [6.13, 49.61],
    terrain: 'hills', population: 0.3,
    civilianFactories: 1, militaryFactories: 0, dockyards: 0, infrastructure: 5,
    resources: { steel: 6 },
    ideology: 'democratic', major: false, startingDivisions: 1,
  },
  {
    tag: 'DEN', name: 'Denmark', members: ['DNK', 'FRO'],
    color: [0xe4, 0x80, 0x90], capital: 'Copenhagen', capitalLonLat: [12.57, 55.68],
    terrain: 'plains', population: 3.8,
    civilianFactories: 4, militaryFactories: 1, dockyards: 2, infrastructure: 5,
    resources: {},
    ideology: 'democratic', major: false, startingDivisions: 2,
  },
  {
    tag: 'NOR', name: 'Norway', members: ['NOR'],
    color: [0x70, 0x90, 0xd4], capital: 'Oslo', capitalLonLat: [10.75, 59.91],
    terrain: 'mountain', population: 2.9,
    civilianFactories: 4, militaryFactories: 1, dockyards: 3, infrastructure: 3,
    resources: { aluminium: 16, steel: 4 },
    ideology: 'democratic', major: false, startingDivisions: 2,
  },
  {
    tag: 'SWE', name: 'Sweden', members: ['SWE'],
    color: [0x5a, 0xac, 0xcc], capital: 'Stockholm', capitalLonLat: [18.07, 59.33],
    terrain: 'forest', population: 6.2,
    civilianFactories: 8, militaryFactories: 3, dockyards: 3, infrastructure: 4,
    resources: { steel: 34, tungsten: 4 },
    ideology: 'democratic', major: false, startingDivisions: 4,
  },
  {
    tag: 'FIN', name: 'Finland', members: ['FIN', 'ALD'],
    color: [0xac, 0xcc, 0xe4], capital: 'Helsinki', capitalLonLat: [24.94, 60.17],
    terrain: 'forest', population: 3.6,
    civilianFactories: 4, militaryFactories: 2, dockyards: 1, infrastructure: 3,
    resources: { steel: 4, chromium: 4 },
    ideology: 'democratic', major: false, startingDivisions: 4,
  },
  {
    tag: 'EST', name: 'Estonia', members: ['EST'],
    color: [0x9e, 0xbc, 0xac], capital: 'Tallinn', capitalLonLat: [24.75, 59.44],
    terrain: 'forest', population: 1.1,
    civilianFactories: 1, militaryFactories: 1, dockyards: 0, infrastructure: 3,
    resources: { oil: 4 },
    ideology: 'neutral', major: false, startingDivisions: 2,
  },
  {
    tag: 'LAT', name: 'Latvia', members: ['LVA'],
    color: [0xc0, 0x90, 0x80], capital: 'Riga', capitalLonLat: [24.11, 56.95],
    terrain: 'forest', population: 2.0,
    civilianFactories: 2, militaryFactories: 1, dockyards: 0, infrastructure: 3,
    resources: {},
    ideology: 'neutral', major: false, startingDivisions: 2,
  },
  {
    tag: 'LIT', name: 'Lithuania', members: ['LTU'],
    color: [0x90, 0xb0, 0x65], capital: 'Kaunas', capitalLonLat: [23.9, 54.9],
    terrain: 'plains', population: 2.5,
    civilianFactories: 2, militaryFactories: 1, dockyards: 0, infrastructure: 3,
    resources: {},
    ideology: 'neutral', major: false, startingDivisions: 2,
  },
  {
    tag: 'IRE', name: 'Ireland', members: ['IRL'],
    color: [0x68, 0xbc, 0x7a], capital: 'Dublin', capitalLonLat: [-6.26, 53.35],
    terrain: 'plains', population: 3.0,
    civilianFactories: 2, militaryFactories: 1, dockyards: 1, infrastructure: 3,
    resources: {},
    ideology: 'democratic', major: false, startingDivisions: 2,
  },
  {
    tag: 'ICE', name: 'Iceland', members: ['ISL'],
    color: [0xac, 0xd4, 0xe0], capital: 'Reykjavik', capitalLonLat: [-21.94, 64.15],
    terrain: 'mountain', population: 0.1,
    civilianFactories: 1, militaryFactories: 0, dockyards: 0, infrastructure: 2,
    resources: {},
    ideology: 'democratic', major: false, startingDivisions: 1,
  },
];

/** Fast lookup from Natural Earth admin-0 code to 1936 nation tag. */
export const MEMBER_TO_TAG = new Map<string, string>();
for (const n of NATIONS) for (const m of n.members) MEMBER_TO_TAG.set(m, n.tag);

export const NATION_BY_TAG = new Map<string, NationDef>(NATIONS.map((n) => [n.tag, n]));
