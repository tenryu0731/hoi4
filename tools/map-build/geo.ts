/**
 * Geometry helpers for the map build. Build-time only -- never shipped.
 *
 * There used to be a great deal more here: a Lambert Conformal Conic
 * projection, a land raster, a pole-of-inaccessibility search, closest
 * approach between rings, ring simplification by area. All of it existed to
 * make a map out of Natural Earth's coastline. The map is traced out of the
 * reference export now, where adjacency, coastline and area are read off the
 * lattice, so what is left is the one thing Natural Earth is still asked for:
 * clipping its administrative rings to the window.
 */

export type Pt = [number, number];
export type Ring = Pt[];
export type Poly = Ring[];          // [outer, ...holes]

export interface Bbox {
  minLon: number; maxLon: number; minLat: number; maxLat: number;
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

