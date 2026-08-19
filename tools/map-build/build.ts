import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  type Bbox, type Pt, type Ring,
  LandMask, bboxOfRing, clipRing, closestApproach, distToSegment,
  poleOfInaccessibility, projectLcc, ringArea,
  type LccParams,
} from './geo';
import { assembleRing, buildTopology, simplifyArc, type ArcRef } from './topology';
import { MEMBER_TO_TAG, NATIONS, NATION_BY_TAG } from '../../src/sim/scenario/nations';
import { subdivideProvinces } from './provinces';
import type {
  CityJson, MapDataJson, ProvinceGeoJson, StateGeoJson,
} from '../../src/sim/map/MapData';
import { MAP_FORMAT_VERSION } from '../../src/sim/map/MapData';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CACHE = join(ROOT, 'tools', '.cache');
const OUT = join(ROOT, 'public', 'data', 'map.json');

const NE_BASE =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

const LAYERS = [
  'ne_50m_admin_0_countries',
  'ne_50m_land',
  'ne_50m_lakes',
  'ne_50m_rivers_lake_centerlines',
  'ne_50m_populated_places',
] as const;

/** Europe plus the Mediterranean rim and the western Soviet Union. */
const BBOX: Bbox = { minLon: -26, maxLon: 52, minLat: 27.5, maxLat: 72 };

const PROJ: LccParams = {
  lon0: 15, lat0: 50, lat1: 40, lat2: 62,
  // Earth radius in km, so one world unit is one kilometre.
  scale: 6371,
  offsetX: 0, offsetY: 0,
};

/** Visvalingam area threshold in square kilometres. */
const SIMPLIFY_AREA = 12;
/** Drop islands smaller than this (square kilometres) unless allow-listed. */
const MIN_ISLAND_AREA = 260;
const ISLAND_ALLOWLIST = new Set(['MLT', 'ISL', 'CYP', 'ALD', 'FRO', 'IMN', 'JEY', 'GGY']);
/** Two coasts closer than this (km) are treated as a crossable strait. */
const STRAIT_KM = 115;

interface GeoFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] }
    | { type: 'LineString'; coordinates: number[][] }
    | { type: 'MultiLineString'; coordinates: number[][][] }
    | { type: 'Point'; coordinates: number[] }
    | null;
}

interface GeoCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

async function ensureLayer(name: string): Promise<GeoCollection> {
  const file = join(CACHE, `${name}.geojson`);
  const exists = await stat(file).then(() => true).catch(() => false);
  if (!exists) {
    await mkdir(CACHE, { recursive: true });
    const url = `${NE_BASE}/${name}.geojson`;
    process.stdout.write(`  downloading ${name} ... `);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
    if (lastErr) throw lastErr;
    process.stdout.write('ok\n');
  }
  return JSON.parse(await readFile(file, 'utf8')) as GeoCollection;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function polygonsOf(f: GeoFeature): number[][][][] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

function linesOf(f: GeoFeature): number[][][] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  return [];
}

const toRing = (coords: number[][]): Ring => coords.map((c) => [c[0], c[1]] as Pt);

function project(ring: Ring): Ring {
  return ring.map((p) => projectLcc(p[0], p[1], PROJ));
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

/** Clips a lon/lat ring to the map window and projects it. Empty when outside. */
function prepareRing(coords: number[][]): Ring | null {
  const clipped = clipRing(toRing(coords), BBOX);
  if (clipped.length < 3) return null;
  return project(clipped);
}

// ---------------------------------------------------------------------------
// Main build
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** When true, split each nation into several provinces (iteration 2). */
  subdivide: boolean;
  /** Approximate number of states to aim for when subdividing. */
  stateTarget: number;
}

export async function buildMap(opts: BuildOptions): Promise<MapDataJson> {
  console.log('Natural Earth -> map.json');
  const [countries, land, lakes, rivers, places] = await Promise.all(
    LAYERS.map((l) => ensureLayer(l)),
  );

  // --- 1. Collect the polygons of every playable nation --------------------
  // Regions are keyed by Natural Earth admin-0 code, not by 1936 tag, so that
  // topology can tell an internal border (Bohemia/Slovakia) from a coastline.
  const memberRings = new Map<string, Ring[]>();
  for (const f of countries.features) {
    const code = String(f.properties.ADM0_A3 ?? '');
    const tag = MEMBER_TO_TAG.get(code);
    if (!tag) continue;
    const rings: Ring[] = [];
    for (const poly of polygonsOf(f)) {
      for (let r = 0; r < poly.length; r++) {
        const ring = prepareRing(poly[r]);
        if (!ring) continue;
        const area = ringArea(ring);
        // Holes (r > 0) are kept regardless of size; tiny outer islands are not.
        if (r === 0 && area < MIN_ISLAND_AREA && !ISLAND_ALLOWLIST.has(code)) continue;
        rings.push(ring);
      }
    }
    if (rings.length === 0) continue;
    const prev = memberRings.get(code);
    if (prev) prev.push(...rings);
    else memberRings.set(code, rings);
  }

  const missing = NATIONS.flatMap((n) => n.members).filter((m) => !memberRings.has(m));
  if (missing.length) console.warn(`  note: no geometry for ${missing.join(', ')}`);

  // --- 2. Topology: shared arcs, simplified once ---------------------------
  const topoInput = [...memberRings].map(([key, rings]) => ({ key, rings }));
  const topo = buildTopology(topoInput);
  console.log(`  ${topoInput.length} admin units -> ${topo.arcs.length} arcs`);

  const simplified = topo.arcs.map((a) => simplifyArc(a, SIMPLIFY_AREA, 2));
  const beforePts = topo.arcs.reduce((s, a) => s + a.length, 0);
  const afterPts = simplified.reduce((s, a) => s + a.length, 0);
  console.log(`  simplified ${beforePts} -> ${afterPts} points`);

  // --- 3. Rebuild each admin unit's rings from simplified arcs -------------
  interface Unit {
    code: string;
    tag: string;
    rings: Ring[];
    ringRefs: ArcRef[][];
  }
  const units: Unit[] = [];
  for (const [code, ringRefs] of topo.regions) {
    const rings: Ring[] = [];
    const keptRefs: ArcRef[][] = [];
    for (const refs of ringRefs) {
      const ring = assembleRing(refs, simplified);
      if (ring.length < 3) continue;
      rings.push(ring);
      keptRefs.push(refs);
    }
    if (rings.length === 0) continue;
    units.push({ code, tag: MEMBER_TO_TAG.get(code)!, rings, ringRefs: keptRefs });
  }
  units.sort((a, b) => a.code.localeCompare(b.code));

  // --- 4. Cities ------------------------------------------------------------
  const cities: CityJson[] = [];
  for (const f of places.features) {
    const g = f.geometry;
    if (!g || g.type !== 'Point') continue;
    const [lon, lat] = g.coordinates as number[];
    if (lon < BBOX.minLon || lon > BBOX.maxLon || lat < BBOX.minLat || lat > BBOX.maxLat) continue;
    const code = String(f.properties.ADM0_A3 ?? '');
    const tag = MEMBER_TO_TAG.get(code);
    if (!tag) continue;
    const popMax = Number(f.properties.POP_MAX ?? 0);
    const name = String(f.properties.NAME ?? '');
    const [x, y] = projectLcc(lon, lat, PROJ);
    const nation = NATION_BY_TAG.get(tag)!;
    const isCapital = name === nation.capital;
    // Modern populations are far larger than 1936 ones; scale them back so the
    // victory-point spread resembles the period rather than today.
    const pop1936 = Math.round((popMax / 1000) * 0.38);
    cities.push({
      name, x, y, pop: pop1936, province: -1,
      capitalOf: isCapital ? tag : null,
      vp: 0,
    });
  }
  // Guarantee every nation has exactly one capital city entry.
  for (const nation of NATIONS) {
    const found = cities.filter((c) => c.capitalOf === nation.tag);
    if (found.length === 0) {
      const [x, y] = projectLcc(nation.capitalLonLat[0], nation.capitalLonLat[1], PROJ);
      cities.push({ name: nation.capital, x, y, pop: 400, province: -1, capitalOf: nation.tag, vp: 0 });
    } else if (found.length > 1) {
      found.slice(1).forEach((c) => { c.capitalOf = null; });
    }
  }

  // --- 5. Provinces ---------------------------------------------------------
  const built = opts.subdivide
    ? subdivideProvinces({ units, cities, target: opts.stateTarget, projection: PROJ })
    : oneProvincePerNation(units);

  const provinces: ProvinceGeoJson[] = built.provinces;
  const states: StateGeoJson[] = built.states;

  // --- 6. Assign cities to provinces and derive victory points -------------
  assignCities(cities, provinces);
  for (const c of cities) {
    // VP roughly tracks 1936 population, with a floor for capitals so that every
    // nation has at least one objective worth taking.
    let vp = 0;
    if (c.pop >= 1500) vp = 20;
    else if (c.pop >= 700) vp = 12;
    else if (c.pop >= 300) vp = 8;
    else if (c.pop >= 120) vp = 5;
    else if (c.pop >= 40) vp = 3;
    else vp = 1;
    if (c.capitalOf) vp = Math.max(vp, 25);
    c.vp = vp;
    if (c.province >= 0) provinces[c.province].vp += vp;
  }
  // Every province is worth taking, so the front always has a direction.
  for (const p of provinces) if (p.vp === 0) p.vp = 1;

  // --- 7. Background land silhouette (also the oracle for strait testing) ---
  const landRings: number[][] = [];
  const landGeom: Ring[] = [];
  for (const f of land.features) {
    for (const poly of polygonsOf(f)) {
      for (let r = 0; r < poly.length; r++) {
        const ring = prepareRing(poly[r]);
        if (!ring) continue;
        if (r === 0 && ringArea(ring) < MIN_ISLAND_AREA * 0.5) continue;
        const simple = simplifyRing(ring, SIMPLIFY_AREA * 1.5);
        landGeom.push(simple);
        landRings.push(flatten(simple));
      }
    }
  }

  // --- 8. Sea adjacency -----------------------------------------------------
  markCoastal(provinces, landGeom);
  addSeaNeighbors(provinces, landGeom);
  connectIsolatedComponents(provinces);
  const lakeRings: number[][] = [];
  for (const f of lakes.features) {
    for (const poly of polygonsOf(f)) {
      const ring = prepareRing(poly[0]);
      if (!ring || ringArea(ring) < 400) continue;
      lakeRings.push(flatten(simplifyRing(ring, SIMPLIFY_AREA)));
    }
  }
  const riverLines: number[][] = [];
  for (const f of rivers.features) {
    const rank = Number(f.properties.scalerank ?? 10);
    if (rank > 6) continue;
    for (const line of linesOf(f)) {
      const clipped = clipRing(toRing(line), BBOX);
      if (clipped.length < 2) continue;
      riverLines.push(flatten(simplifyRing(project(clipped), SIMPLIFY_AREA)));
    }
  }

  // --- 9. Borders for rendering --------------------------------------------
  const borders = classifyBorders(units, simplified, topo.arcOwners, built.provinceOfUnit);

  // --- 10. Bounds -----------------------------------------------------------
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of provinces) {
    for (const ring of p.rings) {
      for (let i = 0; i < ring.length; i += 2) {
        if (ring[i] < minX) minX = ring[i];
        if (ring[i] > maxX) maxX = ring[i];
        if (ring[i + 1] < minY) minY = ring[i + 1];
        if (ring[i + 1] > maxY) maxY = ring[i + 1];
      }
    }
  }

  const data: MapDataJson = {
    version: MAP_FORMAT_VERSION,
    projection: { name: 'lcc', ...PROJ },
    bounds: [
      Math.round(minX * 10) / 10, Math.round(minY * 10) / 10,
      Math.round(maxX * 10) / 10, Math.round(maxY * 10) / 10,
    ],
    provinces,
    states,
    land: landRings,
    lakes: lakeRings,
    rivers: riverLines,
    cities: cities
      .filter((c) => c.province >= 0)
      .map((c) => ({ ...c, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10 })),
    borders,
  };

  return data;
}

// ---------------------------------------------------------------------------
// Iteration 1: one province per nation
// ---------------------------------------------------------------------------

export interface BuiltProvinces {
  provinces: ProvinceGeoJson[];
  states: StateGeoJson[];
  /** Admin-unit code to province id, used to classify border arcs. */
  provinceOfUnit: Map<string, number>;
}

interface UnitLike { code: string; tag: string; rings: Ring[]; ringRefs: ArcRef[][] }

function oneProvincePerNation(units: UnitLike[]): BuiltProvinces {
  const tags = NATIONS.map((n) => n.tag).filter((t) => units.some((u) => u.tag === t));
  const provinces: ProvinceGeoJson[] = [];
  const states: StateGeoJson[] = [];
  const provinceOfUnit = new Map<string, number>();

  tags.forEach((tag, id) => {
    const nation = NATION_BY_TAG.get(tag)!;
    const mine = units.filter((u) => u.tag === tag);
    for (const u of mine) provinceOfUnit.set(u.code, id);

    const rings: Ring[] = [];
    for (const u of mine) rings.push(...u.rings);
    // Largest ring first so the renderer and the label picker both see the
    // mainland before the islands.
    rings.sort((a, b) => ringArea(b) - ringArea(a));
    // A ring nested inside an odd number of others is a hole (enclaves such as
    // San Marino, or the Caspian shoreline cut out of the Soviet Union).
    const ringDepth = rings.map((r, i) => {
      let depth = 0;
      for (let j = 0; j < rings.length; j++) {
        if (j === i) continue;
        if (ringArea(rings[j]) > ringArea(r) && pointInRingFast(r[0][0], r[0][1], rings[j])) depth++;
      }
      return depth % 2;
    });

    // Anchor the label on the ring that holds the capital, not the largest one.
    // The United Kingdom's largest 1936 landmass is Egypt, and France's is
    // Algeria, so "largest ring" would caption both nations in North Africa.
    const [capX, capY] = projectLcc(nation.capitalLonLat[0], nation.capitalLonLat[1], PROJ);
    const homeRing = rings.find((r) => pointInRingFast(capX, capY, r)) ?? rings[0];
    const center = poleOfInaccessibility([homeRing], 2);
    const area = rings.reduce((s, r) => s + ringArea(r), 0);

    provinces.push({
      id, name: nation.name, stateId: id, ownerTag: tag,
      terrain: nation.terrain, vp: 0, coastal: true,
      rings: rings.map((r) => flatten(r)),
      ringDepth,
      center: [Math.round(center[0] * 10) / 10, Math.round(center[1] * 10) / 10],
      area: Math.round(area),
      neighbors: [], seaNeighbors: [],
    });

    const manpower = Math.round(nation.population * 1000);
    states.push({
      id, name: nation.name, ownerTag: tag, provinces: [id],
      manpower,
      resources: nation.resources,
      infrastructure: nation.infrastructure,
      civilianFactories: nation.civilianFactories,
      militaryFactories: nation.militaryFactories,
      dockyards: nation.dockyards,
      buildingSlots: buildingSlotsFor(
        manpower, nation.civilianFactories + nation.militaryFactories,
      ),
    });
  });

  // Land adjacency: two provinces touch when their admin units share an arc.
  // Recomputed here from raw rings so it stays correct after simplification.
  computeLandAdjacency(units, provinceOfUnit, provinces);
  return { provinces, states, provinceOfUnit };
}

/**
 * Factory slots a state offers. Population sets the ceiling, but a state never
 * starts over-built: the floor is whatever industry it already has plus room to
 * grow, so a scenario is never in an illegal position on day one.
 */
export function buildingSlotsFor(manpower: number, existing: number): number {
  const byPopulation = Math.round(manpower / 1200);
  return Math.max(8, existing + 8, Math.min(64, byPopulation));
}

/** Marks provinces adjacent when their source units share at least one arc. */
export function computeLandAdjacency(
  units: UnitLike[],
  provinceOfUnit: Map<string, number>,
  provinces: ProvinceGeoJson[],
): void {
  const arcUsers = new Map<number, Set<number>>();
  for (const u of units) {
    const pid = provinceOfUnit.get(u.code);
    if (pid === undefined) continue;
    for (const refs of u.ringRefs) {
      for (const ref of refs) {
        let s = arcUsers.get(ref.arc);
        if (!s) { s = new Set(); arcUsers.set(ref.arc, s); }
        s.add(pid);
      }
    }
  }
  const sets = provinces.map(() => new Set<number>());
  for (const users of arcUsers.values()) {
    if (users.size < 2) continue;
    const list = [...users];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        sets[list[i]].add(list[j]);
        sets[list[j]].add(list[i]);
      }
    }
  }
  provinces.forEach((p, i) => {
    p.neighbors = [...sets[i]].sort((a, b) => a - b);
  });
}

// ---------------------------------------------------------------------------
// Shared post-processing
// ---------------------------------------------------------------------------

function simplifyRing(ring: Ring, threshold: number): Ring {
  const closed = [...ring, ring[0]];
  const s = simplifyArc(closed, threshold, 4);
  s.pop();
  return s.length >= 3 ? s : ring;
}

function assignCities(cities: CityJson[], provinces: ProvinceGeoJson[]): void {
  const polys = provinces.map((p) => {
    const rings = p.rings.map(unflatten);
    return {
      id: p.id,
      rings,
      depth: p.ringDepth,
      bbox: rings.map((r) => bboxOfRing(r)),
    };
  });

  for (const c of cities) {
    let found = -1;
    for (const poly of polys) {
      // Odd-even over the province's own rings, so a city inside an enclave
      // hole (Vatican inside Rome) is not credited to the surrounding province.
      let winding = 0;
      for (let i = 0; i < poly.rings.length; i++) {
        const [minX, minY, maxX, maxY] = poly.bbox[i];
        if (c.x < minX || c.x > maxX || c.y < minY || c.y > maxY) continue;
        if (pointInRingFast(c.x, c.y, poly.rings[i])) winding++;
      }
      if (winding % 2 === 1) { found = poly.id; break; }
    }
    if (found < 0) {
      // Coastal cities routinely fall just outside the simplified outline, so
      // fall back to the nearest province boundary rather than the nearest
      // centre -- a centre-based match hands Lisbon to Spain.
      let best = Infinity;
      for (const poly of polys) {
        for (let i = 0; i < poly.rings.length; i++) {
          const [minX, minY, maxX, maxY] = poly.bbox[i];
          const dx = Math.max(minX - c.x, 0, c.x - maxX);
          const dy = Math.max(minY - c.y, 0, c.y - maxY);
          if (Math.hypot(dx, dy) > best) continue;
          const ring = poly.rings[i];
          for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
            const d = distToSegment(c.x, c.y, ring[j][0], ring[j][1], ring[k][0], ring[k][1]);
            if (d < best) { best = d; found = poly.id; }
          }
        }
      }
      // Further than this from any coast means the city is outside the playable
      // map (Anatolian interior, the Sahara) and is dropped.
      if (best > 90) found = -1;
    }
    c.province = found;
  }
}

function unflatten(flat: number[]): Ring {
  const out: Ring = new Array(flat.length / 2);
  for (let i = 0; i < flat.length; i += 2) out[i / 2] = [flat[i], flat[i + 1]];
  return out;
}

function pointInRingFast(x: number, y: number, ring: Ring): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Links provinces separated by a short sea crossing. Without this the British
 * Isles, Sicily and Scandinavia are unreachable and no scenario can conclude.
 *
 * A short gap is not enough on its own: Germany and Italy come within 60km of
 * each other through the Tyrol, and Poland within 50km of Hungary through
 * Slovakia. So the segment joining the two closest points is sampled against
 * the land silhouette and rejected if it crosses dry ground.
 */
function addSeaNeighbors(provinces: ProvinceGeoJson[], landGeom: Ring[]): void {
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

  let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
  for (const [a, b, c, d] of boxes) {
    if (a < gMinX) gMinX = a;
    if (b < gMinY) gMinY = b;
    if (c > gMaxX) gMaxX = c;
    if (d > gMaxY) gMaxY = d;
  }
  const mask = LandMask.build(landGeom, [gMinX - 200, gMinY - 200, gMaxX + 200, gMaxY + 200], 3);

  /** True when the straight line between two coasts stays over water. */
  const overWater = (pa: Pt, pb: Pt, dist: number): boolean => {
    if (dist <= 25) return true;   // a genuine narrow strait, e.g. the Oresund
    const samples = 24;
    let landHits = 0;
    let checked = 0;
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      // Ignore the outermost samples: they sit on the shoreline by construction.
      if (t < 0.15 || t > 0.85) continue;
      checked++;
      if (mask.isLand(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t)) landHits++;
    }
    return checked === 0 || landHits / checked < 0.2;
  };

  const sets = provinces.map(() => new Set<number>());
  for (let a = 0; a < provinces.length; a++) {
    for (let b = a + 1; b < provinces.length; b++) {
      if (provinces[a].neighbors.includes(b)) continue;
      const [aminX, aminY, amaxX, amaxY] = boxes[a];
      const [bminX, bminY, bmaxX, bmaxY] = boxes[b];
      const dx = Math.max(0, Math.max(aminX - bmaxX, bminX - amaxX));
      const dy = Math.max(0, Math.max(aminY - bmaxY, bminY - amaxY));
      if (Math.hypot(dx, dy) > STRAIT_KM) continue;

      let best = Infinity;
      let bestPa: Pt = [0, 0];
      let bestPb: Pt = [0, 0];
      for (const ra of rings[a]) {
        for (const rb of rings[b]) {
          const r = closestApproach(ra, rb);
          if (r.dist < best) { best = r.dist; bestPa = r.pa; bestPb = r.pb; }
        }
      }
      if (best <= STRAIT_KM && overWater(bestPa, bestPb, best)) {
        sets[a].add(b);
        sets[b].add(a);
      }
    }
  }
  provinces.forEach((p, i) => {
    p.seaNeighbors = [...sets[i]].sort((x, y) => x - y);
  });
}

/**
 * Guarantees a single connected province graph. Iceland has no neighbour within
 * strait range, and an unreachable province can never change hands, which would
 * leave a scenario undecidable.
 */
function connectIsolatedComponents(provinces: ProvinceGeoJson[]): void {
  const comp = new Int32Array(provinces.length).fill(-1);
  let n = 0;
  for (let i = 0; i < provinces.length; i++) {
    if (comp[i] >= 0) continue;
    const id = n++;
    const stack = [i];
    comp[i] = id;
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nb of [...provinces[cur].neighbors, ...provinces[cur].seaNeighbors]) {
        if (comp[nb] < 0) { comp[nb] = id; stack.push(nb); }
      }
    }
  }
  if (n <= 1) return;

  const sizes = new Array(n).fill(0);
  for (let i = 0; i < provinces.length; i++) sizes[comp[i]]++;
  let main = 0;
  for (let i = 1; i < n; i++) if (sizes[i] > sizes[main]) main = i;

  for (let c = 0; c < n; c++) {
    if (c === main) continue;
    let bestA = -1, bestB = -1, bestD = Infinity;
    for (let i = 0; i < provinces.length; i++) {
      if (comp[i] !== c) continue;
      for (let j = 0; j < provinces.length; j++) {
        if (comp[j] !== main) continue;
        const d = Math.hypot(
          provinces[i].center[0] - provinces[j].center[0],
          provinces[i].center[1] - provinces[j].center[1],
        );
        if (d < bestD) { bestD = d; bestA = i; bestB = j; }
      }
    }
    if (bestA >= 0) {
      provinces[bestA].seaNeighbors = [...new Set([...provinces[bestA].seaNeighbors, bestB])].sort((x, y) => x - y);
      provinces[bestB].seaNeighbors = [...new Set([...provinces[bestB].seaNeighbors, bestA])].sort((x, y) => x - y);
      console.log(`  linked isolated ${provinces[bestA].name} -> ${provinces[bestB].name} (${bestD.toFixed(0)} km)`);
      for (let i = 0; i < provinces.length; i++) if (comp[i] === c) comp[i] = main;
    }
  }
}

/**
 * Flags provinces that touch open water.
 *
 * A province is coastal when part of its outline is not shared with any
 * neighbour -- that edge can only face the sea. Dockyards and naval invasions
 * both need this, and it is far cheaper than testing against the ocean.
 */
function markCoastal(provinces: ProvinceGeoJson[], landGeom: Ring[]): void {
  const landBoxes = landGeom.map((r) => bboxOfRing(r));
  for (const p of provinces) {
    let coastal = false;
    outer: for (const flat of p.rings) {
      for (let i = 0; i < flat.length; i += 2) {
        const x = flat[i];
        const y = flat[i + 1];
        // A vertex within a whisker of the land silhouette is on the coastline.
        for (let k = 0; k < landGeom.length && !coastal; k++) {
          const [minX, minY, maxX, maxY] = landBoxes[k];
          if (x < minX - 4 || x > maxX + 4 || y < minY - 4 || y > maxY + 4) continue;
          const ring = landGeom[k];
          for (const q of ring) {
            if (Math.abs(q[0] - x) <= 4 && Math.abs(q[1] - y) <= 4) {
              coastal = true;
              break;
            }
          }
        }
        if (coastal) break outer;
      }
    }
    p.coastal = coastal;
  }
}

function classifyBorders(
  units: UnitLike[],
  arcs: Pt[][],
  arcOwners: Map<number, Set<string>>,
  provinceOfUnit: Map<string, number>,
): MapDataJson['borders'] {
  const tagOf = new Map<string, string>(units.map((u) => [u.code, u.tag]));
  const country: number[][] = [];
  const province: number[][] = [];
  const coast: number[][] = [];

  for (const [arcIdx, owners] of arcOwners) {
    const pts = arcs[arcIdx];
    if (!pts || pts.length < 2) continue;
    const codes = [...owners].filter((c) => tagOf.has(c));
    if (codes.length === 0) continue;
    const tags = new Set(codes.map((c) => tagOf.get(c)!));
    const pids = new Set(codes.map((c) => provinceOfUnit.get(c)).filter((v) => v !== undefined));
    const flat = flatten(pts);
    if (codes.length === 1) coast.push(flat);
    else if (tags.size > 1) country.push(flat);
    else if (pids.size > 1) province.push(flat);
    // Same tag and same province: an internal seam, not drawn.
  }
  return { country, province, coast };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const subdivide = process.argv.includes('--subdivide');
  const targetArg = process.argv.find((a) => a.startsWith('--states='));
  const stateTarget = targetArg ? Number(targetArg.split('=')[1]) : 56;

  const data = await buildMap({ subdivide, stateTarget });
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data));
  const size = (await stat(OUT)).size;
  console.log(
    `  wrote ${OUT}\n` +
    `  ${data.provinces.length} provinces, ${data.states.length} states, ` +
    `${data.cities.length} cities, ${(size / 1024).toFixed(0)} KB`,
  );
}

if (process.argv[1] && process.argv[1].endsWith('build.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
