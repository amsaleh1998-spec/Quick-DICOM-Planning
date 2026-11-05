// Rigid registration of a surface scan to a CBCT surface: point pairs (Horn), point-to-plane ICP
// on a k-d tree, and an automatic global search for surface matching.
// Transforms are 3×4 row-major [R | t] (p' = R·p + t).

import type { Vec3 } from './math';

export type Affine = number[];

export const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function apply(m: Affine, x: number, y: number, z: number, out: Float64Array | number[], o = 0) {
  out[o] = m[0] * x + m[1] * y + m[2] * z + m[3];
  out[o + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
  out[o + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
}
export function applyV(m: Affine, p: Vec3): Vec3 {
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
}
export function rotV(m: Affine, d: Vec3): Vec3 {
  return [m[0] * d[0] + m[1] * d[1] + m[2] * d[2], m[4] * d[0] + m[5] * d[1] + m[6] * d[2], m[8] * d[0] + m[9] * d[1] + m[10] * d[2]];
}
/** a ∘ b (b first). */
export function compose(a: Affine, b: Affine): Affine {
  const o = new Array<number>(12);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++) {
      let v = c === 3 ? a[r * 4 + 3] : 0;
      for (let k = 0; k < 3; k++) v += a[r * 4 + k] * b[k * 4 + c];
      o[r * 4 + c] = v;
    }
  return o;
}
/** Inverse of a general (invertible) affine. */
export function invert(m: Affine): Affine {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('Transform is not invertible');
  const inv = [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
  const t = [m[3], m[7], m[11]];
  return [
    inv[0], inv[1], inv[2], -(inv[0] * t[0] + inv[1] * t[1] + inv[2] * t[2]),
    inv[3], inv[4], inv[5], -(inv[3] * t[0] + inv[4] * t[1] + inv[5] * t[2]),
    inv[6], inv[7], inv[8], -(inv[6] * t[0] + inv[7] * t[1] + inv[8] * t[2]),
  ];
}
/** Rotation (3×3 row-major) as an affine about the origin. */
export function fromRot(R: number[], t: Vec3 = [0, 0, 0]): Affine {
  return [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2]];
}
/** Rotation of `angle` radians about unit axis (Rodrigues). */
export function axisAngle(ax: Vec3, angle: number): number[] {
  const [x, y, z] = ax;
  const c = Math.cos(angle), s = Math.sin(angle), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
const mul3 = (A: number[], B: number[]) => {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return o;
};
/** Smallest rotation taking unit vector a onto unit vector b. */
export function rotateOnto(a: Vec3, b: Vec3): number[] {
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let ax: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const s = Math.hypot(...ax);
  if (s < 1e-9) {
    if (c > 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    // opposite: any perpendicular axis
    ax = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[2], 0, a[0]];
    const l = Math.hypot(...ax);
    return axisAngle([ax[0] / l, ax[1] / l, ax[2] / l], Math.PI);
  }
  return axisAngle([ax[0] / s, ax[1] / s, ax[2] / s], Math.atan2(s, c));
}

// ---- point pairs (Horn's quaternion method) ------------------------------------

/** Best rigid transform taking points P onto Q (least squares). Needs ≥ 3 non-collinear pairs. */
export function fitRigid(P: Vec3[], Q: Vec3[], w?: number[]): Affine {
  const n = P.length;
  let W = 0;
  const cp = [0, 0, 0], cq = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const wi = w ? w[i] : 1;
    W += wi;
    for (let k = 0; k < 3; k++) {
      cp[k] += wi * P[i][k];
      cq[k] += wi * Q[i][k];
    }
  }
  for (let k = 0; k < 3; k++) {
    cp[k] /= W;
    cq[k] /= W;
  }
  const S = new Array<number>(9).fill(0); // S[a][b] = Σ p_a q_b
  for (let i = 0; i < n; i++) {
    const wi = w ? w[i] : 1;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a * 3 + b] += wi * (P[i][a] - cp[a]) * (Q[i][b] - cq[b]);
  }
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
  const N = [
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ];
  const q = largestEigenvector4(N);
  const [q0, qx, qy, qz] = q;
  const R = [
    q0 * q0 + qx * qx - qy * qy - qz * qz, 2 * (qx * qy - q0 * qz), 2 * (qx * qz + q0 * qy),
    2 * (qy * qx + q0 * qz), q0 * q0 - qx * qx + qy * qy - qz * qz, 2 * (qy * qz - q0 * qx),
    2 * (qz * qx - q0 * qy), 2 * (qz * qy + q0 * qx), q0 * q0 - qx * qx - qy * qy + qz * qz,
  ];
  const t: Vec3 = [
    cq[0] - (R[0] * cp[0] + R[1] * cp[1] + R[2] * cp[2]),
    cq[1] - (R[3] * cp[0] + R[4] * cp[1] + R[5] * cp[2]),
    cq[2] - (R[6] * cp[0] + R[7] * cp[1] + R[8] * cp[2]),
  ];
  return fromRot(R, t);
}

/** Jacobi eigen-decomposition of a symmetric 4×4 matrix; eigenvector of the largest eigenvalue. */
function largestEigenvector4(M: number[]): number[] {
  const a = M.slice();
  const v = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p * 4 + q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++)
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p * 4 + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q * 4 + q] - a[p * 4 + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k * 4 + p], akq = a[k * 4 + q];
          a[k * 4 + p] = c * akp - s * akq;
          a[k * 4 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p * 4 + k], aqk = a[q * 4 + k];
          a[p * 4 + k] = c * apk - s * aqk;
          a[q * 4 + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k * 4 + p], vkq = v[k * 4 + q];
          v[k * 4 + p] = c * vkp - s * vkq;
          v[k * 4 + q] = s * vkp + c * vkq;
        }
      }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i * 4 + i] > a[best * 4 + best]) best = i;
  const e = [v[best], v[4 + best], v[8 + best], v[12 + best]];
  const l = Math.hypot(...e) || 1;
  return e.map((x) => x / l);
}

// ---- k-d tree ---------------------------------------------------------------------

export class KdTree {
  private idx: Uint32Array;
  constructor(readonly pts: Float32Array) {
    const n = pts.length / 3;
    this.idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.idx[i] = i;
    // iterative build: stack of [lo, hi, axis)
    const stack: number[] = [0, n, 0];
    while (stack.length) {
      const axis = stack.pop()!;
      const hi = stack.pop()!;
      const lo = stack.pop()!;
      if (hi - lo <= 1) continue;
      const mid = (lo + hi) >> 1;
      this.select(lo, hi - 1, mid, axis);
      const na = (axis + 1) % 3;
      stack.push(lo, mid, na, mid + 1, hi, na);
    }
  }
  private select(lo: number, hi: number, k: number, axis: number) {
    const P = this.pts, I = this.idx;
    while (hi > lo) {
      const pv = P[I[(lo + hi) >> 1] * 3 + axis];
      let i = lo, j = hi;
      while (i <= j) {
        while (P[I[i] * 3 + axis] < pv) i++;
        while (P[I[j] * 3 + axis] > pv) j--;
        if (i <= j) {
          const t = I[i];
          I[i] = I[j];
          I[j] = t;
          i++;
          j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }
  private best = -1;
  private bestD = Infinity;
  /** Index of the nearest point within sqrt(maxD2) (or -1); distance² in `lastD2`. */
  nearest(x: number, y: number, z: number, maxD2 = Infinity): number {
    this.best = -1;
    this.bestD = maxD2;
    this.search(0, this.idx.length, 0, x, y, z);
    this.lastD2 = this.bestD;
    return this.best;
  }
  lastD2 = Infinity;
  private search(lo: number, hi: number, axis: number, x: number, y: number, z: number) {
    const P = this.pts, I = this.idx;
    while (hi - lo > 0) {
      const mid = (lo + hi) >> 1;
      const p = I[mid] * 3;
      const dx = P[p] - x, dy = P[p + 1] - y, dz = P[p + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < this.bestD) {
        this.bestD = d2;
        this.best = I[mid];
      }
      const diff = axis === 0 ? x - P[p] : axis === 1 ? y - P[p + 1] : z - P[p + 2];
      const na = (axis + 1) % 3;
      // near side first, far side only if the splitting plane is closer than the best
      if (diff < 0) {
        this.search(lo, mid, na, x, y, z);
        if (diff * diff < this.bestD) {
          lo = mid + 1;
          axis = na;
          continue;
        }
      } else {
        this.search(mid + 1, hi, na, x, y, z);
        if (diff * diff < this.bestD) {
          hi = mid;
          axis = na;
          continue;
        }
      }
      return;
    }
  }
}

// ---- target surface --------------------------------------------------------------

/** CBCT surface prepared for matching: points + normals (world mm), k-d tree, coarse distance map. */
export class Target {
  readonly tree: KdTree;
  readonly df: DistanceField;
  constructor(readonly pts: Float32Array, readonly nrm: Float32Array) {
    this.tree = new KdTree(pts);
    this.df = new DistanceField(pts, 1.0);
  }
  get count() {
    return this.pts.length / 3;
  }
}

/** Keep one point per cell of `cell` mm (with its normal). */
export function thinPoints(pos: Float32Array, nrm: Float32Array, cell: number): { pts: Float32Array; nrm: Float32Array } {
  const seen = new Set<number>();
  const op: number[] = [];
  const on: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    const k = Math.floor(pos[i] / cell) * 73856093 ^ Math.floor(pos[i + 1] / cell) * 19349663 ^ Math.floor(pos[i + 2] / cell) * 83492791;
    if (seen.has(k)) continue;
    seen.add(k);
    op.push(pos[i], pos[i + 1], pos[i + 2]);
    on.push(nrm[i], nrm[i + 1], nrm[i + 2]);
  }
  return { pts: Float32Array.from(op), nrm: Float32Array.from(on) };
}

/** Unsigned distance (mm) to a point set on a coarse grid (exact Euclidean transform of the occupied cells). */
export class DistanceField {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly o: Vec3;
  readonly d: Float32Array;
  constructor(pts: Float32Array, readonly cell: number, margin = 25) {
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pts.length; i += 3)
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], pts[i + k]);
        mx[k] = Math.max(mx[k], pts[i + k]);
      }
    mn = mn.map((v) => v - margin);
    mx = mx.map((v) => v + margin);
    this.o = mn as Vec3;
    this.nx = Math.ceil((mx[0] - mn[0]) / cell) + 1;
    this.ny = Math.ceil((mx[1] - mn[1]) / cell) + 1;
    this.nz = Math.ceil((mx[2] - mn[2]) / cell) + 1;
    const { nx, ny, nz } = this;
    const INF = 1e20;
    const f = new Float64Array(nx * ny * nz).fill(INF);
    for (let i = 0; i < pts.length; i += 3) {
      const a = Math.round((pts[i] - mn[0]) / cell), b = Math.round((pts[i + 1] - mn[1]) / cell), c = Math.round((pts[i + 2] - mn[2]) / cell);
      f[a + b * nx + c * nx * ny] = 0;
    }
    // Felzenszwalb–Huttenlocher squared distance transform, one axis at a time
    const edt1 = (get: (i: number) => number, set: (i: number, v: number) => void, n: number, buf: Float64Array, v: Int32Array, z: Float64Array) => {
      for (let i = 0; i < n; i++) buf[i] = get(i);
      let k = 0;
      v[0] = 0;
      z[0] = -INF;
      z[1] = INF;
      for (let q = 1; q < n; q++) {
        let s: number;
        for (;;) {
          const p = v[k];
          s = (buf[q] + q * q - (buf[p] + p * p)) / (2 * q - 2 * p);
          if (s <= z[k] && k > 0) k--;
          else break;
        }
        if (s <= z[k]) {
          // k === 0
          v[0] = q;
          z[0] = -INF;
          z[1] = INF;
          continue;
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        const p = v[k];
        set(q, (q - p) * (q - p) + buf[p]);
      }
    };
    const m = Math.max(nx, ny, nz);
    const buf = new Float64Array(m), vv = new Int32Array(m), zz = new Float64Array(m + 1);
    const nxy = nx * ny;
    for (let c = 0; c < nz; c++)
      for (let b = 0; b < ny; b++) {
        const base = b * nx + c * nxy;
        edt1((i) => f[base + i], (i, val) => (f[base + i] = val), nx, buf, vv, zz);
      }
    for (let c = 0; c < nz; c++)
      for (let a = 0; a < nx; a++) {
        const base = a + c * nxy;
        edt1((i) => f[base + i * nx], (i, val) => (f[base + i * nx] = val), ny, buf, vv, zz);
      }
    for (let b = 0; b < ny; b++)
      for (let a = 0; a < nx; a++) {
        const base = a + b * nx;
        edt1((i) => f[base + i * nxy], (i, val) => (f[base + i * nxy] = val), nz, buf, vv, zz);
      }
    this.d = new Float32Array(f.length);
    for (let i = 0; i < f.length; i++) this.d[i] = Math.sqrt(f[i]) * cell;
  }
  /** Trilinear distance at a world point; `g` receives the gradient (unit-ish). Far outside = large. */
  sample(x: number, y: number, z: number, g?: Float64Array): number {
    const fx = (x - this.o[0]) / this.cell, fy = (y - this.o[1]) / this.cell, fz = (z - this.o[2]) / this.cell;
    const { nx, ny, nz } = this;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) {
      if (g) g[0] = g[1] = g[2] = 0;
      return 1e3;
    }
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const u = fx - i, v = fy - j, w = fz - k;
    const nxy = nx * ny;
    const b = i + j * nx + k * nxy;
    const d = this.d;
    const c000 = d[b], c100 = d[b + 1], c010 = d[b + nx], c110 = d[b + nx + 1];
    const c001 = d[b + nxy], c101 = d[b + nxy + 1], c011 = d[b + nxy + nx], c111 = d[b + nxy + nx + 1];
    const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u, x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
    if (g) {
      const dx0 = (c100 - c000) * (1 - v) + (c110 - c010) * v, dx1 = (c101 - c001) * (1 - v) + (c111 - c011) * v;
      g[0] = (dx0 * (1 - w) + dx1 * w) / this.cell;
      g[1] = ((x10 - x00) * (1 - w) + (x11 - x01) * w) / this.cell;
      g[2] = (y1 - y0) / this.cell;
    }
    return y0 + (y1 - y0) * w;
  }
}

// ---- ICP ----------------------------------------------------------------------------

export interface FitStats {
  /** RMS distance of the inlier pairs (mm) */
  rms: number;
  /** mean absolute distance (mm) */
  mean: number;
  /** fraction of points within 0.5 mm / 1 mm */
  within05: number;
  within1: number;
  n: number;
}

/** Distances of transformed source points to the target surface (point-to-plane near the surface). */
export function fitStats(src: Float32Array, T: Affine, target: Target, maxD = 3): FitStats {
  const p = new Float64Array(3);
  let n = 0, s2 = 0, s1 = 0, w05 = 0, w1 = 0, cnt = 0;
  for (let i = 0; i < src.length; i += 3) {
    apply(T, src[i], src[i + 1], src[i + 2], p);
    cnt++;
    const j = target.tree.nearest(p[0], p[1], p[2], maxD * maxD);
    if (j < 0) continue;
    const q = j * 3;
    const d = Math.abs((p[0] - target.pts[q]) * target.nrm[q] + (p[1] - target.pts[q + 1]) * target.nrm[q + 1] + (p[2] - target.pts[q + 2]) * target.nrm[q + 2]);
    const de = Math.min(d, Math.sqrt(target.tree.lastD2));
    n++;
    s2 += de * de;
    s1 += de;
    if (de <= 0.5) w05++;
    if (de <= 1) w1++;
  }
  return { rms: n ? Math.sqrt(s2 / n) : Infinity, mean: n ? s1 / n : Infinity, within05: cnt ? w05 / cnt : 0, within1: cnt ? w1 / cnt : 0, n };
}

/**
 * ICP refinement of T (scan -> world) so the source points lie on the target surface: first
 * point-to-point steps (wide capture range; outliers only rejected by the gate), then point-to-plane
 * steps (sub-voxel accuracy, robust weights). Pairs beyond the shrinking gate or with
 * incompatible normals are ignored.
 */
export function icp(
  src: Float32Array,
  srcN: Float32Array | null,
  T0: Affine,
  target: Target,
  opts: { iterations?: number; gate0?: number; gate1?: number; coarseIterations?: number } = {},
): Affine {
  /** point-to-plane iterations */
  const iterations = opts.iterations ?? 20;
  /** point-to-point iterations (fixed gate: shrinking it early stalls the pull-in) */
  const coarseIts = opts.coarseIterations ?? 60;
  const gate0 = opts.gate0 ?? 4;
  const gate1 = opts.gate1 ?? 0.8;
  let T = T0.slice();
  const p = new Float64Array(3);
  const P = target.pts, N = target.nrm;
  const normalOk = (i: number, q: number) => {
    if (!srcN) return true;
    const sn = rotV(T, [srcN[i], srcN[i + 1], srcN[i + 2]]);
    return Math.abs(sn[0] * N[q] + sn[1] * N[q + 1] + sn[2] * N[q + 2]) >= 0.5;
  };
  // ---- phase 1: point-to-point
  for (let it = 0; it < coarseIts; it++) {
    const gate = gate0;
    const A: Vec3[] = [], B: Vec3[] = [];
    for (let i = 0; i < src.length; i += 3) {
      apply(T, src[i], src[i + 1], src[i + 2], p);
      const j = target.tree.nearest(p[0], p[1], p[2], gate * gate);
      if (j < 0 || !normalOk(i, j * 3)) continue;
      A.push([p[0], p[1], p[2]]);
      B.push([P[j * 3], P[j * 3 + 1], P[j * 3 + 2]]);
    }
    if (A.length < 6) break;
    // no trimming here: the far pairs are the ones that pull the scan into place
    const step = fitRigid(A, B);
    T = compose(step, T);
    const moved = Math.hypot(step[3], step[7], step[11]) + Math.abs(step[0] - 1) + Math.abs(step[5] - 1) + Math.abs(step[10] - 1);
    if (moved < 1e-5) break;
  }
  // ---- phase 2: point-to-plane
  const A = new Float64Array(36);
  const bv = new Float64Array(6);
  const fineIts = iterations;
  for (let it = 0; it < fineIts; it++) {
    const gate = Math.max(gate1, 1.2) + (gate1 - Math.max(gate1, 1.2)) * (it / Math.max(1, fineIts - 1));
    A.fill(0);
    bv.fill(0);
    let used = 0;
    for (let i = 0; i < src.length; i += 3) {
      apply(T, src[i], src[i + 1], src[i + 2], p);
      const j = target.tree.nearest(p[0], p[1], p[2], gate * gate);
      if (j < 0) continue;
      const q = j * 3;
      if (!normalOk(i, q)) continue;
      const nx = N[q], ny = N[q + 1], nz = N[q + 2];
      const r = (p[0] - P[q]) * nx + (p[1] - P[q + 1]) * ny + (p[2] - P[q + 2]) * nz;
      // J = [p × n, n]
      const J = [p[1] * nz - p[2] * ny, p[2] * nx - p[0] * nz, p[0] * ny - p[1] * nx, nx, ny, nz];
      const w = Math.abs(r) < 0.3 ? 1 : 0.3 / Math.abs(r);
      for (let a = 0; a < 6; a++) {
        bv[a] -= w * J[a] * r;
        for (let b = a; b < 6; b++) A[a * 6 + b] += w * J[a] * J[b];
      }
      used++;
    }
    if (used < 6) break;
    for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) A[a * 6 + b] = A[b * 6 + a];
    const x = solve6(A, bv);
    if (!x) break;
    const ang = Math.hypot(x[0], x[1], x[2]);
    const R = ang > 1e-12 ? axisAngle([x[0] / ang, x[1] / ang, x[2] / ang], ang) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    T = compose(fromRot(R, [x[3], x[4], x[5]]), T);
    if (ang < 1e-7 && Math.hypot(x[3], x[4], x[5]) < 1e-6) break;
  }
  return T;
}

function solve6(A: Float64Array, b: Float64Array): number[] | null {
  const M = Array.from({ length: 6 }, (_, r) => [...A.subarray(r * 6, r * 6 + 6), b[r]]);
  for (let c = 0; c < 6; c++) {
    let piv = c;
    for (let r = c + 1; r < 6; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 6; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 7; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, r) => row[6] / M[r][r]);
}

// ---- coarse alignment on the distance map -----------------------------------------

/** Mean of the best 70 % distances (cheap score on the distance map). */
export function dfScore(src: Float32Array, T: Affine, df: DistanceField): number {
  const n = src.length / 3;
  const ds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    ds[i] = df.sample(T[0] * x + T[1] * y + T[2] * z + T[3], T[4] * x + T[5] * y + T[6] * z + T[7], T[8] * x + T[9] * y + T[10] * z + T[11]);
  }
  ds.sort();
  const k = Math.max(1, Math.floor(n * 0.7));
  let s = 0;
  for (let i = 0; i < k; i++) s += ds[i];
  return s / k;
}

/** A few ICP steps on the distance map (closest point ≈ p − d·∇d), trimmed to the best 70 %. */
export function dfIcp(src: Float32Array, T0: Affine, df: DistanceField, iterations: number): Affine {
  let T = T0;
  const n = src.length / 3;
  const g = new Float64Array(3);
  const P: Vec3[] = [], Q: Vec3[] = [], D: number[] = [];
  for (let it = 0; it < iterations; it++) {
    P.length = Q.length = D.length = 0;
    for (let i = 0; i < n; i++) {
      const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
      const p: Vec3 = [T[0] * x + T[1] * y + T[2] * z + T[3], T[4] * x + T[5] * y + T[6] * z + T[7], T[8] * x + T[9] * y + T[10] * z + T[11]];
      const d = df.sample(p[0], p[1], p[2], g);
      if (d > 15) continue;
      const gl = Math.hypot(g[0], g[1], g[2]);
      if (gl < 1e-6) continue;
      P.push(p);
      Q.push([p[0] - (d * g[0]) / gl, p[1] - (d * g[1]) / gl, p[2] - (d * g[2]) / gl]);
      D.push(d);
    }
    if (P.length < 6) break;
    const order = D.map((d, i) => [d, i]).sort((a, b) => a[0] - b[0]);
    const keep = order.slice(0, Math.max(6, Math.floor(order.length * 0.7))).map((x) => x[1]);
    const step = fitRigid(keep.map((i) => P[i]), keep.map((i) => Q[i]));
    T = compose(step, T);
  }
  return T;
}

/** Random subset of `k` points (deterministic). */
export function subsample(pts: Float32Array, k: number, seed = 1): Float32Array {
  const n = pts.length / 3;
  if (n <= k) return pts.slice();
  const out = new Float32Array(k * 3);
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  // stratified: one random pick per bucket
  for (let i = 0; i < k; i++) {
    const j = Math.min(n - 1, Math.floor(((i + rnd()) * n) / k));
    out[i * 3] = pts[j * 3];
    out[i * 3 + 1] = pts[j * 3 + 1];
    out[i * 3 + 2] = pts[j * 3 + 2];
  }
  return out;
}

export interface GlobalOpts {
  /** occlusal direction of the scan (scan coordinates, unit): out of the occlusal surfaces */
  scanOcclusal: Vec3;
  /** false = rough estimate (partial arch): search wider tilts */
  occlusalConfident?: boolean;
  /** optional point pairs (scan / world) that pin the search: 1 = position, 2 = axis, ≥3 = start */
  hints?: { scan: Vec3[]; world: Vec3[] };
  /** centre of the whole scan (scan coordinates) – placed over the centre of the target arch */
  scanCenter: Vec3;
  /** direction in world in which the teeth of this jaw point (upper: inferior, lower: superior) */
  targetOcclusal: Vec3;
  /** try the opposite scan orientation too */
  allowFlip: boolean;
  onProgress?: (f: number) => void;
  /** testing: inspect the coarse candidates */
  debug?: (cands: { T: Affine; score: number }[]) => void;
  /** testing: inspect each refined candidate (start, result, fit) */
  debugRefine?: (start: Affine, result: Affine, st: FitStats) => void;
}

/**
 * Automatic surface matching: many rotations around the occlusal axis (plus small tilts) and
 * heights, each pulled in with a few distance-map ICP steps; the best candidates are refined with
 * point-to-plane ICP. `sel` = selected scan points (scan coordinates), `selN` their normals.
 */
export async function globalMatch(sel: Float32Array, selN: Float32Array, target: Target, o: GlobalOpts): Promise<{ T: Affine; stats: FitStats }> {
  const coarse = subsample(sel, 160, 7);
  const medium = subsample(sel, 600, 3);
  const c = o.scanCenter;
  // target extent along its occlusal direction and in-plane centre
  const dT = o.targetOcclusal;
  let hMin = Infinity, hMax = -Infinity;
  const tc = [0, 0, 0];
  const TP = target.pts;
  for (let i = 0; i < TP.length; i += 3) {
    const h = TP[i] * dT[0] + TP[i + 1] * dT[1] + TP[i + 2] * dT[2];
    hMin = Math.min(hMin, h);
    hMax = Math.max(hMax, h);
    for (let k = 0; k < 3; k++) tc[k] += TP[i + k];
  }
  for (let k = 0; k < 3; k++) tc[k] /= TP.length / 3;
  const tcH = tc[0] * dT[0] + tc[1] * dT[1] + tc[2] * dT[2];
  // perpendicular basis for tilts
  const e1 = Math.abs(dT[0]) < 0.9 ? [0, -dT[2], dT[1]] : [-dT[2], 0, dT[0]];
  const l1 = Math.hypot(...e1);
  const u: Vec3 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
  const v: Vec3 = [dT[1] * u[2] - dT[2] * u[1], dT[2] * u[0] - dT[0] * u[2], dT[0] * u[1] - dT[1] * u[0]];

  type Cand = { T: Affine; score: number };
  const cands: Cand[] = [];
  const hints = o.hints && o.hints.scan.length ? o.hints : null;
  // three or more pairs: a direct start, refined on the surface
  if (hints && hints.scan.length >= 3) {
    let T = fitRigid(hints.scan, hints.world);
    const fine = subsample(sel, 3000, 11);
    const fineN = subsampleSame(sel, selN, 3000, 11);
    T = icp(fine, fineN, T, target, { gate0: 3, iterations: 30, gate1: 0.6 });
    o.onProgress?.(1);
    return { T, stats: fitStats(fine, T, target) };
  }
  const mean3 = (P: Vec3[]): Vec3 => [0, 1, 2].map((k) => P.reduce((acc, p) => acc + p[k], 0) / P.length) as Vec3;
  // candidate rotations
  const rotations: number[][] = [];
  if (hints && hints.scan.length === 2) {
    // the line between the two pairs fixes all but the twist around it
    const sd = sub3(hints.scan[1], hints.scan[0]);
    const wd = sub3(hints.world[1], hints.world[0]);
    const Ra = rotateOnto(unit3(sd), unit3(wd));
    for (let y = 0; y < 72; y++) rotations.push(mul3(axisAngle(unit3(wd), (y / 72) * Math.PI * 2), Ra));
  } else {
    const flips = o.allowFlip ? [1, -1] : [1];
    const yawSteps = 36; // 10° (the ICP below captures ±20°)
    const tw = o.occlusalConfident === false ? 0.28 : 0.12;
    const tilts: [number, number][] =
      o.occlusalConfident === false
        ? [-tw, 0, tw].flatMap((a2) => [-tw, 0, tw].map((b2) => [a2, b2] as [number, number]))
        : [
            [0, 0],
            [tw, 0],
            [-tw, 0],
            [0, tw],
            [0, -tw],
          ];
    for (const flip of flips) {
      const ds0: Vec3 = [o.scanOcclusal[0] * flip, o.scanOcclusal[1] * flip, o.scanOcclusal[2] * flip];
      const R0 = rotateOnto(ds0, dT);
      for (let y = 0; y < yawSteps; y++) {
        const Ry = mul3(axisAngle(dT, (y / yawSteps) * Math.PI * 2), R0);
        for (const [ta, tb] of tilts) rotations.push(mul3(mul3(axisAngle(u, ta), axisAngle(v, tb)), Ry));
      }
    }
  }
  const heights: number[] = [];
  for (let h = hMin + 3; h <= hMax - 1; h += 3) heights.push(h);
  if (!heights.length) heights.push((hMin + hMax) / 2);
  const shifts: number[] = [-12, -6, 0, 6, 12];
  const quick = subsample(sel, 80, 13);
  const nq = quick.length / 3;
  const df = target.df;
  let done = 0;
  let lastYield = performance.now();
  const rq = new Float64Array(quick.length);
  const hs = hints ? mean3(hints.scan) : null;
  const hw = hints ? mean3(hints.world) : null;
  for (const R of rotations) {
    if (hs && hw) {
      // hints pin the position: hinted scan points onto the hinted CBCT points
      const rs = [R[0] * hs[0] + R[1] * hs[1] + R[2] * hs[2], R[3] * hs[0] + R[4] * hs[1] + R[5] * hs[2], R[6] * hs[0] + R[7] * hs[1] + R[8] * hs[2]];
      const T = icp(coarse, null, fromRot(R, [hw[0] - rs[0], hw[1] - rs[1], hw[2] - rs[2]]), target, { coarseIterations: 12, iterations: 0, gate0: 4 });
      cands.push({ T, score: 0 });
    } else {
      // rotated scan centre and rotated quick points (relative to it)
      const rc = [R[0] * c[0] + R[1] * c[1] + R[2] * c[2], R[3] * c[0] + R[4] * c[1] + R[5] * c[2], R[6] * c[0] + R[7] * c[1] + R[8] * c[2]];
      for (let i = 0; i < nq; i++) {
        const x = quick[i * 3], yy = quick[i * 3 + 1], z = quick[i * 3 + 2];
        rq[i * 3] = R[0] * x + R[1] * yy + R[2] * z - rc[0];
        rq[i * 3 + 1] = R[3] * x + R[4] * yy + R[5] * z - rc[1];
        rq[i * 3 + 2] = R[6] * x + R[7] * yy + R[8] * z - rc[2];
      }
      // 1) cheap: clipped mean distance of the quick points for every placement
      const placed: { g: number[]; s: number }[] = [];
      for (const h of heights)
        for (const ou of shifts)
          for (const ov of shifts) {
            const g = [0, 1, 2].map((k) => tc[k] + dT[k] * (h - tcH) + u[k] * ou + v[k] * ov);
            let s2 = 0;
            for (let i = 0; i < nq; i++) {
              const d = df.sample(rq[i * 3] + g[0], rq[i * 3 + 1] + g[1], rq[i * 3 + 2] + g[2]);
              s2 += d < 4 ? d : 4;
            }
            placed.push({ g, s: s2 / nq });
          }
      placed.sort((a2, b2) => a2.s - b2.s);
      // 2) pull the best few placements in: short point-to-point ICP on the k-d tree
      for (const pl of placed.slice(0, 3)) {
        const T = icp(coarse, null, fromRot(R, [pl.g[0] - rc[0], pl.g[1] - rc[1], pl.g[2] - rc[2]]), target, { coarseIterations: 12, iterations: 0, gate0: 4 });
        cands.push({ T, score: 0 });
      }
    }
    done++;
    if (performance.now() - lastYield > 50) {
      o.onProgress?.(0.7 * (done / rotations.length));
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  // re-rank with exact distances (the 1 mm distance map is too coarse to tell a one-tooth
  // shift from the right fit)
  const rank = subsample(sel, 300, 19);
  const tmp = new Float64Array(3);
  const ds = new Float64Array(rank.length / 3);
  for (const cd of cands) {
    for (let i = 0; i < rank.length; i += 3) {
      apply(cd.T, rank[i], rank[i + 1], rank[i + 2], tmp);
      target.tree.nearest(tmp[0], tmp[1], tmp[2], 25);
      ds[i / 3] = Math.min(5, Math.sqrt(target.tree.lastD2));
    }
    ds.sort();
    let sum = 0;
    const k = Math.floor(ds.length * 0.7);
    for (let i = 0; i < k; i++) sum += ds[i];
    cd.score = sum / k;
  }
  cands.sort((a, b) => a.score - b.score);
  o.debug?.(cands);
  // refine the best *distinct* candidates (neighbouring starts often end in the same place)
  const probe = subsample(sel, 12, 17);
  const where = (T: Affine) => {
    const out = new Float64Array(probe.length);
    for (let i = 0; i < probe.length; i += 3) apply(T, probe[i], probe[i + 1], probe[i + 2], out, i);
    return out;
  };
  const top: Cand[] = [];
  const tops: Float64Array[] = [];
  for (const cd of cands) {
    const w = where(cd.T);
    const dup = tops.some((o2) => {
      let d = 0;
      for (let i = 0; i < w.length; i += 3) d += Math.hypot(w[i] - o2[i], w[i + 1] - o2[i + 1], w[i + 2] - o2[i + 2]);
      return d / (w.length / 3) < 3;
    });
    if (dup) continue;
    top.push(cd);
    tops.push(w);
    if (top.length >= 32) break;
  }
  let bestT = top[0].T;
  let bestStats: FitStats | null = null;
  for (let i = 0; i < top.length; i++) {
    const T = icp(medium, null, top[i].T, target, { gate0: 4, gate1: 1, iterations: 10 });
    const st = fitStats(medium, T, target, 2);
    o.debugRefine?.(top[i].T, T, st);
    if (!bestStats || better(st, bestStats)) {
      bestStats = st;
      bestT = T;
    }
    o.onProgress?.(0.7 + (0.25 * (i + 1)) / top.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  // final polish with more points and normals
  const fine = subsample(sel, 3000, 11);
  const fineN = subsampleSame(sel, selN, 3000, 11);
  bestT = icp(fine, fineN, bestT, target, { coarseIterations: 20, gate0: 2, iterations: 30, gate1: 0.6 });
  o.onProgress?.(1);
  return { T: bestT, stats: fitStats(fine, bestT, target) };
}


const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function better(a: FitStats, b: FitStats) {
  // more points on the surface first, then the tighter fit
  if (Math.abs(a.within05 - b.within05) > 0.05) return a.within05 > b.within05;
  return a.rms < b.rms;
}

/** Same stratified picks as `subsample` but from a parallel array (e.g. normals). */
export function subsampleSame(pts: Float32Array, other: Float32Array, k: number, seed = 1): Float32Array {
  const n = pts.length / 3;
  if (n <= k) return other.slice();
  const out = new Float32Array(k * 3);
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < k; i++) {
    const j = Math.min(n - 1, Math.floor(((i + rnd()) * n) / k));
    out[i * 3] = other[j * 3];
    out[i * 3 + 1] = other[j * 3 + 1];
    out[i * 3 + 2] = other[j * 3 + 2];
  }
  return out;
}

/**
 * Occlusal direction of a dental scan (scan coordinates), pointing out of the occlusal surfaces.
 * A full arch is a flat U, so the axis of least vertex spread is the occlusal axis; it is used when
 * the arch is clearly flat and agrees with the mean surface normal (scans show the occlusal side).
 * Otherwise (partial arches, quadrants) the mean normal itself is used, with less confidence.
 */
export function scanOcclusalAxis(pos: Float32Array, nrm: Float32Array): { axis: Vec3; confident: boolean } {
  const n = pos.length / 3;
  const stride = Math.max(1, Math.floor(n / 50000));
  const c = [0, 0, 0];
  let m = 0;
  for (let v = 0; v < n; v += stride, m++) for (let k = 0; k < 3; k++) c[k] += pos[v * 3 + k];
  for (let k = 0; k < 3; k++) c[k] /= m;
  const C = new Array<number>(9).fill(0);
  for (let v = 0; v < n; v += stride) {
    const d = [pos[v * 3] - c[0], pos[v * 3 + 1] - c[1], pos[v * 3 + 2] - c[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b] += d[a] * d[b];
  }
  const { vecs, vals } = sym3Eigen(C); // ascending
  const e = vecs[0];
  const mn = [0, 0, 0];
  for (let v = 0; v < n; v += stride) for (let k = 0; k < 3; k++) mn[k] += nrm[v * 3 + k];
  const ml = Math.hypot(mn[0], mn[1], mn[2]) || 1;
  const meanN: Vec3 = [mn[0] / ml, mn[1] / ml, mn[2] / ml];
  const d = e[0] * meanN[0] + e[1] * meanN[1] + e[2] * meanN[2];
  const flat = vals[0] < 0.35 * vals[1];
  if (flat && Math.abs(d) > Math.cos((25 * Math.PI) / 180)) {
    const sg = d >= 0 ? 1 : -1;
    return { axis: [e[0] * sg, e[1] * sg, e[2] * sg], confident: true };
  }
  return { axis: meanN, confident: false };
}

/** Eigen-decomposition of a symmetric 3×3 matrix (Jacobi); eigenvalues ascending. */
function sym3Eigen(M: number[]): { vals: number[]; vecs: Vec3[] } {
  const a = M.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[1] ** 2 + a[2] ** 2 + a[5] ** 2;
    if (off < 1e-24) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-30) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cc = 1 / Math.sqrt(t * t + 1);
      const ss = t * cc;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = cc * akp - ss * akq;
        a[k * 3 + q] = ss * akp + cc * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = cc * apk - ss * aqk;
        a[q * 3 + k] = ss * apk + cc * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
        v[k * 3 + p] = cc * vkp - ss * vkq;
        v[k * 3 + q] = ss * vkp + cc * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((x, y) => a[x * 4] - a[y * 4]);
  return { vals: order.map((i) => a[i * 4]), vecs: order.map((i) => [v[i], v[3 + i], v[6 + i]] as Vec3) };
}
