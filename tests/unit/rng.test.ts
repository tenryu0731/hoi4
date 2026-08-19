import { describe, expect, it } from 'vitest';
import { chance, createRng, fork, jitter, rand, randInt, shuffle } from '../../src/sim/core/rng';

describe('deterministic rng', () => {
  it('replays the same sequence from the same seed', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    for (let i = 0; i < 1000; i++) expect(rand(a)).toBe(rand(b));
  });

  it('diverges for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (rand(a) === rand(b)) same++;
    expect(same).toBe(0);
  });

  it('stays inside [0, 1)', () => {
    const r = createRng(999);
    for (let i = 0; i < 20000; i++) {
      const v = rand(r);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    const r = createRng(7);
    const buckets = new Array(10).fill(0);
    const n = 100000;
    for (let i = 0; i < n; i++) buckets[Math.floor(rand(r) * 10)]++;
    for (const b of buckets) {
      expect(b).toBeGreaterThan(n / 10 * 0.9);
      expect(b).toBeLessThan(n / 10 * 1.1);
    }
  });

  it('randInt covers the full range and never exceeds it', () => {
    const r = createRng(42);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = randInt(r, 6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
  });

  it('jitter stays within the requested band', () => {
    const r = createRng(3);
    for (let i = 0; i < 10000; i++) {
      const j = jitter(r, 0.1);
      expect(j).toBeGreaterThanOrEqual(0.9);
      expect(j).toBeLessThan(1.1);
    }
  });

  it('chance(p) converges to p', () => {
    const r = createRng(11);
    let hits = 0;
    for (let i = 0; i < 50000; i++) if (chance(r, 0.25)) hits++;
    expect(hits / 50000).toBeCloseTo(0.25, 2);
  });

  it('shuffle is a permutation and is seed-stable', () => {
    const src = Array.from({ length: 50 }, (_, i) => i);
    const a = shuffle(createRng(5), [...src]);
    const b = shuffle(createRng(5), [...src]);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(src);
  });

  it('fork produces an independent but reproducible stream', () => {
    const base = createRng(100);
    const before = base.s;
    const f1 = fork(base, 7);
    const f2 = fork(base, 7);
    const f3 = fork(base, 8);
    expect(base.s).toBe(before);           // forking must not advance the parent
    expect(rand(f1)).toBe(rand(f2));
    expect(rand(f1)).not.toBe(rand(f3));
  });
});
