// Shaping waxup teeth (library coordinates of the tooth): freeform brush (add / remove material,
// smooth) and moving anatomic parts (cusps, incisal edge) with a smooth falloff.

import type { Vec3 } from '../math';
import { vertexNormals } from '../meshio';

/** Smooth falloff: 1 at the centre, 0 at the radius. */
export const falloff = (d: number, r: number) => {
  if (d >= r) return 0;
  const x = d / r;
  return (1 - x * x) * (1 - x * x);
};

/** Neighbouring vertices of every vertex (compressed rows). */
export interface Adjacency {
  start: Uint32Array;
  nb: Uint32Array;
}
const adjCache = new WeakMap<Uint32Array, Adjacency>();
export function adjacency(nv: number, idx: Uint32Array): Adjacency {
  const c = adjCache.get(idx);
  if (c && c.start.length === nv + 1) return c;
  const sets: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], cc = idx[t + 2];
    sets[a].push(b, cc);
    sets[b].push(a, cc);
    sets[cc].push(a, b);
  }
  const start = new Uint32Array(nv + 1);
  const all: number[] = [];
  for (let i = 0; i < nv; i++) {
    start[i] = all.length;
    for (const j of new Set(sets[i])) all.push(j);
  }
  start[nv] = all.length;
  const out = { start, nb: Uint32Array.from(all) };
  adjCache.set(idx, out);
  return out;
}

export type BrushMode = 'add' | 'remove' | 'smooth';

/**
 * One brush dab at `c` (library coordinates): add or remove material along the surface normals
 * (`amount` mm at the centre) or smooth (`amount` 0..1). Returns the number of vertices changed.
 */
export function brush(pos: Float32Array, idx: Uint32Array, c: Vec3, radius: number, amount: number, mode: BrushMode): number {
  const nv = pos.length / 3;
  const hit: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < nv; i++) {
    const dx = pos[i * 3] - c[0], dy = pos[i * 3 + 1] - c[1], dz = pos[i * 3 + 2] - c[2];
    const f = falloff(Math.sqrt(dx * dx + dy * dy + dz * dz), radius);
    if (f > 0) {
      hit.push(i);
      w.push(f);
    }
  }
  if (!hit.length) return 0;
  if (mode === 'smooth') {
    const adj = adjacency(nv, idx);
    const next = new Float32Array(hit.length * 3);
    hit.forEach((i, k) => {
      let sx = 0, sy = 0, sz = 0;
      const a = adj.start[i], b = adj.start[i + 1];
      for (let j = a; j < b; j++) {
        const n = adj.nb[j];
        sx += pos[n * 3];
        sy += pos[n * 3 + 1];
        sz += pos[n * 3 + 2];
      }
      const cnt = Math.max(1, b - a);
      const f = Math.min(1, amount * w[k]);
      next[k * 3] = pos[i * 3] + (sx / cnt - pos[i * 3]) * f;
      next[k * 3 + 1] = pos[i * 3 + 1] + (sy / cnt - pos[i * 3 + 1]) * f;
      next[k * 3 + 2] = pos[i * 3 + 2] + (sz / cnt - pos[i * 3 + 2]) * f;
    });
    hit.forEach((i, k) => {
      pos[i * 3] = next[k * 3];
      pos[i * 3 + 1] = next[k * 3 + 1];
      pos[i * 3 + 2] = next[k * 3 + 2];
    });
    return hit.length;
  }
  const nrm = vertexNormals(pos, idx);
  const sign = mode === 'add' ? 1 : -1;
  hit.forEach((i, k) => {
    const d = sign * amount * w[k];
    pos[i * 3] += nrm[i * 3] * d;
    pos[i * 3 + 1] += nrm[i * 3 + 1] * d;
    pos[i * 3 + 2] += nrm[i * 3 + 2] * d;
  });
  return hit.length;
}

/** A tooth part being moved: the vertices it drags, their weights and start positions. */
export interface PartDrag {
  tip: Vec3;
  idx: Uint32Array;
  w: Float32Array;
  start: Float32Array;
}

export function startPart(pos: Float32Array, tip: Vec3, radius: number): PartDrag {
  const ids: number[] = [];
  const ws: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) {
    const d = Math.hypot(pos[i * 3] - tip[0], pos[i * 3 + 1] - tip[1], pos[i * 3 + 2] - tip[2]);
    const f = falloff(d, radius);
    if (f > 0) {
      ids.push(i);
      ws.push(f);
    }
  }
  const idx = Uint32Array.from(ids);
  const start = new Float32Array(ids.length * 3);
  ids.forEach((i, k) => start.set(pos.subarray(i * 3, i * 3 + 3), k * 3));
  return { tip: [...tip] as Vec3, idx, w: Float32Array.from(ws), start };
}

/**
 * Deform a part from its start shape: move by `d`, scale by `s` about the tip, turn by `angle`
 * about `axis` through the tip – each vertex by its weight (all library coordinates).
 */
export function applyPart(pos: Float32Array, pd: PartDrag, d: Vec3, s: number, axis: Vec3, angle: number) {
  const [ax, ay, az] = axis;
  const al = Math.hypot(ax, ay, az) || 1;
  const ux = ax / al, uy = ay / al, uz = az / al;
  const t = pd.tip;
  for (let k = 0; k < pd.idx.length; k++) {
    const w = pd.w[k];
    let x = pd.start[k * 3] - t[0], y = pd.start[k * 3 + 1] - t[1], z = pd.start[k * 3 + 2] - t[2];
    // scale
    const f = 1 + (s - 1) * w;
    x *= f;
    y *= f;
    z *= f;
    // rotate (Rodrigues) by the weighted angle
    const a = angle * w;
    if (a !== 0) {
      const co = Math.cos(a), si = Math.sin(a);
      const dt = ux * x + uy * y + uz * z;
      const cx = uy * z - uz * y, cy = uz * x - ux * z, cz = ux * y - uy * x;
      x = x * co + cx * si + ux * dt * (1 - co);
      y = y * co + cy * si + uy * dt * (1 - co);
      z = z * co + cz * si + uz * dt * (1 - co);
    }
    const i = pd.idx[k];
    pos[i * 3] = t[0] + x + d[0] * w;
    pos[i * 3 + 1] = t[1] + y + d[1] * w;
    pos[i * 3 + 2] = t[2] + z + d[2] * w;
  }
}
