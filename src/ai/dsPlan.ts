// DentalSegmentator (nnU-Net v2, 3d_fullres) – constants and the sliding-window plan.
//
// Model: Dot G, et al. "DentalSegmentator: robust open source deep learning-based CT and CBCT
// image segmentation". Journal of Dentistry (2024), doi:10.1016/j.jdent.2024.105130 ·
// weights: Dot G, Zenodo 2024, doi:10.5281/zenodo.10829675 (CC BY 4.0).
// Framework: Isensee F, et al. "nnU-Net". Nature Methods 2021;18:203–211.
//
// Everything here mirrors nnU-Net's own inference (plans.json of Dataset112): CT normalisation,
// target spacing, patch size, step positions and the Gaussian importance map. Pure functions so
// the worker and the tests share them.

import type { Vec3 } from '../math';

export const DS_MODEL = {
  name: 'DentalSegmentator',
  version: '1.0.0',
  /** model input axes: 0 = posterior, 1 = superior, 2 = left (nnU-Net transposes the image to y, z, x) */
  patch: [128, 160, 112] as [number, number, number],
  spacing: [0.43164101243019104, 0.31200000643730164, 0.43164101243019104] as [number, number, number],
  /** CTNormalization: clip to the 0.5 / 99.5 percentiles, then z-score */
  clipLo: -208,
  clipHi: 3070,
  mean: 1178.261474609375,
  std: 611.7098999023438,
  classes: 6,
};

export interface DsLabel {
  cls: number;
  /** label as named by DentalSegmentator */
  original: string;
  name: string;
  color: [number, number, number];
  /** 3D opacity: the jaws slightly see-through so roots, canals and implants show */
  opacity: number;
}

export const DS_LABELS: DsLabel[] = [
  { cls: 1, original: 'Upper Skull', name: 'Maxilla & upper skull', color: [236, 178, 112], opacity: 0.7 },
  { cls: 2, original: 'Mandible', name: 'Mandible', color: [104, 178, 240], opacity: 0.7 },
  { cls: 3, original: 'Upper Teeth', name: 'Upper teeth', color: [250, 240, 206], opacity: 1 },
  { cls: 4, original: 'Lower Teeth', name: 'Lower teeth', color: [222, 238, 250], opacity: 1 },
  { cls: 5, original: 'Mandibular canal', name: 'Mandibular canal', color: [255, 196, 30], opacity: 1 },
];

export const DS_CREDIT = {
  paper: 'Dot G, et al. DentalSegmentator: robust open source deep learning-based CT and CBCT image segmentation. Journal of Dentistry (2024).',
  paperDoi: 'https://doi.org/10.1016/j.jdent.2024.105130',
  weightsDoi: 'https://doi.org/10.5281/zenodo.10829675',
  nnunet: 'Isensee F, Jaeger PF, Kohl SAA, Petersen J, Maier-Hein KH. nnU-Net: a self-configuring method for deep learning-based biomedical image segmentation. Nat Methods 2021;18(2):203-211.',
  nnunetDoi: 'https://doi.org/10.1038/s41592-020-01008-z',
  slicer: 'https://github.com/gaudot/SlicerDentalSegmentator',
  license: 'https://creativecommons.org/licenses/by/4.0/',
};

/** Tile positions along one axis (nnU-Net compute_steps_for_sliding_window). */
export function slidingSteps(size: number, patch: number, step: number): number[] {
  if (size <= patch) return [0];
  const target = patch * step;
  const n = Math.ceil((size - patch) / target) + 1;
  const actual = (size - patch) / (n - 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round(actual * i));
  return out;
}

/**
 * 1D factor of nnU-Net's Gaussian importance map (σ = patch / 8 around patch // 2). The 3D map
 * is the product of the three factors (the max-normalisation cancels in the weighted average).
 */
export function gaussian1d(patch: number): Float64Array {
  const c = Math.floor(patch / 2);
  const s = patch / 8;
  const g = new Float64Array(patch);
  for (let i = 0; i < patch; i++) g[i] = Math.exp(-((i - c) ** 2) / (2 * s * s));
  return g;
}

/** Sum of the Gaussian weights of every tile covering each voxel along one axis. */
export function axisWeightSum(size: number, patch: number, steps: number[], g: Float64Array): Float64Array {
  const W = new Float64Array(size);
  for (const s of steps) for (let i = 0; i < patch; i++) if (s + i < size) W[s + i] += g[i];
  return W;
}

/**
 * Which world axis (and direction) each model axis follows. The model expects axis 0 = posterior,
 * 1 = superior, 2 = patient left (ITK arrays of axial scans). `patientAffine` maps world mm to
 * DICOM LPS; without it the world axes are taken as L, P, S (how the DICOM loader stores scans).
 */
export function modelAxes(patientAffine?: number[]): { ax: [number, number, number]; sg: [number, number, number] } {
  // LPS direction wanted for each model axis
  const want: Vec3[] = [
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 0],
  ];
  const M = patientAffine;
  // LPS direction of world axis a = column a of the rotation part
  const col = (a: number): Vec3 => (M ? [M[a], M[4 + a], M[8 + a]] : ([a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0] as Vec3));
  const ax: [number, number, number] = [-1, -1, -1];
  const sg: [number, number, number] = [1, 1, 1];
  const used = new Set<number>();
  // assign the most clear-cut pairs first
  const pairs: { k: number; a: number; d: number }[] = [];
  for (let k = 0; k < 3; k++)
    for (let a = 0; a < 3; a++) {
      const c = col(a);
      pairs.push({ k, a, d: c[0] * want[k][0] + c[1] * want[k][1] + c[2] * want[k][2] });
    }
  pairs.sort((p, q) => Math.abs(q.d) - Math.abs(p.d));
  for (const p of pairs) {
    if (ax[p.k] >= 0 || used.has(p.a)) continue;
    ax[p.k] = p.a;
    sg[p.k] = p.d < 0 ? -1 : 1;
    used.add(p.a);
  }
  return { ax, sg };
}

export interface ModelGrid {
  /** world axis and direction of each model axis */
  ax: [number, number, number];
  sg: [number, number, number];
  /** voxels of the resampled region (before padding to the patch size) */
  n: [number, number, number];
  /** padding in front (voxels) when the region is smaller than the patch */
  pad: [number, number, number];
  /** padded size */
  size: [number, number, number];
  /** actual model spacing (mm) */
  sp: [number, number, number];
  /** world coordinate (along world axis ax[k]) of the centre of unpadded voxel 0 */
  c0: [number, number, number];
  steps: [number[], number[], number[]];
}

/**
 * Model grid over the world box [lo, hi] (voxel centres of the CT, per world axis) with
 * nnU-Net's resampling convention: the box edges (half a CT voxel outside the centres) are kept,
 * the number of voxels is rounded and the spacing adjusted.
 */
export function modelGrid(lo: Vec3, hi: Vec3, ctSpacing: Vec3, axes: { ax: [number, number, number]; sg: [number, number, number] }, step: number): ModelGrid {
  const { ax, sg } = axes;
  const n: [number, number, number] = [0, 0, 0];
  const pad: [number, number, number] = [0, 0, 0];
  const size: [number, number, number] = [0, 0, 0];
  const sp: [number, number, number] = [0, 0, 0];
  const c0: [number, number, number] = [0, 0, 0];
  const steps: [number[], number[], number[]] = [[], [], []];
  for (let k = 0; k < 3; k++) {
    const a = ax[k];
    const e0 = lo[a] - ctSpacing[a] / 2;
    const e1 = hi[a] + ctSpacing[a] / 2;
    const extent = e1 - e0;
    n[k] = Math.max(1, Math.round(extent / DS_MODEL.spacing[k]));
    sp[k] = extent / n[k];
    c0[k] = sg[k] > 0 ? e0 + sp[k] / 2 : e1 - sp[k] / 2;
    const P = DS_MODEL.patch[k];
    pad[k] = n[k] < P ? Math.floor((P - n[k]) / 2) : 0;
    size[k] = Math.max(n[k], P);
    steps[k] = slidingSteps(size[k], P, step);
  }
  return { ax, sg, n, pad, size, sp, c0, steps };
}

/** World coordinate (along world axis ax[k]) of padded model index m on model axis k. */
export function modelToWorld(g: ModelGrid, k: number, m: number): number {
  return g.c0[k] + g.sg[k] * (m - g.pad[k]) * g.sp[k];
}

/** Continuous padded model index of a world coordinate along model axis k. */
export function worldToModel(g: ModelGrid, k: number, w: number): number {
  return (w - g.c0[k]) / (g.sg[k] * g.sp[k]) + g.pad[k];
}

export function patchCount(g: ModelGrid): number {
  return g.steps[0].length * g.steps[1].length * g.steps[2].length;
}

/**
 * Region the network looks at for a requested box: the box plus `margin` mm of real context on
 * every side, and at least one tile in every direction (instead of padding), inside the scan.
 */
export function contextBox(lo: Vec3, hi: Vec3, scanLo: Vec3, scanHi: Vec3, axes: { ax: [number, number, number] }, margin = 10): { lo: Vec3; hi: Vec3 } {
  const L: Vec3 = [0, 0, 0];
  const H: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const a = axes.ax[k];
    let l = lo[a] - margin;
    let h = hi[a] + margin;
    const need = DS_MODEL.patch[k] * DS_MODEL.spacing[k] + 1;
    if (h - l < need) {
      const c = (l + h) / 2;
      l = c - need / 2;
      h = c + need / 2;
    }
    // keep the size when clamping to the scan
    if (l < scanLo[a]) {
      h += scanLo[a] - l;
      l = scanLo[a];
    }
    if (h > scanHi[a]) {
      l -= h - scanHi[a];
      h = scanHi[a];
    }
    L[a] = Math.max(scanLo[a], l);
    H[a] = Math.min(scanHi[a], h);
  }
  return { lo: L, hi: H };
}

/**
 * Where the jaws meet, as a world coordinate along axis `a`, inside [lo, hi]: the middle of the
 * band of the brightest voxels (enamel, restorations), weighted by how many there are per slice;
 * without teeth, the emptiest slice between the two ridges.
 */
export function occlusalSplit(data: Int16Array, dims: [number, number, number], spacing: Vec3, lo: Vec3, hi: Vec3, a: number, bone: number): number {
  const i0 = [0, 1, 2].map((k) => Math.max(0, Math.ceil(lo[k] / spacing[k])));
  const i1 = [0, 1, 2].map((k) => Math.min(dims[k] - 1, Math.floor(hi[k] / spacing[k])));
  const [b1, b2] = [0, 1, 2].filter((k) => k !== a);
  const n = i1[a] - i0[a] + 1;
  const at = (idx: number[]) => data[idx[0] + idx[1] * dims[0] + idx[2] * dims[0] * dims[1]];
  // the brightest few per cent of what is bone or brighter: enamel, metal
  const hist = new Map<number, number>();
  let total = 0;
  const idx = [0, 0, 0];
  const stride = 2;
  for (idx[a] = i0[a]; idx[a] <= i1[a]; idx[a] += stride)
    for (idx[b1] = i0[b1]; idx[b1] <= i1[b1]; idx[b1] += stride)
      for (idx[b2] = i0[b2]; idx[b2] <= i1[b2]; idx[b2] += stride) {
        const v = at(idx);
        if (v < bone) continue;
        const bin = Math.floor(v / 16);
        hist.set(bin, (hist.get(bin) ?? 0) + 1);
        total++;
      }
  let enamel = bone * 2;
  let acc = 0;
  const bins = [...hist.keys()].sort((x, y) => y - x);
  for (const bin of bins) {
    acc += hist.get(bin)!;
    if (acc >= total * 0.03) {
      enamel = Math.max(bone + 1, bin * 16);
      break;
    }
  }
  // typical bone: the median of what is bone or brighter
  let median = bone;
  acc = 0;
  for (const bin of bins) {
    acc += hist.get(bin)!;
    if (acc >= total * 0.5) {
      median = bin * 16;
      break;
    }
  }
  const bright = new Float64Array(n), boneN = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    idx[a] = i0[a] + t;
    for (idx[b1] = i0[b1]; idx[b1] <= i1[b1]; idx[b1] += stride)
      for (idx[b2] = i0[b2]; idx[b2] <= i1[b2]; idx[b2] += stride) {
        const v = at(idx);
        if (v >= bone) boneN[t]++;
        if (v >= enamel) bright[t]++;
      }
  }
  const smooth = (p: Float64Array, r: number) => p.map((_, t) => {
    let s = 0, c = 0;
    for (let u = Math.max(0, t - r); u <= Math.min(n - 1, t + r); u++) (s += p[u]), c++;
    return s / c;
  });
  const r = Math.max(1, Math.round(1.5 / spacing[a]));
  const B = smooth(bright, r);
  let peak = 0;
  for (let t = 1; t < n; t++) if (B[t] > B[peak]) peak = t;
  const world = (t: number) => (i0[a] + t) * spacing[a];
  // crowns only when there is something distinctly brighter than bone (enamel, metal)
  if (enamel >= median * 1.6 && B[peak] >= 40) {
    // the band of crowns around the peak, its weighted middle
    let s0 = peak, s1 = peak;
    while (s0 > 0 && B[s0 - 1] >= B[peak] * 0.3) s0--;
    while (s1 < n - 1 && B[s1 + 1] >= B[peak] * 0.3) s1++;
    let sw = 0, st = 0;
    for (let t = s0; t <= s1; t++) (sw += B[t]), (st += B[t] * t);
    return world(st / sw);
  }
  // no teeth: the emptiest slice between the two ridges
  const S = smooth(boneN, Math.max(2, Math.round(3 / spacing[a])));
  const m0 = Math.floor(n * 0.15), m1 = Math.ceil(n * 0.85);
  let low = Infinity;
  for (let t = m0; t <= m1; t++) low = Math.min(low, S[t]);
  // the middle of the emptiest stretch
  let best = Math.round(n / 2), bestLen = 0;
  for (let t = m0; t <= m1; ) {
    if (S[t] > low + 1e-9) {
      t++;
      continue;
    }
    let u = t;
    while (u + 1 <= m1 && S[u + 1] <= low + 1e-9) u++;
    if (u - t + 1 > bestLen) [bestLen, best] = [u - t + 1, (t + u) / 2];
    t = u + 1;
  }
  return world(best);
}
