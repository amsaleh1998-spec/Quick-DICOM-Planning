import { ArchCurve } from './curve';
import { Cylinder, Implant, MUA_ANGLES, createImplant, implantParts, setImplantAxis, setImplantLength } from './implant';
import {
  Frame,
  Vec2,
  Vec3,
  add,
  clamp,
  cross,
  deg,
  dot,
  fromFrame,
  identityFrame,
  neg,
  normalize,
  perpendicular,
  rotateFrame,
  scale,
  sub,
  toFrame,
} from './math';
import { CropSpec } from './render';
import { Volume, resampleVolume } from './volume';
import { MprView } from './views/MprView';
import { View3D } from './views/View3D';
import { CrossView, PanoView, PlanAxialView, TangView } from './views/PlanViews';
import { Pt, View, newViewState } from './views/View';

export type Mode = 'mpr' | 'plan';
export type MprTool = 'navigate' | 'rotate' | 'crop';
export type Jaw = 'upper' | 'lower';

export interface Measurement {
  id: number;
  /** 'plane' rulers live on planar slices, 'pano' rulers on the panoramic surface */
  kind: 'plane' | 'pano';
  a: Vec3;
  b: Vec3;
}
let nextMeasurementId = 1;
export type RenderMode = 'surface' | 'translucent' | 'mip';

export class App {
  vol: Volume | null = null;
  /** Origin of the planning/crop frame (volume centre). */
  O: Vec3 = [0, 0, 0];
  /** Orientation frame, changed by Ctrl+Alt rotation in the MPR views. */
  frame: Frame = identityFrame();
  /** In-plane offset angle of each MPR view (keeps the dragged view steady). */
  psi: [number, number, number] = [0, 0, 0];
  /** MPR crosshair (world mm). */
  X: Vec3 = [0, 0, 0];
  crop = { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
  /** True once the user edited the crop box; otherwise it follows rotations. */
  cropEdited = false;
  wl = { center: 0, width: 1 };
  mode: Mode = 'mpr';
  mprTool: MprTool = 'navigate';

  // planning
  curve: ArchCurve | null = null;
  drawing: Vec2[] | null = null;
  /** arc length of the middle cross-section */
  s = 0;
  /** height (frame z) of the axial level / focus */
  focusC = 0;
  crossSpacing = 2;
  /** panoramic shows either a thick slab or a thin slice */
  panoMode: 'slab' | 'slice' = 'slab';
  panoSlab = 12;
  panoSlice = 1;
  panoOffset = 0;
  tangAngle = 0;
  implants: Implant[] = [];
  selectedId: number | null = null;
  /** implant placement in progress (which jaw) */
  placing: Jaw | null = null;
  /** ruler tool active */
  ruler = false;
  measurements: Measurement[] = [];
  /** what right-drag does */
  rightDrag: 'zoom' | 'wl' = 'zoom';
  defaultDiameter = 4;
  defaultLength = 10;
  /** new implants copy the axis of the selected implant */
  placeParallel = true;

  /** 3D rendering settings */
  vr = { mode: 'surface' as RenderMode, lo: 0, hi: 0 };

  activeView: View | null = null;
  readonly mprViews: MprView[];
  readonly planAxial: PlanAxialView;
  readonly pano: PanoView;
  readonly crossViews: CrossView[];
  readonly tang: TangView;
  readonly view3d: View3D;
  readonly views: View[];

  /** UI hooks set by main.ts */
  onStateChange: () => void = () => {};
  onWindowChange: () => void = () => {};
  onCursor: (text: string) => void = () => {};

  private renderPending = false;
  private uiPending = false;

  constructor() {
    this.mprViews = [new MprView(this, 0), new MprView(this, 1), new MprView(this, 2)];
    this.planAxial = new PlanAxialView(this);
    this.pano = new PanoView(this);
    const crossVs = newViewState();
    this.crossViews = [new CrossView(this, 0, crossVs), new CrossView(this, 1, crossVs), new CrossView(this, 2, crossVs)];
    this.tang = new TangView(this);
    this.view3d = new View3D(this);
    this.views = [...this.mprViews, this.planAxial, this.pano, ...this.crossViews, this.tang, this.view3d];
  }

  // ---- scheduling -----------------------------------------------------------

  requestRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      for (const v of this.views) v.render();
    });
  }

  /** State changed: re-render and refresh the side panel. */
  changed() {
    this.requestRender();
    if (this.uiPending) return;
    this.uiPending = true;
    requestAnimationFrame(() => {
      this.uiPending = false;
      this.onStateChange();
    });
  }

  // ---- volume ---------------------------------------------------------------

  setVolume(vol: Volume) {
    this.vol = vol;
    this.O = vol.center;
    this.frame = identityFrame();
    this.psi = [0, 0, 0];
    this.X = vol.center;
    this.resetCrop();
    const w = vol.info.defaultWindow ?? vol.autoWindow();
    this.wl = { ...w };
    this.vr.lo = Math.round(vol.boneThreshold());
    this.vr.hi = vol.max;
    this.curve = null;
    this.drawing = null;
    this.implants = [];
    this.selectedId = null;
    this.placing = null;
    this.measurements = [];
    this.s = 0;
    this.focusC = 0;
    this.panoOffset = 0;
    this.tangAngle = 0;
    this.fitAll();
    this.onWindowChange();
    this.changed();
  }

  fitAll() {
    const fitted = new Set<object>();
    for (const v of this.views) {
      v.invalidate();
      if (fitted.has(v.vs)) continue;
      fitted.add(v.vs);
      v.vs.fitted = false;
    }
    this.requestRender();
  }

  setWindow(center: number, width: number) {
    this.wl.center = center;
    this.wl.width = Math.max(1, width);
    this.onWindowChange();
    this.requestRender();
  }

  autoWindow() {
    if (!this.vol) return;
    const w = this.vol.autoWindow();
    this.setWindow(w.center, w.width);
  }

  // ---- MPR orientation ------------------------------------------------------

  rotateAroundView(orient: number, n: Vec3, angle: number) {
    this.frame = rotateFrame(this.frame, n, angle);
    this.psi[orient] -= angle;
    if (!this.cropEdited) this.resetCrop();
    this.changed();
  }

  /** Make every MPR view show the rotated frame axis-aligned. */
  straightenViews() {
    this.psi = [0, 0, 0];
    this.changed();
  }

  resetRotation() {
    this.frame = identityFrame();
    this.psi = [0, 0, 0];
    if (!this.cropEdited) this.resetCrop();
    this.changed();
  }

  viewTiltDeg(orient: number): number {
    const n = this.mprViews[orient].basis().n;
    const ref: Vec3[] = [
      [0, 0, 1],
      [0, 1, 0],
      [-1, 0, 0],
    ];
    return deg(Math.acos(clamp(Math.abs(dot(n, ref[orient])), 0, 1)));
  }

  // ---- crop -----------------------------------------------------------------

  private fullCropBox(): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of this.vol!.corners()) {
      const f = toFrame(c, this.O, this.frame);
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], f[a]);
        max[a] = Math.max(max[a], f[a]);
      }
    }
    return { min, max };
  }

  resetCrop() {
    if (!this.vol) return;
    const b = this.fullCropBox();
    this.crop = { min: b.min, max: b.max };
    this.cropEdited = false;
    this.changed();
  }

  cropIsFull(): boolean {
    if (!this.vol) return true;
    const b = this.fullCropBox();
    for (let a = 0; a < 3; a++) {
      if (this.crop.min[a] > b.min[a] + 0.01 || this.crop.max[a] < b.max[a] - 0.01) return false;
    }
    return true;
  }

  cropSpec(): CropSpec | null {
    if (!this.vol) return null;
    return { origin: this.O, frame: this.frame, min: this.crop.min, max: this.crop.max };
  }

  /**
   * Bake rotation + crop into a new resampled volume. Curve, implants and
   * crosshair are transformed so the plan stays in place.
   */
  async applyCropAndRotation(onProgress: (f: number) => void) {
    const vol = this.vol;
    if (!vol) return;
    let sp = vol.minSpacing;
    const size = (sp0: number) =>
      [0, 1, 2].reduce((acc, a) => acc * (Math.floor((this.crop.max[a] - this.crop.min[a]) / sp0) + 1), 1);
    while (size(sp) > 300_000_000) sp *= 1.25;
    const R = this.frame;
    const min = this.crop.min.slice() as Vec3;
    const corner0 = fromFrame(min, this.O, R);
    const nv = await resampleVolume(vol, this.O, R, min, this.crop.max, sp, onProgress);
    const toNew = (p: Vec3): Vec3 => {
      const q = sub(p, corner0);
      return [dot(q, R[0]), dot(q, R[1]), dot(q, R[2])];
    };
    const dirToNew = (d: Vec3): Vec3 => [dot(d, R[0]), dot(d, R[1]), dot(d, R[2])];
    const O2 = nv.center;
    const X2 = toNew(this.X);
    const implants = this.implants.map((imp) => ({ ...imp, center: toNew(imp.center), axis: normalize(dirToNew(imp.axis)) }));
    const measurements = this.measurements.map((m) => ({ ...m, a: toNew(m.a), b: toNew(m.b) }));
    const ctrl = this.curve?.ctrl.map((p) => [p[0] - min[0] - O2[0], p[1] - min[1] - O2[1]] as Vec2);
    const focus = this.focusC - min[2] - O2[2];
    const { s, selectedId, wl } = this;
    const vr = { ...this.vr };

    this.setVolume(nv);
    this.X = X2;
    this.implants = implants;
    this.measurements = measurements;
    this.selectedId = selectedId;
    if (ctrl) this.curve = new ArchCurve(ctrl);
    this.s = s;
    this.focusC = focus;
    this.wl = wl;
    this.vr = vr;
    this.onWindowChange();
    this.fitAll();
    this.changed();
  }

  // ---- planning -------------------------------------------------------------

  setMode(m: Mode) {
    this.mode = m;
    if (m === 'plan' && this.vol && this.focusC === 0 && !this.curve) {
      // start the axial level at the crosshair height
      this.focusC = toFrame(this.X, this.O, this.frame)[2];
    }
    this.changed();
  }

  startDrawing() {
    this.drawing = [];
    this.placing = null;
    this.changed();
  }

  cancelDrawing() {
    this.drawing = null;
    this.changed();
  }

  finishCurve() {
    const d = this.drawing;
    this.drawing = null;
    if (d && d.length >= 2) {
      // run from patient right (-a) to patient left (+a)
      if (d[0][0] > d[d.length - 1][0]) d.reverse();
      this.setCurve(d, false);
      this.s = this.curve!.length / 2;
      this.pano.vs.fitted = false;
    }
    this.changed();
  }

  setCurve(ctrl: Vec2[], _interactive: boolean) {
    const prevLen = this.curve?.length;
    this.curve = new ArchCurve(ctrl);
    if (prevLen !== undefined) this.s = clamp(this.s, 0, this.curve.length);
    this.changed();
  }

  clearCurve() {
    this.curve = null;
    this.drawing = null;
    this.changed();
  }

  /** Thickness actually used for the panoramic reconstruction. */
  panoThickness() {
    return this.panoMode === 'slab' ? this.panoSlab : this.panoSlice;
  }

  setPanoMode(m: 'slab' | 'slice') {
    this.panoMode = m;
    this.changed();
  }

  crossS(k: number) {
    return this.s + (k - 1) * this.crossSpacing;
  }

  moveAlongCurve(dir: number) {
    if (!this.curve) return;
    this.s = clamp(this.s + dir * this.crossSpacing, 0, this.curve.length);
    this.changed();
  }

  selectedImplant(): Implant | null {
    return this.implants.find((i) => i.id === this.selectedId) ?? null;
  }

  /** Tangential plane: pivot point, vertical axis and current horizontal direction. */
  tangentialPlane(): { pivot: Vec3; axis: Vec3; h: Vec3 } | null {
    const F = this.frame;
    const sel = this.selectedImplant();
    let pivot: Vec3;
    let axis: Vec3;
    let tRef: Vec3;
    if (sel) {
      pivot = sel.center;
      axis = dot(sel.axis, F[2]) >= 0 ? sel.axis : neg(sel.axis);
      if (this.curve) {
        const f = toFrame(pivot, this.O, F);
        const cp = this.curve.at(this.curve.nearest(f[0], f[1]).s);
        tRef = add(scale(F[0], cp.t[0]), scale(F[1], cp.t[1]));
      } else tRef = F[0];
    } else if (this.curve) {
      const cp = this.curve.at(this.s);
      pivot = fromFrame([cp.p[0], cp.p[1], this.focusC], this.O, F);
      axis = F[2];
      tRef = add(scale(F[0], cp.t[0]), scale(F[1], cp.t[1]));
    } else return null;
    let T = sub(tRef, scale(axis, dot(tRef, axis)));
    if (Math.hypot(T[0], T[1], T[2]) < 1e-3) T = cross(axis, F[1]);
    T = normalize(T);
    const N = cross(axis, T);
    const a = (this.tangAngle * Math.PI) / 180;
    return { pivot, axis, h: normalize(add(scale(T, Math.cos(a)), scale(N, Math.sin(a)))) };
  }

  startPlacing(jaw: Jaw) {
    this.placing = jaw;
    this.ruler = false;
    this.drawing = null;
    this.changed();
  }

  /** Apical direction for an upper (apex up) or lower (apex down) implant. */
  apicalDirection(jaw: Jaw): Vec3 {
    return jaw === 'lower' ? neg(this.frame[2]) : this.frame[2];
  }

  /** Place a new implant of the jaw being placed with its centre at w. */
  placeImplantAt(w: Vec3) {
    const jaw = this.placing ?? 'lower';
    const apical = this.apicalDirection(jaw);
    const ref = this.selectedImplant();
    let axis = apical;
    let sameJaw = false;
    if (this.placeParallel && ref) {
      sameJaw = dot(ref.axis, apical) >= 0;
      axis = sameJaw ? ref.axis : neg(ref.axis);
    }
    const imp = createImplant(w, normalize(axis), this.defaultDiameter, this.defaultLength);
    if (sameJaw && ref?.abutment) imp.abutment = { ...ref.abutment };
    this.implants.push(imp);
    this.placing = null;
    this.tangAngle = 0;
    this.selectImplant(imp.id, true);
  }

  selectImplant(id: number | null, snap: boolean) {
    const changed = this.selectedId !== id;
    this.selectedId = id;
    const imp = this.selectedImplant();
    if (imp && snap && this.curve) {
      const f = toFrame(imp.center, this.O, this.frame);
      this.s = this.curve.nearest(f[0], f[1]).s;
      this.focusC = f[2];
    }
    if (changed) this.tangAngle = 0;
    this.changed();
  }

  deleteImplant(id: number) {
    this.implants = this.implants.filter((i) => i.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.changed();
  }

  implantChanged(_imp: Implant | null, _final = false) {
    this.changed();
  }

  implantById(id: number | null) {
    return this.implants.find((i) => i.id === id) ?? null;
  }

  /** Make the implant parallel to the frame's vertical axis (rotating around its platform). */
  uprightImplant(id: number) {
    const imp = this.implantById(id);
    if (!imp) return;
    setImplantAxis(imp, dot(imp.axis, this.frame[2]) >= 0 ? this.frame[2] : neg(this.frame[2]));
    this.changed();
  }

  /** Make implant `id` parallel to implant `refId` (rotating around its platform). */
  makeParallel(id: number, refId: number) {
    const imp = this.implantById(id);
    const ref = this.implantById(refId);
    if (!imp || !ref || imp === ref) return;
    setImplantAxis(imp, ref.axis.slice() as Vec3);
    this.changed();
  }

  /** Swap platform and apex. */
  flipImplant(id: number) {
    const imp = this.implantById(id);
    if (!imp) return;
    imp.axis = neg(imp.axis);
    this.changed();
  }

  setLength(id: number, length: number) {
    const imp = this.implantById(id);
    if (!imp) return;
    setImplantLength(imp, length);
    this.changed();
  }

  /** Buccal direction at the implant (curve normal), used as 0° for abutment rotation. */
  private buccalAt(imp: Implant): Vec3 {
    const F = this.frame;
    if (this.curve) {
      const f = toFrame(imp.center, this.O, F);
      const cp = this.curve.at(this.curve.nearest(f[0], f[1]).s);
      return add(scale(F[0], cp.n[0]), scale(F[1], cp.n[1]));
    }
    return neg(F[1]);
  }

  /** In-plane basis around the implant's coronal direction: [up, buccal, mesial-ish]. */
  private abutmentBasis(imp: Implant): [Vec3, Vec3, Vec3] {
    const up = neg(imp.axis);
    const b0 = this.buccalAt(imp);
    let B = sub(b0, scale(up, dot(b0, up)));
    B = Math.hypot(B[0], B[1], B[2]) < 1e-3 ? perpendicular(up) : normalize(B);
    return [up, B, cross(up, B)];
  }

  /** Coronal direction of the abutment head. */
  abutmentDir(imp: Implant): Vec3 | null {
    const ab = imp.abutment;
    if (!ab) return null;
    const [up, B, M] = this.abutmentBasis(imp);
    const r = (ab.rotation * Math.PI) / 180;
    const t = (ab.angle * Math.PI) / 180;
    const d = add(scale(B, Math.cos(r)), scale(M, Math.sin(r)));
    return normalize(add(scale(up, Math.cos(t)), scale(d, Math.sin(t))));
  }

  /** Pick MUA angulation and rotation so the abutment points as vertically as possible. */
  autoAlignAbutment(id: number) {
    const imp = this.implantById(id);
    if (!imp || !imp.abutment) return;
    const [up, B, M] = this.abutmentBasis(imp);
    const F2 = this.frame[2];
    const target = dot(F2, up) >= 0 ? F2 : neg(F2);
    const tilt = deg(Math.acos(clamp(dot(target, up), -1, 1)));
    const tp = sub(target, scale(up, dot(target, up)));
    imp.abutment.angle = MUA_ANGLES.reduce((best, a) => (Math.abs(a - tilt) < Math.abs(best - tilt) ? a : best), 0);
    if (Math.hypot(tp[0], tp[1], tp[2]) > 1e-4) {
      imp.abutment.rotation = Math.round(((deg(Math.atan2(dot(tp, M), dot(tp, B))) % 360) + 360) % 360);
    }
    this.changed();
  }

  /** Cylinders of all implants and abutments. */
  allParts(): Cylinder[] {
    return this.implants.flatMap((imp) => implantParts(imp, this.abutmentDir(imp)));
  }

  /** Direction the prosthesis "sees": abutment head axis or implant coronal axis. */
  prostheticAxis(imp: Implant): Vec3 {
    return this.abutmentDir(imp) ?? neg(imp.axis);
  }

  /** Pairwise angles between implants (and their abutments). */
  angleTable(): { a: Implant; b: Implant; implant: number; abutment: number | null }[] {
    const out: { a: Implant; b: Implant; implant: number; abutment: number | null }[] = [];
    for (let i = 0; i < this.implants.length; i++) {
      for (let j = i + 1; j < this.implants.length; j++) {
        const a = this.implants[i];
        const b = this.implants[j];
        if (this.implantJaw(a) !== this.implantJaw(b)) continue;
        const hasAb = !!(a.abutment || b.abutment);
        out.push({
          a,
          b,
          implant: this.implantAngle(a, b),
          abutment: hasAb ? deg(Math.acos(clamp(Math.abs(dot(this.prostheticAxis(a), this.prostheticAxis(b))), 0, 1))) : null,
        });
      }
    }
    return out;
  }

  implantsKey(): string {
    const hasAb = this.implants.some((i) => i.abutment);
    return JSON.stringify([this.implants, this.selectedId, hasAb ? [this.curve?.ctrl, this.frame] : 0]);
  }

  // ---- measurements -----------------------------------------------------------

  addMeasurement(kind: 'plane' | 'pano', w: Vec3): Measurement {
    const m: Measurement = { id: nextMeasurementId++, kind, a: w, b: w };
    this.measurements.push(m);
    return m;
  }

  deleteMeasurement(id: number) {
    this.measurements = this.measurements.filter((m) => m.id !== id);
    this.changed();
  }

  clearMeasurements() {
    this.measurements = [];
    this.changed();
  }

  setRuler(on: boolean) {
    this.ruler = on;
    if (on) {
      this.placing = null;
      this.drawing = null;
    }
    this.changed();
  }

  /** Toggle a view between its grid cell and filling the whole layout. */
  toggleMaximize(v: View) {
    const layout = v.el.parentElement;
    if (!layout) return;
    const was = v.el.classList.contains('max');
    layout.querySelectorAll('.view.max').forEach((e) => e.classList.remove('max'));
    layout.classList.toggle('has-max', !was);
    if (!was) v.el.classList.add('max');
    this.requestRender();
  }

  /** Implant inclination relative to the frame's vertical axis (degrees). */
  implantTilt(imp: Implant) {
    return deg(Math.acos(clamp(Math.abs(dot(imp.axis, this.frame[2])), 0, 1)));
  }

  /** Angle between two implants' axes. */
  implantAngle(a: Implant, b: Implant) {
    return deg(Math.acos(clamp(Math.abs(dot(a.axis, b.axis)), 0, 1)));
  }

  /** Upper implants have their apex pointing up. */
  implantJaw(imp: Implant): Jaw {
    return dot(imp.axis, this.frame[2]) >= 0 ? 'upper' : 'lower';
  }

  // ---- status -----------------------------------------------------------------

  reportCursor(view: View, p: Pt | null) {
    if (!p || !this.vol) {
      this.onCursor('');
      return;
    }
    const w = view.worldAt(p);
    if (!w) {
      this.onCursor('');
      return;
    }
    const v = this.vol.sample(w, NaN);
    const f = toFrame(w, this.O, this.frame);
    this.onCursor(
      `${view.title}  ·  x ${f[0].toFixed(1)}  y ${f[1].toFixed(1)}  z ${f[2].toFixed(1)} mm  ·  value ${Number.isNaN(v) ? '—' : Math.round(v)}`,
    );
  }
}
