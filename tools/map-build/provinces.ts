import { Delaunay } from 'd3-delaunay';
import polygonClipping from 'polygon-clipping';

import {
  type LccParams, type Pt, type Ring,
  bboxOfRing, poleOfInaccessibility, pointInRing, ringArea,
} from './geo';
import type { ArcRef } from './topology';
import type { CityJson, ProvinceGeoJson, StateGeoJson } from '../../src/sim/map/MapData';
import type { TerrainType } from '../../src/sim/core/types';
import { NATION_BY_TAG, NATIONS } from '../../src/sim/scenario/nations';
import type { BuiltProvinces } from './build';

/**
 * Iteration 2 of the map: nations cut into provinces, provinces grouped into
 * states.
 *
 * Provinces are Voronoi cells seeded from real cities and clipped to the
 * nation's own outline. Seeding from cities rather than a regular lattice means
 * the cells follow where people actually lived: dense in the Ruhr and the Po
 * valley, coarse across the steppe, which is exactly the granularity the
 * gameplay wants.
 *
 * Country-level play made every nation a single indivisible cell, so one lost
 * battle was total conquest. Subdivision is what turns the campaign into a
 * front that moves.
 */

export interface SubdivideInput {
  units: { code: string; tag: string; rings: Ring[]; ringRefs: ArcRef[][] }[];
  cities: CityJson[];
  target: number;
  projection: LccParams;
}

/** Square kilometres of European territory per province, before clamping. */
const AREA_PER_PROVINCE = 26_000;
/**
 * The same for colonial and desert holdings. Sparsely held ground does not
 * deserve the same granularity as the Ruhr, and without this France ends up
 * with more provinces in the Sahara than in France.
 */
const COLONIAL_AREA_PER_PROVINCE = 110_000;
/**
 * Even the smallest nation gets more than one province. A single-province
 * country capitulates the moment one battle goes against it, which made the
 * country-level map unplayable.
 */
const MIN_PROVINCES_PER_UNIT = 2;
const MAX_PROVINCES_PER_UNIT = 22;
/** Cells smaller than this are merged away rather than shipped as slivers. */
const MIN_PROVINCE_AREA = 500;

// ---------------------------------------------------------------------------
// Terrain zones
// ---------------------------------------------------------------------------

interface TerrainZone {
  name: string;
  /** [minLon, minLat, maxLon, maxLat] */
  box: [number, number, number, number];
  terrain: TerrainType;
}

/**
 * Physical geography, as lon/lat boxes applied in order.
 *
 * Natural Earth's vector layers carry no elevation, and a raster DEM would cost
 * tens of megabytes for a detail the game reads as one enum. Hand-placed ranges
 * put the Alps, the Carpathians and the Pyrenees where they belong, which is
 * all the combat model needs.
 */
const TERRAIN_ZONES: TerrainZone[] = [
  { name: 'Sahara', box: [-20, 20, 40, 31.5], terrain: 'desert' },
  { name: 'Levant desert', box: [33, 28, 50, 34], terrain: 'desert' },
  { name: 'Alps', box: [5.5, 44.0, 16.5, 48.0], terrain: 'mountain' },
  { name: 'Pyrenees', box: [-2.0, 42.0, 3.5, 43.6], terrain: 'mountain' },
  { name: 'Carpathians', box: [20.5, 44.5, 27.5, 49.5], terrain: 'mountain' },
  { name: 'Dinaric Alps', box: [14.5, 40.0, 24.0, 45.5], terrain: 'mountain' },
  { name: 'Scandinavian mountains', box: [4.5, 58.5, 19.0, 71.5], terrain: 'mountain' },
  { name: 'Caucasus', box: [38.0, 40.5, 50.0, 45.0], terrain: 'mountain' },
  { name: 'Anatolian plateau', box: [26.0, 36.5, 45.0, 41.5], terrain: 'mountain' },
  { name: 'Apennines', box: [9.5, 37.5, 17.0, 44.5], terrain: 'hills' },
  { name: 'Iberian meseta', box: [-8.5, 37.0, 0.5, 43.0], terrain: 'hills' },
  { name: 'Scottish highlands', box: [-8.0, 55.5, -2.0, 59.0], terrain: 'hills' },
  { name: 'Bohemian massif', box: [12.0, 48.5, 19.0, 51.0], terrain: 'hills' },
  { name: 'Pripet marshes', box: [24.0, 50.5, 31.0, 53.5], terrain: 'marsh' },
  { name: 'Low Countries', box: [3.0, 50.8, 9.0, 54.0], terrain: 'marsh' },
  { name: 'Boreal forest', box: [10.0, 57.0, 45.0, 71.5], terrain: 'forest' },
  { name: 'Russian forest belt', box: [27.0, 51.0, 52.0, 62.0], terrain: 'forest' },
];

/**
 * Territory that changed hands between the Natural Earth present and 1936.
 *
 * The country-level map cannot express a border that runs through what is now a
 * single admin unit. At province granularity it can, so East Prussia goes back
 * to Germany rather than sitting inside the Soviet Union.
 */
const HISTORICAL_OVERRIDES: { name: string; box: [number, number, number, number]; tag: string }[] = [
  { name: 'East Prussia', box: [19.4, 53.8, 23.0, 55.4], tag: 'GER' },
];

function classifyTerrain(lon: number, lat: number, cityPop: number): TerrainType {
  if (cityPop >= 900) return 'urban';
  for (const z of TERRAIN_ZONES) {
    const [minLon, minLat, maxLon, maxLat] = z.box;
    if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) return z.terrain;
  }
  return 'plains';
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface Seed {
  x: number;
  y: number;
  lon: number;
  lat: number;
  /** City population in thousands; 0 for a filler point. */
  pop: number;
  cityName: string | null;
}

/** Inverse of the Lambert projection, needed to classify generated seeds. */
function unprojectLcc(x: number, y: number, p: LccParams): [number, number] {
  const D2R = Math.PI / 180;
  const phi1 = p.lat1 * D2R;
  const phi2 = p.lat2 * D2R;
  const phi0 = p.lat0 * D2R;
  const n = Math.abs(p.lat1 - p.lat2) < 1e-9
    ? Math.sin(phi1)
    : Math.log(Math.cos(phi1) / Math.cos(phi2))
      / Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
  const F = (Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n)) / n;
  const rho0 = F / Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n);

  const px = (x - p.offsetX) / p.scale;
  // The forward transform flips y so that north is up.
  const py = -(y - p.offsetY) / p.scale;
  const rho = Math.sign(n) * Math.hypot(px, rho0 - py);
  const theta = Math.atan2(px, rho0 - py);
  const lon = p.lon0 + (theta / n) / D2R;
  const lat = (2 * Math.atan(Math.pow(F / rho, 1 / n)) - Math.PI / 2) / D2R;
  return [lon, lat];
}

function largestRing(rings: Ring[]): Ring {
  let best = rings[0];
  let bestArea = -Infinity;
  for (const r of rings) {
    const a = ringArea(r);
    if (a > bestArea) { bestArea = a; best = r; }
  }
  return best;
}

function pointInRings(x: number, y: number, rings: Ring[]): boolean {
  let winding = 0;
  for (const r of rings) if (pointInRing(x, y, r)) winding++;
  return winding % 2 === 1;
}

/**
 * Picks seed points for one nation: its cities first, then filler points chosen
 * by farthest-point sampling so the empty interior still gets covered.
 */
function makeSeeds(
  rings: Ring[], cities: CityJson[], count: number, proj: LccParams,
): Seed[] {
  const seeds: Seed[] = [];
  const sorted = [...cities].sort((a, b) => b.pop - a.pop);
  for (const c of sorted) {
    if (seeds.length >= count) break;
    // Two cities in the same valley would produce a sliver between them.
    if (seeds.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < 45)) continue;
    const [lon, lat] = unprojectLcc(c.x, c.y, proj);
    seeds.push({ x: c.x, y: c.y, lon, lat, pop: c.pop, cityName: c.name });
  }
  if (seeds.length >= count) return seeds;

  // Candidate lattice over the nation's bounding box, kept to interior points.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) {
    const [a, b, c, d] = bboxOfRing(r);
    minX = Math.min(minX, a); minY = Math.min(minY, b);
    maxX = Math.max(maxX, c); maxY = Math.max(maxY, d);
  }
  const span = Math.max(maxX - minX, maxY - minY);
  const step = Math.max(12, span / 42);
  const candidates: Pt[] = [];
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      if (pointInRings(x, y, rings)) candidates.push([x, y]);
    }
  }
  if (candidates.length === 0) {
    if (seeds.length === 0) {
      const centre = poleOfInaccessibility([rings[0]], 4);
      const [lon, lat] = unprojectLcc(centre[0], centre[1], proj);
      seeds.push({ x: centre[0], y: centre[1], lon, lat, pop: 0, cityName: null });
    }
    return seeds;
  }

  // Farthest-point sampling: repeatedly take the candidate furthest from every
  // seed placed so far, which spreads cells evenly without any randomness.
  const dist = candidates.map((p) =>
    seeds.length === 0
      ? Infinity
      : Math.min(...seeds.map((s) => Math.hypot(s.x - p[0], s.y - p[1]))));

  while (seeds.length < count) {
    let best = -1;
    let bestD = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (dist[i] > bestD) { bestD = dist[i]; best = i; }
    }
    if (best < 0 || bestD <= 0) break;
    const [x, y] = candidates[best];
    const [lon, lat] = unprojectLcc(x, y, proj);
    seeds.push({ x, y, lon, lat, pop: 0, cityName: null });
    dist[best] = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (dist[i] === -Infinity) continue;
      const d = Math.hypot(candidates[i][0] - x, candidates[i][1] - y);
      if (d < dist[i]) dist[i] = d;
    }
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// Subdivision
// ---------------------------------------------------------------------------

type MultiRing = number[][][];

interface RawProvince {
  tag: string;
  seed: Seed;
  rings: Ring[];
  area: number;
  centre: Pt;
  terrain: TerrainType;
}

/**
 * Groups a unit's rings into a proper MultiPolygon.
 *
 * A nation's rings are a flat list: mainland, islands, and enclave holes all
 * mixed together. Handing that straight to a boolean-op library treats every
 * island as a hole in the mainland, and the intersection comes back empty --
 * which silently dropped Spain, Portugal and Greece from the map entirely.
 * Each outer ring must carry its own holes.
 */
function toMultiPolygon(rings: Ring[]): MultiRing[] {
  const order = rings
    .map((r, i) => ({ i, area: ringArea(r) }))
    .sort((a, b) => b.area - a.area);

  const isHole = new Array(rings.length).fill(false);
  const parent = new Array<number>(rings.length).fill(-1);

  for (const { i } of order) {
    // Nesting depth decides the role: inside an odd number of rings is a hole.
    let depth = 0;
    let smallestContainer = -1;
    let smallestArea = Infinity;
    for (let j = 0; j < rings.length; j++) {
      if (i === j) continue;
      const areaJ = ringArea(rings[j]);
      if (areaJ <= ringArea(rings[i])) continue;
      if (!pointInRing(rings[i][0][0], rings[i][0][1], rings[j])) continue;
      depth++;
      if (areaJ < smallestArea) { smallestArea = areaJ; smallestContainer = j; }
    }
    isHole[i] = depth % 2 === 1;
    parent[i] = smallestContainer;
  }

  const polygons: MultiRing[] = [];
  const indexOfOuter = new Map<number, number>();
  for (let i = 0; i < rings.length; i++) {
    if (isHole[i]) continue;
    indexOfOuter.set(i, polygons.length);
    polygons.push([rings[i].map((p) => [p[0], p[1]] as number[])]);
  }
  for (let i = 0; i < rings.length; i++) {
    if (!isHole[i]) continue;
    const owner = parent[i] >= 0 ? indexOfOuter.get(parent[i]) : undefined;
    if (owner === undefined) continue;
    polygons[owner].push(rings[i].map((p) => [p[0], p[1]] as number[]));
  }
  return polygons;
}

function clipCellToUnit(cell: Pt[], unit: MultiRing[]): Ring[] {
  if (cell.length < 3) return [];
  try {
    const result = polygonClipping.intersection(
      [cell.map((p) => [p[0], p[1]] as [number, number])] as never,
      unit as never,
    );
    const out: Ring[] = [];
    for (const poly of result) {
      for (const ring of poly) {
        const r: Ring = ring.map((p) => [p[0], p[1]] as Pt);
        // polygon-clipping repeats the first point at the end.
        if (r.length > 1) {
          const f = r[0];
          const l = r[r.length - 1];
          if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) r.pop();
        }
        if (r.length >= 3) out.push(r);
      }
    }
    return out;
  } catch {
    // Degenerate geometry: drop the cell rather than abort the whole build.
    return [];
  }
}

export function subdivideProvinces(input: SubdivideInput): BuiltProvinces {
  const { units, cities, projection } = input;
  const stateTarget = Math.max(8, input.target);

  // --- 1. Voronoi cells per admin unit ------------------------------------
  const raw: RawProvince[] = [];
  const provinceOfUnit = new Map<string, number>();

  for (const unit of units) {
    const area = unit.rings.reduce((s, r) => s + ringArea(r), 0);
    const centre = poleOfInaccessibility([largestRing(unit.rings)], 8);
    const [, centreLat] = unprojectLcc(centre[0], centre[1], projection);
    const density = centreLat < 37 ? COLONIAL_AREA_PER_PROVINCE : AREA_PER_PROVINCE;
    const byDensity = Math.min(
      MAX_PROVINCES_PER_UNIT,
      Math.max(MIN_PROVINCES_PER_UNIT, Math.round(area / density)),
    );
    // Never ask for more provinces than the territory can hold: splitting Malta
    // in two produces two slivers, both of which are then discarded, and the
    // island disappears from the map.
    const byArea = Math.max(1, Math.floor(area / MIN_PROVINCE_AREA));
    const wanted = Math.min(byDensity, byArea);

    const unitMulti = toMultiPolygon(unit.rings);
    // Seed only on landmasses big enough to hold a province. Otherwise
    // farthest-point sampling puts seeds on Madeira and the Azores -- the
    // points furthest from everything else -- and their clipped cells are then
    // discarded as slivers, leaving the mainland as a single province.
    const seedRings = unit.rings.filter((r) => ringArea(r) >= MIN_PROVINCE_AREA * 3);
    const usable = seedRings.length > 0 ? seedRings : unit.rings;
    const mine = cities.filter((c) => pointInRings(c.x, c.y, usable));
    const seeds = makeSeeds(usable, mine, wanted, projection);

    if (seeds.length <= 1) {
      const [lon, lat] = unprojectLcc(centre[0], centre[1], projection);
      const seed = seeds[0] ?? { x: centre[0], y: centre[1], lon, lat, pop: 0, cityName: null };
      raw.push({
        tag: unit.tag,
        seed,
        rings: unit.rings,
        area,
        centre,
        terrain: classifyTerrain(seed.lon, seed.lat, seed.pop),
      });
      continue;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of unit.rings) {
      const [a, b, c, d] = bboxOfRing(r);
      minX = Math.min(minX, a); minY = Math.min(minY, b);
      maxX = Math.max(maxX, c); maxY = Math.max(maxY, d);
    }
    const pad = 50;
    // Nearly collinear seeds -- which is exactly what a narrow country like
    // Portugal or Norway produces -- degenerate the triangulation and make
    // d3-delaunay return null cells. A sub-kilometre deterministic offset
    // breaks the collinearity without moving anything visible.
    const delaunay = Delaunay.from(seeds.map((s, i) => [
      s.x + (((i * 37) % 7) - 3) * 0.35,
      s.y + (((i * 53) % 5) - 2) * 0.35,
    ] as [number, number]));
    const voronoi = delaunay.voronoi([minX - pad, minY - pad, maxX + pad, maxY + pad]);

    let produced = 0;
    for (let i = 0; i < seeds.length; i++) {
      const poly = voronoi.cellPolygon(i);
      if (!poly) continue;
      const rings = clipCellToUnit(poly.map((q: number[]) => [q[0], q[1]] as Pt), unitMulti);
      if (rings.length === 0) continue;
      const cellArea = rings.reduce((s, r) => s + ringArea(r), 0);
      if (cellArea < MIN_PROVINCE_AREA) continue;
      rings.sort((a, b) => ringArea(b) - ringArea(a));
      const cellCentre = poleOfInaccessibility([rings[0]], 3);
      raw.push({
        tag: unit.tag,
        seed: seeds[i],
        rings,
        area: cellArea,
        centre: cellCentre,
        terrain: classifyTerrain(seeds[i].lon, seeds[i].lat, seeds[i].pop),
      });
      produced++;
    }
    if (produced < wanted) {
      console.warn(
        `  note: ${unit.code} produced ${produced}/${wanted} provinces` +
        ` (${seeds.length} seeds, ${Math.round(area)} km2)`,
      );
    }
  }

  // --- 2. Historical border corrections ------------------------------------
  for (const p of raw) {
    for (const o of HISTORICAL_OVERRIDES) {
      const [minLon, minLat, maxLon, maxLat] = o.box;
      const { lon, lat } = p.seed;
      if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) {
        p.tag = o.tag;
      }
    }
  }

  // --- 3. Order provinces by nation, then geographically -------------------
  // Stable ids make save data and screenshot baselines survive a rebuild.
  const tagOrder = new Map(NATIONS.map((n, i) => [n.tag, i]));
  raw.sort((a, b) => {
    const ta = tagOrder.get(a.tag) ?? 999;
    const tb = tagOrder.get(b.tag) ?? 999;
    if (ta !== tb) return ta - tb;
    if (a.centre[1] !== b.centre[1]) return a.centre[1] - b.centre[1];
    return a.centre[0] - b.centre[0];
  });

  for (const unit of units) provinceOfUnit.set(unit.code, -1);

  // --- 4. Group provinces into states --------------------------------------
  const states: StateGeoJson[] = [];
  const stateOfProvince = new Int32Array(raw.length).fill(-1);

  const byTag = new Map<string, number[]>();
  raw.forEach((p, i) => {
    const list = byTag.get(p.tag);
    if (list) list.push(i);
    else byTag.set(p.tag, [i]);
  });

  // Provinces per state is derived from the requested state count rather than
  // fixed, so `--states=N` actually controls the economic granularity.
  const provincesPerState = Math.max(2, Math.round(raw.length / stateTarget));

  for (const [tag, members] of byTag) {
    const nation = NATION_BY_TAG.get(tag);
    if (!nation) continue;
    const k = Math.max(1, Math.round(members.length / provincesPerState));
    const groups = clusterProvinces(raw, members, k);

    for (const group of groups) {
      if (group.length === 0) continue;
      const id = states.length;
      for (const idx of group) stateOfProvince[idx] = id;
      states.push({
        id,
        name: stateName(raw, group, nation.name, states.length),
        ownerTag: tag,
        provinces: [],           // filled once province ids are final
        manpower: 0,
        resources: {},
        infrastructure: nation.infrastructure,
        civilianFactories: 0,
        militaryFactories: 0,
        dockyards: 0,
        buildingSlots: 0,
      });
    }
  }

  // --- 5. Emit provinces ---------------------------------------------------
  const provinces: ProvinceGeoJson[] = raw.map((p, id) => {
    const ringDepth = p.rings.map((r, i) => {
      let depth = 0;
      for (let j = 0; j < p.rings.length; j++) {
        if (i === j) continue;
        if (ringArea(p.rings[j]) > ringArea(r) && pointInRing(r[0][0], r[0][1], p.rings[j])) depth++;
      }
      return depth % 2;
    });
    return {
      id,
      name: p.seed.cityName ?? `${NATION_BY_TAG.get(p.tag)?.name ?? p.tag} ${id}`,
      stateId: Math.max(0, stateOfProvince[id]),
      ownerTag: p.tag,
      terrain: p.terrain,
      vp: 0,
      coastal: false,
      rings: p.rings.map((r) => flatten(r)),
      ringDepth,
      center: [Math.round(p.centre[0] * 10) / 10, Math.round(p.centre[1] * 10) / 10],
      area: Math.round(p.area),
      neighbors: [],
      seaNeighbors: [],
    };
  });

  for (const p of provinces) {
    const st = states[p.stateId];
    if (st) st.provinces.push(p.id);
  }

  // --- 6. Distribute national assets across states -------------------------
  distributeNationalAssets(provinces, states, raw);

  // --- 7. Adjacency --------------------------------------------------------
  computeGeometricAdjacency(provinces);

  return { provinces, states, provinceOfUnit };
}

function flatten(ring: Ring, decimals = 1): number[] {
  const f = 10 ** decimals;
  const out = new Array<number>(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    out[i * 2] = Math.round(ring[i][0] * f) / f;
    out[i * 2 + 1] = Math.round(ring[i][1] * f) / f;
  }
  return out;
}

function stateName(raw: RawProvince[], group: number[], nationName: string, index: number): string {
  // Name the state after its largest city, so the UI reads as a place.
  let best = group[0];
  for (const i of group) if (raw[i].seed.pop > raw[best].seed.pop) best = i;
  const city = raw[best].seed.cityName;
  return city ? city : `${nationName} ${index + 1}`;
}

/**
 * Lloyd-relaxed k-means over province centres.
 *
 * Seeded from the k most populous provinces rather than at random, so the
 * result is identical on every build -- a state layout that shuffles between
 * builds would invalidate every save and every screenshot baseline.
 */
function clusterProvinces(raw: RawProvince[], members: number[], k: number): number[][] {
  if (k <= 1 || members.length <= 1) return [members];

  const byPop = [...members].sort((a, b) => raw[b].seed.pop - raw[a].seed.pop);
  const centroids: Pt[] = byPop.slice(0, k).map((i) => [raw[i].centre[0], raw[i].centre[1]]);

  let assignment = new Int32Array(members.length).fill(-1);
  for (let iter = 0; iter < 24; iter++) {
    let changed = false;
    for (let m = 0; m < members.length; m++) {
      const c = raw[members[m]].centre;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < centroids.length; i++) {
        const d = (centroids[i][0] - c[0]) ** 2 + (centroids[i][1] - c[1]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (assignment[m] !== best) { assignment[m] = best; changed = true; }
    }
    if (!changed && iter > 0) break;

    const sums = centroids.map(() => [0, 0, 0]);
    for (let m = 0; m < members.length; m++) {
      const c = raw[members[m]].centre;
      const s = sums[assignment[m]];
      s[0] += c[0]; s[1] += c[1]; s[2]++;
    }
    for (let i = 0; i < centroids.length; i++) {
      if (sums[i][2] === 0) continue;
      centroids[i] = [sums[i][0] / sums[i][2], sums[i][1] / sums[i][2]];
    }
  }

  const groups: number[][] = centroids.map(() => []);
  for (let m = 0; m < members.length; m++) groups[assignment[m]].push(members[m]);
  return groups.filter((g) => g.length > 0);
}

/**
 * Splits each nation's population, industry and resources across its states,
 * weighted by where the people actually are.
 */
function distributeNationalAssets(
  provinces: ProvinceGeoJson[], states: StateGeoJson[], raw: RawProvince[],
): void {
  const byTag = new Map<string, number[]>();
  states.forEach((s, i) => {
    const list = byTag.get(s.ownerTag);
    if (list) list.push(i);
    else byTag.set(s.ownerTag, [i]);
  });

  for (const [tag, stateIds] of byTag) {
    const nation = NATION_BY_TAG.get(tag);
    if (!nation) continue;

    // Industry and population follow cities, not acreage. Weighting by area
    // would hand French North Africa more factories than metropolitan France,
    // because the Sahara is enormous and empty.
    const weights = stateIds.map((sid) => {
      let pop = 0;
      let area = 0;
      let colonial = false;
      for (const pid of states[sid].provinces) {
        pop += raw[pid].seed.pop;
        area += provinces[pid].area;
        if (raw[pid].seed.lat < 37) colonial = true;
      }
      const base = 0.12 + pop / 250 + area / 900_000;
      // Overseas holdings were raw-material suppliers, not industrial cores.
      return colonial ? base * 0.22 : base;
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;

    const share = (total: number, i: number) => (total * weights[i]) / totalWeight;

    // Integer assets are handed out largest-remainder so the totals match the
    // nation table exactly rather than drifting with rounding.
    const civ = largestRemainder(nation.civilianFactories, weights);
    const mil = largestRemainder(nation.militaryFactories, weights);
    const dockWeights = stateIds.map((sid, i) =>
      states[sid].provinces.some((pid) => provinces[pid].coastal) ? weights[i] : 0);
    const anyCoastal = dockWeights.some((w) => w > 0);
    const dock = largestRemainder(nation.dockyards, anyCoastal ? dockWeights : weights);

    stateIds.forEach((sid, i) => {
      const st = states[sid];
      st.manpower = Math.max(20, Math.round(share(nation.population * 1000, i)));
      st.civilianFactories = civ[i];
      st.militaryFactories = mil[i];
      st.dockyards = dock[i];
      for (const [r, v] of Object.entries(nation.resources) as [keyof typeof nation.resources, number][]) {
        const amount = Math.round(share(v, i));
        if (amount > 0) st.resources[r] = amount;
      }
      // A state with a big city has better roads and rail.
      let biggestCity = 0;
      for (const pid of st.provinces) biggestCity = Math.max(biggestCity, raw[pid].seed.pop);
      st.infrastructure = Math.max(1, Math.min(5,
        nation.infrastructure - 1 + (biggestCity > 400 ? 2 : biggestCity > 120 ? 1 : 0)));
      st.buildingSlots = Math.max(
        4,
        st.civilianFactories + st.militaryFactories + 3,
        Math.min(24, Math.round(st.manpower / 900)),
      );
    });
  }
}

/** Distributes an integer total across weights without losing or gaining any. */
function largestRemainder(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const floor = exact.map((v) => Math.floor(v));
  let remaining = total - floor.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    floor[i]++;
    remaining--;
  }
  return floor;
}

/**
 * Land adjacency by proximity.
 *
 * Voronoi cells clipped against the same outline share exact edges, and Natural
 * Earth's neighbouring countries share exact boundary vertices, so a small
 * tolerance catches every genuine border and nothing else. Doing it
 * geometrically also means the two sources of geometry -- clipped cells and
 * original coastlines -- are treated identically.
 */
const ADJACENCY_TOLERANCE = 3;

function computeGeometricAdjacency(provinces: ProvinceGeoJson[]): void {
  const rings = provinces.map((p) => p.rings.map(unflatten));
  const boxes = provinces.map((_p, i) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rings[i]) {
      for (const [x, y] of r) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return [minX, minY, maxX, maxY] as const;
  });

  // Bucket by grid cell so the pair test is local rather than quadratic.
  const CELL = 260;
  const buckets = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 100003 + cy;
  provinces.forEach((_p, i) => {
    const [minX, minY, maxX, maxY] = boxes[i];
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
        const k = key(cx, cy);
        const b = buckets.get(k);
        if (b) b.push(i);
        else buckets.set(k, [i]);
      }
    }
  });

  const sets = provinces.map(() => new Set<number>());
  const tested = new Set<number>();
  for (const bucket of buckets.values()) {
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const i = bucket[a];
        const j = bucket[b];
        const pairKey = i < j ? i * 100003 + j : j * 100003 + i;
        if (tested.has(pairKey)) continue;
        tested.add(pairKey);

        const [aMinX, aMinY, aMaxX, aMaxY] = boxes[i];
        const [bMinX, bMinY, bMaxX, bMaxY] = boxes[j];
        if (aMinX - bMaxX > ADJACENCY_TOLERANCE || bMinX - aMaxX > ADJACENCY_TOLERANCE) continue;
        if (aMinY - bMaxY > ADJACENCY_TOLERANCE || bMinY - aMaxY > ADJACENCY_TOLERANCE) continue;

        if (ringsTouch(rings[i], rings[j], ADJACENCY_TOLERANCE)) {
          sets[i].add(j);
          sets[j].add(i);
        }
      }
    }
  }

  provinces.forEach((p, i) => {
    p.neighbors = [...sets[i]].sort((x, y) => x - y);
  });
}

function ringsTouch(a: Ring[], b: Ring[], tolerance: number): boolean {
  const t2 = tolerance * tolerance;
  for (const ra of a) {
    for (const rb of b) {
      for (const p of ra) {
        for (const q of rb) {
          const dx = p[0] - q[0];
          const dy = p[1] - q[1];
          if (dx * dx + dy * dy <= t2) return true;
        }
      }
    }
  }
  return false;
}

function unflatten(flat: number[]): Ring {
  const out: Ring = new Array(flat.length / 2);
  for (let i = 0; i < flat.length; i += 2) out[i / 2] = [flat[i], flat[i + 1]];
  return out;
}
