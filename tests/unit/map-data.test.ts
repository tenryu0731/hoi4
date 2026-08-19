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

  it('reproduces well-known European land borders', () => {
    const byTag = new Map(data.provinces.map((p) => [p.ownerTag, p]));
    const borders: [string, string][] = [
      ['GER', 'FRA'], ['GER', 'POL'], ['GER', 'DEN'], ['GER', 'BEL'],
      ['FRA', 'SPR'], ['SPR', 'POR'], ['ITA', 'SWI'], ['ITA', 'AUS'],
      ['SOV', 'FIN'], ['SOV', 'ROM'], ['YUG', 'GRE'], ['BUL', 'TUR'],
      ['NOR', 'SWE'], ['HUN', 'ROM'],
    ];
    for (const [a, b] of borders) {
      const pa = byTag.get(a);
      const pb = byTag.get(b);
      expect(pa, a).toBeDefined();
      expect(pb, b).toBeDefined();
      expect(pa!.neighbors, `${a}-${b}`).toContain(pb!.id);
    }
  });

  it('does not invent land borders across water or third countries', () => {
    const byTag = new Map(data.provinces.map((p) => [p.ownerTag, p]));
    const notBorders: [string, string][] = [
      ['GER', 'ITA'], ['POL', 'HUN'], ['POL', 'ROM'], ['HOL', 'FRA'],
      ['SWE', 'DEN'], ['GRE', 'ITA'], ['IRE', 'FRA'],
    ];
    for (const [a, b] of notBorders) {
      const pa = byTag.get(a);
      const pb = byTag.get(b);
      if (!pa || !pb) continue;
      expect(pa.neighbors, `${a}-${b} must not be a land border`).not.toContain(pb.id);
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

  it('finds a path between any two provinces', () => {
    const ids = index.provinces.map((p) => p.id);
    for (const a of ids) {
      for (const b of ids) {
        const path = index.path(a, b);
        expect(path, `${a}->${b}`).not.toBeNull();
        expect(path![0]).toBe(a);
        expect(path![path!.length - 1]).toBe(b);
        for (let i = 1; i < path!.length; i++) {
          expect(index.areAdjacent(path![i - 1], path![i])).toBe(true);
        }
      }
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
