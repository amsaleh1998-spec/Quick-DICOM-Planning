import type { App } from '../app';
import { Implant, MUA_HEAD_HEIGHT, apexOf, platformOf, setImplantAxis, setImplantLength } from '../implant';
import { Vec3, add, addScaled, clamp, rotate, scale } from '../math';
import type { Pt } from './View';

export type EditMode = 'move' | 'rotCoronal' | 'rotApical' | 'diameter' | 'length';

/** What the editor needs to know about a view. */
export interface ImplantViewAdapter {
  /** world -> screen (CSS px) plus signed distance from the view surface (mm) */
  project(w: Vec3): { x: number; y: number; depth: number };
  /** world directions of screen +x / +y at the implant, and the view normal */
  basis(imp: Implant): { u: Vec3; v: Vec3; n: Vec3 };
  /** mm per CSS pixel */
  scale(): number;
  /** distance of the screen point from the implant axis and its axial coordinate (from centre, + = apical) */
  radialAxial(p: Pt, imp: Implant): { rad: number; h: number };
  /** implant whose body/abutment is under the point */
  hitBody(p: Pt): Implant | null;
  /** whether the implant is cut by / relevant for this view (guides and handles) */
  visible(imp: Implant): boolean;
}

const HANDLE_R = 7;

/**
 * Shared implant interaction: move, rotate with coronal/apical handles placed
 * beyond the implant, resize diameter by dragging the side outline and length
 * by dragging the apical end.
 */
export class ImplantEditor {
  private drag: { imp: Implant; mode: EditMode; basis: { u: Vec3; v: Vec3; n: Vec3 } } | null = null;

  constructor(
    private app: App,
    private ad: ImplantViewAdapter,
  ) {}

  get active() {
    return this.drag !== null;
  }

  /** Distance of the rotation handles beyond the coronal / apical ends (mm). */
  private handleOffsets(imp: Implant): [number, number] {
    const minMm = 16 * this.ad.scale();
    const coronalExtra = imp.abutment ? imp.abutment.gingivalHeight + MUA_HEAD_HEIGHT : 0;
    return [coronalExtra + Math.max(2.5, minMm), Math.max(2.5, minMm)];
  }

  handles(imp: Implant): { coronal: Vec3; apical: Vec3 } {
    const [oc, oa] = this.handleOffsets(imp);
    return {
      coronal: addScaled(platformOf(imp), imp.axis, -oc),
      apical: addScaled(apexOf(imp), imp.axis, oa),
    };
  }

  hit(p: Pt): { imp: Implant; mode: EditMode } | null {
    const app = this.app;
    const sel = app.selectedImplant();
    if (sel && this.ad.visible(sel)) {
      const hd = this.handles(sel);
      for (const [w, mode] of [
        [hd.coronal, 'rotCoronal'],
        [hd.apical, 'rotApical'],
      ] as [Vec3, EditMode][]) {
        const s = this.ad.project(w);
        if (Math.hypot(s.x - p[0], s.y - p[1]) <= HANDLE_R + 3) return { imp: sel, mode };
      }
      const tol = 5 * this.ad.scale();
      const { rad, h } = this.ad.radialAxial(p, sel);
      const r = sel.diameter / 2;
      const hl = sel.length / 2;
      if (Math.abs(h - hl) < tol && rad < r + tol) return { imp: sel, mode: 'length' };
      if (Math.abs(rad - r) < tol && h > -hl && h < hl - tol * 0.5) return { imp: sel, mode: 'diameter' };
    }
    const imp = this.ad.hitBody(p);
    return imp ? { imp, mode: 'move' } : null;
  }

  cursorFor(mode: EditMode, imp: Implant): string {
    if (mode === 'move') return 'move';
    if (mode === 'rotCoronal' || mode === 'rotApical') return 'grab';
    const a = this.ad.project(platformOf(imp));
    const b = this.ad.project(apexOf(imp));
    const vertical = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
    if (mode === 'length') return vertical ? 'ns-resize' : 'ew-resize';
    return vertical ? 'ew-resize' : 'ns-resize';
  }

  /** Returns true when a drag started. */
  start(p: Pt): boolean {
    const hit = this.hit(p);
    if (!hit) return false;
    this.drag = { imp: hit.imp, mode: hit.mode, basis: this.ad.basis(hit.imp) };
    this.app.selectImplant(hit.imp.id, false);
    return true;
  }

  move(p: Pt, last: Pt): boolean {
    const d = this.drag;
    if (!d) return false;
    const imp = d.imp;
    const sc = this.ad.scale();
    switch (d.mode) {
      case 'move':
        imp.center = add(imp.center, add(scale(d.basis.u, (p[0] - last[0]) * sc), scale(d.basis.v, (p[1] - last[1]) * sc)));
        break;
      case 'rotCoronal':
      case 'rotApical': {
        // coronal handle pivots around the apex, apical handle around the platform
        const pivotW = d.mode === 'rotCoronal' ? apexOf(imp) : platformOf(imp);
        const c = this.ad.project(pivotW);
        let da = Math.atan2(p[1] - c.y, p[0] - c.x) - Math.atan2(last[1] - c.y, last[0] - c.x);
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        const axis = rotate(imp.axis, d.basis.n, da);
        if (d.mode === 'rotApical') setImplantAxis(imp, axis);
        else {
          imp.axis = axis;
          imp.center = addScaled(pivotW, axis, -imp.length / 2);
        }
        break;
      }
      case 'diameter': {
        const { rad } = this.ad.radialAxial(p, imp);
        imp.diameter = clamp(Math.round(rad * 2 * 10) / 10, 2.5, 9);
        break;
      }
      case 'length': {
        const { h } = this.ad.radialAxial(p, imp);
        setImplantLength(imp, clamp(Math.round((h + imp.length / 2) * 2) / 2, 4, 25));
        break;
      }
    }
    this.app.implantChanged(imp);
    return true;
  }

  end(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    this.app.implantChanged(null, true);
    return true;
  }

  /** Cursor for hovering; returns null when nothing is under the mouse. */
  hoverCursor(p: Pt): string | null {
    const hit = this.hit(p);
    return hit ? this.cursorFor(hit.mode, hit.imp) : null;
  }

  /** Dashed axis through every visible implant and rotation handles for the selected one. */
  draw(o: CanvasRenderingContext2D) {
    const app = this.app;
    for (const imp of app.implants) {
      if (!this.ad.visible(imp)) continue;
      const sel = imp.id === app.selectedId;
      const hd = this.handles(imp);
      const ext = 2;
      const a = this.ad.project(sel ? hd.coronal : addScaled(platformOf(imp), imp.axis, -ext));
      const b = this.ad.project(sel ? hd.apical : addScaled(apexOf(imp), imp.axis, ext));
      if (Math.hypot(a.x - b.x, a.y - b.y) < 6) continue; // axis points at the viewer
      o.save();
      o.lineWidth = 1.2;
      o.setLineDash([6, 4]);
      o.strokeStyle = 'rgba(0,0,0,0.6)';
      o.lineWidth = 3;
      o.beginPath();
      o.moveTo(a.x, a.y);
      o.lineTo(b.x, b.y);
      o.stroke();
      o.strokeStyle = sel ? '#ffe9b0' : 'rgba(220,255,230,0.9)';
      o.lineWidth = 1.2;
      o.stroke();
      o.restore();
      if (!sel) continue;
      for (const [w, label] of [
        [hd.coronal, 'C'],
        [hd.apical, 'A'],
      ] as [Vec3, string][]) {
        const s = this.ad.project(w);
        o.beginPath();
        o.arc(s.x, s.y, HANDLE_R, 0, Math.PI * 2);
        o.fillStyle = 'rgba(20,24,32,0.85)';
        o.fill();
        o.strokeStyle = '#ffb81c';
        o.lineWidth = 2;
        o.stroke();
        // small rotation arrow
        o.beginPath();
        o.arc(s.x, s.y, HANDLE_R + 4, -2.2, -0.3);
        o.strokeStyle = 'rgba(255,184,28,0.8)';
        o.lineWidth = 1.5;
        o.stroke();
        const ex = s.x + Math.cos(-0.3) * (HANDLE_R + 4);
        const ey = s.y + Math.sin(-0.3) * (HANDLE_R + 4);
        o.beginPath();
        o.moveTo(ex - 4, ey - 3);
        o.lineTo(ex, ey);
        o.lineTo(ex + 1, ey - 5);
        o.stroke();
        o.font = '600 9px system-ui, sans-serif';
        o.fillStyle = '#ffb81c';
        o.textAlign = 'center';
        o.fillText(label, s.x, s.y + 3);
        o.textAlign = 'left';
      }
    }
  }
}

/** Screen-space radial/axial coordinates for projected views (e.g. panoramic). */
export function projectedRadialAxial(
  p: Pt,
  imp: Implant,
  project: (w: Vec3) => { x: number; y: number },
  mmPerPx: number,
): { rad: number; h: number } {
  const a = project(platformOf(imp));
  const b = project(apexOf(imp));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lpx = Math.hypot(dx, dy) || 1;
  const t = ((p[0] - a.x) * dx + (p[1] - a.y) * dy) / (lpx * lpx);
  const perp = Math.abs((p[0] - a.x) * dy - (p[1] - a.y) * dx) / lpx;
  // map along-axis pixels back to mm using the projected length
  return { rad: perp * mmPerPx, h: (t - 0.5) * imp.length };
}

