import { Implant, apexOf, implantRadiusAt, platformOf } from './implant';
import { Vec3, addScaled, clamp, dot, length, sub } from './math';

/** Traced nerve canal (inferior alveolar nerve): a tube through clicked points. */
export interface Nerve {
  id: number;
  name: string;
  side: 'right' | 'left';
  /** control points (world mm), ordered along the canal */
  pts: Vec3[];
  diameter: number;
  visible: boolean;
}

export const NERVE_COLOR: [number, number, number] = [255, 214, 10];
export const NERVE_DEFAULT_DIAMETER = 2.5;
/** implants closer than this to the nerve surface are flagged */
export const NERVE_SAFETY_MM = 2;

let nextNerveId = 1;

export function reserveNerveIds(maxId: number) {
  nextNerveId = Math.max(nextNerveId, maxId + 1);
}

export function createNerve(side: 'right' | 'left'): Nerve {
  return {
    id: nextNerveId++,
    name: side === 'right' ? 'Right IAN' : 'Left IAN',
    side,
    pts: [],
    diameter: NERVE_DEFAULT_DIAMETER,
    visible: true,
  };
}

/**
 * Insert a new control point where it lengthens the path the least, so points
 * can be clicked in any order (e.g. scrolling back and forth through the
 * cross-sections). Returns the index of the new point.
 */
export function insertNervePoint(pts: Vec3[], p: Vec3): number {
  if (pts.length < 2) {
    pts.push(p);
    return pts.length - 1;
  }
  const d = (a: Vec3, b: Vec3) => length(sub(a, b));
  let best = 0;
  let bestCost = d(p, pts[0]); // before the first point
  const endCost = d(p, pts[pts.length - 1]);
  if (endCost < bestCost) {
    best = pts.length;
    bestCost = endCost;
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const cost = d(pts[i], p) + d(p, pts[i + 1]) - d(pts[i], pts[i + 1]);
    if (cost < bestCost) {
      bestCost = cost;
      best = i + 1;
    }
  }
  pts.splice(best, 0, p);
  return best;
}

const pathCache = new Map<number, { key: string; path: Vec3[] }>();

/** Smooth centre line (centripetal Catmull-Rom) sampled about every 0.5 mm. */
export function nervePath(n: Nerve): Vec3[] {
  const key = JSON.stringify(n.pts);
  const c = pathCache.get(n.id);
  if (c && c.key === key) return c.path;
  const path = sampleCatmullRom3(n.pts, 0.5);
  pathCache.set(n.id, { key, path });
  return path;
}

export function nerveLength(n: Nerve): number {
  const p = nervePath(n);
  let L = 0;
  for (let i = 1; i < p.length; i++) L += length(sub(p[i], p[i - 1]));
  return L;
}

function sampleCatmullRom3(pts: Vec3[], step: number): Vec3[] {
  if (pts.length < 2) return pts.slice();
  const out: Vec3[] = [];
  const reflect = (a: Vec3, about: Vec3): Vec3 => [2 * about[0] - a[0], 2 * about[1] - a[1], 2 * about[2] - a[2]];
  const knot = (a: Vec3, b: Vec3) => Math.max(1e-3, Math.sqrt(length(sub(b, a))));
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = i === 0 ? reflect(pts[1], pts[0]) : pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = i + 2 >= pts.length ? reflect(pts[pts.length - 2], pts[pts.length - 1]) : pts[i + 2];
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const per = Math.max(1, Math.ceil(length(sub(p2, p1)) / step));
    for (let k = 0; k < per; k++) out.push(cr3(p0, p1, p2, p3, t1, t2, t3, t1 + ((t2 - t1) * k) / per));
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function cr3(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t1: number, t2: number, t3: number, t: number): Vec3 {
  const lerp = (a: Vec3, b: Vec3, ta: number, tb: number): Vec3 => {
    const d = tb - ta || 1e-6;
    const wa = (tb - t) / d;
    const wb = (t - ta) / d;
    return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]];
  };
  const a1 = lerp(p0, p1, 0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, 0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/** Closest points between segments p1-q1 and p2-q2: parameters (s, t) in [0,1]. */
function closestSegSeg(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): [number, number] {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  if (a < 1e-12 && e < 1e-12) return [0, 0];
  if (a < 1e-12) return [0, clamp(f / e, 0, 1)];
  const c = dot(d1, r);
  if (e < 1e-12) return [clamp(-c / a, 0, 1), 0];
  const b = dot(d1, d2);
  const den = a * e - b * b;
  let s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
  let t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = clamp(-c / a, 0, 1);
  } else if (t > 1) {
    t = 1;
    s = clamp((b - c) / a, 0, 1);
  }
  return [s, t];
}

/**
 * Signed distance (mm) from point p to the implant body: a truncated cone with flat platform and
 * apex faces (negative inside).
 */
function implantPointDistance(imp: Implant, p: Vec3): number {
  const P = platformOf(imp);
  const L = imp.length;
  const v = sub(p, P);
  const h = dot(v, imp.axis);
  const rho = length(addScaled(v, imp.axis, -h));
  const r0 = implantRadiusAt(imp, -L / 2);
  const r1 = implantRadiusAt(imp, L / 2);
  // profile in (h, rho): platform face (0,0)–(0,r0), side (0,r0)–(L,r1), apex face (L,r1)–(L,0)
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay;
    const t = clamp(((h - ax) * dx + (rho - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return Math.hypot(h - ax - t * dx, rho - ay - t * dy);
  };
  const d = Math.min(seg(0, 0, 0, r0), seg(0, r0, L, r1), seg(L, r1, L, 0));
  const inside = h >= 0 && h <= L && rho <= r0 + ((r1 - r0) * h) / L;
  return inside ? -d : d;
}

/** Shortest distance (mm) between the implant body surface and the nerve canal surface (negative: they overlap). */
export function implantNerveDistance(imp: Implant, n: Nerve): number {
  const path = nervePath(n);
  if (path.length < 2) return Infinity;
  const P = platformOf(imp);
  const A = apexOf(imp);
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], d = sub(path[i + 1], a);
    // along the segment every 0.1 mm, and where it passes closest to the implant axis
    const steps = Math.max(1, Math.ceil(length(d) / 0.1));
    for (let k = 0; k <= steps; k++) best = Math.min(best, implantPointDistance(imp, addScaled(a, d, k / steps)));
    best = Math.min(best, implantPointDistance(imp, addScaled(a, d, closestSegSeg(P, A, a, path[i + 1])[1])));
  }
  return best - n.diameter / 2;
}
