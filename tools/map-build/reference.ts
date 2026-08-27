import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the reference map says.
 *
 * 「ステートの画像とプロヴィンスの画像の…完璧に一致させる」. Two things about the
 * real game's map are worth copying and neither of them is geometry: which
 * provinces belong to the same state, and how finely a given part of the world
 * is cut up. Both were read off screenshots of the game map and georeferenced
 * against Natural Earth's coastlines -- an overlay of the two agrees to a
 * couple of pixels along every coast in Europe.
 *
 * The borders this project draws still come from Natural Earth. The reference
 * decides the grouping and the granularity; it never supplies a line.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, 'reference');

interface Fit {
  lon0: number;
  lonSpan: number;
  /** Latitude as a polynomial in the row fraction: lat = sum(lat[k] * v^k). */
  lat: number[];
}

interface StatesFile {
  width: number; height: number; cells: number; fit: Fit; data: string;
}

interface DensityFile {
  lon0: number; lat0: number; step: number; width: number; height: number;
  kmPerProvince: number[][];
}

let states: { w: number; h: number; fit: Fit; cells: Uint16Array; count: number } | null = null;
let density: DensityFile | null = null;

function loadStates(): NonNullable<typeof states> {
  if (states) return states;
  const raw = JSON.parse(readFileSync(join(DIR, 'hoi4-states.json'), 'utf8')) as StatesFile;
  const buf = gunzipSync(Buffer.from(raw.data, 'base64'));
  const cells = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  states = { w: raw.width, h: raw.height, fit: raw.fit, cells, count: raw.cells };
  return states;
}

function loadDensity(): DensityFile {
  if (density) return density;
  density = JSON.parse(
    readFileSync(join(DIR, 'hoi4-province-density.json'), 'utf8'),
  ) as DensityFile;
  return density;
}

const latAt = (fit: Fit, v: number): number => {
  let out = 0;
  let p = 1;
  for (const k of fit.lat) { out += k * p; p *= v; }
  return out;
};

/**
 * Row fraction for a latitude, by bisection.
 *
 * The polynomial is cubic and monotone across the image, so there is nothing
 * to gain from a closed form and something to lose: the quadratic it replaced
 * was still drifting a full degree at the Arctic circle, which put the Kola
 * peninsula inside Finland.
 */
function rowOf(fit: Fit, lat: number): number | null {
  let lo = 0;
  let hi = 1;
  const a = latAt(fit, lo);
  const b = latAt(fit, hi);
  if ((lat - a) * (lat - b) > 0) return null;
  const descending = a > b;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if ((latAt(fit, mid) > lat) === descending) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The reference's state at a point, or 0 where it has nothing to say -- sea,
 * or ground outside the screenshot.
 */
export function referenceStateAt(lon: number, lat: number): number {
  const s = loadStates();
  const u = (lon - s.fit.lon0) / s.fit.lonSpan;
  if (u < 0 || u >= 1) return 0;
  const v = rowOf(s.fit, lat);
  if (v === null || v < 0 || v >= 1) return 0;
  const x = Math.min(s.w - 1, Math.max(0, Math.floor(u * s.w)));
  const y = Math.min(s.h - 1, Math.max(0, Math.floor(v * s.h)));
  return s.cells[y * s.w + x];
}

/** How many square kilometres the reference gives one province, here. */
export function referenceKmPerProvince(lon: number, lat: number): number | null {
  const d = loadDensity();
  const i = Math.floor((lon - d.lon0) / d.step);
  const j = Math.floor((lat - d.lat0) / d.step);
  if (i < 0 || i >= d.width || j < 0 || j >= d.height) return null;
  return d.kmPerProvince[j][i];
}

export function referenceStateCount(): number {
  return loadStates().count;
}
