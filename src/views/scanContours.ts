// Outlines of the intraoral scans in the 2D views: where the scan surface crosses the slice
// (planar views) or the panoramic surface at the current offset.

import type { App } from '../app';
import type { ArchCurve } from '../curve';
import { Frame, Vec3 } from '../math';
import { Scan, scanWorld } from '../scans';

interface Bounds {
  key: string;
  min: Vec3;
  max: Vec3;
}
const boundsCache = new WeakMap<Scan, Bounds>();

function bounds(s: Scan, pos: Float32Array): Bounds {
  const key = s.transform!.join(',');
  const c = boundsCache.get(s);
  if (c && c.key === key) return c;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < min[k]) min[k] = pos[i + k];
      if (pos[i + k] > max[k]) max[k] = pos[i + k];
    }
  const b = { key, min, max };
  boundsCache.set(s, b);
  return b;
}

const css = (c: [number, number, number], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

let distBuf = new Float32Array(0);

/**
 * Segments of the scan surface crossing the plane through `center` with in-plane axes u, v,
 * as screen coordinates [x0, y0, x1, y1, ...] (screen = w/2 + q·u/scale, h/2 + q·v/scale).
 */
export function planeSegments(s: Scan, center: Vec3, u: Vec3, v: Vec3, scale: number, w: number, h: number): Float32Array | null {
  const wd = scanWorld(s);
  if (!wd) return null;
  const pos = wd.pos;
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  // quick reject: plane misses the bounding box
  const b = bounds(s, pos);
  let dmin = Infinity, dmax = -Infinity;
  for (let c = 0; c < 8; c++) {
    const p = [c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]];
    const d = (p[0] - center[0]) * n[0] + (p[1] - center[1]) * n[1] + (p[2] - center[2]) * n[2];
    dmin = Math.min(dmin, d);
    dmax = Math.max(dmax, d);
  }
  if (dmin > 0 || dmax < 0) return new Float32Array(0);
  const nv = pos.length / 3;
  if (distBuf.length < nv) distBuf = new Float32Array(nv);
  const D = distBuf;
  for (let i = 0; i < nv; i++) D[i] = (pos[i * 3] - center[0]) * n[0] + (pos[i * 3 + 1] - center[1]) * n[1] + (pos[i * 3 + 2] - center[2]) * n[2];
  const idx = s.mesh.idx;
  const out: number[] = [];
  const pt = (a: number, bb: number) => {
    const t = D[a] / (D[a] - D[bb]);
    const x = pos[a * 3] + (pos[bb * 3] - pos[a * 3]) * t - center[0];
    const y = pos[a * 3 + 1] + (pos[bb * 3 + 1] - pos[a * 3 + 1]) * t - center[1];
    const z = pos[a * 3 + 2] + (pos[bb * 3 + 2] - pos[a * 3 + 2]) * t - center[2];
    out.push(w / 2 + (x * u[0] + y * u[1] + z * u[2]) / scale, h / 2 + (x * v[0] + y * v[1] + z * v[2]) / scale);
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], bb = idx[t + 1], c = idx[t + 2];
    const sa = D[a] > 0, sb = D[bb] > 0, sc = D[c] > 0;
    if (sa === sb && sb === sc) continue;
    // the lone vertex and its two edges
    if (sa === sb) {
      pt(c, a);
      pt(c, bb);
    } else if (sa === sc) {
      pt(bb, a);
      pt(bb, c);
    } else {
      pt(a, bb);
      pt(a, c);
    }
  }
  return Float32Array.from(out);
}

export function strokeSegments(o: CanvasRenderingContext2D, seg: Float32Array, color: [number, number, number], opacity: number) {
  if (!seg.length) return;
  o.beginPath();
  for (let i = 0; i < seg.length; i += 4) {
    o.moveTo(seg[i], seg[i + 1]);
    o.lineTo(seg[i + 2], seg[i + 3]);
  }
  o.lineCap = 'round';
  // dark halo for contrast on bright bone, then the scan colour
  o.strokeStyle = 'rgba(0,0,0,0.55)';
  o.lineWidth = 3;
  o.stroke();
  o.strokeStyle = css(color, Math.max(0.55, opacity));
  o.lineWidth = 1.6;
  o.stroke();
}

/** Draw every visible scan's outline in a planar view (results cached by plane). */
const planeCache = new WeakMap<object, Map<number, { key: string; seg: Float32Array }>>();
export function drawPlaneScans(owner: object, app: App, o: CanvasRenderingContext2D, center: Vec3, u: Vec3, v: Vec3, scale: number, w: number, h: number) {
  if (!app.showScanContours) return;
  let m = planeCache.get(owner);
  if (!m) planeCache.set(owner, (m = new Map()));
  for (const s of app.scans) {
    if (!s.visible || !s.transform) continue;
    const key = JSON.stringify([center, u, v, scale, w, h, s.transform]);
    let c = m.get(s.id);
    if (!c || c.key !== key) {
      c = { key, seg: planeSegments(s, center, u, v, scale, w, h) ?? new Float32Array(0) };
      m.set(s.id, c);
    }
    strokeSegments(o, c.seg, s.color, s.opacity);
  }
}

// ---- panoramic ------------------------------------------------------------------------

interface PanoCoords {
  key: string;
  /** arc length, frame height, signed offset from the curve (buccal +) per vertex; NaN = off the curve */
  s: Float32Array;
  c: Float32Array;
  off: Float32Array;
}
const panoCache = new WeakMap<Scan, PanoCoords>();

/** Nearest arc length on a 2D grid around the curve (brute force per cell, then per vertex lookup). */
function nearestGrid(curve: ArchCurve, cell: number, margin: number) {
  const poly = curve.polyline();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  x0 -= margin;
  y0 -= margin;
  x1 += margin;
  y1 += margin;
  const nx = Math.ceil((x1 - x0) / cell) + 1;
  const ny = Math.ceil((y1 - y0) / cell) + 1;
  const sg = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sg[i + j * nx] = curve.nearest(x0 + i * cell, y0 + j * cell).s;
  return {
    s(x: number, y: number): number {
      const fx = (x - x0) / cell, fy = (y - y0) / cell;
      if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) return NaN;
      const i = Math.min(nx - 1, Math.round(fx)), j = Math.min(ny - 1, Math.round(fy));
      return sg[i + j * nx];
    },
  };
}

export function panoCoords(s: Scan, curve: ArchCurve, O: Vec3, F: Frame): PanoCoords | null {
  const wd = scanWorld(s);
  if (!wd) return null;
  const key = JSON.stringify([s.transform, curve.ctrl, O, F]);
  const c = panoCache.get(s);
  if (c && c.key === key) return c;
  const pos = wd.pos;
  const nv = pos.length / 3;
  const S = new Float32Array(nv), C = new Float32Array(nv), OFF = new Float32Array(nv);
  const grid = nearestGrid(curve, 0.75, 20);
  for (let i = 0; i < nv; i++) {
    const qx = pos[i * 3] - O[0], qy = pos[i * 3 + 1] - O[1], qz = pos[i * 3 + 2] - O[2];
    const a = qx * F[0][0] + qy * F[0][1] + qz * F[0][2];
    const b = qx * F[1][0] + qy * F[1][1] + qz * F[1][2];
    C[i] = qx * F[2][0] + qy * F[2][1] + qz * F[2][2];
    const sv = grid.s(a, b);
    if (Number.isNaN(sv)) {
      S[i] = NaN;
      OFF[i] = NaN;
      continue;
    }
    // refine on the true curve near the grid guess
    const cp = curve.at(sv);
    S[i] = sv + (a - cp.p[0]) * cp.t[0] + (b - cp.p[1]) * cp.t[1];
    OFF[i] = (a - cp.p[0]) * cp.n[0] + (b - cp.p[1]) * cp.n[1];
  }
  const out = { key, s: S, c: C, off: OFF };
  panoCache.set(s, out);
  return out;
}

/** Outline of the scans on the panoramic surface at `offset` (screen via xOf / yOf). */
export function drawPanoScans(app: App, o: CanvasRenderingContext2D, curve: ArchCurve, offset: number, xOf: (s: number) => number, yOf: (c: number) => number) {
  if (!app.showScanContours) return;
  for (const s of app.scans) {
    if (!s.visible || !s.transform) continue;
    const pc = panoCoords(s, curve, app.O, app.frame);
    if (!pc) continue;
    const { s: S, c: C, off: OFF } = pc;
    const idx = s.mesh.idx;
    const seg: number[] = [];
    const pt = (a: number, b: number) => {
      const da = OFF[a] - offset, db = OFF[b] - offset;
      const t = da / (da - db);
      seg.push(xOf(S[a] + (S[b] - S[a]) * t), yOf(C[a] + (C[b] - C[a]) * t));
    };
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      if (Number.isNaN(S[a] + S[b] + S[c])) continue;
      // skip triangles spanning a jump of the nearest-point mapping
      if (Math.abs(S[a] - S[b]) > 4 || Math.abs(S[a] - S[c]) > 4) continue;
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
    strokeSegments(o, Float32Array.from(seg), s.color, s.opacity);
  }
}
