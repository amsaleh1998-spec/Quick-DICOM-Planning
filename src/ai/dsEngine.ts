// Sliding-window inference around a network (nnU-Net style), independent of the runtime:
// builds the normalised input tiles from the CT, blends the tile outputs with the Gaussian
// importance map and writes the result straight into the app's label grid.
//
// Memory: the blended logits are kept only for the rows of tiles still in use (a ring of
// patch[0] + 1 model rows, int16 fixed point); finished rows are resampled to the label grid
// (trilinear logits, then argmax – like nnU-Net's export) and dropped.

import type { Vec3 } from '../math';
import { DS_MODEL, ModelGrid, axisWeightSum, gaussian1d, modelAxes, modelGrid, worldToModel } from './dsPlan';

export interface EngineInput {
  /** CT voxels (x fastest) and geometry; world = origin + index × spacing */
  data: Int16Array;
  dims: [number, number, number];
  spacing: Vec3;
  origin?: Vec3;
  /** region the network sees: world box of CT voxel centres */
  roiLo: Vec3;
  roiHi: Vec3;
  /** labels are written only inside this world box (default: the whole region) */
  outLo?: Vec3;
  outHi?: Vec3;
  patientAffine?: number[];
  /** tile step as a fraction of the patch (nnU-Net default 0.5) */
  step: number;
  /** output grid (the app's label grid): voxel (i, j, k) sits at world (i, j, k) × gs */
  label: { nx: number; ny: number; nz: number; gs: Vec3 };
}

export interface EngineResult {
  /** class per label voxel (0 = background) */
  cls: Uint8Array;
  /** logit margin between the best and the second class, × 16, clamped to 1..255 */
  margin: Uint8Array;
  /** voxels per class */
  counts: number[];
}

/**
 * Bounding box (world, voxel centres) of the non-zero voxels inside [lo, hi] – nnU-Net crops
 * every image to its non-zero region before predicting (matters for scans whose area outside the
 * reconstructed field of view is stored as 0).
 */
export function nonzeroBox(data: Int16Array, dims: [number, number, number], spacing: Vec3, lo: Vec3, hi: Vec3, origin: Vec3 = [0, 0, 0]): { lo: Vec3; hi: Vec3 } {
  const [nx, ny] = dims;
  const i0 = [0, 1, 2].map((a) => Math.max(0, Math.ceil((lo[a] - origin[a]) / spacing[a] - 1e-6)));
  const i1 = [0, 1, 2].map((a) => Math.min(dims[a] - 1, Math.floor((hi[a] - origin[a]) / spacing[a] + 1e-6)));
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let k = i0[2]; k <= i1[2]; k++) {
    for (let j = i0[1]; j <= i1[1]; j++) {
      const row = (k * ny + j) * nx;
      let first = -1, last = -1;
      for (let i = i0[0]; i <= i1[0]; i++) {
        if (data[row + i] !== 0) {
          if (first < 0) first = i;
          last = i;
        }
      }
      if (first < 0) continue;
      if (first < mn[0]) mn[0] = first;
      if (last > mx[0]) mx[0] = last;
      if (j < mn[1]) mn[1] = j;
      if (j > mx[1]) mx[1] = j;
      if (k < mn[2]) mn[2] = k;
      if (k > mx[2]) mx[2] = k;
    }
  }
  if (mx[0] < 0) return { lo, hi };
  return {
    lo: [origin[0] + mn[0] * spacing[0], origin[1] + mn[1] * spacing[1], origin[2] + mn[2] * spacing[2]],
    hi: [origin[0] + mx[0] * spacing[0], origin[1] + mx[1] * spacing[1], origin[2] + mx[2] * spacing[2]],
  };
}

const SCALE = 128; // fixed point of the blended logits
const BG_LOGIT = 10; // tiles skipped as empty count as confident background
const NC = DS_MODEL.classes;

export class DsEngine {
  readonly grid: ModelGrid;
  readonly tiles: [number, number, number][] = [];
  private readonly inp: EngineInput;
  private readonly P = DS_MODEL.patch;
  /** per axis: normalised Gaussian factor g / W for every tile start */
  private readonly rk: Map<number, Float32Array>[] = [new Map(), new Map(), new Map()];
  private readonly R: number;
  private readonly ring: Int16Array;
  private readonly plane: number;
  private zeroedTo = -1;
  private curRow = -1;
  /** label planes (index along world axis ax[0]) still to write */
  private pending: number[];
  readonly out: EngineResult;
  private readonly outStride: [number, number, number];

  constructor(inp: EngineInput) {
    this.inp = inp;
    const g = modelGrid(inp.roiLo, inp.roiHi, inp.spacing, modelAxes(inp.patientAffine), inp.step);
    this.grid = g;
    for (const s0 of g.steps[0]) for (const s1 of g.steps[1]) for (const s2 of g.steps[2]) this.tiles.push([s0, s1, s2]);
    for (let k = 0; k < 3; k++) {
      const P = this.P[k];
      const gk = gaussian1d(P);
      const W = axisWeightSum(g.size[k], P, g.steps[k], gk);
      for (const s of g.steps[k]) {
        const r = new Float32Array(P);
        for (let i = 0; i < P; i++) r[i] = s + i < g.size[k] ? gk[i] / W[s + i] : 0;
        this.rk[k].set(s, r);
      }
    }
    this.R = this.P[0] + 1;
    this.plane = NC * g.size[1] * g.size[2];
    this.ring = new Int16Array(this.R * this.plane);
    const L = inp.label;
    const n = L.nx * L.ny * L.nz;
    this.out = { cls: new Uint8Array(n), margin: new Uint8Array(n).fill(255), counts: new Array(NC).fill(0) };
    this.outStride = [1, L.nx, L.nx * L.ny];
    const ln = [L.nx, L.ny, L.nz][g.ax[0]];
    this.pending = Array.from({ length: ln }, (_, i) => i);
  }

  /** Bytes of working memory (ring buffer). */
  get ringBytes() {
    return this.ring.byteLength;
  }

  /**
   * Normalised input of tile t ([P0][P1][P2], last axis fastest). Returns false when the tile is
   * uniform (outside the field of view / air only) and can be skipped.
   */
  fillTile(t: [number, number, number], out: Float32Array): boolean {
    const { data, dims, spacing } = this.inp;
    const origin = this.inp.origin ?? [0, 0, 0];
    const g = this.grid;
    const stride = [1, dims[0], dims[0] * dims[1]];
    const offA: Int32Array[] = [];
    const offB: Int32Array[] = [];
    const fr: Float32Array[] = [];
    const valid: Uint8Array[] = [];
    let anyPad = false;
    for (let k = 0; k < 3; k++) {
      const P = this.P[k];
      const a = g.ax[k];
      const oa = new Int32Array(P), ob = new Int32Array(P), f = new Float32Array(P), v = new Uint8Array(P);
      for (let m = 0; m < P; m++) {
        const u = t[k] + m - g.pad[k];
        if (u < 0 || u >= g.n[k]) {
          anyPad = true;
          continue;
        }
        v[m] = 1;
        const w = g.c0[k] + g.sg[k] * u * g.sp[k];
        let x = (w - origin[a]) / spacing[a];
        if (x < 0) x = 0;
        if (x > dims[a] - 1) x = dims[a] - 1;
        const i0 = Math.floor(x);
        const i1 = Math.min(dims[a] - 1, i0 + 1);
        oa[m] = i0 * stride[a];
        ob[m] = i1 * stride[a];
        f[m] = x - i0;
      }
      offA.push(oa);
      offB.push(ob);
      fr.push(f);
      valid.push(v);
    }
    const { clipLo, clipHi, mean, std } = DS_MODEL;
    const inv = 1 / std;
    const [P0, P1, P2] = this.P;
    let mn = Infinity, mx = -Infinity;
    let o = 0;
    for (let m0 = 0; m0 < P0; m0++) {
      const v0 = valid[0][m0];
      const a0 = offA[0][m0], b0 = offB[0][m0], f0 = fr[0][m0];
      for (let m1 = 0; m1 < P1; m1++) {
        const v01 = v0 & valid[1][m1];
        const a1 = offA[1][m1], b1 = offB[1][m1], f1 = fr[1][m1];
        const aa = a0 + a1, ba = b0 + a1, ab = a0 + b1, bb = b0 + b1;
        const oa2 = offA[2], ob2 = offB[2], fr2 = fr[2], v2 = valid[2];
        for (let m2 = 0; m2 < P2; m2++, o++) {
          if (!(v01 & v2[m2])) {
            out[o] = 0;
            continue;
          }
          const c = oa2[m2], d = ob2[m2], f2 = fr2[m2];
          // trilinear: axis 2 first, then 1, then 0
          const x00 = data[aa + c] + (data[aa + d] - data[aa + c]) * f2;
          const x10 = data[ba + c] + (data[ba + d] - data[ba + c]) * f2;
          const x01 = data[ab + c] + (data[ab + d] - data[ab + c]) * f2;
          const x11 = data[bb + c] + (data[bb + d] - data[bb + c]) * f2;
          const y0 = x00 + (x01 - x00) * f1;
          const y1 = x10 + (x11 - x10) * f1;
          let val = y0 + (y1 - y0) * f0;
          if (val < clipLo) val = clipLo;
          else if (val > clipHi) val = clipHi;
          if (val < mn) mn = val;
          if (val > mx) mx = val;
          out[o] = (val - mean) * inv;
        }
      }
    }
    // nothing above air, or a constant region without padding (outside the scanned cylinder)
    if (mx < clipLo + 20) return false;
    if (!anyPad && mx - mn < 5) return false;
    return true;
  }

  /** Start a tile row (all tiles with the same start along model axis 0). */
  private beginRow(s0: number) {
    if (s0 === this.curRow) return;
    if (this.curRow >= 0) this.finishRows(s0 - 1);
    this.curRow = s0;
    const last = s0 + this.P[0] - 1;
    for (let r = this.zeroedTo + 1; r <= last; r++) {
      const base = (r % this.R) * this.plane;
      this.ring.fill(0, base, base + this.plane);
    }
    this.zeroedTo = Math.max(this.zeroedTo, last);
  }

  /** Blend the network output of tile t (logits [6][P0][P1][P2]); null = skipped tile. */
  addTile(t: [number, number, number], logits: Float32Array | null) {
    this.beginRow(t[0]);
    const g = this.grid;
    const [P0, P1, P2] = this.P;
    const r0 = this.rk[0].get(t[0])!, r1 = this.rk[1].get(t[1])!, r2 = this.rk[2].get(t[2])!;
    const S1 = g.size[1], S2 = g.size[2];
    const ring = this.ring;
    const n2 = Math.min(P2, S2 - t[2]);
    const n1 = Math.min(P1, S1 - t[1]);
    const n0 = Math.min(P0, g.size[0] - t[0]);
    const vox = P0 * P1 * P2;
    const chStride = S1 * S2;
    const w = new Float32Array(n2);
    for (let m0 = 0; m0 < n0; m0++) {
      const slot = ((t[0] + m0) % this.R) * this.plane;
      const f0 = r0[m0] * SCALE;
      for (let m1 = 0; m1 < n1; m1++) {
        const f01 = f0 * r1[m1];
        for (let m2 = 0; m2 < n2; m2++) w[m2] = f01 * r2[m2];
        const a0 = slot + (t[1] + m1) * S2 + t[2];
        if (!logits) {
          for (let m2 = 0; m2 < n2; m2++) ring[a0 + m2] += ((BG_LOGIT * w[m2] + 32768.5) | 0) - 32768;
          continue;
        }
        const l0 = m0 * P1 * P2 + m1 * P2;
        // the blend is a convex combination of tile logits: |sum| ≤ SCALE · max|logit|, so only
        // the (rare) huge logits need clamping to stay inside int16
        for (let c = 0; c < NC; c++) {
          const ai = a0 + c * chStride;
          const li = l0 + c * vox;
          for (let m2 = 0; m2 < n2; m2++) {
            let x = logits[li + m2];
            x = x > 250 ? 250 : x < -250 ? -250 : x;
            // round to nearest (Math.round is several times slower here)
            ring[ai + m2] += ((x * w[m2] + 32768.5) | 0) - 32768;
          }
        }
      }
    }
  }

  /** All tiles done: write the remaining planes. */
  finish(): EngineResult {
    this.finishRows(this.grid.size[0] - 1);
    return this.out;
  }

  /** Rows up to `upTo` are final: write every label plane whose two model rows are final. */
  private finishRows(upTo: number) {
    const g = this.grid;
    const L = this.inp.label;
    const a0 = g.ax[0];
    const last = g.size[0] - 1;
    const keep: number[] = [];
    for (const p of this.pending) {
      const u = worldToModel(g, 0, p * L.gs[a0]);
      const uc = u < 0 ? 0 : u > last ? last : u;
      const r = Math.floor(uc);
      const r1 = Math.min(last, r + 1);
      if (r1 <= upTo || upTo >= last) this.writePlane(p, u, r, r1, uc - r);
      else keep.push(p);
    }
    this.pending = keep;
  }

  /** Inside the output box along world axis a (half a label voxel of slack). */
  private inOut(a: number, w: number): boolean {
    const { outLo, outHi, label } = this.inp;
    if (!outLo || !outHi) return true;
    const e = label.gs[a] / 2 + 1e-6;
    return w >= outLo[a] - e && w <= outHi[a] + e;
  }

  private writePlane(p: number, u0: number, ra: number, rb: number, t0: number) {
    const g = this.grid;
    const L = this.inp.label;
    const S1 = g.size[1], S2 = g.size[2];
    const cells = S1 * S2;
    const out = this.out;
    const st = this.outStride;
    const ldims = [L.nx, L.ny, L.nz];
    const A1 = g.ax[1], A2 = g.ax[2];
    const n1 = ldims[A1], n2 = ldims[A2];
    const base0 = p * st[g.ax[0]];
    // outside the segmented region along axis 0: background
    const in0 = u0 >= g.pad[0] - 0.5 && u0 <= g.pad[0] + g.n[0] - 0.5 && this.inOut(g.ax[0], p * L.gs[g.ax[0]]);
    if (!in0) {
      out.counts[0] += n1 * n2; // stays background (cls 0, margin 255)
      return;
    }
    // 1. interpolate the two rows along axis 0 (normalised logits)
    const ring = this.ring;
    const sa = (ra % this.R) * this.plane, sb = (rb % this.R) * this.plane;
    const pl = new Float32Array(NC * cells);
    const k = 1 / SCALE;
    for (let i = 0; i < NC * cells; i++) pl[i] = (ring[sa + i] + (ring[sb + i] - ring[sa + i]) * t0) * k;
    // 2. per cell argmax and margin
    const lab = new Uint8Array(cells);
    const mar = new Float32Array(cells);
    for (let c = 0; c < cells; c++) {
      let b = 0, bv = pl[c], sv = -Infinity;
      for (let q = 1; q < NC; q++) {
        const v = pl[q * cells + c];
        if (v > bv) {
          sv = bv;
          bv = v;
          b = q;
        } else if (v > sv) sv = v;
      }
      lab[c] = b;
      mar[c] = bv - sv;
    }
    // 3. per label-grid axis: model cell and fraction, inside flag
    const axisMap = (k: number, A: number, n: number) => {
      const i0 = new Int32Array(n), i1 = new Int32Array(n), f = new Float32Array(n), ok = new Uint8Array(n);
      const last = g.size[k] - 1;
      for (let i = 0; i < n; i++) {
        const u = worldToModel(g, k, i * L.gs[A]);
        ok[i] = u >= g.pad[k] - 0.5 && u <= g.pad[k] + g.n[k] - 0.5 && this.inOut(A, i * L.gs[A]) ? 1 : 0;
        const uc = u < 0 ? 0 : u > last ? last : u;
        i0[i] = Math.floor(uc);
        i1[i] = Math.min(last, i0[i] + 1);
        f[i] = uc - i0[i];
      }
      return { i0, i1, f, ok };
    };
    const m1 = axisMap(1, A1, n1);
    const m2 = axisMap(2, A2, n2);
    const tmp = new Float32Array(NC);
    for (let j = 0; j < n1; j++) {
      const rowA = m1.i0[j] * S2, rowB = m1.i1[j] * S2, fj = m1.f[j];
      const okj = m1.ok[j];
      const ob = base0 + j * st[A1];
      for (let i = 0; i < n2; i++) {
        const oi = ob + i * st[A2];
        if (!(okj & m2.ok[i])) {
          out.cls[oi] = 0;
          out.margin[oi] = 255;
          out.counts[0]++;
          continue;
        }
        const ca = m2.i0[i], cb = m2.i1[i], fi = m2.f[i];
        const c00 = rowA + ca, c01 = rowA + cb, c10 = rowB + ca, c11 = rowB + cb;
        const l = lab[c00];
        let cls: number, margin: number;
        const w00 = (1 - fj) * (1 - fi), w01 = (1 - fj) * fi, w10 = fj * (1 - fi), w11 = fj * fi;
        if (lab[c01] === l && lab[c10] === l && lab[c11] === l) {
          cls = l;
          margin = mar[c00] * w00 + mar[c01] * w01 + mar[c10] * w10 + mar[c11] * w11;
        } else {
          let b = 0, bv = -Infinity, sv = -Infinity;
          for (let q = 0; q < NC; q++) {
            const o = q * cells;
            const v = pl[o + c00] * w00 + pl[o + c01] * w01 + pl[o + c10] * w10 + pl[o + c11] * w11;
            tmp[q] = v;
            if (v > bv) {
              sv = bv;
              bv = v;
              b = q;
            } else if (v > sv) sv = v;
          }
          cls = b;
          margin = bv - sv;
        }
        out.cls[oi] = cls;
        const m = Math.round(margin * 16);
        out.margin[oi] = m < 1 ? 1 : m > 255 ? 255 : m;
        out.counts[cls]++;
      }
    }
  }
}
