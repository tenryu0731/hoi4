import type { Pt } from './geo';

/**
 * Visvalingam-Whyatt: repeatedly drop the vertex whose triangle with its two
 * neighbours has the smallest area. Endpoints are pinned so arcs stay stitched.
 */
export function simplifyArc(pts: Pt[], areaThreshold: number, minPoints = 2): Pt[] {
  const n = pts.length;
  if (n <= minPoints || n < 3) return pts;

  const alive = new Uint8Array(n);
  alive.fill(1);
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1;
    next[i] = i + 1;
  }
  next[n - 1] = -1;

  const triArea = (i: number): number => {
    const a = prev[i];
    const b = next[i];
    if (a < 0 || b < 0) return Infinity;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[i];
    const [cx, cy] = pts[b];
    return Math.abs((ax - cx) * (by - ay) - (ax - bx) * (cy - ay)) / 2;
  };

  const area = new Float64Array(n);
  for (let i = 0; i < n; i++) area[i] = triArea(i);

  let live = n;
  for (;;) {
    let bestIdx = -1;
    let bestArea = Infinity;
    for (let i = 1; i < n - 1; i++) {
      if (!alive[i]) continue;
      if (area[i] < bestArea) {
        bestArea = area[i];
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestArea >= areaThreshold || live <= minPoints) break;
    alive[bestIdx] = 0;
    live--;
    const a = prev[bestIdx];
    const b = next[bestIdx];
    next[a] = b;
    if (b >= 0) prev[b] = a;
    if (a > 0) area[a] = triArea(a);
    if (b >= 0 && b < n - 1) area[b] = triArea(b);
  }

  const outPts: Pt[] = [];
  for (let i = 0; i < n; i++) if (alive[i]) outPts.push(pts[i]);
  return outPts;
}
