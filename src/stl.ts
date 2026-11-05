// STL export: iso-surfaces of sampled scalar fields (marching tetrahedra), solid cones / tubes,
// and a binary STL writer. All coordinates are world millimetres.

import { Vec3, cross, normalize, sub } from './math';

/**
 * A scalar field sampled on a regular grid. Inside the surface ⇔ s > 0. Linear interpolation of
 * s places the vertices; ±Infinity marks samples forced outside / inside (e.g. another segment, the
 * crop box, the padding), where the crossing is put half-way between the samples.
 * The outermost layer of samples must be outside, so every surface is closed.
 */
export interface ScalarGrid {
  nx: number;
  ny: number;
  nz: number;
  s: Float32Array;
  /** world position of sample (0,0,0) */
  origin: Vec3;
  /** distance between samples along x, y, z (mm) */
  step: Vec3;
}

/** Triangle soup: 9 floats (3 vertices) per triangle. */
export type Tris = Float32Array;

class TriBuffer {
  private chunks: Float32Array[] = [];
  private cur = new Float32Array(9 * 65536);
  private n = 0;
  count = 0;
  push(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
    if (this.n + 9 > this.cur.length) {
      this.chunks.push(this.cur);
      this.cur = new Float32Array(9 * 65536);
      this.n = 0;
    }
    const c = this.cur;
    let i = this.n;
    c[i++] = ax; c[i++] = ay; c[i++] = az;
    c[i++] = bx; c[i++] = by; c[i++] = bz;
    c[i++] = cx; c[i++] = cy; c[i++] = cz;
    this.n = i;
    this.count++;
  }
  done(): Tris {
    const out = new Float32Array(this.count * 9);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    out.set(this.cur.subarray(0, this.n), o);
    return out;
  }
}

/**
 * Turn closed cavities into solid: every outside sample (s ≤ 0) that cannot be reached from the
 * grid border (6-connected) becomes inside. Removes the inner surfaces of trabecular bone, sinuses
 * enclosed by the segment etc., which gives much smaller, printable models.
 */
export function fillCavities(g: ScalarGrid) {
  const { nx, ny, nz, s } = g;
  const nxy = nx * ny;
  const n = nx * ny * nz;
  const seen = new Uint8Array(n);
  let stack = new Int32Array(1 << 16);
  let sp = 0;
  const pushIdx = (i: number) => {
    if (seen[i] || s[i] > 0) return;
    seen[i] = 1;
    if (sp === stack.length) {
      const bigger = new Int32Array(stack.length * 2);
      bigger.set(stack);
      stack = bigger;
    }
    stack[sp++] = i;
  };
  // seed: the whole border layer
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) pushIdx(i + j * nx + k * nxy);
      }
  while (sp > 0) {
    const idx = stack[--sp];
    const i = idx % nx;
    const j = ((idx - i) / nx) % ny;
    const k = (idx - i - j * nx) / nxy;
    if (i > 0) pushIdx(idx - 1);
    if (i < nx - 1) pushIdx(idx + 1);
    if (j > 0) pushIdx(idx - nx);
    if (j < ny - 1) pushIdx(idx + nx);
    if (k > 0) pushIdx(idx - nxy);
    if (k < nz - 1) pushIdx(idx + nxy);
  }
  for (let i = 0; i < n; i++) if (!seen[i] && s[i] <= 0) s[i] = Infinity;
}

// Freudenthal split of the unit cube into 6 tetrahedra around the 0–7 diagonal; identical in every
// cube, so neighbouring cubes share faces and the surface has no cracks.
// corner index = dx + 2*dy + 4*dz
const TETS = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];

/** Iso-surface s = 0 of the grid (marching tetrahedra), outward-facing triangles. */
export async function isoSurface(g: ScalarGrid, onProgress?: (f: number) => void): Promise<Tris> {
  const { nx, ny, nz, s, origin, step } = g;
  const nxy = nx * ny;
  const out = new TriBuffer();
  const cs = new Float64Array(8);
  const cx = new Float64Array(8);
  const cy = new Float64Array(8);
  const cz = new Float64Array(8);
  const off = [0, 1, nx, nx + 1, nxy, nxy + 1, nxy + nx, nxy + nx + 1];
  // edge point between corners a (inside) and b (outside) -> written to p[o..o+2]
  const p = new Float64Array(12);
  const edge = (a: number, b: number, o: number) => {
    const sa = cs[a];
    const sb = cs[b];
    let t = 0.5;
    if (Number.isFinite(sa) && Number.isFinite(sb)) t = Math.min(1, Math.max(0, sa / (sa - sb)));
    p[o] = cx[a] + t * (cx[b] - cx[a]);
    p[o + 1] = cy[a] + t * (cy[b] - cy[a]);
    p[o + 2] = cz[a] + t * (cz[b] - cz[a]);
  };
  // emit triangle p[o1], p[o2], p[o3], flipped so its normal points along (rx, ry, rz)
  const tri = (o1: number, o2: number, o3: number, rx: number, ry: number, rz: number) => {
    const ux = p[o2] - p[o1], uy = p[o2 + 1] - p[o1 + 1], uz = p[o2 + 2] - p[o1 + 2];
    const vx = p[o3] - p[o1], vy = p[o3 + 1] - p[o1 + 1], vz = p[o3 + 2] - p[o1 + 2];
    const nX = uy * vz - uz * vy, nY = uz * vx - ux * vz, nZ = ux * vy - uy * vx;
    if (nX * rx + nY * ry + nZ * rz >= 0) out.push(p[o1], p[o1 + 1], p[o1 + 2], p[o2], p[o2 + 1], p[o2 + 2], p[o3], p[o3 + 1], p[o3 + 2]);
    else out.push(p[o1], p[o1 + 1], p[o1 + 2], p[o3], p[o3 + 1], p[o3 + 2], p[o2], p[o2 + 1], p[o2 + 2]);
  };
  const ins: number[] = [];
  const outs: number[] = [];
  let lastYield = performance.now();
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const base = i + j * nx + k * nxy;
        let nIn = 0;
        for (let c = 0; c < 8; c++) {
          const v = s[base + off[c]];
          cs[c] = v;
          if (v > 0) nIn++;
        }
        if (nIn === 0 || nIn === 8) continue;
        for (let c = 0; c < 8; c++) {
          cx[c] = origin[0] + (i + (c & 1)) * step[0];
          cy[c] = origin[1] + (j + ((c >> 1) & 1)) * step[1];
          cz[c] = origin[2] + (k + ((c >> 2) & 1)) * step[2];
        }
        for (const t of TETS) {
          ins.length = 0;
          outs.length = 0;
          for (const c of t) (cs[c] > 0 ? ins : outs).push(c);
          if (ins.length === 0 || ins.length === 4) continue;
          // reference direction: from the inside corners towards the outside corners
          let rx = 0, ry = 0, rz = 0;
          for (const c of outs) (rx += cx[c] / outs.length), (ry += cy[c] / outs.length), (rz += cz[c] / outs.length);
          for (const c of ins) (rx -= cx[c] / ins.length), (ry -= cy[c] / ins.length), (rz -= cz[c] / ins.length);
          if (ins.length === 1) {
            edge(ins[0], outs[0], 0);
            edge(ins[0], outs[1], 3);
            edge(ins[0], outs[2], 6);
            tri(0, 3, 6, rx, ry, rz);
          } else if (ins.length === 3) {
            edge(ins[0], outs[0], 0);
            edge(ins[1], outs[0], 3);
            edge(ins[2], outs[0], 6);
            tri(0, 3, 6, rx, ry, rz);
          } else {
            // quad a-c, a-d, b-d, b-c
            const [a, b] = ins;
            const [c, d] = outs;
            edge(a, c, 0);
            edge(a, d, 3);
            edge(b, d, 6);
            edge(b, c, 9);
            tri(0, 3, 6, rx, ry, rz);
            tri(0, 6, 9, rx, ry, rz);
          }
        }
      }
    }
    if (performance.now() - lastYield > 60) {
      onProgress?.((k + 1) / (nz - 1));
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  onProgress?.(1);
  return out.done();
}

// ---- solids ---------------------------------------------------------------------

function basis(axis: Vec3): [Vec3, Vec3] {
  const a = normalize(axis);
  const helper: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(a, helper));
  const v = cross(a, u);
  return [u, v];
}

function pushOriented(out: TriBuffer, a: Vec3, b: Vec3, c: Vec3, inside: Vec3) {
  const n = cross(sub(b, a), sub(c, a));
  const cen: Vec3 = [(a[0] + b[0] + c[0]) / 3 - inside[0], (a[1] + b[1] + c[1]) / 3 - inside[1], (a[2] + b[2] + c[2]) / 3 - inside[2]];
  if (n[0] * cen[0] + n[1] * cen[1] + n[2] * cen[2] >= 0) out.push(...a, ...b, ...c);
  else out.push(...a, ...c, ...b);
}

/** Closed truncated cone from `start` (radius r0) to `end` (radius r1). */
export function coneMesh(start: Vec3, end: Vec3, r0: number, r1: number, segments = 72): Tris {
  const out = new TriBuffer();
  const axis = sub(end, start);
  const [u, v] = basis(axis);
  const center: Vec3 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2];
  const ring = (c: Vec3, r: number, i: number): Vec3 => {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a) * r;
    const sa = Math.sin(a) * r;
    return [c[0] + u[0] * ca + v[0] * sa, c[1] + u[1] * ca + v[1] * sa, c[2] + u[2] * ca + v[2] * sa];
  };
  for (let i = 0; i < segments; i++) {
    const a0 = ring(start, r0, i);
    const a1 = ring(start, r0, i + 1);
    const b0 = ring(end, r1, i);
    const b1 = ring(end, r1, i + 1);
    // the solid is convex: orient every face away from its centre
    pushOriented(out, a0, a1, b1, center);
    pushOriented(out, a0, b1, b0, center);
    pushOriented(out, start, a1, a0, center);
    pushOriented(out, end, b0, b1, center);
  }
  return out.done();
}

/** Closed tube (radius r) along a polyline, with flat end caps. */
export function tubeMesh(path: Vec3[], r: number, segments = 24): Tris {
  const out = new TriBuffer();
  if (path.length < 2) return out.done();
  // parallel-transported ring frames
  const tangents: Vec3[] = path.map((_, i) => normalize(sub(path[Math.min(i + 1, path.length - 1)], path[Math.max(i - 1, 0)])));
  let [u] = basis(tangents[0]);
  const rings: Vec3[][] = [];
  for (let i = 0; i < path.length; i++) {
    const t = tangents[i];
    // remove the tangent component from the previous u
    const d = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
    u = normalize([u[0] - d * t[0], u[1] - d * t[1], u[2] - d * t[2]]);
    const v = cross(t, u);
    const ring: Vec3[] = [];
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const ca = Math.cos(a) * r;
      const sa = Math.sin(a) * r;
      const c = path[i];
      ring.push([c[0] + u[0] * ca + v[0] * sa, c[1] + u[1] * ca + v[1] * sa, c[2] + u[2] * ca + v[2] * sa]);
    }
    rings.push(ring);
  }
  for (let i = 0; i < path.length - 1; i++) {
    const mid: Vec3 = [(path[i][0] + path[i + 1][0]) / 2, (path[i][1] + path[i + 1][1]) / 2, (path[i][2] + path[i + 1][2]) / 2];
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      pushOriented(out, rings[i][s], rings[i][s1], rings[i + 1][s1], mid);
      pushOriented(out, rings[i][s], rings[i + 1][s1], rings[i + 1][s], mid);
    }
  }
  // caps, oriented away from the tube body
  const capIn = (end: number, next: number): Vec3 => {
    const a = path[end];
    const b = path[next];
    return [a[0] + (b[0] - a[0]) * 0.01, a[1] + (b[1] - a[1]) * 0.01, a[2] + (b[2] - a[2]) * 0.01];
  };
  const last = path.length - 1;
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    pushOriented(out, path[0], rings[0][s], rings[0][s1], capIn(0, 1));
    pushOriented(out, path[last], rings[last][s], rings[last][s1], capIn(last, last - 1));
  }
  return out.done();
}

export function concatTris(parts: Tris[]): Tris {
  const out = new Float32Array(parts.reduce((a, t) => a + t.length, 0));
  let o = 0;
  for (const t of parts) {
    out.set(t, o);
    o += t.length;
  }
  return out;
}

/** Binary STL (little endian), facet normals from the vertex order. */
export function stlBytes(tris: Tris, name: string): Uint8Array {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const bytes = new Uint8Array(buf);
  const header = `Quick DICOM Planning - ${name}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    const ux = tris[b + 3] - tris[b], uy = tris[b + 4] - tris[b + 1], uz = tris[b + 5] - tris[b + 2];
    const vx = tris[b + 6] - tris[b], vy = tris[b + 7] - tris[b + 1], vz = tris[b + 8] - tris[b + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    dv.setFloat32(o, nx, true);
    dv.setFloat32(o + 4, ny, true);
    dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 9; k++, o += 4) dv.setFloat32(o, tris[b + k], true);
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return bytes;
}
