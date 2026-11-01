import type { App } from '../app';
import { ABUTMENT_COLOR, ABUTMENT_SELECTED_COLOR, Cylinder, IMPLANT_COLOR, IMPLANT_SELECTED_COLOR, Implant, platformOf } from '../implant';
import { Vec2, Vec3, add, addScaled, cross, distToSegment2, dot, fromFrame, neg, normalize, scale, toFrame } from '../math';
import { CropSpec, SlabSpec, sampleLine } from '../render';
import { Plane, PlaneView, Pt, View, ViewState, drawLabel } from './View';
import { ImplantEditor, projectedRadialAxial } from './implantEdit';

const CURVE_COLOR = '#4fb3ff';
const CROSS_COLOR = '#c38cff';
const TANG_COLOR = '#ff7ab6';

// ---------------------------------------------------------------------------
// Axial planning view: draw/edit the panoramic curve
// ---------------------------------------------------------------------------

export class PlanAxialView extends PlaneView {
  private dragPt = -1;

  constructor(app: App) {
    super(app, 'Axial', '#e8524a');
    this.implantsEditable = true;
  }

  protected plane(): Plane | null {
    const F = this.app.frame;
    return { center: fromFrame([0, 0, this.app.focusC], this.app.O, F), u: F[0], v: F[1] };
  }
  protected crop(): CropSpec | null {
    return this.app.cropSpec();
  }

  fit() {
    const { min, max } = this.app.crop;
    this.vs.scale = Math.max((max[0] - min[0]) / Math.max(1, this.w), (max[1] - min[1]) / Math.max(1, this.h)) * 1.05;
    this.vs.panU = (min[0] + max[0]) / 2;
    this.vs.panV = (min[1] + max[1]) / 2;
  }

  /** Frame (a,b) of a screen point at the current level. */
  private toAB(p: Pt): Vec2 {
    const w = this.screenToWorld(p)!;
    const f = toFrame(w, this.app.O, this.app.frame);
    return [f[0], f[1]];
  }
  private fromAB(ab: Vec2): Pt {
    const s = this.worldToScreen(fromFrame([ab[0], ab[1], this.app.focusC], this.app.O, this.app.frame))!;
    return [s[0], s[1]];
  }

  protected onLeftDown(p: Pt): boolean {
    const app = this.app;
    if (app.placing) {
      app.placeImplantAt(this.screenToWorld(p)!);
      return false;
    }
    if (app.drawing) {
      app.drawing.push(this.toAB(p));
      app.changed();
      return false;
    }
    if (app.curve) {
      const i = app.curve.ctrl.findIndex((c) => {
        const s = this.fromAB(c);
        return Math.hypot(s[0] - p[0], s[1] - p[1]) < 8;
      });
      if (i >= 0) {
        this.dragPt = i;
        return true;
      }
    }
    if (this.startImplantDrag(p)) return true;
    // click near the curve -> move the cross-sections there
    if (app.curve) {
      const ab = this.toAB(p);
      const nr = app.curve.nearest(ab[0], ab[1]);
      if (nr.dist < 15) {
        app.s = nr.s;
        app.changed();
      }
    }
    return false;
  }

  protected onLeftDrag(p: Pt, last: Pt) {
    if (this.dragImplant(p, last)) return;
    if (this.dragPt >= 0 && this.app.curve) {
      const ctrl = this.app.curve.ctrl.slice();
      ctrl[this.dragPt] = this.toAB(p);
      this.app.setCurve(ctrl, true);
    }
  }

  protected onLeftUp() {
    if (this.endImplantDrag()) return;
    if (this.dragPt >= 0) this.app.setCurve(this.app.curve!.ctrl, false);
    this.dragPt = -1;
  }

  protected onHover(p: Pt) {
    const app = this.app;
    if (app.drawing || app.placing) {
      this.el.style.cursor = 'crosshair';
      if (app.drawing) app.requestRender(); // rubber band
      this.hover = p;
      return;
    }
    this.hover = null;
    if (app.curve && app.curve.ctrl.some((c) => {
      const s = this.fromAB(c);
      return Math.hypot(s[0] - p[0], s[1] - p[1]) < 8;
    })) {
      this.el.style.cursor = 'grab';
      return;
    }
    if (!this.updateHoverCursor(p)) this.el.style.cursor = '';
  }
  private hover: Pt | null = null;

  protected onDoubleClick(p: Pt) {
    const app = this.app;
    if (app.drawing) {
      // the dblclick also produced two clicks; drop the duplicate point
      const d = app.drawing;
      if (d.length >= 2) {
        const a = d[d.length - 1];
        const b = d[d.length - 2];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1) d.pop();
      }
      app.finishCurve();
      return;
    }
    // double-click on a control point removes it; on the curve inserts one
    if (!app.curve) return;
    const ctrl = app.curve.ctrl.slice();
    const i = ctrl.findIndex((c) => {
      const s = this.fromAB(c);
      return Math.hypot(s[0] - p[0], s[1] - p[1]) < 8;
    });
    if (i >= 0) {
      if (ctrl.length > 2) {
        ctrl.splice(i, 1);
        app.setCurve(ctrl, false);
      }
      return;
    }
    const ab = this.toAB(p);
    // find segment between control points closest to the click
    let bi = -1;
    let bd = 10;
    for (let k = 0; k < ctrl.length - 1; k++) {
      const a = this.fromAB(ctrl[k]);
      const b = this.fromAB(ctrl[k + 1]);
      const d = distToSegment2(p[0], p[1], a[0], a[1], b[0], b[1]);
      if (d < bd) {
        bd = d;
        bi = k;
      }
    }
    if (bi >= 0 && app.curve.nearest(ab[0], ab[1]).dist / this.vs.scale < 10) {
      ctrl.splice(bi + 1, 0, ab);
      app.setCurve(ctrl, false);
    }
  }

  protected onScroll(dir: number) {
    this.app.focusC -= dir * this.app.vol!.minSpacing * 2;
    this.app.changed();
  }

  protected drawOverlay(o: CanvasRenderingContext2D) {
    const app = this.app;
    this.drawImplantAxes(o);
    const curve = app.curve;
    if (curve) {
      const poly = curve.polyline();
      o.strokeStyle = CURVE_COLOR;
      o.lineWidth = 2;
      o.beginPath();
      poly.forEach((ab, i) => {
        const s = this.fromAB(ab);
        if (i) o.lineTo(s[0], s[1]);
        else o.moveTo(s[0], s[1]);
      });
      o.stroke();
      // slab boundaries
      o.setLineDash([3, 4]);
      o.lineWidth = 1;
      o.strokeStyle = 'rgba(79,179,255,0.45)';
      for (const side of [-1, 1]) {
        o.beginPath();
        const half = (app.panoThickness() / 2) * side;
        for (let s = 0, i = 0; s <= curve.length; s += 1, i++) {
          const cp = curve.at(s);
          const sp = this.fromAB([cp.p[0] + cp.n[0] * half, cp.p[1] + cp.n[1] * half]);
          if (i) o.lineTo(sp[0], sp[1]);
          else o.moveTo(sp[0], sp[1]);
        }
        o.stroke();
      }
      o.setLineDash([]);
      // control points
      for (const c of curve.ctrl) {
        const s = this.fromAB(c);
        o.fillStyle = '#0b1220';
        o.strokeStyle = CURVE_COLOR;
        o.lineWidth = 2;
        o.beginPath();
        o.arc(s[0], s[1], 4.5, 0, Math.PI * 2);
        o.fill();
        o.stroke();
      }
      // cross-section positions
      for (let k = 0; k < 3; k++) {
        const s = app.crossS(k);
        const cp = curve.at(s);
        const L = 12;
        const a = this.fromAB([cp.p[0] + cp.n[0] * L, cp.p[1] + cp.n[1] * L]);
        const b = this.fromAB([cp.p[0] - cp.n[0] * L, cp.p[1] - cp.n[1] * L]);
        o.strokeStyle = k === 1 ? '#fff' : CROSS_COLOR;
        o.lineWidth = k === 1 ? 2 : 1;
        o.beginPath();
        o.moveTo(a[0], a[1]);
        o.lineTo(b[0], b[1]);
        o.stroke();
      }
      const sEnd = this.fromAB(curve.at(0).p);
      const eEnd = this.fromAB(curve.at(curve.length).p);
      drawLabel(o, 'R', sEnd[0] - 6, sEnd[1] + 18, CURVE_COLOR, 'center');
      drawLabel(o, 'L', eEnd[0] + 6, eEnd[1] + 18, CURVE_COLOR, 'center');
    }
    // tangential plane trace
    const tp = app.tangentialPlane();
    if (tp) {
      const c = this.worldToScreen(tp.pivot)!;
      const d: Vec3 = tp.h;
      const dx = dot(d, app.frame[0]);
      const dy = dot(d, app.frame[1]);
      const l = Math.hypot(dx, dy);
      if (l > 0.05) {
        const L = 15 / this.vs.scale;
        o.strokeStyle = TANG_COLOR;
        o.lineWidth = 1.5;
        o.beginPath();
        o.moveTo(c[0] - (dx / l) * L, c[1] - (dy / l) * L);
        o.lineTo(c[0] + (dx / l) * L, c[1] + (dy / l) * L);
        o.stroke();
      }
    }
    // drawing in progress
    if (app.drawing) {
      o.strokeStyle = '#ffd34f';
      o.fillStyle = '#ffd34f';
      o.lineWidth = 2;
      o.beginPath();
      app.drawing.forEach((ab, i) => {
        const s = this.fromAB(ab);
        if (i) o.lineTo(s[0], s[1]);
        else o.moveTo(s[0], s[1]);
      });
      if (this.hover && app.drawing.length) o.lineTo(this.hover[0], this.hover[1]);
      o.stroke();
      for (const ab of app.drawing) {
        const s = this.fromAB(ab);
        o.beginPath();
        o.arc(s[0], s[1], 4, 0, Math.PI * 2);
        o.fill();
      }
      drawLabel(o, 'Click to add points along the arch (patient right → left). Double-click / Enter to finish, Esc to cancel.', 8, this.h - 10, '#ffd34f');
    } else if (!curve) {
      drawLabel(o, 'Use “Draw panoramic curve” and click along the arch.', 8, this.h - 10, '#ffd34f');
    }
    drawLabel(o, `level ${app.focusC.toFixed(1)} mm`, this.w - 34, 16, '#9fb0c8', 'right');
  }
}

// ---------------------------------------------------------------------------
// Cross-sections (perpendicular to the curve)
// ---------------------------------------------------------------------------

export class CrossView extends PlaneView {
  constructor(
    app: App,
    readonly index: 0 | 1 | 2,
    vs: ViewState,
  ) {
    super(app, `Cross-section ${index + 1}`, index === 1 ? '#ffffff' : CROSS_COLOR, vs);
    this.implantsEditable = true;
  }

  protected emptyMessage() {
    return this.app.vol ? 'Draw a panoramic curve in the axial view first.' : 'No volume loaded';
  }

  protected plane(): Plane | null {
    const app = this.app;
    if (!app.curve) return null;
    const cp = app.curve.at(app.crossS(this.index));
    const F = app.frame;
    const nW = add(scale(F[0], cp.n[0]), scale(F[1], cp.n[1]));
    return {
      center: fromFrame([cp.p[0], cp.p[1], app.focusC], app.O, F),
      u: neg(nW), // buccal on the left, lingual on the right
      v: neg(F[2]),
    };
  }
  protected crop(): CropSpec | null {
    return this.app.cropSpec();
  }

  fit() {
    // ~40 mm field of view
    this.vs.scale = 40 / Math.max(1, Math.min(this.w, this.h));
    this.vs.panU = 0;
    this.vs.panV = 0;
  }

  protected onLeftDown(p: Pt): boolean {
    const app = this.app;
    if (app.placing) {
      app.placeImplantAt(this.screenToWorld(p)!);
      return false;
    }
    if (this.startImplantDrag(p)) return true;
    // click: set the vertical level
    const w = this.screenToWorld(p)!;
    app.focusC = toFrame(w, app.O, app.frame)[2];
    app.changed();
    return false;
  }
  protected onLeftDrag(p: Pt, last: Pt) {
    this.dragImplant(p, last);
  }
  protected onLeftUp() {
    this.endImplantDrag();
  }
  protected onHover(p: Pt) {
    if (!this.updateHoverCursor(p)) this.el.style.cursor = this.app.placing ? 'crosshair' : '';
  }
  protected onScroll(dir: number) {
    this.app.moveAlongCurve(dir);
  }

  protected drawOverlay(o: CanvasRenderingContext2D) {
    const app = this.app;
    const pl = this.currentPlane()!;
    // curve position marker (vertical) & level (horizontal)
    const cp = app.curve!.at(app.crossS(this.index));
    const base = fromFrame([cp.p[0], cp.p[1], app.focusC], app.O, app.frame);
    const s = this.worldToScreen(base, pl)!;
    o.strokeStyle = 'rgba(79,179,255,0.55)';
    o.setLineDash([4, 4]);
    o.lineWidth = 1;
    o.beginPath();
    o.moveTo(s[0], 0);
    o.lineTo(s[0], this.h);
    o.moveTo(0, s[1]);
    o.lineTo(this.w, s[1]);
    o.stroke();
    o.setLineDash([]);
    this.drawImplantAxes(o);
    drawLabel(o, 'B', 8, this.h / 2 + 4, '#9fb0c8');
    drawLabel(o, 'L', this.w - 8, this.h / 2 + 4, '#9fb0c8', 'right');
    const sk = app.crossS(this.index);
    drawLabel(o, `${sk.toFixed(1)} mm`, this.w - 34, 16, '#9fb0c8', 'right');
    drawScaleBar(o, this.w, this.h, this.vs.scale);
  }
}

// ---------------------------------------------------------------------------
// Tangential view: rotates 360° around the vertical / implant axis
// ---------------------------------------------------------------------------

export class TangView extends PlaneView {
  private frozen: Plane | null = null;

  constructor(app: App) {
    super(app, 'Tangential', TANG_COLOR);
    this.implantsEditable = true;
  }

  protected emptyMessage() {
    return this.app.vol ? 'Draw a panoramic curve or select an implant.' : 'No volume loaded';
  }

  protected plane(): Plane | null {
    if (this.frozen) return this.frozen;
    const tp = this.app.tangentialPlane();
    if (!tp) return null;
    return { center: tp.pivot, u: tp.h, v: neg(tp.axis) };
  }
  protected crop(): CropSpec | null {
    return this.app.cropSpec();
  }

  fit() {
    this.vs.scale = 40 / Math.max(1, Math.min(this.w, this.h));
    this.vs.panU = 0;
    this.vs.panV = 0;
  }

  protected onLeftDown(p: Pt): boolean {
    const app = this.app;
    if (app.placing) {
      app.placeImplantAt(this.screenToWorld(p)!);
      return false;
    }
    // freeze the plane while dragging so the implant follows the mouse
    const pl = this.plane();
    if (pl && this.startImplantDrag(p)) {
      this.frozen = pl;
      return true;
    }
    return false;
  }
  protected onLeftDrag(p: Pt, last: Pt) {
    this.dragImplant(p, last);
  }
  protected onLeftUp() {
    this.frozen = null;
    this.endImplantDrag();
    this.app.requestRender();
  }
  protected onHover(p: Pt) {
    if (!this.updateHoverCursor(p)) this.el.style.cursor = this.app.placing ? 'crosshair' : 'ew-resize';
  }
  protected onScroll(dir: number) {
    const app = this.app;
    app.tangAngle = (app.tangAngle + dir * 5 + 360) % 360;
    app.changed();
  }

  protected drawOverlay(o: CanvasRenderingContext2D) {
    const app = this.app;
    const pl = this.currentPlane()!;
    const piv = this.worldToScreen(this.frozen ? this.frozen.center : app.tangentialPlane()!.pivot, pl)!;
    o.strokeStyle = 'rgba(255,122,182,0.5)';
    o.setLineDash([4, 4]);
    o.lineWidth = 1;
    o.beginPath();
    o.moveTo(piv[0], 0);
    o.lineTo(piv[0], this.h);
    o.stroke();
    o.setLineDash([]);
    this.drawImplantAxes(o);
    const sel = app.selectedImplant();
    drawLabel(o, `${app.tangAngle.toFixed(0)}°`, this.w - 34, 16, TANG_COLOR, 'right');
    drawLabel(o, sel ? `around ${sel.name} – scroll to rotate` : 'scroll to rotate 360°', 8, this.h - 10, '#9fb0c8');
    // compass: angle indicator
    const cx = this.w - 22;
    const cy = 46;
    o.strokeStyle = 'rgba(255,255,255,0.4)';
    o.beginPath();
    o.arc(cx, cy, 12, 0, Math.PI * 2);
    o.stroke();
    const a = (app.tangAngle * Math.PI) / 180;
    o.strokeStyle = TANG_COLOR;
    o.lineWidth = 2;
    o.beginPath();
    o.moveTo(cx - Math.cos(a) * 12, cy - Math.sin(a) * 12);
    o.lineTo(cx + Math.cos(a) * 12, cy + Math.sin(a) * 12);
    o.stroke();
    drawScaleBar(o, this.w, this.h, this.vs.scale);
  }
}

// ---------------------------------------------------------------------------
// Panoramic reconstruction along the curve
// ---------------------------------------------------------------------------

export class PanoView extends View {
  protected measureKind: 'plane' | 'pano' | null = 'pano';
  private editor = new ImplantEditor(this.app, {
    project: (w) => {
      const pr = this.project(w);
      return { x: pr.x, y: pr.y, depth: pr.off - this.app.panoOffset };
    },
    basis: (imp) => this.localBasis(imp),
    scale: () => this.vs.scale,
    radialAxial: (p, imp) => projectedRadialAxial(p, imp, (w) => this.project(w), this.vs.scale),
    hitBody: (p) => this.hitBody(p),
    visible: () => true,
    container: this.el,
  });

  private modeSeg: HTMLDivElement;

  constructor(app: App) {
    super(app, 'Panoramic', CURVE_COLOR);
    this.maxPixels = 320_000;
    // Slab / Slice switch inside the view
    this.modeSeg = document.createElement('div');
    this.modeSeg.className = 'view-seg';
    for (const m of ['slab', 'slice'] as const) {
      const b = document.createElement('button');
      b.dataset.mode = m;
      b.textContent = m === 'slab' ? 'Slab' : 'Slice';
      b.title = m === 'slab' ? 'Thick averaged panoramic (slab)' : 'Thin panoramic slice (Alt+wheel moves it buccal/lingual)';
      b.onclick = () => app.setPanoMode(m);
      this.modeSeg.append(b);
    }
    this.el.append(this.modeSeg);
  }

  override render() {
    for (const b of Array.from(this.modeSeg.children) as HTMLButtonElement[]) b.classList.toggle('active', b.dataset.mode === this.app.panoMode);
    this.modeSeg.style.display = this.app.curve ? '' : 'none';
    super.render();
  }

  protected measureScreen(w: Vec3): Pt | null {
    if (!this.app.curve) return null;
    const pr = this.project(w);
    return Math.abs(pr.off - this.app.panoOffset) < 1 ? [pr.x, pr.y] : null;
  }

  /** Distance measured on the developed panoramic surface. */
  protected measureDistance(a: Vec3, b: Vec3): number {
    const pa = this.project(a);
    const pb = this.project(b);
    const ca = toFrame(a, this.app.O, this.app.frame)[2];
    const cb = toFrame(b, this.app.O, this.app.frame)[2];
    return Math.hypot(pa.s - pb.s, ca - cb);
  }

  protected emptyMessage() {
    return this.app.vol ? 'Draw a panoramic curve in the axial view to see the panoramic reconstruction.' : 'No volume loaded';
  }

  /** screen x -> arc length */
  sAt(x: number) {
    return this.app.curve!.length / 2 + this.vs.panU + (x - this.w / 2) * this.vs.scale;
  }
  /** screen y -> frame height */
  cAt(y: number) {
    return -(this.vs.panV + (y - this.h / 2) * this.vs.scale);
  }
  xOf(s: number) {
    return this.w / 2 + (s - this.app.curve!.length / 2 - this.vs.panU) / this.vs.scale;
  }
  yOf(c: number) {
    return this.h / 2 + (-c - this.vs.panV) / this.vs.scale;
  }

  /** World point -> panoramic screen position (projection along the curve normal). */
  project(w: Vec3): { x: number; y: number; s: number; off: number } {
    const app = this.app;
    const f = toFrame(w, app.O, app.frame);
    const nr = app.curve!.nearest(f[0], f[1]);
    const cp = app.curve!.at(nr.s);
    const off = (f[0] - cp.p[0]) * cp.n[0] + (f[1] - cp.p[1]) * cp.n[1];
    return { x: this.xOf(nr.s), y: this.yOf(f[2]), s: nr.s, off };
  }

  worldAt(p: Pt): Vec3 | null {
    const app = this.app;
    if (!app.curve) return null;
    const cp = app.curve.at(this.sAt(p[0]));
    return fromFrame([cp.p[0] + cp.n[0] * app.panoOffset, cp.p[1] + cp.n[1] * app.panoOffset, this.cAt(p[1])], app.O, app.frame);
  }

  fit() {
    const app = this.app;
    const L = app.curve ? app.curve.length : 80;
    const hgt = app.crop.max[2] - app.crop.min[2];
    this.vs.scale = Math.max((L + 10) / Math.max(1, this.w), hgt / Math.max(1, this.h)) * 1.02;
    this.vs.panU = 0;
    this.vs.panV = -(app.crop.min[2] + app.crop.max[2]) / 2;
  }

  // Draft quality (fewer slab samples) while the geometry changes continuously.
  private draft = false;
  private lastBaseKey = '';
  private lastChange = 0;
  private refineTimer = 0;

  protected geometryKey(): string | null {
    const app = this.app;
    if (!app.curve) return null;
    const c = app.cropSpec();
    const base = JSON.stringify([app.curve.ctrl, app.frame, app.O, this.vs, this.w, this.h, app.panoThickness(), app.panoOffset, c && [c.min, c.max]]);
    if (base !== this.lastBaseKey) {
      const now = performance.now();
      if (this.lastBaseKey && now - this.lastChange < 300) {
        this.draft = true;
        clearTimeout(this.refineTimer);
        this.refineTimer = window.setTimeout(() => {
          this.draft = false;
          this.app.requestRender();
        }, 250);
      }
      this.lastChange = now;
      this.lastBaseKey = base;
    }
    return base + (this.draft ? '|draft' : '');
  }

  protected computeValues(out: Float32Array, w: number, h: number) {
    const app = this.app;
    const vol = app.vol!;
    const curve = app.curve!;
    const F = app.frame;
    const k = 1 / this.imgScale;
    const crop = app.cropSpec();
    const thick = app.panoThickness();
    let samples = thick > 0.2 ? Math.min(40, Math.max(2, Math.ceil(thick / Math.max(0.25, vol.minSpacing)))) : 1;
    if (this.draft) samples = Math.min(samples, 3);
    const c0 = this.cAt(0.5 * k);
    const dc = -this.vs.scale * k;
    const dp = scale(F[2], dc);
    for (let i = 0; i < w; i++) {
      const s = this.sAt((i + 0.5) * k);
      if (s < 0 || s > curve.length) {
        for (let j = 0; j < h; j++) out[j * w + i] = vol.min;
        continue;
      }
      const cp = curve.at(s);
      const off = app.panoOffset;
      const p0 = fromFrame([cp.p[0] + cp.n[0] * off, cp.p[1] + cp.n[1] * off, c0], app.O, F);
      const nW = add(scale(F[0], cp.n[0]), scale(F[1], cp.n[1]));
      const slab: SlabSpec | null = samples > 1 ? { dir: nW, thickness: thick, samples, mode: 'avg' } : null;
      sampleLine(vol, out, i, w, h, p0, dp, crop, slab, vol.min);
    }
  }

  protected composeExtraKey() {
    return '';
  }

  // ---- interaction --------------------------------------------------------

  /** Local in-plane basis at an implant: u = curve tangent, v = down. */
  private localBasis(imp: Implant): { u: Vec3; v: Vec3; n: Vec3 } {
    const app = this.app;
    const pr = this.project(imp.center);
    const cp = app.curve!.at(pr.s);
    const F = app.frame;
    const u = normalize(add(scale(F[0], cp.t[0]), scale(F[1], cp.t[1])));
    const v = neg(F[2]);
    return { u, v, n: cross(u, v) };
  }

  private partEnds(c: Cylinder) {
    const a = this.project(addScaled(c.center, c.axis, c.half));
    const b = this.project(addScaled(c.center, c.axis, -c.half));
    return { a, b };
  }

  private hitBody(p: Pt): Implant | null {
    for (const part of this.app.allParts()) {
      const { a, b } = this.partEnds(part);
      const rpx = part.radius / this.vs.scale + 3;
      if (distToSegment2(p[0], p[1], a.x, a.y, b.x, b.y) <= rpx) return part.implant;
    }
    return null;
  }

  private draggingPos = false;

  protected onLeftDown(p: Pt): boolean {
    const app = this.app;
    if (!app.curve) return false;
    if (app.placing) {
      app.placeImplantAt(this.worldAt(p)!);
      return false;
    }
    const wasSelected = app.selectedId;
    if (this.editor.start(p)) {
      // snap the cross-sections to a newly selected implant
      if (app.selectedId !== wasSelected) app.selectImplant(app.selectedId, true);
      return true;
    }
    this.draggingPos = true;
    this.setPos(p);
    return true;
  }

  private setPos(p: Pt) {
    const app = this.app;
    app.s = Math.max(0, Math.min(app.curve!.length, this.sAt(p[0])));
    app.focusC = this.cAt(p[1]);
    app.changed();
  }

  protected onLeftDrag(p: Pt, last: Pt) {
    if (this.editor.move(p, last)) return;
    if (this.draggingPos) this.setPos(p);
  }

  protected onLeftUp() {
    this.editor.end();
    this.draggingPos = false;
  }

  protected onHover(p: Pt) {
    if (!this.app.curve) return;
    this.el.style.cursor = this.editor.hoverCursor(p) ?? (this.app.placing ? 'crosshair' : 'col-resize');
  }

  protected onScroll(dir: number, _p: Pt, e: WheelEvent) {
    if (e.altKey) {
      // shift the panoramic layer buccal/lingual
      this.app.panoOffset += dir * 0.5;
      this.app.changed();
      return;
    }
    this.app.moveAlongCurve(dir);
  }

  protected drawOverlay(o: CanvasRenderingContext2D) {
    const app = this.app;
    const curve = app.curve!;
    // cross-section markers
    for (let k = 0; k < 3; k++) {
      const x = this.xOf(app.crossS(k));
      o.strokeStyle = k === 1 ? 'rgba(255,255,255,0.9)' : 'rgba(195,140,255,0.8)';
      o.lineWidth = k === 1 ? 1.5 : 1;
      o.beginPath();
      o.moveTo(x, 0);
      o.lineTo(x, this.h);
      o.stroke();
    }
    // level
    const y = this.yOf(app.focusC);
    o.strokeStyle = 'rgba(232,82,74,0.6)';
    o.setLineDash([5, 5]);
    o.beginPath();
    o.moveTo(0, y);
    o.lineTo(this.w, y);
    o.stroke();
    o.setLineDash([]);
    // implants + abutments (projected along the curve normal)
    const tops = new Map<number, { x: number; y: number }>();
    for (const part of app.allParts()) {
      const imp = part.implant;
      const { a, b } = this.partEnds(part);
      const sel = imp.id === app.selectedId;
      const isImp = part.kind === 'implant';
      const col = isImp ? (sel ? IMPLANT_SELECTED_COLOR : IMPLANT_COLOR) : sel ? ABUTMENT_SELECTED_COLOR : ABUTMENT_COLOR;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l;
      const ny = dx / l;
      const r = part.radius / this.vs.scale;
      o.beginPath();
      o.moveTo(a.x + nx * r, a.y + ny * r);
      o.lineTo(b.x + nx * r, b.y + ny * r);
      o.lineTo(b.x - nx * r, b.y - ny * r);
      o.lineTo(a.x - nx * r, a.y - ny * r);
      o.closePath();
      o.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${isImp ? 0.35 : 0.5})`;
      o.strokeStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      o.lineWidth = sel ? 2 : 1.5;
      o.fill();
      o.stroke();
      if (isImp) {
        // platform marker
        const pf = this.project(platformOf(imp));
        o.beginPath();
        o.moveTo(pf.x + nx * r, pf.y + ny * r);
        o.lineTo(pf.x - nx * r, pf.y - ny * r);
        o.lineWidth = 3;
        o.stroke();
      }
      const t = tops.get(imp.id);
      const ymin = Math.min(a.y, b.y) - r * 0.3;
      if (!t || ymin < t.y) tops.set(imp.id, { x: (a.x + b.x) / 2, y: ymin });
    }
    this.editor.draw(o);
    for (const imp of app.implants) {
      const t = tops.get(imp.id)!;
      const sel = imp.id === app.selectedId;
      const col = sel ? IMPLANT_SELECTED_COLOR : IMPLANT_COLOR;
      drawLabel(o, imp.name.replace('Implant ', '#'), t.x, t.y - 8, `rgb(${col[0]},${col[1]},${col[2]})`, 'center');
    }
    // angulation between neighbouring implants
    for (const jaw of ['upper', 'lower'] as const) {
      const ordered = app.implants
        .filter((imp) => app.implantJaw(imp) === jaw)
        .map((imp) => ({ imp, x: this.project(imp.center).x }))
        .sort((a, b) => a.x - b.x);
      for (let i = 0; i + 1 < ordered.length; i++) {
        const A = ordered[i].imp;
        const B = ordered[i + 1].imp;
        const ta = tops.get(A.id)!;
        const tb = tops.get(B.id)!;
        const ang = app.implantAngle(A, B);
        const ab = A.abutment || B.abutment ? app.angleTable().find((r) => (r.a === A && r.b === B) || (r.a === B && r.b === A)) : null;
        const text = `${ang.toFixed(1)}°` + (ab && ab.abutment !== null ? ` (MUA ${ab.abutment.toFixed(1)}°)` : '');
        drawLabel(o, text, (ta.x + tb.x) / 2, Math.min(ta.y, tb.y) - 26, '#ffe08a', 'center');
      }
    }
    // tangential pivot
    const tp = app.tangentialPlane();
    if (tp) {
      const pr = this.project(tp.pivot);
      o.strokeStyle = TANG_COLOR;
      o.lineWidth = 1.5;
      o.beginPath();
      o.arc(pr.x, pr.y, 5, 0, Math.PI * 2);
      o.stroke();
    }
    drawLabel(o, 'R', this.xOf(0) + 6, this.h - 10, '#9fb0c8');
    drawLabel(o, 'L', this.xOf(curve.length) - 6, this.h - 10, '#9fb0c8', 'right');
    drawLabel(
      o,
      `${app.panoMode === 'slab' ? 'slab' : 'slice'} ${app.panoThickness().toFixed(1)} mm${app.panoOffset ? ` · offset ${app.panoOffset.toFixed(1)} mm` : ''} · length ${curve.length.toFixed(0)} mm`,
      this.w - 34,
      16,
      '#9fb0c8',
      'right',
    );
    drawScaleBar(o, this.w, this.h, this.vs.scale);
  }
}

function drawScaleBar(o: CanvasRenderingContext2D, w: number, h: number, mmPerPx: number) {
  const target = 80 * mmPerPx;
  const steps = [1, 2, 5, 10, 20, 50];
  const mm = steps.find((s) => s >= target * 0.6) ?? 50;
  const px = mm / mmPerPx;
  const x1 = w - 12;
  const y = h - 12;
  o.strokeStyle = 'rgba(255,255,255,0.75)';
  o.lineWidth = 1.5;
  o.beginPath();
  o.moveTo(x1 - px, y - 4);
  o.lineTo(x1 - px, y);
  o.lineTo(x1, y);
  o.lineTo(x1, y - 4);
  o.stroke();
  o.font = '11px system-ui, sans-serif';
  o.fillStyle = 'rgba(255,255,255,0.75)';
  o.textAlign = 'center';
  o.fillText(`${mm} mm`, x1 - px / 2, y - 6);
  o.textAlign = 'left';
}

