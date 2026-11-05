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

/** Indexed triangle mesh: xyz per vertex, 3 vertex indices per triangle. */
export interface Mesh {
  pos: Float32Array;
  idx: Uint32Array;
}

class Growable<T extends Float32Array | Uint32Array> {
  data: T;
  n = 0;
  constructor(private make: (n: number) => T) {
    this.data = make(1 << 16);
  }
  push3(a: number, b: number, c: number) {
    if (this.n + 3 > this.data.length) {
      const bigger = this.make(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.n++] = a;
    this.data[this.n++] = b;
    this.data[this.n++] = c;
  }
  done(): T {
    return this.data.slice(0, this.n) as T;
  }
}

/**
 * Iso-surface s = 0 of the grid by marching tetrahedra, as an indexed mesh with outward-facing
 * triangles. Every grid edge crossed by the surface gets exactly one vertex, shared by all the
 * triangles around it, so the mesh is connected (needed for smoothing) and closed.
 */
export async function isoSurface(g: ScalarGrid, onProgress?: (f: number) => void): Promise<Mesh> {
  const { nx, ny, nz, s, origin, step } = g;
  const nxy = nx * ny;
  const pos = new Growable((n) => new Float32Array(n));
  const idx = new Growable((n) => new Uint32Array(n));
  let nVerts = 0;
  // Vertex ids of crossed edges, by the edge's lower sample and direction (bits x=1, y=2, z=4;
  // in Freudenthal cubes every edge runs in a positive direction from its lower corner).
  // In-plane directions 1,2,3 live in the plane of their lower sample, the others cross
  // from plane k to k+1. Two plane buffers are swapped as the sweep moves up.
  let planeLo = new Int32Array(nxy * 3).fill(-1);
  let planeHi = new Int32Array(nxy * 3).fill(-1);
  const crossE = new Int32Array(nxy * 4);
  const CROSS_SLOT = [-1, -1, -1, -1, 0, 1, 2, 3];
  const cs = new Float64Array(8);
  const corner = [0, 1, nx, nx + 1, nxy, nxy + 1, nxy + nx, nxy + nx + 1];
  let i = 0, j = 0, k = 0;
  const vertex = (ca: number, cb: number): number => {
    // make ca the lower corner (its bits are a subset of cb's)
    if ((ca & cb) !== ca) {
      const t = ca;
      ca = cb;
      cb = t;
    }
    const d = cb ^ ca;
    const ax = i + (ca & 1), ay = j + ((ca >> 1) & 1), az = k + ((ca >> 2) & 1);
    const inPlane = ax + ay * nx;
    let buf: Int32Array;
    let slot: number;
    if (d & 4) {
      buf = crossE;
      slot = inPlane * 4 + CROSS_SLOT[d];
    } else {
      buf = az === k ? planeLo : planeHi;
      slot = inPlane * 3 + (d - 1);
    }
    const have = buf[slot];
    if (have >= 0) return have;
    const sa = cs[ca];
    const sb = cs[cb];
    let t = 0.5;
    if (Number.isFinite(sa) && Number.isFinite(sb)) t = Math.min(1, Math.max(0, sa / (sa - sb)));
    const bx = ax + ((d & 1) ? 1 : 0), by = ay + ((d & 2) ? 1 : 0), bz = az + ((d & 4) ? 1 : 0);
    pos.push3(
      origin[0] + (ax + t * (bx - ax)) * step[0],
      origin[1] + (ay + t * (by - ay)) * step[1],
      origin[2] + (az + t * (bz - az)) * step[2],
    );
    buf[slot] = nVerts;
    return nVerts++;
  };
  // triangle (a, b, c) oriented so its normal points from the inside corners to the outside ones
  const P = pos;
  const tri = (a: number, b: number, c: number, rx: number, ry: number, rz: number) => {
    const d = P.data;
    const ux = d[b * 3] - d[a * 3], uy = d[b * 3 + 1] - d[a * 3 + 1], uz = d[b * 3 + 2] - d[a * 3 + 2];
    const vx = d[c * 3] - d[a * 3], vy = d[c * 3 + 1] - d[a * 3 + 1], vz = d[c * 3 + 2] - d[a * 3 + 2];
    const nX = uy * vz - uz * vy, nY = uz * vx - ux * vz, nZ = ux * vy - uy * vx;
    if (a === b || b === c || a === c) return;
    if (nX * rx + nY * ry + nZ * rz >= 0) idx.push3(a, b, c);
    else idx.push3(a, c, b);
  };
  const ins: number[] = [];
  const outs: number[] = [];
  let lastYield = performance.now();
  for (k = 0; k < nz - 1; k++) {
    crossE.fill(-1);
    for (j = 0; j < ny - 1; j++) {
      for (i = 0; i < nx - 1; i++) {
        const base = i + j * nx + k * nxy;
        let nIn = 0;
        for (let c = 0; c < 8; c++) {
          const v = s[base + corner[c]];
          cs[c] = v;
          if (v > 0) nIn++;
        }
        if (nIn === 0 || nIn === 8) continue;
        for (const tt of TETS) {
          ins.length = 0;
          outs.length = 0;
          for (const c of tt) (cs[c] > 0 ? ins : outs).push(c);
          if (ins.length === 0 || ins.length === 4) continue;
          // reference direction (grid units): from the inside corners towards the outside corners
          let rx = 0, ry = 0, rz = 0;
          for (const c of outs) (rx += (c & 1) / outs.length), (ry += ((c >> 1) & 1) / outs.length), (rz += ((c >> 2) & 1) / outs.length);
          for (const c of ins) (rx -= (c & 1) / ins.length), (ry -= ((c >> 1) & 1) / ins.length), (rz -= ((c >> 2) & 1) / ins.length);
          rx *= step[0];
          ry *= step[1];
          rz *= step[2];
          if (ins.length === 1) {
            tri(vertex(ins[0], outs[0]), vertex(ins[0], outs[1]), vertex(ins[0], outs[2]), rx, ry, rz);
          } else if (ins.length === 3) {
            tri(vertex(ins[0], outs[0]), vertex(ins[1], outs[0]), vertex(ins[2], outs[0]), rx, ry, rz);
          } else {
            // quad a-c, a-d, b-d, b-c
            const [a, b] = ins;
            const [c, d] = outs;
            const ac = vertex(a, c), ad = vertex(a, d), bd = vertex(b, d), bc = vertex(b, c);
            tri(ac, ad, bd, rx, ry, rz);
            tri(ac, bd, bc, rx, ry, rz);
          }
        }
      }
    }
    // the upper plane becomes the lower plane of the next layer
    const t = planeLo;
    planeLo = planeHi;
    planeHi = t;
    planeHi.fill(-1);
    if (performance.now() - lastYield > 60) {
      onProgress?.((k + 1) / (nz - 1));
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  onProgress?.(1);
  return { pos: pos.done(), idx: idx.done() };
}

/**
 * Taubin λ|μ smoothing (Laplacian smoothing that does not shrink the model): removes the voxel
 * staircase while keeping the size and shape of the bone.
 */
export async function smoothMesh(m: Mesh, iterations = 12, lambda = 0.5, mu = -0.53, onProgress?: (f: number) => void) {
  const nv = m.pos.length / 3;
  const idx = m.idx;
  // neighbour lists (CSR); each edge appears in two triangles, which just doubles its weight
  const deg = new Uint32Array(nv + 1);
  for (let t = 0; t < idx.length; t += 3) {
    deg[idx[t]] += 2;
    deg[idx[t + 1]] += 2;
    deg[idx[t + 2]] += 2;
  }
  const start = new Uint32Array(nv + 1);
  for (let v = 0; v < nv; v++) start[v + 1] = start[v] + deg[v];
  const nb = new Uint32Array(start[nv]);
  const fillPos = start.slice(0, nv);
  const add = (a: number, b: number) => (nb[fillPos[a]++] = b);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    add(a, b);
    add(a, c);
    add(b, a);
    add(b, c);
    add(c, a);
    add(c, b);
  }
  let p: Float32Array = m.pos;
  let q: Float32Array = new Float32Array(p.length);
  for (let it = 0; it < iterations; it++) {
    const f = it % 2 === 0 ? lambda : mu;
    for (let v = 0; v < nv; v++) {
      const s0 = start[v], s1 = start[v + 1];
      const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
      if (s1 === s0) {
        q[v * 3] = x;
        q[v * 3 + 1] = y;
        q[v * 3 + 2] = z;
        continue;
      }
      let ax = 0, ay = 0, az = 0;
      for (let e = s0; e < s1; e++) {
        const w = nb[e] * 3;
        ax += p[w];
        ay += p[w + 1];
        az += p[w + 2];
      }
      const inv = 1 / (s1 - s0);
      q[v * 3] = x + f * (ax * inv - x);
      q[v * 3 + 1] = y + f * (ay * inv - y);
      q[v * 3 + 2] = z + f * (az * inv - z);
    }
    const t = p;
    p = q;
    q = t;
    onProgress?.((it + 1) / iterations);
    await new Promise((r) => setTimeout(r, 0));
  }
  m.pos = p as Mesh['pos'];
}

/** Indexed mesh -> triangle soup. */
export function meshToTris(m: Mesh): Tris {
  const out = new Float32Array(m.idx.length * 3);
  for (let t = 0; t < m.idx.length; t++) {
    const v = m.idx[t] * 3;
    out[t * 3] = m.pos[v];
    out[t * 3 + 1] = m.pos[v + 1];
    out[t * 3 + 2] = m.pos[v + 2];
  }
  return out;
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
export function stlBytes(tris: Tris, name: string, space: 'LPS' | null = null): Uint8Array {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const bytes = new Uint8Array(buf);
  // "SPACE=LPS" tells 3D Slicer (and similar) which patient coordinate convention the file uses
  const header = `${space ? `SPACE=${space} ` : ''}Quick DICOM Planning - ${name}`.slice(0, 79);
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
