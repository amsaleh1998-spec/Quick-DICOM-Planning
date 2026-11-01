import { Vec2 } from './math';

export interface CurvePoint {
  /** position in the planning frame (a, b) – mm */
  p: Vec2;
  /** unit tangent */
  t: Vec2;
  /** unit normal pointing buccally (outwards of the arch) */
  n: Vec2;
}

/**
 * Panoramic curve: Catmull-Rom spline through control points in the axial
 * plane of the planning frame, parametrised by arc length.
 */
export class ArchCurve {
  readonly ctrl: Vec2[];
  private xs: Float64Array;
  private ys: Float64Array;
  private cum: Float64Array;
  readonly length: number;

  constructor(ctrl: Vec2[]) {
    this.ctrl = ctrl.map((p) => [p[0], p[1]] as Vec2);
    const pts = sampleCatmullRom(this.ctrl, 24);
    this.xs = new Float64Array(pts.length);
    this.ys = new Float64Array(pts.length);
    this.cum = new Float64Array(pts.length);
    let L = 0;
    for (let i = 0; i < pts.length; i++) {
      this.xs[i] = pts[i][0];
      this.ys[i] = pts[i][1];
      if (i > 0) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      this.cum[i] = L;
    }
    this.length = L;
  }

  /** Dense polyline for drawing. */
  polyline(): Vec2[] {
    const out: Vec2[] = [];
    for (let i = 0; i < this.xs.length; i++) out.push([this.xs[i], this.ys[i]]);
    return out;
  }

  position(s: number): Vec2 {
    const n = this.cum.length;
    if (n === 1) return [this.xs[0], this.ys[0]];
    const c = this.cum;
    if (s <= 0) {
      // extrapolate along first segment
      const t = this.dir(0);
      return [this.xs[0] + t[0] * s, this.ys[0] + t[1] * s];
    }
    if (s >= this.length) {
      const t = this.dir(n - 2);
      return [this.xs[n - 1] + t[0] * (s - this.length), this.ys[n - 1] + t[1] * (s - this.length)];
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (c[m] <= s) lo = m;
      else hi = m;
    }
    const seg = c[hi] - c[lo];
    const f = seg > 0 ? (s - c[lo]) / seg : 0;
    return [this.xs[lo] + (this.xs[hi] - this.xs[lo]) * f, this.ys[lo] + (this.ys[hi] - this.ys[lo]) * f];
  }

  private dir(i: number): Vec2 {
    const dx = this.xs[i + 1] - this.xs[i];
    const dy = this.ys[i + 1] - this.ys[i];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }

  /** Point, tangent and buccal normal at arc length s (tangent smoothed over ±0.75 mm). */
  at(s: number): CurvePoint {
    const p = this.position(s);
    const h = 0.75;
    const a = this.position(s - h);
    const b = this.position(s + h);
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    // n = t x z  (z = superior) -> (ty, -tx): points anterior/buccal for a
    // curve running from patient right to patient left.
    return { p, t: [tx, ty], n: [ty, -tx] };
  }

  /** Nearest arc-length parameter to a point. */
  nearest(x: number, y: number): { s: number; dist: number } {
    let best = Infinity;
    let bs = 0;
    for (let i = 0; i < this.xs.length - 1; i++) {
      const ax = this.xs[i];
      const ay = this.ys[i];
      const dx = this.xs[i + 1] - ax;
      const dy = this.ys[i + 1] - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d < best) {
        best = d;
        bs = this.cum[i] + t * (this.cum[i + 1] - this.cum[i]);
      }
    }
    return { s: bs, dist: best };
  }
}

function sampleCatmullRom(pts: Vec2[], per: number): Vec2[] {
  if (pts.length < 2) return pts.slice();
  const out: Vec2[] = [];
  const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = i === 0 ? reflect(pts[1], pts[0]) : P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = i + 2 >= pts.length ? reflect(pts[pts.length - 2], pts[pts.length - 1]) : P(i + 2);
    // centripetal parametrisation avoids loops/cusps
    const t0 = 0;
    const knot = (a: Vec2, b: Vec2) => Math.max(1e-3, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5));
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let k = 0; k < per; k++) {
      const t = t1 + ((t2 - t1) * k) / per;
      out.push(cr(p0, p1, p2, p3, t0, t1, t2, t3, t));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function reflect(a: Vec2, about: Vec2): Vec2 {
  return [2 * about[0] - a[0], 2 * about[1] - a[1]];
}

function cr(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t0: number, t1: number, t2: number, t3: number, t: number): Vec2 {
  const lerp = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => {
    const d = tb - ta || 1e-6;
    return [((tb - t) / d) * a[0] + ((t - ta) / d) * b[0], ((tb - t) / d) * a[1] + ((t - ta) / d) * b[1]];
  };
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}
