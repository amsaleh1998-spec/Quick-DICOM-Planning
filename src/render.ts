import { Frame, Vec3 } from './math';
import { Volume, trilinear } from './volume';

/** Crop box in frame coordinates; points outside are rendered as background. */
export interface CropSpec {
  origin: Vec3;
  frame: Frame;
  min: Vec3;
  max: Vec3;
}

export interface SlabSpec {
  /** unit world direction across the slab */
  dir: Vec3;
  thickness: number;
  samples: number;
  mode: 'avg' | 'mip';
}

/**
 * Sample `count` points along a line p0 + t*dp (world mm) into out[offset + t*stride].
 * Optional slab: each point is the average/max of samples across `slab.dir`.
 */
export function sampleLine(
  vol: Volume,
  out: Float32Array,
  offset: number,
  stride: number,
  count: number,
  p0: Vec3,
  dp: Vec3,
  crop: CropSpec | null,
  slab: SlabSpec | null,
  bg: number,
) {
  const { data, nx, ny, nz } = vol;
  const nxy = nx * ny;
  const mx = nx - 1;
  const my = ny - 1;
  const mz = nz - 1;
  const isx = 1 / vol.spacing[0];
  const isy = 1 / vol.spacing[1];
  const isz = 1 / vol.spacing[2];
  let x = p0[0] * isx;
  let y = p0[1] * isy;
  let z = p0[2] * isz;
  const dx = dp[0] * isx;
  const dy = dp[1] * isy;
  const dz = dp[2] * isz;

  // Crop coordinates are linear in t as well.
  let c0 = 0,
    c1 = 0,
    c2 = 0,
    dc0 = 0,
    dc1 = 0,
    dc2 = 0,
    mn0 = 0,
    mn1 = 0,
    mn2 = 0,
    mx0 = 0,
    mx1 = 0,
    mx2 = 0;
  const useCrop = crop !== null;
  if (crop) {
    const f = crop.frame;
    const q: Vec3 = [p0[0] - crop.origin[0], p0[1] - crop.origin[1], p0[2] - crop.origin[2]];
    c0 = q[0] * f[0][0] + q[1] * f[0][1] + q[2] * f[0][2];
    c1 = q[0] * f[1][0] + q[1] * f[1][1] + q[2] * f[1][2];
    c2 = q[0] * f[2][0] + q[1] * f[2][1] + q[2] * f[2][2];
    dc0 = dp[0] * f[0][0] + dp[1] * f[0][1] + dp[2] * f[0][2];
    dc1 = dp[0] * f[1][0] + dp[1] * f[1][1] + dp[2] * f[1][2];
    dc2 = dp[0] * f[2][0] + dp[1] * f[2][1] + dp[2] * f[2][2];
    [mn0, mn1, mn2] = crop.min;
    [mx0, mx1, mx2] = crop.max;
  }

  if (!slab || slab.samples <= 1) {
    for (let t = 0; t < count; t++) {
      let v: number;
      if (useCrop && (c0 < mn0 || c0 > mx0 || c1 < mn1 || c1 > mx1 || c2 < mn2 || c2 > mx2)) v = bg;
      else v = trilinear(data, nx, nxy, mx, my, mz, x, y, z, bg);
      out[offset + t * stride] = v;
      x += dx;
      y += dy;
      z += dz;
      c0 += dc0;
      c1 += dc1;
      c2 += dc2;
    }
    return;
  }

  const n = slab.samples;
  const step = slab.thickness / (n - 1);
  const sx = slab.dir[0] * step * isx;
  const sy = slab.dir[1] * step * isy;
  const sz = slab.dir[2] * step * isz;
  const half = (n - 1) / 2;
  let sc0 = 0,
    sc1 = 0,
    sc2 = 0;
  if (crop) {
    const f = crop.frame;
    const d = slab.dir;
    sc0 = (d[0] * f[0][0] + d[1] * f[0][1] + d[2] * f[0][2]) * step;
    sc1 = (d[0] * f[1][0] + d[1] * f[1][1] + d[2] * f[1][2]) * step;
    sc2 = (d[0] * f[2][0] + d[1] * f[2][1] + d[2] * f[2][2]) * step;
  }
  const mip = slab.mode === 'mip';
  for (let t = 0; t < count; t++) {
    let acc = mip ? -Infinity : 0;
    let px = x - sx * half;
    let py = y - sy * half;
    let pz = z - sz * half;
    let q0 = c0 - sc0 * half;
    let q1 = c1 - sc1 * half;
    let q2 = c2 - sc2 * half;
    for (let s = 0; s < n; s++) {
      let v: number;
      if (useCrop && (q0 < mn0 || q0 > mx0 || q1 < mn1 || q1 > mx1 || q2 < mn2 || q2 > mx2)) v = bg;
      else v = trilinear(data, nx, nxy, mx, my, mz, px, py, pz, bg);
      if (mip) {
        if (v > acc) acc = v;
      } else acc += v;
      px += sx;
      py += sy;
      pz += sz;
      q0 += sc0;
      q1 += sc1;
      q2 += sc2;
    }
    out[offset + t * stride] = mip ? acc : acc / n;
    x += dx;
    y += dy;
    z += dz;
    c0 += dc0;
    c1 += dc1;
    c2 += dc2;
  }
}

/** Sample a planar image: pixel (i,j) -> p0 + i*du + j*dv. */
export function samplePlane(
  vol: Volume,
  out: Float32Array,
  w: number,
  h: number,
  p0: Vec3,
  du: Vec3,
  dv: Vec3,
  crop: CropSpec | null,
  slab: SlabSpec | null,
  bg: number,
) {
  for (let j = 0; j < h; j++) {
    const rowStart: Vec3 = [p0[0] + dv[0] * j, p0[1] + dv[1] * j, p0[2] + dv[2] * j];
    sampleLine(vol, out, j * w, 1, w, rowStart, du, crop, slab, bg);
  }
}

export function windowToBytes(
  values: Float32Array,
  rgba: Uint8ClampedArray,
  center: number,
  width: number,
) {
  const lo = center - width / 2;
  const k = 255 / Math.max(1e-6, width);
  for (let i = 0, o = 0; i < values.length; i++, o += 4) {
    const g = (values[i] - lo) * k;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
    rgba[o + 3] = 255;
  }
}
