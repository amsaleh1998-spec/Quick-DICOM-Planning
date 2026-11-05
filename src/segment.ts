import { ArchCurve } from './curve';
import { Frame, Vec2, Vec3, dot, sub } from './math';
import type { CropSpec } from './render';
import { Volume } from './volume';

/**
 * Threshold based segmentation (maxilla, mandible, teeth, existing implants …).
 *
 * Labels live in one byte per voxel on a grid that matches the 3D render
 * texture (the volume, downsampled when it is very large). Values 1..127 are
 * segment ids; the SHELL bit marks the one-voxel rim just outside a segment
 * (below its threshold) so that hiding a segment also hides the iso-surface
 * that wraps it.
 *
 * Segments are defined by their seeds (click position + threshold range),
 * replayed in the order they were made. Separation cuts are surfaces the
 * region growing cannot cross, so after drawing a cut every segment is simply
 * grown again.
 */
export const SHELL = 0x80;
export const MAX_SEGMENTS = 127;
/** voxel budget of the label grid (same as the 3D texture) */
let GRID_BUDGET = 48_000_000;

/** Voxel budget of the label grid (lower on phones). */
export function setLabelGridBudget(n: number) {
  GRID_BUDGET = n;
}
const GRID_MAX_DIM = 2048;

export type RGB = [number, number, number];

export interface Seed {
  /** clicked position (world mm) */
  p: Vec3;
  lo: number;
  hi: number;
  /** crop box active when the seed was placed (growing stays inside it) */
  crop: CropSpec | null;
  /** global creation order (replay order) */
  order: number;
}

export interface Segment {
  id: number;
  name: string;
  color: RGB;
  visible: boolean;
  seeds: Seed[];
  /** voxel count (excluding the shell), updated after every rebuild */
  voxels: number;
}

/** Cut drawn in a planar slice: the polyline extruded along the slice normal. */
export interface PlaneCut {
  id: number;
  kind: 'plane';
  /** points (world mm) drawn on the slice */
  pts: Vec3[];
  u: Vec3;
  v: Vec3;
  n: Vec3;
  /** half thickness (mm) around the slice it was drawn on; null = through the whole volume */
  depth: number | null;
  /** view it was drawn in (for the list) */
  viewName: string;
}

/** Cut drawn in the panoramic: a curved sheet c = h(s) following the arch. */
export interface PanoCut {
  id: number;
  kind: 'pano';
  /** planning frame and panoramic curve at the time it was drawn */
  O: Vec3;
  F: Frame;
  ctrl: Vec2[];
  /** (arc length, height) points, sorted by arc length */
  pts: Vec2[];
  /** panoramic slice offset when drawn; depth is measured from here */
  offset: number;
  depth: number | null;
}

export type Cut = PlaneCut | PanoCut;
/** A cut before it has been given an id. */
export type NewCut = Omit<PlaneCut, 'id'> | Omit<PanoCut, 'id'>;

export const SEGMENT_PRESETS: { name: string; color: RGB }[] = [
  { name: 'Maxilla', color: [236, 178, 112] },
  { name: 'Mandible', color: [104, 178, 240] },
  { name: 'Tooth', color: [248, 244, 222] },
  { name: 'Implant', color: [178, 186, 202] },
  { name: 'Segment', color: [140, 220, 150] },
];
const EXTRA_COLORS: RGB[] = [
  [240, 120, 160],
  [170, 140, 250],
  [120, 225, 215],
  [250, 210, 90],
  [230, 140, 90],
  [150, 200, 110],
];

/** side of a world point: +1 / -1, or 0 when the cut does not reach it */
type CutEval = (x: number, y: number, z: number) => number;

export function labelGridFactor(vol: Volume, maxDim = GRID_MAX_DIM): number {
  let f = 1;
  for (;;) {
    const d = [Math.ceil(vol.nx / f), Math.ceil(vol.ny / f), Math.ceil(vol.nz / f)];
    if (d[0] * d[1] * d[2] <= GRID_BUDGET && Math.max(...d) <= maxDim) return f;
    f++;
  }
}

export class Segmentation {
  private vol: Volume | null = null;
  /** grid downsampling factor and dimensions */
  f = 1;
  nx = 0;
  ny = 0;
  nz = 0;
  /** grid spacing (mm) */
  gs: Vec3 = [1, 1, 1];
  labels: Uint8Array | null = null;
  segments: Segment[] = [];
  cuts: Cut[] = [];
  /** bumped whenever the labels change (GPU upload, overlays) */
  version = 0;
  private nextOrder = 1;
  private nextCutId = 1;
  private colorIdx = 0;
  private evalCache = new Map<number, CutEval>();

  /** New volume: drop everything. */
  reset(vol: Volume | null) {
    this.vol = vol;
    this.labels = null;
    this.segments = [];
    this.cuts = [];
    this.evalCache.clear();
    this.nextOrder = 1;
    this.colorIdx = 0;
    this.version++;
    if (vol) {
      this.f = labelGridFactor(vol);
      this.nx = Math.ceil(vol.nx / this.f);
      this.ny = Math.ceil(vol.ny / this.f);
      this.nz = Math.ceil(vol.nz / this.f);
      this.gs = [vol.spacing[0] * this.f, vol.spacing[1] * this.f, vol.spacing[2] * this.f];
    }
  }

  get voxelVolume() {
    return this.gs[0] * this.gs[1] * this.gs[2];
  }

  private ensureLabels(): Uint8Array {
    if (!this.labels) this.labels = new Uint8Array(this.nx * this.ny * this.nz);
    return this.labels;
  }

  // ---- segments --------------------------------------------------------------

  segmentById(id: number | null) {
    return this.segments.find((s) => s.id === id) ?? null;
  }

  addSegment(name: string, color?: RGB): Segment | null {
    const used = new Set(this.segments.map((s) => s.id));
    let id = 1;
    while (used.has(id)) id++;
    if (id > MAX_SEGMENTS) return null;
    const same = this.segments.filter((s) => s.name === name || s.name.startsWith(name + ' ')).length;
    const seg: Segment = {
      id,
      name: same ? `${name} ${same + 1}` : name,
      color: color ?? EXTRA_COLORS[this.colorIdx++ % EXTRA_COLORS.length],
      visible: true,
      seeds: [],
      voxels: 0,
    };
    // a second "Maxilla" etc. gets its own colour
    if (color && same) seg.color = EXTRA_COLORS[this.colorIdx++ % EXTRA_COLORS.length];
    this.segments.push(seg);
    return seg;
  }

  /** Restore segments and cuts (project load / volume resampling). */
  restore(segments: Segment[], cuts: Cut[]) {
    this.segments = segments.map((s) => ({ ...s, seeds: s.seeds.map((d) => ({ ...d })), voxels: 0 }));
    this.cuts = cuts.map((c) => ({ ...c }));
    this.evalCache.clear();
    this.nextOrder = Math.max(1, ...this.segments.flatMap((s) => s.seeds.map((d) => d.order + 1)));
    this.nextCutId = Math.max(1, ...this.cuts.map((c) => c.id + 1));
    this.colorIdx = this.segments.length;
  }

  removeSegment(id: number) {
    this.segments = this.segments.filter((s) => s.id !== id);
  }

  /**
   * Grow segment `seg` from the voxel nearest to world point p (within [lo, hi]).
   * Voxels already owned by another segment are only taken when the click is on
   * that segment (e.g. carving a tooth out of the mandible with a higher threshold).
   */
  grow(seg: Segment, p: Vec3, lo: number, hi: number, crop: CropSpec | null): { added: number; message?: string } {
    if (!this.vol) return { added: 0, message: 'No volume loaded' };
    const labels = this.ensureLabels();
    const idx = this.snapSeed(p, lo, hi, crop);
    if (idx < 0) return { added: 0, message: 'Nothing within the threshold range here – click on the bone surface or lower the threshold.' };
    const l = labels[idx];
    if ((l & SHELL ? 0 : l) === seg.id) return { added: 0, message: `Already part of ${seg.name}.` };
    const added = this.fill(idx, seg.id, lo, hi, crop);
    if (!added) return { added: 0, message: 'Nothing was added.' };
    this.shell(seg.id, lo);
    seg.seeds.push({ p, lo, hi, crop, order: this.nextOrder++ });
    this.count();
    this.version++;
    return { added };
  }

  /** Clear the labels and grow every segment again from its seeds. */
  rebuild() {
    if (!this.vol) return;
    const anySeeds = this.segments.some((s) => s.seeds.length);
    if (!anySeeds && !this.labels) {
      this.version++;
      return;
    }
    const labels = this.ensureLabels();
    labels.fill(0);
    const seeds = this.segments
      .flatMap((s) => s.seeds.map((d) => ({ seg: s, d })))
      .sort((a, b) => a.d.order - b.d.order);
    for (const { seg, d } of seeds) {
      const idx = this.snapSeed(d.p, d.lo, d.hi, d.crop);
      if (idx < 0) continue;
      const l = labels[idx];
      if ((l & SHELL ? 0 : l) === seg.id) continue;
      if (this.fill(idx, seg.id, d.lo, d.hi, d.crop)) this.shell(seg.id, d.lo);
    }
    this.count();
    this.version++;
  }

  /** Segment id at a world point (0 = none). Shell voxels count as unlabelled. */
  labelAt(x: number, y: number, z: number): number {
    const L = this.labels;
    if (!L) return 0;
    const i = Math.round(x / this.gs[0]);
    const j = Math.round(y / this.gs[1]);
    const k = Math.round(z / this.gs[2]);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return 0;
    const l = L[i + j * this.nx + k * this.nx * this.ny];
    return l & SHELL ? 0 : l;
  }

  /** Raw label byte (including the shell bit) – used by the 3D picking. */
  rawLabelAt(x: number, y: number, z: number): number {
    const L = this.labels;
    if (!L) return 0;
    const i = Math.round(x / this.gs[0]);
    const j = Math.round(y / this.gs[1]);
    const k = Math.round(z / this.gs[2]);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return 0;
    return L[i + j * this.nx + k * this.nx * this.ny] & 127;
  }

  /**
   * Scalar field of one segment for surface export, sampled every `step` CT voxels (1 = the full
   * resolution of the scan, finer than the label grid when that is downsampled) inside the
   * segment's bounding box plus one padding layer. Where the nearest label voxel belongs to the
   * segment (or its shell) the sample carries the CT value minus the threshold, so the surface
   * follows the bone at full resolution; everything else is forced outside, so the surface closes
   * against neighbouring segments, cuts and the borders. `step` grows when the box would need
   * more than `maxSamples` samples.
   */
  segmentField(seg: Segment, step: number, maxSamples = 60_000_000): import('./stl').ScalarGrid | null {
    const L = this.labels;
    const vol = this.vol;
    if (!L || !vol || !seg.voxels) return null;
    const { nx, ny, nz, f } = this;
    const nxy = nx * ny;
    let i0 = nx, j0 = ny, k0 = nz, i1 = -1, j1 = -1, k1 = -1;
    for (let k = 0, idx = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++, idx++) {
          if ((L[idx] & 127) !== seg.id) continue;
          if (i < i0) i0 = i;
          if (i > i1) i1 = i;
          if (j < j0) j0 = j;
          if (j > j1) j1 = j;
          if (k < k0) k0 = k;
          if (k > k1) k1 = k;
        }
    if (i1 < 0) return null;
    // bounding box in CT voxels (a label voxel covers f CT voxels around i·f)
    const lo: [number, number, number] = [Math.max(0, i0 * f - f), Math.max(0, j0 * f - f), Math.max(0, k0 * f - f)];
    const hi: [number, number, number] = [Math.min(vol.nx - 1, i1 * f + f), Math.min(vol.ny - 1, j1 * f + f), Math.min(vol.nz - 1, k1 * f + f)];
    let st = Math.max(1, Math.round(step));
    const dims = () => [0, 1, 2].map((a) => Math.floor((hi[a] - lo[a]) / st) + 3);
    while (dims().reduce((x, y) => x * y, 1) > maxSamples) st++;
    const [sx, sy, sz] = dims();
    const iso = this.segmentLo(seg) - 0.5;
    const out = new Float32Array(sx * sy * sz).fill(-Infinity);
    const data = vol.data;
    const vnx = vol.nx;
    const vnxy = vol.nx * vol.ny;
    for (let c = 1; c < sz - 1; c++) {
      const vk = lo[2] + (c - 1) * st;
      if (vk > hi[2]) continue;
      const lk = Math.min(nz - 1, Math.round(vk / f));
      for (let b = 1; b < sy - 1; b++) {
        const vj = lo[1] + (b - 1) * st;
        if (vj > hi[1]) continue;
        const lj = Math.min(ny - 1, Math.round(vj / f));
        const rowOut = b * sx + c * sx * sy;
        const rowL = lj * nx + lk * nxy;
        const rowV = vj * vnx + vk * vnxy;
        for (let a = 1; a < sx - 1; a++) {
          const vi = lo[0] + (a - 1) * st;
          if (vi > hi[0]) continue;
          const li = Math.min(nx - 1, Math.round(vi / f));
          if ((L[li + rowL] & 127) !== seg.id) continue;
          out[a + rowOut] = data[vi + rowV] - iso;
        }
      }
    }
    const sp = vol.spacing;
    return {
      nx: sx,
      ny: sy,
      nz: sz,
      s: out,
      origin: [(lo[0] - st) * sp[0], (lo[1] - st) * sp[1], (lo[2] - st) * sp[2]],
      step: [st * sp[0], st * sp[1], st * sp[2]],
    };
  }

  /** Threshold of a segment (its first seed) for rendering its surface. */
  segmentLo(seg: Segment): number {
    return seg.seeds.length ? Math.min(...seg.seeds.map((s) => s.lo)) : 0;
  }

  // ---- cuts ------------------------------------------------------------------

  addCut(cut: NewCut): Cut {
    const c = { ...cut, id: this.nextCutId++ } as Cut;
    this.cuts.push(c);
    return c;
  }

  removeCut(id: number) {
    this.cuts = this.cuts.filter((c) => c.id !== id);
    this.evalCache.delete(id);
  }

  /** Side of a world point relative to the cut (+1/-1, 0 = outside its depth). */
  cutSide(cut: Cut, x: number, y: number, z: number): number {
    return this.evaluator(cut)(x, y, z);
  }

  private evaluator(cut: Cut): CutEval {
    let e = this.evalCache.get(cut.id);
    if (!e) {
      e = cut.kind === 'plane' ? this.planeEval(cut) : this.panoEval(cut);
      this.evalCache.set(cut.id, e);
    }
    return e;
  }

  /** Rasterised side map of the extruded polyline in its (u, v) plane. */
  private planeEval(cut: PlaneCut): CutEval {
    const o = cut.pts[0];
    const { u, v, n } = cut;
    const poly: Vec2[] = cut.pts.map((p) => {
      const q = sub(p, o);
      return [dot(q, u), dot(q, v)];
    });
    if (poly.length < 2) return () => 0;
    // bounds of the volume in (u, v)
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (const c of this.vol!.corners()) {
      const q = sub(c, o);
      const a = dot(q, u);
      const b = dot(q, v);
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      b0 = Math.min(b0, b);
      b1 = Math.max(b1, b);
    }
    const side = rasterizeSide(poly, a0, a1, b0, b1, Math.min(...this.gs));
    const depth = cut.depth;
    return (x, y, z) => {
      const qx = x - o[0];
      const qy = y - o[1];
      const qz = z - o[2];
      if (depth !== null && Math.abs(qx * n[0] + qy * n[1] + qz * n[2]) > depth) return 0;
      return side.at(qx * u[0] + qy * u[1] + qz * u[2], qx * v[0] + qy * v[1] + qz * v[2]);
    };
  }

  /** Curved sheet along the arch: above / below the drawn height profile. */
  private panoEval(cut: PanoCut): CutEval {
    const curve = new ArchCurve(cut.ctrl);
    const { O, F } = cut;
    const pts = cut.pts.slice().sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) return () => 0;
    const h = (s: number) => {
      if (s <= pts[0][0]) return pts[0][1];
      const last = pts[pts.length - 1];
      if (s >= last[0]) return last[1];
      let i = 1;
      while (pts[i][0] < s) i++;
      const p = pts[i - 1];
      const q = pts[i];
      const t = q[0] > p[0] ? (s - p[0]) / (q[0] - p[0]) : 0;
      return p[1] + (q[1] - p[1]) * t;
    };
    // raster of (arc length, buccal offset) over the axial plane of the frame
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (const c of this.vol!.corners()) {
      const q = sub(c, O);
      const a = dot(q, F[0]);
      const b = dot(q, F[1]);
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      b0 = Math.min(b0, b);
      b1 = Math.max(b1, b);
    }
    const res = Math.max(Math.min(...this.gs), (a1 - a0) / 600, (b1 - b0) / 600, 0.2);
    const W = Math.max(1, Math.ceil((a1 - a0) / res) + 1);
    const H = Math.max(1, Math.ceil((b1 - b0) / res) + 1);
    const sMap = new Float32Array(W * H);
    const oMap = new Float32Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const a = a0 + i * res;
        const b = b0 + j * res;
        const nr = curve.nearest(a, b);
        const cp = curve.at(nr.s);
        sMap[j * W + i] = h(nr.s);
        oMap[j * W + i] = (a - cp.p[0]) * cp.n[0] + (b - cp.p[1]) * cp.n[1];
      }
    }
    const depth = cut.depth;
    const off0 = cut.offset;
    const f0 = F[0];
    const f1 = F[1];
    const f2 = F[2];
    return (x, y, z) => {
      const qx = x - O[0];
      const qy = y - O[1];
      const qz = z - O[2];
      const a = qx * f0[0] + qy * f0[1] + qz * f0[2];
      const b = qx * f1[0] + qy * f1[1] + qz * f1[2];
      const c = qx * f2[0] + qy * f2[1] + qz * f2[2];
      let i = Math.round((a - a0) / res);
      let j = Math.round((b - b0) / res);
      i = i < 0 ? 0 : i >= W ? W - 1 : i;
      j = j < 0 ? 0 : j >= H ? H - 1 : j;
      const k = j * W + i;
      if (depth !== null && Math.abs(oMap[k] - off0) > depth) return 0;
      return c >= sMap[k] ? 1 : -1;
    };
  }

  // ---- region growing ------------------------------------------------------------

  /** Grid voxel value (point sample, like the 3D texture). */
  private valueAt(i: number, j: number, k: number): number {
    const vol = this.vol!;
    const f = this.f;
    return vol.data[i * f + j * f * vol.nx + k * f * vol.nx * vol.ny];
  }

  /** Nearest grid voxel within [lo, hi] (searching up to 3 voxels around p), or -1. */
  private snapSeed(p: Vec3, lo: number, hi: number, crop: CropSpec | null): number {
    const ci = p[0] / this.gs[0];
    const cj = p[1] / this.gs[1];
    const ck = p[2] / this.gs[2];
    const i0 = Math.round(ci);
    const j0 = Math.round(cj);
    const k0 = Math.round(ck);
    const inCrop = cropTester(crop);
    let best = -1;
    let bd = Infinity;
    const R = 3;
    for (let dk = -R; dk <= R; dk++) {
      for (let dj = -R; dj <= R; dj++) {
        for (let di = -R; di <= R; di++) {
          const i = i0 + di;
          const j = j0 + dj;
          const k = k0 + dk;
          if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) continue;
          const d = (i - ci) ** 2 + (j - cj) ** 2 + (k - ck) ** 2;
          if (d >= bd) continue;
          const v = this.valueAt(i, j, k);
          if (v < lo || v > hi) continue;
          if (!inCrop(i * this.gs[0], j * this.gs[1], k * this.gs[2])) continue;
          bd = d;
          best = i + j * this.nx + k * this.nx * this.ny;
        }
      }
    }
    return best;
  }

  /** 6-connected flood fill; returns the number of voxels labelled. */
  private fill(seed: number, target: number, lo: number, hi: number, crop: CropSpec | null): number {
    const labels = this.labels!;
    const vol = this.vol!;
    const { nx, ny, nz, f } = this;
    const nxy = nx * ny;
    const data = vol.data;
    const vnx = vol.nx * f;
    const vnxy = vol.nx * vol.ny * f;
    const [gx, gy, gz] = this.gs;
    const l0 = labels[seed];
    const src = l0 & SHELL ? 0 : l0;
    if (src === target) return 0;
    const evals = this.cuts.map((c) => this.evaluator(c));
    const nc = evals.length;
    const sideA = new Int8Array(nc);
    const inCrop = cropTester(crop);
    const useCrop = crop !== null;

    let stack = new Int32Array(1 << 16);
    let sp = 0;
    let count = 1;
    labels[seed] = target;
    stack[sp++] = seed;

    const visit = (n: number, i: number, j: number, k: number) => {
      const l = labels[n];
      if ((l & SHELL ? 0 : l) !== src) return;
      const v = data[i * f + j * vnx + k * vnxy];
      if (v < lo || v > hi) return;
      const x = i * gx;
      const y = j * gy;
      const z = k * gz;
      if (useCrop && !inCrop(x, y, z)) return;
      for (let c = 0; c < nc; c++) {
        const sa = sideA[c];
        if (sa) {
          const sb = evals[c](x, y, z);
          if (sb && sb !== sa) return;
        }
      }
      labels[n] = target;
      count++;
      if (sp >= stack.length) {
        const s2 = new Int32Array(stack.length * 2);
        s2.set(stack);
        stack = s2;
      }
      stack[sp++] = n;
    };

    while (sp) {
      const idx = stack[--sp];
      const k = (idx / nxy) | 0;
      const r = idx - k * nxy;
      const j = (r / nx) | 0;
      const i = r - j * nx;
      if (nc) {
        const x = i * gx;
        const y = j * gy;
        const z = k * gz;
        for (let c = 0; c < nc; c++) sideA[c] = evals[c](x, y, z);
      }
      if (i > 0) visit(idx - 1, i - 1, j, k);
      if (i < nx - 1) visit(idx + 1, i + 1, j, k);
      if (j > 0) visit(idx - nx, i, j - 1, k);
      if (j < ny - 1) visit(idx + nx, i, j + 1, k);
      if (k > 0) visit(idx - nxy, i, j, k - 1);
      if (k < nz - 1) visit(idx + nxy, i, j, k + 1);
    }
    return count;
  }

  /**
   * Mark unlabelled voxels below the threshold around the segment (all 26
   * neighbours) as its shell, so the interpolated surface wrapping it belongs to it.
   */
  private shell(target: number, lo: number) {
    const labels = this.labels!;
    const { nx, ny, nz } = this;
    const nxy = nx * ny;
    for (let k = 0, idx = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++, idx++) {
          if (labels[idx] !== target) continue;
          for (let dk = -1; dk <= 1; dk++) {
            const kk = k + dk;
            if (kk < 0 || kk >= nz) continue;
            for (let dj = -1; dj <= 1; dj++) {
              const jj = j + dj;
              if (jj < 0 || jj >= ny) continue;
              for (let di = -1; di <= 1; di++) {
                const ii = i + di;
                if (ii < 0 || ii >= nx) continue;
                const n = ii + jj * nx + kk * nxy;
                const l = labels[n];
                if (l !== 0 && !(l & SHELL)) continue;
                if (this.valueAt(ii, jj, kk) >= lo) continue;
                labels[n] = target | SHELL;
              }
            }
          }
        }
      }
    }
  }

  private count() {
    const counts = new Float64Array(256); // shell voxels land in 128..255 and are not counted
    const L = this.labels;
    if (L) for (let i = 0; i < L.length; i++) counts[L[i]]++;
    for (const s of this.segments) s.voxels = counts[s.id];
  }
}

/** Point-in-crop test (frame coordinates); always true without a crop. */
export function cropTester(crop: CropSpec | null): (x: number, y: number, z: number) => boolean {
  if (!crop) return () => true;
  const { origin: o, frame: F, min, max } = crop;
  return (x, y, z) => {
    const qx = x - o[0];
    const qy = y - o[1];
    const qz = z - o[2];
    const a = qx * F[0][0] + qy * F[0][1] + qz * F[0][2];
    if (a < min[0] || a > max[0]) return false;
    const b = qx * F[1][0] + qy * F[1][1] + qz * F[1][2];
    if (b < min[1] || b > max[1]) return false;
    const c = qx * F[2][0] + qy * F[2][1] + qz * F[2][2];
    return c >= min[2] && c <= max[2];
  };
}

/**
 * Which side of an open polyline a 2D point is on. The polyline is extended
 * at both ends along its end segments and closed far away on its left, then
 * the plane is rasterised with an even-odd scanline fill.
 */
function rasterizeSide(poly: Vec2[], a0: number, a1: number, b0: number, b1: number, minRes: number) {
  const span = Math.max(a1 - a0, b1 - b0, 1);
  const res = Math.max(minRes, span / 1024);
  // drop repeated points (zero-length segments would give the extensions no direction)
  poly = poly.filter((p, i) => i === 0 || Math.hypot(p[0] - poly[i - 1][0], p[1] - poly[i - 1][1]) > 1e-3);
  if (poly.length < 2) return { at: () => 0 };
  const pad = 2 * res;
  a0 -= pad;
  b0 -= pad;
  a1 += pad;
  b1 += pad;
  const W = Math.ceil((a1 - a0) / res) + 1;
  const H = Math.ceil((b1 - b0) / res) + 1;
  const R = span * 20 + 1000;
  const n = poly.length;
  const dir = (p: Vec2, q: Vec2): Vec2 => {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  const d0 = dir(poly[1], poly[0]); // outward at the start
  const d1 = dir(poly[n - 2], poly[n - 1]); // outward at the end
  const chord = dir(poly[0], poly[n - 1]);
  const left: Vec2 = [-chord[1], chord[0]];
  const e0: Vec2 = [poly[0][0] + d0[0] * R, poly[0][1] + d0[1] * R];
  const e1: Vec2 = [poly[n - 1][0] + d1[0] * R, poly[n - 1][1] + d1[1] * R];
  const ring: Vec2[] = [e0, ...poly, e1, [e1[0] + left[0] * R, e1[1] + left[1] * R], [e0[0] + left[0] * R, e0[1] + left[1] * R]];
  const grid = new Int8Array(W * H).fill(-1);
  const xs: number[] = [];
  for (let j = 0; j < H; j++) {
    const y = b0 + j * res;
    xs.length = 0;
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k];
      const q = ring[(k + 1) % ring.length];
      if (p[1] <= y === q[1] <= y) continue;
      xs.push(p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - a0) / res));
      const i1 = Math.min(W - 1, Math.floor((xs[k + 1] - a0) / res));
      for (let i = i0; i <= i1; i++) grid[j * W + i] = 1;
    }
  }
  return {
    at(a: number, b: number): number {
      let i = Math.round((a - a0) / res);
      let j = Math.round((b - b0) / res);
      i = i < 0 ? 0 : i >= W ? W - 1 : i;
      j = j < 0 ? 0 : j >= H ? H - 1 : j;
      return grid[j * W + i];
    },
  };
}
