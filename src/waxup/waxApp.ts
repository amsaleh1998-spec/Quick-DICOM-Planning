// The waxup inside the app: state of the Waxup panel and the operations the interface calls
// (set up a jaw on the curve, add / remove / reset teeth), plus the starting height of the teeth
// found in the CBCT.

import type { App } from '../app';
import type { ArchCurve } from '../curve';
import { Vec3, clamp, dot, fromFrame, sub } from '../math';
import { IDENTITY } from '../register';
import { Jaw, ToothLibrary, ensureLibrary, jawOf, jawOrder } from './library';
import { JawPlacement, WaxTooth, Waxup, curveMidline, toothWorld } from './waxup';
import { HeightField, ToothGroup, jawFrame } from './occlusion';
import { Scan, scanWorld } from '../scans';
import { ChainMode, chainsOf, contacts, settleChain, toothAxes } from './chain';
export type { Waxup };
export type { ChainMode };

export type WaxTab = 'simple' | 'advanced' | 'chain';
/** Simple tab: what a plain drag does (Ctrl = rotate, Shift = scale, Ctrl+Shift = scale in one direction) */
export type WaxAction = 'move' | 'rotate' | 'scale';
/** Simple tab: directions a change is limited to (tooth axes) */
export type WaxLimit = 'all' | 'md' | 'bl' | 'oc' | 'mdbl';
export type WaxAdvTool = 'axis' | 'cusps' | 'freeform';

export class WaxState {
  readonly model = new Waxup();
  /** the Waxup panel is open: teeth react to the mouse */
  editing = false;
  tab: WaxTab = 'simple';
  action: WaxAction = 'move';
  limit: WaxLimit = 'all';
  /** Simple tab: all teeth of the jaw together */
  moveAll = false;
  advTool: WaxAdvTool = 'axis';
  chainMode: ChainMode = 'chain';
  /** chain: teeth scaled when the chain is stretched or squeezed */
  scalable = true;
  /** chain: neighbours stay in contact */
  contact = true;
  /** chain: tube, discs and control points in the 3D view */
  showChain = true;
  /** chain: rotations limited to a buccal / lingual tilt */
  limitTilt = false;
  /** changes mirrored to the other side (anterior symmetry) */
  mirror = false;
  /** the tooth on the other side becomes the exact mirror image of the one changed (1-to-1) */
  mirrorShape = false;
  /**
   * instant shaping with the antagonist when teeth of a jaw are moved / scaled: cut where they reach
   * into it, or adapt (cut and draw the closest cusps onto it for contacts)
   */
  cut: Record<Jaw, 'off' | 'cut' | 'adapt'> = { upper: 'off', lower: 'off' };
  /** distance kept to the antagonist when cutting (mm) */
  cutGap = 0;
  /** the abrasion slider changes the front or the back teeth */
  abrasionGroup: ToothGroup = 'posterior';
  /** pinned teeth / chain ends (see chain.ts toothPin / discPin) */
  pins = new Set<string>();
  selected: number | null = null;
  hover: number | null = null;
  hoverPart: { fdi: number; i: number } | null = null;
  /** chain control / disc / axis handle under the mouse */
  hoverCtl: string | null = null;
  brushRadius = 1.5;
  /** 0..1 */
  brushStrength = 0.5;
  color: [number, number, number] = [246, 244, 238];
  opacity = 0.9;
  visible: Record<Jaw, boolean> = { upper: true, lower: true };
  /** outlines in the slices */
  contours = true;
  /** open the Waxup panel (set by the interface); `grabbed`: a tooth is being dragged in a view */
  openPanel: (grabbed?: boolean) => void = () => {};

  get cusps() {
    return this.editing && this.tab === 'advanced' && this.advTool === 'cusps';
  }
  get freeform() {
    return this.editing && this.tab === 'advanced' && this.advTool === 'freeform';
  }
  /** all teeth of the selected tooth's jaw are changed together */
  get wholeJaw() {
    return this.editing && this.tab === 'simple' && this.moveAll;
  }

  /** Changes that affect drawing (views compare it). */
  key(): string {
    const m = this.model;
    return JSON.stringify([
      m.teeth.map((t) => [t.fdi, t.geo, t.ver ?? 0, t.T]),
      this.selected, this.hover, this.hoverPart, this.hoverCtl, this.editing && [this.tab, this.advTool, this.chainMode, this.showChain, this.moveAll],
      [...this.pins], this.color, this.opacity, this.visible, this.contours,
    ]);
  }

  /** Contacts of a tooth with its neighbours and its axes (world) – tests and debugging. */
  contacts(t: WaxTooth) {
    return contacts(this.model, t);
  }
  axes(t: WaxTooth) {
    return toothAxes(this.model, t);
  }

  /** Teeth that are drawn. */
  shown() {
    return this.model.teeth.filter((t) => this.visible[t.jaw]);
  }

  /** Forget everything (new scan). */
  clear() {
    this.model.teeth = [];
    this.model.placement = {};
    this.model.abrasion = { anterior: 0, posterior: 0 };
    this.selected = this.hover = null;
    this.hoverPart = null;
    this.hoverCtl = null;
    this.pins.clear();
  }
}

/** The curve a jaw's teeth are set up on: with several curves, the highest for the upper jaw. */
function curveFor(app: App, jaw: Jaw): { curve: ArchCurve; level: number } | null {
  if (!app.curves.length) return null;
  const levelOf = (id: number, nav: number) => (id === app.activeCurveId ? app.focusC : nav);
  const list = app.curves.map((c) => ({ curve: c.curve, level: levelOf(c.id, c.nav.focusC) }));
  if (list.length === 1) return list[0];
  list.sort((a, b) => a.level - b.level);
  return jaw === 'upper' ? list[list.length - 1] : list[0];
}

/** Crown height of a jaw in the library (median, from the occlusal plane to the cervical end). */
function crownHeight(lib: ToothLibrary, jaw: Jaw): number {
  const h: number[] = [];
  for (const fdi of jawOrder(jaw)) {
    const p = lib.teeth.get(fdi)!.pos;
    let m = 0;
    for (let i = 2; i < p.length; i += 3) m = jaw === 'upper' ? Math.max(m, p[i]) : Math.max(m, -p[i]);
    h.push(m);
  }
  h.sort((a, b) => a - b);
  return h[h.length >> 1];
}

/**
 * Height (planning c) of the occlusal plane for new teeth, from the CBCT along the front 50 mm of
 * the curve. Two profiles over height: the share of bone (any hard tissue) and of enamel / metal
 * (twice the bone threshold):
 *   - crowns of both jaws in occlusion (an enamel band >= 10 mm): inside the band, in proportion
 *     to the crown heights;
 *   - crowns of one jaw only: on top of them (lower) or below them (upper), towards the empty side;
 *   - edentulous: in the empty band between the ridges, shared in proportion to the crown heights;
 *   - one ridge in view: on top of it (lower jaw) or below it (upper jaw).
 */
export function occlusalLevel(app: App, curve: ArchCurve, c0: number, jaw: Jaw, lib: ToothLibrary): number {
  const vol = app.vol;
  if (!vol) return c0;
  const thr = vol.boneThreshold();
  const hLow = crownHeight(lib, 'lower');
  const hUp = crownHeight(lib, 'upper');
  const share = hLow / (hLow + hUp);
  const mid = curveMidline(curve);
  const step = 0.5;
  const lo = c0 - 40;
  const n = Math.round(80 / step);
  const at = (i: number) => lo + i * step;
  const F = new Float64Array(n + 1); // bone
  const E = new Float64Array(n + 1); // enamel / metal
  let cols = 0;
  for (let s = mid - 25; s <= mid + 25; s += 2.5) {
    const cp = curve.at(clamp(s, 0, curve.length));
    cols++;
    for (let i = 0; i <= n; i++) {
      let v = -Infinity;
      for (const off of [-2, 0, 2]) {
        const w = fromFrame([cp.p[0] + cp.n[0] * off, cp.p[1] + cp.n[1] * off, at(i)], app.O, app.frame);
        v = Math.max(v, vol.sample(w));
      }
      if (v >= thr) F[i]++;
      if (v >= thr * 2) E[i]++;
    }
  }
  for (let i = 0; i <= n; i++) {
    F[i] /= cols;
    E[i] /= cols;
  }
  // crowns: the enamel band nearest c0
  let band: [number, number] | null = null;
  for (let i = 0; i <= n; ) {
    if (E[i] < 0.15) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && E[j + 1] >= 0.15) j++;
    // small breaks (between the cusps) belong to the band
    while (j + 4 <= n && E.subarray(j + 1, j + 5).some((x) => x >= 0.15)) {
      j++;
      while (j < n && E[j + 1] >= 0.15) j++;
    }
    if ((j - i) * step >= 4) {
      const g: [number, number] = [at(i), at(j)];
      const d = (x: [number, number]) => Math.max(0, x[0] - c0, c0 - x[1]);
      if (!band || d(g) < d(band)) band = g;
    }
    i = j + 1;
  }
  if (band) {
    const [b0, b1] = band;
    if (b1 - b0 >= 10) return b0 + (b1 - b0) * share;
    // one jaw's crowns: the occlusal plane is on the empty side
    const emptyAbove = F[Math.min(n, Math.round((b1 + 4 - lo) / step))] < 0.15;
    const emptyBelow = F[Math.max(0, Math.round((b0 - 4 - lo) / step))] < 0.15;
    if (emptyAbove && !emptyBelow) return b1;
    if (emptyBelow && !emptyAbove) return b0;
    return (b0 + b1) / 2;
  }
  // edentulous: the empty band between bone below and bone above (nearest c0)
  const maxBelow = new Float64Array(n + 1), maxAbove = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) maxBelow[i] = Math.max(maxBelow[i - 1], F[i - 1]);
  for (let i = n - 1; i >= 0; i--) maxAbove[i] = Math.max(maxAbove[i + 1], F[i + 1]);
  let gap: [number, number] | null = null;
  for (let i = 0; i <= n; ) {
    if (F[i] >= 0.15 || maxBelow[i] < 0.4 || maxAbove[i] < 0.4) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && F[j + 1] < 0.15) j++;
    const g: [number, number] = [at(i), at(j)];
    const d = (x: [number, number]) => Math.max(0, x[0] - c0, c0 - x[1]);
    if ((j - i) * step >= 3 && (!gap || d(g) < d(gap))) gap = g;
    i = j + 1;
  }
  if (gap) return gap[0] + (gap[1] - gap[0]) * share;
  // one ridge only
  if (jaw === 'lower') {
    for (let i = n; i >= 0; i--) if (F[i] >= 0.3) return at(i) + hLow + 0.5;
  } else {
    for (let i = 0; i <= n; i++) if (F[i] >= 0.3) return at(i) - hUp - 0.5;
  }
  return jaw === 'lower' ? c0 + hLow : c0 - hUp;
}

/** Set a jaw up on the current curve (teeth added later go to their place on this arch). */
export function placementFor(app: App, jaw: Jaw, lib: ToothLibrary): JawPlacement | null {
  const c = curveFor(app, jaw);
  if (!c) return null;
  const model = app.wax.model;
  const other = model.placement[jaw === 'upper' ? 'lower' : 'upper'];
  const level = other ? other.level : occlusalLevel(app, c.curve, c.level, jaw, lib);
  return {
    O: [...app.O] as Vec3,
    F: app.frame.map((a) => [...a]) as JawPlacement['F'],
    ctrl: c.curve.ctrl.map((p) => [p[0], p[1]]),
    sMid: curveMidline(c.curve),
    level,
    // one curve for both jaws: the upper arch sits a little outside the lower one
    buccal: jaw === 'upper' && app.curves.length === 1 ? 1.5 : 0,
    scale: 1,
    adjust: [...IDENTITY],
  };
}

/** Add teeth (FDI numbers); sets their jaw up first if needed. Resolves to an error text or null. */
export async function addTeeth(app: App, fdis: number[]): Promise<string | null> {
  if (!app.vol) return 'Open a CBCT first.';
  if (!app.curves.length) return 'Draw the panoramic curve first – the teeth are set up along it.';
  let lib: ToothLibrary;
  try {
    lib = await ensureLibrary();
  } catch (e) {
    return (e as Error).message;
  }
  const model = app.wax.model;
  model.lib = lib;
  const before = new Set<WaxTooth>(model.teeth);
  for (const fdi of fdis) {
    const jaw = jawOf(fdi);
    if (!model.placement[jaw]) {
      const pl = placementFor(app, jaw, lib);
      if (!pl) return 'Draw the panoramic curve first.';
      model.placement[jaw] = pl;
    }
    model.add(fdi);
  }
  // new teeth are set up in contact with each other and with the teeth already there
  for (const jaw of ['upper', 'lower'] as Jaw[])
    for (const c of chainsOf(model, jaw)) if (c.some((t) => !before.has(t))) settleChain(model, c, before, app.wax.scalable);
  if (fdis.length) app.wax.selected = fdis[fdis.length - 1];
  app.changed();
  return null;
}

/** Set a jaw up again on the current curve (all its teeth back to their library place and shape). */
export async function refitJaw(app: App, jaw: Jaw): Promise<string | null> {
  const model = app.wax.model;
  const fdis = model.teeth.filter((t) => t.jaw === jaw).map((t) => t.fdi);
  for (const f of fdis) model.remove(f);
  delete model.placement[jaw];
  return addTeeth(app, fdis);
}

export function removeTooth(app: App, fdi: number) {
  const m = app.wax.model;
  m.remove(fdi);
  if (!m.teeth.some((t) => t.jaw === jawOf(fdi))) delete m.placement[jawOf(fdi)];
  if (app.wax.selected === fdi) app.wax.selected = null;
  app.wax.pins.delete(`t${fdi}`);
  app.changed();
}


// ---- antagonist ----------------------------------------------------------------------------

/**
 * What the teeth of a jaw are cut against: the visible, placed scans of the opposing jaw (by their
 * kind, or – antagonist / other – lying on the far side of the occlusal plane) and the opposing
 * jaw's visible waxup teeth.
 */
export function antagonistsOf(app: App, jaw: Jaw): { scans: Scan[]; teeth: WaxTooth[] } {
  const m = app.wax.model;
  const pl = m.placement[jaw];
  if (!pl) return { scans: [], teeth: [] };
  const f = jawFrame(pl);
  const other: Jaw = jaw === 'upper' ? 'lower' : 'upper';
  const scans = app.scans.filter((s) => {
    if (!s.transform || !s.visible || s.kind === jaw) return false;
    if (s.kind === other) return true;
    const w = scanWorld(s);
    if (!w) return false;
    let sum = 0, n = 0;
    const step = 3 * Math.max(1, Math.floor(w.pos.length / 3 / 4000));
    for (let i = 0; i < w.pos.length; i += step) {
      sum += dot(sub([w.pos[i], w.pos[i + 1], w.pos[i + 2]], f.O), f.az);
      n++;
    }
    const mean = sum / Math.max(1, n);
    return jaw === 'upper' ? mean < f.level : mean > f.level;
  });
  return { scans, teeth: m.teeth.filter((t) => t.jaw === other && app.wax.visible[other]) };
}

/** The antagonist of a jaw as a height field over the region of its teeth (null: none). */
export function buildCutter(app: App, jaw: Jaw): HeightField | null {
  const m = app.wax.model;
  const pl = m.placement[jaw];
  const own = m.teeth.filter((t) => t.jaw === jaw);
  if (!pl || !own.length) return null;
  const src = antagonistsOf(app, jaw);
  if (!src.scans.length && !src.teeth.length) return null;
  const f = jawFrame(pl);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (const t of own) {
    const p = toothWorld(t).pos;
    for (let i = 0; i < p.length; i += 9) {
      const d = sub([p[i], p[i + 1], p[i + 2]], f.O);
      const a = dot(d, f.ax), b = dot(d, f.ay), c = dot(d, f.az);
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      b0 = Math.min(b0, b);
      b1 = Math.max(b1, b);
      c0 = Math.min(c0, c);
      c1 = Math.max(c1, c);
    }
  }
  // room for the teeth to move while they are dragged
  const hf = new HeightField(f, jaw === 'upper', a0 - 10, b0 - 10, a1 + 10, b1 + 10, c0 - 8, c1 + 8);
  for (const s of src.scans) {
    const w = scanWorld(s);
    if (w) hf.add(w.pos, s.mesh.idx);
  }
  for (const t of src.teeth) hf.add(toothWorld(t).pos, t.idx);
  return hf;
}
