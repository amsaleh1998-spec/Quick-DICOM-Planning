import { Frame, Vec3, fromFrame } from './math';

let nextVolumeId = 1;

export interface VolumeInfo {
  patientName?: string;
  seriesDescription?: string;
  studyDate?: string;
  modality?: string;
  source: string;
  defaultWindow?: { center: number; width: number };
}

/**
 * Scalar volume on a regular grid. World coordinates (mm) are simply
 * index * spacing, axes aligned with the patient (LPS: +x = patient left,
 * +y = posterior, +z = superior) after loading.
 */
export class Volume {
  readonly id = nextVolumeId++;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly spacing: Vec3;
  readonly data: Int16Array;
  min = 0;
  max = 0;
  info: VolumeInfo;

  constructor(dims: [number, number, number], spacing: Vec3, data: Int16Array, info: VolumeInfo) {
    [this.nx, this.ny, this.nz] = dims;
    if (this.nx < 2 || this.ny < 2 || this.nz < 2) throw new Error('Volume needs at least 2 voxels along every axis');
    this.spacing = spacing;
    this.data = data;
    this.info = info;
    this.updateRange();
  }

  updateRange() {
    let mn = 32767;
    let mx = -32768;
    const d = this.data;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    this.min = mn;
    this.max = mx;
  }

  get dims(): [number, number, number] {
    return [this.nx, this.ny, this.nz];
  }

  /** Physical size of the volume (mm, from first to last voxel centre). */
  get extent(): Vec3 {
    return [(this.nx - 1) * this.spacing[0], (this.ny - 1) * this.spacing[1], (this.nz - 1) * this.spacing[2]];
  }

  get center(): Vec3 {
    const e = this.extent;
    return [e[0] / 2, e[1] / 2, e[2] / 2];
  }

  get minSpacing(): number {
    return Math.min(this.spacing[0], this.spacing[1], this.spacing[2]);
  }

  /** The 8 corners of the volume in world coordinates. */
  corners(): Vec3[] {
    const e = this.extent;
    const out: Vec3[] = [];
    for (let i = 0; i < 8; i++) out.push([i & 1 ? e[0] : 0, i & 2 ? e[1] : 0, i & 4 ? e[2] : 0]);
    return out;
  }

  /** Trilinear sample at a world position; returns `bg` outside. */
  sample(p: Vec3, bg = this.min): number {
    const x = p[0] / this.spacing[0];
    const y = p[1] / this.spacing[1];
    const z = p[2] / this.spacing[2];
    return trilinear(this.data, this.nx, this.nx * this.ny, this.nx - 1, this.ny - 1, this.nz - 1, x, y, z, bg);
  }

  /**
   * Threshold separating bone/teeth from soft tissue for 3D rendering:
   * Otsu on the whole histogram (air vs. tissue), then Otsu again above it.
   */
  boneThreshold(): number {
    const d = this.data;
    const bins = 1024;
    const lo = this.min;
    const range = Math.max(1, this.max - this.min);
    const hist = new Float64Array(bins);
    const step = Math.max(1, Math.floor(d.length / 2_000_000));
    for (let i = 0; i < d.length; i += step) hist[Math.min(bins - 1, Math.floor(((d[i] - lo) / range) * bins))]++;
    const otsu = (from: number) => {
      let total = 0;
      let sum = 0;
      for (let b = from; b < bins; b++) {
        total += hist[b];
        sum += b * hist[b];
      }
      let wB = 0;
      let sumB = 0;
      let best = 0;
      let bt = from;
      for (let b = from; b < bins; b++) {
        wB += hist[b];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += b * hist[b];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) {
          best = between;
          bt = b;
        }
      }
      return bt;
    };
    const t1 = otsu(0);
    const t2 = otsu(t1 + 1);
    return lo + ((t2 + 0.5) / bins) * range;
  }

  /** Window from histogram percentiles – CBCT grey values are rarely calibrated HU. */
  autoWindow(): { center: number; width: number } {
    const d = this.data;
    const bins = 4096;
    const lo = this.min;
    const range = Math.max(1, this.max - this.min);
    const hist = new Uint32Array(bins);
    const step = Math.max(1, Math.floor(d.length / 2_000_000));
    let n = 0;
    for (let i = 0; i < d.length; i += step) {
      hist[Math.min(bins - 1, Math.floor(((d[i] - lo) / range) * bins))]++;
      n++;
    }
    const pick = (q: number) => {
      let acc = 0;
      for (let b = 0; b < bins; b++) {
        acc += hist[b];
        if (acc >= q * n) return lo + (b / bins) * range;
      }
      return this.max;
    };
    const a = pick(0.02);
    const b = pick(0.998);
    const width = Math.max(1, b - a);
    return { center: a + width / 2, width };
  }
}

export function trilinear(
  d: Int16Array,
  nx: number,
  nxy: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  x: number,
  y: number,
  z: number,
  bg: number,
): number {
  if (!(x >= 0 && y >= 0 && z >= 0 && x <= maxX && y <= maxY && z <= maxZ)) return bg;
  let x0 = x | 0;
  let y0 = y | 0;
  let z0 = z | 0;
  if (x0 >= maxX) x0 = maxX - 1;
  if (y0 >= maxY) y0 = maxY - 1;
  if (z0 >= maxZ) z0 = maxZ - 1;
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const i = x0 + y0 * nx + z0 * nxy;
  const c00 = d[i] + (d[i + 1] - d[i]) * fx;
  const c10 = d[i + nx] + (d[i + nx + 1] - d[i + nx]) * fx;
  const j = i + nxy;
  const c01 = d[j] + (d[j + 1] - d[j]) * fx;
  const c11 = d[j + nx] + (d[j + nx + 1] - d[j + nx]) * fx;
  const c0 = c00 + (c10 - c00) * fy;
  const c1 = c01 + (c11 - c01) * fy;
  return c0 + (c1 - c0) * fz;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Resample the volume onto a new grid aligned with `frame`, covering the box
 * [boxMin, boxMax] (frame coordinates relative to `origin`). This bakes a
 * re-orientation and crop into a new, smaller volume.
 */
export async function resampleVolume(
  vol: Volume,
  origin: Vec3,
  frame: Frame,
  boxMin: Vec3,
  boxMax: Vec3,
  spacing: number,
  onProgress?: (f: number) => void,
): Promise<Volume> {
  const dims = [0, 1, 2].map((a) => Math.max(2, Math.floor((boxMax[a] - boxMin[a]) / spacing) + 1)) as [number, number, number];
  const total = dims[0] * dims[1] * dims[2];
  if (total > 400_000_000) throw new Error('Cropped volume is too large – make the crop box smaller.');
  const out = new Int16Array(total);
  const p0 = fromFrame(boxMin, origin, frame);
  const sx = vol.spacing[0];
  const sy = vol.spacing[1];
  const sz = vol.spacing[2];
  // Steps in source index space.
  const di: Vec3 = [(frame[0][0] * spacing) / sx, (frame[0][1] * spacing) / sy, (frame[0][2] * spacing) / sz];
  const dj: Vec3 = [(frame[1][0] * spacing) / sx, (frame[1][1] * spacing) / sy, (frame[1][2] * spacing) / sz];
  const dk: Vec3 = [(frame[2][0] * spacing) / sx, (frame[2][1] * spacing) / sy, (frame[2][2] * spacing) / sz];
  const base: Vec3 = [p0[0] / sx, p0[1] / sy, p0[2] / sz];
  const { data, nx, ny, nz } = vol;
  const nxy = nx * ny;
  const bg = vol.min;
  let o = 0;
  let last = performance.now();
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      let x = base[0] + dj[0] * j + dk[0] * k;
      let y = base[1] + dj[1] * j + dk[1] * k;
      let z = base[2] + dj[2] * j + dk[2] * k;
      for (let i = 0; i < dims[0]; i++) {
        out[o++] = Math.round(trilinear(data, nx, nxy, nx - 1, ny - 1, nz - 1, x, y, z, bg));
        x += di[0];
        y += di[1];
        z += di[2];
      }
    }
    if (performance.now() - last > 60) {
      onProgress?.(k / dims[2]);
      await tick();
      last = performance.now();
    }
  }
  return new Volume(dims, [spacing, spacing, spacing], out, { ...vol.info, source: vol.info.source + ' (reoriented/cropped)' });
}

/**
 * Synthetic CBCT-like phantom so the app can be tried without data: a mandible
 * (missing lower-left first molar, mandibular canals) and a maxilla with a
 * palate whose teeth touch the lower teeth in occlusion, on a slightly tilted
 * occlusal plane.
 */
export function createPhantom(): Volume {
  const sp = 0.35;
  const nx = 300;
  const ny = 270;
  const nz = 262;
  const data = new Int16Array(nx * ny * nz);

  // Dental arch: parabola in the axial plane (mm).
  const x0 = (nx * sp) / 2;
  const yFront = 20;
  const k = 0.064;
  const arch: { x: number; y: number; s: number }[] = [];
  let s = 0;
  for (let t = -31; t <= 31.0001; t += 0.25) {
    const p = { x: x0 + t, y: yFront + k * t * t, s: 0 };
    if (arch.length) {
      const q = arch[arch.length - 1];
      s += Math.hypot(p.x - q.x, p.y - q.y);
    }
    p.s = s;
    arch.push(p);
  }
  const archLen = s;
  const sMid = archLen / 2;

  // Per axial pixel: signed distance to the arch (+ = buccal/outside) and arch position.
  const dist = new Float32Array(nx * ny);
  const pos = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * sp;
      const y = j * sp;
      let best = 1e9;
      let bi = 0;
      for (let a = 0; a < arch.length; a += 2) {
        const dx = x - arch[a].x;
        const dy = y - arch[a].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) {
          best = d2;
          bi = a;
        }
      }
      // refine
      for (let a = Math.max(0, bi - 2); a <= Math.min(arch.length - 1, bi + 2); a++) {
        const dx = x - arch[a].x;
        const dy = y - arch[a].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) {
          best = d2;
          bi = a;
        }
      }
      const inside = y > yFront + k * (x - x0) * (x - x0);
      dist[j * nx + i] = Math.sqrt(best) * (inside ? -1 : 1);
      pos[j * nx + i] = arch[bi].s;
    }
  }

  // Teeth along the arch (centre position, mesio-distal width).
  const widths = [8.5, 6.5, 7.5, 7, 7, 10.5, 10];
  const teeth: { s: number; w: number }[] = [];
  for (const side of [-1, 1]) {
    let acc = 0;
    widths.forEach((w, idx) => {
      const c = acc + w / 2;
      acc += w + 0.4;
      // Missing lower-left first molar (patient left = +x).
      if (side === 1 && idx === 5) return;
      teeth.push({ s: sMid + side * c, w });
    });
  }

  let seed = 12345;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };

  const crest = 38;
  // maxilla: crest of the upper alveolar process; upper crowns reach down to the lower ones
  const uCrest = crest + 18;
  const archEndY = yFront + k * 31 * 31;
  for (let kz = 0; kz < nz; kz++) {
    for (let j = 0; j < ny; j++) {
      const y = j * sp;
      // Tilted occlusal plane (~4.5°) so re-orientation can be practised.
      const z = kz * sp - 0.08 * (y - 40);
      const row = kz * nx * ny + j * nx;
      for (let i = 0; i < nx; i++) {
        const d = dist[j * nx + i];
        const sa = pos[j * nx + i];
        let v = -1000;
        const endFade = sa < 1.5 || sa > archLen - 1.5;
        if (!endFade && Math.abs(d) < 14 && z > 4 && z < uCrest + 30) v = 40; // soft tissue
        if (d < 0 && y < archEndY && z > uCrest + 6 && z < uCrest + 20) v = 40; // tongue / palate soft tissue
        if (!endFade) {
          // Mandibular body: rounded box in (d, z).
          const hw = 5.5 - Math.max(0, z - 30) * 0.12;
          const bz0 = 12;
          const nd = Math.abs(d) / Math.max(1, hw);
          const nzc = (z - (bz0 + crest) / 2) / ((crest - bz0) / 2);
          const r = Math.pow(Math.pow(nd, 4) + Math.pow(Math.abs(nzc), 4), 0.25);
          if (r < 1) {
            const shell = (1 - r) * Math.min(hw, (crest - bz0) / 2);
            v = shell < 1.3 ? 1800 : 750;
            // Mandibular canal in the posterior region.
            const off = Math.abs(sa - sMid);
            if (off > 14) {
              const cz = 21 + (off - 14) * 0.08;
              if (Math.hypot(d + 0.5, z - cz) < 1.4) v = 120;
            }
          }
          // Teeth
          for (let t = 0; t < teeth.length; t++) {
            const ds = sa - teeth[t].s;
            const rw = teeth[t].w / 2;
            if (Math.abs(ds) > rw) continue;
            if (z > crest - 13 && z < crest + 9) {
              const rr = Math.hypot(ds / rw, d / 4.2);
              if (z >= crest) {
                // crown
                const bulge = 1 - Math.pow((z - crest - 3) / 6.5, 2) * 0.35;
                if (rr < 0.95 * bulge) v = rr > 0.95 * bulge - 0.28 ? 2900 : 2100;
                if (rr < 0.25 && z < crest + 4) v = 350;
              } else {
                // root, tapering into bone
                const taper = 0.75 - (crest - z) * 0.035;
                if (rr < taper) v = rr < 0.18 ? 350 : 2050;
                else if (rr < taper + 0.08) v = 200; // PDL space
              }
            }
          }
        }
        if (!endFade && z > uCrest - 10) {
          // Maxillary alveolar process (upper arch ~1 mm more buccal), widening upwards.
          const ud = d - 1;
          const uhw = 5.5 + Math.max(0, z - uCrest - 6) * 0.18;
          const uz1 = uCrest + 24;
          const nd = Math.abs(ud) / uhw;
          const nzc = (z - (uCrest + uz1) / 2) / ((uz1 - uCrest) / 2);
          const r = Math.pow(Math.pow(nd, 4) + Math.pow(Math.abs(nzc), 4), 0.25);
          if (r < 1) {
            const shell = (1 - r) * Math.min(uhw, (uz1 - uCrest) / 2);
            v = shell < 1.2 ? 1700 : 700;
          }
          // Upper teeth (all present), crowns pointing down onto the lower teeth.
          for (let t = 0; t < teeth.length + 1; t++) {
            const tc = t < teeth.length ? teeth[t] : { s: sMid + widths.slice(0, 5).reduce((a, w) => a + w + 0.4, 0) + 10.5 / 2, w: 10.5 };
            const ds = sa - tc.s;
            const rw = tc.w / 2;
            if (Math.abs(ds) > rw) continue;
            if (z > uCrest - 9 && z < uCrest + 13) {
              const rr = Math.hypot(ds / rw, ud / 4.4);
              if (z <= uCrest) {
                const bulge = 1 - Math.pow((uCrest - z - 3) / 6.5, 2) * 0.35;
                if (rr < 0.95 * bulge) v = rr > 0.95 * bulge - 0.28 ? 2900 : 2100;
                if (rr < 0.25 && z > uCrest - 4) v = 350;
              } else {
                const taper = 0.75 - (z - uCrest) * 0.035;
                if (rr < taper) v = rr < 0.18 ? 350 : 2050;
                else if (rr < taper + 0.08) v = 200;
              }
            }
          }
        }
        // Hard palate between the arms of the upper arch.
        if (d < -4 && y < archEndY && z > uCrest + 14 && z < uCrest + 18) v = Math.abs(z - uCrest - 16) > 1.1 ? 1600 : 650;
        data[row + i] = v + Math.round(rnd() * 45);
      }
    }
  }

  return new Volume([nx, ny, nz], [sp, sp, sp], data, {
    source: 'Demo phantom',
    patientName: 'Demo^Phantom',
    seriesDescription: 'Synthetic mandible',
    modality: 'CT',
  });
}
