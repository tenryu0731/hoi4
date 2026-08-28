import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the reference map says.
 *
 * Two things about the real game's map are worth copying and neither of them
 * is geometry: which of our cells belong to the same state, and where its
 * provinces actually sit. Both are read off one export of the game map --
 * primary colours, blue sea, green province borders, black state borders --
 * and georeferenced against Natural Earth's coastline, which the two agree on
 * to an intersection-over-union of 0.928 and a root-mean-square of 0.15
 * degrees along every coast.
 *
 * The borders this project draws still come from Natural Earth. The reference
 * decides the grouping and where the seeds go; it never supplies a line.
 *
 * An earlier reference read a state-mode screenshot by runs of flat colour,
 * which stop at province borders rather than state ones -- it was a province
 * map wearing a state map's name, and it cut Latvia into seven. Telling the
 * two tiers apart by the colour of the line is what makes this one honest.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, 'reference', 'hoi4-cells.json');

interface CellsFile {
  width: number; height: number;
  states: number; provinces: number;
  /** lon = lon0 + lonStep * column. */
  lon0: number; lonStep: number;
  /** lat = sum(latPoly[k] * v^(n-k)), v = (row * latScale) + latY0 / 6000. */
  latPoly: number[]; latY0: number; latScale: number;
  stateCells: string; provinceCells: string;
}

interface Loaded {
  w: number; h: number;
  lon0: number; lonStep: number;
  poly: number[]; v0: number; vStep: number;
  states: Uint16Array; provinces: Uint16Array;
  stateCount: number; provinceCount: number;
}

let ref: Loaded | null = null;

function load(): Loaded {
  if (ref) return ref;
  const doc = JSON.parse(readFileSync(FILE, 'utf8')) as CellsFile;
  const grid = (b64: string): Uint16Array => {
    const raw = gunzipSync(Buffer.from(b64, 'base64'));
    return new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  };
  ref = {
    w: doc.width, h: doc.height,
    lon0: doc.lon0, lonStep: doc.lonStep,
    poly: doc.latPoly, v0: doc.latY0 / 6000, vStep: doc.latScale,
    states: grid(doc.stateCells), provinces: grid(doc.provinceCells),
    stateCount: doc.states, provinceCount: doc.provinces,
  };
  return ref;
}

/** Latitude of a row, from the fitted polynomial. */
function latOfRow(r: Loaded, row: number): number {
  const v = r.v0 + row * r.vStep;
  let y = 0;
  for (const c of r.poly) y = y * v + c;
  return y;
}

/**
 * The row a latitude falls on.
 *
 * The polynomial runs the other way, so it is inverted by bisection. It is
 * monotone over the window the map covers, which is what makes that safe.
 */
function rowOfLat(r: Loaded, lat: number): number {
  let lo = 0;
  let hi = r.h - 1;
  const top = latOfRow(r, lo);
  const bottom = latOfRow(r, hi);
  if (lat > Math.max(top, bottom) || lat < Math.min(top, bottom)) return -1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if ((latOfRow(r, mid) > lat) === (top > bottom)) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

function cellAt(grid: Uint16Array, lon: number, lat: number): number {
  const r = load();
  const col = Math.round((lon - r.lon0) / r.lonStep);
  if (col < 0 || col >= r.w) return 0;
  const row = rowOfLat(r, lat);
  if (row < 0 || row >= r.h) return 0;
  return grid[row * r.w + col];
}

/** Which of the real game's states this point lies in; 0 off the map. */
export function referenceStateAt(lon: number, lat: number): number {
  return cellAt(load().states, lon, lat);
}

/** Which of the real game's provinces this point lies in; 0 off the map. */
export function referenceProvinceAt(lon: number, lat: number): number {
  return cellAt(load().provinces, lon, lat);
}

export function referenceStateCount(): number {
  return load().stateCount;
}

export function referenceProvinceCount(): number {
  return load().provinceCount;
}

/**
 * Where the real game puts a province, in lon/lat.
 *
 * One point per province cell -- the mean of the cell, nudged to a pixel that
 * is actually inside it so a horseshoe-shaped province does not seed into its
 * own bay. These are the seeds our own cells grow from, which is what makes
 * our provinces sit where the real game's do without copying a single line of
 * its geometry. Each carries the state the reference puts it in, so the cell
 * grown from it can be grouped without guessing.
 */
export function referenceProvinceSeeds(): { lon: number; lat: number; cell: number; state: number }[] {
  const r = load();
  const sumX = new Float64Array(r.provinceCount + 1);
  const sumY = new Float64Array(r.provinceCount + 1);
  const n = new Int32Array(r.provinceCount + 1);
  for (let row = 0; row < r.h; row++) {
    for (let col = 0; col < r.w; col++) {
      const c = r.provinces[row * r.w + col];
      if (c === 0) continue;
      sumX[c] += col; sumY[c] += row; n[c]++;
    }
  }
  const out: { lon: number; lat: number; cell: number; state: number }[] = [];
  for (let c = 1; c <= r.provinceCount; c++) {
    if (n[c] === 0) continue;
    let col = Math.round(sumX[c] / n[c]);
    let row = Math.round(sumY[c] / n[c]);
    if (r.provinces[row * r.w + col] !== c) {
      // The mean fell outside the cell. Take the nearest pixel that is in it.
      let best = Infinity;
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          if (r.provinces[y * r.w + x] !== c) continue;
          const d = (x - sumX[c] / n[c]) ** 2 + (y - sumY[c] / n[c]) ** 2;
          if (d < best) { best = d; col = x; row = y; }
        }
      }
    }
    // The state the reference itself puts this province in. Carried with the
    // seed rather than looked up again later from our own cell's shape: our
    // cell is a Voronoi region clipped to a different coastline, so asking
    // where *it* lies is a vote that can go the wrong way on a border. This
    // cannot -- it is the reference answering about its own province.
    out.push({
      lon: r.lon0 + col * r.lonStep, lat: latOfRow(r, row), cell: c,
      state: r.states[row * r.w + col],
    });
  }
  return out;
}
