import type { App } from '../app';
import {
  Implant,
  MAX_IMPLANT_LENGTH,
  MUA_HEAD_HEIGHT,
  apexOf,
  apicalDiameterOf,
  implantRadiusAt,
  isTapered,
  platformOf,
  setApicalDiameter,
  setCoronalDiameter,
  setImplantAxis,
  setImplantLength,
} from '../implant';
import { findModel, modelId, nearestSize } from '../implantLibrary';
import { Vec3, add, addScaled, clamp, rotate, scale } from '../math';
import type { Pt } from './View';

export type EditMode = 'move' | 'rotCoronal' | 'rotApical' | 'diameter' | 'apicalDiameter' | 'length';

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
  /** element the live dimension badge is placed in */
  container: HTMLElement;
}

type DimKind = 'diameter' | 'apicalDiameter' | 'length';
/** dimension changes per mm of mouse travel (lower = finer control) */
const DIM_GAIN = 0.5;
const BADGE_MS = 5000;

const HANDLE_R = 7;

/**
 * Shared implant interaction: move, rotate with coronal/apical handles placed
 * beyond the implant, resize diameter by dragging the side outline and length
 * by dragging the apical end.
 */
export class ImplantEditor {
  private drag: {
    imp: Implant;
    mode: EditMode;
    basis: { u: Vec3; v: Vec3; n: Vec3 };
    /** value and mouse measure at drag start (relative, damped dimension changes) */
    startValue: number;
    startMeasure: number;
    /** library model at the start of a resize (sizes snap to the system) */
    model: ReturnType<typeof findModel>;
  } | null = null;
  // live dimension badge
  private badge: HTMLDivElement | null = null;
  private badgeState: { imp: Implant; kind: DimKind; editing: boolean } | null = null;
  private hideTimer = 0;

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
    if (sel && !sel.hidden && this.ad.visible(sel)) {
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
      const hl = sel.length / 2;
      const rApex = apicalDiameterOf(sel) / 2;
      if (Math.abs(h - hl) < tol && rad < rApex + tol) return { imp: sel, mode: 'length' };
      // side outline (follows the taper): apical half edits the apex of a tapered implant
      if (Math.abs(rad - implantRadiusAt(sel, h)) < tol && h > -hl && h < hl - tol * 0.5)
        return { imp: sel, mode: isTapered(sel) && h > 0 && !sel.lib ? 'apicalDiameter' : 'diameter' };
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
    // diameter and apicalDiameter
    return vertical ? 'ew-resize' : 'ns-resize';
  }

  /** Returns true when a drag started. */
  start(p: Pt): boolean {
    const hit = this.hit(p);
    if (!hit) return false;
    const imp = hit.imp;
    let startValue = 0;
    let startMeasure = 0;
    if (hit.mode === 'diameter' || hit.mode === 'apicalDiameter' || hit.mode === 'length') {
      const ra = this.ad.radialAxial(p, imp);
      startValue = hit.mode === 'diameter' ? imp.diameter : hit.mode === 'apicalDiameter' ? apicalDiameterOf(imp) : imp.length;
      // diameters: distance from the axis; length: distance from the platform along the axis
      startMeasure = hit.mode === 'length' ? ra.h + imp.length / 2 : ra.rad;
      this.showBadge(imp, hit.mode);
    }
    this.drag = { imp, mode: hit.mode, basis: this.ad.basis(imp), startValue, startMeasure, model: imp.lib ? findModel(imp.lib.id) : null };
    this.app.selectImplant(imp.id, false);
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
        const v = d.startValue + 2 * (rad - d.startMeasure) * DIM_GAIN;
        // a library implant takes the system's size nearest to the dragged diameter
        if (d.model) this.snapModel(imp, d.model, d.model.size.d + (v - d.startValue), d.model.size.L, 'd');
        else setCoronalDiameter(imp, clamp(Math.round(v * 10) / 10, 2.5, 9));
        break;
      }
      case 'apicalDiameter': {
        const { rad } = this.ad.radialAxial(p, imp);
        const v = d.startValue + 2 * (rad - d.startMeasure) * DIM_GAIN;
        setApicalDiameter(imp, Math.round(v * 10) / 10);
        break;
      }
      case 'length': {
        const { h } = this.ad.radialAxial(p, imp);
        const v = d.startValue + (h + imp.length / 2 - d.startMeasure) * DIM_GAIN;
        if (d.model) this.snapModel(imp, d.model, d.model.size.d, d.model.size.L + (v - d.startValue), 'L');
        else setImplantLength(imp, clamp(Math.round(v * 2) / 2, 4, MAX_IMPLANT_LENGTH));
        break;
      }
    }
    this.app.implantChanged(imp);
    return true;
  }

  /** A library implant becomes the size of its system nearest to (d, L). */
  private snapModel(imp: Implant, m: NonNullable<ReturnType<typeof findModel>>, d: number, L: number, change: 'd' | 'L') {
    const z = nearestSize(m.system, d, L, change, m.size);
    const id = modelId(m.brand.name, m.system.name, z.label);
    if (id !== imp.lib?.id) this.app.applyModel(imp, id);
  }

  end(): boolean {
    if (!this.drag) return false;
    if (this.drag.mode === 'diameter' || this.drag.mode === 'apicalDiameter' || this.drag.mode === 'length') this.scheduleHide();
    this.drag = null;
    this.app.implantChanged(null, true);
    return true;
  }

  /** Cursor for hovering; returns null when nothing is under the mouse. */
  hoverCursor(p: Pt): string | null {
    const hit = this.hit(p);
    return hit ? this.cursorFor(hit.mode, hit.imp) : null;
  }

  // ---- live dimension badge --------------------------------------------------

  private showBadge(imp: Implant, kind: DimKind) {
    clearTimeout(this.hideTimer);
    if (this.badgeState?.editing) return;
    this.badgeState = { imp, kind, editing: false };
    if (!this.badge) {
      const b = document.createElement('div');
      b.className = 'dim-badge';
      b.title = 'Click to type a value';
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (!this.badgeState?.editing) {
          e.preventDefault();
          this.beginEdit();
        }
      });
      this.ad.container.append(b);
      this.badge = b;
    }
    this.badge.style.display = '';
    this.renderBadgeText();
  }

  private scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (!this.badgeState?.editing) this.hideBadge();
    }, BADGE_MS);
  }

  private hideBadge() {
    clearTimeout(this.hideTimer);
    this.badgeState = null;
    if (this.badge) {
      this.badge.style.display = 'none';
      this.badge.textContent = '';
    }
  }

  private renderBadgeText() {
    const st = this.badgeState;
    if (!st || !this.badge || st.editing) return;
    // a library implant: its size as the manufacturer names it (diameter × length from the file name)
    const m = st.imp.lib ? findModel(st.imp.lib.id) : null;
    if (m) {
      this.badge.textContent = `${m.system.name} ${m.size.label}`;
      return;
    }
    this.badge.textContent =
      st.kind === 'diameter'
        ? `Ø ${st.imp.diameter.toFixed(1)} mm${isTapered(st.imp) ? ' (platform)' : ''}`
        : st.kind === 'apicalDiameter'
          ? `Ø apex ${apicalDiameterOf(st.imp).toFixed(1)} mm`
          : `L ${st.imp.length.toFixed(1)} mm`;
  }

  private beginEdit() {
    const st = this.badgeState;
    const b = this.badge;
    if (!st || !b) return;
    clearTimeout(this.hideTimer);
    st.editing = true;
    const input = document.createElement('input');
    input.type = 'number';
    const isDia = st.kind !== 'length';
    input.step = isDia ? '0.1' : '0.5';
    input.min = st.kind === 'diameter' ? '2.5' : st.kind === 'apicalDiameter' ? '1.5' : '4';
    input.max = st.kind === 'diameter' ? '9' : st.kind === 'apicalDiameter' ? String(st.imp.diameter) : String(MAX_IMPLANT_LENGTH);
    const model = st.imp.lib ? findModel(st.imp.lib.id) : null;
    input.value = model
      ? String(st.kind === 'length' ? model.size.L : model.size.d)
      : (st.kind === 'diameter' ? st.imp.diameter : st.kind === 'apicalDiameter' ? apicalDiameterOf(st.imp) : st.imp.length).toFixed(1);
    b.textContent = st.kind === 'diameter' ? 'Ø ' : st.kind === 'apicalDiameter' ? 'Ø apex ' : 'L ';
    b.append(input, document.createTextNode(' mm'));
    b.classList.add('editing');
    let done = false;
    const finish = (apply: boolean) => {
      if (done) return;
      done = true;
      b.classList.remove('editing');
      const v = Number(input.value);
      if (apply && input.value !== '' && Number.isFinite(v) && model) {
        // a typed size of a library implant: the system's nearest one
        if (st.kind === 'length') this.snapModel(st.imp, model, model.size.d, v, 'L');
        else this.snapModel(st.imp, model, v, model.size.L, 'd');
        this.app.implantChanged(st.imp, true);
      } else if (apply && input.value !== '' && Number.isFinite(v)) {
        if (st.kind === 'diameter') setCoronalDiameter(st.imp, clamp(Math.round(v * 10) / 10, 2.5, 9));
        else if (st.kind === 'apicalDiameter') setApicalDiameter(st.imp, Math.round(v * 10) / 10);
        else setImplantLength(st.imp, clamp(Math.round(v * 10) / 10, 4, MAX_IMPLANT_LENGTH));
        this.app.implantChanged(st.imp, true);
      }
      this.hideBadge();
      this.app.requestRender();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
  }

  /** Position the badge next to the implant (called on every overlay redraw). */
  private placeBadge() {
    const st = this.badgeState;
    const b = this.badge;
    if (!st || !b) return;
    const imp = st.imp;
    if (!this.app.implants.includes(imp) || !this.ad.visible(imp)) {
      if (!st.editing) b.style.display = 'none';
      return;
    }
    b.style.display = '';
    const a = this.ad.project(platformOf(imp));
    const c = this.ad.project(apexOf(imp));
    let dx = c.x - a.x;
    let dy = c.y - a.y;
    let l = Math.hypot(dx, dy);
    if (l < 1) {
      dx = 1;
      dy = 0;
      l = 1;
    }
    dx /= l;
    dy /= l;
    // perpendicular pointing to the screen right where possible
    let px = -dy;
    let py = dx;
    if (px < 0) {
      px = -px;
      py = -py;
    }
    const rpx = imp.diameter / 2 / this.ad.scale();
    // clear of the implant and its handles, however wide the text (library sizes are longer)
    const gap = Math.max(40, (b.offsetWidth || 80) / 2 + 14);
    const mx = (a.x + c.x) / 2;
    const my = (a.y + c.y) / 2;
    let x: number, y: number;
    if (st.kind === 'diameter') {
      // beside the coronal half
      x = (mx + a.x) / 2 + px * (rpx + gap);
      y = (my + a.y) / 2 + py * (rpx + gap);
    } else if (st.kind === 'apicalDiameter') {
      // beside the apical half
      x = (mx + c.x) / 2 + px * (rpx + gap);
      y = (my + c.y) / 2 + py * (rpx + gap);
    } else {
      x = c.x - px * (rpx + gap) - dx * 4;
      y = c.y - py * (rpx + gap) - dy * 4;
    }
    b.style.left = `${Math.round(x)}px`;
    b.style.top = `${Math.round(y)}px`;
    this.renderBadgeText();
  }

  /** Dashed axis through every visible implant and rotation handles for the selected one. */
  draw(o: CanvasRenderingContext2D) {
    this.placeBadge();
    const app = this.app;
    for (const imp of app.implants) {
      if (imp.hidden || !this.ad.visible(imp)) continue;
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

