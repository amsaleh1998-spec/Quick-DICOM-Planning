// Waxup editing with the mouse, in the 3D view and in the slices (exocad-style):
//   Position: drag = move in the view plane, Shift+drag = scale, Ctrl+drag = rotate around the
//             view axis; single tooth or whole jaw, with chain mode and mirroring.
//   Parts:    drag a cusp / incisal-edge dot = move that part (Shift = scale it, Ctrl = rotate it).
//   Freeform: drag over a tooth (3D view) = add material, Ctrl = remove, Shift = smooth.

import type { App } from '../app';
import { Vec3, normalize, sub } from '../math';
import { applyV } from '../register';
import { PartDrag, applyPart, brush, startPart } from '../waxup/sculpt';
import {
  ChainLink,
  WaxTooth,
  Waxup,
  beginGeometryEdit,
  chainLinks,
  repackChain,
  rotateScaleAbout,
  toLibDir,
  toLibPoint,
  translation,
} from '../waxup/waxup';
import { contralateral } from '../waxup/library';
import type { Pt } from './View';

/** What the editor needs to know about a view. */
export interface WaxViewAdapter {
  /** tooth under the screen point and the world point there */
  pick(p: Pt): { fdi: number; w: Vec3 } | null;
  /** world point under the screen point, in the plane through `anchor` that faces the viewer */
  planePoint(p: Pt, anchor: Vec3): Vec3 | null;
  /** screen position of a world point */
  project(w: Vec3): Pt | null;
  /** unit axis into the screen at a world point */
  viewAxis(w: Vec3): Vec3;
  /** whether a world point lies close enough to the view surface to show a handle there */
  near(w: Vec3): boolean;
  /** mm per screen pixel at a world point */
  mmPerPx(w: Vec3): number;
  /** freeform sculpting works here (3D view) */
  sculpt: boolean;
}

type Drag =
  | { kind: 'move' | 'rotate' | 'scale'; tooth: WaxTooth; jaw: boolean; anchor: Vec3; center: Vec3; last: Pt; links: ChainLink[] | null; mirror: boolean }
  | { kind: 'part'; mode: 'move' | 'rotate' | 'scale'; tooth: WaxTooth; pd: PartDrag; tipW: Vec3; start: Pt; axis: Vec3 }
  | { kind: 'brush'; mode: 'add' | 'remove' | 'smooth'; tooth: WaxTooth; lastW: Vec3 };

const HANDLE_PX = 9;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;

export class WaxupEditor {
  private drag: Drag | null = null;
  /** cursor position over a tooth (brush outline) */
  private hoverAt: Vec3 | null = null;

  constructor(
    private app: App,
    private ad: WaxViewAdapter,
  ) {}

  get active() {
    return this.drag !== null;
  }

  private get w() {
    return this.app.wax;
  }
  private get m(): Waxup {
    return this.app.wax.model;
  }

  /** Part handle (cusp dot) under the screen point, of the selected or hovered tooth. */
  private partAt(p: Pt): { fdi: number; i: number } | null {
    const ids = [this.w.selected, this.w.hover].filter((x): x is number => x !== null);
    for (const fdi of ids) {
      const t = this.m.tooth(fdi);
      if (!t) continue;
      const tips = this.m.partTips(t);
      for (let i = 0; i < tips.length; i++) {
        const tw = applyV(t.T, tips[i]);
        if (!this.ad.near(tw)) continue;
        const s = this.ad.project(tw);
        if (s && Math.hypot(s[0] - p[0], s[1] - p[1]) <= HANDLE_PX) return { fdi, i };
      }
    }
    return null;
  }

  /** Mouse over the view (no button): hover highlight; returns the cursor, or null when not over a tooth. */
  hover(p: Pt): string | null {
    const w = this.w;
    if (w.tool === 'parts') {
      const part = this.partAt(p);
      const prev = JSON.stringify(w.hoverPart);
      w.hoverPart = part;
      const hit = part ? null : this.ad.pick(p);
      const hov = part?.fdi ?? hit?.fdi ?? null;
      if (hov !== w.hover || JSON.stringify(part) !== prev) {
        w.hover = hov;
        this.app.requestRender();
      }
      return part ? 'grab' : hit ? 'pointer' : null;
    }
    const hit = this.ad.pick(p);
    const fdi = hit?.fdi ?? null;
    if (fdi !== w.hover) {
      w.hover = fdi;
      this.app.requestRender();
    }
    if (w.tool === 'freeform' && this.ad.sculpt) {
      this.hoverAt = hit?.w ?? null;
      this.app.requestRender();
      return hit ? 'crosshair' : null;
    }
    return hit ? (w.tool === 'position' ? 'move' : 'pointer') : null;
  }

  leave() {
    if (this.w.hover !== null || this.hoverAt) {
      this.w.hover = null;
      this.hoverAt = null;
      this.app.requestRender();
    }
  }

  /** Button pressed: returns true when the waxup takes the drag. */
  start(p: Pt, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
    const w = this.w;
    const ctrl = e.ctrlKey || e.metaKey;
    const mode = ctrl ? 'rotate' : e.shiftKey ? 'scale' : 'move';
    if (w.tool === 'parts') {
      const part = this.partAt(p);
      if (part) {
        const t = this.m.tooth(part.fdi)!;
        w.selected = t.fdi;
        const tips = this.m.partTips(t);
        beginGeometryEdit(t);
        const tpl = this.m.template(t.fdi);
        const pd = startPart(t.pos, tips[part.i], tpl.partRadius);
        const tipW = applyV(t.T, tips[part.i]);
        this.drag = { kind: 'part', mode, tooth: t, pd, tipW, start: p, axis: toLibDir(t, this.ad.viewAxis(tipW)) };
        this.app.changed();
        return true;
      }
      const hit = this.ad.pick(p);
      if (!hit) return false;
      w.selected = hit.fdi; // shows its parts
      this.app.changed();
      return true;
    }
    const hit = this.ad.pick(p);
    if (!hit) return false;
    const t = this.m.tooth(hit.fdi)!;
    w.selected = t.fdi;
    if (w.tool === 'freeform') {
      if (!this.ad.sculpt) {
        this.app.onStatus('Freeform works in the 3D view – the slices show the result.', true);
        this.app.changed();
        return true;
      }
      beginGeometryEdit(t);
      const bm = ctrl ? 'remove' : e.shiftKey ? 'smooth' : 'add';
      this.drag = { kind: 'brush', mode: bm, tooth: t, lastW: hit.w };
      this.dab(t, hit.w, bm);
      this.app.changed();
      return true;
    }
    // position
    const jaw = w.scope === 'jaw';
    const center = jaw ? this.m.jawCenter(t.jaw)! : this.m.center(t);
    const up = this.app.frame[2];
    const links = !jaw && w.chain ? chainLinks(this.m, t.jaw, up) : null;
    this.drag = { kind: mode, tooth: t, jaw, anchor: hit.w, center, last: p, links, mirror: !jaw && w.mirror };
    this.app.changed();
    return true;
  }

  move(p: Pt) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'brush') {
      const hit = this.ad.pick(p);
      if (!hit || hit.fdi !== d.tooth.fdi) return;
      const r = this.w.brushRadius;
      if (Math.hypot(hit.w[0] - d.lastW[0], hit.w[1] - d.lastW[1], hit.w[2] - d.lastW[2]) < r * 0.25) return;
      this.dab(d.tooth, hit.w, d.mode);
      d.lastW = hit.w;
      this.hoverAt = hit.w;
      this.app.changed();
      return;
    }
    if (d.kind === 'part') {
      const t = d.tooth;
      let dl: Vec3 = [0, 0, 0];
      let s = 1;
      let angle = 0;
      const cs = this.ad.project(d.tipW);
      if (d.mode === 'move') {
        const a = this.ad.planePoint(d.start, d.tipW), b = this.ad.planePoint(p, d.tipW);
        if (a && b) dl = toLibDir(t, sub(b, a));
      } else if (cs) {
        const r0 = Math.hypot(d.start[0] - cs[0], d.start[1] - cs[1]), r1 = Math.hypot(p[0] - cs[0], p[1] - cs[1]);
        if (d.mode === 'scale') s = Math.min(2, Math.max(0.4, Math.exp((r1 - r0) / 120)));
        else angle = Math.atan2(p[1] - cs[1], p[0] - cs[0]) - Math.atan2(d.start[1] - cs[1], d.start[0] - cs[0]);
      }
      applyPart(t.pos, d.pd, dl, s, d.axis, angle);
      t.ver = (t.ver ?? 0) + 1;
      this.app.changed();
      return;
    }
    // position: incremental from the last mouse position
    const t = d.tooth;
    const m = this.m;
    let D: number[] | null = null;
    const cs = this.ad.project(d.center);
    if (d.kind === 'move') {
      const a = this.ad.planePoint(d.last, d.anchor), b = this.ad.planePoint(p, d.anchor);
      if (a && b) {
        const dv = sub(b, a);
        D = translation(dv);
        d.anchor = [d.anchor[0] + dv[0], d.anchor[1] + dv[1], d.anchor[2] + dv[2]];
        d.center = [d.center[0] + dv[0], d.center[1] + dv[1], d.center[2] + dv[2]];
      }
    } else if (cs) {
      const axis = this.ad.viewAxis(d.center);
      if (d.kind === 'rotate') {
        const angle = Math.atan2(p[1] - cs[1], p[0] - cs[0]) - Math.atan2(d.last[1] - cs[1], d.last[0] - cs[0]);
        D = rotateScaleAbout(d.center, axis, angle, 1);
      } else {
        // away from the centre = larger, about 10 % per 25 px
        const r0 = Math.hypot(d.last[0] - cs[0], d.last[1] - cs[1]), r1 = Math.hypot(p[0] - cs[0], p[1] - cs[1]);
        let f = Math.exp((r1 - r0) / 250);
        const cur = Waxup.scaleOf(t);
        f = Math.min(MAX_SCALE / cur, Math.max(MIN_SCALE / cur, f));
        D = rotateScaleAbout(d.center, axis, 0, f);
      }
    }
    d.last = p;
    if (!D) return;
    if (d.jaw) m.transformJaw(t.jaw, D);
    else {
      m.transformTooth(t, D, d.mirror);
      if (d.links) {
        repackChain(d.links, t);
        const other = d.mirror ? m.tooth(contralateral(t.fdi)) : null;
        if (other) repackChain(d.links, other);
      }
    }
    this.app.changed();
  }

  end() {
    this.drag = null;
    this.app.changed();
  }

  /** One brush dab at a world point. */
  private dab(t: WaxTooth, wp: Vec3, mode: 'add' | 'remove' | 'smooth') {
    const s = Waxup.scaleOf(t);
    const r = this.w.brushRadius / s;
    const st = this.w.brushStrength;
    const amount = mode === 'smooth' ? 0.25 + st * 0.6 : (0.02 + st * 0.1) / s;
    brush(t.pos, t.idx, toLibPoint(t, wp), r, amount, mode);
    t.ver = (t.ver ?? 0) + 1;
  }

  /** Part handles and the brush outline. */
  draw(o: CanvasRenderingContext2D) {
    const w = this.w;
    if (!w.editing) return;
    if (w.tool === 'parts') {
      const drawn = new Set<number>();
      for (const fdi of [w.selected, w.hover]) {
        if (fdi === null || drawn.has(fdi)) continue;
        drawn.add(fdi);
        const t = this.m.tooth(fdi);
        if (!t || !w.visible[t.jaw]) continue;
        this.m.partTips(t).forEach((tip, i) => {
          const tw = applyV(t.T, tip);
          if (!this.ad.near(tw)) return;
          const s = this.ad.project(tw);
          if (!s) return;
          const hot = w.hoverPart?.fdi === fdi && w.hoverPart.i === i;
          o.beginPath();
          o.arc(s[0], s[1], hot ? 7 : 5, 0, Math.PI * 2);
          o.fillStyle = hot ? '#5ab4ff' : 'rgba(90,180,255,0.75)';
          o.fill();
          o.lineWidth = 2;
          o.strokeStyle = 'rgba(0,0,0,0.7)';
          o.stroke();
        });
      }
    }
    if (w.tool === 'freeform' && this.ad.sculpt && this.hoverAt) {
      const s = this.ad.project(this.hoverAt);
      if (s) {
        const r = w.brushRadius / this.ad.mmPerPx(this.hoverAt);
        o.beginPath();
        o.arc(s[0], s[1], r, 0, Math.PI * 2);
        o.lineWidth = 1.5;
        o.strokeStyle = 'rgba(255,255,255,0.85)';
        o.setLineDash([4, 3]);
        o.stroke();
        o.setLineDash([]);
      }
    }
  }
}

/** Unit axis into the screen for a view with screen axes u (right) and v (down). */
export const intoScreen = (u: Vec3, v: Vec3): Vec3 => normalize([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
