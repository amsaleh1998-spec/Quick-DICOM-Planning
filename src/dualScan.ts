// Dual scan protocol: the denture is scanned alone (with its radiopaque markers) and then in the
// patient's mouth. The markers - small, compact, very bright blobs - are found in both CBCTs and
// matched by the distances between them (which do not change when the denture is moved), giving the
// rigid transform from the denture scan into the patient's scan. The denture itself is segmented
// from the denture-only scan (the acrylic is the only solid object there) and placed with it.

import type { MeshData } from './meshio';
import type { Vec3 } from './math';
import { Affine, applyV, fitRigid } from './register';
import { ScalarGrid, fillCavities, isoSurface, smoothMesh } from './stl';
import type { Volume } from './volume';

export interface Marker {
  /** centre (world mm of its volume), weighted by intensity */
  p: Vec3;
  /** volume (mm³) */
  mm3: number;
  /** brightest value */
  peak: number;
}

/** Value histogram of a volume: counts per value from vol.min. */
function histogram(vol: Volume): Int32Array {
  const h = new Int32Array(vol.max - vol.min + 1);
  const d = vol.data;
  const mn = vol.min;
  for (let i = 0; i < d.length; i++) h[d[i] - mn]++;
  return h;
}

function percentile(vol: Volume, h: Int32Array, q: number): number {
  const target = q * vol.data.length;
  let acc = 0;
  for (let i = 0; i < h.length; i++) {
    acc += h[i];
    if (acc >= target) return vol.min + i;
  }
  return vol.max;
}

/**
 * Threshold for the markers: half-way between the bulk of the volume (99th percentile: air, acrylic,
 * bone) and the brightest voxels (the markers, 99.999th percentile).
 */
export function autoMarkerThreshold(vol: Volume): number {
  const h = histogram(vol);
  const bulk = percentile(vol, h, 0.99);
  const top = Math.max(percentile(vol, h, 0.99999), bulk + 1);
  return Math.round(bulk + 0.5 * (top - bulk));
}

/** Small, compact, bright blobs above `threshold` – marker candidates. */
export function findMarkers(vol: Volume, threshold: number, opts: { minMm3?: number; maxMm3?: number; maxSize?: number } = {}): Marker[] {
  const minMm3 = opts.minMm3 ?? 0.15;
  const maxMm3 = opts.maxMm3 ?? 60;
  const maxSize = opts.maxSize ?? 7; // mm, along every axis
  const { nx, ny, nz, data, spacing: sp } = vol;
  const nxy = nx * ny;
  const vox = sp[0] * sp[1] * sp[2];
  const seen = new Uint8Array(data.length);
  let stack = new Int32Array(1 << 14);
  const out: Marker[] = [];
  for (let s0 = 0; s0 < data.length; s0++) {
    if (seen[s0] || data[s0] < threshold) continue;
    // flood fill (6-connected)
    let n = 0, sw = 0, cx = 0, cy = 0, cz = 0, peak = -32768;
    let i0 = nx, i1 = 0, j0 = ny, j1 = 0, k0 = nz, k1 = 0;
    let top = 0;
    stack[top++] = s0;
    seen[s0] = 1;
    while (top) {
      const id = stack[--top];
      const k = (id / nxy) | 0;
      const r = id - k * nxy;
      const j = (r / nx) | 0;
      const i = r - j * nx;
      const v = data[id];
      const w = v - threshold + 1;
      n++;
      sw += w;
      cx += w * i;
      cy += w * j;
      cz += w * k;
      if (v > peak) peak = v;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
      if (k < k0) k0 = k;
      if (k > k1) k1 = k;
      if (top + 6 > stack.length) {
        const bigger = new Int32Array(stack.length * 2);
        bigger.set(stack);
        stack = bigger;
      }
      const push = (q: number) => {
        if (!seen[q] && data[q] >= threshold) {
          seen[q] = 1;
          stack[top++] = q;
        }
      };
      if (i > 0) push(id - 1);
      if (i < nx - 1) push(id + 1);
      if (j > 0) push(id - nx);
      if (j < ny - 1) push(id + nx);
      if (k > 0) push(id - nxy);
      if (k < nz - 1) push(id + nxy);
    }
    const mm3 = n * vox;
    if (mm3 < minMm3 || mm3 > maxMm3) continue;
    const size = [(i1 - i0 + 1) * sp[0], (j1 - j0 + 1) * sp[1], (k1 - k0 + 1) * sp[2]];
    if (Math.max(...size) > maxSize) continue;
    // compact: fills a fair part of its bounding box (not a thin streak or a sliver of enamel)
    if (n / ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1)) < 0.15) continue;
    out.push({ p: [(cx / sw) * sp[0], (cy / sw) * sp[1], (cz / sw) * sp[2]], mm3, peak });
  }
  return out;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface MarkerMatch {
  /** denture scan -> patient scan (world mm) */
  T: Affine;
  /** [index in the denture markers, index in the patient candidates] */
  pairs: [number, number][];
  /** root mean square distance of the matched markers after the fit (mm) */
  rms: number;
}

/**
 * Match the denture's markers D to candidates P in the patient's scan (P may hold extra blobs):
 * pairs of markers with the same distance give candidate triangles, each triangle a rigid
 * transform; the transform that brings the most markers onto candidates wins and is refitted on
 * all of them. Null when fewer than 3 markers can be matched.
 */
export function matchMarkers(D: Vec3[], P: Vec3[], tol = 0.7): MarkerMatch | null {
  if (D.length < 3 || P.length < 3) return null;
  // pairs of candidates, sorted by distance (looked up by range)
  const pp: { d: number; a: number; b: number }[] = [];
  for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) pp.push({ d: dist(P[a], P[b]), a, b });
  pp.sort((x, y) => x.d - y.d);
  const pd = Float64Array.from(pp.map((x) => x.d));
  const lower = (d: number) => {
    let lo = 0, hi = pd.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (pd[m] < d) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const inliers = (T: Affine) => {
    const pairs: [number, number][] = [];
    let ss = 0;
    const used = new Set<number>();
    for (let i = 0; i < D.length; i++) {
      const q = applyV(T, D[i]);
      let best = -1, bd = tol;
      for (let j = 0; j < P.length; j++) {
        const d = dist(q, P[j]);
        if (d < bd && !used.has(j)) {
          bd = d;
          best = j;
        }
      }
      if (best >= 0) {
        used.add(best);
        pairs.push([i, best]);
        ss += bd * bd;
      }
    }
    return { pairs, rms: pairs.length ? Math.sqrt(ss / pairs.length) : Infinity };
  };
  // denture pairs, longest first (a long baseline fixes the transform best)
  const dp: [number, number][] = [];
  for (let i = 0; i < D.length; i++) for (let j = i + 1; j < D.length; j++) dp.push([i, j]);
  dp.sort((x, y) => dist(D[y[0]], D[y[1]]) - dist(D[x[0]], D[x[1]]));
  let best: { pairs: [number, number][]; rms: number; T: Affine } | null = null;
  let tries = 0;
  outer: for (const [i, j] of dp) {
    const dij = dist(D[i], D[j]);
    for (let m = lower(dij - tol); m < pd.length && pd[m] <= dij + tol; m++) {
      for (const [p, q] of [
        [pp[m].a, pp[m].b],
        [pp[m].b, pp[m].a],
      ]) {
        for (let k = 0; k < D.length; k++) {
          if (k === i || k === j) continue;
          const dik = dist(D[i], D[k]), djk = dist(D[j], D[k]);
          // the triangle must not be degenerate (nearly collinear markers fix no rotation)
          const s = (dij + dik + djk) / 2;
          if (Math.sqrt(Math.max(0, s * (s - dij) * (s - dik) * (s - djk))) < 2) continue;
          for (let r = 0; r < P.length; r++) {
            if (r === p || r === q) continue;
            if (Math.abs(dist(P[p], P[r]) - dik) > tol || Math.abs(dist(P[q], P[r]) - djk) > tol) continue;
            const T = fitRigid([D[i], D[j], D[k]], [P[p], P[q], P[r]]);
            const res = inliers(T);
            if (!best || res.pairs.length > best.pairs.length || (res.pairs.length === best.pairs.length && res.rms < best.rms)) best = { ...res, T };
            if (best.pairs.length === D.length && best.rms < tol / 3) break outer;
            if (++tries > 40000) break outer;
          }
        }
      }
    }
  }
  if (!best || best.pairs.length < 3) return null;
  // refit on every matched marker (twice: the refit may pick up one more)
  let T = best.T;
  let res = best;
  for (let it = 0; it < 2; it++) {
    T = fitRigid(
      res.pairs.map(([a]) => D[a]),
      res.pairs.map(([, b]) => P[b]),
    );
    const r2 = inliers(T);
    if (r2.pairs.length < res.pairs.length) break;
    res = { ...r2, T };
  }
  return { T: res.T, pairs: res.pairs, rms: res.rms };
}

/** Threshold between air and acrylic (Otsu), below the markers' threshold. */
export function autoDentureThreshold(vol: Volume, below: number): number {
  const h = histogram(vol);
  const top = Math.min(h.length - 1, below - vol.min - 1);
  let total = 0, sum = 0;
  for (let i = 0; i <= top; i++) {
    total += h[i];
    sum += i * h[i];
  }
  // the best split; where several values split equally well (nothing lies between air and acrylic),
  // the middle of that range – not right at the edge of the air's noise
  let wB = 0, sumB = 0, bestT = 0, bestEnd = 0, bestV = -1;
  for (let t = 0; t <= top; t++) {
    wB += h[t];
    sumB += t * h[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > bestV * (1 + 1e-9)) {
      bestV = v;
      bestT = bestEnd = t;
    } else if (v >= bestV * (1 - 1e-9) && bestEnd === t - 1) bestEnd = t;
  }
  return vol.min + Math.round((bestT + bestEnd) / 2) + 1;
}

/** Sampling step (voxels) so the grid stays below `maxSamples`. */
function stepFor(vol: Volume, maxSamples: number): number {
  let st = 1;
  while (Math.ceil(vol.nx / st) * Math.ceil(vol.ny / st) * Math.ceil(vol.nz / st) > maxSamples) st++;
  return st;
}

/**
 * The denture: the largest connected object above `threshold` in the denture-only scan (the
 * acrylic with its markers; loose bits such as the scanning support or noise are left out).
 * Returns the sampled mask (1 = denture) on a grid of `step` voxels, for previews.
 */
export function dentureMask(vol: Volume, threshold: number, maxSamples = 4_000_000): { mask: Uint8Array; nx: number; ny: number; nz: number; step: number; voxels: number } {
  const st = stepFor(vol, maxSamples);
  const gx = Math.ceil(vol.nx / st), gy = Math.ceil(vol.ny / st), gz = Math.ceil(vol.nz / st);
  const { nx, ny, data } = vol;
  const nxy = nx * ny;
  const gxy = gx * gy;
  const on = new Uint8Array(gx * gy * gz);
  for (let c = 0; c < gz; c++)
    for (let b = 0; b < gy; b++)
      for (let a = 0; a < gx; a++) on[a + b * gx + c * gxy] = data[a * st + b * st * nx + c * st * nxy] >= threshold ? 1 : 0;
  // label components, keep the largest
  const label = new Int32Array(on.length);
  let stack = new Int32Array(1 << 14);
  let bestLabel = 0, bestSize = 0, next = 0;
  for (let s0 = 0; s0 < on.length; s0++) {
    if (!on[s0] || label[s0]) continue;
    next++;
    let size = 0, top = 0;
    stack[top++] = s0;
    label[s0] = next;
    while (top) {
      const id = stack[--top];
      size++;
      const c = (id / gxy) | 0;
      const r = id - c * gxy;
      const b = (r / gx) | 0;
      const a = r - b * gx;
      if (top + 6 > stack.length) {
        const bigger = new Int32Array(stack.length * 2);
        bigger.set(stack);
        stack = bigger;
      }
      const push = (q: number) => {
        if (on[q] && !label[q]) {
          label[q] = next;
          stack[top++] = q;
        }
      };
      if (a > 0) push(id - 1);
      if (a < gx - 1) push(id + 1);
      if (b > 0) push(id - gx);
      if (b < gy - 1) push(id + gx);
      if (c > 0) push(id - gxy);
      if (c < gz - 1) push(id + gxy);
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = next;
    }
  }
  const mask = new Uint8Array(on.length);
  for (let i = 0; i < mask.length; i++) mask[i] = label[i] === bestLabel && bestLabel ? 1 : 0;
  return { mask, nx: gx, ny: gy, nz: gz, step: st, voxels: bestSize };
}

/**
 * Surface of the denture (closed, smoothed), in the denture scan's world mm. Inner cavities are
 * filled (acrylic is solid).
 */
export async function dentureSurface(vol: Volume, threshold: number, onProgress?: (f: number) => void, maxSamples = 30_000_000): Promise<MeshData> {
  const m = dentureMask(vol, threshold, maxSamples);
  const { step: st } = m;
  // padded grid: the iso value s = 0 at the threshold inside the kept object, negative elsewhere
  const sx = m.nx + 2, sy = m.ny + 2, sz = m.nz + 2;
  const s = new Float32Array(sx * sy * sz).fill(-1000);
  const { nx, ny, data } = vol;
  const nxy = nx * ny;
  const iso = threshold - 0.5;
  for (let c = 0; c < m.nz; c++)
    for (let b = 0; b < m.ny; b++)
      for (let a = 0; a < m.nx; a++) {
        const v = data[a * st + b * st * nx + c * st * nxy];
        const g = a + b * m.nx + c * m.nx * m.ny;
        // voxels of other objects above the threshold count as outside
        s[a + 1 + (b + 1) * sx + (c + 1) * sx * sy] = m.mask[g] ? v - iso : Math.min(v - iso, -0.5);
      }
  const sp = vol.spacing;
  const grid: ScalarGrid = { nx: sx, ny: sy, nz: sz, s, origin: [-st * sp[0], -st * sp[1], -st * sp[2]], step: [st * sp[0], st * sp[1], st * sp[2]] };
  fillCavities(grid);
  const mesh = await isoSurface(grid, (f) => onProgress?.(f * 0.8));
  await smoothMesh(mesh, 10, 0.5, -0.53, (f) => onProgress?.(0.8 + f * 0.2));
  return { pos: mesh.pos, idx: mesh.idx, col: null };
}
