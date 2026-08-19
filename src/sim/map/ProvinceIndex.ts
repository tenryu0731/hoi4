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
  area: number;
  neighbors: ProvinceId[];
  seaNeighbors: ProvinceId[];
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

export class ProvinceIndex {
  readonly provinces: Province[];
  readonly bounds: [number, number, number, number];
  readonly data: MapDataJson;

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
  private stamp = 0;

  private constructor(data: MapDataJson) {
    this.data = data;
    this.bounds = data.bounds;
    this.provinces = data.provinces.map(toProvince);

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

  private markSegment(
    x0: number, y0: number, x1: number, y1: number,
    id: number, mark: (cx: number, cy: number, id: number) => void,
  ): void {
    const c = this.cellSize;
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (c * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      mark(Math.floor((x - this.gridOffX) / c), Math.floor((y - this.gridOffY) / c), id);
    }
  }

  private fillInterior(p: Province, mark: (cx: number, cy: number, id: number) => void): void {
    const c = this.cellSize;
    const row0 = Math.floor((p.bbox[1] - this.gridOffY) / c);
    const row1 = Math.floor((p.bbox[3] - this.gridOffY) / c);
    const xs: number[] = [];
    for (let row = row0; row <= row1; row++) {
      const y = this.gridOffY + (row + 0.5) * c;
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

  areAdjacent(a: ProvinceId, b: ProvinceId): boolean {
    return this.provinces[a].neighbors.includes(b) || this.provinces[a].seaNeighbors.includes(b);
  }

  isSeaLink(a: ProvinceId, b: ProvinceId): boolean {
    return this.provinces[a].seaNeighbors.includes(b);
  }

  /** Straight-line distance between province centres, in kilometres. */
  distance(a: ProvinceId, b: ProvinceId): number {
    const pa = this.provinces[a];
    const pb = this.provinces[b];
    return Math.hypot(pa.centerX - pb.centerX, pa.centerY - pb.centerY);
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

    const open: number[] = [from];
    visitStamp[from] = stamp;
    gScore[from] = 0;
    fScore[from] = this.distance(from, to);
    cameFrom[from] = -1;
    closed[from] = 0;

    let expansions = 0;
    while (open.length > 0) {
      // Linear scan beats a heap here: the open set stays small because the
      // province graph is tiny and the heuristic is strong.
      let bestIdx = 0;
      for (let i = 1; i < open.length; i++) {
        if (fScore[open[i]] < fScore[open[bestIdx]]) bestIdx = i;
      }
      const current = open[bestIdx];
      open[bestIdx] = open[open.length - 1];
      open.pop();

      if (current === to) return this.reconstruct(current);
      if (closed[current] === 1 && visitStamp[current] === stamp) continue;
      closed[current] = 1;
      if (++expansions > maxExp) return null;

      const p = this.provinces[current];
      for (let k = 0; k < 2; k++) {
        const list = k === 0 ? p.neighbors : p.seaNeighbors;
        if (k === 1 && !allowSea) break;
        for (const nb of list) {
          if (blocked?.(nb)) continue;
          if (visitStamp[nb] === stamp && closed[nb] === 1) continue;
          let step = this.distance(current, nb);
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
            open.push(nb);
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

  /** Breadth-first reachable set, used by supply propagation and encirclement. */
  reachable(
    from: ProvinceId,
    passable: (id: ProvinceId) => boolean,
    maxDepth = Infinity,
  ): Set<ProvinceId> {
    const out = new Set<ProvinceId>();
    if (!passable(from)) return out;
    out.add(from);
    let frontier = [from];
    let depth = 0;
    while (frontier.length && depth < maxDepth) {
      const next: ProvinceId[] = [];
      for (const cur of frontier) {
        for (const nb of this.provinces[cur].neighbors) {
          if (out.has(nb) || !passable(nb)) continue;
          out.add(nb);
          next.push(nb);
        }
      }
      frontier = next;
      depth++;
    }
    return out;
  }
}

const EMPTY = new Int32Array(0);

function toProvince(p: ProvinceGeoJson): Province {
  const rings = p.rings.map((r) => Float32Array.from(r));
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
    ringDepth: p.ringDepth,
    centerX: p.center[0],
    centerY: p.center[1],
    area: p.area,
    neighbors: p.neighbors,
    seaNeighbors: p.seaNeighbors,
    bbox: [minX, minY, maxX, maxY],
  };
}
