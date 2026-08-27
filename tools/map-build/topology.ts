import type { Pt, Ring } from './geo';

/**
 * Minimal topology builder in the spirit of TopoJSON.
 *
 * Simplifying each country polygon independently tears shared borders apart:
 * two neighbours drop different vertices and a sliver of ocean appears between
 * them. So we cut every ring into arcs at junction points, simplify each unique
 * arc exactly once, and stitch the rings back together. As a bonus, arcs shared
 * by two regions give us land adjacency for free and exactly.
 */

export interface RegionInput {
  key: string;
  rings: Ring[];
}

export interface ArcRef {
  arc: number;
  reversed: boolean;
}

export interface Topology {
  /** Unique arcs, each an open polyline whose endpoints are junctions. */
  arcs: Pt[][];
  /** Region key to rings, each ring expressed as an ordered list of arc refs. */
  regions: Map<string, ArcRef[][]>;
  /** Arc index to the set of region keys that use it. */
  arcOwners: Map<number, Set<string>>;
}

const PREC = 1e6;
const keyOf = (p: Pt): string => `${Math.round(p[0] * PREC)}|${Math.round(p[1] * PREC)}`;

export function buildTopology(regions: RegionInput[]): Topology {
  // --- 1. Junction detection -----------------------------------------------
  // A point is a junction when different rings pass through it with different
  // neighbours, i.e. where a shared border starts or stops being shared.
  const seen = new Map<string, string>();
  const junctions = new Set<string>();

  const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

  for (const region of regions) {
    for (const ring of region.rings) {
      const keys = ring.map(keyOf);
      const n = keys.length;
      for (let i = 0; i < n; i++) {
        const cur = keys[i];
        const pk = pairKey(keys[(i - 1 + n) % n], keys[(i + 1) % n]);
        const before = seen.get(cur);
        if (before === undefined) seen.set(cur, pk);
        else if (before !== pk) junctions.add(cur);
      }
    }
  }

  // --- 2. Cut rings into arcs ----------------------------------------------
  const arcs: Pt[][] = [];
  const arcIndex = new Map<string, number>();
  const arcOwners = new Map<number, Set<string>>();
  const out = new Map<string, ArcRef[][]>();

  const signature = (pts: Pt[]): { sig: string; reversed: boolean } => {
    const keys = pts.map(keyOf);
    const fwd = keys.join(';');
    const rev = keys.slice().reverse().join(';');
    return fwd <= rev ? { sig: fwd, reversed: false } : { sig: rev, reversed: true };
  };

  const addArc = (pts: Pt[], owner: string): ArcRef => {
    const { sig, reversed } = signature(pts);
    let idx = arcIndex.get(sig);
    if (idx === undefined) {
      idx = arcs.length;
      arcs.push(reversed ? pts.slice().reverse() : pts);
      arcIndex.set(sig, idx);
      arcOwners.set(idx, new Set());
    }
    arcOwners.get(idx)!.add(owner);
    return { arc: idx, reversed };
  };

  for (const region of regions) {
    const ringRefs: ArcRef[][] = [];
    for (const ring of region.rings) {
      const keys = ring.map(keyOf);
      const n = keys.length;
      const cutAt: number[] = [];
      for (let i = 0; i < n; i++) if (junctions.has(keys[i])) cutAt.push(i);

      const refs: ArcRef[] = [];
      if (cutAt.length === 0) {
        // No junction: the whole ring is one closed arc (coast, island, enclave).
        refs.push(addArc([...ring, ring[0]], region.key));
      } else {
        for (let c = 0; c < cutAt.length; c++) {
          const start = cutAt[c];
          const end = cutAt[(c + 1) % cutAt.length];
          const pts: Pt[] = [];
          let i = start;
          for (;;) {
            pts.push(ring[i]);
            if (i === end && pts.length > 1) break;
            i = (i + 1) % n;
            if (pts.length > n + 1) break;
          }
          if (pts.length >= 2) refs.push(addArc(pts, region.key));
        }
      }
      ringRefs.push(refs);
    }
    out.set(region.key, ringRefs);
  }

  return { arcs, regions: out, arcOwners };
}

/**
 * Visvalingam-Whyatt: repeatedly drop the vertex whose triangle with its two
 * neighbours has the smallest area. Endpoints are pinned so arcs stay stitched.
 */
export function simplifyArc(pts: Pt[], areaThreshold: number, minPoints = 2): Pt[] {
  const n = pts.length;
  if (n <= minPoints || n < 3) return pts;

  const alive = new Uint8Array(n);
  alive.fill(1);
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1;
    next[i] = i + 1;
  }
  next[n - 1] = -1;

  const triArea = (i: number): number => {
    const a = prev[i];
    const b = next[i];
    if (a < 0 || b < 0) return Infinity;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[i];
    const [cx, cy] = pts[b];
    return Math.abs((ax - cx) * (by - ay) - (ax - bx) * (cy - ay)) / 2;
  };

  const area = new Float64Array(n);
  for (let i = 0; i < n; i++) area[i] = triArea(i);

  let live = n;
  for (;;) {
    let bestIdx = -1;
    let bestArea = Infinity;
    for (let i = 1; i < n - 1; i++) {
      if (!alive[i]) continue;
      if (area[i] < bestArea) {
        bestArea = area[i];
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestArea >= areaThreshold || live <= minPoints) break;
    alive[bestIdx] = 0;
    live--;
    const a = prev[bestIdx];
    const b = next[bestIdx];
    next[a] = b;
    if (b >= 0) prev[b] = a;
    if (a > 0) area[a] = triArea(a);
    if (b >= 0 && b < n - 1) area[b] = triArea(b);
  }

  const outPts: Pt[] = [];
  for (let i = 0; i < n; i++) if (alive[i]) outPts.push(pts[i]);
  return outPts;
}

/** Rebuilds a ring's point list from its arc references. */
export function assembleRing(refs: ArcRef[], arcs: Pt[][]): Pt[] {
  const out: Pt[] = [];
  for (const ref of refs) {
    const a = ref.reversed ? arcs[ref.arc].slice().reverse() : arcs[ref.arc];
    const start = out.length === 0 ? 0 : 1;
    for (let i = start; i < a.length; i++) out.push(a[i]);
  }
  if (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) out.pop();
  }
  return out;
}

/**
 * Merges a group of regions into one outline.
 *
 * Because every border is an arc shared by exactly the regions that touch it,
 * a merge is bookkeeping rather than geometry: an arc used by two members of
 * the group is interior and cancels, and whatever is left is the group's own
 * boundary. Chaining those survivors end to end gives the merged rings, with
 * no risk of the slivers a polygon-union would leave behind.
 */
export function dissolve(members: ArcRef[][][], arcs: Pt[][]): ArcRef[][] {
  const uses = new Map<number, ArcRef[]>();
  for (const rings of members) {
    for (const refs of rings) {
      for (const ref of refs) {
        const list = uses.get(ref.arc);
        if (list) list.push(ref);
        else uses.set(ref.arc, [ref]);
      }
    }
  }

  // Odd use counts survive; an arc walked once from each side is interior.
  const boundary: ArcRef[] = [];
  for (const [, list] of uses) if (list.length % 2 === 1) boundary.push(list[0]);
  if (boundary.length === 0) return [];

  const PREC2 = 1e6;
  const at = (p: Pt): string => `${Math.round(p[0] * PREC2)}|${Math.round(p[1] * PREC2)}`;
  const endsOf = (ref: ArcRef): [string, string] => {
    const a = arcs[ref.arc];
    const first = at(a[0]);
    const last = at(a[a.length - 1]);
    return ref.reversed ? [last, first] : [first, last];
  };

  const outgoing = new Map<string, number[]>();
  boundary.forEach((ref, i) => {
    const [from] = endsOf(ref);
    const list = outgoing.get(from);
    if (list) list.push(i);
    else outgoing.set(from, [i]);
  });

  const used = new Uint8Array(boundary.length);
  const rings: ArcRef[][] = [];
  for (let seed = 0; seed < boundary.length; seed++) {
    if (used[seed]) continue;
    const ring: ArcRef[] = [];
    let cur = seed;
    for (;;) {
      used[cur] = 1;
      ring.push(boundary[cur]);
      const [, to] = endsOf(boundary[cur]);
      const next = (outgoing.get(to) ?? []).find((i) => !used[i]);
      if (next === undefined) break;
      cur = next;
    }
    if (ring.length > 0) rings.push(ring);
  }
  return rings;
}
