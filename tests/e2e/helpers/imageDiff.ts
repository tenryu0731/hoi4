import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';

/**
 * Tile-based screenshot comparison.
 *
 * A single global "percent of pixels changed" number hides the failures that
 * matter: a border shifting by one pixel across the whole map and a panel
 * disappearing can produce the same total. So the frame is split into tiles and
 * each tile is scored separately, which tells us *where* the render changed and
 * lets the report name the regions instead of just failing.
 */

export const BASELINE_DIR = join(process.cwd(), 'tests', 'e2e', '__screenshots__');

export interface TileDiff {
  col: number;
  row: number;
  x: number;
  y: number;
  changedRatio: number;
}

export interface DiffResult {
  status: 'created' | 'match' | 'differ' | 'size-changed';
  /** Fraction of all pixels that differ beyond the per-channel threshold. */
  changedRatio: number;
  /** Tiles whose local change exceeds `tileThreshold`, worst first. */
  hotTiles: TileDiff[];
  width: number;
  height: number;
  diffPath?: string;
}

export interface DiffOptions {
  /** Per-channel difference below which two pixels count as equal. */
  channelTolerance?: number;
  tileSize?: number;
  /** A tile counts as changed when this fraction of its pixels differ. */
  tileThreshold?: number;
  /** Overwrite the baseline instead of comparing. */
  update?: boolean;
}

export function compareToBaseline(
  name: string,
  actual: Buffer,
  opts: DiffOptions = {},
): DiffResult {
  const channelTolerance = opts.channelTolerance ?? 12;
  const tileSize = opts.tileSize ?? 32;
  const tileThreshold = opts.tileThreshold ?? 0.02;

  const baselinePath = join(BASELINE_DIR, `${name}.png`);
  const actualPath = join(BASELINE_DIR, `${name}.actual.png`);
  const diffPath = join(BASELINE_DIR, `${name}.diff.png`);
  mkdirSync(dirname(baselinePath), { recursive: true });

  const actualPng = PNG.sync.read(actual);

  if (opts.update || !existsSync(baselinePath)) {
    writeFileSync(baselinePath, actual);
    return {
      status: 'created', changedRatio: 0, hotTiles: [],
      width: actualPng.width, height: actualPng.height,
    };
  }

  const basePng = PNG.sync.read(readFileSync(baselinePath));
  if (basePng.width !== actualPng.width || basePng.height !== actualPng.height) {
    writeFileSync(actualPath, actual);
    return {
      status: 'size-changed', changedRatio: 1, hotTiles: [],
      width: actualPng.width, height: actualPng.height,
    };
  }

  const { width, height } = basePng;
  const cols = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const tileChanged = new Uint32Array(cols * rows);
  const tileTotal = new Uint32Array(cols * rows);

  const diffPng = new PNG({ width, height });
  let changed = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dr = Math.abs(basePng.data[i] - actualPng.data[i]);
      const dg = Math.abs(basePng.data[i + 1] - actualPng.data[i + 1]);
      const db = Math.abs(basePng.data[i + 2] - actualPng.data[i + 2]);
      const isDiff = dr > channelTolerance || dg > channelTolerance || db > channelTolerance;

      const t = Math.floor(y / tileSize) * cols + Math.floor(x / tileSize);
      tileTotal[t]++;
      if (isDiff) {
        changed++;
        tileChanged[t]++;
        diffPng.data[i] = 255;
        diffPng.data[i + 1] = 40;
        diffPng.data[i + 2] = 90;
        diffPng.data[i + 3] = 255;
      } else {
        // Keep the unchanged image faintly visible so the diff is readable.
        const grey = (basePng.data[i] + basePng.data[i + 1] + basePng.data[i + 2]) / 3;
        const v = Math.round(grey * 0.25 + 40);
        diffPng.data[i] = v;
        diffPng.data[i + 1] = v;
        diffPng.data[i + 2] = v;
        diffPng.data[i + 3] = 255;
      }
    }
  }

  const hotTiles: TileDiff[] = [];
  for (let t = 0; t < tileChanged.length; t++) {
    if (tileTotal[t] === 0) continue;
    const ratio = tileChanged[t] / tileTotal[t];
    if (ratio >= tileThreshold) {
      hotTiles.push({
        col: t % cols,
        row: Math.floor(t / cols),
        x: (t % cols) * tileSize,
        y: Math.floor(t / cols) * tileSize,
        changedRatio: ratio,
      });
    }
  }
  hotTiles.sort((a, b) => b.changedRatio - a.changedRatio);

  const changedRatio = changed / (width * height);
  if (hotTiles.length === 0) {
    return { status: 'match', changedRatio, hotTiles, width, height };
  }

  writeFileSync(actualPath, actual);
  writeFileSync(diffPath, PNG.sync.write(diffPng));
  return { status: 'differ', changedRatio, hotTiles, width, height, diffPath };
}

/** Human-readable summary of where a frame changed. */
export function describeDiff(name: string, r: DiffResult): string {
  if (r.status === 'created') return `${name}: baseline created (${r.width}x${r.height})`;
  if (r.status === 'size-changed') return `${name}: viewport size changed to ${r.width}x${r.height}`;
  const head = `${name}: ${(r.changedRatio * 100).toFixed(3)}% pixels, ${r.hotTiles.length} hot tiles`;
  if (r.hotTiles.length === 0) return head;
  const worst = r.hotTiles.slice(0, 8)
    .map((t) => `(${t.x},${t.y})=${(t.changedRatio * 100).toFixed(0)}%`)
    .join(' ');
  return `${head}\n  worst regions: ${worst}`;
}
