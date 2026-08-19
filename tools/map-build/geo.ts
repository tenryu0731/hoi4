/** Geometry helpers for the map build. Build-time only -- never shipped. */

export type Pt = [number, number];
export type Ring = Pt[];
export type Poly = Ring[];          // [outer, ...holes]

export interface Bbox {
  minLon: number; maxLon: number; minLat: number; maxLat: number;
}

// ---------------------------------------------------------------------------
// Lambert Conformal Conic -- the standard choice for mid-latitude Europe.
// ---------------------------------------------------------------------------

export interface LccParams {
  lon0: number; lat0: number; lat1: number; lat2: number;
  /** World units per earth radian at the reference parallel. */
  scale: number;
  offsetX: number; offsetY: number;
}

const D2R = Math.PI / 180;

function coneConstant(lat1: number, lat2: number): number {
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  if (Math.abs(lat1 - lat2) < 1e-9) return Math.sin(p1);
  return (
    Math.log(Math.cos(p1) / Math.cos(p2)) /
    Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2))
  );
}

export function projectLcc(lon: number, lat: number, p: LccParams): Pt {
  const n = coneConstant(p.lat1, p.lat2);
  const phi = Math.max(-89.9, Math.min(89.9, lat)) * D2R;
  const phi1 = p.lat1 * D2R;
  const phi0 = p.lat0 * D2R;
  const F = (Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n)) / n;
  const rho = F / Math.pow(Math.tan(Math.PI / 4 + phi / 2), n);
  const rho0 = F / Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n);
  let dl = (lon - p.lon0) * D2R;
  while (dl > Math.PI) dl -= 2 * Math.PI;
  while (dl < -Math.PI) dl += 2 * Math.PI;
  const theta = n * dl;
  const x = rho * Math.sin(theta);
  // Flip y so that north is up on screen (Pixi's y grows downward).
  const y = -(rho0 - rho * Math.cos(theta));
  return [x * p.scale + p.offsetX, y * p.scale + p.offsetY];
}

// ---------------------------------------------------------------------------
// Clipping (Sutherland-Hodgman against an axis-aligned rectangle, lon/lat space)
// ---------------------------------------------------------------------------

type Side = 'left' | 'right' | 'bottom' | 'top';

function inside(p: Pt, side: Side, b: Bbox): boolean {
  switch (side) {
    case 'left': return p[0] >= b.minLon;
    case 'right': return p[0] <= b.maxLon;
    case 'bottom': return p[1] >= b.minLat;
    case 'top': return p[1] <= b.maxLat;
  }
}

function intersect(a: Pt, b: Pt, side: Side, box: Bbox): Pt {
  const [ax, ay] = a, [bx, by] = b;
  switch (side) {
    case 'left': { const t = (box.minLon - ax) / (bx - ax); return [box.minLon, ay + t * (by - ay)]; }
    case 'right': { const t = (box.maxLon - ax) / (bx - ax); return [box.maxLon, ay + t * (by - ay)]; }
    case 'bottom': { const t = (box.minLat - ay) / (by - ay); return [ax + t * (bx - ax), box.minLat]; }
    case 'top': { const t = (box.maxLat - ay) / (by - ay); return [ax + t * (bx - ax), box.maxLat]; }
  }
}

/** Clips a ring to the bbox. Returns [] when the ring falls entirely outside. */
export function clipRing(ring: Ring, box: Bbox): Ring {
  let out = ring;
  for (const side of ['left', 'right', 'bottom', 'top'] as Side[]) {
    const input = out;
    out = [];
    if (input.length === 0) break;
    let prev = input[input.length - 1];
    let prevIn = inside(prev, side, box);
    for (const cur of input) {
      const curIn = inside(cur, side, box);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur, side, box));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur, side, box));
      }
      prev = cur;
      prevIn = curIn;
    }
  }
  return out;
}

export function bboxOfRing(ring: Ring): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// ---------------------------------------------------------------------------
// Ring measures
// ---------------------------------------------------------------------------

/** Signed area; positive when the ring winds counter-clockwise. */
export function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

export function ringArea(ring: Ring): number {
  return Math.abs(signedArea(ring));
}

export function pointInRing(x: number, y: number, ring: Ring): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

export function pointInPoly(x: number, y: number, poly: Poly): boolean {
  if (!pointInRing(x, y, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(x, y, poly[i])) return false;
  return true;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToPolyBoundary(x: number, y: number, poly: Poly): number {
  let best = Infinity;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const d = distToSegment(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Pole of inaccessibility: the interior point furthest from any edge. Labels and
 * unit counters go here -- a plain centroid falls outside concave shapes like
 * Norway or Croatia.
 */
export function poleOfInaccessibility(poly: Poly, precision = 0.6): Pt {
  const [minX, minY, maxX, maxY] = bboxOfRing(poly[0]);
  const w = maxX - minX, h = maxY - minY;
  const cellSize = Math.min(w, h) / 8 || 1;

  interface Cell { x: number; y: number; h: number; d: number; max: number }
  const makeCell = (x: number, y: number, half: number): Cell => {
    const inner = pointInPoly(x, y, poly);
    const d = (inner ? 1 : -1) * distToPolyBoundary(x, y, poly);
    return { x, y, h: half, d, max: d + half * Math.SQRT2 };
  };

  const queue: Cell[] = [];
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) {
      queue.push(makeCell(x + cellSize / 2, y + cellSize / 2, cellSize / 2));
    }
  }
  let best = makeCell(minX + w / 2, minY + h / 2, 0);
  let guard = 0;
  while (queue.length && guard++ < 20000) {
    queue.sort((a, b) => b.max - a.max);
    const cell = queue.shift()!;
    if (cell.d > best.d) best = cell;
    if (cell.max - best.d <= precision) continue;
    const half = cell.h / 2;
    queue.push(makeCell(cell.x - half, cell.y - half, half));
    queue.push(makeCell(cell.x + half, cell.y - half, half));
    queue.push(makeCell(cell.x - half, cell.y + half, half));
    queue.push(makeCell(cell.x + half, cell.y + half, half));
  }
  return [best.x, best.y];
}

/** Minimum distance from any vertex of `a` to any segment of `b`. */
export function ringDistance(a: Ring, b: Ring): number {
  let best = Infinity;
  for (const [px, py] of a) {
    for (let i = 0, j = b.length - 1; i < b.length; j = i++) {
      const d = distToSegment(px, py, b[j][0], b[j][1], b[i][0], b[i][1]);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

/** Closest pair of points between two rings, vertex-to-segment both ways. */
export function closestApproach(a: Ring, b: Ring): { dist: number; pa: Pt; pb: Pt } {
  let best = Infinity;
  let pa: Pt = a[0];
  let pb: Pt = b[0];
  const consider = (px: number, py: number, ring: Ring, flip: boolean) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = ring[j][0], ay = ring[j][1], bx = ring[i][0], by = ring[i][1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      const d = Math.hypot(px - cx, py - cy);
      if (d < best) {
        best = d;
        if (flip) { pa = [cx, cy]; pb = [px, py]; }
        else { pa = [px, py]; pb = [cx, cy]; }
      }
    }
  };
  for (const [px, py] of a) consider(px, py, b, false);
  for (const [px, py] of b) consider(px, py, a, true);
  return { dist: best, pa, pb };
}

/**
 * Scanline raster of a set of rings, used as a fast "is this point on land"
 * oracle when deciding whether a short gap between two coasts is really water.
 */
export class LandMask {
  private grid: Uint8Array;
  constructor(
    private minX: number,
    private minY: number,
    private cell: number,
    private w: number,
    private h: number,
  ) {
    this.grid = new Uint8Array(w * h);
  }

  static build(rings: Ring[], bounds: [number, number, number, number], cell: number): LandMask {
    const [minX, minY, maxX, maxY] = bounds;
    const w = Math.ceil((maxX - minX) / cell) + 2;
    const h = Math.ceil((maxY - minY) / cell) + 2;
    const mask = new LandMask(minX, minY, cell, w, h);
    for (const ring of rings) mask.fillRing(ring);
    return mask;
  }

  private fillRing(ring: Ring): void {
    let minY = Infinity, maxY = -Infinity;
    for (const p of ring) {
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const row0 = Math.max(0, Math.floor((minY - this.minY) / this.cell));
    const row1 = Math.min(this.h - 1, Math.ceil((maxY - this.minY) / this.cell));
    const xs: number[] = [];
    for (let row = row0; row <= row1; row++) {
      const y = this.minY + (row + 0.5) * this.cell;
      xs.length = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const yi = ring[i][1], yj = ring[j][1];
        if ((yi > y) === (yj > y)) continue;
        const xi = ring[i][0], xj = ring[j][0];
        xs.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        // XOR fill so that holes punched by inner rings cancel out.
        const c0 = Math.max(0, Math.floor((xs[k] - this.minX) / this.cell));
        const c1 = Math.min(this.w - 1, Math.ceil((xs[k + 1] - this.minX) / this.cell));
        const base = row * this.w;
        for (let c = c0; c <= c1; c++) this.grid[base + c] ^= 1;
      }
    }
  }

  isLand(x: number, y: number): boolean {
    const c = Math.floor((x - this.minX) / this.cell);
    const r = Math.floor((y - this.minY) / this.cell);
    if (c < 0 || r < 0 || c >= this.w || r >= this.h) return false;
    return this.grid[r * this.w + c] !== 0;
  }
}
