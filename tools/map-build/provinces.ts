import type {
  CityJson, MapProjection, ProvinceGeoJson, StateGeoJson,
} from '../../src/sim/map/MapData';
import type { ResourceType, TerrainType } from '../../src/sim/core/types';
import { NATION_BY_TAG, NATIONS } from '../../src/sim/scenario/nations';
import { CARVE_1936, CLAIMS_1936 } from './historical';
import type { Pt, Ring } from './geo';
import { chainRings, loadReference, ringPoints, traceGrid, WATER } from './raster';
import { simplifyArc } from './topology';
import type { AdminUnit } from './states';

/**
 * The map, traced out of the reference export.
 *
 * 「Natural Earth の海岸線じゃなくて画像の線を使え」. What used to be here grew
 * Voronoi cells from seeds and clipped them against Natural Earth's coastline,
 * and however well that was tuned it could only ever be a map that *resembled*
 * the one being copied -- measured at the end, 77.7% of its province borders
 * fell within two pixels of the reference's and 61.2% of its state borders did.
 * The lines now come from the reference itself, so those numbers are one by
 * construction, and about eleven hundred lines of seeding, clipping, welding
 * and leftover-reclaiming are gone with them.
 *
 * Natural Earth is still read. It answers questions of fact -- who held this
 * ground in 1936, where the towns are, which rivers are worth drawing -- and
 * no questions of shape.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * How much of a corner the simplifier may cut, in square source pixels.
 *
 * The raster's border is a staircase of 3.5km steps, and drawn as it is the
 * map reads as a QR code. Two square pixels removes every single-step jog and
 * leaves the shape: measured against the pixel counts, each province keeps its
 * area to within 1.0%.
 */
const SIMPLIFY_PX = 2;
/** Stored coordinates per source pixel, which is what one Chaikin pass needs. */
export const QUANTUM = 4;
/**
 * Render units per stored integer, set so one unit is a kilometre along the
 * 45th parallel. True there and nowhere else -- which is the whole reason
 * nothing measures distance in render units any more.
 */
export const RENDER_SCALE = (0.04537247209597017 * 111.320 * Math.SQRT1_2) / QUANTUM;

/**
 * How far a town may be from the export's coastline and still belong to it.
 *
 * Twelve pixels is about forty kilometres, which covers every harbour the
 * game's simplified coast puts out to sea and stops well short of carrying a
 * town across a strait.
 */
const CITY_SEARCH_PX = 12;
/** How far a strait may reach, in kilometres of open water. */
/**
 * How far a strait may reach, in kilometres of open water.
 *
 * Measured against this map rather than against the Earth, because this map is
 * the game's and the game's coastlines are drawn apart where it needs room for
 * sea provinces: the Dover Strait, thirty-four kilometres wide in life, is a
 * hundred and forty-four here. The threshold has to clear that, and at a
 * hundred and fifty it does while still leaving Sardinia to Tunisia (194km)
 * and Malta's latitude to Sicily's a voyage rather than a crossing.
 */
const STRAIT_KM = 150;

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

function classifyTerrain(lon: number, lat: number, cityPop: number): TerrainType {
  if (cityPop >= 900) return 'urban';
  for (const z of TERRAIN_ZONES) {
    const [minLon, minLat, maxLon, maxLat] = z.box;
    if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) return z.terrain;
  }
  return 'plains';
}

// ---------------------------------------------------------------------------
// Spherical measurement
// ---------------------------------------------------------------------------

const EARTH_KM = 6371.0088;
const RAD = Math.PI / 180;

/** Great-circle kilometres. The only distance in the build that means anything. */
export function haversineKm(
  lon1: number, lat1: number, lon2: number, lat2: number,
): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface ReferenceInput {
  admin: AdminUnit[];
  /** Towns, carrying lon/lat until the projection is applied. */
  cities: BuildCity[];
}

/** A town as the build carries it, before its coordinates are projected. */
export interface BuildCity extends CityJson {
  lon: number;
  lat: number;
  /** Whose town it is, so a harbour the coastline missed lands at home. */
  tag: string;
  /** Where it ends up on the lattice, once it has been put ashore. */
  col: number;
  row: number;
}

export interface BuiltMap {
  projection: MapProjection;
  arcs: number[][];
  provinces: ProvinceGeoJson[];
  states: StateGeoJson[];
  land: number[][];
  borders: { country: number[]; state: number[]; province: number[]; coast: number[] };
}

/** One province cell, as read off the raster before it becomes a province. */
interface Cell {
  /** Raster id, 1-based. */
  ref: number;
  /** Index in the province array. */
  id: number;
  pixels: number;
  /** Representative pixel, guaranteed inside the cell. */
  col: number;
  row: number;
  lon: number;
  lat: number;
  areaKm: number;
  tag: string;
  stateRef: number;
  stateId: number;
  terrain: TerrainType;
  name: string;
  cityName: string | null;
  cityPop: number;
  coastal: boolean;
  /** A state name history insists on, whatever the towns say. */
  carved: string | null;
}

export function buildFromReference(input: ReferenceInput): BuiltMap {
  const ref = loadReference();
  const { w, h } = ref;

  // --- 1. Geometry ---------------------------------------------------------
  const topo = traceGrid(ref.provinces, w, h);
  const arcs = topo.arcs.map((a) => quantise(chaikin(simplifyArc(a, SIMPLIFY_PX, 3))));
  console.log(`  traced ${arcs.length} arcs, `
    + `${arcs.reduce((s, a) => s + a.length, 0) / 2} points`);

  // --- 2. Cell statistics --------------------------------------------------
  const cells = measureCells(ref);
  console.log(`  ${cells.length} province cells`);

  // --- 3. Who held the ground in 1936 --------------------------------------
  assignOwners(cells, ref, input.admin);

  // --- 4. Towns ------------------------------------------------------------
  assignCities(cells, ref, input.cities);

  // --- 5. Adjacency, straight off the lattice ------------------------------
  const neighbors = rasterAdjacency(ref, cells);

  // --- 6. Names ------------------------------------------------------------
  nameProvinces(cells, input.cities);

  // --- 7. States -----------------------------------------------------------
  const stateGroups = groupStates(cells, neighbors);

  // --- 8. Coast and straits ------------------------------------------------
  const coastal = markCoastal(ref, cells);
  const seaNeighbors = findStraits(ref, cells, coastal, neighbors);
  console.log(`  ${coastal.filter(Boolean).length} coastal, `
    + `${seaNeighbors.reduce((s, x) => s + x.length, 0) / 2} sea crossings`);

  // --- 9. Assemble ---------------------------------------------------------
  const provinces: ProvinceGeoJson[] = cells.map((c) => {
    const rings = topo.rings.get(c.ref) ?? [];
    const signed = rings.map((r) => ({ refs: r, area: ringArea(ringPoints(r, topo.arcs)) }));
    // Every ring was wound with the cell on its left, so an outer boundary and
    // a hole come out with opposite signs and nothing has to test containment.
    signed.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    return {
      id: c.id,
      name: c.name,
      stateId: c.stateId,
      ownerTag: c.tag,
      terrain: c.terrain,
      vp: 0,
      coastal: coastal[c.id],
      rings: signed.map((s) => s.refs),
      center: [Math.round(c.col * QUANTUM), Math.round(c.row * QUANTUM)] as [number, number],
      area: Math.round(c.areaKm),
      neighbors: neighbors[c.id],
      seaNeighbors: seaNeighbors[c.id],
    };
  });

  const states = buildStates(stateGroups, cells, provinces);
  distributeNationalAssets(provinces, states, cells);

  return {
    projection: ref.projection(RENDER_SCALE, QUANTUM),
    arcs,
    provinces,
    states,
    land: landRings(topo, cells),
    borders: classifyArcs(topo, cells),
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Chaikin corner-cut, endpoints pinned so shared arcs still meet. */
function chaikin(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    if (i > 0) out.push([ax + (bx - ax) * 0.25, ay + (by - ay) * 0.25]);
    if (i < pts.length - 2) out.push([ax + (bx - ax) * 0.75, ay + (by - ay) * 0.75]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Lattice coordinates to the integers the file stores.
 *
 * A quarter of a source pixel is under 900 metres, which at the closest zoom
 * the player can reach is a third of a pixel on the screen. Storing it as an
 * integer rather than as a decimal is worth about a third of the file.
 */
function quantise(pts: Pt[]): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (let i = 0; i < pts.length; i++) {
    const x = Math.round(pts[i][0] * QUANTUM);
    const y = Math.round(pts[i][1] * QUANTUM);
    out.push(i === 0 ? x : x - px, i === 0 ? y : y - py);
    px = x;
    py = y;
  }
  return out;
}

function ringArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return s / 2;
}

// ---------------------------------------------------------------------------
// Reading the raster
// ---------------------------------------------------------------------------

/**
 * Pixel counts, a representative point, and true area for every cell.
 *
 * The representative point is the cell's mean nudged onto a pixel that is
 * actually inside it, so a horseshoe-shaped province does not put its counter
 * in its own bay. Area is summed per row from the real width of a pixel at
 * that latitude, because on a cylindrical grid a pixel in Lapland covers a
 * third of what a pixel in the Sahara does.
 */
function measureCells(ref: ReturnType<typeof loadReference>): Cell[] {
  const { w, h, provinces, states, provinceCount } = ref;
  const n = provinceCount + 1;
  const px = new Int32Array(n);
  const sumC = new Float64Array(n);
  const sumR = new Float64Array(n);
  const area = new Float64Array(n);

  // Square kilometres of one pixel on each row.
  const rowArea = new Float64Array(h);
  for (let r = 0; r < h; r++) {
    const latTop = ref.latOf(r);
    const latBottom = ref.latOf(r + 1);
    const midLat = (latTop + latBottom) / 2;
    const dLat = Math.abs(latTop - latBottom);
    rowArea[r] = dLat * 110.574 * ref.lonStep * 111.320 * Math.cos(midLat * RAD);
  }

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cell = provinces[r * w + c];
      if (cell === WATER) continue;
      px[cell]++;
      sumC[cell] += c;
      sumR[cell] += r;
      area[cell] += rowArea[r];
    }
  }

  // Where a counter goes: the pixel of each cell that is furthest from any
  // other cell. The mean would do for a compact province and fails for the
  // rest -- a crescent around a bay has its mean in the water, and a province
  // whose mean sits a pixel from its own border loses it altogether once the
  // outline is simplified, which is how Çanakkale ended up with a centre no
  // longer inside itself. This is inside by construction and by a margin.
  const depth = insideness(provinces, w, h);
  const bestDepth = new Float64Array(n);
  const bestAt = new Int32Array(n).fill(-1);
  for (let i = 0; i < w * h; i++) {
    const cell = provinces[i];
    if (cell === WATER) continue;
    if (bestAt[cell] < 0 || depth[i] > bestDepth[cell]) {
      bestDepth[cell] = depth[i];
      bestAt[cell] = i;
    }
  }

  const out: Cell[] = [];
  for (let cellRef = 1; cellRef < n; cellRef++) {
    if (px[cellRef] === 0) continue;
    const at = bestAt[cellRef];
    const row = Math.floor(at / w);
    const col = at - row * w;
    out.push({
      ref: cellRef, id: out.length, pixels: px[cellRef],
      col: col + 0.5, row: row + 0.5,
      lon: ref.lonOf(col + 0.5), lat: ref.latOf(row + 0.5),
      areaKm: area[cellRef],
      tag: '', stateRef: states[row * w + col], stateId: -1,
      terrain: 'plains', name: '', cityName: null, cityPop: 0,
      coastal: false, carved: null,
    });
  }
  return out;
}

/**
 * How deep inside its own cell each pixel is, in pixels.
 *
 * A breadth-first flood from every pixel that has a different cell next to it,
 * which gives the four-connected distance to the nearest edge. Four-connected
 * rather than Euclidean because the only use is picking the deepest pixel, and
 * the two agree about which that is.
 */
function insideness(cells: Uint16Array, w: number, h: number): Int32Array {
  const depth = new Int32Array(w * h).fill(-1);
  let frontier: number[] = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const cur = cells[i];
      if (cur === WATER) { depth[i] = 0; continue; }
      const edge = (c === 0 || cells[i - 1] !== cur)
        || (c + 1 === w || cells[i + 1] !== cur)
        || (r === 0 || cells[i - w] !== cur)
        || (r + 1 === h || cells[i + w] !== cur);
      if (edge) { depth[i] = 1; frontier.push(i); }
    }
  }
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const i of frontier) {
      const r = Math.floor(i / w);
      const c = i - r * w;
      const d = depth[i] + 1;
      if (c > 0 && depth[i - 1] < 0) { depth[i - 1] = d; next.push(i - 1); }
      if (c + 1 < w && depth[i + 1] < 0) { depth[i + 1] = d; next.push(i + 1); }
      if (r > 0 && depth[i - w] < 0) { depth[i - w] = d; next.push(i - w); }
      if (r + 1 < h && depth[i + w] < 0) { depth[i + w] = d; next.push(i + w); }
    }
    frontier = next;
  }
  return depth;
}

/**
 * Land adjacency, straight off the lattice.
 *
 * Two provinces are neighbours when two of their pixels touch. There is no
 * tolerance to tune and no seam length to argue about, which between them were
 * the cause of every adjacency bug this map has had: a strait that was really
 * a T-junction, a border that was really a corner, an Øresund that had to be
 * told apart from Bavaria by how long the two rings ran alongside each other.
 */
function rasterAdjacency(
  ref: ReturnType<typeof loadReference>, cells: Cell[],
): number[][] {
  const { w, h, provinces } = ref;
  const idOf = new Int32Array(ref.provinceCount + 1).fill(-1);
  for (const c of cells) idOf[c.ref] = c.id;
  const sets = cells.map(() => new Set<number>());
  const link = (a: number, b: number): void => {
    if (a === b || a === WATER || b === WATER) return;
    const x = idOf[a];
    const y = idOf[b];
    if (x < 0 || y < 0) return;
    sets[x].add(y);
    sets[y].add(x);
  };
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cur = provinces[r * w + c];
      if (c + 1 < w) link(cur, provinces[r * w + c + 1]);
      if (r + 1 < h) link(cur, provinces[(r + 1) * w + c]);
    }
  }
  return sets.map((s) => [...s].sort((a, b) => a - b));
}

/**
 * Which provinces touch open water.
 *
 * The export paints the sea blue, so this is not a judgement about geometry:
 * the pixel next door either is water or it is not. Pixels off the edge of the
 * export are *not* water -- the crop stops in the middle of Russia, and a
 * province at the map's edge is not a port.
 */
function markCoastal(ref: ReturnType<typeof loadReference>, cells: Cell[]): boolean[] {
  const { w, h, provinces } = ref;
  const idOf = new Int32Array(ref.provinceCount + 1).fill(-1);
  for (const c of cells) idOf[c.ref] = c.id;
  const out = cells.map(() => false);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cur = provinces[r * w + c];
      if (cur === WATER) continue;
      const id = idOf[cur];
      if (id < 0) continue;
      if ((c > 0 && provinces[r * w + c - 1] === WATER)
        || (c + 1 < w && provinces[r * w + c + 1] === WATER)
        || (r > 0 && provinces[(r - 1) * w + c] === WATER)
        || (r + 1 < h && provinces[(r + 1) * w + c] === WATER)) out[id] = true;
    }
  }
  return out;
}

/**
 * Sea crossings, measured through the water rather than across it.
 *
 * Every water pixel is flooded outward from the coast at once, carrying the
 * province it came from and how far it has travelled. Where two floods meet,
 * the two provinces are a crossing apart -- and the distance is the length of
 * the route a ship would take, so a bay does not become a strait just because
 * its two headlands are close as the crow flies. Land cannot be crossed at
 * all, because the flood never enters it.
 */
function findStraits(
  ref: ReturnType<typeof loadReference>, cells: Cell[], coastal: boolean[],
  neighbors: number[][],
): number[][] {
  const land = neighbors.map((list) => new Set(list));
  const { w, h, provinces } = ref;
  const idOf = new Int32Array(ref.provinceCount + 1).fill(-1);
  for (const c of cells) idOf[c.ref] = c.id;

  // Kilometres per step, by row. Diagonals are not walked: four-connectivity
  // over a fine grid is within a few per cent of the true path length and
  // costs nothing to reason about.
  const stepX = new Float64Array(h);
  const stepY = new Float64Array(h);
  for (let r = 0; r < h; r++) {
    const lat = ref.latOf(r + 0.5);
    stepX[r] = ref.lonStep * 111.320 * Math.cos(lat * RAD);
    stepY[r] = Math.abs(ref.latOf(r) - ref.latOf(r + 1)) * 110.574;
  }

  const source = new Int32Array(w * h).fill(-1);
  const dist = new Float64Array(w * h).fill(Infinity);
  // A bucket queue: distances are bounded by STRAIT_KM and the step is a few
  // kilometres, so a heap would be all overhead.
  const BUCKET = 2;
  const buckets: number[][] = Array.from(
    { length: Math.ceil(STRAIT_KM / BUCKET) + 2 }, () => [],
  );
  const pushCell = (i: number, d: number, src: number): void => {
    if (d >= STRAIT_KM || d >= dist[i]) return;
    dist[i] = d;
    source[i] = src;
    buckets[Math.floor(d / BUCKET)].push(i);
  };

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cur = provinces[r * w + c];
      if (cur === WATER) continue;
      const id = idOf[cur];
      if (id < 0 || !coastal[id]) continue;
      const neighbours = [
        c > 0 ? r * w + c - 1 : -1,
        c + 1 < w ? r * w + c + 1 : -1,
        r > 0 ? (r - 1) * w + c : -1,
        r + 1 < h ? (r + 1) * w + c : -1,
      ];
      for (const nb of neighbours) {
        if (nb < 0 || provinces[nb] !== WATER) continue;
        pushCell(nb, 0, id);
      }
    }
  }

  const pairs = new Map<number, number>();
  const note = (a: number, b: number, d: number): void => {
    if (a === b) return;
    const key = a < b ? a * 100000 + b : b * 100000 + a;
    const had = pairs.get(key);
    if (had === undefined || d < had) pairs.set(key, d);
  };

  for (let b = 0; b < buckets.length; b++) {
    for (let qi = 0; qi < buckets[b].length; qi++) {
      const i = buckets[b][qi];
      if (dist[i] >= (b + 1) * BUCKET) continue;   // superseded by a shorter route
      const r = (i / w) | 0;
      const c = i - r * w;
      const d = dist[i];
      const src = source[i];
      const step = [
        [c > 0 ? i - 1 : -1, stepX[r]],
        [c + 1 < w ? i + 1 : -1, stepX[r]],
        [r > 0 ? i - w : -1, stepY[r]],
        [r + 1 < h ? i + w : -1, stepY[r]],
      ] as const;
      for (const [j, cost] of step) {
        if (j < 0) continue;
        if (provinces[j] !== WATER) continue;
        if (source[j] >= 0 && source[j] !== src) note(src, source[j], d + dist[j]);
        pushCell(j, d + cost, src);
      }
    }
  }

  const out = cells.map(() => new Set<number>());
  for (const [key, d] of pairs) {
    const a = Math.floor(key / 100000);
    const b = key - a * 100000;
    // Two provinces that already share a land border do not also need a
    // ferry between them: every river mouth on the map would be a strait.
    if (land[a].has(b)) continue;
    if (d > STRAIT_KM) continue;
    out[a].add(b);
    out[b].add(a);
  }
  return out.map((s) => [...s].sort((a, b) => a - b));
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * Puts every cell in 1936 hands.
 *
 * Natural Earth's administrative units are rasterised onto the reference's own
 * grid and each cell takes the tag most of its pixels agree on. A vote rather
 * than a point sample because the two sources are fitted to each other to
 * about a sixth of a degree, and on that scale a single point near a frontier
 * is a coin toss while a whole province is not.
 */
function assignOwners(
  cells: Cell[], ref: ReturnType<typeof loadReference>, admin: AdminUnit[],
): void {
  const { w, h } = ref;
  const tags: string[] = [];
  const tagIndex = new Map<string, number>();
  const owner = new Int16Array(w * h).fill(-1);

  const rowOf = rowLookup(ref);
  // Which unit painted each pixel, alongside which tag, so a unit that the
  // vote erases can be found again afterwards.
  const unitAt = new Int32Array(w * h).fill(-1);
  // How many pixels each unit covered at all, land or water. A unit that
  // covered none is smaller than the lattice; one that covered only water is
  // an island this export does not have. The two need opposite answers.
  const painted = new Int32Array(admin.length);
  admin.forEach((unit, ui) => {
    let ti = tagIndex.get(unit.tag);
    if (ti === undefined) { ti = tags.length; tags.push(unit.tag); tagIndex.set(unit.tag, ti); }
    for (const ring of unit.lonLat) {
      fillRing(ring, ref, rowOf, w, h, (i) => {
        owner[i] = ti as number;
        unitAt[i] = ui;
        painted[ui]++;
      });
    }
  });

  const votes = new Map<number, Map<number, number>>();
  const idOf = new Int32Array(ref.provinceCount + 1).fill(-1);
  for (const c of cells) idOf[c.ref] = c.id;
  for (let i = 0; i < w * h; i++) {
    const cell = ref.provinces[i];
    if (cell === WATER) continue;
    const id = idOf[cell];
    if (id < 0 || owner[i] < 0) continue;
    let m = votes.get(id);
    if (!m) { m = new Map(); votes.set(id, m); }
    m.set(owner[i], (m.get(owner[i]) ?? 0) + 1);
  }

  const unclaimed: Cell[] = [];
  for (const c of cells) {
    const m = votes.get(c.id);
    if (!m) { unclaimed.push(c); continue; }
    let best = -1;
    let bestN = -1;
    for (const [ti, n] of m) if (n > bestN) { bestN = n; best = ti; }
    c.tag = tags[best];
  }
  if (unclaimed.length > 0) {
    console.log(`  ${unclaimed.length} cells with no admin unit under them`);
  }
  // Whatever Natural Earth does not cover -- a headland the fit puts a pixel
  // off the coast, an island it never drew -- goes to the nearest cell that is
  // claimed, so no ground is left ownerless.
  for (const c of unclaimed) {
    let best = '';
    let bestD = Infinity;
    for (const o of cells) {
      if (!o.tag) continue;
      const d = haversineKm(c.lon, c.lat, o.lon, o.lat);
      if (d < bestD) { bestD = d; best = o.tag; }
    }
    c.tag = best || NATIONS[0].tag;
  }

  // Named corrections last, so nothing downstream can vote them away again.
  for (const claim of CLAIMS_1936) {
    const id = cellAtLonLat(ref, idOf, claim.lon, claim.lat);
    if (id < 0) {
      console.warn(`  claim for ${claim.why} lands on no province`);
      continue;
    }
    if (cells[id].tag === claim.tag) continue;
    console.log(`  ${claim.lon.toFixed(2)},${claim.lat.toFixed(2)}: `
      + `${cells[id].tag} -> ${claim.tag}, ${claim.why}`);
    cells[id].tag = claim.tag;
  }

  rescueErasedUnits(cells, ref, admin, unitAt, painted, idOf);
}

/** How far from a cell a claim may stand, in the cell's own radii. */
const RESCUE_REACH = 1.5;
/** How much of a cell a distant claim must cover to be believed. */
const RESCUE_SHARE = 0.05;

/**
 * Gives back the ground the vote took from anything smaller than a province.
 *
 * A majority is the right answer for a frontier and the wrong one for a
 * territory that does not fill a cell. Gibraltar is six square kilometres
 * against a cell of two thousand, so every pixel of the cell that is not
 * Gibraltar is Spain and the vote hands the Rock to Spain; the same
 * arithmetic gave Rhodes to Turkey, whose coast is twenty kilometres away.
 *
 * So: a unit that does not hold a single one of the cells it covers has been
 * erased rather than outvoted, and it takes the cell it covers most. Only
 * then -- a unit that lost one cell of six and kept the others is a border
 * being drawn, which is what the vote is for.
 *
 * A claim still has to be credible, because the two sources are fitted to
 * each other and the fit is loose in places. It is credible if the unit
 * stands on the cell -- within about a cell's own reach of it -- or if it
 * covers a real share of the cell without standing near the middle, which is
 * what an island group looks like when the export draws it as one piece: the
 * Dodecanese are a hundred and thirty kilometres from the point that
 * represents their cell and still cover a fifth of it. Neither is true of a
 * unit the export simply does not contain. Malta is not on this map at all,
 * so a Maltese parish lands on Sicily -- one pixel of two hundred, a hundred
 * and twenty kilometres out -- and rescuing it painted a piece of Sicily
 * British. There is no ground here to give it, and saying so is the honest
 * answer.
 */
function rescueErasedUnits(
  cells: Cell[], ref: ReturnType<typeof loadReference>, admin: AdminUnit[],
  unitAt: Int32Array, painted: Int32Array, idOf: Int32Array,
): void {
  const { w, h } = ref;
  // Pixels each unit contributes to each cell.
  const spread = admin.map(() => new Map<number, number>());
  for (let i = 0; i < w * h; i++) {
    const ui = unitAt[i];
    if (ui < 0) continue;
    const cell = ref.provinces[i];
    if (cell === WATER) continue;
    const id = idOf[cell];
    if (id < 0) continue;
    const m = spread[ui];
    m.set(id, (m.get(id) ?? 0) + 1);
  }

  const rescued: string[] = [];
  const taken = new Set<number>();
  admin.forEach((unit, ui) => {
    const m = spread[ui];
    let held = false;
    let best = -1;
    let bestN = 0;
    for (const [id, n] of m) {
      if (cells[id].tag === unit.tag) held = true;
      if (n > bestN) { bestN = n; best = id; }
    }
    if (held) return;
    const at = unitCentre(unit);
    if (!at) return;
    if (m.size === 0) {
      // Nothing to rescue unless the unit is smaller than a lattice pixel and
      // therefore covers nothing at all. One that painted pixels and reached
      // no cell painted only water, which is a different thing: an island the
      // export does not draw.
      if (painted[ui] > 0) return;
      best = cellAtLonLat(ref, idOf, at[0], at[1]);
    }
    if (best < 0 || taken.has(best) || cells[best].tag === unit.tag) return;

    const cell = cells[best];
    const reach = Math.sqrt(cell.areaKm / Math.PI);
    const away = haversineKm(at[0], at[1], cell.lon, cell.lat);
    if (away > reach * RESCUE_REACH && bestN < cell.pixels * RESCUE_SHARE) return;

    taken.add(best);
    rescued.push(`${unit.name} (${cell.tag} -> ${unit.tag})`);
    cell.tag = unit.tag;
  });
  if (rescued.length > 0) {
    console.log(`  ${rescued.length} units the vote had erased: `
      + `${rescued.join(', ')}`);
  }
}

/** Mean of a unit's outline, which is inside it for anything this small. */
function unitCentre(unit: AdminUnit): [number, number] | null {
  let lon = 0;
  let lat = 0;
  let n = 0;
  for (const ring of unit.lonLat) {
    for (const [x, y] of ring) { lon += x; lat += y; n++; }
  }
  return n === 0 ? null : [lon / n, lat / n];
}

/** The province standing on this point, or -1 for water and off the map. */
function cellAtLonLat(
  ref: ReturnType<typeof loadReference>, idOf: Int32Array, lon: number, lat: number,
): number {
  const col = Math.round((lon - ref.lon0) / ref.lonStep);
  const row = ref.rowOfLat(lat);
  if (col < 0 || col >= ref.w || row < 0 || row >= ref.h) return -1;
  const cell = ref.provinces[row * ref.w + col];
  return cell === WATER ? -1 : idOf[cell];
}

/**
 * Longitude and latitude to the reference's own lattice.
 *
 * The map is drawn in this frame and nothing is measured in it, so the only
 * thing that has to be right here is that a town lands on the province it
 * belongs to and a river runs down the valley it belongs to.
 */
export function referenceProjector(): {
  toLattice(lon: number, lat: number): Pt;
  toLonLat(col: number, row: number): Pt;
} {
  const ref = loadReference();
  const lats = new Float64Array(ref.h + 1);
  for (let r = 0; r <= ref.h; r++) lats[r] = ref.latOf(r);
  const descending = lats[0] > lats[ref.h];
  return {
    toLattice(lon: number, lat: number): Pt {
      let lo = 0;
      let hi = ref.h;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (descending ? lats[mid] > lat : lats[mid] < lat) lo = mid + 1;
        else hi = mid;
      }
      // Between the two tabulated rows, so a river is not a staircase.
      let row = lo;
      if (lo > 0) {
        const a = lats[lo - 1];
        const b = lats[lo];
        if (a !== b) row = lo - 1 + (lat - a) / (b - a);
      }
      return [(lon - ref.lon0) / ref.lonStep, row];
    },
    toLonLat(col: number, row: number): Pt {
      return [ref.lonOf(col), ref.latOf(row)];
    },
  };
}

/** Row index for a latitude, tabulated once instead of bisected per vertex. */
function rowLookup(ref: ReturnType<typeof loadReference>): (lat: number) => number {
  const { h } = ref;
  const lats = new Float64Array(h + 1);
  for (let r = 0; r <= h; r++) lats[r] = ref.latOf(r);
  const descending = lats[0] > lats[h];
  return (lat: number): number => {
    let lo = 0;
    let hi = h;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (descending ? lats[mid] > lat : lats[mid] < lat) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

/** Scanline fill of a lon/lat ring onto the reference grid. */
function fillRing(
  ring: Ring, ref: ReturnType<typeof loadReference>, rowOf: (lat: number) => number,
  w: number, h: number, set: (index: number) => void,
): void {
  const n = ring.length;
  if (n < 3) return;
  let minRow = Infinity;
  let maxRow = -Infinity;
  const rows = new Float64Array(n);
  const cols = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = rowOf(ring[i][1]);
    cols[i] = (ring[i][0] - ref.lon0) / ref.lonStep;
    if (rows[i] < minRow) minRow = rows[i];
    if (rows[i] > maxRow) maxRow = rows[i];
  }
  const r0 = Math.max(0, Math.floor(minRow));
  const r1 = Math.min(h - 1, Math.ceil(maxRow));
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const y = r + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = rows[i];
      const yj = rows[j];
      if ((yi > y) === (yj > y)) continue;
      xs.push(cols[i] + ((y - yi) / (yj - yi)) * (cols[j] - cols[i]));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const c1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      const base = r * w;
      for (let c = c0; c <= c1; c++) set(base + c);
    }
  }
}

// ---------------------------------------------------------------------------
// Towns and names
// ---------------------------------------------------------------------------

function assignCities(
  cells: Cell[], ref: ReturnType<typeof loadReference>,
  cities: BuildCity[],
): void {
  const { w, h } = ref;
  const idOf = new Int32Array(ref.provinceCount + 1).fill(-1);
  for (const c of cells) idOf[c.ref] = c.id;
  const rowOf = rowLookup(ref);

  for (const city of cities) {
    const col = Math.round((city.lon - ref.lon0) / ref.lonStep);
    const row = rowOf(city.lat);
    city.col = col;
    city.row = row;
    let id = -1;
    if (col >= 0 && col < w && row >= 0 && row < h) {
      const cell = ref.provinces[row * w + col];
      if (cell !== WATER) id = idOf[cell];
    }
    if (id < 0) {
      // A port whose pixel fell in its own harbour, which is most of them:
      // the export's coastline is the game's, and the game's is a few
      // kilometres inside the real one wherever it simplifies a bay. Spiral
      // outward to the nearest land rather than asking which province centre
      // is closest -- Iraklio is nearer the middle of Attica than the middle
      // of Crete, and answering that way put half the Aegean's harbours on
      // the mainland.
      // eslint-disable-next-line no-labels
      outer: for (let ring = 1; ring <= CITY_SEARCH_PX; ring++) {
        for (let dr = -ring; dr <= ring; dr++) {
          for (let dc = -ring; dc <= ring; dc++) {
            if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
            const r = row + dr;
            const c = col + dc;
            if (r < 0 || r >= h || c < 0 || c >= w) continue;
            const cell = ref.provinces[r * w + c];
            if (cell === WATER) continue;
            id = idOf[cell];
            if (id < 0) continue;
            // Drawn where it was put ashore, not where the atlas says: a dot
            // in the water is a bug the player can see.
            city.col = c;
            city.row = r;
            break outer;
          }
        }
      }
    }
    if (id < 0) {
      // Beyond the coastline's own error: the export puts Iceland about a
      // degree and a half north of where Natural Earth does, so Reykjavik
      // lands in the sea and no amount of spiralling reaches the island. Fall
      // back to the nearest ground its own country holds, which is the answer
      // the spiral was looking for anyway.
      let bestD = Infinity;
      for (const c of cells) {
        if (c.tag !== city.tag) continue;
        const d = haversineKm(city.lon, city.lat, c.lon, c.lat);
        if (d < bestD) { bestD = d; id = c.id; city.col = c.col; city.row = c.row; }
      }
    }
    city.province = id;
  }

  // A province is named after the largest town on it, handed out largest
  // first so Algiers is not left calling itself Blida.
  const order = [...cities].sort((a, b) => b.pop - a.pop);
  for (const city of order) {
    if (city.province < 0) continue;
    const c = cells[city.province];
    if (city.pop > c.cityPop) { c.cityPop = city.pop; c.cityName = city.name; }
  }
  for (const c of cells) c.terrain = classifyTerrain(c.lon, c.lat, c.cityPop);
}

/**
 * Gives every province a place name.
 *
 * A province with a town takes that town's name. The rest are named for the
 * nearest real town with a compass qualifier, because "Sweden 282" tells a
 * player nothing and breaks the illusion the map is working to create.
 */
function nameProvinces(cells: Cell[], cities: BuildCity[]): void {
  const used = new Map<string, number>();
  const claim = (base: string): string => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base} ${romanish(n)}`;
  };
  const named = [...cells].sort((a, b) => b.cityPop - a.cityPop);
  for (const c of named) if (c.cityName) c.name = claim(c.cityName);
  for (const c of cells) {
    if (c.name) continue;
    let best: BuildCity | null = null;
    let bestD = Infinity;
    for (const city of cities) {
      const d = (city.lon - c.lon) ** 2 + ((city.lat - c.lat) * 1.6) ** 2;
      if (d < bestD) { bestD = d; best = city; }
    }
    if (!best) { c.name = claim(NATION_BY_TAG.get(c.tag)?.name ?? c.tag); continue; }
    c.name = claim(`${compass(c.lon - best.lon, c.lat - best.lat)} ${best.name}`);
  }
}

function compass(dLon: number, dLat: number): string {
  const angle = Math.atan2(dLat, dLon);
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

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * Groups provinces into states, following the reference's own state map.
 *
 * The two tiers come from one raster, so a state is exactly a set of whole
 * provinces and can never cut one in half. The grouping is split again by
 * owner and by connectivity: the reference draws the game's 1936 borders and
 * Natural Earth draws today's, and where the two disagree a state would
 * otherwise straddle a frontier or arrive in two pieces.
 */
function groupStates(cells: Cell[], neighbors: number[][]): number[][] {
  const byKey = new Map<string, number[]>();
  for (const c of cells) {
    const key = `${c.stateRef}|${c.tag}`;
    const list = byKey.get(key);
    if (list) list.push(c.id); else byKey.set(key, [c.id]);
  }

  const groups: number[][] = [];
  for (const members of byKey.values()) {
    const set = new Set(members);
    const seen = new Set<number>();
    for (const start of members) {
      if (seen.has(start)) continue;
      const part: number[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length > 0) {
        const cur = stack.pop() as number;
        part.push(cur);
        for (const nb of neighbors[cur]) {
          if (!set.has(nb) || seen.has(nb)) continue;
          seen.add(nb);
          stack.push(nb);
        }
      }
      groups.push(part);
    }
  }

  carveHistoricalStates(groups, cells, neighbors);
  groups.forEach((g, i) => { for (const id of g) cells[id].stateId = i; });
  return groups;
}

/**
 * Cuts the states history made that no administrative map remembers.
 *
 * The Sudetenland is the case that matters: it has to be its own state before
 * Munich can hand it over, and no present-day unit describes it. The rim is
 * grown inward from the frontier it faces until it has taken enough ground.
 */
function carveHistoricalStates(
  groups: number[][], cells: Cell[], neighbors: number[][],
): void {
  for (const carve of CARVE_1936) {
    const inWindow = (c: Cell): boolean => (
      c.lon >= carve.window.minLon && c.lon <= carve.window.maxLon
      && c.lat >= carve.window.minLat && c.lat <= carve.window.maxLat
    );
    const pool = new Set(
      cells.filter((c) => c.tag === carve.from && inWindow(c)).map((c) => c.id),
    );
    if (pool.size === 0) continue;
    // The frontier ring first, then inward until the area is met.
    const taken = new Set<number>();
    let frontier = [...pool].filter((id) => neighbors[id].some(
      (nb) => carve.frontierWith.includes(cells[nb].tag),
    ));
    let area = 0;
    while (frontier.length > 0 && area < carve.areaKm) {
      const next: number[] = [];
      for (const id of frontier) {
        if (taken.has(id)) continue;
        taken.add(id);
        area += cells[id].areaKm;
        for (const nb of neighbors[id]) {
          if (pool.has(nb) && !taken.has(nb)) next.push(nb);
        }
      }
      if (area >= carve.areaKm) break;
      frontier = next;
    }
    if (taken.size === 0) continue;
    for (const g of groups) {
      for (let i = g.length - 1; i >= 0; i--) if (taken.has(g[i])) g.splice(i, 1);
    }
    for (let i = groups.length - 1; i >= 0; i--) if (groups[i].length === 0) groups.splice(i, 1);
    const members = [...taken].sort((a, b) => a - b);
    for (const id of members) cells[id].carved = carve.name;
    groups.push(members);
    console.log(`  carved ${carve.name}: ${members.length} provinces, `
      + `${Math.round(area)} km2`);
  }
}

function buildStates(
  groups: number[][], cells: Cell[], provinces: ProvinceGeoJson[],
): StateGeoJson[] {
  const taken = new Map<string, number>();
  return groups.map((members, i) => {
    for (const id of members) provinces[id].stateId = i;
    return {
      id: i,
      name: uniqueStateName(stateNameFor(cells, members), cells, members, taken),
      ownerTag: cells[members[0]].tag,
      provinces: members.slice().sort((a, b) => a - b),
      manpower: 0,
      resources: {} as Partial<Record<ResourceType, number>>,
      infrastructure: 1,
      civilianFactories: 0,
      militaryFactories: 0,
      dockyards: 0,
      buildingSlots: 8,
    };
  });
}

/** A state is called after the largest place inside it. */
function stateNameFor(cells: Cell[], members: readonly number[]): string {
  const given = cells[members[0]].carved;
  if (given) return given;
  let best = members[0];
  for (const m of members) if (cells[m].cityPop > cells[best].cityPop) best = m;
  if (cells[best].cityName) return cells[best].cityName as string;
  let widest = members[0];
  for (const m of members) if (cells[m].areaKm > cells[widest].areaKm) widest = m;
  return cells[widest].name;
}

function uniqueStateName(
  base: string, cells: Cell[], members: readonly number[], taken: Map<string, number>,
): string {
  const n = taken.get(base) ?? 0;
  taken.set(base, n + 1);
  if (n === 0) return base;
  let lon = 0;
  let lat = 0;
  for (const m of members) { lon += cells[m].lon; lat += cells[m].lat; }
  const anchor = cells[members[0]];
  const name = `${compass(lon / members.length - anchor.lon, lat / members.length - anchor.lat)} ${base}`;
  const again = taken.get(name) ?? 0;
  taken.set(name, again + 1);
  return again === 0 ? name : `${base} ${romanish(n)}`;
}

// ---------------------------------------------------------------------------
// Borders and the silhouette
// ---------------------------------------------------------------------------

function classifyArcs(
  topo: ReturnType<typeof traceGrid>, cells: Cell[],
): BuiltMap['borders'] {
  const byRef = new Map<number, Cell>();
  for (const c of cells) byRef.set(c.ref, c);
  const out: BuiltMap['borders'] = { country: [], state: [], province: [], coast: [] };
  for (let i = 0; i < topo.arcs.length; i++) {
    const { left, right } = topo.sides[i];
    const a = byRef.get(left);
    const b = byRef.get(right);
    if (!a || !b) { out.coast.push(i); continue; }
    if (a.tag !== b.tag) out.country.push(i);
    else if (a.stateId !== b.stateId) out.state.push(i);
    else out.province.push(i);
  }
  return out;
}

/**
 * The land silhouette: every arc with water on one side, chained into loops.
 *
 * Taken from the same arcs the provinces use, so the background can never show
 * through a hairline gap at the coast the way two independently traced
 * outlines would.
 */
function landRings(topo: ReturnType<typeof traceGrid>, cells: Cell[]): number[][] {
  const land = new Set(cells.map((c) => c.ref));
  const refs: number[] = [];
  for (let i = 0; i < topo.arcs.length; i++) {
    const { left, right } = topo.sides[i];
    const leftLand = land.has(left);
    const rightLand = land.has(right);
    if (leftLand === rightLand) continue;
    // Wound with land on the left, so a coastline and the shore of a lake
    // inside it come out with opposite signed areas and the lake reads as a
    // hole rather than as more ground.
    refs.push(leftLand ? i : ~i);
  }
  return chainRings(refs, topo.arcs);
}

// ---------------------------------------------------------------------------
// National assets
// ---------------------------------------------------------------------------

function distributeNationalAssets(
  provinces: ProvinceGeoJson[], states: StateGeoJson[], cells: Cell[],
): void {
  const byTag = new Map<string, number[]>();
  states.forEach((s, i) => {
    const list = byTag.get(s.ownerTag);
    if (list) list.push(i); else byTag.set(s.ownerTag, [i]);
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
        pop += cells[pid].cityPop;
        area += provinces[pid].area;
        if (cells[pid].lat < 37) colonial = true;
      }
      const base = 0.12 + pop / 250 + area / 900_000;
      return colonial ? base * 0.22 : base;
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    const share = (total: number, i: number) => (total * weights[i]) / totalWeight;

    const civ = largestRemainder(nation.civilianFactories, weights);
    const mil = largestRemainder(nation.militaryFactories, weights);
    const dockWeights = stateIds.map((sid, i) =>
      (states[sid].provinces.some((pid) => provinces[pid].coastal) ? weights[i] : 0));
    const anyCoastal = dockWeights.some((x) => x > 0);
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
      let biggestCity = 0;
      for (const pid of st.provinces) biggestCity = Math.max(biggestCity, cells[pid].cityPop);
      st.infrastructure = Math.max(1, Math.min(5,
        nation.infrastructure - 1 + (biggestCity > 400 ? 2 : biggestCity > 120 ? 1 : 0)));
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
