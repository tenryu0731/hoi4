import type { ProvinceId, TerrainType } from '../core/types';
import type { MapDataJson, ProvinceGeoJson } from './MapData';

/**
 * Runtime view over the baked map. Owns everything geometric that the
 * simulation and the renderer need: spatial picking, adjacency, and pathfinding.
 *
 * Geometry lives in typed arrays and never changes after load; anything that
 * varies during a game (owner, controller, supply) lives in GameState instead.
 */

export interface Province {
  id: ProvinceId;
  name: string;
  stateId: number;
  ownerTag: string;
  terrain: TerrainType;
  vp: number;
  coastal: boolean;
  /** Flat [x0, y0, x1, y1, ...] per ring. */
  rings: Float32Array[];
  /** 0 = outer ring, 1 = hole. */
  ringDepth: number[];
  centerX: number;
  centerY: number;
  /** Where the province is on the Earth. Distances are measured from this. */
  lon: number;
  lat: number;
  area: number;
  neighbors: ProvinceId[];
  seaNeighbors: ProvinceId[];
  /**
   * Kilometres to each neighbour, in step with the lists above.
   *
   * The graph never changes, so the length of an edge is a constant. A* asks
   * for one on every edge it relaxes and supply propagation on every edge it
   * pushes through, which between them was most of the calls to `distance`.
   */
  neighborKm: Float32Array;
  seaNeighborKm: Float32Array;
  /** [minX, minY, maxX, maxY] over every ring. */
  bbox: [number, number, number, number];
}

export interface PathOptions {
  /** Extra cost multiplier for a province, e.g. terrain or enemy control. */
  cost?: (id: ProvinceId) => number;
  /** Provinces the mover may not enter. */
  blocked?: (id: ProvinceId) => boolean;
  /** Whether sea crossings may be used, and how much dearer they are. */
  allowSea?: boolean;
  seaMultiplier?: number;
  /** Abort once the open set exceeds this many nodes. */
  maxExpansions?: number;
}

const DEFAULT_SEA_MULTIPLIER = 4;

const EARTH_KM = 6371.0088;
const RAD = Math.PI / 180;

/**
 * How close a vertex has to be to the other province's edge to count as on the
 * shared boundary, in kilometres. Provinces average around 160 km across, so
 * this is far below the scale at which two distinct boundaries could be
 * confused, and well above the error two independent simplification passes
 * introduce along the same line.
 */
const SHARED_EPS = 1.5;

/** Squared distance from a point to a segment. */
function pointSegmentDistanceSq(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

export class ProvinceIndex {
  readonly provinces: Province[];
  readonly bounds: [number, number, number, number];
  readonly data: MapDataJson;
  /** Every boundary line on the map, in render units, each held once. */
  readonly arcs: Float32Array[];
  /** The land silhouette, assembled from the same arcs the provinces use. */
  readonly landRings: Float32Array[];
  /** Rivers, in render units. */
  readonly rivers: Float32Array[];

  private cellSize: number;
  private gridW: number;
  private gridH: number;
  private gridOffX: number;
  private gridOffY: number;
  /** Flattened cell -> candidate province ids. */
  private grid: Int32Array[];

  // Scratch buffers reused by pathfinding so a search allocates nothing.
  private gScore: Float64Array;
  private fScore: Float64Array;
  private cameFrom: Int32Array;
  private closed: Uint8Array;
  private visitStamp: Int32Array;
  /** The A* open set, as a binary heap of province ids. */
  private open: Int32Array;
  private stamp = 0;
  /**
   * Each province as a unit vector on the sphere, so a great-circle distance
   * is a dot product and one arc cosine rather than five trigonometric calls.
   * A cache keyed by the province pair was the obvious alternative and the
   * wrong one: nine million pairs is not a cache, it is a leak.
   */
  private unitX: Float64Array;
  private unitY: Float64Array;
  private unitZ: Float64Array;
  /** Latitude and longitude to a render position: `geographer` run backwards. */
  private surveyor: (lon: number, lat: number) => [number, number];

  private constructor(data: MapDataJson) {
    this.data = data;
    this.bounds = data.bounds;
    // Delta-encoded lattice integers to render units, once, for everything
    // that draws.
    const scale = data.projection.scale;
    this.arcs = data.arcs.map((a) => {
      const out = new Float32Array(a.length);
      let x = 0;
      let y = 0;
      for (let i = 0; i < a.length; i += 2) {
        x += a[i];
        y += a[i + 1];
        out[i] = x * scale;
        out[i + 1] = y * scale;
      }
      return out;
    });
    const place = geographer(data.projection);
    this.surveyor = surveyor(data.projection);
    this.provinces = data.provinces.map((p) => toProvince(p, this.arcs, scale, place));
    const n0 = this.provinces.length;
    this.unitX = new Float64Array(n0);
    this.unitY = new Float64Array(n0);
    this.unitZ = new Float64Array(n0);
    for (let i = 0; i < n0; i++) {
      const lat = this.provinces[i].lat * RAD;
      const lon = this.provinces[i].lon * RAD;
      const c = Math.cos(lat);
      this.unitX[i] = c * Math.cos(lon);
      this.unitY[i] = c * Math.sin(lon);
      this.unitZ[i] = Math.sin(lat);
    }
    for (const p of this.provinces) {
      p.neighborKm = Float32Array.from(p.neighbors, (nb) => this.distance(p.id, nb));
      p.seaNeighborKm = Float32Array.from(p.seaNeighbors, (nb) => this.distance(p.id, nb));
    }
    this.landRings = data.land.map((refs) => assembleRing(refs, this.arcs));
    // Towns are stored on the same lattice as everything else; the UI reads
    // them straight off `data.cities`, so they are put into render units here
    // rather than at every call site.
    for (const c of data.cities) { c.x *= scale; c.y *= scale; }
    this.rivers = data.rivers.map((flat) => {
      const out = new Float32Array(flat.length);
      for (let i = 0; i < flat.length; i++) out[i] = flat[i] * scale;
      return out;
    });

    const [minX, minY, maxX, maxY] = data.bounds;
    const w = maxX - minX;
    const h = maxY - minY;
    // Aim for a handful of provinces per cell: enough buckets to keep candidate
    // lists short, few enough that building the grid stays cheap.
    const target = Math.max(1, this.provinces.length * 6);
    this.cellSize = Math.max(20, Math.sqrt((w * h) / target));
    this.gridOffX = minX;
    this.gridOffY = minY;
    this.gridW = Math.ceil(w / this.cellSize) + 1;
    this.gridH = Math.ceil(h / this.cellSize) + 1;
    this.grid = new Array(this.gridW * this.gridH);
    this.buildGrid();

    const n = this.provinces.length;
    this.gScore = new Float64Array(n);
    this.fScore = new Float64Array(n);
    this.cameFrom = new Int32Array(n);
    this.closed = new Uint8Array(n);
    this.visitStamp = new Int32Array(n).fill(-1);
    // One slot per province is not enough: A* may hold several stale entries
    // for the same node, one per improvement found before it is expanded.
    this.open = new Int32Array(n).fill(-1 * 8);
  }

  static load(data: MapDataJson): ProvinceIndex {
    return new ProvinceIndex(data);
  }

  get count(): number {
    return this.provinces.length;
  }

  get(id: ProvinceId): Province {
    return this.provinces[id];
  }

  // -------------------------------------------------------------------------
  // Spatial index
  // -------------------------------------------------------------------------

  private buildGrid(): void {
    const buckets: number[][] = new Array(this.gridW * this.gridH);
    const mark = (cx: number, cy: number, id: number) => {
      if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) return;
      const k = cy * this.gridW + cx;
      const b = buckets[k] ?? (buckets[k] = []);
      if (b[b.length - 1] !== id) b.push(id);
    };

    for (const p of this.provinces) {
      // 1. Cells touched by the boundary, walked segment by segment.
      for (const ring of p.rings) {
        for (let i = 0; i < ring.length; i += 2) {
          const j = (i + 2) % ring.length;
          this.markSegment(ring[i], ring[i + 1], ring[j], ring[j + 1], p.id, mark);
        }
      }
      // 2. Interior cells, by scanline over all rings at once so holes drop out.
      this.fillInterior(p, mark);
    }

    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      this.grid[i] = b ? Int32Array.from(new Set(b)) : EMPTY;
    }
  }

  /**
   * Marks every cell a boundary segment passes through.
   *
   * A grid traversal rather than point sampling. Sampling the segment at half
   * a cell skips any cell the line only clips the corner of, and a skipped
   * cell is a province the player cannot tap: measured on the finer map, the
   * eastern tip of Saratov reached 3.8 units into a cell that the sampler
   * never marked, so a tap there returned open sea. Halving the step again
   * would only make the sliver smaller, not remove it -- there is always a
   * corner thin enough to fall between two samples. This visits the cells the
   * segment actually crosses, so there is no sliver to miss.
   */
  private markSegment(
    x0: number, y0: number, x1: number, y1: number,
    id: number, mark: (cx: number, cy: number, id: number) => void,
  ): void {
    const c = this.cellSize;
    let cx = Math.floor((x0 - this.gridOffX) / c);
    let cy = Math.floor((y0 - this.gridOffY) / c);
    const cx1 = Math.floor((x1 - this.gridOffX) / c);
    const cy1 = Math.floor((y1 - this.gridOffY) / c);
    mark(cx, cy, id);
    if (cx === cx1 && cy === cy1) return;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    // Distance along the segment, in units of t, to the next cell boundary in
    // each axis, and the t spent crossing one whole cell.
    const tDeltaX = dx === 0 ? Infinity : Math.abs(c / dx);
    const tDeltaY = dy === 0 ? Infinity : Math.abs(c / dy);
    const nextX = this.gridOffX + (cx + (stepX > 0 ? 1 : 0)) * c;
    const nextY = this.gridOffY + (cy + (stepY > 0 ? 1 : 0)) * c;
    let tMaxX = dx === 0 ? Infinity : (nextX - x0) / dx;
    let tMaxY = dy === 0 ? Infinity : (nextY - y0) / dy;

    // Bounded so a degenerate segment cannot spin: the traversal can never
    // need more steps than the cells its bounding box spans.
    const limit = Math.abs(cx1 - cx) + Math.abs(cy1 - cy) + 2;
    for (let i = 0; i < limit; i++) {
      if (tMaxX < tMaxY) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        cy += stepY;
        tMaxY += tDeltaY;
      }
      mark(cx, cy, id);
      if (cx === cx1 && cy === cy1) return;
    }
  }

  /**
   * Marks the cells a province covers, by scanline.
   *
   * Each row is sampled at several heights rather than only at its centre. A
   * single centre sample systematically misses cells where the province occupies
   * the top or bottom of the row but not the middle -- a thin coastal strip, a
   * province tapering to a point -- and a missed cell is a province the user
   * simply cannot tap.
   */
  private fillInterior(p: Province, mark: (cx: number, cy: number, id: number) => void): void {
    const c = this.cellSize;
    const row0 = Math.floor((p.bbox[1] - this.gridOffY) / c);
    const row1 = Math.floor((p.bbox[3] - this.gridOffY) / c);
    const offsets = [0.08, 0.3, 0.5, 0.7, 0.92];
    const xs: number[] = [];
    for (let row = row0; row <= row1; row++) {
      for (const off of offsets) {
        const y = this.gridOffY + (row + off) * c;
        xs.length = 0;
        for (const ring of p.rings) {
          for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
            const yi = ring[i + 1];
            const yj = ring[j + 1];
            if ((yi > y) === (yj > y)) continue;
            xs.push(ring[i] + ((y - yi) / (yj - yi)) * (ring[j] - ring[i]));
          }
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.floor((xs[k] - this.gridOffX) / c);
          const c1 = Math.floor((xs[k + 1] - this.gridOffX) / c);
          for (let cx = c0; cx <= c1; cx++) mark(cx, row, p.id);
        }
      }
    }
  }

  /** World position to province, or null when the point is at sea. */
  pick(x: number, y: number): ProvinceId | null {
    const cx = Math.floor((x - this.gridOffX) / this.cellSize);
    const cy = Math.floor((y - this.gridOffY) / this.cellSize);
    if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) return null;
    const cands = this.grid[cy * this.gridW + cx];
    for (let i = 0; i < cands.length; i++) {
      if (this.contains(cands[i], x, y)) return cands[i];
    }
    return null;
  }

  /**
   * The province standing at a place on the Earth, or null for sea and for
   * ground this map does not draw.
   *
   * The counterpart of `get(id).lon/lat`, and the way to ask a question about
   * real geography -- who held Danzig, is Reykjavík ashore -- without
   * hand-rolling the projection at the call site.
   */
  atLonLat(lon: number, lat: number): ProvinceId | null {
    const [x, y] = this.surveyor(lon, lat);
    return this.pick(x, y);
  }

  /**
   * Forgiving pick for touch input: falls back to the nearest province within
   * `slack` world units so a fingertip landing just offshore still selects.
   */
  pickNearest(x: number, y: number, slack = 60): ProvinceId | null {
    const exact = this.pick(x, y);
    if (exact !== null) return exact;

    let best: ProvinceId | null = null;
    let bestD = slack;
    const r = Math.ceil(slack / this.cellSize);
    const cx = Math.floor((x - this.gridOffX) / this.cellSize);
    const cy = Math.floor((y - this.gridOffY) / this.cellSize);
    const seen = new Set<number>();
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gy < 0 || gx >= this.gridW || gy >= this.gridH) continue;
        for (const id of this.grid[gy * this.gridW + gx]) {
          if (seen.has(id)) continue;
          seen.add(id);
          const d = this.distanceToBoundary(id, x, y, bestD);
          if (d < bestD) { bestD = d; best = id; }
        }
      }
    }
    return best;
  }

  contains(id: ProvinceId, x: number, y: number): boolean {
    const p = this.provinces[id];
    if (x < p.bbox[0] || x > p.bbox[2] || y < p.bbox[1] || y > p.bbox[3]) return false;
    let winding = 0;
    for (const ring of p.rings) {
      let hit = false;
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const yi = ring[i + 1];
        const yj = ring[j + 1];
        if ((yi > y) !== (yj > y) && x < ((ring[j] - ring[i]) * (y - yi)) / (yj - yi) + ring[i]) {
          hit = !hit;
        }
      }
      if (hit) winding++;
    }
    return winding % 2 === 1;
  }

  private distanceToBoundary(id: ProvinceId, x: number, y: number, cutoff: number): number {
    const p = this.provinces[id];
    if (x < p.bbox[0] - cutoff || x > p.bbox[2] + cutoff) return Infinity;
    if (y < p.bbox[1] - cutoff || y > p.bbox[3] + cutoff) return Infinity;
    let best = Infinity;
    for (const ring of p.rings) {
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const ax = ring[j], ay = ring[j + 1], bx = ring[i], by = ring[i + 1];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
        if (d < best) best = d;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Adjacency + distance
  // -------------------------------------------------------------------------

  /**
   * The polyline runs two provinces actually share.
   *
   * Membership is decided by distance from a vertex of `a` to the nearest edge
   * of `b`, not by vertex equality. The two rings are simplified independently,
   * so along a boundary they agree on the line but not on where they put their
   * points -- testing for coincident vertices finds only the handful that
   * happen to survive both passes, which is enough to look like no shared
   * boundary at all. The tolerance is two orders of magnitude below the width
   * of a province, so it cannot join boundaries that are not really the same.
   *
   * This is what lets the front line follow the ground it runs along instead of
   * being a stick drawn between two centroids. Callers cache: the result only
   * changes when the map does, which is never.
   */
  sharedBorder(a: ProvinceId, b: ProvinceId): number[][] {
    const pa = this.get(a);
    const pb = this.get(b);
    // Whole-province reject before touching any geometry.
    if (pa.bbox[0] > pb.bbox[2] + SHARED_EPS || pb.bbox[0] > pa.bbox[2] + SHARED_EPS) return [];
    if (pa.bbox[1] > pb.bbox[3] + SHARED_EPS || pb.bbox[1] > pa.bbox[3] + SHARED_EPS) return [];

    const runs: number[][] = [];
    for (const ring of pa.rings) {
      const n = ring.length / 2;
      if (n < 2) continue;
      let run: number[] = [];
      // One extra step so a run crossing the ring seam is not cut in two.
      for (let i = 0; i <= n; i++) {
        const j = (i % n) * 2;
        if (i < n && this.nearRings(ring[j], ring[j + 1], pb.rings)) {
          run.push(ring[j], ring[j + 1]);
          continue;
        }
        if (run.length >= 4) runs.push(run);
        run = [];
      }
      if (run.length >= 4) runs.push(run);
    }
    return runs;
  }

  /**
   * True when a province's outline passes within SHARED_EPS of (x, y).
   *
   * The public form of the test `sharedBorder` runs internally. The border
   * mesh asks it per *edge* rather than per vertex: these polygons average
   * thirteen sides, so a boundary between two of them is two or three
   * vertices, and a run built from vertices that both rings agree on is a
   * two-point stub with nothing joining it to the next one.
   */
  outlineCarries(province: ProvinceId, x: number, y: number): boolean {
    const p = this.provinces[province];
    return p === undefined ? false : this.nearRings(x, y, p.rings);
  }

  /** True when (x, y) lies within SHARED_EPS of any edge in `rings`. */
  private nearRings(x: number, y: number, rings: readonly Float32Array[]): boolean {
    for (const r of rings) {
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = i * 2;
        const k = ((i + 1) % n) * 2;
        if (pointSegmentDistanceSq(x, y, r[j], r[j + 1], r[k], r[k + 1])
            <= SHARED_EPS * SHARED_EPS) {
          return true;
        }
      }
    }
    return false;
  }

  areAdjacent(a: ProvinceId, b: ProvinceId): boolean {
    return this.provinces[a].neighbors.includes(b) || this.provinces[a].seaNeighbors.includes(b);
  }

  isSeaLink(a: ProvinceId, b: ProvinceId): boolean {
    return this.provinces[a].seaNeighbors.includes(b);
  }

  /**
   * Great-circle distance between province centres, in kilometres.
   *
   * 「円筒図法にして、距離は別に持つ」. The map is drawn in a cylindrical frame so
   * that it looks like the game it is modelled on, and a cylindrical frame
   * stretches east-west by 1/cos(latitude): measuring in it would make the
   * Gulf of Finland twice as wide as the Adriatic when the two are the same
   * distance, and Murmansk further from Archangel than Rome is from Tunis.
   * Everything that depends on how far apart two places are -- marching,
   * shipping, supply range, the AI choosing a target -- comes through here,
   * so here is where the sphere is.
   *
   * This is on the hot path -- A* asks for it twice per edge it relaxes -- so
   * it is written to avoid trigonometry entirely. Each province is held as a
   * unit vector, which turns the angle between two of them into a dot product;
   * the straight-line chord between them follows from that, and the arc is
   * recovered from the chord by the first three terms of arcsine. Measured on
   * this machine: 90 million calls a second through `Math.acos`, 300 million
   * this way, and a full campaign ran at 16.8ms a game-day against a 16ms
   * budget with the arc cosine in place.
   *
   * The series is truncated at the seventh power, which over the widest span
   * this map holds -- Iceland to the Caspian, about 7,200km -- is worth 0.7km,
   * and under 0.1km at any distance an army would actually march. Nothing in
   * the simulation can tell the difference: a division covers 210km on its
   * best day.
   */
  distance(a: ProvinceId, b: ProvinceId): number {
    const dot = this.unitX[a] * this.unitX[b]
      + this.unitY[a] * this.unitY[b]
      + this.unitZ[a] * this.unitZ[b];
    // Half the chord, in radii. Clamped because two identical vectors can dot
    // to a hair over one and a square root of -1e-16 is not a distance.
    const c2 = 2 - 2 * dot;
    const h = c2 > 0 ? Math.sqrt(c2) / 2 : 0;
    const h2 = h * h;
    return 2 * EARTH_KM * h * (1 + h2 * (1 / 6 + h2 * (3 / 40 + h2 * (15 / 336))));
  }

  // -------------------------------------------------------------------------
  // Pathfinding
  // -------------------------------------------------------------------------

  /**
   * A* over the province graph. Returns the full node list including `from`
   * and `to`, or null when no route exists.
   */
  path(from: ProvinceId, to: ProvinceId, opts: PathOptions = {}): ProvinceId[] | null {
    if (from === to) return [from];
    const blocked = opts.blocked;
    if (blocked?.(to)) return null;

    const seaMul = opts.seaMultiplier ?? DEFAULT_SEA_MULTIPLIER;
    const allowSea = opts.allowSea ?? true;
    const costOf = opts.cost;
    const maxExp = opts.maxExpansions ?? 20000;

    const stamp = ++this.stamp;
    const { gScore, fScore, cameFrom, closed, visitStamp } = this;

    // A binary heap, not a linear scan of the open set.
    //
    // The scan was written for a 323-province map, where the comment that
    // replaced it -- "the open set stays small because the province graph is
    // tiny" -- was true. At 1,266 provinces it is not: finding the minimum
    // became the single most expensive thing the simulation does, 25.8% of a
    // twelve-year campaign's CPU time. Ties break on province id so the route
    // chosen is the same one on every machine and every run.
    let open = this.open;
    let openLen = 0;
    const less = (x: number, y: number): boolean =>
      fScore[x] < fScore[y] || (fScore[x] === fScore[y] && x < y);
    const push = (id: number): void => {
      // A node can be pushed once per improvement found before it is expanded,
      // so the heap is not bounded by the province count. Growing is rare
      // enough never to show in a profile and cheaper than being wrong.
      if (openLen >= open.length) {
        const bigger = new Int32Array(open.length * 2);
        bigger.set(open);
        open = bigger;
        this.open = bigger;
      }
      let i = openLen++;
      open[i] = id;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!less(open[i], open[parent])) break;
        const t = open[i]; open[i] = open[parent]; open[parent] = t;
        i = parent;
      }
    };
    const pop = (): number => {
      const top = open[0];
      open[0] = open[--openLen];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < openLen && less(open[l], open[best])) best = l;
        if (r < openLen && less(open[r], open[best])) best = r;
        if (best === i) break;
        const t = open[i]; open[i] = open[best]; open[best] = t;
        i = best;
      }
      return top;
    };

    visitStamp[from] = stamp;
    gScore[from] = 0;
    fScore[from] = this.distance(from, to);
    cameFrom[from] = -1;
    closed[from] = 0;
    push(from);

    let expansions = 0;
    while (openLen > 0) {
      const current = pop();

      if (current === to) return this.reconstruct(current);
      if (closed[current] === 1 && visitStamp[current] === stamp) continue;
      closed[current] = 1;
      if (++expansions > maxExp) return null;

      const p = this.provinces[current];
      for (let k = 0; k < 2; k++) {
        const list = k === 0 ? p.neighbors : p.seaNeighbors;
        if (k === 1 && !allowSea) break;
        const km = k === 0 ? p.neighborKm : p.seaNeighborKm;
        for (let i = 0; i < list.length; i++) {
          const nb = list[i];
          if (blocked?.(nb)) continue;
          if (visitStamp[nb] === stamp && closed[nb] === 1) continue;
          let step = km[i];
          if (k === 1) step *= seaMul;
          if (costOf) step *= costOf(nb);
          const tentative = gScore[current] + step;
          if (visitStamp[nb] !== stamp) {
            visitStamp[nb] = stamp;
            closed[nb] = 0;
            gScore[nb] = Infinity;
          }
          if (tentative < gScore[nb]) {
            gScore[nb] = tentative;
            cameFrom[nb] = current;
            fScore[nb] = tentative + this.distance(nb, to);
            push(nb);
          }
        }
      }
    }
    return null;
  }

  private reconstruct(end: ProvinceId): ProvinceId[] {
    const out: ProvinceId[] = [end];
    let cur = this.cameFrom[end];
    while (cur !== -1) {
      out.push(cur);
      cur = this.cameFrom[cur];
    }
    out.reverse();
    return out;
  }

  /**
   * Breadth-first reachable set, used by supply propagation and encirclement.
   *
   * `includeSea` must match whatever supply does: if supply crosses straits but
   * connectivity does not, every island reads as an encircled pocket.
   */
  reachable(
    from: ProvinceId,
    passable: (id: ProvinceId) => boolean,
    opts: { includeSea?: boolean; maxDepth?: number } = {},
  ): Set<ProvinceId> {
    const includeSea = opts.includeSea ?? false;
    const maxDepth = opts.maxDepth ?? Infinity;
    const out = new Set<ProvinceId>();
    if (!passable(from)) return out;
    out.add(from);
    let frontier = [from];
    let depth = 0;
    while (frontier.length && depth < maxDepth) {
      const next: ProvinceId[] = [];
      for (const cur of frontier) {
        const p = this.provinces[cur];
        for (const nb of p.neighbors) {
          if (out.has(nb) || !passable(nb)) continue;
          out.add(nb);
          next.push(nb);
        }
        if (includeSea) {
          for (const nb of p.seaNeighbors) {
            if (out.has(nb) || !passable(nb)) continue;
            out.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
      depth++;
    }
    return out;
  }
}

const EMPTY = new Int32Array(0);
const EMPTY_KM = new Float32Array(0);

function signedRingArea(ring: Float32Array): number {
  let s = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    s += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  }
  return s / 2;
}

/**
 * Turns a lattice position into a place on the Earth.
 *
 * Longitude is linear in the column and latitude is a polynomial in the row --
 * the fit the reference export was georeferenced with. This is the only route
 * from the drawn map back to real geography, and everything that measures a
 * distance goes through it once, at load.
 */
function geographer(
  proj: MapDataJson['projection'],
): (col: number, row: number) => [number, number] {
  const { quantum, lon0, lonStep, latPoly, latV0, latVStep } = proj;
  return (col, row) => {
    const v = latV0 + (row / quantum) * latVStep;
    let lat = 0;
    for (const c of latPoly) lat = lat * v + c;
    return [lon0 + lonStep * (col / quantum), lat];
  };
}

/**
 * Turns a place on the Earth into a render position.
 *
 * Longitude inverts in closed form; latitude does not, so the polynomial is
 * tabulated once per row and bisected. The table is the same one the fit was
 * made against, which is what keeps this and `geographer` exact inverses
 * rather than merely close.
 */
function surveyor(
  proj: MapDataJson['projection'],
): (lon: number, lat: number) => [number, number] {
  const { quantum, scale, lon0, lonStep, latPoly, latV0, latVStep } = proj;
  const latAt = (row: number): number => {
    const v = latV0 + row * latVStep;
    let lat = 0;
    for (const c of latPoly) lat = lat * v + c;
    return lat;
  };
  // The fit is monotone over the map's rows; which way it runs comes from the
  // file rather than from an assumption about north being up.
  const rows = 4096;
  const descending = latAt(0) > latAt(rows);
  return (lon, lat) => {
    let lo = 0;
    let hi = rows;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (descending ? latAt(mid) > lat : latAt(mid) < lat) lo = mid;
      else hi = mid;
    }
    return [
      ((lon - lon0) / lonStep) * quantum * scale,
      ((lo + hi) / 2) * quantum * scale,
    ];
  };
}

/**
 * Expands a ring of signed arc references into a flat outline.
 *
 * `i` reads arc `i` forward, `~i` reads it backwards. Each arc ends where the
 * next begins, so the shared endpoint is written once.
 */
function assembleRing(refs: number[], arcs: Float32Array[]): Float32Array {
  let n = 0;
  for (const ref of refs) n += (arcs[ref >= 0 ? ref : ~ref].length / 2) - 1;
  const out = new Float32Array(n * 2);
  let k = 0;
  for (const ref of refs) {
    const arc = arcs[ref >= 0 ? ref : ~ref];
    const m = arc.length / 2;
    if (ref >= 0) {
      for (let i = 0; i < m - 1; i++) { out[k++] = arc[i * 2]; out[k++] = arc[i * 2 + 1]; }
    } else {
      for (let i = m - 1; i > 0; i--) { out[k++] = arc[i * 2]; out[k++] = arc[i * 2 + 1]; }
    }
  }
  return out;
}

/**
 * Rebuilds a province's outlines from the shared arc table.
 *
 * The file stores every boundary once and each province names the arcs its
 * rings are made of, so two neighbours are guaranteed the same vertices rather
 * than merely simplified to nearly the same ones. Expanding them here costs a
 * few milliseconds at load and means nothing downstream has to know.
 */
function toProvince(
  p: ProvinceGeoJson, arcs: Float32Array[], scale: number,
  place: (col: number, row: number) => [number, number],
): Province {
  const rings = p.rings.map((refs) => assembleRing(refs, arcs));
  // Outer rings and holes are told apart by which way they wind: the build
  // walks every ring with the province on its left, so a hole comes back with
  // the opposite sign from the outline it sits in.
  const areas = rings.map(signedRingArea);
  const outerSign = Math.sign(areas.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0));
  const [lon, lat] = place(p.center[0], p.center[1]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < minX) minX = r[i];
      if (r[i] > maxX) maxX = r[i];
      if (r[i + 1] < minY) minY = r[i + 1];
      if (r[i + 1] > maxY) maxY = r[i + 1];
    }
  }
  return {
    id: p.id,
    name: p.name,
    stateId: p.stateId,
    ownerTag: p.ownerTag,
    terrain: p.terrain,
    vp: p.vp,
    coastal: p.coastal,
    rings,
    ringDepth: areas.map((a) => (Math.sign(a) === outerSign ? 0 : 1)),
    centerX: p.center[0] * scale,
    centerY: p.center[1] * scale,
    lon,
    lat,
    area: p.area,
    neighbors: p.neighbors,
    seaNeighbors: p.seaNeighbors,
    // Filled once the whole index exists, since they are distances between
    // provinces and no province can measure to another on its own.
    neighborKm: EMPTY_KM,
    seaNeighborKm: EMPTY_KM,
    bbox: [minX, minY, maxX, maxY],
  };
}
