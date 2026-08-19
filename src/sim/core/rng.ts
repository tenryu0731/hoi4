/**
 * Deterministic PRNG (mulberry32). The simulation must never call Math.random:
 * every stochastic decision draws from a state stored inside GameState so that
 * the same seed plus the same command sequence always replays identically.
 */
export interface RngState {
  s: number;
}

export function createRng(seed: number): RngState {
  return { s: seed >>> 0 };
}

/** Next float in [0, 1). Mutates the state in place. */
export function rand(r: RngState): number {
  r.s = (r.s + 0x6d2b79f5) | 0;
  let t = Math.imul(r.s ^ (r.s >>> 15), 1 | r.s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Integer in [0, n). */
export function randInt(r: RngState, n: number): number {
  return Math.floor(rand(r) * n);
}

/** Float in [min, max). */
export function randRange(r: RngState, min: number, max: number): number {
  return min + rand(r) * (max - min);
}

/** Symmetric jitter multiplier in [1-amount, 1+amount). */
export function jitter(r: RngState, amount: number): number {
  return 1 + (rand(r) * 2 - 1) * amount;
}

/** True with probability p. */
export function chance(r: RngState, p: number): boolean {
  return rand(r) < p;
}

/** Fisher-Yates shuffle in place, deterministic for a given rng state. */
export function shuffle<T>(r: RngState, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(r, i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Derives an independent stream from a base state without advancing it.
 * Used so that per-country AI draws do not depend on iteration order elsewhere.
 */
export function fork(r: RngState, salt: number): RngState {
  return { s: (Math.imul(r.s ^ salt, 0x9e3779b1) ^ (salt << 13)) >>> 0 };
}
