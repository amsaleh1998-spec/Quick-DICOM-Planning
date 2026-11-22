// Editing triangle meshes (the dual scan denture, intraoral scans): connected parts, keeping /
// deleting triangles, trimming with a screen lasso, finding and closing holes, cut and smooth brushes.
// Every operation returns a new mesh – meshes are never changed in place (undo keeps them).

import type { MeshData } from './meshio';
import type { Vec3 } from './math';

/** Connected parts (triangles sharing a vertex): part per triangle, triangle count per part. */
export function components(m: MeshData): { part: Int32Array; sizes: number[] } {
  const nv = m.pos.length / 3;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (a: number) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const unite = (a: number, b: number) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  const idx = m.idx;
  for (let t = 0; t < idx.length; t += 3) {
    unite(idx[t], idx[t + 1]);
    unite(idx[t], idx[t + 2]);
  }
  const label = new Int32Array(nv).fill(-1);
  const part = new Int32Array(idx.length / 3);
  const sizes: number[] = [];
  for (let t = 0; t < part.length; t++) {
    const r = find(idx[t * 3]);
    if (label[r] < 0) {
      label[r] = sizes.length;
      sizes.push(0);
    }
    part[t] = label[r];
    sizes[label[r]]++;
  }
  return { part, sizes };
}

/** The mesh with only the triangles where keep(t) is true (unused vertices dropped). */
export function keepTriangles(m: MeshData, keep: (t: number) => boolean): MeshData {
  const nt = m.idx.length / 3;
  const remap = new Int32Array(m.pos.length / 3).fill(-1);
  const idx: number[] = [];
  let nv = 0;
  for (let t = 0; t < nt; t++) {
    if (!keep(t)) continue;
    for (let k = 0; k < 3; k++) {
      const v = m.idx[t * 3 + k];
      if (remap[v] < 0) remap[v] = nv++;
      idx.push(remap[v]);
    }
  }
  const pos = new Float32Array(nv * 3);
  const col = m.col ? new Uint8Array(nv * 3) : null;
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v];
    if (r < 0) continue;
    pos[r * 3] = m.pos[v * 3];
    pos[r * 3 + 1] = m.pos[v * 3 + 1];
    pos[r * 3 + 2] = m.pos[v * 3 + 2];
    if (col) {
      col[r * 3] = m.col![v * 3];
      col[r * 3 + 1] = m.col![v * 3 + 1];
      col[r * 3 + 2] = m.col![v * 3 + 2];
    }
  }
  return { pos, idx: Uint32Array.from(idx), col };
}

/** Is the point inside the polygon (even–odd rule)? */
export function inPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Trim: the triangles whose centre lies inside the screen polygon (via `screen`, null = behind
 * the camera) – and, when `visible` is given, can be seen there – are removed.
 */
export function trimLasso(m: MeshData, poly: [number, number][], screen: (p: Vec3) => [number, number] | null, visible?: (p: Vec3, s: [number, number]) => boolean): MeshData {
  if (poly.length < 3) return m;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const { pos, idx } = m;
  return keepTriangles(m, (t) => {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const p: Vec3 = [(pos[a] + pos[b] + pos[c]) / 3, (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3];
    const s = screen(p);
    if (!s || s[0] < x0 || s[0] > x1 || s[1] < y0 || s[1] > y1 || !inPolygon(s[0], s[1], poly)) return true;
    return visible ? !visible(p, s) : false;
  });
}

/**
 * Holes: loops of edges used by one triangle only, as vertex lists in the order a cap closing
 * the hole runs (so the cap faces the same way as the surface around it).
 */
export function boundaryLoops(m: MeshData): number[][] {
  const idx = m.idx;
  const count = new Map<number, number>();
  const nv = m.pos.length / 3;
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  for (let t = 0; t < idx.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const e = key(idx[t + k], idx[t + ((k + 1) % 3)]);
      count.set(e, (count.get(e) ?? 0) + 1);
    }
  // boundary edges a -> b (triangle winding); the cap runs b -> a
  const next = new Map<number, number[]>();
  for (let t = 0; t < idx.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k], b = idx[t + ((k + 1) % 3)];
      if (count.get(key(a, b)) !== 1) continue;
      const l = next.get(b);
      if (l) l.push(a);
      else next.set(b, [a]);
    }
  const loops: number[][] = [];
  for (const start of [...next.keys()]) {
    while (next.get(start)?.length) {
      const loop = [start];
      let v = next.get(start)!.pop()!;
      let guard = 0;
      while (v !== start && guard++ < 1e6) {
        const l = next.get(v);
        if (!l?.length) break; // open chain (non-manifold): give up on it
        loop.push(v);
        v = l.pop()!;
      }
      if (v === start) loops.push(...simpleLoops(loop));
    }
  }
  return loops;
}

/** A loop that passes a vertex twice (holes touching at a corner) as simple loops. */
function simpleLoops(loop: number[]): number[][] {
  const out: number[][] = [];
  const stack: number[] = [];
  const at = new Map<number, number>();
  for (const v of loop) {
    const i = at.get(v);
    if (i !== undefined) {
      // v ... (back to v): a loop of its own
      const sub = stack.splice(i + 1);
      for (const w of sub) at.delete(w);
      if (sub.length >= 2) out.push([v, ...sub]);
      continue;
    }
    at.set(v, stack.length);
    stack.push(v);
  }
  if (stack.length >= 3) out.push(stack);
  return out;
}

/** Length of a loop (mm). */
export function loopLength(m: MeshData, loop: number[]): number {
  let L = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
    L += Math.hypot(m.pos[a] - m.pos[b], m.pos[a + 1] - m.pos[b + 1], m.pos[a + 2] - m.pos[b + 2]);
  }
  return L;
}

/** Triangles closing one hole (ear clipping, smallest angle first, in the hole's best plane). */
function capLoop(pos: Float32Array, loop: number[]): number[] {
  const n = loop.length;
  const P = (i: number): Vec3 => [pos[loop[i] * 3], pos[loop[i] * 3 + 1], pos[loop[i] * 3 + 2]];
  // Newell normal of the loop, and a basis of its plane
  const N: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = P(i), b = P((i + 1) % n);
    N[0] += (a[1] - b[1]) * (a[2] + b[2]);
    N[1] += (a[2] - b[2]) * (a[0] + b[0]);
    N[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const nl = Math.hypot(N[0], N[1], N[2]) || 1;
  N[0] /= nl;
  N[1] /= nl;
  N[2] /= nl;
  const h: Vec3 = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u: Vec3 = [N[1] * h[2] - N[2] * h[1], N[2] * h[0] - N[0] * h[2], N[0] * h[1] - N[1] * h[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u[0] /= ul;
  u[1] /= ul;
  u[2] /= ul;
  const v: Vec3 = [N[1] * u[2] - N[2] * u[1], N[2] * u[0] - N[0] * u[2], N[0] * u[1] - N[1] * u[0]];
  const xy = loop.map((_, i) => {
    const p = P(i);
    return [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]] as [number, number];
  });
  const ring = loop.map((_, i) => i);
  const tris: number[] = [];
  const cross2 = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  const inTri = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]) => {
    const d1 = cross2(a, b, p), d2 = cross2(b, c, p), d3 = cross2(c, a, p);
    return d1 > 0 && d2 > 0 && d3 > 0;
  };
  const angle = (i: number) => {
    const m = ring.length;
    const a = P(ring[(i + m - 1) % m]), b = P(ring[i]), c = P(ring[(i + 1) % m]);
    const e1: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], e2: Vec3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const d = (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / (Math.hypot(...e1) * Math.hypot(...e2) || 1);
    return Math.acos(Math.max(-1, Math.min(1, d)));
  };
  while (ring.length > 3) {
    const m = ring.length;
    let best = -1, bestA = Infinity, fallback = -1, fallbackA = Infinity;
    for (let i = 0; i < m; i++) {
      const ia = ring[(i + m - 1) % m], ib = ring[i], ic = ring[(i + 1) % m];
      const a = angle(i);
      if (a < fallbackA) {
        fallbackA = a;
        fallback = i;
      }
      if (cross2(xy[ia], xy[ib], xy[ic]) <= 0 || a >= bestA) continue; // reflex in the plane
      let ear = true;
      for (const j of ring)
        if (j !== ia && j !== ib && j !== ic && inTri(xy[j], xy[ia], xy[ib], xy[ic])) {
          ear = false;
          break;
        }
      if (ear) {
        best = i;
        bestA = a;
      }
    }
    const i = best >= 0 ? best : fallback; // a twisted loop: clip the sharpest corner anyway
    tris.push(loop[ring[(i + m - 1) % m]], loop[ring[i]], loop[ring[(i + 1) % m]]);
    ring.splice(i, 1);
  }
  tris.push(loop[ring[0]], loop[ring[1]], loop[ring[2]]);
  return tris;
}

/** Close holes (all of them, or the loops given). */
export function fillHoles(m: MeshData, loops = boundaryLoops(m)): MeshData {
  if (!loops.length) return m;
  const extra: number[] = [];
  for (const loop of loops) extra.push(...capLoop(m.pos, loop));
  const idx = new Uint32Array(m.idx.length + extra.length);
  idx.set(m.idx);
  idx.set(extra, m.idx.length);
  return { pos: m.pos, idx, col: m.col };
}

/** Part of the triangle nearest to a point (by triangle centre). */
export function partNear(m: MeshData, part: Int32Array, p: Vec3): number {
  const { pos, idx } = m;
  let best = -1, bd = Infinity;
  for (let t = 0; t < part.length; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const dx = (pos[a] + pos[b] + pos[c]) / 3 - p[0], dy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3 - p[1], dz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3 - p[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) {
      bd = d;
      best = part[t];
    }
  }
  return best;
}

/** Cut brush: the triangles touching any of the brush spheres (centres `pts`, radius r) removed. */
export function brushCut(m: MeshData, pts: Vec3[], r: number): MeshData {
  const { pos, idx } = m;
  const nv = pos.length / 3;
  const hit = new Uint8Array(nv);
  const r2 = r * r;
  let any = false;
  for (const p of pts) {
    for (let v = 0; v < nv; v++) {
      if (hit[v]) continue;
      const dx = pos[v * 3] - p[0], dy = pos[v * 3 + 1] - p[1], dz = pos[v * 3 + 2] - p[2];
      if (dx * dx + dy * dy + dz * dz <= r2) {
        hit[v] = 1;
        any = true;
      }
    }
  }
  if (!any) return m;
  return keepTriangles(m, (t) => !hit[idx[t * 3]] && !hit[idx[t * 3 + 1]] && !hit[idx[t * 3 + 2]]);
}

/** Neighbouring vertices of every vertex (compressed rows). */
export function neighbours(m: MeshData): { start: Uint32Array; nb: Uint32Array } {
  const nv = m.pos.length / 3;
  const idx = m.idx;
  const deg = new Uint32Array(nv + 1);
  for (let t = 0; t < idx.length; t++) deg[idx[t]] += 2;
  const start = new Uint32Array(nv + 1);
  for (let v = 0; v < nv; v++) start[v + 1] = start[v] + deg[v];
  const fill = start.slice(0, nv);
  const nb = new Uint32Array(start[nv]);
  for (let t = 0; t < idx.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k];
      nb[fill[a]++] = idx[t + ((k + 1) % 3)];
      nb[fill[a]++] = idx[t + ((k + 2) % 3)];
    }
  return { start, nb };
}

/**
 * Smooth brush, one dab: the surface within r of p smoothed (Taubin steps – no shrinking), most
 * in the middle of the brush. Changes `pos` in place.
 */
export function smoothAt(pos: Float32Array, nbrs: { start: Uint32Array; nb: Uint32Array }, p: Vec3, r: number, iterations = 10) {
  const nv = pos.length / 3;
  const verts: number[] = [], wts: number[] = [];
  const r2 = r * r;
  for (let v = 0; v < nv; v++) {
    const dx = pos[v * 3] - p[0], dy = pos[v * 3 + 1] - p[1], dz = pos[v * 3 + 2] - p[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    verts.push(v);
    wts.push((1 - d2 / r2) ** 2);
  }
  if (!verts.length) return;
  const tmp = new Float32Array(verts.length * 3);
  const { start, nb } = nbrs;
  const step = (f: number) => {
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const s = start[v], e = start[v + 1];
      if (e === s) {
        tmp[i * 3] = pos[v * 3];
        tmp[i * 3 + 1] = pos[v * 3 + 1];
        tmp[i * 3 + 2] = pos[v * 3 + 2];
        continue;
      }
      let ax = 0, ay = 0, az = 0;
      for (let j = s; j < e; j++) {
        const u = nb[j] * 3;
        ax += pos[u];
        ay += pos[u + 1];
        az += pos[u + 2];
      }
      const n = e - s, w = f * wts[i];
      tmp[i * 3] = pos[v * 3] + w * (ax / n - pos[v * 3]);
      tmp[i * 3 + 1] = pos[v * 3 + 1] + w * (ay / n - pos[v * 3 + 1]);
      tmp[i * 3 + 2] = pos[v * 3 + 2] + w * (az / n - pos[v * 3 + 2]);
    }
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i] * 3;
      pos[v] = tmp[i * 3];
      pos[v + 1] = tmp[i * 3 + 1];
      pos[v + 2] = tmp[i * 3 + 2];
    }
  };
  for (let it = 0; it < iterations; it++) {
    step(0.6);
    step(-0.63);
  }
}

/** Smooth brush stroke: a smoothed copy (dabs at `pts`). */
export function brushSmooth(m: MeshData, pts: Vec3[], r: number, iterations = 10): MeshData {
  const pos = new Float32Array(m.pos);
  const nbrs = neighbours(m);
  for (const p of pts) smoothAt(pos, nbrs, p, r, iterations);
  return { pos, idx: m.idx, col: m.col };
}
