/**
 * The map's colour language. Kept in one place because the political map only
 * reads well when ocean, parchment, borders and nation colours are tuned
 * against each other.
 */

export const PALETTE = {
  oceanDeep: 0x13293d,
  oceanMid: 0x1c405c,
  oceanShallow: 0x2a5f80,
  /** Halo painted around every coastline to lift land off the water. */
  coastGlow: 0x74b3cf,

  /** Land that belongs to no playable nation. */
  neutralLand: 0x8f8974,
  /** Base tone the relief texture is tinted from. */
  landBase: 0xc9bda0,

  borderCountry: 0x1a1610,
  borderProvince: 0x5c5343,
  borderCoast: 0x2b2318,

  river: 0x3f7fa6,
  lake: 0x24587a,

  textPrimary: 0xf2ead8,
  textShadow: 0x120e08,
  textCity: 0xe8dcc4,

  selection: 0xffe9a8,
  hostile: 0xd2453a,
  friendly: 0x4c9be8,
  frontline: 0xe05a3c,

  supplyGood: 0x5fbf6a,
  supplyBad: 0xc4483a,
} as const;

/** Map modes recolour the province fills without touching geometry. */
export type MapMode = 'political' | 'terrain' | 'resource' | 'supply' | 'victory';

export const TERRAIN_COLOR: Record<string, number> = {
  plains: 0x9fae72,
  forest: 0x5f7d4e,
  hills: 0xa8955f,
  mountain: 0x8b7f70,
  urban: 0x9a8f88,
  marsh: 0x74886a,
  desert: 0xd6c08a,
};

/** Multiplies a packed RGB by a scalar, clamped per channel. */
export function shade(color: number, amount: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * amount));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * amount));
  const b = Math.min(255, Math.round((color & 0xff) * amount));
  return (r << 16) | (g << 8) | b;
}

export function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export function rgbToHex(rgb: readonly [number, number, number]): number {
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}

/** Continuous ramp for scalar map modes (supply, resources). */
export function ramp(t: number, stops: readonly [number, number][]): number {
  const c = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (c <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return mix(c0, c1, (c - t0) / Math.max(1e-6, t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}

export const SUPPLY_RAMP: readonly [number, number][] = [
  [0, 0x8e2f26], [0.5, 0xc9a23c], [1, 0x4f9e58],
];

export const RESOURCE_RAMP: readonly [number, number][] = [
  [0, 0x3a3a3a], [0.35, 0x7a6a3a], [0.7, 0xc9a23c], [1, 0xf0d98a],
];

export const VICTORY_RAMP: readonly [number, number][] = [
  [0, 0x38343c], [0.4, 0x6d4f6b], [0.75, 0xb0577c], [1, 0xf2a65a],
];
