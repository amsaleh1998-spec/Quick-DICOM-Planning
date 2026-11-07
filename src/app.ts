import { ArchCurve } from './curve';
import { Cylinder, Implant, MUA_ANGLES, createImplant, implantParts, setApicalDiameter, setImplantAxis, setImplantLength } from './implant';
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
  length,
  neg,
  normalize,
  perpendicular,
  rotateFrame,
  scale,
  sub,
  toFrame,
} from './math';
import { Nerve, createNerve, implantNerveDistance, insertNervePoint } from './nerve';
import { Scan, scansKey } from './scans';
import { CropSpec } from './render';
import { AiLayer, Cut, SEGMENT_PRESETS, Segment, Segmentation } from './segment';
import { DS_LABELS } from './ai/dsPlan';
import { canalCentrelines } from './ai/canal';
import { Volume, composeAffine, resampleVolume } from './volume';
import type { History } from './history';
import { planHistory } from './planHistory';
import { MprView } from './views/MprView';
import { View3D } from './views/View3D';
import { CrossView, PanoView, PlanAxialView, TangView } from './views/PlanViews';
import { IS_MAC, Pt, View, ViewState, newViewState } from './views/View';

export type Mode = 'mpr' | 'plan';
export type MprTool = 'navigate' | 'rotate' | 'crop';
export type Jaw = 'upper' | 'lower';

/** A panoramic curve plus the view state that belongs to it. */
export interface CurveSlot {
  id: number;
  name: string;
  curve: ArchCurve;
  /** navigation remembered while another curve is active */
  nav: { s: number; focusC: number; panoOffset: number; panoVs: ViewState | null };
}
let nextCurveId = 1;
/** Segmentation / nerve tools: region growing, separation cut, nerve tracing. */
export type SegTool = 'grow' | 'cut' | 'nerve';

export interface Measurement {
  id: number;
  /** 'plane' rulers live on planar slices, 'pano' rulers on the panoramic surface */
  kind: 'plane' | 'pano';
  a: Vec3;
  b: Vec3;
}
let nextMeasurementId = 1;

const INPUT_KEY = 'qdp.input';
function loadInputPreference(): 'mouse' | 'trackpad' {
  try {
    const v = localStorage.getItem(INPUT_KEY);
    if (v === 'mouse' || v === 'trackpad') return v;
  } catch {
    /* storage unavailable */
  }
  return IS_MAC ? 'trackpad' : 'mouse';
}
export function saveInputPreference(v: 'mouse' | 'trackpad') {
  try {
    localStorage.setItem(INPUT_KEY, v);
  } catch {
    /* storage unavailable */
  }
}
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
  /** the ACTIVE panoramic curve (the panoramic, cross-sections and tangential view follow it) */
  curve: ArchCurve | null = null;
  /** all panoramic curves, e.g. one for the maxilla and one for the mandible */
  curves: CurveSlot[] = [];
  activeCurveId: number | null = null;
  /** true while drawing an additional curve (false = (re)drawing the active one) */
  private drawingNew = false;
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
  /** ruler waiting for its second click (and the view it was started in) */
  pendingMeasurement: { m: Measurement; view: object } | null = null;
  /** measurement under the mouse (Delete removes it) */
  hoverMeasurementId: number | null = null;
  /** what right-drag does */
  rightDrag: 'zoom' | 'wl' = 'zoom';
  /** mouse-wheel events are ignored until then (the SpaceMouse driver also emits wheel events) */
  wheelBlockedUntil = 0;
  /** simplified phone UI: touch gestures instead of mouse interactions */
  touchUi = false;
  /** pointing device: trackpad mode maps two-finger gestures to navigation */
  input: 'mouse' | 'trackpad' = loadInputPreference();
  defaultDiameter = 4;
  /** new implants are tapered (apex 1 mm narrower than the platform) */
  defaultTapered = true;
  defaultLength = 10;
  /** new implants copy the axis of the selected implant */
  placeParallel = true;

  /** 3D rendering settings */
  vr = { mode: 'surface' as RenderMode, lo: 0, hi: 0 };

  /** intraoral scans / surface models placed in the CBCT */
  scans: Scan[] = [];
  /** draw scan outlines in the 2D views */
  showScanContours = true;
  /** scan selected in the side panel */
  activeScanId: number | null = null;

  // segmentation & nerve tracing
  readonly seg = new Segmentation();
  nerves: Nerve[] = [];
  /** segment that clicks are added to */
  activeSegId: number | null = null;
  /** nerve being traced / edited */
  activeNerveId: number | null = null;
  segTool: SegTool | null = null;
  /** separation cut being drawn (points in the view it was started in) */
  cutDraft: { view: View; pts: Vec3[] } | null = null;
  /** half thickness of new cuts (mm); null = through the whole volume */
  cutDepth: number | null = null;
  /** 3D: render bone that belongs to no segment */
  showUnsegmented = true;
  /** tint segments in the 2D slices */
  showSegOverlay = true;
  /** draw the blue panoramic curve (+ slab bounds, R/L) in the axial plan view */
  showCurveAxial = true;
  /** draw the blue curve / level / slab guide lines in the cross-sections */
  showCurveCross = false;

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
  onStatus: (msg: string, error?: boolean) => void = () => {};
  /** a panoramic curve has just been drawn (the next step is placing implants) */
  onCurveDrawn: () => void = () => {};
  /** show / hide a busy overlay (null hides it) */
  onBusy: (text: string | null) => void = () => {};

  private renderPending = false;
  private uiPending = false;

  constructor() {
    // every gesture (click, drag) is one undo step: commit when it starts and once it has ended
    window.addEventListener(
      'pointerdown',
      () => {
        this.pointersDown++;
        this.commitHistory();
      },
      true,
    );
    const up = () => {
      this.pointersDown = Math.max(0, this.pointersDown - 1);
      // after the gesture's own handlers (pointerup, click) have run
      setTimeout(() => this.pointersDown === 0 && this.commitHistory(), 0);
    };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    this.mprViews = [new MprView(this, 0), new MprView(this, 1), new MprView(this, 2)];
    this.planAxial = new PlanAxialView(this);
    this.pano = new PanoView(this);
    const crossVs = newViewState();
    this.crossViews = [new CrossView(this, 0, crossVs), new CrossView(this, 1, crossVs), new CrossView(this, 2, crossVs)];
    this.tang = new TangView(this);
    this.view3d = new View3D(this);
    this.views = [...this.mprViews, this.planAxial, this.pano, ...this.crossViews, this.tang, this.view3d];
    this.history = planHistory(this);
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
    this.scheduleCommit();
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
    this.curves = [];
    this.activeCurveId = null;
    this.drawing = null;
    this.implants = [];
    this.selectedId = null;
    this.placing = null;
    this.measurements = [];
    this.pendingMeasurement = null;
    this.hoverMeasurementId = null;
    this.s = 0;
    this.focusC = 0;
    this.panoOffset = 0;
    this.tangAngle = 0;
    this.seg.reset(vol);
    this.nerves = [];
    this.scans = [];
    this.activeSegId = null;
    this.activeNerveId = null;
    this.segTool = null;
    this.cutDraft = null;
    this.fitAll();
    this.onWindowChange();
    this.resetHistory();
    this.markSaved(); // a freshly opened scan has nothing to save yet
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
    this.saveCurveNav();
    const toNewAB = (p: Vec2): Vec2 => [p[0] - min[0] - O2[0], p[1] - min[1] - O2[1]];
    const toNewC = (c: number) => c - min[2] - O2[2];
    const curveSlots = this.curves.map((sl) => ({
      ...sl,
      curve: new ArchCurve(sl.curve.ctrl.map(toNewAB)),
      nav: { ...sl.nav, focusC: toNewC(sl.nav.focusC), panoVs: null },
    }));
    const activeCurveId = this.activeCurveId;
    const focus = toNewC(this.focusC);
    const { s, selectedId, wl } = this;
    const vr = { ...this.vr };
    const tCrop = (c: CropSpec | null): CropSpec | null =>
      c && { origin: toNew(c.origin), frame: c.frame.map(dirToNew) as Frame, min: c.min, max: c.max };
    const segments: Segment[] = this.seg.segments.map((g) => ({
      ...g,
      seeds: g.seeds.map((d) => ({ ...d, p: toNew(d.p), crop: tCrop(d.crop) })),
    }));
    const cuts: Cut[] = this.seg.cuts.map((c) =>
      c.kind === 'plane'
        ? { ...c, pts: c.pts.map(toNew), u: dirToNew(c.u), v: dirToNew(c.v), n: dirToNew(c.n) }
        : { ...c, O: toNew(c.O), F: c.F.map(dirToNew) as Frame },
    );
    const nerves = this.nerves.map((n) => ({ ...n, pts: n.pts.map(toNew) }));
    // scans and the AI result: world_new = R·(world_old − corner0)
    const oldToNew = [
      R[0][0], R[0][1], R[0][2], -(R[0][0] * corner0[0] + R[0][1] * corner0[1] + R[0][2] * corner0[2]),
      R[1][0], R[1][1], R[1][2], -(R[1][0] * corner0[0] + R[1][1] * corner0[1] + R[1][2] * corner0[2]),
      R[2][0], R[2][1], R[2][2], -(R[2][0] * corner0[0] + R[2][1] * corner0[1] + R[2][2] * corner0[2]),
    ];
    const scans = this.scans;
    for (const sc of scans) if (sc.transform) sc.transform = composeAffine(oldToNew, sc.transform);
    const oldAi = this.seg.ai;
    const ai: AiLayer | null = oldAi && { ...oldAi, toWorld: composeAffine(oldToNew, oldAi.toWorld ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]) };
    const { activeSegId, activeNerveId, showUnsegmented, showSegOverlay, cutDepth } = this;

    this.setVolume(nv);
    this.X = X2;
    this.implants = implants;
    this.measurements = measurements;
    this.selectedId = selectedId;
    this.curves = curveSlots;
    this.activeCurveId = activeCurveId;
    this.curve = this.activeSlot()?.curve ?? null;
    this.s = s;
    this.focusC = focus;
    this.wl = wl;
    this.vr = vr;
    Object.assign(this, { activeSegId, activeNerveId, showUnsegmented, showSegOverlay, cutDepth });
    this.restoreSegmentation(segments, cuts, nerves, ai);
    this.scans = scans;
    this.resetHistory(); // coordinates changed: earlier states no longer apply
    this.savedKey = null; // the resampled volume itself is a change worth saving
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

  /** Start drawing: `asNew` adds another curve, otherwise the active curve is (re)drawn. */
  startDrawing(asNew = false) {
    this.drawingNew = asNew || !this.curve;
    this.drawing = [];
    this.placing = null;
    this.segTool = null;
    this.cutDraft = null;
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
      if (this.drawingNew) this.addCurve(d);
      else this.setCurve(d, false);
      this.s = this.curve!.length / 2;
      this.panoOffset = 0;
      this.pano.vs.fitted = false;
      this.drawingNew = false;
      this.changed();
      this.onCurveDrawn();
      return;
    }
    this.drawingNew = false;
    this.changed();
  }

  /** Replace the active curve's points (creates the first curve when there is none). */
  setCurve(ctrl: Vec2[], _interactive: boolean) {
    const slot = this.activeSlot();
    if (!slot) {
      this.addCurve(ctrl);
      return;
    }
    const prevLen = this.curve?.length;
    this.curve = slot.curve = new ArchCurve(ctrl);
    if (prevLen !== undefined) this.s = clamp(this.s, 0, this.curve.length);
    this.changed();
  }

  activeSlot(): CurveSlot | null {
    return this.curves.find((c) => c.id === this.activeCurveId) ?? null;
  }

  private defaultCurveName(): string {
    const used = new Set(this.curves.map((c) => c.name));
    for (let n = this.curves.length + 1; ; n++) if (!used.has(`Curve ${n}`)) return `Curve ${n}`;
  }

  /** Add a new curve and make it active (its view starts at the current axial level). */
  addCurve(ctrl: Vec2[], name?: string): CurveSlot {
    // the user usually scrolls to the new jaw's level before adding the curve:
    // keep the previous curve's own level
    this.saveCurveNav(true);
    const curve = new ArchCurve(ctrl);
    const slot: CurveSlot = {
      id: nextCurveId++,
      name: name ?? this.defaultCurveName(),
      curve,
      nav: { s: curve.length / 2, focusC: this.focusC, panoOffset: 0, panoVs: null },
    };
    this.curves.push(slot);
    this.activeCurveId = slot.id;
    this.curve = curve;
    this.s = curve.length / 2;
    this.panoOffset = 0;
    this.pano.vs.fitted = false;
    this.changed();
    return slot;
  }

  /** Remember the active curve's navigation (level, position, panoramic offset & zoom). */
  private saveCurveNav(keepLevel = false) {
    const slot = this.activeSlot();
    if (slot) slot.nav = { s: this.s, focusC: keepLevel ? slot.nav.focusC : this.focusC, panoOffset: this.panoOffset, panoVs: { ...this.pano.vs } };
  }

  /** Switch the panoramic, cross-sections and tangential view to another curve. */
  activateCurve(id: number) {
    if (id === this.activeCurveId) return;
    const slot = this.curves.find((c) => c.id === id);
    if (!slot) return;
    this.saveCurveNav();
    this.activeCurveId = id;
    this.curve = slot.curve;
    this.s = clamp(slot.nav.s, 0, slot.curve.length);
    this.focusC = slot.nav.focusC;
    this.panoOffset = slot.nav.panoOffset;
    if (slot.nav.panoVs) Object.assign(this.pano.vs, slot.nav.panoVs);
    else this.pano.vs.fitted = false;
    this.drawing = null;
    this.changed();
  }

  renameCurve(id: number, name: string) {
    const slot = this.curves.find((c) => c.id === id);
    if (!slot) return;
    slot.name = name.trim().slice(0, 40) || slot.name;
    this.changed();
  }

  deleteCurve(id: number) {
    const idx = this.curves.findIndex((c) => c.id === id);
    if (idx < 0) return;
    this.curves.splice(idx, 1);
    if (this.activeCurveId === id) {
      const next = this.curves[Math.min(idx, this.curves.length - 1)];
      this.activeCurveId = null;
      this.curve = null;
      if (next) {
        // restore the remaining curve's own view
        this.activeCurveId = next.id;
        this.curve = next.curve;
        this.s = clamp(next.nav.s, 0, next.curve.length);
        this.focusC = next.nav.focusC;
        this.panoOffset = next.nav.panoOffset;
        if (next.nav.panoVs) Object.assign(this.pano.vs, next.nav.panoVs);
        else this.pano.vs.fitted = false;
      }
    }
    this.changed();
  }

  /** Delete the active curve (the next one, if any, becomes active). */
  clearCurve() {
    this.drawing = null;
    if (this.activeCurveId !== null) this.deleteCurve(this.activeCurveId);
    else this.changed();
  }

  /** The curve an implant belongs to: closest in the axial plane and in height to the curve's level. */
  curveForImplant(imp: Implant): CurveSlot | null {
    if (this.curves.length === 0) return null;
    this.saveCurveNav();
    const f = toFrame(imp.center, this.O, this.frame);
    let best: CurveSlot | null = null;
    let bestScore = Infinity;
    for (const sl of this.curves) {
      const d = sl.curve.nearest(f[0], f[1]).dist;
      const score = d + Math.abs(f[2] - sl.nav.focusC);
      if (score < bestScore) {
        bestScore = score;
        best = sl;
      }
    }
    return best;
  }

  /** Project restore: all curves and which one is active. */
  restoreCurves(list: { name: string; ctrl: Vec2[]; nav?: Partial<CurveSlot['nav']> }[], activeIndex: number) {
    this.curves = list.map((c) => {
      const curve = new ArchCurve(c.ctrl);
      return {
        id: nextCurveId++,
        name: c.name,
        curve,
        nav: { s: c.nav?.s ?? curve.length / 2, focusC: c.nav?.focusC ?? this.focusC, panoOffset: c.nav?.panoOffset ?? 0, panoVs: c.nav?.panoVs ?? null },
      };
    });
    const active = this.curves[Math.max(0, Math.min(activeIndex, this.curves.length - 1))];
    this.activeCurveId = active?.id ?? null;
    this.curve = active?.curve ?? null;
  }

  /** Undo / redo: the curves as they were (same ids keep their own navigation). */
  restoreCurveList(list: [number, string, Vec2[]][]) {
    this.drawing = null;
    const old = new Map(this.curves.map((c) => [c.id, c]));
    const prevActive = this.activeCurveId;
    this.curves = list.map(([id, name, ctrl]) => {
      const o = old.get(id);
      const curve = o && JSON.stringify(o.curve.ctrl) === JSON.stringify(ctrl) ? o.curve : new ArchCurve(ctrl);
      return { id, name, curve, nav: o?.nav ?? { s: curve.length / 2, focusC: this.focusC, panoOffset: 0, panoVs: null } };
    });
    nextCurveId = Math.max(nextCurveId, ...list.map((c) => c[0] + 1));
    const active = this.curves.find((c) => c.id === prevActive) ?? this.curves[this.curves.length - 1] ?? null;
    this.activeCurveId = active?.id ?? null;
    this.curve = active?.curve ?? null;
    if (active && active.id !== prevActive) {
      this.s = clamp(active.nav.s, 0, active.curve.length);
      this.focusC = active.nav.focusC;
      this.panoOffset = active.nav.panoOffset;
      this.pano.vs.fitted = false;
    } else if (this.curve) this.s = clamp(this.s, 0, this.curve.length);
    this.changed();
  }

  /** Curves for saving: current navigation of the active curve included. */
  curvesForSave(): { list: { name: string; ctrl: Vec2[]; nav: CurveSlot['nav'] }[]; active: number } {
    this.saveCurveNav();
    return {
      list: this.curves.map((c) => ({ name: c.name, ctrl: c.curve.ctrl, nav: c.nav })),
      active: Math.max(0, this.curves.findIndex((c) => c.id === this.activeCurveId)),
    };
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

  /** Move the cross-sections along the curve by `step` mm (default: the cross-section spacing). */
  moveAlongCurve(dir: number, step = this.crossSpacing) {
    if (!this.curve) return;
    this.s = clamp(this.s + dir * step, 0, this.curve.length);
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
    this.segTool = null;
    this.cutDraft = null;
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
    if (this.defaultTapered) setApicalDiameter(imp, Math.round((imp.diameter - 1) * 10) / 10);
    if (sameJaw && ref?.abutment) imp.abutment = { ...ref.abutment };
    if (sameJaw && ref) imp.showProstheticAxis = ref.showProstheticAxis;
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

  implantChanged(_imp: Implant | null, final = false) {
    this.followSelected();
    this.changed();
    if (final) this.commitHistory();
  }

  // ---- undo / redo (see planHistory.ts) ------------------------------------------

  private history!: History;
  private commitTimer = 0;
  private pointersDown = 0;

  /** Record the changes since the last commit as one undo step. */
  commitHistory() {
    clearTimeout(this.commitTimer);
    this.history?.commit();
  }

  /** Edits outside a gesture (typing, sliders, keys) become a step once they have settled. */
  private scheduleCommit() {
    clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => {
      if (this.pointersDown > 0) this.scheduleCommit(); // still dragging
      else this.commitHistory();
    }, 400);
  }

  /** the plan as it was last saved or opened; null = changed in a way the plan text does not show */
  private savedKey: string | null = null;

  /** The current plan is what is in the project file (just saved or opened). */
  markSaved() {
    this.savedKey = this.history?.stateKey() ?? null;
    this.changed();
  }

  /** Something outside the plan history changed (e.g. the patient's name). */
  markUnsaved() {
    this.savedKey = null;
    this.changed();
  }

  /** The plan has changes that are not in a project file yet (the demo volume never counts). */
  get unsaved(): boolean {
    return !!this.vol && this.vol.info.source !== 'Demo phantom' && (this.savedKey === null || this.history.stateKey() !== this.savedKey);
  }

  /** Start a new history (new scan, project opened, coordinates changed). */
  resetHistory() {
    clearTimeout(this.commitTimer);
    this.history?.reset();
  }

  get undoCount() {
    return this.history.undoCount;
  }
  get redoCount() {
    return this.history.redoCount;
  }

  /** Undo the last change of the plan; returns what it changed, or null when there is nothing to undo. */
  undo(): string[] | null {
    clearTimeout(this.commitTimer);
    this.drawing = null;
    this.cutDraft = null;
    this.cancelPendingMeasurement();
    return this.history.undo();
  }

  redo(): string[] | null {
    clearTimeout(this.commitTimer);
    this.drawing = null;
    this.cutDraft = null;
    this.cancelPendingMeasurement();
    return this.history.redo();
  }

  // ---- implant visibility -------------------------------------------------------

  setImplantHidden(id: number, hidden: boolean) {
    const imp = this.implantById(id);
    if (!imp) return;
    imp.hidden = hidden;
    if (hidden && this.selectedId === id) this.selectedId = null; // nothing invisible stays editable
    this.changed();
  }

  setAbutmentHidden(id: number, hidden: boolean) {
    const imp = this.implantById(id);
    if (!imp) return;
    imp.abutmentHidden = hidden;
    this.changed();
  }

  showAllImplants() {
    for (const i of this.implants) {
      i.hidden = false;
      i.abutmentHidden = false;
    }
    this.changed();
  }

  /**
   * Keep the cross-sections on the selected implant: whenever it moves (or its
   * shape changes) the middle cross-section jumps to its position on the curve.
   * Scrolling the cross-sections afterwards is still free.
   */
  followSelected() {
    const imp = this.selectedImplant();
    if (!imp || !this.curve) return;
    const f = toFrame(imp.center, this.O, this.frame);
    this.s = clamp(this.curve.nearest(f[0], f[1]).s, 0, this.curve.length);
  }

  /** Rename an implant (empty names fall back to "Implant <id>"). */
  renameImplant(id: number, name: string) {
    const imp = this.implantById(id);
    if (!imp) return;
    imp.name = name.trim().slice(0, 40) || `Implant ${id}`;
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
    this.followSelected();
    this.changed();
  }

  /** Make implant `id` parallel to implant `refId` (rotating around its platform). */
  makeParallel(id: number, refId: number) {
    const imp = this.implantById(id);
    const ref = this.implantById(refId);
    if (!imp || !ref || imp === ref) return;
    setImplantAxis(imp, ref.axis.slice() as Vec3);
    this.followSelected();
    this.changed();
  }

  /** Swap platform and apex. */
  flipImplant(id: number) {
    const imp = this.implantById(id);
    if (!imp) return;
    imp.axis = neg(imp.axis);
    this.followSelected();
    this.changed();
  }

  setLength(id: number, length: number) {
    const imp = this.implantById(id);
    if (!imp) return;
    setImplantLength(imp, length);
    this.followSelected();
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

  /** Changes to the scans that affect drawing. */
  scansKey(): string {
    return scansKey(this.scans) + this.showScanContours;
  }

  implantsKey(): string {
    const hasAb = this.implants.some((i) => i.abutment);
    return JSON.stringify([this.implants, this.selectedId, hasAb ? [this.curve?.ctrl, this.frame] : 0]);
  }

  // ---- segmentation -----------------------------------------------------------

  /** Switch the segmentation / nerve tool (null = off). */
  setSegTool(t: SegTool | null) {
    this.cutDraft = null;
    this.segTool = t;
    if (t) {
      this.cancelPendingMeasurement();
      this.ruler = false;
      this.placing = null;
      this.drawing = null;
    }
    this.changed();
  }

  activeSegment(): Segment | null {
    return this.seg.segmentById(this.activeSegId);
  }

  /** Create a segment from a preset (index into SEGMENT_PRESETS) and wait for a click on it. */
  newSegment(preset: number) {
    if (!this.vol) return;
    const p = SEGMENT_PRESETS[preset] ?? SEGMENT_PRESETS[SEGMENT_PRESETS.length - 1];
    const seg = this.seg.addSegment(p.name, p.color, p.opacity ?? 1);
    if (!seg) {
      this.onStatus('Too many segments – delete some first.', true);
      return;
    }
    this.activeSegId = seg.id;
    this.setSegTool('grow');
    const tip =
      p.name === 'Tooth'
        ? 'raise the lower 3D threshold until the tooth stands out from the bone'
        : p.name === 'Implant'
          ? 'raise the lower 3D threshold until only the metal remains'
          : 'set the 3D thresholds first so it is separated from its neighbours';
    this.onStatus(`${seg.name}: click on it in the 3D view or in any slice (${tip}).`);
  }

  selectSegment(id: number | null) {
    this.activeSegId = id;
    this.changed();
  }

  /** Run a slow job behind the busy overlay, then refresh. */
  private busy(text: string, fn: () => void) {
    this.onBusy(text);
    setTimeout(() => {
      try {
        fn();
      } catch (e) {
        console.error(e);
        this.onStatus((e as Error).message, true);
      } finally {
        this.onBusy(null);
        this.changed();
      }
    }, 30);
  }

  /** Region-grow the active segment from world point w with the current 3D thresholds. */
  growAt(w: Vec3) {
    if (!this.vol) return;
    let seg = this.activeSegment();
    if (!seg) {
      seg = this.seg.addSegment('Segment');
      if (!seg) return;
      this.activeSegId = seg.id;
    }
    const target = seg;
    const lo = this.vr.lo;
    const hi = Math.max(this.vr.lo + 1, this.vr.hi);
    const c = this.cropSpec();
    const crop: CropSpec | null =
      c && !this.cropIsFull()
        ? { origin: [...c.origin] as Vec3, frame: c.frame.map((a) => [...a]) as Frame, min: [...c.min] as Vec3, max: [...c.max] as Vec3 }
        : null;
    this.busy(`Segmenting ${target.name}…`, () => {
      const r = this.seg.grow(target, w, lo, hi, crop);
      if (r.added) {
        const cm3 = (target.voxels * this.seg.voxelVolume) / 1000;
        this.onStatus(`${target.name}: ${cm3.toFixed(2)} cm³. Click more parts to add them, or draw a cut if it leaked into a neighbour.`);
      } else this.onStatus(r.message ?? 'Nothing was added.', true);
    });
  }

  /** Grow every segment again (after cuts, deletions or threshold changes). */
  rebuildSegments(text = 'Updating segmentation…') {
    this.busy(text, () => this.seg.rebuild());
  }

  deleteSegment(id: number) {
    this.seg.removeSegment(id);
    if (this.activeSegId === id) this.activeSegId = null;
    if (this.segTool === 'grow' && !this.activeSegment()) this.segTool = null;
    this.rebuildSegments();
  }

  /** Remove all seeds of a segment (keeps the entry, ready for new clicks). */
  clearSegment(id: number) {
    const s = this.seg.segmentById(id);
    if (!s) return;
    s.seeds = [];
    delete s.ai;
    if (!this.seg.segments.some((g) => g.ai)) this.seg.setAi(null);
    this.rebuildSegments();
  }

  /** Re-grow a segment with the current 3D thresholds. */
  regrowSegment(id: number) {
    const s = this.seg.segmentById(id);
    if (!s || !s.seeds.length) return;
    const hi = Math.max(this.vr.lo + 1, this.vr.hi);
    for (const d of s.seeds) {
      d.lo = this.vr.lo;
      d.hi = hi;
    }
    this.rebuildSegments(`Re-growing ${s.name}…`);
  }

  setSegmentVisible(id: number, visible: boolean) {
    const s = this.seg.segmentById(id);
    if (!s) return;
    s.visible = visible;
    this.changed();
  }

  startCut() {
    if (!this.vol) return;
    this.setSegTool('cut');
    this.onStatus('Click points along the gap in a slice or in the panoramic (crossing the contact), double-click or Enter to finish.');
  }

  addCutPoint(view: View, w: Vec3) {
    if (!this.cutDraft || this.cutDraft.view !== view) this.cutDraft = { view, pts: [] };
    const pts = this.cutDraft.pts;
    // the clicks of a double click land on the same spot: keep one point
    const last = pts[pts.length - 1];
    if (last && length(sub(w, last)) < 3 * view.vs.scale) return;
    pts.push(w);
    this.requestRender();
  }

  finishCut() {
    const d = this.cutDraft;
    this.cutDraft = null;
    if (!d || d.pts.length < 2) {
      this.onStatus('A cut needs at least two points.', true);
      this.changed();
      return;
    }
    const c = d.view.makeCut(d.pts, this.cutDepth);
    if (!c) return;
    this.seg.addCut(c);
    this.segTool = null;
    this.rebuildSegments('Applying cut…');
  }

  deleteCut(id: number) {
    this.seg.removeCut(id);
    this.rebuildSegments();
  }

  /** Replace segments, cuts and nerves (project load, resampling) and rebuild the labels. */
  restoreSegmentation(segments: Segment[], cuts: Cut[], nerves: Nerve[], ai: AiLayer | null = null) {
    this.seg.restore(segments, cuts);
    this.seg.setAi(ai);
    this.nerves = nerves;
    if (!this.seg.segmentById(this.activeSegId)) this.activeSegId = null;
    if (!nerves.some((n) => n.id === this.activeNerveId)) this.activeNerveId = null;
    if (segments.some((s) => s.seeds.length || (s.ai && ai))) this.rebuildSegments('Rebuilding segmentation…');
    else this.changed();
  }

  /**
   * Result of the automatic segmentation (classes + margins on the current label grid): replaces
   * earlier automatic segments and adds one segment per structure found.
   */
  applyAiSegmentation(res: { cls: Uint8Array; margin: Uint8Array; counts: number[] }, model: string): Segment[] {
    const seg = this.seg;
    for (const s of seg.segments.filter((g) => g.ai)) seg.removeSegment(s.id);
    seg.setAi({ model, created: new Date().toISOString(), nx: seg.nx, ny: seg.ny, nz: seg.nz, gs: [...seg.gs], cls: res.cls, margin: res.margin, toWorld: null });
    const added: Segment[] = [];
    for (const l of DS_LABELS) {
      if ((res.counts[l.cls] ?? 0) < 20) continue; // nothing (or only noise) found
      const g = seg.addSegment(l.name, l.color, l.opacity);
      if (!g) break;
      g.color = [...l.color];
      g.ai = { cls: l.cls, model };
      added.push(g);
    }
    if (!added.length) seg.setAi(null);
    // the AI segments cover the jaws: hide the remaining (unsegmented) bone in 3D
    else this.showUnsegmented = false;
    this.activeSegId = null;
    this.rebuildSegments('Showing the automatic segmentation…');
    return added;
  }

  /**
   * Nerve paths along an automatically segmented mandibular canal (one per side). Sides that
   * already have a traced nerve are left alone. Returns the sides created.
   */
  nervesFromCanal(segId: number): ('right' | 'left')[] {
    const seg = this.seg;
    // midline: centre of the mandible (or of the scan)
    const mand = seg.segments.find((g) => g.ai?.cls === 2);
    let midX = this.vol ? this.vol.extent[0] / 2 : 0;
    if (mand && seg.labels) {
      let sx = 0, n = 0;
      for (let k = 0, idx = 0; k < seg.nz; k++)
        for (let j = 0; j < seg.ny; j++)
          for (let i = 0; i < seg.nx; i++, idx++)
            if (seg.labels[idx] === mand.id) {
              sx += i;
              n++;
            }
      if (n) midX = (sx / n) * seg.gs[0];
    }
    const made: ('right' | 'left')[] = [];
    for (const l of canalCentrelines(seg, segId, midX)) {
      let nv = this.nerves.find((x) => x.side === l.side);
      if (nv && nv.pts.length >= 2) continue;
      if (!nv) {
        nv = createNerve(l.side);
        this.nerves.push(nv);
      }
      nv.pts = l.pts;
      nv.diameter = l.diameter;
      nv.visible = true;
      made.push(l.side);
    }
    this.changed();
    return made;
  }

  // ---- nerve tracing ------------------------------------------------------------

  activeNerve(): Nerve | null {
    return this.nerves.find((n) => n.id === this.activeNerveId) ?? null;
  }

  /** Start (or continue) tracing the nerve of one side. */
  traceNerve(side: 'right' | 'left') {
    if (!this.vol) return;
    let n = this.nerves.find((x) => x.side === side);
    if (!n) {
      n = createNerve(side);
      this.nerves.push(n);
    }
    n.visible = true;
    this.activeNerveId = n.id;
    this.setSegTool('nerve');
    this.onStatus(`${n.name}: click the centre of the canal on cross-sections or the panoramic, in any order (mental foramen → mandibular foramen).`);
  }

  selectNerve(id: number | null) {
    this.activeNerveId = id;
    this.changed();
  }

  /** Add a point to the active nerve; returns its index (or -1). */
  addNervePoint(w: Vec3): number {
    const n = this.activeNerve();
    if (!n) return -1;
    const i = insertNervePoint(n.pts, w);
    this.changed();
    return i;
  }

  /** Move a nerve control point (while dragging). */
  moveNervePoint(n: Nerve, idx: number, w: Vec3) {
    n.pts[idx] = w;
    this.requestRender();
  }

  deleteNervePoint(id: number, idx: number) {
    const n = this.nerves.find((x) => x.id === id);
    if (!n) return;
    n.pts.splice(idx, 1);
    this.changed();
  }

  deleteNerve(id: number) {
    this.nerves = this.nerves.filter((n) => n.id !== id);
    if (this.activeNerveId === id) {
      this.activeNerveId = null;
      if (this.segTool === 'nerve') this.segTool = null;
    }
    this.changed();
  }

  /** Distance between the implant and each traced nerve (surface to surface, mm). */
  nerveDistances(imp: Implant): { nerve: Nerve; d: number }[] {
    return this.nerves.filter((n) => n.pts.length >= 2).map((nerve) => ({ nerve, d: implantNerveDistance(imp, nerve) }));
  }

  /** Changes that affect segmentation / nerve drawing. */
  segKey(): string {
    const s = this.seg;
    return JSON.stringify([
      s.version,
      s.segments.map((g) => [g.id, g.visible, g.color, g.voxels, g.opacity ?? 1]),
      s.cuts.map((c) => c.id),
      this.showSegOverlay,
      this.showUnsegmented,
      this.nerves.map((n) => [n.pts, n.diameter, n.visible]),
    ]);
  }

  // ---- measurements -----------------------------------------------------------

  addMeasurement(kind: 'plane' | 'pano', w: Vec3): Measurement {
    const m: Measurement = { id: nextMeasurementId++, kind, a: w, b: w };
    this.measurements.push(m);
    return m;
  }

  deleteMeasurement(id: number) {
    this.measurements = this.measurements.filter((m) => m.id !== id);
    if (this.pendingMeasurement?.m.id === id) this.pendingMeasurement = null;
    if (this.hoverMeasurementId === id) this.hoverMeasurementId = null;
    this.changed();
  }

  /** Drop a ruler that only has its first point. */
  cancelPendingMeasurement() {
    const p = this.pendingMeasurement;
    if (!p) return;
    this.pendingMeasurement = null;
    this.deleteMeasurement(p.m.id);
  }

  /** Replace all measurements (project restore). */
  setMeasurements(ms: Measurement[]) {
    this.measurements = ms;
    this.pendingMeasurement = null;
    this.hoverMeasurementId = null;
    nextMeasurementId = Math.max(nextMeasurementId, ...ms.map((m) => m.id + 1));
    this.changed();
  }

  clearMeasurements() {
    this.measurements = [];
    this.pendingMeasurement = null;
    this.hoverMeasurementId = null;
    this.changed();
  }

  setRuler(on: boolean) {
    this.cancelPendingMeasurement();
    this.ruler = on;
    if (on) {
      this.placing = null;
      this.drawing = null;
      this.segTool = null;
      this.cutDraft = null;
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
    const segName = this.seg.segmentById(this.seg.labelAt(w[0], w[1], w[2]))?.name;
    this.onCursor(
      `${view.title}  ·  x ${f[0].toFixed(1)}  y ${f[1].toFixed(1)}  z ${f[2].toFixed(1)} mm  ·  value ${Number.isNaN(v) ? '—' : Math.round(v)}` +
        (segName ? `  ·  ${segName}` : ''),
    );
  }
}
