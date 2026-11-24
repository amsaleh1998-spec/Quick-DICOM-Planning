// ① Reorient in the 3D view: with the Crop or Rotate tool, the crop box and the three axes of the
// orientation frame are drawn over the rendering, and can be edited there –
//   Crop:   drag a face's handle along its axis (the rendering is cropped as it moves);
//   Rotate: drag one of the three rings to turn the frame around that axis (as the matching
//           2D view's rotation does).
// Colours as in the 2D views: axial (red) turns around the S–I axis, coronal (green) around A–P,
// sagittal (yellow) around R–L.

import type { App } from '../app';
import { MPR_COLORS } from './MprView';
import { Vec3, add, dot, fromFrame, scale, sub } from '../math';

type Pt = [number, number];

export interface Gizmo3dHost {
  project(w: Vec3): Pt | null;
  rayAt(p: Pt): { o: Vec3; d: Vec3 };
  /** camera looking direction */
  fwd(): Vec3;
}

/** The frame axis that is each 2D view's normal (axial: S–I, coronal: A–P, sagittal: R–L). */
const VIEW_AXIS = [2, 1, 0];
const HANDLE_R = 7;
const RING_HIT = 8;

type Grab =
  | { kind: 'face'; axis: number; side: 'min' | 'max'; start: number; h0: number; c: Vec3 }
  | { kind: 'ring'; orient: number; last: number | null; lastScreen: number };

export class Reorient3d {
  private grab: Grab | null = null;
  private hover: { kind: 'face'; axis: number; side: 'min' | 'max' } | { kind: 'ring'; orient: number } | null = null;

  constructor(
    private app: App,
    private host: Gizmo3dHost,
  ) {}

  /** Shown while Reorient's Crop or Rotate tool is on. */
  active(): boolean {
    const a = this.app;
    return !!a.vol && a.mode === 'mpr' && (a.mprTool === 'crop' || a.mprTool === 'rotate');
  }

  get dragging(): boolean {
    return !!this.grab;
  }

  private corner(c: Vec3): Vec3 {
    return fromFrame(c, this.app.O, this.app.frame);
  }

  /** Centre of a face of the crop box (world). */
  private face(axis: number, side: 'min' | 'max'): { c: Vec3 } {
    const { min, max } = this.app.crop;
    const f: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    f[axis] = side === 'min' ? min[axis] : max[axis];
    return { c: this.corner(f) };
  }

  /** Radius of the rotation rings (world mm): about the crop box's size. */
  private ringRadius(): number {
    const { min, max } = this.app.crop;
    return 0.42 * Math.min(max[0] - min[0], max[1] - min[1], max[2] - min[2]) + 0.1 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  }

  /** Points of a ring (world) around the view's axis, through the frame origin. */
  private ring(orient: number, n = 72): Vec3[] {
    const F = this.app.frame;
    const ax = VIEW_AXIS[orient];
    const u = F[(ax + 1) % 3], v = F[(ax + 2) % 3];
    const r = this.ringRadius();
    const out: Vec3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      out.push(add(this.app.O, add(scale(u, r * Math.cos(t)), scale(v, r * Math.sin(t)))));
    }
    return out;
  }

  private hit(p: Pt): Reorient3d['hover'] {
    const tool = this.app.mprTool;
    if (tool === 'crop') {
      // the nearest handle under the pointer; of handles on top of each other (a face seen
      // head-on and the one behind it), the one nearer to the camera
      let best: Reorient3d['hover'] = null, bd = HANDLE_R + 3, bz = Infinity;
      const fwd = this.host.fwd();
      for (let axis = 0; axis < 3; axis++)
        for (const side of ['min', 'max'] as const) {
          const c = this.face(axis, side).c;
          const s = this.host.project(c);
          if (!s) continue;
          const d = Math.hypot(s[0] - p[0], s[1] - p[1]);
          const z = dot(c, fwd);
          if (d < bd - 2 || (d < HANDLE_R + 3 && Math.abs(d - bd) <= 2 && z < bz)) {
            bd = d;
            bz = z;
            best = { kind: 'face', axis, side };
          }
        }
      return best;
    }
    if (tool === 'rotate') {
      // the ring under the pointer; where rings cross, the one facing the camera most (a ring
      // seen edge-on is only a line)
      let best: Reorient3d['hover'] = null, bd = RING_HIT, bf = -1;
      const fwd = this.host.fwd();
      for (let orient = 0; orient < 3; orient++) {
        const facing = Math.abs(dot(this.app.frame[VIEW_AXIS[orient]], fwd));
        const pts = this.ring(orient).map((w) => this.host.project(w));
        let d = Infinity;
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i], b = pts[i + 1];
          if (a && b) d = Math.min(d, segDist(p, a, b));
        }
        if (d >= RING_HIT) continue;
        if (d < bd - 3 || (Math.abs(d - bd) <= 3 && facing > bf)) {
          bd = d;
          bf = facing;
          best = { kind: 'ring', orient };
        }
      }
      return best;
    }
    return null;
  }

  /** Cursor for the pointer (null: not over the gizmo). */
  cursor(p: Pt): string | null {
    if (!this.active()) return null;
    const h = this.hit(p);
    const changed = JSON.stringify(h) !== JSON.stringify(this.hover);
    this.hover = h;
    if (changed) this.app.requestRender();
    return h ? (h.kind === 'face' ? 'move' : 'grab') : null;
  }

  /** Angle of the pointer around the ring's axis, in the ring's plane (null when edge-on). */
  private ringAngle(orient: number, p: Pt): number | null {
    const F = this.app.frame;
    const ax = VIEW_AXIS[orient];
    const n = F[ax], u = F[(ax + 1) % 3], v = F[(ax + 2) % 3];
    const { o, d } = this.host.rayAt(p);
    const den = dot(d, n);
    if (Math.abs(den) < 0.12) return null;
    const t = dot(sub(this.app.O, o), n) / den;
    const q = sub(add(o, scale(d, t)), this.app.O);
    return Math.atan2(dot(q, v), dot(q, u));
  }

  /** Pointer pressed: true when it took the gizmo (the view does not turn then). */
  start(p: Pt): boolean {
    if (!this.active()) return false;
    const h = this.hit(p);
    if (!h) return false;
    if (h.kind === 'face') {
      const { c } = this.face(h.axis, h.side);
      const axis = this.app.frame[h.axis];
      const { min, max } = this.app.crop;
      this.grab = { kind: 'face', axis: h.axis, side: h.side, start: h.side === 'min' ? min[h.axis] : max[h.axis], h0: this.axisParam(p, c, axis), c };
    } else {
      const o = this.host.project(this.app.O) ?? p;
      this.grab = { kind: 'ring', orient: h.orient, last: this.ringAngle(h.orient, p), lastScreen: Math.atan2(p[1] - o[1], p[0] - o[0]) };
    }
    this.hover = h;
    return true;
  }

  /** Position along the line c + axis·h closest to the pointer's ray. */
  private axisParam(p: Pt, c: Vec3, axis: Vec3): number {
    const { o, d } = this.host.rayAt(p);
    const w0 = sub(o, c);
    const b = dot(d, axis), dd = dot(d, w0), e = dot(axis, w0);
    const den = 1 - b * b;
    return den < 1e-6 ? e : (e - b * dd) / den;
  }

  move(p: Pt) {
    const g = this.grab;
    if (!g) return;
    const app = this.app;
    if (g.kind === 'face') {
      const axis = app.frame[g.axis];
      const v = g.start + (this.axisParam(p, g.c, axis) - g.h0);
      const crop = app.crop;
      if (g.side === 'min') crop.min[g.axis] = Math.min(v, crop.max[g.axis] - 2);
      else crop.max[g.axis] = Math.max(v, crop.min[g.axis] + 2);
      app.cropEdited = true;
      app.changed();
      return;
    }
    // ring: the turn of the pointer around the axis
    const view = app.mprViews[g.orient];
    const n = view.basis().n;
    const ax = app.frame[VIEW_AXIS[g.orient]];
    const a = this.ringAngle(g.orient, p);
    const o = this.host.project(app.O) ?? p;
    const sa = Math.atan2(p[1] - o[1], p[0] - o[0]);
    let da: number;
    if (a !== null && g.last !== null) da = wrap(a - g.last);
    else {
      // edge-on: the turn on screen, with the sense of the axis seen from the camera
      da = wrap(sa - g.lastScreen) * (dot(ax, this.host.fwd()) > 0 ? 1 : -1);
    }
    // the ring turns with the frame: the pointer's angle measured on it moves back by da
    g.last = a === null ? null : wrap(a - da);
    g.lastScreen = sa;
    if (Math.abs(da) < 1e-6) return;
    // the frame turns around its own axis; the 2D view's normal is that axis (or its opposite)
    app.rotateAroundView(g.orient, n, dot(n, ax) >= 0 ? da : -da);
  }

  end() {
    this.grab = null;
  }

  draw(o: CanvasRenderingContext2D) {
    const app = this.app;
    if (!app.vol || app.mode !== 'mpr') return;
    const tool = app.mprTool;
    const showBox = tool === 'crop' || tool === 'rotate' || !app.cropIsFull();
    if (!showBox) return;
    const { min, max } = app.crop;
    const P = (x: number, y: number, z: number) => this.host.project(this.corner([x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]]));
    const edges: [number[], number[]][] = [];
    for (let a = 0; a < 2; a++)
      for (let b = 0; b < 2; b++) {
        edges.push([[0, a, b], [1, a, b]], [[a, 0, b], [a, 1, b]], [[a, b, 0], [a, b, 1]]);
      }
    o.save();
    const editing = tool === 'crop' || tool === 'rotate';
    // the crop box
    o.lineWidth = editing ? 1.6 : 1;
    o.strokeStyle = editing ? '#4fb3ff' : 'rgba(79,179,255,0.55)';
    o.beginPath();
    for (const [e0, e1] of edges) {
      const s0 = P(e0[0], e0[1], e0[2]), s1 = P(e1[0], e1[1], e1[2]);
      if (!s0 || !s1) continue;
      o.moveTo(s0[0], s0[1]);
      o.lineTo(s1[0], s1[1]);
    }
    o.stroke();
    if (!editing) {
      o.restore();
      return;
    }
    // the three axes of the frame, through its origin, across the box
    const F = app.frame;
    for (let orient = 0; orient < 3; orient++) {
      const ax = VIEW_AXIS[orient];
      const a = this.host.project(add(app.O, scale(F[ax], min[ax])));
      const b = this.host.project(add(app.O, scale(F[ax], max[ax])));
      if (!a || !b) continue;
      o.strokeStyle = MPR_COLORS[orient];
      o.lineWidth = 2;
      o.globalAlpha = 0.9;
      o.beginPath();
      o.moveTo(a[0], a[1]);
      o.lineTo(b[0], b[1]);
      o.stroke();
      // arrowhead at the positive end (S, P, L)
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      const ux = dx / L, uy = dy / L;
      o.fillStyle = MPR_COLORS[orient];
      o.beginPath();
      o.moveTo(b[0] + ux * 9, b[1] + uy * 9);
      o.lineTo(b[0] - uy * 4.5, b[1] + ux * 4.5);
      o.lineTo(b[0] + uy * 4.5, b[1] - ux * 4.5);
      o.closePath();
      o.fill();
    }
    o.globalAlpha = 1;
    if (tool === 'crop') {
      // a handle on each face
      for (let axis = 0; axis < 3; axis++)
        for (const side of ['min', 'max'] as const) {
          const s = this.host.project(this.face(axis, side).c);
          if (!s) continue;
          const hot = (this.grab?.kind === 'face' && this.grab.axis === axis && this.grab.side === side) || (this.hover?.kind === 'face' && this.hover.axis === axis && this.hover.side === side);
          const orient = VIEW_AXIS.indexOf(axis);
          o.beginPath();
          o.arc(s[0], s[1], hot ? HANDLE_R + 2 : HANDLE_R, 0, Math.PI * 2);
          o.fillStyle = hot ? '#ffffff' : '#4fb3ff';
          o.fill();
          o.lineWidth = 2;
          o.strokeStyle = MPR_COLORS[orient];
          o.stroke();
        }
    } else {
      // the rotation rings
      for (let orient = 0; orient < 3; orient++) {
        const hot = (this.grab?.kind === 'ring' && this.grab.orient === orient) || (this.hover?.kind === 'ring' && this.hover.orient === orient);
        o.strokeStyle = MPR_COLORS[orient];
        o.lineWidth = hot ? 4 : 2.2;
        o.globalAlpha = hot ? 1 : 0.85;
        o.beginPath();
        let pen = false;
        for (const w of this.ring(orient)) {
          const s = this.host.project(w);
          if (!s) {
            pen = false;
            continue;
          }
          if (pen) o.lineTo(s[0], s[1]);
          else o.moveTo(s[0], s[1]);
          pen = true;
        }
        o.stroke();
      }
      o.globalAlpha = 1;
    }
    o.restore();
  }
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Distance of a point to a screen segment. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

