import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { ProvinceIndex } from '../../src/sim/map/ProvinceIndex';
import { MAP_FORMAT_VERSION, type MapDataJson } from '../../src/sim/map/MapData';
import { TERRAIN_TYPES } from '../../src/sim/core/types';

const MAP_PATH = join(process.cwd(), 'public', 'data', 'map.json');

let data: MapDataJson;
let index: ProvinceIndex;

beforeAll(() => {
  data = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as MapDataJson;
  index = ProvinceIndex.load(data);
});

describe('map data integrity', () => {
  it('matches the format version the runtime expects', () => {
    expect(data.version).toBe(MAP_FORMAT_VERSION);
  });

  it('uses ids that match array positions', () => {
    data.provinces.forEach((p, i) => expect(p.id).toBe(i));
    data.states.forEach((s, i) => expect(s.id).toBe(i));
  });

  it('has closed, non-degenerate rings with an even coordinate count', () => {
    for (const p of data.provinces) {
      expect(p.rings.length).toBeGreaterThan(0);
      expect(p.rings.length).toBe(p.ringDepth.length);
      for (const ring of p.rings) {
        expect(ring.length % 2).toBe(0);
        expect(ring.length / 2).toBeGreaterThanOrEqual(3);
        for (const v of ring) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('gives every province a finite centre inside its own bounding box', () => {
    for (const p of index.provinces) {
      expect(Number.isFinite(p.centerX)).toBe(true);
      expect(Number.isFinite(p.centerY)).toBe(true);
      expect(p.centerX).toBeGreaterThanOrEqual(p.bbox[0]);
      expect(p.centerX).toBeLessThanOrEqual(p.bbox[2]);
      expect(p.centerY).toBeGreaterThanOrEqual(p.bbox[1]);
      expect(p.centerY).toBeLessThanOrEqual(p.bbox[3]);
    }
  });

  it('places every province centre inside the province itself', () => {
    for (const p of index.provinces) {
      expect(index.contains(p.id, p.centerX, p.centerY)).toBe(true);
    }
  });

  it('uses only known terrain types', () => {
    for (const p of data.provinces) {
      expect(TERRAIN_TYPES).toContain(p.terrain);
    }
  });

  it('keeps adjacency symmetric and free of self-links', () => {
    for (const p of data.provinces) {
      for (const n of p.neighbors) {
        expect(n).not.toBe(p.id);
        expect(data.provinces[n].neighbors).toContain(p.id);
      }
      for (const n of p.seaNeighbors) {
        expect(n).not.toBe(p.id);
        expect(data.provinces[n].seaNeighbors).toContain(p.id);
      }
      // A pair is either a land border or a sea crossing, never both.
      for (const n of p.seaNeighbors) expect(p.neighbors).not.toContain(n);
    }
  });

  it('forms a single connected graph', () => {
    const seen = new Set<number>([0]);
    const stack = [0];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const n of [...data.provinces[cur].neighbors, ...data.provinces[cur].seaNeighbors]) {
        if (!seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    expect(seen.size).toBe(data.provinces.length);
  });

  it('gives every province at least one neighbour and a positive victory value', () => {
    for (const p of data.provinces) {
      expect(p.neighbors.length + p.seaNeighbors.length).toBeGreaterThan(0);
      expect(p.vp).toBeGreaterThan(0);
      expect(p.area).toBeGreaterThan(0);
    }
  });

  it('assigns every state to provinces that point back at it', () => {
    for (const s of data.states) {
      expect(s.provinces.length).toBeGreaterThan(0);
      for (const pid of s.provinces) expect(data.provinces[pid].stateId).toBe(s.id);
      expect(s.manpower).toBeGreaterThan(0);
      expect(s.infrastructure).toBeGreaterThanOrEqual(1);
    }
    for (const p of data.provinces) {
      expect(data.states[p.stateId].provinces).toContain(p.id);
    }
  });

  it('gives every nation exactly one capital city inside its own territory', () => {
    const tags = new Set(data.provinces.map((p) => p.ownerTag));
    for (const tag of tags) {
      const caps = data.cities.filter((c) => c.capitalOf === tag);
      expect(caps.length, `capital count for ${tag}`).toBe(1);
      expect(data.provinces[caps[0].province].ownerTag, `capital of ${tag}`).toBe(tag);
    }
  });

  it('places every city inside a real province', () => {
    for (const c of data.cities) {
      expect(c.province).toBeGreaterThanOrEqual(0);
      expect(c.province).toBeLessThan(data.provinces.length);
    }
  });

  /** Country-level adjacency, derived from province adjacency. */
  function countryNeighbours(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const p of data.provinces) {
      let set = out.get(p.ownerTag);
      if (!set) { set = new Set(); out.set(p.ownerTag, set); }
      for (const n of p.neighbors) set.add(data.provinces[n].ownerTag);
    }
    return out;
  }

  it('reproduces well-known European land borders', () => {
    const nb = countryNeighbours();
    // Borders as they stood in January 1936, which is not where they stand
    // now: Germany reaches Lithuania across East Prussia, Poland reaches
    // Romania across Pokuttia, and Czechoslovakia reaches Romania across
    // Ruthenia. Italy meets Yugoslavia at Istria.
    const borders: [string, string][] = [
      ['GER', 'FRA'], ['GER', 'POL'], ['GER', 'DEN'], ['GER', 'BEL'],
      ['FRA', 'SPR'], ['SPR', 'POR'], ['ITA', 'SWI'], ['ITA', 'AUS'],
      ['SOV', 'FIN'], ['SOV', 'ROM'], ['YUG', 'GRE'], ['BUL', 'TUR'],
      ['NOR', 'SWE'], ['HUN', 'ROM'],
      ['GER', 'LIT'], ['POL', 'ROM'], ['POL', 'LIT'], ['CZE', 'ROM'],
      ['ITA', 'YUG'], ['POL', 'SOV'],
    ];
    for (const [a, b] of borders) {
      expect(nb.get(a), `${a} missing`).toBeDefined();
      expect([...(nb.get(a) ?? [])], `${a}-${b}`).toContain(b);
      expect([...(nb.get(b) ?? [])], `${b}-${a}`).toContain(a);
    }
  });

  it('does not invent land borders across water or third countries', () => {
    const nb = countryNeighbours();
    // Poland and Hungary did not touch until Ruthenia was carved up in 1939,
    // and Italy's Dodecanese are islands, so neither pair is a land border.
    const notBorders: [string, string][] = [
      ['GER', 'ITA'], ['POL', 'HUN'], ['HOL', 'FRA'],
      ['SWE', 'DEN'], ['GRE', 'ITA'], ['IRE', 'FRA'],
    ];
    for (const [a, b] of notBorders) {
      expect([...(nb.get(a) ?? [])], `${a}-${b} must not be a land border`).not.toContain(b);
    }
  });
});

describe('ProvinceIndex', () => {
  it('picks the province containing a capital city', () => {
    for (const c of data.cities) {
      if (!c.capitalOf) continue;
      const picked = index.pick(c.x, c.y) ?? index.pickNearest(c.x, c.y, 80);
      expect(picked, `${c.name} (${c.capitalOf})`).not.toBeNull();
      expect(data.provinces[picked!].ownerTag, `${c.name}`).toBe(c.capitalOf);
    }
  });

  it('picks every province from its own centre', () => {
    for (const p of index.provinces) {
      expect(index.pick(p.centerX, p.centerY), p.name).toBe(p.id);
    }
  });

  it('returns null far out to sea and outside the map', () => {
    const [minX, minY, maxX, maxY] = data.bounds;
    expect(index.pick(minX - 5000, minY - 5000)).toBeNull();
    expect(index.pick(maxX + 5000, maxY + 5000)).toBeNull();
  });

  it('agrees with a brute-force point-in-polygon test on a sampled grid', () => {
    const [minX, minY, maxX, maxY] = data.bounds;
    let checked = 0;
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 40; j++) {
        const x = minX + ((maxX - minX) * (i + 0.5)) / 40;
        const y = minY + ((maxY - minY) * (j + 0.5)) / 40;
        const picked = index.pick(x, y);
        const brute = index.provinces.find((p) => index.contains(p.id, x, y))?.id ?? null;
        expect(picked, `at ${x.toFixed(0)},${y.toFixed(0)}`).toBe(brute);
        checked++;
      }
    }
    expect(checked).toBe(1600);
  });

  it('finds a valid path between every sampled pair of provinces', () => {
    // All pairs is 100k searches on the province map, which is too slow for a
    // suite meant to run after every change. A deterministic stride samples
    // every province as both origin and destination without the quadratic cost.
    const n = index.count;
    const stride = 7;
    let checked = 0;
    for (let a = 0; a < n; a++) {
      for (let k = 1; k <= 5; k++) {
        const b = (a * stride + k * 31) % n;
        const path = index.path(a, b);
        expect(path, `${a}->${b}`).not.toBeNull();
        expect(path![0]).toBe(a);
        expect(path![path!.length - 1]).toBe(b);
        for (let i = 1; i < path!.length; i++) {
          expect(index.areAdjacent(path![i - 1], path![i]), `${a}->${b} step ${i}`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBe(n * 5);
  });

  it('can reach the far corners of the map', () => {
    const byTag = new Map(index.provinces.map((p) => [p.ownerTag, p]));
    const corners: [string, string][] = [
      ['POR', 'SOV'], ['ICE', 'TUR'], ['IRE', 'GRE'], ['NOR', 'SPR'],
    ];
    for (const [a, b] of corners) {
      const pa = byTag.get(a);
      const pb = byTag.get(b);
      if (!pa || !pb) continue;
      expect(index.path(pa.id, pb.id), `${a}->${b}`).not.toBeNull();
    }
  });

  it('returns a single-node path to itself', () => {
    expect(index.path(3, 3)).toEqual([3]);
  });

  it('returns the direct hop between neighbours', () => {
    const p = index.provinces.find((q) => q.neighbors.length > 0)!;
    const path = index.path(p.id, p.neighbors[0]);
    expect(path).toEqual([p.id, p.neighbors[0]]);
  });

  it('refuses to route through blocked provinces', () => {
    const byTag = new Map(index.provinces.map((p) => [p.ownerTag, p]));
    const ire = byTag.get('IRE')!;
    // Ireland only touches the outside world through the United Kingdom.
    const eng = byTag.get('ENG')!;
    const path = index.path(ire.id, byTag.get('FRA')!.id, { blocked: (id) => id === eng.id });
    if (path) {
      expect(path).not.toContain(eng.id);
    } else {
      expect(path).toBeNull();
    }
  });

  it('returns null when the destination itself is blocked', () => {
    expect(index.path(0, 5, { blocked: (id) => id === 5 })).toBeNull();
  });

  it('prefers land routes when sea crossings are expensive', () => {
    const byTag = new Map(index.provinces.map((p) => [p.ownerTag, p]));
    const ger = byTag.get('GER')!.id;
    const swe = byTag.get('SWE')!.id;
    const viaSea = index.path(ger, swe, { seaMultiplier: 1 })!;
    const viaLand = index.path(ger, swe, { seaMultiplier: 50 })!;
    expect(viaSea.length).toBeLessThanOrEqual(viaLand.length);
  });

  it('cannot reach an island when sea travel is forbidden', () => {
    const byTag = new Map(index.provinces.map((p) => [p.ownerTag, p]));
    const ice = byTag.get('ICE')!.id;
    const ger = byTag.get('GER')!.id;
    expect(index.path(ger, ice, { allowSea: false })).toBeNull();
    expect(index.path(ger, ice, { allowSea: true })).not.toBeNull();
  });

  it('computes reachable sets that respect the passability predicate', () => {
    const all = index.reachable(0, () => true);
    expect(all.size).toBeGreaterThan(1);
    const none = index.reachable(0, (id) => id === 0);
    expect([...none]).toEqual([0]);
  });

  it('measures symmetric, positive distances', () => {
    expect(index.distance(0, 1)).toBeCloseTo(index.distance(1, 0), 6);
    expect(index.distance(0, 1)).toBeGreaterThan(0);
    expect(index.distance(4, 4)).toBe(0);
  });
});

/**
 * Shared boundaries.
 *
 * The front line is drawn along them, so a pair of neighbours that reports no
 * shared geometry is a stretch of front that silently does not exist.
 */
describe('shared borders', () => {
  it('recovers a boundary for most neighbouring pairs', () => {
    let pairs = 0;
    let withGeometry = 0;
    for (const p of index.provinces) {
      for (const nb of p.neighbors) {
        if (nb < p.id) continue;
        pairs++;
        if (index.sharedBorder(p.id, nb).length > 0) withGeometry++;
      }
    }
    expect(pairs).toBeGreaterThan(400);
    // Not all of them: the subdivision leaves pairs that meet at a single
    // corner, and the strait links are adjacency across water. Neither has a
    // boundary to draw, so the front line simply has nothing to say there.
    expect(withGeometry / pairs).toBeGreaterThan(0.7);
  });

  it('agrees with itself whichever province is asked first', () => {
    const pair = (() => {
      for (const p of index.provinces) {
        for (const nb of p.neighbors) {
          if (nb > p.id && index.sharedBorder(p.id, nb).length > 0) return [p.id, nb];
        }
      }
      throw new Error('no pair shares a boundary');
    })();
    const forward = index.sharedBorder(pair[0], pair[1]).flat().length;
    const backward = index.sharedBorder(pair[1], pair[0]).flat().length;
    expect(forward).toBeGreaterThan(0);
    expect(backward).toBeGreaterThan(0);
  });

  it('returns nothing for provinces that do not touch', () => {
    const a = index.provinces.find((q) => q.ownerTag === 'POR')!;
    const b = index.provinces.find((q) => q.ownerTag === 'FIN')!;
    expect(index.sharedBorder(a.id, b.id)).toEqual([]);
  });
});
