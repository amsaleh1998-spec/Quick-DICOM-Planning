// Library implants in the 2D views: the real cut of the mesh in a slice (filled, with its threads)
// and its silhouette in the panoramic. Generic implants keep their exact cone (View.ts / PlanViews.ts).

import type { App } from '../app';
import { IMPLANT_COLOR, IMPLANT_SELECTED_COLOR, Implant, platformOf } from '../implant';
import { LibMesh, meshOf, meshWorld } from '../implantLibrary';
import { Vec3, addScaled, cross, dot, normalize } from '../math';
import { meshPlaneSegments } from './scanContours';

/** Library implants whose mesh is loaded (the others are drawn as generic cones meanwhile). */
export function meshedImplants(app: App): { imp: Implant; m: LibMesh }[] {
  const out: { imp: Implant; m: LibMesh }[] = [];
  for (const imp of app.implants) {
    if (imp.hidden || !imp.lib) continue;
    const m = meshOf(imp.lib.id);
    if (m) out.push({ imp, m });
  }
  return out;
}
export const isMeshed = (imp: Implant) => !!imp.lib && !!meshOf(imp.lib.id);

const boxCache = new WeakMap<Float32Array, { min: Vec3; max: Vec3 }>();
function box(p: Float32Array) {
  let b = boxCache.get(p);
  if (!b) {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[i + k]);
        max[k] = Math.max(max[k], p[i + k]);
      }
    boxCache.set(p, (b = { min, max }));
  }
  return b;
}

/** Join cut segments (x0, y0, x1, y1 …) into closed loops. */
export function segmentLoops(seg: Float32Array): number[][] {
  const key = (x: number, y: number) => `${Math.round(x * 64)},${Math.round(y * 64)}`;
  const n = seg.length / 4;
  const at = new Map<string, number[]>();
  for (let i = 0; i < n; i++)
    for (const e of [0, 1]) {
      const k = key(seg[i * 4 + e * 2], seg[i * 4 + e * 2 + 1]);
      const l = at.get(k);
      if (l) l.push(i * 2 + e);
      else at.set(k, [i * 2 + e]);
    }
  const used = new Uint8Array(n);
  const loops: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const loop = [seg[s * 4], seg[s * 4 + 1], seg[s * 4 + 2], seg[s * 4 + 3]];
    let end = 1; // walk from the second end of segment s
    let cur = s;
    for (let guard = 0; guard < n; guard++) {
      const ex = seg[cur * 4 + end * 2], ey = seg[cur * 4 + end * 2 + 1];
      const next = at.get(key(ex, ey))?.find((q) => !used[q >> 1]);
      if (next === undefined) break;
      cur = next >> 1;
      used[cur] = 1;
      end = 1 - (next & 1);
      loop.push(seg[cur * 4 + end * 2], seg[cur * 4 + end * 2 + 1]);
    }
    loops.push(loop);
  }
  return loops;
}

const css = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Library implants cut by a planar slice: filled section with its outline. */
export function drawPlaneImplants(app: App, o: CanvasRenderingContext2D, center: Vec3, u: Vec3, v: Vec3, scale: number, w: number, h: number) {
  for (const { imp, m } of meshedImplants(app)) {
    const pos = meshWorld(imp, m, platformOf(imp), imp.axis);
    const seg = meshPlaneSegments(pos, m.idx, box(pos), center, u, v, scale, w, h);
    if (!seg.length) continue;
    const col = imp.id === app.selectedId ? IMPLANT_SELECTED_COLOR : IMPLANT_COLOR;
    o.beginPath();
    for (const l of segmentLoops(seg)) {
      o.moveTo(l[0], l[1]);
      for (let i = 2; i < l.length; i += 2) o.lineTo(l[i], l[i + 1]);
      o.closePath();
    }
    o.fillStyle = css(col, 0.32);
    o.fill('evenodd');
    o.lineWidth = 1.5;
    o.lineJoin = 'round';
    o.strokeStyle = css(col, 0.95);
    o.stroke();
  }
}

/**
 * Outline of a library implant seen across the panoramic: for every 0.15 mm along its axis, its
 * extent to either side (`side`: the direction across the axis in the panoramic). World points.
 */
export function silhouette(imp: Implant, m: LibMesh, side: Vec3): Vec3[] {
  const P = platformOf(imp);
  const pos = meshWorld(imp, m, P, imp.axis);
  const up: Vec3 = [-imp.axis[0], -imp.axis[1], -imp.axis[2]];
  const s = normalize(side);
  let h0 = Infinity, h1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const hh = (pos[i] - P[0]) * up[0] + (pos[i + 1] - P[1]) * up[1] + (pos[i + 2] - P[2]) * up[2];
    h0 = Math.min(h0, hh);
    h1 = Math.max(h1, hh);
  }
  const bin = 0.15;
  const nb = Math.max(1, Math.ceil((h1 - h0) / bin) + 1);
  const lo = new Float32Array(nb).fill(Infinity), hi = new Float32Array(nb).fill(-Infinity);
  for (let i = 0; i < pos.length; i += 3) {
    const dx = pos[i] - P[0], dy = pos[i + 1] - P[1], dz = pos[i + 2] - P[2];
    const k = Math.min(nb - 1, Math.round((dx * up[0] + dy * up[1] + dz * up[2] - h0) / bin));
    const e = dx * s[0] + dy * s[1] + dz * s[2];
    if (e < lo[k]) lo[k] = e;
    if (e > hi[k]) hi[k] = e;
  }
  const left: Vec3[] = [], right: Vec3[] = [];
  for (let k = 0; k < nb; k++) {
    if (lo[k] > hi[k]) continue;
    const c = addScaled(P, up, h0 + k * bin);
    left.push(addScaled(c, s, lo[k]));
    right.push(addScaled(c, s, hi[k]));
  }
  return [...left, ...right.reverse()];
}

/** Direction across an implant's axis, perpendicular to a viewing direction `into`. */
export const sideOf = (axis: Vec3, into: Vec3): Vec3 => {
  const c = cross(axis, into);
  return dot(c, c) < 1e-9 ? normalize(cross(axis, [0, 0, 1])) : normalize(c);
};
