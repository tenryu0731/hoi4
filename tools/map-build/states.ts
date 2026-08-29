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

import { type Bbox, type Pt, type Ring } from './geo';
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
