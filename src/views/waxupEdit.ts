// Waxup editing with the mouse, in the 3D view and in the slices, laid out like the tooth
// placement window of a dental CAD:
//   Simple:   drag = move (or the action chosen in the panel), Ctrl = rotate, Shift = scale,
//             Ctrl+Shift = scale in one direction; optionally limited to tooth directions; one
//             tooth or all teeth of the jaw.
//   Advanced: axis handles (drag = scale along that tooth axis), cusps (drag a dot = move it,
//             Shift = scale, Ctrl = rotate), freeform (add, Ctrl = remove, Shift = smooth; 3D view).
//   Chain:    chain / single / tube (see waxup/chain.ts). In 3D the tube, its end discs and a
//             control point per tooth and disc: click a point = pin / unpin, drag a disc = move
//             that end of the chain.
// Symmetry mirrors every change to the other side of the jaw; 1-to-1 mirroring makes the tooth on
// the other side the exact mirror image of the one changed.

import type { App } from '../app';
import { Vec3, add, cross, dot, length, normalize, scale, sub } from '../math';
import { Affine, applyV, axisAngle, compose, invert, rotV, rotateOnto } from '../register';
import { PartDrag, applyPart, brush, startPart } from '../waxup/sculpt';
import {
  WaxTooth,
  Waxup,
  beginGeometryEdit,
  mirrorPlane,
  newGeo,
  reflection,
  rotateScaleAbout,
  toLibDir,
  toLibPoint,
  toothKey,
  toothWorld,
  translation,
} from '../waxup/waxup';
import {
  ChainControls,
  ChainOp,
  ChainSnap,
  ToothAxes,
  applyChain,
  chainControls,
  chainOf,
  flipped,
  mirroredVertices,
  snapshot,
  toothAxes,
  toothPin,
  toothScale,
} from '../waxup/chain';
import { Jaw, contralateral } from '../waxup/library';
import { HeightField, cutTooth } from '../waxup/occlusion';
import { buildCutter } from '../waxup/waxApp';
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
  /** the 3D view: freeform sculpting, trackball rotation, chain controls */
  sculpt: boolean;
}

type Op = 'move' | 'rotate' | 'scale' | 'dirscale';

interface XformDrag {
  kind: 'xform';
  op: Op;
  tooth: WaxTooth;
  /** one tooth, the whole jaw, or the chain tab */
  ctx: 'tooth' | 'jaw' | 'chain';
  start: Pt;
  last: Pt;
  moved: boolean;
  anchor: Vec3;
  center: Vec3;
  cs: Pt | null;
  /** every tooth of the jaw at the start */
  T0: Map<WaxTooth, Affine>;
  adjust0: Affine | null;
  axes: ToothAxes;
  /** allowed directions / rotation axes (empty = free) */
  limit: Vec3[];
  /** rotation so far */
  R: number[];
  /** directional scaling: the axes (set once the drag has a direction) and its screen direction */
  dir: Vec3[] | null;
  sdir: Pt | null;
  chain: ChainSnap | null;
  gi: number;
  f: number;
  shown: { line?: [Vec3, Vec3[]]; arrows?: [Vec3, Vec3[], number]; label?: string } | null;
}

type Drag =
  | XformDrag
  | { kind: 'disc'; snap: ChainSnap; end: 'a' | 'b'; tooth: WaxTooth; start: Pt; anchor: Vec3; T0: Map<WaxTooth, Affine>; moved: boolean }
  | { kind: 'pin'; key: string; label: string; start: Pt; moved: boolean }
  | { kind: 'axis'; tooth: WaxTooth; axis: Vec3; center: Vec3; cs: Pt; sdir: Pt; r0: number; T0: Map<WaxTooth, Affine>; f: number }
  | { kind: 'part'; mode: 'move' | 'rotate' | 'scale'; tooth: WaxTooth; pd: PartDrag; tipW: Vec3; start: Pt; axis: Vec3; mirror: { t: WaxTooth; pd: PartDrag; axis: Vec3 } | null }
  | { kind: 'brush'; mode: 'add' | 'remove' | 'smooth'; tooth: WaxTooth; lastW: Vec3; other: WaxTooth | null }
  | { kind: 'noop' };

const HANDLE_PX = 9;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;
const AXIS_COLORS = ['#ff6b6b', '#5ad17a', '#5aa9ff'];

const mul3 = (A: number[], B: number[]) => {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return o;
};
const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Rotation matrix -> axis and angle. */
function toAxisAngle(R: number[]): { axis: Vec3; angle: number } {
  const c = Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2));
  const axis: Vec3 = [R[7] - R[5], R[2] - R[6], R[3] - R[1]];
  const l = length(axis);
  if (l < 1e-9) return { axis: [0, 0, 1], angle: 0 };
  return { axis: scale(axis, 1 / l), angle: Math.acos(c) };
}

/** Scaling by f along the given unit axes, about c. */
function scaleAlong(c: Vec3, axes: Vec3[], f: number): Affine {
  const M = I3();
  for (const a of axes) for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) M[r * 3 + k] += (f - 1) * a[r] * a[k];
  const t: Vec3 = [c[0] - (M[0] * c[0] + M[1] * c[1] + M[2] * c[2]), c[1] - (M[3] * c[0] + M[4] * c[1] + M[5] * c[2]), c[2] - (M[6] * c[0] + M[7] * c[1] + M[8] * c[2])];
  return [M[0], M[1], M[2], t[0], M[3], M[4], M[5], t[1], M[6], M[7], M[8], t[2]];
}

/**
 * A move in the view plane limited to one direction (the point on that line under the mouse) or
 * to a plane (where the mouse ray meets it; seen edge-on: the move without its off-plane part).
 */
function constrainMove(d: Vec3, axes: Vec3[], v: Vec3): Vec3 {
  if (!axes.length) return d;
  if (axes.length === 1) {
    const k = axes[0];
    const ks = sub(k, scale(v, dot(k, v)));
    const l2 = dot(ks, ks);
    return l2 < 0.05 ? [0, 0, 0] : scale(k, dot(d, ks) / l2);
  }
  const nrm = normalize(cross(axes[0], axes[1]));
  const vn = dot(v, nrm);
  if (Math.abs(vn) > 0.25) return sub(d, scale(v, dot(d, nrm) / vn));
  return sub(d, scale(nrm, dot(d, nrm)));
}

const quadrant = (fdi: number) => Math.floor(fdi / 10);

export class WaxupEditor {
  private drag: Drag | null = null;
  /** cursor position over a tooth (brush outline) */
  private hoverAt: Vec3 | null = null;
  private ctlCache: { key: string; ctl: ChainControls[] } | null = null;
  /** antagonist cutting during a drag: the teeth's vertices when it started, and their cut copies */
  private cutting: { hf: HeightField; gap: number; base: Map<WaxTooth, { pos: Float32Array; idx: Uint32Array; geo: number }>; own: Map<WaxTooth, number> } | null = null;

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

  // ---- chain controls (3D) ----------------------------------------------------------------

  private chainUi() {
    const w = this.w;
    return this.ad.sculpt && w.editing && w.tab === 'chain' && w.showChain;
  }

  private controls(): ChainControls[] {
    const w = this.w;
    const key = this.m.teeth.map(toothKey).join(';') + JSON.stringify(w.visible);
    if (this.ctlCache?.key !== key) this.ctlCache = { key, ctl: chainControls(this.m, (j) => w.visible[j]) };
    return this.ctlCache.ctl;
  }

  private discOutline(d: ChainControls['discs'][number]): Pt[] | null {
    const side = cross(d.normal, d.up);
    const out: Pt[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const s = this.ad.project(add(d.c, add(scale(d.up, Math.cos(a) * d.r), scale(side, Math.sin(a) * d.r))));
      if (!s) return null;
      out.push(s);
    }
    return out;
  }

  /** Control point or disc under the mouse. */
  private controlAt(p: Pt): { type: 'point'; key: string; label: string } | { type: 'disc'; key: string; chain: ChainControls; end: 'a' | 'b' } | null {
    for (const c of this.controls()) {
      for (const pt of c.points) {
        const s = this.ad.project(pt.w);
        if (s && Math.hypot(s[0] - p[0], s[1] - p[1]) <= HANDLE_PX) return { type: 'point', key: pt.key, label: `tooth ${pt.fdi}` };
      }
      for (const d of c.discs) {
        const s = this.ad.project(d.ctl);
        const end = d.end === 'a' ? c.teeth[0].fdi : c.teeth[c.teeth.length - 1].fdi;
        if (s && Math.hypot(s[0] - p[0], s[1] - p[1]) <= HANDLE_PX) return { type: 'point', key: d.key, label: `the chain end at ${end}` };
      }
    }
    for (const c of this.controls())
      for (const d of c.discs) {
        const poly = this.discOutline(d);
        if (poly && inside(poly, p)) return { type: 'disc', key: d.key, chain: c, end: d.end };
      }
    return null;
  }

  // ---- axis handles (Advanced) ----------------------------------------------------------------

  private axisTool() {
    const w = this.w;
    return w.editing && w.tab === 'advanced' && w.advTool === 'axis';
  }

  /** Handles of a tooth: both ends of its arch and buccal axes, the occlusal end of its long axis. */
  private axisHandles(t: WaxTooth): { axis: Vec3; i: number; k: number; p: Vec3 }[] {
    const ax = toothAxes(this.m, t);
    const c = this.m.center(t);
    const P = toothWorld(t).pos;
    const dirs: [Vec3, number][] = [
      [ax.md, 0],
      [scale(ax.md, -1), 0],
      [ax.bl, 1],
      [scale(ax.bl, -1), 1],
      [ax.oc, 2],
    ];
    return dirs.map(([d, i], k) => {
      let mx = 0;
      for (let j = 0; j < P.length; j += 3) mx = Math.max(mx, (P[j] - c[0]) * d[0] + (P[j + 1] - c[1]) * d[1] + (P[j + 2] - c[2]) * d[2]);
      return { axis: d, i, k, p: add(c, scale(d, mx + 1.5)) };
    });
  }

  private axisAt(p: Pt): { t: WaxTooth; h: { axis: Vec3; i: number; k: number; p: Vec3 } } | null {
    for (const fdi of [this.w.selected, this.w.hover]) {
      const t = this.m.tooth(fdi);
      if (!t || !this.w.visible[t.jaw]) continue;
      for (const h of this.axisHandles(t)) {
        if (!this.ad.near(h.p)) continue;
        const s = this.ad.project(h.p);
        if (s && Math.hypot(s[0] - p[0], s[1] - p[1]) <= HANDLE_PX) return { t, h };
      }
    }
    return null;
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

  // ---- hover ----------------------------------------------------------------------------------

  private setHoverCtl(key: string | null) {
    if (key !== this.w.hoverCtl) {
      this.w.hoverCtl = key;
      this.app.requestRender();
    }
  }

  /** Mouse over the view (no button): hover highlight; returns the cursor, or null when not over a tooth. */
  hover(p: Pt): string | null {
    const w = this.w;
    if (this.chainUi()) {
      const c = this.controlAt(p);
      if (c) {
        this.setHoverCtl(c.type === 'point' ? c.key : `disc:${c.key}`);
        this.setHover(null);
        if (c.type === 'point')
          this.app.onStatus(w.pins.has(c.key) ? `Click to unpin ${c.label}` : `Click to pin ${c.label}: it stays where it is while the chain changes`);
        else this.app.onStatus('End of the chain: drag to move it – the other end stays, the teeth in between follow');
        return c.type === 'point' ? 'pointer' : 'grab';
      }
    }
    if (this.axisTool() && (w.selected !== null || w.hover !== null)) {
      const a = this.axisAt(p);
      this.setHoverCtl(a ? `ax:${a.t.fdi}:${a.h.k}` : null);
      if (a) {
        this.app.onStatus(`Tooth ${a.t.fdi}: drag to scale it ${['along the arch', 'buccal / lingual', 'in height'][a.h.i]}`);
        return 'grab';
      }
    } else this.setHoverCtl(null);
    if (w.cusps) {
      const part = this.partAt(p);
      const prev = JSON.stringify(w.hoverPart);
      w.hoverPart = part;
      const hit = part ? null : this.ad.pick(p);
      const hov = part?.fdi ?? hit?.fdi ?? null;
      if (hov !== w.hover || JSON.stringify(part) !== prev) {
        if (hov !== w.hover) this.hint(hov);
        w.hover = hov;
        this.app.requestRender();
      }
      return part ? 'grab' : hit ? 'move' : null;
    }
    const hit = this.ad.pick(p);
    this.setHover(hit?.fdi ?? null);
    if (w.freeform && this.ad.sculpt) {
      this.hoverAt = hit?.w ?? null;
      this.app.requestRender();
      return hit ? 'crosshair' : null;
    }
    return hit ? 'move' : null;
  }

  private setHover(fdi: number | null) {
    if (fdi !== this.w.hover) {
      this.w.hover = fdi;
      this.hint(fdi);
      this.app.requestRender();
    }
  }

  /** Status line for the tooth under the mouse. */
  private hint(fdi: number | null) {
    if (fdi === null) return;
    const w = this.w;
    const keys = 'Ctrl: rotate · Shift: scale · Ctrl+Shift: scale in one direction';
    let how: string;
    if (w.tab === 'advanced')
      how =
        w.advTool === 'cusps'
          ? 'drag a blue dot to reshape a cusp · drag the tooth to move it'
          : w.advTool === 'freeform'
            ? this.ad.sculpt
              ? 'drag to add material · Ctrl: remove · Shift: smooth'
              : 'freeform works in the 3D view'
            : 'drag a coloured handle to scale along that axis · drag the tooth to move it';
    else if (w.tab === 'chain') {
      if (w.pins.has(toothPin(fdi))) how = 'pinned – click its red point to unpin it';
      else
        how = {
          chain: `drag to move the chain · ${keys}`,
          single: `drag to move this tooth – ${w.contact ? 'its neighbours stay in contact' : 'the others stay'} · ${keys}`,
          tube: 'drag to slide the teeth along the tube · Ctrl: rotate · Shift: scale',
        }[w.chainMode];
    } else {
      const act = { move: 'move', rotate: 'rotate', scale: 'scale' }[w.action];
      how = `drag to ${act}${w.moveAll ? ' all teeth of the jaw' : ''} · ${keys}`;
    }
    this.app.onStatus(`Tooth ${fdi}: ${how}`);
  }

  /** Mouse over a tooth while the Waxup panel is closed (3D view): highlight it, it can be grabbed. */
  peek(p: Pt): string | null {
    const fdi = this.ad.pick(p)?.fdi ?? null;
    if (fdi !== this.w.hover) {
      this.w.hover = fdi;
      if (fdi !== null) this.app.onStatus(`Tooth ${fdi}: drag to move · Shift+drag: scale · Ctrl+drag: rotate`);
      this.app.requestRender();
    }
    return fdi !== null ? 'move' : null;
  }

  leave() {
    if (this.w.hover !== null || this.hoverAt || this.w.hoverCtl !== null) {
      this.w.hover = null;
      this.w.hoverCtl = null;
      this.hoverAt = null;
      this.app.requestRender();
    }
  }

  // ---- press ------------------------------------------------------------------------------------

  private jawSnapshot(t: WaxTooth): Map<WaxTooth, Affine> {
    return new Map(this.m.teeth.filter((x) => x.jaw === t.jaw).map((x) => [x, x.T.slice()]));
  }

  /** Button pressed: returns true when the waxup takes the drag. */
  start(p: Pt, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
    const w = this.w;
    const m = this.m;
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    // chain controls: a point pins, a disc moves its end of the chain
    if (this.chainUi()) {
      const c = this.controlAt(p);
      if (c?.type === 'point') {
        this.drag = { kind: 'pin', key: c.key, label: c.label, start: p, moved: false };
        return true;
      }
      if (c?.type === 'disc') {
        if (w.pins.has(c.key)) {
          this.app.onStatus('This end of the chain is pinned – click its red point to unpin it.', true);
          this.drag = { kind: 'noop' };
          return true;
        }
        const tooth = c.end === 'a' ? c.chain.teeth[0] : c.chain.teeth[c.chain.teeth.length - 1];
        const snap = snapshot(m, c.chain.teeth, w.pins);
        const anchor = snap.nodes[c.end === 'a' ? 0 : snap.nodes.length - 1];
        this.drag = { kind: 'disc', snap, end: c.end, tooth, start: p, anchor, T0: this.jawSnapshot(tooth), moved: false };
        this.startCut(tooth.jaw);
        return true;
      }
    }
    if (this.axisTool()) {
      const a = this.axisAt(p);
      if (a) {
        const center = m.center(a.t);
        const cs = this.ad.project(center);
        const hs = this.ad.project(a.h.p);
        if (cs && hs) {
          const v: Pt = [hs[0] - cs[0], hs[1] - cs[1]];
          const l = Math.hypot(v[0], v[1]);
          if (l > 4) {
            w.selected = a.t.fdi;
            const sdir: Pt = [v[0] / l, v[1] / l];
            const r0 = Math.max(10, (p[0] - cs[0]) * sdir[0] + (p[1] - cs[1]) * sdir[1]);
            this.drag = { kind: 'axis', tooth: a.t, axis: a.h.axis, center, cs, sdir, r0, T0: this.jawSnapshot(a.t), f: 1 };
            this.startCut(a.t.jaw);
            this.app.changed();
            return true;
          }
        }
      }
    }
    if (w.cusps) {
      const part = this.partAt(p);
      if (part) {
        const t = m.tooth(part.fdi)!;
        w.selected = t.fdi;
        const mode = ctrl ? 'rotate' : shift ? 'scale' : 'move';
        const tips = m.partTips(t);
        beginGeometryEdit(t);
        const pd = startPart(t.pos, tips[part.i], m.template(t.fdi).partRadius);
        const tipW = applyV(t.T, tips[part.i]);
        const view = this.ad.viewAxis(tipW);
        // symmetry: the matching cusp of the tooth on the other side
        let mirror: { t: WaxTooth; pd: PartDrag; axis: Vec3 } | null = null;
        const o = w.mirror && !w.mirrorShape ? this.other(t) : null;
        const M = o && this.reflectionOf(t);
        if (o && M) {
          const mt = applyV(M, tipW);
          const otips = m.partTips(o);
          let j = 0, bd = Infinity;
          otips.forEach((q, i) => {
            const d = length(sub(applyV(o.T, q), mt));
            if (d < bd) [bd, j] = [d, i];
          });
          beginGeometryEdit(o);
          mirror = { t: o, pd: startPart(o.pos, otips[j], m.template(o.fdi).partRadius), axis: toLibDir(o, rotV(M, view)) };
        }
        this.drag = { kind: 'part', mode, tooth: t, pd, tipW, start: p, axis: toLibDir(t, view), mirror };
        this.app.changed();
        return true;
      }
      // not on a dot: the tooth itself moves (and is selected, which shows its dots)
    }
    const hit = this.ad.pick(p);
    if (!hit) return false;
    // grabbed with another panel open (3D view): the Waxup panel opens with this tooth
    if (!w.editing) w.openPanel(true);
    const t = m.tooth(hit.fdi)!;
    w.selected = t.fdi;
    if (w.freeform) {
      if (!this.ad.sculpt) {
        this.app.onStatus('Freeform works in the 3D view – the slices show the result.', true);
        this.drag = { kind: 'noop' };
        this.app.changed();
        return true;
      }
      beginGeometryEdit(t);
      const other = w.mirror && !w.mirrorShape ? this.other(t) : null;
      if (other) beginGeometryEdit(other);
      const bd: Extract<Drag, { kind: 'brush' }> = { kind: 'brush', mode: ctrl ? 'remove' : shift ? 'smooth' : 'add', tooth: t, lastW: hit.w, other };
      this.drag = bd;
      this.dab(bd, hit.w);
      this.app.changed();
      return true;
    }
    const tab = w.editing ? w.tab : 'simple';
    if (tab === 'chain' && w.pins.has(toothPin(t.fdi))) {
      this.app.onStatus(`Tooth ${t.fdi} is pinned – click its red point to unpin it.`, true);
      this.drag = { kind: 'noop' };
      this.app.changed();
      return true;
    }
    const op: Op = ctrl && shift ? 'dirscale' : ctrl ? 'rotate' : shift ? 'scale' : tab === 'simple' && w.editing ? w.action : 'move';
    const ctx = tab === 'chain' ? 'chain' : tab === 'simple' && w.editing && w.moveAll ? 'jaw' : 'tooth';
    const axes = toothAxes(m, t);
    const center = ctx === 'jaw' ? m.jawCenter(t.jaw)! : m.center(t);
    let limit: Vec3[] = [];
    if (tab === 'simple' && w.editing) {
      const L = w.limit;
      if (op === 'rotate')
        limit = { all: [], md: [axes.bl], bl: [axes.md], oc: [axes.oc], mdbl: [axes.md, axes.bl] }[L];
      else limit = { all: [], md: [axes.md], bl: [axes.bl], oc: [axes.oc], mdbl: [axes.md, axes.bl] }[L];
    } else if (tab === 'chain' && op === 'rotate' && w.limitTilt) limit = [axes.md];
    const chain = ctx === 'chain' ? snapshot(m, chainOf(m, t), w.pins) : null;
    this.drag = {
      kind: 'xform',
      op,
      tooth: t,
      ctx,
      start: p,
      last: p,
      moved: false,
      anchor: hit.w,
      center,
      cs: this.ad.project(center),
      T0: this.jawSnapshot(t),
      adjust0: m.placement[t.jaw]?.adjust.slice() ?? null,
      axes,
      limit,
      R: I3(),
      dir: null,
      sdir: null,
      chain,
      gi: chain ? chain.teeth.indexOf(t) : -1,
      f: 1,
      shown: null,
    };
    this.startCut(t.jaw);
    this.app.changed();
    return true;
  }

  // ---- drag -------------------------------------------------------------------------------------

  move(p: Pt) {
    const d = this.drag;
    if (!d || d.kind === 'noop') return;
    if (d.kind === 'pin') {
      if (Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) > 4) d.moved = true;
      return;
    }
    if (d.kind === 'brush') return this.moveBrush(d, p);
    if (d.kind === 'part') return this.movePart(d, p);
    if (d.kind === 'axis') {
      const r = (p[0] - d.cs[0]) * d.sdir[0] + (p[1] - d.cs[1]) * d.sdir[1];
      d.f = Math.min(2.5, Math.max(0.4, r / d.r0));
      d.tooth.T = compose(scaleAlong(d.center, [d.axis], d.f), d.T0.get(d.tooth)!);
      this.mirrorChanges(d.T0, d.tooth);
      this.applyCut(d.T0);
      this.app.changed();
      return;
    }
    if (d.kind === 'disc') {
      d.moved = true;
      const a = this.ad.planePoint(d.start, d.anchor), b = this.ad.planePoint(p, d.anchor);
      if (!a || !b) return;
      const mv = sub(b, a);
      const w = this.w;
      const k = d.end === 'a' ? 0 : d.snap.nodes.length - 1;
      const op: ChainOp = w.chainMode === 'tube' ? { kind: 'slide', ds: this.alongTube(mv, d.snap, d.snap.S[k], d.anchor) } : { kind: 'move', d: mv };
      applyChain(d.snap, { disc: d.end }, op, { mode: w.chainMode, scalable: w.scalable, contact: w.contact });
      this.mirrorChanges(d.T0, d.tooth);
      this.applyCut(d.T0);
      this.app.changed();
      return;
    }
    this.moveXform(d, p);
  }

  /** A move in the view plane as a distance along the tube (at arc length s). */
  private alongTube(mv: Vec3, snap: ChainSnap, s: number, at: Vec3): number {
    const t = snap.tube.tangent(s);
    const v = this.ad.viewAxis(at);
    const ts = sub(t, scale(v, dot(t, v)));
    const l2 = dot(ts, ts);
    return l2 < 0.05 ? 0 : dot(mv, ts) / l2;
  }

  private moveXform(d: XformDrag, p: Pt) {
    const ad = this.ad;
    const w = this.w;
    const m = this.m;
    if (!d.moved && Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) < 2) return;
    d.moved = true;
    const T0g = d.T0.get(d.tooth)!;
    let D: Affine | null = null;
    let op: ChainOp | null = null;
    d.shown = null;
    switch (d.op) {
      case 'move': {
        const a = ad.planePoint(d.start, d.anchor), b = ad.planePoint(p, d.anchor);
        if (!a || !b) return;
        const raw = sub(b, a);
        const mv = constrainMove(raw, d.limit, ad.viewAxis(d.anchor));
        D = translation(mv);
        if (d.ctx === 'chain' && w.chainMode === 'tube' && d.chain) {
          const S = d.chain.S;
          op = { kind: 'slide', ds: this.alongTube(raw, d.chain, (S[d.gi] + S[d.gi + 1]) / 2, d.anchor) };
        } else op = { kind: 'move', d: mv };
        if (d.limit.length) d.shown = { line: [add(d.anchor, mv), d.limit] };
        break;
      }
      case 'rotate': {
        let Rinc: number[];
        if (ad.sculpt) {
          // trackball: the grabbed point follows the mouse around the centre
          const a = ad.planePoint(d.last, d.anchor), b = ad.planePoint(p, d.anchor);
          if (!a || !b) return;
          const va = sub(a, d.center), vb = sub(b, d.center);
          if (length(va) < 1e-6 || length(vb) < 1e-6) return;
          Rinc = rotateOnto(normalize(va), normalize(vb));
        } else {
          const cs = ad.project(d.center);
          if (!cs) return;
          const ang = Math.atan2(p[1] - cs[1], p[0] - cs[0]) - Math.atan2(d.last[1] - cs[1], d.last[0] - cs[0]);
          Rinc = axisAngle(ad.viewAxis(d.center), ang);
        }
        if (d.limit.length) {
          const r = toAxisAngle(Rinc);
          let rv: Vec3 = [0, 0, 0];
          for (const k of d.limit) rv = add(rv, scale(k, dot(r.axis, k) * r.angle));
          const a = length(rv);
          Rinc = a > 1e-9 ? axisAngle(scale(rv, 1 / a), a) : I3();
        }
        d.R = mul3(Rinc, d.R);
        const r = toAxisAngle(d.R);
        D = rotateScaleAbout(d.center, r.axis, r.angle, 1);
        op = { kind: 'rotate', axis: r.axis, angle: r.angle, c: d.center };
        d.shown = { label: `${Math.round((r.angle * 180) / Math.PI)}°` };
        break;
      }
      case 'scale':
      case 'dirscale': {
        const cs = d.cs;
        if (!cs) return;
        let axes: Vec3[] = d.limit;
        if (d.op === 'dirscale' && !axes.length) {
          // the direction of the drag picks the axis
          if (!d.dir) {
            const a = ad.planePoint(d.start, d.anchor), b = ad.planePoint(p, d.anchor);
            if (!a || !b || Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) < 6) return;
            d.dir = [normalize(sub(b, a))];
            const l = Math.hypot(p[0] - d.start[0], p[1] - d.start[1]);
            d.sdir = [(p[0] - d.start[0]) / l, (p[1] - d.start[1]) / l];
          }
          axes = d.dir;
        }
        if (axes.length) {
          // along the axes: further along the (first) axis on screen = larger
          if (!d.sdir) {
            const e = ad.project(add(d.center, axes[0]));
            let v: Pt = e ? [e[0] - cs[0], e[1] - cs[1]] : [1, 0];
            const l = Math.hypot(v[0], v[1]) || 1;
            v = [v[0] / l, v[1] / l];
            if ((d.start[0] - cs[0]) * v[0] + (d.start[1] - cs[1]) * v[1] < 0) v = [-v[0], -v[1]];
            d.sdir = v;
          }
          const along = (p[0] - d.start[0]) * d.sdir[0] + (p[1] - d.start[1]) * d.sdir[1];
          d.f = Math.min(2.5, Math.max(0.4, Math.exp(along / 120)));
          D = scaleAlong(d.center, axes, d.f);
          op = { kind: 'set', T: compose(D, T0g) };
          d.shown = { arrows: [d.center, axes, d.f], label: `${Math.round(d.f * 100)} %` };
        } else {
          // uniform: away from the centre = larger, about 10 % per 25 px
          const r0 = Math.hypot(d.start[0] - cs[0], d.start[1] - cs[1]), r1 = Math.hypot(p[0] - cs[0], p[1] - cs[1]);
          const s0 = d.ctx === 'jaw' ? 1 : toothScale(T0g);
          d.f = Math.min(MAX_SCALE / s0, Math.max(MIN_SCALE / s0, Math.exp((r1 - r0) / 250)));
          D = rotateScaleAbout(d.center, [0, 0, 1], 0, d.f);
          op = { kind: 'scale', f: d.f, c: d.center };
          d.shown = { label: `${Math.round(d.f * 100)} %` };
        }
        break;
      }
    }
    d.last = p;
    if (!D || !op) return;
    if (d.ctx === 'jaw') {
      for (const [t, t0] of d.T0) t.T = compose(D, t0);
      const pl = m.placement[d.tooth.jaw];
      if (pl && d.adjust0) pl.adjust = compose(D, d.adjust0);
    } else if (d.ctx === 'chain' && d.chain) {
      for (const [t, t0] of d.T0) t.T = t0.slice();
      const mode = w.chainMode;
      const chainOp: ChainOp = mode === 'single' || op.kind === 'set' ? { kind: 'set', T: compose(D, T0g) } : op;
      applyChain(d.chain, { tooth: d.gi }, chainOp, { mode, scalable: w.scalable, contact: w.contact });
      this.mirrorChanges(d.T0, d.tooth);
    } else {
      d.tooth.T = compose(D, T0g);
      this.mirrorChanges(d.T0, d.tooth);
    }
    this.applyCut(d.T0);
    this.app.changed();
  }

  // ---- antagonist cutting ---------------------------------------------------------------------

  /** Antagonist cutting is on for this jaw: the antagonist's surface and the teeth as they are now. */
  private startCut(jaw: Jaw) {
    this.cutting = null;
    const w = this.w;
    if (!w.editing || !w.cut[jaw]) return;
    const hf = buildCutter(this.app, jaw);
    if (!hf) return;
    const base = new Map(this.m.teeth.filter((t) => t.jaw === jaw).map((t) => [t, { pos: t.pos, idx: t.idx, geo: t.geo }]));
    this.cutting = { hf, gap: w.cutGap, base, own: new Map() };
  }

  /** Teeth that moved are cut where they reach into the antagonist (from their shape at the start). */
  private applyCut(T0: Map<WaxTooth, Affine>) {
    const c = this.cutting;
    if (!c) return;
    for (const [t, b] of c.base) {
      const t0 = T0.get(t);
      const moved = !t0 || t.T.some((v, i) => v !== t0[i]);
      const cut = moved ? cutTooth(c.hf, t.T, b.pos, c.gap) : null;
      if (cut) {
        let g = c.own.get(t);
        if (!g) c.own.set(t, (g = newGeo()));
        t.pos = cut;
        t.idx = b.idx;
        t.geo = g;
        t.ver = (t.ver ?? 0) + 1;
      } else if (t.pos !== b.pos) {
        t.pos = b.pos;
        t.idx = b.idx;
        t.geo = b.geo;
        t.ver = (t.ver ?? 0) + 1;
      }
    }
  }

  // ---- symmetry -------------------------------------------------------------------------------

  private other(t: WaxTooth): WaxTooth | null {
    const o = this.m.tooth(contralateral(t.fdi));
    return o && !this.w.pins.has(toothPin(o.fdi)) ? o : null;
  }

  private reflectionOf(t: WaxTooth): Affine | null {
    const pl = this.m.placement[t.jaw];
    if (!pl) return null;
    const { p, n } = mirrorPlane(pl);
    return reflection(p, n);
  }

  /** Symmetry: every tooth on the dragged tooth's side passes its change to its counterpart. */
  private mirrorChanges(T0: Map<WaxTooth, Affine>, driver: WaxTooth) {
    const w = this.w;
    if (!w.mirror && !w.mirrorShape) return;
    const M = this.reflectionOf(driver);
    if (!M) return;
    const side = quadrant(driver.fdi);
    for (const [t, t0] of T0) {
      if (quadrant(t.fdi) !== side) continue;
      const o = this.other(t);
      const o0 = o && T0.get(o);
      if (!o || !o0) continue;
      const D = compose(t.T, invert(t0));
      o.T = compose(compose(M, compose(D, M)), o0);
    }
  }

  /** 1-to-1 mirroring: the counterparts of the changed teeth become their exact mirror images. */
  private mirrorShapes(teeth: WaxTooth[]): WaxTooth[] {
    const out: WaxTooth[] = [];
    if (!this.w.mirrorShape) return out;
    for (const t of teeth) {
      const o = this.other(t);
      const M = this.reflectionOf(t);
      if (!o || !M) continue;
      // placed as the mirror image (world) of the tooth, its vertices mirrored across the library
      // midline – so they sit where its own library tooth would
      o.T = compose(compose(M, t.T), [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
      o.pos = mirroredVertices(t, o, M);
      o.idx = flipped(t.idx);
      o.geo = newGeo();
      o.ver = (o.ver ?? 0) + 1;
      out.push(o);
    }
    return out;
  }

  // ---- shaping ---------------------------------------------------------------------------------------

  private moveBrush(d: Extract<Drag, { kind: 'brush' }>, p: Pt) {
    const hit = this.ad.pick(p);
    if (!hit || hit.fdi !== d.tooth.fdi) return;
    const r = this.w.brushRadius;
    if (Math.hypot(hit.w[0] - d.lastW[0], hit.w[1] - d.lastW[1], hit.w[2] - d.lastW[2]) < r * 0.25) return;
    this.dab(d, hit.w);
    d.lastW = hit.w;
    this.hoverAt = hit.w;
    this.app.changed();
  }

  /** One brush dab at a world point (and at its mirror image with symmetry). */
  private dab(d: Extract<Drag, { kind: 'brush' }>, wp: Vec3) {
    const one = (t: WaxTooth, at: Vec3) => {
      const s = Waxup.scaleOf(t);
      const st = this.w.brushStrength;
      const amount = d.mode === 'smooth' ? 0.25 + st * 0.6 : (0.02 + st * 0.1) / s;
      brush(t.pos, t.idx, toLibPoint(t, at), this.w.brushRadius / s, amount, d.mode);
      t.ver = (t.ver ?? 0) + 1;
    };
    one(d.tooth, wp);
    const M = d.other && this.reflectionOf(d.tooth);
    if (d.other && M) one(d.other, applyV(M, wp));
    this.mirrorShapes([d.tooth]);
  }

  private movePart(d: Extract<Drag, { kind: 'part' }>, p: Pt) {
    const t = d.tooth;
    let dw: Vec3 = [0, 0, 0];
    let s = 1;
    let angle = 0;
    const cs = this.ad.project(d.tipW);
    if (d.mode === 'move') {
      const a = this.ad.planePoint(d.start, d.tipW), b = this.ad.planePoint(p, d.tipW);
      if (a && b) dw = sub(b, a);
    } else if (cs) {
      const r0 = Math.hypot(d.start[0] - cs[0], d.start[1] - cs[1]), r1 = Math.hypot(p[0] - cs[0], p[1] - cs[1]);
      if (d.mode === 'scale') s = Math.min(2, Math.max(0.4, Math.exp((r1 - r0) / 120)));
      else angle = Math.atan2(p[1] - cs[1], p[0] - cs[0]) - Math.atan2(d.start[1] - cs[1], d.start[0] - cs[0]);
    }
    applyPart(t.pos, d.pd, toLibDir(t, dw), s, d.axis, angle);
    t.ver = (t.ver ?? 0) + 1;
    const M = d.mirror && this.reflectionOf(t);
    if (d.mirror && M) {
      const o = d.mirror.t;
      // a reflection turns the other way round
      applyPart(o.pos, d.mirror.pd, toLibDir(o, rotV(M, dw)), s, d.mirror.axis, -angle);
      o.ver = (o.ver ?? 0) + 1;
    }
    this.mirrorShapes([t]);
    this.app.changed();
  }

  // ---- release -----------------------------------------------------------------------------------------

  end() {
    const d = this.drag;
    this.drag = null;
    const w = this.w;
    if (d?.kind === 'pin' && !d.moved) {
      const on = !w.pins.has(d.key);
      if (on) w.pins.add(d.key);
      else w.pins.delete(d.key);
      this.app.onStatus(on ? `Pinned ${d.label}: it stays where it is while the chain changes` : `${d.label[0].toUpperCase()}${d.label.slice(1)} is free again`);
    }
    let copies: WaxTooth[] = [];
    if (d?.kind === 'xform' && d.moved) copies = this.mirrorShapes([...d.T0.keys()].filter((t) => quadrant(t.fdi) === quadrant(d.tooth.fdi) && t.T.some((v, i) => v !== d.T0.get(t)![i])));
    if (d?.kind === 'axis') copies = this.mirrorShapes([d.tooth]);
    if (d?.kind === 'disc' && d.moved) copies = this.mirrorShapes(d.snap.teeth.filter((t) => quadrant(t.fdi) === quadrant(d.tooth.fdi)));
    // mirror images are cut against the antagonist on their own side
    const c = this.cutting;
    if (c)
      for (const o of copies) {
        const cut = cutTooth(c.hf, o.T, o.pos, c.gap);
        if (cut) {
          o.pos = cut;
          o.ver = (o.ver ?? 0) + 1;
        }
      }
    this.cutting = null;
    this.app.changed();
  }

  // ---- drawing ----------------------------------------------------------------------------------------

  /** Chain controls, handles, guides and the brush outline. */
  draw(o: CanvasRenderingContext2D) {
    const w = this.w;
    if (!w.editing) return;
    if (this.chainUi()) this.drawChain(o);
    if (this.axisTool()) {
      const drawn = new Set<number>();
      for (const fdi of [w.selected, w.hover]) {
        const t = this.m.tooth(fdi);
        if (!t || drawn.has(t.fdi) || !w.visible[t.jaw]) continue;
        drawn.add(t.fdi);
        const c = this.m.center(t);
        const cs = this.ad.project(c);
        for (const h of this.axisHandles(t)) {
          if (!this.ad.near(h.p)) continue;
          const s = this.ad.project(h.p);
          if (!s || !cs) continue;
          const hot = w.hoverCtl === `ax:${t.fdi}:${h.k}`;
          o.strokeStyle = AXIS_COLORS[h.i];
          o.lineWidth = 1.5;
          o.setLineDash([4, 3]);
          o.beginPath();
          o.moveTo(cs[0], cs[1]);
          o.lineTo(s[0], s[1]);
          o.stroke();
          o.setLineDash([]);
          o.beginPath();
          o.arc(s[0], s[1], hot ? 7.5 : 5.5, 0, Math.PI * 2);
          o.fillStyle = AXIS_COLORS[h.i];
          o.fill();
          o.lineWidth = 2;
          o.strokeStyle = hot ? '#fff' : 'rgba(0,0,0,0.7)';
          o.stroke();
        }
      }
    }
    if (w.cusps) {
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
    const d = this.drag;
    if (d?.kind === 'xform' && d.shown) this.drawGuides(o, d);
    if (d?.kind === 'axis') {
      const s = this.ad.project(d.center);
      if (s) this.label(o, `${Math.round(d.f * 100)} %`, s);
    }
    if (w.freeform && this.ad.sculpt && this.hoverAt) {
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

  private label(o: CanvasRenderingContext2D, text: string, at: Pt) {
    o.font = '600 12px system-ui, sans-serif';
    const tw = o.measureText(text).width;
    o.fillStyle = 'rgba(10,14,22,0.8)';
    o.fillRect(at[0] + 14, at[1] - 22, tw + 10, 18);
    o.fillStyle = '#9ff0b4';
    o.fillText(text, at[0] + 19, at[1] - 9);
  }

  /** Limited move: the allowed directions; scaling: green arrows along the scaled axes. */
  private drawGuides(o: CanvasRenderingContext2D, d: XformDrag) {
    const sh = d.shown!;
    if (sh.line) {
      const [p, axes] = sh.line;
      o.strokeStyle = 'rgba(255,214,90,0.9)';
      o.lineWidth = 1.5;
      o.setLineDash([6, 4]);
      for (const k of axes) {
        const a = this.ad.project(add(p, scale(k, -12))), b = this.ad.project(add(p, scale(k, 12)));
        if (!a || !b) continue;
        o.beginPath();
        o.moveTo(a[0], a[1]);
        o.lineTo(b[0], b[1]);
        o.stroke();
      }
      o.setLineDash([]);
    }
    if (sh.arrows) {
      const [c, axes, f] = sh.arrows;
      o.strokeStyle = '#3ddc6e';
      o.fillStyle = '#3ddc6e';
      o.lineWidth = 3;
      for (const k of axes) {
        const L = 6 * f;
        const a = this.ad.project(add(c, scale(k, -L))), b = this.ad.project(add(c, scale(k, L)));
        if (!a || !b) continue;
        o.beginPath();
        o.moveTo(a[0], a[1]);
        o.lineTo(b[0], b[1]);
        o.stroke();
        for (const [tip, from] of [[b, a], [a, b]] as [Pt, Pt][]) {
          const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
          o.beginPath();
          o.moveTo(tip[0] + Math.cos(ang) * 6, tip[1] + Math.sin(ang) * 6);
          o.lineTo(tip[0] + Math.cos(ang + 2.5) * 9, tip[1] + Math.sin(ang + 2.5) * 9);
          o.lineTo(tip[0] + Math.cos(ang - 2.5) * 9, tip[1] + Math.sin(ang - 2.5) * 9);
          o.closePath();
          o.fill();
        }
      }
    }
    if (sh.label) {
      const s = this.ad.project(d.ctx === 'jaw' ? d.center : this.m.center(d.tooth));
      if (s) this.label(o, sh.label, s);
    }
  }

  /** Tube, discs and control points (3D view, Chain tab). */
  private drawChain(o: CanvasRenderingContext2D) {
    const w = this.w;
    const tubeMode = w.chainMode === 'tube';
    for (const c of this.controls()) {
      const path = (pts: Vec3[]) => {
        o.beginPath();
        let started = false;
        for (const q of pts) {
          const s = this.ad.project(q);
          if (!s) continue;
          if (started) o.lineTo(s[0], s[1]);
          else o.moveTo(s[0], s[1]);
          started = true;
        }
      };
      const mid = c.tube.at(c.tube.length / 2);
      const width = Math.min(14, Math.max(4, 1.8 / this.ad.mmPerPx(mid)));
      o.lineCap = 'round';
      o.lineJoin = 'round';
      if (tubeMode) {
        // the fixed arch the teeth slide along, beyond both ends
        const ext = (from: number, to: number) => {
          const pts: Vec3[] = [];
          for (let s = from; s <= to; s += 1) pts.push(c.tube.at(s));
          path(pts);
          o.strokeStyle = 'rgba(235,70,70,0.6)';
          o.lineWidth = width;
          o.stroke();
        };
        ext(-14, 0);
        ext(c.tube.length, c.tube.length + 14);
      }
      path(c.tube.pts);
      o.strokeStyle = 'rgba(64,220,235,0.42)';
      o.lineWidth = width;
      o.stroke();
      o.strokeStyle = 'rgba(170,250,255,0.9)';
      o.lineWidth = 1.5;
      o.stroke();
      o.lineCap = 'butt';
      for (const d of c.discs) {
        const poly = this.discOutline(d);
        if (!poly) continue;
        const hot = w.hoverCtl === `disc:${d.key}` || (this.drag?.kind === 'disc' && this.drag.snap.teeth[0] === c.teeth[0] && this.drag.end === d.end);
        const pinned = w.pins.has(d.key);
        o.beginPath();
        poly.forEach((q, i) => (i ? o.lineTo(q[0], q[1]) : o.moveTo(q[0], q[1])));
        o.closePath();
        o.fillStyle = pinned ? 'rgba(200,70,70,0.3)' : hot ? 'rgba(150,120,220,0.5)' : 'rgba(110,85,175,0.35)';
        o.fill();
        o.lineWidth = hot ? 2 : 1.2;
        o.strokeStyle = 'rgba(190,170,240,0.85)';
        o.stroke();
      }
      const point = (q: Vec3, key: string) => {
        const s = this.ad.project(q);
        if (!s) return;
        const hot = w.hoverCtl === key;
        const pinned = w.pins.has(key);
        o.beginPath();
        o.arc(s[0], s[1], hot ? 8 : 6, 0, Math.PI * 2);
        const g = o.createRadialGradient(s[0] - 2, s[1] - 2, 1, s[0], s[1], hot ? 8 : 6);
        g.addColorStop(0, pinned ? '#ff9a9a' : '#8ff0a0');
        g.addColorStop(1, pinned ? '#c62f36' : '#1f8f3a');
        o.fillStyle = g;
        o.fill();
        o.lineWidth = hot ? 2 : 1;
        o.strokeStyle = hot ? '#fff' : 'rgba(0,0,0,0.6)';
        o.stroke();
      };
      for (const pt of c.points) point(pt.w, pt.key);
      for (const d of c.discs) point(d.ctl, d.key);
    }
  }
}

/** Point in polygon (even-odd). */
function inside(poly: Pt[], p: Pt): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/** Unit axis into the screen for a view with screen axes u (right) and v (down). */
export const intoScreen = (u: Vec3, v: Vec3): Vec3 => normalize([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
