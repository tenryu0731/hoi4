import { Texture } from 'pixi.js';

/**
 * Procedurally generated textures.
 *
 * Every surface texture in the game is synthesised at boot from a seeded value
 * noise field rather than downloaded. That keeps the asset budget at zero bytes
 * for the largest visual surfaces, and a deterministic seed means screenshot
 * diffs stay stable between runs.
 */

function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Tiling value noise: wraps exactly at `period` so the texture can repeat. */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const wrap = (v: number) => ((v % period) + period) % period;
  const xa = wrap(x0), xb = wrap(x0 + 1);
  const ya = wrap(y0), yb = wrap(y0 + 1);
  const v00 = hash2(xa, ya, seed);
  const v10 = hash2(xb, ya, seed);
  const v01 = hash2(xa, yb, seed);
  const v11 = hash2(xb, yb, seed);
  return (
    v00 * (1 - fx) * (1 - fy) +
    v10 * fx * (1 - fy) +
    v01 * (1 - fx) * fy +
    v11 * fx * fy
  );
}

/** Fractional Brownian motion over tiling value noise. */
function fbm(x: number, y: number, basePeriod: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, basePeriod * freq, seed + o * 977) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
  return { canvas, ctx };
}

/**
 * Shaded relief for the land fill. Renders a height field lit from the
 * north-west, which is the convention every printed atlas uses, so the result
 * reads as terrain rather than as noise.
 */
export function createReliefTexture(size = 512, seed = 1337): Texture {
  const { canvas, ctx } = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  const period = 8;
  const scale = period / size;

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = fbm(x * scale, y * scale, period, 5, seed);
      // Ridged transform emphasises mountain chains over rolling blur.
      const ridged = 1 - Math.abs(h * 2 - 1);
      height[y * size + x] = h * 0.65 + ridged * 0.35;
    }
  }

  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      // Light from the upper left; 6.0 exaggerates slope so it survives tinting.
      const light = 0.5 + (-dx - dy) * 6.0;
      const shade = Math.max(0.72, Math.min(1.22, light));
      const base = 214 * shade + (at(x, y) - 0.5) * 26;
      const v = Math.max(0, Math.min(255, base));
      const i = (y * size + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v * 0.985;
      img.data[i + 2] = v * 0.95;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return Texture.from(canvas);
}

/** Slow-moving swell for the ocean, tiled in screen space. */
export function createOceanTexture(size = 256, seed = 4242): Texture {
  const { canvas, ctx } = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  const period = 4;
  const scale = period / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * scale, y * scale, period, 4, seed);
      // Anisotropic squash gives the streaky look of open water.
      const streak = fbm(x * scale * 0.5, y * scale * 3, period, 3, seed + 31);
      const v = 128 + (n - 0.5) * 42 + (streak - 0.5) * 26;
      const i = (y * size + x) * 4;
      img.data[i] = v * 0.72;
      img.data[i + 1] = v * 0.9;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return Texture.from(canvas);
}

/** Fine paper grain laid over the whole map to break up flat fills. */
export function createGrainTexture(size = 256, seed = 77): Texture {
  const { canvas, ctx } = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = hash2(x, y, seed) * 0.6 + fbm((x / size) * 16, (y / size) * 16, 16, 3, seed) * 0.4;
      const v = Math.round(120 + (n - 0.5) * 90);
      const i = (y * size + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 46;
    }
  }
  ctx.putImageData(img, 0, 0);
  return Texture.from(canvas);
}

/** 1x64 vertical gradient, stretched to fade panels and the ocean depth ramp. */
export function createVerticalRamp(stops: [number, string][], height = 64): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, height);
  for (const [pos, color] of stops) g.addColorStop(pos, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1, height);
  return Texture.from(canvas);
}
