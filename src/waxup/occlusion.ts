// Occlusion with the opposing jaw, and abrasion.
//
// Antagonist cutting: the antagonist (scan of the opposing jaw and / or the opposing jaw's waxup
// teeth) is seen along the jaw's vertical as a height field over the occlusal plane – its highest
// points for a lower antagonist, its lowest for an upper one. Tooth vertices that reach into it are
// pushed back along the vertical onto its surface (or `gap` mm short of it): the tooth is cut where
// it meets the antagonist.
//
// Abrasion: the occlusal relief of a tooth (its top `depth` mm) is scaled along the occlusal axis –
// below 1 the cusps / incisal edges wear flat, above 1 they become more pointed.

import { Vec3, add, dot, normalize, scale, sub } from '../math';
import { Affine, applyV, invert, rotV } from '../register';
import type { Jaw } from './library';
import type { JawPlacement } from './waxup';
import { adjacency } from './sculpt';

/** A jaw's frame in the world (follows whole-jaw moves): ax patient left, ay posterior, az superior. */
export interface JawFrame {
  O: Vec3;
  ax: Vec3;
  ay: Vec3;
  az: Vec3;
  /** height (along az) of the jaw's occlusal plane */
  level: number;
}

export function jawFrame(pl: JawPlacement): JawFrame {
  const O = applyV(pl.adjust, pl.O);
  const [ax, ay, az] = pl.F.map((f) => normalize(rotV(pl.adjust, f)));
  const onPlane = applyV(pl.adjust, add(pl.O, scale(pl.F[2], pl.level)));
  return { O, ax, ay, az, level: dot(sub(onPlane, O), az) };
}

/** Surface to cut against, as a grid over the occlusal plane. */
export class HeightField {
  readonly cell = 0.15;
  private h: Float32Array;
  readonly nx: number;
  readonly ny: number;

  /**
   * `top`: keep the highest points (the antagonist lies below: it cuts an upper tooth). The grid
   * covers [a0, a1] × [b0, b1] (jaw frame); triangles are taken where they reach [cLo, cHi].
   */
  constructor(
    readonly f: JawFrame,
    readonly top: boolean,
    private a0: number,
    private b0: number,
    a1: number,
    b1: number,
    private cLo: number,
    private cHi: number,
  ) {
    this.nx = Math.max(1, Math.ceil((a1 - a0) / this.cell));
    this.ny = Math.max(1, Math.ceil((b1 - b0) / this.cell));
    this.h = new Float32Array(this.nx * this.ny).fill(NaN);
  }

  /** Rasterise a triangle mesh (world vertices). */
  add(pos: Float32Array, idx: Uint32Array) {
    const { f, cell, nx, ny, h, top } = this;
    const n = pos.length / 3;
    const A = new Float32Array(n), B = new Float32Array(n), C = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3] - f.O[0], y = pos[i * 3 + 1] - f.O[1], z = pos[i * 3 + 2] - f.O[2];
      A[i] = x * f.ax[0] + y * f.ax[1] + z * f.ax[2];
      B[i] = x * f.ay[0] + y * f.ay[1] + z * f.ay[2];
      C[i] = x * f.az[0] + y * f.az[1] + z * f.az[2];
    }
    const aMax = this.a0 + nx * cell, bMax = this.b0 + ny * cell;
    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
      const ca = C[i0], cb = C[i1], cc = C[i2];
      if (Math.max(ca, cb, cc) < this.cLo || Math.min(ca, cb, cc) > this.cHi) continue;
      const xa = A[i0], xb = A[i1], xc = A[i2], ya = B[i0], yb = B[i1], yc = B[i2];
      const lo = Math.min(xa, xb, xc), hi = Math.max(xa, xb, xc), lo2 = Math.min(ya, yb, yc), hi2 = Math.max(ya, yb, yc);
      if (hi < this.a0 || lo > aMax || hi2 < this.b0 || lo2 > bMax) continue;
      const area = (xb - xa) * (yc - ya) - (xc - xa) * (yb - ya);
      if (Math.abs(area) < 1e-9) continue;
      const iS = Math.max(0, Math.ceil((lo - this.a0) / cell - 0.5)), iE = Math.min(nx - 1, Math.floor((hi - this.a0) / cell - 0.5));
      const jS = Math.max(0, Math.ceil((lo2 - this.b0) / cell - 0.5)), jE = Math.min(ny - 1, Math.floor((hi2 - this.b0) / cell - 0.5));
      for (let j = jS; j <= jE; j++) {
        const py = this.b0 + (j + 0.5) * cell;
        for (let i = iS; i <= iE; i++) {
          const px = this.a0 + (i + 0.5) * cell;
          const w0 = ((xb - px) * (yc - py) - (xc - px) * (yb - py)) / area;
          const w1 = ((xc - px) * (ya - py) - (xa - px) * (yc - py)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const z = w0 * ca + w1 * cb + w2 * cc;
          const k = j * nx + i;
          const cur = h[k];
          if (cur !== cur || (top ? z > cur : z < cur)) h[k] = z;
        }
      }
    }
  }

  /** Height of the surface at (a, b) of the jaw frame; NaN where there is none. */
  at(a: number, b: number): number {
    const x = (a - this.a0) / this.cell - 0.5, y = (b - this.b0) / this.cell - 0.5;
    const i = Math.floor(x), j = Math.floor(y);
    if (i < 0 || j < 0 || i + 1 >= this.nx || j + 1 >= this.ny) return NaN;
    const h = this.h, nx = this.nx;
    const v00 = h[j * nx + i], v10 = h[j * nx + i + 1], v01 = h[(j + 1) * nx + i], v11 = h[(j + 1) * nx + i + 1];
    const fx = x - i, fy = y - j;
    if (v00 === v00 && v10 === v10 && v01 === v01 && v11 === v11)
      return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    // at the edge of the antagonist: the nearest cell
    const near = h[(fy < 0.5 ? j : j + 1) * nx + (fx < 0.5 ? i : i + 1)];
    return near;
  }
}

/**
 * Cut a tooth (library vertices `base`, library -> world `T`) where it reaches into the antagonist:
 * vertices are pushed along the vertical onto its surface, `gap` mm short of it. Returns the new
 * vertices, or null when nothing reaches into it.
 */
export function cutTooth(hf: HeightField, T: Affine, base: Float32Array, gap: number): Float32Array | null {
  const f = hf.f;
  // library displacement of 1 mm along the world vertical
  const dl = rotV(invert(T), f.az);
  let out: Float32Array | null = null;
  for (let i = 0; i < base.length; i += 3) {
    const x = base[i], y = base[i + 1], z = base[i + 2];
    const wx = T[0] * x + T[1] * y + T[2] * z + T[3] - f.O[0];
    const wy = T[4] * x + T[5] * y + T[6] * z + T[7] - f.O[1];
    const wz = T[8] * x + T[9] * y + T[10] * z + T[11] - f.O[2];
    const c = wx * f.az[0] + wy * f.az[1] + wz * f.az[2];
    const H = hf.at(wx * f.ax[0] + wy * f.ax[1] + wz * f.ax[2], wx * f.ay[0] + wy * f.ay[1] + wz * f.ay[2]);
    if (H !== H) continue;
    const d = hf.top ? H + gap - c : H - gap - c;
    if (hf.top ? d <= 0 : d >= 0) continue;
    out ??= base.slice();
    out[i] += dl[0] * d;
    out[i + 1] += dl[1] * d;
    out[i + 2] += dl[2] * d;
  }
  return out;
}

/**
 * Adapt a tooth to the antagonist (shape modification): what reaches into it is pushed back (as
 * when cutting), and the occlusal surface where it comes closest – the cusps facing the antagonist
 * – is drawn onto it, so the tooth gets contact areas there. Only the occlusal relief (its top 3 mm)
 * changes, smoothly; a tooth more than `reach` mm away is only cut. Returns the new vertices, or
 * null when nothing changes.
 */
export function adaptTooth(hf: HeightField, T: Affine, base: Float32Array, idx: Uint32Array, jaw: Jaw, gap: number, reach = 1.5): Float32Array | null {
  const f = hf.f;
  const n = base.length / 3;
  const dl = rotV(invert(T), f.az);
  // clearance to the antagonist along the vertical (negative: reaching into it)
  const q = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
    const wx = T[0] * x + T[1] * y + T[2] * z + T[3] - f.O[0];
    const wy = T[4] * x + T[5] * y + T[6] * z + T[7] - f.O[1];
    const wz = T[8] * x + T[9] * y + T[10] * z + T[11] - f.O[2];
    const c = wx * f.az[0] + wy * f.az[1] + wz * f.az[2];
    const H = hf.at(wx * f.ax[0] + wy * f.ax[1] + wz * f.ax[2], wx * f.ay[0] + wy * f.ay[1] + wz * f.ay[2]);
    if (H === H) q[i] = hf.top ? c - (H + gap) : H - gap - c;
  }
  // occlusal relief: weight 1 in the top 1.5 mm of the tooth, fading out by 3 mm
  const s = jaw === 'upper' ? -1 : 1;
  let top = -Infinity;
  for (let i = 0; i < n; i++) top = Math.max(top, s * base[i * 3 + 2]);
  const occl = (i: number) => {
    const h = top - s * base[i * 3 + 2];
    if (h <= 1.5) return 1;
    if (h >= 3) return 0;
    const x = (3 - h) / 1.5;
    return x * x * (3 - 2 * x);
  };
  let m = Infinity;
  for (let i = 0; i < n; i++) if (q[i] === q[i] && occl(i) > 0.5) m = Math.min(m, q[i]);
  const near = Math.max(0, m);
  const dir = hf.top ? -1 : 1; // world vertical direction towards the antagonist
  let disp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const qi = q[i];
    if (qi !== qi) continue;
    if (qi < 0) disp[i] = dir * qi; // out of the antagonist
    else if (near <= reach) {
      // the parts that come closest (within 0.25 mm of the nearest) touch it, fading out over 0.5 mm
      const a = Math.min(1, Math.max(0, 1 - (qi - near - 0.25) / 0.5)) * occl(i);
      disp[i] = dir * qi * a;
    }
  }
  // smooth contact patches
  const adj = adjacency(n, idx);
  for (let it = 0; it < 3; it++) {
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const a = adj.start[i], b = adj.start[i + 1];
      for (let k = a; k < b; k++) sum += disp[adj.nb[k]];
      next[i] = b > a ? 0.5 * disp[i] + (0.5 * sum) / (b - a) : disp[i];
    }
    disp = next;
  }
  let moved = false;
  const out = base.slice();
  for (let i = 0; i < n; i++) {
    const d = disp[i];
    if (Math.abs(d) < 1e-5) continue;
    moved = true;
    out[i * 3] += dl[0] * d;
    out[i * 3 + 1] += dl[1] * d;
    out[i * 3 + 2] += dl[2] * d;
  }
  // smoothing may leave a little inside the antagonist: cut that
  const cut = cutTooth(hf, T, out, gap);
  return cut ?? (moved ? out : null);
}

// ---- abrasion ---------------------------------------------------------------------------------

export type ToothGroup = 'anterior' | 'posterior';
export const groupOf = (fdi: number): ToothGroup => (fdi % 10 <= 3 ? 'anterior' : 'posterior');

/** Depth of the occlusal relief (mm): incisal edges and canine tips / cusps. */
export const RELIEF: Record<ToothGroup, number> = { anterior: 1.8, posterior: 2.2 };

/** Relief scale of an abrasion value (-1 pointed … 0 library … 1 flat). */
export const reliefScale = (v: number) => (v >= 0 ? 1 - 0.75 * v : 1 - 0.6 * v);

/**
 * The occlusal relief of a tooth scaled by `k` along its occlusal axis (library coordinates: the
 * occlusal side is -z for upper teeth, +z for lower ones), about the level `depth` mm below its
 * occlusal-most point; the change fades in over 0.8 mm below that level.
 */
export function abrade(pos: Float32Array, jaw: Jaw, k: number, depth: number): Float32Array {
  const s = jaw === 'upper' ? -1 : 1;
  let top = -Infinity;
  for (let i = 2; i < pos.length; i += 3) top = Math.max(top, s * pos[i]);
  const base = top - depth;
  const band = 0.4;
  const out = pos.slice();
  if (Math.abs(k - 1) < 1e-9) return out;
  for (let i = 2; i < pos.length; i += 3) {
    const h = s * pos[i];
    if (h <= base - band) continue;
    const x = Math.min(1, (h - (base - band)) / (2 * band));
    const w = x * x * (3 - 2 * x);
    out[i] = s * (h + (h - base) * (k - 1) * w);
  }
  return out;
}
