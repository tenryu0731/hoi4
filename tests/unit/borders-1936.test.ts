import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { ProvinceIndex } from '../../src/sim/map/ProvinceIndex';
import type { MapDataJson } from '../../src/sim/map/MapData';

/**
 * Who held what on the first of January, 1936.
 *
 * The map is built by rasterising Natural Earth's present-day administrative
 * units onto the reference export's grid and letting each cell take the tag
 * most of its pixels agree on, with an explicit list of the places where the
 * borders moved between then and now. That is a lot of machinery between the
 * source data and the answer, and every part of it has been wrong at least
 * once: a majority erased Gibraltar, a rescue meant for Gibraltar handed a
 * Sicilian province to Malta, and every district of Moldova came out Romanian
 * including the left bank of the Dniester, which was Soviet.
 *
 * So the borders are checked against the history rather than against
 * themselves. A snapshot would have accepted all three.
 */

const MAP_PATH = join(process.cwd(), 'public', 'data', 'map.json');

let index: ProvinceIndex;

beforeAll(() => {
  const data = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as MapDataJson;
  index = ProvinceIndex.load(data);
});

/** A place, and the tag that held it in 1936. */
type Fact = readonly [name: string, lon: number, lat: number, tag: string];

/**
 * Points inland enough to be on this map's land.
 *
 * The reference is a game map, not a survey: its coastline is drawn where
 * Hearts of Iron IV needs sea provinces, so Copenhagen, Dublin and Riga all
 * stand in open water on it. Testing a capital's own coordinates would be
 * testing the georeference, which is measured elsewhere; these points are
 * chosen to sit inside the country they belong to.
 */
const INLAND: readonly Fact[] = [
  // --- the Reich in its Versailles borders, the Saar already returned ------
  ['Berlin', 13.40, 52.52, 'GER'],
  ['Munich', 11.58, 48.14, 'GER'],
  ['Cologne', 6.96, 50.94, 'GER'],
  ['Breslau / Lower Silesia', 17.04, 51.11, 'GER'],
  ['Königsberg / East Prussia', 20.51, 54.71, 'GER'],
  ['Saarbrücken, German since the 1935 plebiscite', 6.99, 49.23, 'GER'],

  // --- Poland between Riga and the Corridor -------------------------------
  ['Warsaw', 21.01, 52.23, 'POL'],
  ['Lwów / eastern Galicia', 24.03, 49.84, 'POL'],
  ['Wilno, held by Poland since 1920', 25.28, 54.69, 'POL'],
  ['Brest-Litovsk / Polesie', 23.70, 52.10, 'POL'],
  ['Równe / Wołyń', 26.25, 50.62, 'POL'],

  // --- Czechoslovakia, Sudetenland and Ruthenia included ------------------
  ['Prague', 14.42, 50.09, 'CZE'],
  ['Karlovy Vary / Sudetenland', 12.87, 50.23, 'CZE'],
  ['Bratislava', 17.11, 48.15, 'CZE'],
  ['Užhorod / Podkarpatská Rus', 22.30, 48.62, 'CZE'],
  ['Český Těšín / Zaolzie', 18.63, 49.75, 'CZE'],

  // --- Austria, two years before the Anschluss ----------------------------
  ['Vienna', 16.37, 48.21, 'AUS'],
  ['Innsbruck', 11.40, 47.27, 'AUS'],
  ['Salzburg', 13.04, 47.81, 'AUS'],
  ['Klagenfurt, Austrian by the 1920 plebiscite', 14.31, 46.62, 'AUS'],

  // --- Greater Romania ----------------------------------------------------
  ['Bucharest', 26.10, 44.44, 'ROM'],
  ['Cluj / Transylvania', 23.60, 46.77, 'ROM'],
  ['Chișinău / Bessarabia', 28.86, 47.01, 'ROM'],
  ['Ismail / the Budjak', 28.84, 45.35, 'ROM'],
  ['Cernăuți / northern Bukovina', 25.94, 48.29, 'ROM'],
  ['Silistra / the Cadrilater', 27.26, 44.12, 'ROM'],

  // --- Italy and its Adriatic gains ---------------------------------------
  ['Rome', 12.50, 41.90, 'ITA'],
  ['Bolzano / South Tyrol', 11.35, 46.50, 'ITA'],
  ['Trieste / Venezia Giulia', 13.77, 45.65, 'ITA'],
  ['Benghazi / Cyrenaica', 20.07, 32.12, 'ITA'],

  // --- the rest of Europe -------------------------------------------------
  ['Paris', 2.35, 48.86, 'FRA'],
  ['Strasbourg / Alsace', 7.75, 48.58, 'FRA'],
  ['London', -0.13, 51.51, 'ENG'],
  ['Moscow', 37.62, 55.75, 'SOV'],
  ['Minsk', 27.57, 53.90, 'SOV'],
  ['Kiev', 30.52, 50.45, 'SOV'],
  ['Odessa', 30.73, 46.48, 'SOV'],
  ['Madrid', -3.70, 40.42, 'SPR'],
  ['Lisbon', -9.14, 38.72, 'POR'],
  ['Bern', 7.45, 46.95, 'SWI'],
  ['Luxembourg', 6.13, 49.61, 'LUX'],
  ['Budapest', 19.04, 47.50, 'HUN'],
  ['Sopron, Hungarian by the 1921 vote', 16.59, 47.68, 'HUN'],
  ['Belgrade', 20.46, 44.79, 'YUG'],
  ['Zagreb', 15.98, 45.81, 'YUG'],
  ['Ljubljana', 14.51, 46.06, 'YUG'],
  ['Skopje', 21.43, 41.99, 'YUG'],
  ['Sofia', 23.32, 42.70, 'BUL'],
  ['Tirana', 19.82, 41.33, 'ALB'],
  ['Thessaloniki', 22.94, 40.64, 'GRE'],
  ['Ankara', 32.85, 39.93, 'TUR'],
  ['Edirne, Turkey in Europe', 26.56, 41.68, 'TUR'],
  ['Oslo', 10.75, 59.91, 'NOR'],
  ['Kaunas, the provisional capital', 23.90, 54.90, 'LIT'],
  ['Viipuri / the Karelian Isthmus', 28.75, 60.71, 'FIN'],
  ['Petsamo, Finland’s Arctic corridor', 31.0, 69.6, 'FIN'],
  ['Murmansk', 33.08, 68.97, 'SOV'],

  // --- the colonial and mandate world -------------------------------------
  ['Algiers', 3.06, 36.75, 'FRA'],
  ['Tunis', 10.18, 36.81, 'FRA'],
  ['Casablanca', -7.60, 33.57, 'FRA'],
  ['Damascus, the French mandate', 36.29, 33.51, 'FRA'],
  ['İskenderun, the Sanjak before 1939', 36.16, 36.20, 'FRA'],
  ['Cairo', 31.24, 30.04, 'ENG'],
  ['Jerusalem', 35.22, 31.78, 'ENG'],
  ['Baghdad', 44.36, 33.31, 'ENG'],
  ['Mosul', 43.13, 36.34, 'ENG'],
  ['Nicosia / Cyprus', 33.36, 35.17, 'ENG'],
  ['Smara / Spanish Sahara', -11.67, 26.74, 'SPR'],
  ['Tehran', 51.39, 35.69, 'PER'],
];

/**
 * Places whose own coordinates fall in this map's water.
 *
 * The georeference is fitted to about a sixth of a degree and the reference
 * draws its coasts where the game needs them, so an island or a port can miss
 * the land by a cell. What still has to be true is that the nearest province
 * belongs to the right country -- Reykjavík is Icelandic even though the point
 * is at sea, because the export puts Iceland a degree and a half north.
 */
const OFFSHORE: readonly Fact[] = [
  ['Reykjavík', -21.94, 64.15, 'ICE'],
  ['Copenhagen', 12.57, 55.68, 'DEN'],
  ['Tallinn', 24.75, 59.44, 'EST'],
  ['Riga', 24.11, 56.95, 'LAT'],
  ['Dublin', -6.26, 53.35, 'IRE'],
  ['Belfast, Northern Ireland', -5.93, 54.60, 'ENG'],
  ['Danzig, under Poland at the start', 18.65, 54.35, 'POL'],
  ['Tripoli / Libya', 13.19, 32.89, 'ITA'],
  ['Rhodes / the Dodecanese', 28.22, 36.44, 'ITA'],
  ['Heraklion / Crete', 25.14, 35.34, 'GRE'],
  ['Ceuta', -5.32, 35.89, 'SPR'],
  ['Tórshavn / the Faroes', -6.79, 62.01, 'DEN'],
];

const owner = (id: number): string => index.get(id).ownerTag;

/** The nearest province by great-circle distance to a point at sea. */
function nearest(lon: number, lat: number): number {
  const RAD = Math.PI / 180;
  let best = 0;
  let bestD = Infinity;
  for (const p of index.provinces) {
    const dx = (p.lon - lon) * Math.cos(lat * RAD);
    const dy = p.lat - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = p.id; }
  }
  return best;
}

describe('the 1936 map', () => {
  it('puts every inland place in the hands that held it', () => {
    const wrong: string[] = [];
    for (const [name, lon, lat, tag] of INLAND) {
      const id = index.atLonLat(lon, lat);
      if (id === null) { wrong.push(`${name}: at sea on this map`); continue; }
      if (owner(id) !== tag) wrong.push(`${name}: ${owner(id)}, wanted ${tag}`);
    }
    expect(wrong).toEqual([]);
  });

  it('gives a coast the map draws away from its country to that country anyway', () => {
    const wrong: string[] = [];
    for (const [name, lon, lat, tag] of OFFSHORE) {
      const id = index.atLonLat(lon, lat) ?? nearest(lon, lat);
      if (owner(id) !== tag) wrong.push(`${name}: ${owner(id)}, wanted ${tag}`);
    }
    expect(wrong).toEqual([]);
  });

  it('leaves no province cut off from every neighbour of its own country', () => {
    // A one-province enclave is usually a mistake -- a rescue that reached
    // across a sea, a vote that lost a frontier -- and the few real ones are
    // worth naming so a new one is noticed.
    const real = new Set([
      'Luxembourg', 'Gibraltar', 'Rodi', 'Tangier', 'Las Palmas', 'Smara',
      'North-west Polyarnyy',
    ]);
    const odd: string[] = [];
    for (const p of index.provinces) {
      if (p.neighbors.length === 0) continue;
      if (p.neighbors.some((n) => owner(n) === p.ownerTag)) continue;
      if (real.has(p.name)) continue;
      odd.push(`${p.name} (${p.ownerTag})`);
    }
    expect(odd).toEqual([]);
  });

  it('keeps every state whole inside one country', () => {
    const split: string[] = [];
    for (const s of index.data.states) {
      const tags = new Set(s.provinces.map((i) => owner(i)));
      if (tags.size > 1) split.push(`${s.name}: ${[...tags].join(', ')}`);
    }
    expect(split).toEqual([]);
  });
});
