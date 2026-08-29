import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MapProjection } from '../../src/sim/map/MapData';
import type { Pt } from './geo';

/**
 * The reference map, read as geometry rather than as a hint.
 *
 * 「Natural Earth の海岸線じゃなくて画像の線を使え」. Every line the map draws now
 * comes from the Hearts of Iron IV export: its coastline, its province
 * borders, its state borders. Natural Earth is still read, but only for things
 * that are facts rather than shapes -- who owned what in 1936, where the towns
 * are, which rivers are worth drawing.
 *
 * The export is a raster of cell ids, so the geometry has to be traced out of
 * it. Tracing each cell on its own would tear the map apart the moment
 * anything is simplified -- two neighbours drop different vertices and a
 * sliver of sea opens between them -- so this walks the boundary *edges* of
 * the lattice instead, cuts them into arcs at every junction, and hands each
 * arc to both of the cells that share it. Simplify an arc once and both sides
 * move together, exactly.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, 'reference', 'hoi4-cells.json');

/** Cell id for anything off the edge of the export. */
export const OUTSIDE = 65535;
/** Cell id for sea, lakes, and any other water the export painted blue. */
export const WATER = 0;

interface CellsFile {
  width: number; height: number;
  states: number; provinces: number;
  lon0: number; lonStep: number;
  latPoly: number[]; latY0: number; latScale: number;
  stateCells: string; provinceCells: string;
}

export interface ReferenceRaster {
  w: number;
  h: number;
  provinces: Uint16Array;
  states: Uint16Array;
  provinceCount: number;
  stateCount: number;
  /** lon = lon0 + lonStep * column. */
  lon0: number;
  lonStep: number;
  /** The fit that turns a row into a latitude, for the runtime to reuse. */
  latPoly: number[];
  latV0: number;
  latVStep: number;
  /** The wire-format projection block, given the render scale and quantum. */
  projection(scale: number, quantum: number): MapProjection;
  /** Longitude of a lattice column. Fractional columns are fine. */
  lonOf(col: number): number;
  /** Latitude of a lattice row. Fractional rows are fine. */
  latOf(row: number): number;
  /** The row a latitude falls on, or -1 off the map. */
  rowOfLat(lat: number): number;
}

let cached: ReferenceRaster | null = null;

export function loadReference(): ReferenceRaster {
  if (cached) return cached;
  const doc = JSON.parse(readFileSync(FILE, 'utf8')) as CellsFile;
  const grid = (b64: string): Uint16Array => {
    const raw = gunzipSync(Buffer.from(b64, 'base64'));
    return new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  };
  const w = doc.width;
  const h = doc.height;
  const v0 = doc.latY0 / 6000;
  const vStep = doc.latScale;
  const latOf = (row: number): number => {
    const v = v0 + row * vStep;
    let y = 0;
    for (const c of doc.latPoly) y = y * v + c;
    return y;
  };
  cached = {
    w, h,
    provinces: grid(doc.provinceCells), states: grid(doc.stateCells),
    provinceCount: doc.provinces, stateCount: doc.states,
    lon0: doc.lon0, lonStep: doc.lonStep,
    latPoly: doc.latPoly, latV0: v0, latVStep: vStep,
    projection: (scale, quantum) => ({
      name: 'reference' as const,
      scale, quantum,
      lon0: doc.lon0, lonStep: doc.lonStep,
      latPoly: doc.latPoly, latV0: v0, latVStep: vStep,
    }),
    lonOf: (col) => doc.lon0 + col * doc.lonStep,
    latOf,
    // The polynomial runs the other way, so it is inverted by bisection. It is
    // monotone over the window the map covers, which is what makes that safe.
    rowOfLat: (lat) => {
      const top = latOf(0);
      const bottom = latOf(h - 1);
      if (lat > Math.max(top, bottom) || lat < Math.min(top, bottom)) return -1;
      let lo = 0;
      let hi = h - 1;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if ((latOf(mid) > lat) === (top > bottom)) lo = mid;
        else hi = mid;
      }
      return Math.round((lo + hi) / 2);
    },
  };
  return cached;
}

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

export interface RasterTopology {
  /** Arcs in lattice-corner coordinates: [col, row], both integers. */
  arcs: Pt[][];
  /** For each arc, the cell on its left and on its right as walked forward. */
  sides: { left: number; right: number }[];
  /**
   * For each cell, its rings. A ring is a list of signed arc references: `i`
   * uses arc `i` forward, `~i` uses it reversed. Every ring is wound with the
   * cell on the left, so an outer boundary and a hole come out with opposite
   * signed areas without anything having to test containment.
   */
  rings: Map<number, number[][]>;
}

/** Bit per direction in the exit mask: east, south, west, north. */
const E = 1; const S = 2; const W = 4; const N = 8;
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * Cuts a grid of cell ids into shared arcs.
 *
 * The lattice has (w+1) x (h+1) corners. A horizontal edge at corner row `r`
 * spanning columns c..c+1 separates the pixel above from the pixel below; a
 * vertical edge at corner column `c` spanning rows r..r+1 separates the pixel
 * to its west from the pixel to its east. An edge is a boundary when those two
 * pixels carry different ids -- which is also true at the water's edge and at
 * the edge of the export, because both of those are ids too.
 */
export function traceGrid(cells: Uint16Array, w: number, h: number): RasterTopology {
  const cw = w + 1;
  const at = (r: number, c: number): number => (
    r < 0 || r >= h || c < 0 || c >= w ? OUTSIDE : cells[r * w + c]
  );

  // Boundary edges, addressed by their west/north corner: `hor` runs east from
  // the corner, `ver` runs south from it.
  const hor = new Uint8Array(cw * (h + 1));
  const ver = new Uint8Array(cw * (h + 1));
  for (let r = 0; r <= h; r++) {
    const above = r - 1;
    for (let c = 0; c < w; c++) {
      if (at(above, c) !== at(r, c)) hor[r * cw + c] = 1;
    }
  }
  for (let r = 0; r < h; r++) {
    for (let c = 0; c <= w; c++) {
      if (at(r, c - 1) !== at(r, c)) ver[r * cw + c] = 1;
    }
  }

  /** Which boundary edges leave a corner, as a bit mask. */
  const exits = (c: number, r: number): number => {
    const i = r * cw + c;
    let m = 0;
    if (c < w && hor[i] === 1) m |= E;
    if (r < h && ver[i] === 1) m |= S;
    if (c > 0 && hor[i - 1] === 1) m |= W;
    if (r > 0 && ver[i - cw] === 1) m |= N;
    return m;
  };

  /** The cells either side of the edge leaving (c, r) in `dir`, as one key. */
  const pairOf = (c: number, r: number, dir: number): number => {
    const a = leftOf(at, c, r, dir);
    const b = rightOf(at, c, r, dir);
    return a < b ? a * 70000 + b : b * 70000 + a;
  };

  /**
   * A corner is a junction unless exactly two boundaries pass through it and
   * both separate the same two cells. Anything else -- three cells meeting, a
   * checkerboard, the corner of the export -- has to end an arc, or the arc on
   * one side would not match the arc on the other.
   */
  const isNode = (c: number, r: number, m: number): boolean => {
    if (m !== (E | W) && m !== (N | S) && m !== (E | S) && m !== (E | N)
      && m !== (W | S) && m !== (W | N)) return true;
    let first = -1;
    for (let d = 0; d < 4; d++) {
      if ((m & (1 << d)) === 0) continue;
      if (first < 0) first = pairOf(c, r, d);
      else return first !== pairOf(c, r, d);
    }
    return true;
  };

  const arcs: Pt[][] = [];
  const sides: { left: number; right: number }[] = [];
  const usedH = new Uint8Array(cw * (h + 1));
  const usedV = new Uint8Array(cw * (h + 1));
  const slot = (c: number, r: number, dir: number): [Uint8Array, number] => (
    dir === 0 ? [usedH, r * cw + c]
      : dir === 1 ? [usedV, r * cw + c]
        : dir === 2 ? [usedH, r * cw + c - 1]
          : [usedV, (r - 1) * cw + c]
  );

  /** Walks one arc onward from a corner until it reaches a junction. */
  const walk = (c0: number, r0: number, dir0: number, stopAtStart: boolean): void => {
    const pts: Pt[] = [[c0, r0]];
    const left = leftOf(at, c0, r0, dir0);
    const right = rightOf(at, c0, r0, dir0);
    let c = c0;
    let r = r0;
    let dir = dir0;
    for (let guard = 0; guard < 4 * (w + h) * 64; guard++) {
      const [arr, i] = slot(c, r, dir);
      arr[i] = 1;
      c += DX[dir];
      r += DY[dir];
      pts.push([c, r]);
      if (stopAtStart ? (c === c0 && r === r0) : isNode(c, r, exits(c, r))) break;
      const m = exits(c, r);
      const back = (dir + 2) % 4;
      let next = -1;
      for (let d = 0; d < 4; d++) if (d !== back && (m & (1 << d)) !== 0) { next = d; break; }
      if (next < 0) break;
      dir = next;
    }
    arcs.push(pts);
    sides.push({ left, right });
  };

  for (let r = 0; r <= h; r++) {
    for (let c = 0; c <= w; c++) {
      const m = exits(c, r);
      if (m === 0 || !isNode(c, r, m)) continue;
      for (let d = 0; d < 4; d++) {
        if ((m & (1 << d)) === 0) continue;
        const [arr, i] = slot(c, r, d);
        if (arr[i] === 1) continue;
        walk(c, r, d, false);
      }
    }
  }

  // Loops with no junction at all: an island in open sea, a lake inside one
  // province. Nothing above will have started them, because they have no node.
  for (let r = 0; r <= h; r++) {
    for (let c = 0; c < w; c++) {
      if (hor[r * cw + c] === 0 || usedH[r * cw + c] === 1) continue;
      walk(c, r, 0, true);
    }
  }

  return { arcs, sides, rings: assembleRings(arcs, sides) };
}

/**
 * Which cell lies to the left of an edge leaving corner (c, r) in `dir`.
 *
 * The lattice runs x east and y south, so facing south the left hand points
 * east. Getting this backwards would not fail loudly -- every ring would come
 * out inside out, and every outer boundary would read as a hole.
 */
function leftOf(
  at: (r: number, c: number) => number, c: number, r: number, dir: number,
): number {
  switch (dir) {
    case 0: return at(r - 1, c);      // east: north side
    case 1: return at(r, c);          // south: east side
    case 2: return at(r, c - 1);      // west: south side
    default: return at(r - 1, c - 1); // north: west side
  }
}

function rightOf(
  at: (r: number, c: number) => number, c: number, r: number, dir: number,
): number {
  switch (dir) {
    case 0: return at(r, c);
    case 1: return at(r, c - 1);
    case 2: return at(r - 1, c - 1);
    default: return at(r - 1, c);
  }
}

/**
 * Chains each cell's arcs into closed rings, wound with the cell on the left.
 *
 * Arcs meet only at their endpoints, so the chain is found by looking up which
 * arc starts where the last one ended. A cell that pinches to a point has
 * several candidates at that corner; taking the sharpest left turn keeps the
 * ring on the correct side of the pinch instead of cutting across it.
 */
function assembleRings(
  arcs: Pt[][], sides: { left: number; right: number }[],
): Map<number, number[][]> {
  const byCell = new Map<number, number[]>();
  const push = (cell: number, ref: number): void => {
    if (cell === OUTSIDE) return;
    const list = byCell.get(cell);
    if (list) list.push(ref); else byCell.set(cell, [ref]);
  };
  for (let i = 0; i < arcs.length; i++) {
    push(sides[i].left, i);
    push(sides[i].right, ~i);
  }

  const out = new Map<number, number[][]>();
  for (const [cell, refs] of byCell) out.set(cell, chainRings(refs, arcs));
  return out;
}

/**
 * Chains signed arc references into closed rings.
 *
 * Arcs meet only at their endpoints, so the chain is found by looking up which
 * arc starts where the last one ended. Several may: a cell that pinches to a
 * point has two, and a headland where three provinces meet the sea has three.
 * Taking whichever comes first threads the ring through the wrong one and ties
 * two separate loops together: the land silhouette came out as 263 rings that
 * way and 285 this way, the difference being islands welded to the mainland
 * through a shared corner. Turning as far left as the incoming heading allows
 * keeps the ring on its own side of the junction.
 */
export function chainRings(refs: readonly number[], arcs: Pt[][]): number[][] {
  const head = (ref: number): Pt => (ref >= 0 ? arcs[ref][0] : last(arcs[~ref]));
  const tail = (ref: number): Pt => (ref >= 0 ? last(arcs[ref]) : arcs[~ref][0]);
  // The direction the ring leaves this arc's start, or arrives at its end,
  // reading the arc in whichever sense the ref asks for.
  const heading = (ref: number, atStart: boolean): number => {
    const pts = ref >= 0 ? arcs[ref] : arcs[~ref];
    const n = pts.length;
    const [a, b] = ref >= 0
      ? (atStart ? [pts[0], pts[1]] : [pts[n - 2], pts[n - 1]])
      : (atStart ? [pts[n - 1], pts[n - 2]] : [pts[1], pts[0]]);
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };

  const open = new Map<string, number[]>();
  for (const ref of refs) {
    const k = key(head(ref));
    const list = open.get(k);
    if (list) list.push(ref); else open.set(k, [ref]);
  }
  const used = new Set<number>();
  const rings: number[][] = [];
  for (const seed of refs) {
    if (used.has(seed)) continue;
    const ring: number[] = [];
    let cur = seed;
    for (let guard = 0; guard <= refs.length; guard++) {
      used.add(cur);
      ring.push(cur);
      const at = key(tail(cur));
      const candidates = (open.get(at) ?? []).filter((r) => !used.has(r));
      if (candidates.length === 0) break;
      if (candidates.length === 1) { cur = candidates[0]; continue; }
      const inbound = heading(cur, false);
      let best = candidates[0];
      let bestTurn = -Infinity;
      for (const c of candidates) {
        let turn = heading(c, true) - inbound;
        while (turn <= -Math.PI) turn += 2 * Math.PI;
        while (turn > Math.PI) turn -= 2 * Math.PI;
        if (turn > bestTurn) { bestTurn = turn; best = c; }
      }
      cur = best;
    }
    if (ring.length > 0) rings.push(ring);
  }
  return rings;
}

const last = (pts: Pt[]): Pt => pts[pts.length - 1];
const key = (p: Pt): string => `${p[0]},${p[1]}`;

/** Expands a ring of signed arc refs into a closed polyline. */
export function ringPoints(ring: number[], arcs: Pt[][]): Pt[] {
  const out: Pt[] = [];
  for (const ref of ring) {
    const pts = ref >= 0 ? arcs[ref] : arcs[~ref];
    if (ref >= 0) for (let i = 0; i < pts.length - 1; i++) out.push(pts[i]);
    else for (let i = pts.length - 1; i > 0; i--) out.push(pts[i]);
  }
  return out;
}
