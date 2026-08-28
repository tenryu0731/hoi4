/**
 * States, built from the world's real administrative units.
 *
 * A state is not an invention of the game: it is a province of Italy, a
 * French department, a Polish voivodeship. Natural Earth's admin-1 layer
 * carries all of them, but at wildly different depths — sixteen Länder for
 * Germany, two hundred and thirty-two districts for the United Kingdom — so
 * the units are merged upward until each one is worth being a state, which
 * keeps every state border on a line somebody actually drew.
 */

import { type Bbox, type Pt, type Ring, ringArea } from './geo';
import { type ArcRef, type Topology, dissolve } from './topology';
import { CUTS_1936, RENAME_1936, RETAG_1936 } from './historical';

export interface AdminUnit {
  /** Stable key for topology; unique across the whole map. */
  key: string;
  tag: string;
  name: string;
  /** Present-day country code, which decides how big a state has to be. */
  adm0: string;
  /** Rings in lon/lat, before projection. */
  lonLat: Ring[];
}

export interface AdminFeature {
  properties: Record<string, unknown>;
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] }
    | { type: string; coordinates: unknown }
    | null;
}

/** Below this many square kilometres a unit is merged into a neighbour. */
export const MIN_STATE_AREA = 8_500;
/** The same, out in the colonies, where a state covers a province of desert. */
export const MIN_SPARSE_STATE_AREA = 55_000;
/** Admin-0 codes whose interior is empty enough to want the larger threshold. */
const SPARSE = new Set([
  'DZA', 'LBY', 'MAR', 'TUN', 'EGY', 'SYR', 'IRQ', 'JOR', 'ISR', 'PSE', 'LBN',
  'SAU', 'ESH', 'MRT', 'MLI', 'NER', 'TCD', 'SDN',
]);
/** An island may still join a state this far away when it has no land border. */
const ISLAND_REACH_KM = 210;

/** Names restored for 1936, which survive a merge they would otherwise lose. */
const PERIOD_NAMES = new Set<string>([
  ...Object.values(RENAME_1936),
  ...CUTS_1936.map((c) => c.name),
]);

const polygonsOf = (f: AdminFeature): number[][][][] => {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates as number[][][]];
  if (g.type === 'MultiPolygon') return g.coordinates as number[][][][];
  return [];
};

const toRing = (coords: number[][]): Ring => coords.map((c) => [c[0], c[1]] as Pt);

/** Sutherland-Hodgman against an axis-aligned window, in lon/lat. */
function clipLonLat(ring: Ring, box: Bbox): Ring {
  let out = ring;
  const passes: Array<[(p: Pt) => boolean, (a: Pt, b: Pt) => Pt]> = [
    [(p) => p[0] >= box.minLon, (a, b) => lerpX(a, b, box.minLon)],
    [(p) => p[0] <= box.maxLon, (a, b) => lerpX(a, b, box.maxLon)],
    [(p) => p[1] >= box.minLat, (a, b) => lerpY(a, b, box.minLat)],
    [(p) => p[1] <= box.maxLat, (a, b) => lerpY(a, b, box.maxLat)],
  ];
  for (const [inside, cut] of passes) {
    const next: Ring = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      const ain = inside(a);
      const bin = inside(b);
      if (ain) next.push(a);
      if (ain !== bin) next.push(cut(a, b));
    }
    out = next;
    if (out.length === 0) return out;
  }
  return out;
}

const lerpX = (a: Pt, b: Pt, x: number): Pt => {
  const t = (x - a[0]) / (b[0] - a[0]);
  return [x, a[1] + (b[1] - a[1]) * t];
};
const lerpY = (a: Pt, b: Pt, y: number): Pt => {
  const t = (y - a[1]) / (b[1] - a[1]);
  return [a[0] + (b[0] - a[0]) * t, y];
};

/**
 * The five tiles a cut window carves the plane into: the window itself and
 * the four slabs around it. They tile without overlapping, so clipping a unit
 * against all five splits it cleanly and the cut edges match on both sides.
 */
function tilesAround(w: Bbox, world: Bbox): Array<{ box: Bbox; inside: boolean }> {
  return [
    { box: w, inside: true },
    { box: { minLon: world.minLon, maxLon: w.minLon, minLat: world.minLat, maxLat: world.maxLat }, inside: false },
    { box: { minLon: w.maxLon, maxLon: world.maxLon, minLat: world.minLat, maxLat: world.maxLat }, inside: false },
    { box: { minLon: w.minLon, maxLon: w.maxLon, minLat: world.minLat, maxLat: w.minLat }, inside: false },
    { box: { minLon: w.minLon, maxLon: w.maxLon, minLat: w.maxLat, maxLat: world.maxLat }, inside: false },
  ];
}

export interface AdminOptions {
  /** The map window; geometry outside it never matters. */
  world: Bbox;
  /** Present-day admin-0 code to 1936 nation tag. */
  tagOf: (adm0: string) => string | undefined;
}

/**
 * Reads the admin-1 layer into 1936 units: today's shapes, yesterday's owners.
 */
export function adminUnits1936(features: AdminFeature[], opts: AdminOptions): AdminUnit[] {
  const cutsByCode = new Map<string, typeof CUTS_1936[number][]>();
  for (const cut of CUTS_1936) {
    const list = cutsByCode.get(cut.from);
    if (list) list.push(cut);
    else cutsByCode.set(cut.from, [cut]);
  }

  const units: AdminUnit[] = [];
  const seen = new Map<string, number>();

  for (const f of features) {
    const adm0 = String(f.properties.adm0_a3 ?? '');
    const base = opts.tagOf(adm0);
    if (!base) continue;

    const iso = String(f.properties.iso_3166_2 ?? '');
    const code = iso || String(f.properties.adm1_code ?? '');
    const rings: Ring[] = [];
    for (const poly of polygonsOf(f)) {
      for (const r of poly) {
        const ring = clipLonLat(toRing(r), opts.world);
        if (ring.length >= 3) rings.push(ring);
      }
    }
    if (rings.length === 0) continue;

    const tag = RETAG_1936[code] ?? base;
    const rawName = String(f.properties.name ?? f.properties.name_local ?? code);
    const name = RENAME_1936[code] ?? rawName;

    // Codes repeat here and there (Moldova ships two MD-RE), so keys are made
    // unique rather than trusted.
    const uniq = (stem: string): string => {
      const n = (seen.get(stem) ?? 0) + 1;
      seen.set(stem, n);
      return n === 1 ? stem : `${stem}#${n}`;
    };

    const cuts = [...(cutsByCode.get(code) ?? []), ...(cutsByCode.get(`adm0:${adm0}`) ?? [])];
    if (cuts.length === 0) {
      units.push({ key: uniq(code), tag, name, adm0, lonLat: rings });
      continue;
    }

    // One cut at a time; a unit crossed by two windows is split by both.
    let pieces: Array<{ tag: string; name: string; rings: Ring[] }> = [{ tag, name, rings }];
    for (const cut of cuts) {
      const next: typeof pieces = [];
      for (const piece of pieces) {
        for (const tile of tilesAround(cut.window, opts.world)) {
          const kept: Ring[] = [];
          for (const ring of piece.rings) {
            const clipped = clipLonLat(ring, tile.box);
            if (clipped.length >= 3) kept.push(clipped);
          }
          if (kept.length === 0) continue;
          next.push(tile.inside
            ? { tag: cut.tag, name: cut.name, rings: kept }
            : { tag: piece.tag, name: piece.name, rings: kept });
        }
      }
      pieces = next;
    }
    // Slabs of the same survivor are one unit again, not four.
    const byOwner = new Map<string, { tag: string; name: string; rings: Ring[] }>();
    for (const piece of pieces) {
      const k = `${piece.tag}|${piece.name}`;
      const prev = byOwner.get(k);
      if (prev) prev.rings.push(...piece.rings);
      else byOwner.set(k, piece);
    }
    for (const piece of byOwner.values()) {
      units.push({
        key: uniq(`${code}:${piece.tag}`),
        tag: piece.tag, name: piece.name, adm0, lonLat: piece.rings,
      });
    }
  }

  return units;
}

// ---------------------------------------------------------------------------
// Merging small units upward
// ---------------------------------------------------------------------------

export interface StateGroup {
  name: string;
  tag: string;
  /** Admin unit keys, largest first. */
  members: string[];
  rings: Ring[];
  area: number;
  centre: Pt;
}

export interface GroupInput {
  units: AdminUnit[];
  /** Projected rings, keyed the same way as the units. */
  projected: Map<string, Ring[]>;
  topo: Topology;
}

/** How many of a ring's points are not repeats of another, to the metre. */
const distinct = (ring: Ring): number => {
  const seen = new Set<string>();
  for (const p of ring) seen.add(`${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`);
  return seen.size;
};

const centroidOf = (rings: Ring[]): Pt => {
  let bx = 0;
  let by = 0;
  let best = -1;
  for (const ring of rings) {
    const a = ringArea(ring);
    if (a <= best) continue;
    best = a;
    let sx = 0;
    let sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    bx = sx / ring.length;
    by = sy / ring.length;
  }
  return [bx, by];
};

/**
 * Merges neighbours until no state is embarrassingly small.
 *
 * Smallest first, into its smallest same-nation neighbour: growing the runt
 * rather than the giant keeps state sizes even, which is what stops one
 * province of Lombardy sitting next to the whole of Bavaria.
 */
export function groupIntoStates(input: GroupInput): StateGroup[] {
  const { units, projected, topo } = input;
  const byKey = new Map(units.map((u) => [u.key, u]));

  interface Node {
    key: string;
    tag: string;
    name: string;
    members: string[];
    area: number;
    centre: Pt;
    alive: boolean;
    settled: boolean;
  }
  const nodes = new Map<string, Node>();
  for (const u of units) {
    const rings = projected.get(u.key);
    if (!rings || rings.length === 0) continue;
    const area = rings.reduce((s, r) => s + ringArea(r), 0);
    nodes.set(u.key, {
      key: u.key, tag: u.tag, name: u.name, members: [u.key],
      area, centre: centroidOf(rings), alive: true, settled: false,
    });
  }

  // Land adjacency comes free from the arcs two units share.
  const neighbours = new Map<string, Set<string>>();
  const touch = (a: string, b: string): void => {
    if (a === b) return;
    let set = neighbours.get(a);
    if (!set) { set = new Set(); neighbours.set(a, set); }
    set.add(b);
  };
  for (const owners of topo.arcOwners.values()) {
    if (owners.size < 2) continue;
    const list = [...owners];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) { touch(list[i], list[j]); touch(list[j], list[i]); }
    }
  }

  // Where a unit ends up after merges, so stale neighbour names still resolve.
  const home = new Map<string, string>([...nodes.keys()].map((k) => [k, k]));
  const find = (k: string): string => {
    let cur = k;
    while (home.get(cur) !== cur) cur = home.get(cur)!;
    return cur;
  };

  const floorFor = (n: Node): number =>
    n.members.some((m) => SPARSE.has(byKey.get(m)?.adm0 ?? '')) ? MIN_SPARSE_STATE_AREA : MIN_STATE_AREA;

  const liveNeighbours = (n: Node): Node[] => {
    const out = new Map<string, Node>();
    for (const m of n.members) {
      for (const raw of neighbours.get(m) ?? []) {
        const root = find(raw);
        if (root === n.key) continue;
        const node = nodes.get(root);
        if (node?.alive && node.tag === n.tag) out.set(root, node);
      }
    }
    return [...out.values()];
  };

  for (;;) {
    let worst: Node | null = null;
    for (const n of nodes.values()) {
      if (!n.alive || n.settled || n.area >= floorFor(n)) continue;
      if (worst === null || n.area < worst.area) worst = n;
    }
    if (worst === null) break;

    let into = liveNeighbours(worst).sort((a, b) => a.area - b.area)[0] ?? null;
    if (into === null) {
      // An island: join the nearest same-nation state if one is within reach.
      let bestDist = ISLAND_REACH_KM;
      for (const other of nodes.values()) {
        if (!other.alive || other.key === worst.key || other.tag !== worst.tag) continue;
        const d = Math.hypot(other.centre[0] - worst.centre[0], other.centre[1] - worst.centre[1]);
        if (d < bestDist) { bestDist = d; into = other; }
      }
    }
    if (into === null) {
      // Nothing to join — Malta on its own is a state, and that is correct.
      // Marked settled rather than given a fictitious area: inflating it to
      // the floor to stop the loop also became the state's reported size, and
      // Gibraltar went out as eight and a half thousand square kilometres.
      worst.settled = true;
      continue;
    }

    // The larger name wins, so a state is called after its principal region --
    // except that a name restored for 1936 outranks a modern one whenever it
    // covers a real share of the merged ground, so Istria stays Istria.
    const periodWorst = PERIOD_NAMES.has(worst.name);
    const periodInto = PERIOD_NAMES.has(into.name);
    const share = worst.area / (worst.area + into.area);
    if (periodWorst && !periodInto ? share >= 0.4 : worst.area > into.area) into.name = worst.name;
    into.members.push(...worst.members);
    into.area += worst.area;
    worst.alive = false;
    home.set(worst.key, into.key);
  }

  const groups: StateGroup[] = [];
  for (const n of nodes.values()) {
    if (!n.alive) continue;
    const memberRings = n.members
      .map((m) => topo.regions.get(m))
      .filter((r): r is ArcRef[][] => r !== undefined);
    const refs = dissolve(memberRings, topo.arcs);
    const rings: Ring[] = [];
    for (const ring of refs) {
      const pts: Ring = [];
      for (const ref of ring) {
        const arc = ref.reversed ? topo.arcs[ref.arc].slice().reverse() : topo.arcs[ref.arc];
        for (let i = pts.length === 0 ? 0 : 1; i < arc.length; i++) pts.push(arc[i]);
      }
      // Simplification can flatten a unit smaller than its own threshold into a
      // line: Gibraltar's six square kilometres came back as four points, two
      // of them the same point, and a cell with no inside has nowhere to put
      // its own centre.
      if (pts.length >= 3 && distinct(pts) >= 3 && ringArea(pts) >= 1) rings.push(pts);
    }
    const members = n.members
      .slice()
      .sort((a, b) => areaOf(projected.get(b)) - areaOf(projected.get(a)));
    const area = rings.reduce((s, r) => s + ringArea(r), 0) || n.area;
    groups.push({
      name: byKey.get(members[0])?.name ?? n.name,
      tag: n.tag,
      members,
      rings: rings.length > 0 ? rings : n.members.flatMap((m) => projected.get(m) ?? []),
      area,
      centre: n.centre,
    });
  }
  // A unit whose every ring collapsed has nothing left to be a state with.
  const solid = groups.filter((g) => g.rings.length > 0 && g.area >= 1);
  solid.sort((a, b) => a.tag.localeCompare(b.tag) || b.area - a.area);
  return solid;
}

const areaOf = (rings: Ring[] | undefined): number =>
  rings ? rings.reduce((s, r) => s + ringArea(r), 0) : 0;
