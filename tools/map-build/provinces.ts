import { Delaunay } from 'd3-delaunay';
import polygonClipping from 'polygon-clipping';

import {
  type LccParams, type Pt, type Ring,
  bboxOfRing, poleOfInaccessibility, pointInRing, ringArea,
} from './geo';
import type { CityJson, ProvinceGeoJson, StateGeoJson } from '../../src/sim/map/MapData';
import type { TerrainType } from '../../src/sim/core/types';
import { NATION_BY_TAG, NATIONS } from '../../src/sim/scenario/nations';
import type { StateGroup } from './states';
import { CARVE_1936, STATE_BUDGET_1936, type Carve } from './historical';
import { referenceKmPerProvince, referenceStateAt } from './reference';
import type { BuiltProvinces } from './build';

/**
 * Provinces: the cells a state is cut into.
 *
 * States come from the world's real administrative map (see `states.ts`), and
 * every province is carved out of exactly one of them, so the two tiers nest
 * the way Hearts of Iron's do -- a state is a named region you can see, and
 * the provinces inside it are where divisions actually stand.
 *
 * The cells themselves are Voronoi, seeded from real cities and clipped to the
 * state's own outline. Seeding from cities rather than a regular lattice means
 * the cells follow where people actually lived: dense in the Ruhr and the Po
 * valley, coarse across the steppe, which is exactly the granularity the
 * gameplay wants.
 */

export interface SubdivideInput {
  /** The 1936 states, already merged out of real administrative units. */
  states: StateGroup[];
  cities: CityJson[];
  projection: LccParams;
}

/** Square kilometres of a European state per province, before clamping. */
const AREA_PER_PROVINCE = 2_600;
/**
 * The same for colonial and desert holdings. Sparsely held ground does not
 * deserve the same granularity as the Ruhr, and without this France ends up
 * with more provinces in the Sahara than in France.
 */
const COLONIAL_AREA_PER_PROVINCE = 15_000;
/**
 * Even the smallest state is cut in two. A single-province state has no
 * interior, so a front can never run through it and the fighting happens
 * entirely on its borders.
 */
const MIN_PROVINCES_PER_STATE = 2;
/**
 * And no administrative block is cut into more than a dozen. Open a state in
 * the real game and it lists a handful of provinces however much ground it
 * covers -- Norrland is enormous and still reads as a page, not a country.
 * The cutting happens before the cells are regrouped into states, so a state
 * that ends up spanning several blocks can hold more; what this stops is one
 * block of desert turning into a state's worth of cells on its own.
 */
const MAX_PROVINCES_PER_STATE = 12;
/**
 * What fraction of the cells asked for actually survive to the map -- rounding
 * down, the sliver floor and the per-state ceiling each shave one here and
 * there. Measured against the reference and corrected for, which brings every
 * region of Europe inside a few percent of the count the real game uses.
 */
const REFERENCE_YIELD = 0.93;
/**
 * The smallest patch of unclaimed ground worth handing back. Below this it is
 * a rasterising artefact along a coast, not a hole anyone can see.
 */
const MIN_LEFTOVER_AREA = 40;
/**
 * The smallest ring worth drawing beyond a province's own body -- an outlying
 * islet, or a hole around one. Below this it is grit from a boolean op.
 */
const MIN_FRAGMENT_AREA = 8;
/**
 * How much of a town's own share of a state one province covers. Below one
 * because a province is a town plus its hinterland and the hinterland between
 * two towns has to go somewhere; measured to leave settled Europe untouched
 * while pulling Norrland and the Sahara back to the size the real game uses.
 */
const SETTLEMENT_REACH = 0.55;
/** Cells smaller than this are merged away rather than shipped as slivers. */
const MIN_PROVINCE_AREA = 260;

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

/**
 * The point furthest from any edge -- but of the polygon, not of its outline.
 *
 * A cell clipped out of a state that wraps an enclave comes back with holes in
 * it, and a pole of inaccessibility computed from the outer ring alone happily
 * lands in the middle of one. Udine, Saint Gallen and East Skopje all did, and
 * a province whose own centre is not inside it cannot be tapped.
 */
function centreOf(rings: Ring[], precision = 3): Pt {
  const sorted = [...rings].sort((a, b) => ringArea(b) - ringArea(a));
  const outer = sorted[0];
  const holes = sorted.slice(1).filter((r) => ringInsideRing(r, outer));
  return poleOfInaccessibility([outer, ...holes], precision);
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
  // Two cities closer together than a cell is wide would produce a sliver
  // between them, so the spacing follows the cell size rather than a constant.
  const spacing = Math.sqrt(AREA_PER_PROVINCE) * 0.55;
  const sorted = [...cities].sort((a, b) => b.pop - a.pop);
  for (const c of sorted) {
    if (seeds.length >= count) break;
    // Two cities in the same valley would produce a sliver between them.
    if (seeds.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < spacing)) continue;
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
  /** Filled in by `nameProvinces`. */
  name: string;
  /** The state this cell was carved out of, used when naming it. */
  stateName: string;
  /** Set when history gives this ground a name of its own. */
  carved?: string;
}

/**
 * Is `inner` nested inside `outer`? Sampled across the whole ring rather than
 * tested at its first vertex: where a state was cut out of a larger admin unit
 * (the Karelian isthmus, Venezia Giulia) the two lobes meet along the cut, so
 * a lone vertex sitting on that shared edge can decide a whole lobe is a hole
 * and erase it. A majority of vertices and edge midpoints cannot be fooled by
 * a boundary they only touch.
 */
function ringInsideRing(inner: Ring, outer: Ring): boolean {
  const step = Math.max(1, Math.floor(inner.length / 24));
  let inside = 0;
  let tested = 0;
  for (let k = 0; k < inner.length; k += step) {
    const a = inner[k];
    const b = inner[(k + 1) % inner.length];
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const [x, y] of [a, mid]) {
      tested++;
      if (pointInRing(x, y, outer)) inside++;
    }
  }
  return tested > 0 && inside * 2 > tested;
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
      if (!ringInsideRing(rings[i], rings[j])) continue;
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

/** polygon-clipping's nested output, flattened back to the rings we carry. */
function ringsOf(result: MultiRing[]): Ring[] {
  const out: Ring[] = [];
  for (const poly of result) {
    for (const ring of poly) {
      const r: Ring = ring.map((q) => [q[0], q[1]] as Pt);
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
}

/**
 * Grids, in kilometres, to snap a boolean op's input to when it refuses the
 * geometry as it stands. polygon-clipping is exact in principle and fragile in
 * practice: a ring that all but touches itself makes it abandon an output ring
 * and throw. Snapping turns "all but touches" into "touches", which it handles
 * -- and a metre of slack on a province border is invisible, where a missing
 * province is the beige hole players report.
 */
const SNAP_GRIDS = [0, 1e-3, 1e-2, 0.1] as const;

function snapMulti(polys: MultiRing[], grid: number): MultiRing[] {
  if (grid <= 0) return polys;
  return polys.map((poly) => poly.map((ring) => {
    const out: number[][] = [];
    for (const q of ring) {
      const p = [Math.round(q[0] / grid) * grid, Math.round(q[1] / grid) * grid];
      const last = out[out.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      out.push(p);
    }
    return out;
  }));
}

function clipCellToUnit(cell: Pt[], unit: MultiRing[]): Ring[] {
  if (cell.length < 3) return [];
  const cellPoly: MultiRing[] = [[cell.map((q) => [q[0], q[1]])]];
  for (const grid of SNAP_GRIDS) {
    try {
      return ringsOf(polygonClipping.intersection(
        snapMulti(cellPoly, grid) as never, snapMulti(unit, grid) as never,
      ) as MultiRing[]);
    } catch {
      // Too tight for this grid; try a coarser one.
    }
  }
  // Every grid refused it. `reclaimLeftover` gives the ground back, so a cell
  // lost here costs a border, never a hole.
  return [];
}

/** Net area of one polygon-clipping polygon: its outer ring less its holes. */
function polyArea(poly: number[][][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const ring = poly[i].map((q) => [q[0], q[1]] as Pt);
    a += i === 0 ? ringArea(ring) : -ringArea(ring);
  }
  return a;
}

/**
 * Ground inside a state that no province claimed, handed to the nearest one.
 *
 * A Voronoi cell can go missing for reasons that have nothing to do with
 * geography -- two seeds landing on the same point, a boolean op refusing a
 * ring that touches itself, a lobe misread as a hole -- and the result is
 * always the same: a gap in the state that renders as unowned land, which is
 * exactly the artefact players report. Rather than chase each cause, the state
 * is asked at the end what nobody took, and the remainder is merged into the
 * province next to it. Whatever goes wrong upstream, the map stays whole.
 */
function reclaimLeftover(unit: MultiRing[], members: RawProvince[]): void {
  if (members.length === 0) return;
  const claimed = members.map((p) => toMultiPolygon(p.rings));
  let leftover: MultiRing[] = [];
  for (const grid of SNAP_GRIDS) {
    try {
      leftover = polygonClipping.difference(
        snapMulti(unit, grid) as never,
        ...(claimed.map((c) => snapMulti(c, grid)) as never[]),
      ) as MultiRing[];
      break;
    } catch {
      // Too tight for this grid; try a coarser one.
    }
  }
  for (const poly of leftover) {
    if (polyArea(poly) < MIN_LEFTOVER_AREA) continue;
    const rings = ringsOf([poly]);
    if (rings.length === 0) continue;
    const at = centreOf(rings);
    let host = members[0];
    let best = Infinity;
    for (const p of members) {
      const d = Math.hypot(p.centre[0] - at[0], p.centre[1] - at[1]);
      if (d < best) { best = d; host = p; }
    }
    let merged: Ring[];
    try {
      merged = ringsOf(polygonClipping.union(
        toMultiPolygon(host.rings) as never, [poly] as never,
      ) as MultiRing[]);
    } catch {
      merged = [...host.rings, ...rings];
    }
    if (merged.length === 0) continue;
    merged.sort((a, b) => ringArea(b) - ringArea(a));
    host.rings = merged;
    host.area = toMultiPolygon(merged).reduce((sum, q) => sum + polyArea(q), 0);
    host.centre = centreOf(merged);
  }
}



export function subdivideProvinces(input: SubdivideInput): BuiltProvinces {
  const { states: groups, cities, projection } = input;

  // --- 1. Voronoi cells inside each state ----------------------------------
  const raw: RawProvince[] = [];
  /** Province indices belonging to each state, in build order. */
  const membersOfState: number[][] = groups.map(() => []);

  groups.forEach((group, stateIdx) => {
    const area = group.area;
    const centre = centreOf(group.rings, 8);
    const [centreLon, centreLat] = unprojectLcc(centre[0], centre[1], projection);

    const unitMulti = toMultiPolygon(group.rings);
    // Seed only on landmasses big enough to hold a province. Otherwise
    // farthest-point sampling puts seeds on the outermost skerry -- the point
    // furthest from everything else -- and its clipped cell is then discarded
    // as a sliver, leaving the mainland as a single province.
    const seedRings = group.rings.filter((r) => ringArea(r) >= MIN_PROVINCE_AREA * 3);
    const usable = seedRings.length > 0 ? seedRings : group.rings;
    const mine = cities.filter((c) => pointInRings(c.x, c.y, usable));

    // How finely the real game cuts this part of the world, where it says.
    // Measured against it, an area rule alone came out at 0.81 of the
    // reference overall and much further off in places -- 0.59 in Scandinavia,
    // 0.70 in Germany and Poland, 1.13 in the Balkans.
    // Asking for exactly the reference's number lands about a tenth short:
    // rounding down, the sliver floor, and the ceiling per state all shave a
    // cell here and there. The shortfall is measured, so it is corrected for.
    const said = (referenceKmPerProvince(centreLon, centreLat)
      ?? (centreLat < 37 ? COLONIAL_AREA_PER_PROVINCE : AREA_PER_PROVINCE)) * REFERENCE_YIELD;
    // Empty ground gets coarser cells than the reference asks for.
    //
    // The density grid is read off a screenshot, and a screenshot of Lapland is
    // mostly snow: the segmentation found about as many borders per square
    // degree there as in Poland, which is false -- the real game cuts Norrland
    // into a dozen provinces and Poland into sixty. Left alone it gave northern
    // Sweden seventy provinces in one state and Iceland forty-two, which is
    // 「プロヴィンスがおかしい」 whatever the reference says.
    //
    // Towns are the honest signal, and the one the reference itself follows
    // wherever it reads correctly: a province is roughly a town and its
    // hinterland. So the cell can be no smaller than the ground a town has to
    // itself here. In settled country that floor is far below what the
    // reference says and changes nothing; in the Sahara and above the Arctic
    // circle it is what decides.
    const perTown = area / Math.max(1, mine.length);
    const density = Math.max(said, perTown * SETTLEMENT_REACH);
    const byDensity = Math.min(
      MAX_PROVINCES_PER_STATE,
      Math.max(MIN_PROVINCES_PER_STATE, Math.round(area / density)),
    );
    // Never ask for more provinces than the territory can hold: splitting Malta
    // in two produces two slivers, both of which are then discarded, and the
    // island disappears from the map.
    const byArea = Math.max(1, Math.floor(area / MIN_PROVINCE_AREA));
    const wanted = Math.min(byDensity, byArea);

    const seeds = makeSeeds(usable, mine, wanted, projection);
    const push = (p: RawProvince): void => {
      membersOfState[stateIdx].push(raw.length);
      raw.push(p);
    };

    if (seeds.length <= 1) {
      const [lon, lat] = unprojectLcc(centre[0], centre[1], projection);
      const seed = seeds[0] ?? { x: centre[0], y: centre[1], lon, lat, pop: 0, cityName: null };
      push({
        tag: group.tag,
        seed,
        rings: group.rings,
        area,
        centre,
        terrain: classifyTerrain(seed.lon, seed.lat, seed.pop),
        name: '',
        stateName: group.name,
      });
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of group.rings) {
      const [a, b, c, d] = bboxOfRing(r);
      minX = Math.min(minX, a); minY = Math.min(minY, b);
      maxX = Math.max(maxX, c); maxY = Math.max(maxY, d);
    }
    const pad = 50;
    // Nearly collinear seeds -- which is exactly what a long coastal state
    // produces -- degenerate the triangulation and make d3-delaunay return null
    // cells. A sub-kilometre deterministic offset breaks the collinearity
    // without moving anything visible.
    const delaunay = Delaunay.from(seeds.map((s, i) => [
      s.x + (((i * 37) % 7) - 3) * 0.35,
      s.y + (((i * 53) % 5) - 2) * 0.35,
    ] as [number, number]));
    const voronoi = delaunay.voronoi([minX - pad, minY - pad, maxX + pad, maxY + pad]);

    for (let i = 0; i < seeds.length; i++) {
      const poly = voronoi.cellPolygon(i);
      if (!poly) continue;
      const rings = clipCellToUnit(poly.map((q: number[]) => [q[0], q[1]] as Pt), unitMulti);
      if (rings.length === 0) continue;
      const cellArea = rings.reduce((s, r) => s + ringArea(r), 0);
      if (cellArea < MIN_PROVINCE_AREA) continue;
      rings.sort((a, b) => ringArea(b) - ringArea(a));
      push({
        tag: group.tag,
        seed: seeds[i],
        rings,
        area: cellArea,
        centre: centreOf(rings),
        terrain: classifyTerrain(seeds[i].lon, seeds[i].lat, seeds[i].pop),
        name: '',
        stateName: group.name,
      });
    }

    // A state whose every cell came out a sliver would vanish; keep it whole.
    if (membersOfState[stateIdx].length === 0) {
      const [lon, lat] = unprojectLcc(centre[0], centre[1], projection);
      push({
        tag: group.tag,
        seed: { x: centre[0], y: centre[1], lon, lat, pop: 0, cityName: null },
        rings: group.rings,
        area,
        centre,
        terrain: classifyTerrain(lon, lat, 0),
        name: '',
        stateName: group.name,
      });
    }

    const members = membersOfState[stateIdx].map((i) => raw[i]);
    reclaimLeftover(unitMulti, members);
    // Every square kilometre of a state has to end up inside one of its
    // provinces -- ground no cell claims renders as unowned land. Counting
    // cells cannot see that: Leningrad's state produced 20 of its 36 and still
    // lost its entire western lobe, because a geometry fault had classified
    // that lobe as a hole. Area is what the player sees, so area is the guard.
    const held = members.reduce((sum, p) => sum + p.area, 0);
    if (held < area * 0.98) {
      console.warn(`  note: ${group.name} (${group.tag}) covered ` +
        `${Math.round(held)} of ${Math.round(area)} km2 in ` +
        `${members.length} provinces`);
    }
  });

  // --- 2. Name the provinces that have no city of their own ----------------
  nameProvinces(raw, cities);

  // --- 3. Group the cells into states, following the reference -------------
  const blockOf = new Int32Array(raw.length).fill(-1);
  membersOfState.forEach((list, b) => { for (const i of list) blockOf[i] = b; });
  const touching = adjacencyOf(raw);
  const stateGroups = carveHistoricalStates(
    applyStateBudget(regroupByReference(raw, blockOf, touching, projection), raw, touching),
    raw, touching, projection,
  );

  const stateOfProvince = new Int32Array(raw.length).fill(-1);
  // Two states can land on the same principal town -- one Pomerania either
  // side of the Oder, one Pskov either side of the lake -- and two identically
  // captioned regions next to each other read as one.
  const takenNames = new Map<string, number>();
  const states: StateGeoJson[] = stateGroups.map((members, id) => {
    for (const idx of members) stateOfProvince[idx] = id;
    const tag = raw[members[0]].tag;
    const nation = NATION_BY_TAG.get(tag);
    return {
      id,
      name: uniqueStateName(stateNameFor(raw, members), raw, members, takenNames),
      ownerTag: tag,
      provinces: [],           // filled once province ids are final
      manpower: 0,
      resources: {},
      infrastructure: nation?.infrastructure ?? 3,
      civilianFactories: 0,
      militaryFactories: 0,
      dockyards: 0,
      buildingSlots: 0,
    };
  });

  const provinces: ProvinceGeoJson[] = raw.map((p, id) => {
    // Everything but the province's own body has to earn its place. A boolean
    // op that clips a cell along the seam it already touches leaves grit --
    // rings of a square kilometre and less -- and grit on the map reads as a
    // grain of rice sitting in the sea. The largest ring is always kept, so a
    // province this small in the first place (Gibraltar, four square
    // kilometres) still survives whole.
    const rings = p.rings.filter((r, i) => i === 0 || ringArea(r) >= MIN_FRAGMENT_AREA);
    const ringDepth = rings.map((r, i) => {
      let depth = 0;
      for (let j = 0; j < rings.length; j++) {
        if (i === j) continue;
        if (ringArea(rings[j]) > ringArea(r) && ringInsideRing(r, rings[j])) depth++;
      }
      return depth % 2;
    });
    return {
      id,
      name: p.name,
      stateId: Math.max(0, stateOfProvince[id]),
      ownerTag: p.tag,
      terrain: p.terrain,
      vp: 0,
      coastal: false,
      rings: rings.map((r) => flatten(r)),
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

  weldProvinceRings(provinces);

  // --- 4. Distribute national assets across states -------------------------
  distributeNationalAssets(provinces, states, raw);

  // --- 5. Adjacency --------------------------------------------------------
  computeGeometricAdjacency(provinces);

  return { provinces, states };
}


// ---------------------------------------------------------------------------
// Grouping cells into states
// ---------------------------------------------------------------------------

/** How many points inside a cell are put to the reference before it decides. */
const REFERENCE_SAMPLES = 9;
/** A state below this many square kilometres is folded into a neighbour. */
const MIN_STATE_KM = 2_400;

/**
 * Which of the reference's states a cell belongs to.
 *
 * Put to a vote rather than read off the centre: the georeference is good to a
 * couple of pixels and a pixel is eleven kilometres, so a cell whose centre
 * happens to land on a border line would otherwise be handed to whichever side
 * the rounding fell on. Nine points spread over the cell make that a tie-break
 * instead of a coin toss.
 */
function referenceStateOf(p: RawProvince, proj: LccParams): number {
  const votes = new Map<number, number>();
  const outer = p.rings[0];
  const put = (x: number, y: number): void => {
    const [lon, lat] = unprojectLcc(x, y, proj);
    const cell = referenceStateAt(lon, lat);
    if (cell > 0) votes.set(cell, (votes.get(cell) ?? 0) + 1);
  };
  put(p.centre[0], p.centre[1]);
  const step = Math.max(1, Math.floor(outer.length / (REFERENCE_SAMPLES - 1)));
  for (let i = 0; i < outer.length; i += step) {
    // Pulled well inside, so a vertex on the coast does not vote for the sea.
    put(p.centre[0] + (outer[i][0] - p.centre[0]) * 0.55,
        p.centre[1] + (outer[i][1] - p.centre[1]) * 0.55);
  }
  let best = 0;
  let bestN = 0;
  for (const [cell, n] of votes) if (n > bestN || (n === bestN && cell < best)) { best = cell; bestN = n; }
  return best;
}

/**
 * Folds a country's states together until it has no more than its budget.
 *
 * The smallest goes first, into whichever same-nation state it shares the most
 * province border with -- so what disappears is the runt, and where it goes is
 * the neighbour it already looks like part of. A state with no same-nation
 * land neighbour at all -- Malta, Gibraltar, the Canaries -- is set aside
 * rather than flung across water, and sits outside the budget, which is what
 * `STATE_BUDGET_1936` says its numbers mean.
 */
function applyStateBudget(
  groups: number[][], raw: RawProvince[], touching: number[][],
): number[][] {
  const stateOf = new Int32Array(raw.length).fill(-1);
  groups.forEach((members, i) => { for (const m of members) stateOf[m] = i; });
  const live = groups.map((m) => [...m]);
  const areaOf = live.map((m) => m.reduce((s, i) => s + raw[i].area, 0));
  const tagOf = live.map((m) => (m.length > 0 ? raw[m[0]].tag : ''));

  const byTag = new Map<string, number[]>();
  live.forEach((m, i) => {
    if (m.length === 0) return;
    const list = byTag.get(tagOf[i]);
    if (list) list.push(i);
    else byTag.set(tagOf[i], [i]);
  });

  for (const [tag, indices] of byTag) {
    const budget = STATE_BUDGET_1936[tag];
    if (budget === undefined) continue;
    let mine = indices.filter((i) => live[i].length > 0);
    const stranded = new Set<number>();
    while (mine.length - stranded.size > budget) {
      let runt = -1;
      for (const i of mine) {
        if (stranded.has(i)) continue;
        if (runt < 0 || areaOf[i] < areaOf[runt]) runt = i;
      }
      if (runt < 0) break;
      // Shared border, counted in province pairs: the longest seam wins, so a
      // sliver joins the state it is already part of the shape of.
      const seam = new Map<number, number>();
      for (const m of live[runt]) {
        for (const nb of touching[m]) {
          const s = stateOf[nb];
          if (s < 0 || s === runt || live[s].length === 0) continue;
          if (raw[nb].tag !== tag) continue;
          seam.set(s, (seam.get(s) ?? 0) + 1);
        }
      }
      let host = -1;
      let best = 0;
      for (const [s, n] of seam) if (n > best || (n === best && s < host)) { best = n; host = s; }
      if (host < 0) { stranded.add(runt); continue; }
      for (const m of live[runt]) { live[host].push(m); stateOf[m] = host; }
      areaOf[host] += areaOf[runt];
      live[runt] = [];
      mine = mine.filter((i) => i !== runt);
    }
    if (mine.length - stranded.size > budget) {
      console.warn(`  note: ${tag} stayed at ${mine.length} states, budget ${budget}`);
    }
  }

  return live.filter((m) => m.length > 0);
}

/**
 * States, as the reference groups them.
 *
 * A state is a set of provinces, so following the reference is a matter of
 * asking each cell which of its states it stands in and collecting the answers
 * -- the borders that come out are our own province edges, not eleven-kilometre
 * pixel staircases traced off a screenshot.
 *
 * Three repairs after the vote, in order: a group split between two owners is
 * split with it, because a state cannot be half German; a group that is not
 * joined up is broken into its pieces, because a state with a detached half is
 * not a state; and anything left too small to be worth a name is folded into
 * the neighbour it shares the most border with.
 */
function regroupByReference(
  raw: RawProvince[], blockOf: Int32Array, touching: number[][], proj: LccParams,
): number[][] {
  const key = new Array<string>(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const cell = referenceStateOf(raw[i], proj);
    // Off the edge of the reference -- the Atlantic islands, the deep Sahara,
    // the ground east of it -- the administrative blocks stand in.
    key[i] = cell > 0 ? `r${cell}|${raw[i].tag}` : `b${blockOf[i]}|${raw[i].tag}`;
  }

  const buckets = new Map<string, number[]>();
  for (let i = 0; i < raw.length; i++) {
    const list = buckets.get(key[i]);
    if (list) list.push(i);
    else buckets.set(key[i], [i]);
  }

  const out: number[][] = [];
  for (const members of buckets.values()) {
    const set = new Set(members);
    const seen = new Set<number>();
    for (const seed of members) {
      if (seen.has(seed)) continue;
      const comp: number[] = [];
      const stack = [seed];
      seen.add(seed);
      while (stack.length > 0) {
        const cur = stack.pop()!;
        comp.push(cur);
        for (const nb of touching[cur]) {
          if (set.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
        }
      }
      out.push(comp);
    }
  }

  // Fold the runts into whichever neighbouring state they touch most.
  const stateOf = new Int32Array(raw.length).fill(-1);
  out.forEach((members, i) => { for (const m of members) stateOf[m] = i; });
  const areaOfState = out.map((m) => m.reduce((s, i) => s + raw[i].area, 0));
  const order = out.map((_, i) => i).sort((a, b) => areaOfState[a] - areaOfState[b]);
  const dead = new Set<number>();
  for (const i of order) {
    if (dead.has(i) || areaOfState[i] >= MIN_STATE_KM) continue;
    const tally = new Map<number, number>();
    for (const m of out[i]) {
      for (const nb of touching[m]) {
        const s = stateOf[nb];
        if (s < 0 || s === i || dead.has(s)) continue;
        if (raw[nb].tag !== raw[m].tag) continue;
        tally.set(s, (tally.get(s) ?? 0) + 1);
      }
    }
    let host = -1;
    let bestN = 0;
    for (const [s, n] of tally) if (n > bestN) { host = s; bestN = n; }
    if (host < 0) continue;
    for (const m of out[i]) { out[host].push(m); stateOf[m] = host; }
    areaOfState[host] += areaOfState[i];
    out[i] = [];
    dead.add(i);
  }

  const kept = out.filter((m) => m.length > 0);
  // Nation first, then north to south, so ids move as little as possible when
  // the map is rebuilt.
  const tagOrder = new Map<string, number>(NATIONS.map((n, i) => [n.tag, i]));
  kept.sort((a, b) => {
    const ta = tagOrder.get(raw[a[0]].tag) ?? 999;
    const tb = tagOrder.get(raw[b[0]].tag) ?? 999;
    if (ta !== tb) return ta - tb;
    const ya = a.reduce((s, i) => s + raw[i].centre[1], 0) / a.length;
    const yb = b.reduce((s, i) => s + raw[i].centre[1], 0) / b.length;
    return ya - yb;
  });
  return kept;
}


/**
 * Takes the regions that history moves on their own out of the states they
 * would otherwise be buried in.
 *
 * The rim is grown a ring at a time from the frontier, nearest first, until it
 * has the area the region actually had. Growing rather than drawing keeps it on
 * real province edges and lets it follow the border round a corner, which a
 * box could not: the Sudetenland is a horseshoe.
 */
function carveHistoricalStates(
  groups: number[][], raw: RawProvince[], touching: number[][], proj: LccParams,
): number[][] {
  const stateOf = new Int32Array(raw.length).fill(-1);
  groups.forEach((members, i) => { for (const m of members) stateOf[m] = i; });
  const out = groups.map((m) => [...m]);

  for (const carve of CARVE_1936) {
    const taken = growRim(carve, raw, touching, proj);
    if (taken.length === 0) {
      console.warn(`  note: ${carve.name} found no frontier to grow from`);
      continue;
    }
    for (const id of taken) {
      const from = stateOf[id];
      if (from < 0) continue;
      out[from] = out[from].filter((m) => m !== id);
    }
    out.push(taken);
    const id = out.length - 1;
    for (const m of taken) stateOf[m] = id;
    for (const m of taken) { raw[m].stateName = carve.name; raw[m].carved = carve.name; }
    const area = taken.reduce((s, m) => s + raw[m].area, 0);
    console.log(`  carved ${carve.name}: ${taken.length} cells, ${Math.round(area)} km2`);
  }
  return out.filter((m) => m.length > 0);
}

/** The provinces of one carve, grown inward from its frontier. */
function growRim(
  carve: Carve, raw: RawProvince[], touching: number[][], proj: LccParams,
): number[] {
  const eligible = (i: number): boolean => {
    if (raw[i].tag !== carve.from) return false;
    const [lon, lat] = unprojectLcc(raw[i].centre[0], raw[i].centre[1], proj);
    const w = carve.window;
    return lon >= w.minLon && lon <= w.maxLon && lat >= w.minLat && lat <= w.maxLat;
  };

  // Ring zero: our own ground that looks across the frontier.
  let ring: number[] = [];
  const chosen = new Set<number>();
  for (let i = 0; i < raw.length; i++) {
    if (!eligible(i)) continue;
    if (!touching[i].some((nb) => carve.frontierWith.includes(raw[nb].tag))) continue;
    ring.push(i);
  }
  // Nearest the frontier first, and by id after that so a rebuild takes the
  // same ground twice.
  ring.sort((a, b) => a - b);

  // The first ring is taken whole, whatever it costs. It is the whole point:
  // a rim that stops half way along the frontier does not separate the
  // interior from it, and the cession would still find Prague on the German
  // border and take that instead.
  let area = 0;
  for (const i of ring) { chosen.add(i); area += raw[i].area; }

  while (area < carve.areaKm) {
    const next: number[] = [];
    for (const i of chosen) {
      for (const nb of touching[i]) if (!chosen.has(nb) && eligible(nb)) next.push(nb);
    }
    if (next.length === 0) break;
    let grew = false;
    for (const i of [...new Set(next)].sort((a, b) => a - b)) {
      if (area >= carve.areaKm) break;
      chosen.add(i);
      area += raw[i].area;
      grew = true;
    }
    if (!grew) break;
  }
  return [...chosen].sort((a, b) => a - b);
}

/** Cell-to-cell adjacency, by shared ring geometry. */
function adjacencyOf(raw: RawProvince[]): number[][] {
  const out: number[][] = raw.map(() => []);
  const bboxes = raw.map((p) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const ring of p.rings) {
      const [x0, y0, x1, y1] = bboxOfRing(ring);
      a = Math.min(a, x0); b = Math.min(b, y0); c = Math.max(c, x1); d = Math.max(d, y1);
    }
    return [a, b, c, d] as const;
  });
  // Bucket by a coarse grid so this stays linear in the number of cells.
  const CELL = 120;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < raw.length; i++) {
    const [a, b, c, d] = bboxes[i];
    for (let gx = Math.floor(a / CELL); gx <= Math.floor(c / CELL); gx++) {
      for (let gy = Math.floor(b / CELL); gy <= Math.floor(d / CELL); gy++) {
        const k = `${gx},${gy}`;
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  }
  const seen = new Set<number>();
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        const pk = i < j ? i * 1e6 + j : j * 1e6 + i;
        if (seen.has(pk)) continue;
        seen.add(pk);
        const [ax0, ay0, ax1, ay1] = bboxes[i];
        const [bx0, by0, bx1, by1] = bboxes[j];
        if (ax1 < bx0 - ADJACENCY_TOLERANCE || bx1 < ax0 - ADJACENCY_TOLERANCE) continue;
        if (ay1 < by0 - ADJACENCY_TOLERANCE || by1 < ay0 - ADJACENCY_TOLERANCE) continue;
        if (!ringsTouch(raw[i].rings, raw[j].rings, ADJACENCY_TOLERANCE)) continue;
        out[i].push(j);
        out[j].push(i);
      }
    }
  }
  return out;
}

/**
 * Keeps two states from carrying the same caption, by pointing at where the
 * second one is: North Pomerania and South Pomerania rather than two of them.
 */
function uniqueStateName(
  base: string, raw: RawProvince[], members: readonly number[], taken: Map<string, number>,
): string {
  const n = taken.get(base) ?? 0;
  taken.set(base, n + 1);
  if (n === 0) return base;
  let x = 0;
  let y = 0;
  for (const m of members) { x += raw[m].centre[0]; y += raw[m].centre[1]; }
  const anchor = raw[members[0]].centre;
  const name = `${compass(x / members.length - anchor[0], y / members.length - anchor[1])} ${base}`;
  const again = taken.get(name) ?? 0;
  taken.set(name, again + 1);
  return again === 0 ? name : `${base} ${romanish(n)}`;
}

/** A state is called after the largest place inside it. */
function stateNameFor(raw: RawProvince[], members: readonly number[]): string {
  // Unless history has already named it. The Sudetenland is not called Ostrava
  // just because Ostrava is the biggest town on it.
  const given = raw[members[0]].carved;
  if (given) return given;
  let best = members[0];
  let bestPop = -1;
  for (const m of members) {
    const pop = raw[m].seed.pop;
    if (pop > bestPop) { bestPop = pop; best = m; }
  }
  if (bestPop > 0 && raw[best].seed.cityName) return raw[best].seed.cityName!;
  // Nothing but empty ground: fall back to the block the largest cell came from.
  let widest = members[0];
  for (const m of members) if (raw[m].area > raw[widest].area) widest = m;
  return raw[widest].stateName;
}

/**
 * Gives every province a place name.
 *
 * A province seeded on a city takes that city's name. The rest are named for
 * the nearest real town with a compass qualifier, because "Sweden 282" tells a
 * player nothing and breaks the illusion the map is working to create.
 */
function nameProvinces(raw: RawProvince[], cities: CityJson[]): void {
  const used = new Map<string, number>();
  const claim = (base: string): string => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base} ${romanish(n)}`;
  };

  // Cities first, so they get the unqualified name.
  for (const p of raw) {
    if (p.seed.cityName) p.name = claim(p.seed.cityName);
  }
  for (const p of raw) {
    if (p.name) continue;
    let best: CityJson | null = null;
    let bestD = Infinity;
    for (const c of cities) {
      const d = (c.x - p.centre[0]) ** 2 + (c.y - p.centre[1]) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best) {
      p.name = claim(NATION_BY_TAG.get(p.tag)?.name ?? p.tag);
      continue;
    }
    p.name = claim(`${compass(p.centre[0] - best.x, p.centre[1] - best.y)} ${best.name}`);
  }
}

function compass(dx: number, dy: number): string {
  // Screen y grows southward, matching the projection's flip.
  const angle = Math.atan2(-dy, dx);
  const octant = Math.round((angle * 4) / Math.PI);
  switch (((octant % 8) + 8) % 8) {
    case 0: return 'East';
    case 1: return 'North-east';
    case 2: return 'North';
    case 3: return 'North-west';
    case 4: return 'West';
    case 5: return 'South-west';
    case 6: return 'South';
    default: return 'South-east';
  }
}

function romanish(n: number): string {
  return ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n - 1] ?? String(n + 1);
}

/**
 * Coordinates go out at whole kilometres.
 *
 * A tenth of a kilometre is a hundred metres, and the map is six and a half
 * thousand kilometres across: at the closest zoom the player can reach that
 * hundred metres is under a fifth of a pixel, so every one of those decimal
 * places was two characters of a two-megabyte file spent on something nobody
 * can see. Dropping them took the baked map from 2.7 MB to 2.0.
 */
/**
 * How far a rounded vertex can end up from the straight edge it started on:
 * half the diagonal of the one-kilometre lattice, plus a hair.
 */
const WELD_TOLERANCE = 0.72;

/**
 * Welds the T-junctions that rounding opens between neighbouring provinces.
 *
 * Two cells that share an edge share its endpoints exactly, so rounding moves
 * both sides the same way and the seam holds. A T-junction does not: where two
 * provinces meet along a third's straight edge, the meeting point sits *on*
 * that edge beforehand and up to seven hundred metres off it afterwards,
 * opening a rice-grain of unowned ground between the three. Every edge is
 * therefore re-noded against the rounded vertices lying along it -- the bend is
 * where the three provinces actually meet, and the straight line is the lie.
 */
function weldProvinceRings(provinces: ProvinceGeoJson[]): void {
  const CELL = 8;
  const cellOf = (x: number, y: number): number =>
    Math.floor(y / CELL) * 100_000 + Math.floor(x / CELL);
  const index = new Map<number, number[]>();
  for (const p of provinces) {
    for (const r of p.rings) {
      for (let i = 0; i < r.length; i += 2) {
        const k = cellOf(r[i], r[i + 1]);
        let list = index.get(k);
        if (!list) { list = []; index.set(k, list); }
        let seen = false;
        for (let j = 0; j < list.length; j += 2) {
          if (list[j] === r[i] && list[j + 1] === r[i + 1]) { seen = true; break; }
        }
        if (!seen) list.push(r[i], r[i + 1]);
      }
    }
  }

  for (const p of provinces) {
    p.rings = p.rings.map((r) => {
      const n = r.length / 2;
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const ax = r[i * 2], ay = r[i * 2 + 1];
        const j = (i + 1) % n;
        const bx = r[j * 2], by = r[j * 2 + 1];
        out.push(ax, ay);
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) continue;
        const hits: [number, number, number][] = [];
        const x0 = Math.floor((Math.min(ax, bx) - 1) / CELL);
        const x1 = Math.floor((Math.max(ax, bx) + 1) / CELL);
        const y0 = Math.floor((Math.min(ay, by) - 1) / CELL);
        const y1 = Math.floor((Math.max(ay, by) + 1) / CELL);
        for (let cy = y0; cy <= y1; cy++) {
          for (let cx = x0; cx <= x1; cx++) {
            const list = index.get(cy * 100_000 + cx);
            if (!list) continue;
            for (let k = 0; k < list.length; k += 2) {
              const px = list[k], py = list[k + 1];
              if ((px === ax && py === ay) || (px === bx && py === by)) continue;
              const t = ((px - ax) * dx + (py - ay) * dy) / len2;
              if (t <= 1e-6 || t >= 1 - 1e-6) continue;
              const ex = ax + t * dx - px, ey = ay + t * dy - py;
              if (ex * ex + ey * ey > WELD_TOLERANCE * WELD_TOLERANCE) continue;
              hits.push([t, px, py]);
            }
          }
        }
        if (hits.length === 0) continue;
        hits.sort((u, v) => u[0] - v[0]);
        let lastX = ax, lastY = ay;
        for (const [, px, py] of hits) {
          if (px === lastX && py === lastY) continue;
          out.push(px, py);
          lastX = px; lastY = py;
        }
      }
      return out;
    });
  }
}

function flatten(ring: Ring, decimals = 0): number[] {
  const f = 10 ** decimals;
  const out = new Array<number>(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    out[i * 2] = Math.round(ring[i][0] * f) / f;
    out[i * 2 + 1] = Math.round(ring[i][1] * f) / f;
  }
  return out;
}


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
    // nation table exactly rather than drifting with rounding. Resources were
    // rounded one state at a time instead, which cost almost nothing while a
    // nation had eight states and a great deal once it had seventy: measured
    // on the administrative map, the Soviet Union's twelve tungsten arrived as
    // three, its twenty-four chromium as fourteen, and its sixty oil as
    // sixty-four, because every share under a half vanished and every share
    // over one rounded up.
    const civ = largestRemainder(nation.civilianFactories, weights);
    const mil = largestRemainder(nation.militaryFactories, weights);
    const dockWeights = stateIds.map((sid, i) =>
      states[sid].provinces.some((pid) => provinces[pid].coastal) ? weights[i] : 0);
    const anyCoastal = dockWeights.some((w) => w > 0);
    const dock = largestRemainder(nation.dockyards, anyCoastal ? dockWeights : weights);
    const mined = new Map<string, number[]>();
    for (const [r, v] of Object.entries(nation.resources) as [string, number][]) {
      mined.set(r, largestRemainder(v, weights));
    }

    stateIds.forEach((sid, i) => {
      const st = states[sid];
      st.manpower = Math.max(20, Math.round(share(nation.population * 1000, i)));
      st.civilianFactories = civ[i];
      st.militaryFactories = mil[i];
      st.dockyards = dock[i];
      for (const [r, spread] of mined) {
        const amount = spread[i];
        if (amount > 0) st.resources[r as keyof typeof st.resources] = amount;
      }
      // A state with a big city has better roads and rail.
      let biggestCity = 0;
      for (const pid of st.provinces) biggestCity = Math.max(biggestCity, raw[pid].seed.pop);
      st.infrastructure = Math.max(1, Math.min(5,
        nation.infrastructure - 1 + (biggestCity > 400 ? 2 : biggestCity > 120 ? 1 : 0)));
      // The ceiling is deliberately well above what any state's population
      // reaches on its own. It used to be 24, which bound only the dense
      // industrial states -- Germany's two states and Britain's five hit it
      // while the Soviet Union's eight, spread thin, never did. The result was
      // Germany starting with one free slot and Britain with none, so their
      // economic game was over before it began, while the USSR built freely.
      st.buildingSlots = Math.max(
        6,
        st.civilianFactories + st.militaryFactories + st.dockyards + 6,
        Math.min(40, Math.round(st.manpower / 900)),
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

