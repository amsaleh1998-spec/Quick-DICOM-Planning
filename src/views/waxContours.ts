// Outlines of the waxup teeth in the 2D views (where the crown surface crosses the slice, or the
// panoramic surface at the current offset), and picking a tooth by its outline.

import type { App } from '../app';
import type { ArchCurve } from '../curve';
import { distToSegment2, type Frame, type Vec3 } from '../math';
import { WaxTooth, toothKey, toothWorld } from '../waxup/waxup';
import { meshPlaneSegments, nearestGrid, strokeSegments } from './scanContours';

type Segs = Map<number, Float32Array>;
/** last outlines drawn per view (screen coordinates), for picking */
const drawn = new WeakMap<object, Segs>();
const planeCache = new WeakMap<object, Map<number, { key: string; seg: Float32Array }>>();

const SELECTED: [number, number, number] = [255, 190, 90];

function colorOf(app: App, t: WaxTooth): [number, number, number] {
  const w = app.wax;
  const jawSel = w.wholeJaw && w.selected !== null ? w.model.tooth(w.selected)?.jaw : null;
  if (t.fdi === w.selected || t.jaw === jawSel) return SELECTED;
  if (t.fdi === w.hover) return [255, 245, 225];
  return w.color;
}

function stroke(app: App, o: CanvasRenderingContext2D, t: WaxTooth, seg: Float32Array) {
  const sel = t.fdi === app.wax.selected;
  strokeSegments(o, seg, colorOf(app, t), sel ? 1 : 0.9);
  if (sel || t.fdi === app.wax.hover) strokeSegments(o, seg, colorOf(app, t), 1); // a little bolder
}

/** Draw the teeth crossing a planar slice. */
export function drawPlaneWax(owner: object, app: App, o: CanvasRenderingContext2D, center: Vec3, u: Vec3, v: Vec3, scale: number, w: number, h: number) {
  const out: Segs = new Map();
  drawn.set(owner, out);
  if (!app.wax.contours) return;
  let m = planeCache.get(owner);
  if (!m) planeCache.set(owner, (m = new Map()));
  for (const t of app.wax.shown()) {
    const key = JSON.stringify([center, u, v, scale, w, h]) + toothKey(t);
    let c = m.get(t.fdi);
    if (!c || c.key !== key) {
      const wd = toothWorld(t);
      c = { key, seg: meshPlaneSegments(wd.pos, t.idx, wd, center, u, v, scale, w, h) };
      m.set(t.fdi, c);
    }
    if (!c.seg.length) continue;
    out.set(t.fdi, c.seg);
    stroke(app, o, t, c.seg);
  }
}

// ---- panoramic ------------------------------------------------------------------------

const gridCache = new WeakMap<ArchCurve, ReturnType<typeof nearestGrid>>();
const panoCache = new WeakMap<WaxTooth, { key: string; s: Float32Array; c: Float32Array; off: Float32Array }>();

function panoCoords(t: WaxTooth, curve: ArchCurve, O: Vec3, F: Frame) {
  const key = JSON.stringify([curve.ctrl, O, F]) + toothKey(t);
  const c = panoCache.get(t);
  if (c && c.key === key) return c;
  let grid = gridCache.get(curve);
  if (!grid) gridCache.set(curve, (grid = nearestGrid(curve, 0.75, 20)));
  const pos = toothWorld(t).pos;
  const nv = pos.length / 3;
  const S = new Float32Array(nv), C = new Float32Array(nv), OFF = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    const qx = pos[i * 3] - O[0], qy = pos[i * 3 + 1] - O[1], qz = pos[i * 3 + 2] - O[2];
    const a = qx * F[0][0] + qy * F[0][1] + qz * F[0][2];
    const b = qx * F[1][0] + qy * F[1][1] + qz * F[1][2];
    C[i] = qx * F[2][0] + qy * F[2][1] + qz * F[2][2];
    const sv = grid.s(a, b);
    if (Number.isNaN(sv)) {
      S[i] = OFF[i] = NaN;
      continue;
    }
    const cp = curve.at(sv);
    S[i] = sv + (a - cp.p[0]) * cp.t[0] + (b - cp.p[1]) * cp.t[1];
    OFF[i] = (a - cp.p[0]) * cp.n[0] + (b - cp.p[1]) * cp.n[1];
  }
  const out = { key, s: S, c: C, off: OFF };
  panoCache.set(t, out);
  return out;
}

/** Draw the teeth crossing the panoramic surface at `offset`. */
export function drawPanoWax(owner: object, app: App, o: CanvasRenderingContext2D, curve: ArchCurve, offset: number, xOf: (s: number) => number, yOf: (c: number) => number) {
  const out: Segs = new Map();
  drawn.set(owner, out);
  if (!app.wax.contours) return;
  for (const t of app.wax.shown()) {
    const { s: S, c: C, off: OFF } = panoCoords(t, curve, app.O, app.frame);
    const idx = t.idx;
    const seg: number[] = [];
    const pt = (a: number, b: number) => {
      const da = OFF[a] - offset, db = OFF[b] - offset;
      const f = da / (da - db);
      seg.push(xOf(S[a] + (S[b] - S[a]) * f), yOf(C[a] + (C[b] - C[a]) * f));
    };
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      if (Number.isNaN(S[a] + S[b] + S[c])) continue;
      const sa = OFF[a] > offset, sb = OFF[b] > offset, sc = OFF[c] > offset;
      if (sa === sb && sb === sc) continue;
      if (sa === sb) {
        pt(c, a);
        pt(c, b);
      } else if (sa === sc) {
        pt(b, a);
        pt(b, c);
      } else {
        pt(a, b);
        pt(a, c);
      }
    }
    if (!seg.length) continue;
    const f = Float32Array.from(seg);
    out.set(t.fdi, f);
    stroke(app, o, t, f);
  }
}

/** Tooth whose outline (as last drawn in this view) contains the screen point, or passes within `tol` px. */
export function waxAt(owner: object, p: [number, number], tol = 6): number | null {
  const m = drawn.get(owner);
  if (!m) return null;
  let near: { fdi: number; d: number } | null = null;
  for (const [fdi, seg] of m) {
    let inside = false;
    for (let i = 0; i < seg.length; i += 4) {
      const y0 = seg[i + 1], y1 = seg[i + 3];
      if (y0 > p[1] === y1 > p[1]) continue;
      const x = seg[i] + ((p[1] - y0) / (y1 - y0)) * (seg[i + 2] - seg[i]);
      if (x > p[0]) inside = !inside;
    }
    if (inside) return fdi;
    for (let i = 0; i < seg.length; i += 4) {
      const d = Math.sqrt(distToSegment2(p[0], p[1], seg[i], seg[i + 1], seg[i + 2], seg[i + 3]));
      if (d <= tol && (!near || d < near.d)) near = { fdi, d };
    }
  }
  return near?.fdi ?? null;
}
