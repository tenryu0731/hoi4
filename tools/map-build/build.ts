import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { type Bbox, type Pt, type Ring, clipRing } from './geo';
import { adminUnits1936, type AdminFeature } from './states';
import { CITY_NAMES_1936 } from './historical';
import { MEMBER_TO_TAG, NATIONS, NATION_BY_TAG } from '../../src/sim/scenario/nations';
import {
  type BuildCity,
  QUANTUM, RENDER_SCALE, buildFromReference, haversineKm, referenceProjector,
} from './provinces';
import type { CityJson, MapDataJson, ProvinceGeoJson } from '../../src/sim/map/MapData';
import { MAP_FORMAT_VERSION } from '../../src/sim/map/MapData';

/**
 * Bakes `public/data/map.json`.
 *
 * Two sources, with a clean line between them. The *shape* of the world -- the
 * coastline, every province, every state -- is traced out of the Hearts of Iron
 * IV reference export by `provinces.ts`. Natural Earth supplies only facts:
 * which country held which ground in 1936, where the towns were and how big
 * they were, and which rivers are worth drawing. 「Natural Earth の海岸線じゃ
 * なくて画像の線を使え」.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CACHE = join(ROOT, 'tools', '.cache');
const OUT = join(ROOT, 'public', 'data', 'map.json');

const NE_BASE =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

const LAYERS = [
  // The world's real administrative units: who held what, in 1936 hands.
  'ne_10m_admin_1_states_provinces',
  'ne_10m_populated_places',
  'ne_50m_rivers_lake_centerlines',
] as const;

/** Europe plus the Mediterranean rim and the western Soviet Union. */
const BBOX: Bbox = { minLon: -26, maxLon: 54, minLat: 25, maxLat: 74 };

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
        await new Promise((r) => { setTimeout(r, 2000 * 2 ** attempt); });
      }
    }
    if (lastErr) throw lastErr;
    process.stdout.write('ok\n');
  }
  return JSON.parse(await readFile(file, 'utf8')) as GeoCollection;
}

function linesOf(f: GeoFeature): number[][][] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  return [];
}

const toRing = (coords: number[][]): Ring => coords.map((c) => [c[0], c[1]] as Pt);

// ---------------------------------------------------------------------------
// Main build
// ---------------------------------------------------------------------------

export async function buildMap(): Promise<MapDataJson> {
  console.log('reference export + Natural Earth -> map.json');
  const [adm1, places, rivers] = await Promise.all(LAYERS.map((l) => ensureLayer(l)));

  // --- 1. Who held the ground ----------------------------------------------
  const units = adminUnits1936(adm1.features as unknown as AdminFeature[], {
    world: BBOX,
    tagOf: (code) => MEMBER_TO_TAG.get(code),
  });
  console.log(`  ${units.length} admin units in 1936 hands`);
  const missing = NATIONS.filter((n) => !units.some((u) => u.tag === n.tag));
  if (missing.length) console.warn(`  note: no geometry for ${missing.map((n) => n.tag).join(', ')}`);

  // --- 2. Towns -------------------------------------------------------------
  const cities: BuildCity[] = [];
  for (const f of places.features) {
    const g = f.geometry;
    if (!g || g.type !== 'Point') continue;
    const [lon, lat] = g.coordinates as number[];
    if (lon < BBOX.minLon || lon > BBOX.maxLon || lat < BBOX.minLat || lat > BBOX.maxLat) continue;
    const code = String(f.properties.ADM0_A3 ?? '');
    const tag = MEMBER_TO_TAG.get(code);
    if (!tag) continue;
    const popMax = Number(f.properties.POP_MAX ?? 0);
    const modern = String(f.properties.NAME ?? '');
    const name = CITY_NAMES_1936[`${modern}|${code}`] ?? modern;
    const nation = NATION_BY_TAG.get(tag)!;
    // Modern populations are far larger than 1936 ones; scale them back so the
    // victory-point spread resembles the period rather than today.
    cities.push({
      name, lon, lat, x: 0, y: 0, col: 0, row: 0, tag, pop: Math.round((popMax / 1000) * 0.38),
      province: -1, capitalOf: name === nation.capital ? tag : null, vp: 0,
    });
  }
  // Guarantee every nation has exactly one capital city entry.
  for (const nation of NATIONS) {
    const found = cities.filter((c) => c.capitalOf === nation.tag);
    if (found.length === 0) {
      cities.push({
        name: nation.capital, lon: nation.capitalLonLat[0], lat: nation.capitalLonLat[1],
        x: 0, y: 0, col: 0, row: 0, tag: nation.tag, pop: 400, province: -1, capitalOf: nation.tag, vp: 0,
      });
    } else if (found.length > 1) {
      found.slice(1).forEach((c) => { c.capitalOf = null; });
    }
  }

  // --- 3. The map itself ----------------------------------------------------
  const built = buildFromReference({ admin: units, cities });
  const { provinces, states } = built;

  for (const c of cities) {
    c.x = Math.round(c.col * QUANTUM);
    c.y = Math.round(c.row * QUANTUM);
  }
  const project = referenceProjector();

  // --- 4. Victory points ----------------------------------------------------
  for (const c of cities) {
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

  connectIsolatedComponents(provinces);

  // --- 5. Rivers ------------------------------------------------------------
  const riverLines: number[][] = [];
  for (const f of rivers.features) {
    const rank = Number(f.properties.scalerank ?? 10);
    if (rank > 6) continue;
    for (const line of linesOf(f)) {
      const clipped = clipRing(toRing(line), BBOX);
      if (clipped.length < 2) continue;
      const flat: number[] = [];
      for (const [lon, lat] of clipped) {
        const [col, row] = project.toLattice(lon, lat);
        flat.push(Math.round(col * QUANTUM), Math.round(row * QUANTUM));
      }
      riverLines.push(flat);
    }
  }

  // --- 6. Bounds ------------------------------------------------------------
  // The arcs are delta-encoded, so this has to walk them rather than read them.
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const arc of built.arcs) {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < arc.length; i += 2) {
      cx += arc[i];
      cy += arc[i + 1];
      const x = cx * RENDER_SCALE;
      const y = cy * RENDER_SCALE;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  return {
    version: MAP_FORMAT_VERSION,
    projection: built.projection,
    bounds: [
      Math.round(minX * 10) / 10, Math.round(minY * 10) / 10,
      Math.round(maxX * 10) / 10, Math.round(maxY * 10) / 10,
    ],
    arcs: built.arcs,
    provinces,
    states,
    land: built.land,
    rivers: riverLines,
    borders: built.borders,
    cities: cities
      .filter((c) => c.province >= 0)
      .map((c) => {
        const out: CityJson = {
          name: c.name, x: c.x, y: c.y, pop: c.pop,
          province: c.province, capitalOf: c.capitalOf, vp: c.vp,
        };
        // `capitalOf: null` on thirteen hundred towns is thirty kilobytes of
        // the word "null"; readers already treat the field as optional.
        if (out.capitalOf === null) delete (out as { capitalOf?: string | null }).capitalOf;
        return out;
      }),
  };
}

/**
 * Guarantees a single connected province graph.
 *
 * Iceland has no neighbour within strait range, and an unreachable province can
 * never change hands, which would leave a scenario undecidable. Measured on the
 * sphere, because the render frame stretches east-west with latitude and this
 * runs where that stretch is largest.
 */
function connectIsolatedComponents(provinces: ProvinceGeoJson[]): void {
  const proj = referenceProjector();
  const place = (p: ProvinceGeoJson): [number, number] =>
    proj.toLonLat(p.center[0] / QUANTUM, p.center[1] / QUANTUM);
  const comp = new Int32Array(provinces.length).fill(-1);
  let n = 0;
  for (let i = 0; i < provinces.length; i++) {
    if (comp[i] >= 0) continue;
    const id = n++;
    const stack = [i];
    comp[i] = id;
    while (stack.length) {
      const cur = stack.pop() as number;
      for (const nb of [...provinces[cur].neighbors, ...provinces[cur].seaNeighbors]) {
        if (comp[nb] < 0) { comp[nb] = id; stack.push(nb); }
      }
    }
  }
  if (n <= 1) return;

  const sizes = new Array<number>(n).fill(0);
  for (let i = 0; i < provinces.length; i++) sizes[comp[i]]++;
  let main = 0;
  for (let i = 1; i < n; i++) if (sizes[i] > sizes[main]) main = i;

  for (let c = 0; c < n; c++) {
    if (c === main) continue;
    let bestA = -1; let bestB = -1; let bestD = Infinity;
    for (let i = 0; i < provinces.length; i++) {
      if (comp[i] !== c) continue;
      for (let j = 0; j < provinces.length; j++) {
        if (comp[j] !== main) continue;
        const d = haversineKm(...place(provinces[i]), ...place(provinces[j]));
        if (d < bestD) { bestD = d; bestA = i; bestB = j; }
      }
    }
    if (bestA >= 0) {
      const a = provinces[bestA];
      const b = provinces[bestB];
      a.seaNeighbors = [...new Set([...a.seaNeighbors, bestB])].sort((x, y) => x - y);
      b.seaNeighbors = [...new Set([...b.seaNeighbors, bestA])].sort((x, y) => x - y);
      console.log(`  linked isolated ${a.name} -> ${b.name} (${bestD.toFixed(0)} km)`);
      for (let i = 0; i < provinces.length; i++) if (comp[i] === c) comp[i] = main;
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const data = await buildMap();
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data));
  const size = (await stat(OUT)).size;
  console.log(
    `  wrote ${OUT}\n`
    + `  ${data.provinces.length} provinces, ${data.states.length} states, `
    + `${data.cities.length} cities, ${data.arcs.length} arcs, `
    + `${(size / 1024).toFixed(0)} KB`,
  );
}

if (process.argv[1] && process.argv[1].endsWith('build.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
