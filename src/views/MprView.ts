import type { App } from '../app';
import { Vec3, add, addScaled, cross, distToSegment2, dot, fromFrame, neg, normalize, scale, sub, toFrame } from '../math';
import { Plane, PlaneView, Pt, ScrollInfo, drawLabel, orientationLabel } from './View';

export const MPR_COLORS = ['#e8524a', '#58c95a', '#e8c547'];
export const MPR_NAMES = ['Axial', 'Coronal', 'Sagittal'];
/** Frame axis that is the normal of each view. */
const NORMAL_AXIS = [2, 1, 0];

/**
 * Orthogonal MPR view (0 axial, 1 coronal, 2 sagittal) of the oriented frame.
 * Ctrl+Alt+drag rotates the other two planes around this view's normal.
 */
export class MprView extends PlaneView {
  private rotating = false;
  private cropEdge: { axis: number; side: 'min' | 'max' } | null = null;

  constructor(
    app: App,
    readonly orient: 0 | 1 | 2,
  ) {
    super(app, MPR_NAMES[orient], MPR_COLORS[orient]);
    // Shift makes the crosshair follow the mouse instead
    this.shiftPans = false;
  }

  /** In-plane basis for this view (includes its in-plane offset angle psi). */
  basis(): { u: Vec3; v: Vec3; n: Vec3 } {
    const F = this.app.frame;
    let u0: Vec3, v0: Vec3;
    if (this.orient === 0) {
      u0 = F[0];
      v0 = F[1];
    } else if (this.orient === 1) {
      u0 = F[0];
      v0 = neg(F[2]);
    } else {
      u0 = F[1];
      v0 = neg(F[2]);
    }
    const psi = this.app.psi[this.orient];
    const c = Math.cos(psi);
    const s = Math.sin(psi);
    const u = add(scale(u0, c), scale(v0, s));
    const v = add(scale(u0, -s), scale(v0, c));
    return { u, v, n: cross(u, v) };
  }

  protected plane(): Plane | null {
    if (!this.app.vol) return null;
    const { u, v, n } = this.basis();
    const X = this.app.X;
    const vc = this.app.O;
    // keep the vol centre at the screen centre; plane passes through crosshair
    const center = addScaled(vc, n, -dot(sub(vc, X), n));
    return { center, u, v };
  }

  fit() {
    const vol = this.app.vol;
    if (!vol) return;
    const { u, v } = this.basis();
    let mu = 0;
    let mv = 0;
    for (const c of vol.corners()) {
      const q = sub(c, this.app.O);
      mu = Math.max(mu, Math.abs(dot(q, u)));
      mv = Math.max(mv, Math.abs(dot(q, v)));
    }
    this.vs.scale = Math.max((2 * mu) / Math.max(1, this.w), (2 * mv) / Math.max(1, this.h)) * 1.06;
    this.vs.panU = 0;
    this.vs.panV = 0;
  }

  // ---- interaction -------------------------------------------------------

  /** Touch: with the Rotate tool a one-finger drag tilts the other planes. */
  protected touchDragAt(): boolean {
    return this.app.mprTool === 'rotate';
  }

  protected onLeftDown(p: Pt, e: PointerEvent): boolean {
    const tool = this.app.mprTool;
    if (((e.ctrlKey || e.metaKey) && e.altKey) || tool === 'rotate') {
      this.rotating = true;
      return true;
    }
    if (tool === 'crop') {
      this.cropEdge = this.hitCropEdge(p);
      if (this.cropEdge) return true;
    }
    this.setCrosshair(p);
    return true;
  }

  protected onLeftDrag(p: Pt, last: Pt) {
    if (this.rotating) {
      const c = this.worldToScreen(this.app.X)!;
      let da = Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(last[1] - c[1], last[0] - c[0]);
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      this.app.rotateAroundView(this.orient, this.basis().n, da);
    } else if (this.cropEdge) {
      const w = this.screenToWorld(p)!;
      const f = toFrame(w, this.app.O, this.app.frame);
      const { axis, side } = this.cropEdge;
      const crop = this.app.crop;
      if (side === 'min') crop.min[axis] = Math.min(f[axis], crop.max[axis] - 2);
      else crop.max[axis] = Math.max(f[axis], crop.min[axis] + 2);
      this.app.cropEdited = true;
      this.app.changed();
    } else {
      this.setCrosshair(p);
    }
  }

  protected onLeftUp() {
    this.rotating = false;
    this.cropEdge = null;
  }

  protected onHover(p: Pt, e: PointerEvent) {
    if (e.shiftKey && this.app.vol) {
      this.setCrosshair(p);
      this.el.style.cursor = 'crosshair';
      return;
    }
    if (this.app.mprTool === 'crop') {
      const e = this.hitCropEdge(p);
      if (e) {
        const { u } = this.basis();
        const ax = this.app.frame[e.axis];
        this.el.style.cursor = Math.abs(dot(ax, u)) > 0.7 ? 'ew-resize' : 'ns-resize';
        return;
      }
    }
    this.el.style.cursor = this.app.mprTool === 'rotate' ? 'alias' : 'crosshair';
  }

  private setCrosshair(p: Pt) {
    const w = this.screenToWorld(p);
    if (!w) return;
    this.app.X = w;
    this.app.changed();
  }

  /** Scroll bar: slice position along this view's normal, across the whole volume (down = like wheel down). */
  protected scrollInfo(): ScrollInfo | null {
    const vol = this.app.vol;
    if (!vol) return null;
    const n = this.basis().n;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of vol.corners()) {
      const d = dot(sub(c, this.app.O), n);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return { top: hi, bottom: lo, value: dot(sub(this.app.X, this.app.O), n) };
  }

  protected setScroll(v: number) {
    const n = this.basis().n;
    this.app.X = addScaled(this.app.X, n, v - dot(sub(this.app.X, this.app.O), n));
    this.app.changed();
  }

  protected onScroll(dir: number) {
    const step = this.app.vol!.minSpacing;
    this.app.X = addScaled(this.app.X, this.basis().n, -dir * step);
    this.app.changed();
  }

  // ---- crop box --------------------------------------------------------

  /** The two in-plane frame axes of this view. */
  private inPlaneAxes(): [number, number] {
    const na = NORMAL_AXIS[this.orient];
    return [0, 1, 2].filter((a) => a !== na) as [number, number];
  }

  private cropCorners(): Pt[] {
    const { min, max } = this.app.crop;
    const [a, b] = this.inPlaneAxes();
    const na = NORMAL_AXIS[this.orient];
    const fx = toFrame(this.app.X, this.app.O, this.app.frame);
    const pts: Pt[] = [];
    const combos: [number, number][] = [
      [min[a], min[b]],
      [max[a], min[b]],
      [max[a], max[b]],
      [min[a], max[b]],
    ];
    for (const [va, vb] of combos) {
      const c: Vec3 = [0, 0, 0];
      c[a] = va;
      c[b] = vb;
      c[na] = fx[na];
      const s = this.worldToScreen(fromFrame(c, this.app.O, this.app.frame))!;
      pts.push([s[0], s[1]]);
    }
    return pts;
  }

  private hitCropEdge(p: Pt): { axis: number; side: 'min' | 'max' } | null {
    const pts = this.cropCorners();
    const [a, b] = this.inPlaneAxes();
    // edges: 0-1 is b=min, 1-2 is a=max, 2-3 is b=max, 3-0 is a=min
    const edges: { axis: number; side: 'min' | 'max'; i: number; j: number }[] = [
      { axis: b, side: 'min', i: 0, j: 1 },
      { axis: a, side: 'max', i: 1, j: 2 },
      { axis: b, side: 'max', i: 2, j: 3 },
      { axis: a, side: 'min', i: 3, j: 0 },
    ];
    let best: (typeof edges)[number] | null = null;
    let bd = 8;
    for (const e of edges) {
      const d = distToSegment2(p[0], p[1], pts[e.i][0], pts[e.i][1], pts[e.j][0], pts[e.j][1]);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best ? { axis: best.axis, side: best.side } : null;
  }

  // ---- overlay -----------------------------------------------------------

  protected drawOverlay(o: CanvasRenderingContext2D) {
    const app = this.app;
    const { u, v, n } = this.basis();
    const X = app.X;
    const cs = this.worldToScreen(X)!;

    // crop box (dim outside)
    if (app.mprTool === 'crop' || !app.cropIsFull()) {
      const pts = this.cropCorners();
      o.save();
      o.beginPath();
      o.rect(0, 0, this.w, this.h);
      o.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < 4; i++) o.lineTo(pts[i][0], pts[i][1]);
      o.closePath();
      o.fillStyle = 'rgba(0,0,0,0.55)';
      o.fill('evenodd');
      o.beginPath();
      o.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < 4; i++) o.lineTo(pts[i][0], pts[i][1]);
      o.closePath();
      o.strokeStyle = app.mprTool === 'crop' ? '#4fb3ff' : 'rgba(79,179,255,0.5)';
      o.lineWidth = app.mprTool === 'crop' ? 2 : 1;
      o.stroke();
      o.restore();
    }

    // crosshair lines: intersections with the other two planes
    const L = Math.hypot(this.w, this.h);
    for (const other of app.mprViews) {
      if (other === this) continue;
      const d = normalize(cross(n, other.basis().n));
      const dx = dot(d, u);
      const dy = dot(d, v);
      const gap = 14;
      o.strokeStyle = other.color;
      o.globalAlpha = 0.85;
      o.lineWidth = 1;
      o.beginPath();
      o.moveTo(cs[0] - dx * L, cs[1] - dy * L);
      o.lineTo(cs[0] - dx * gap, cs[1] - dy * gap);
      o.moveTo(cs[0] + dx * gap, cs[1] + dy * gap);
      o.lineTo(cs[0] + dx * L, cs[1] + dy * L);
      o.stroke();
      // rotation handles
      if (app.mprTool === 'rotate') {
        o.fillStyle = other.color;
        for (const sgn of [-1, 1]) {
          o.beginPath();
          o.arc(cs[0] + sgn * dx * 60, cs[1] + sgn * dy * 60, 4, 0, Math.PI * 2);
          o.fill();
        }
      }
      o.globalAlpha = 1;
    }

    this.drawImplantAxes(o);

    // orientation letters
    const lbl = (d: Vec3) => orientationLabel(d);
    drawLabel(o, lbl(u), this.w - 8, this.h / 2 + 4, '#ababb2', 'right');
    drawLabel(o, lbl(neg(u)), 8, this.h / 2 + 4, '#ababb2');
    drawLabel(o, lbl(neg(v)), this.w / 2, 34, '#ababb2', 'center');
    drawLabel(o, lbl(v), this.w / 2, this.h - 8, '#ababb2', 'center');

    const fx = toFrame(X, app.O, app.frame);
    const na = NORMAL_AXIS[this.orient];
    drawLabel(o, `${fx[na].toFixed(1)} mm`, 8, this.h - 8, '#ababb2');
    const angle = app.viewTiltDeg(this.orient);
    if (angle > 0.05) drawLabel(o, `tilt ${angle.toFixed(1)}°`, this.w - 8, this.h - 8, '#ababb2', 'right');
  }
}
