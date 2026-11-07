// The waxup inside the app: state of the Waxup panel and the operations the interface calls
// (set up a jaw on the curve, add / remove / reset teeth), plus the starting height of the teeth
// found in the CBCT.

import type { App } from '../app';
import type { ArchCurve } from '../curve';
import { Vec3, clamp, fromFrame } from '../math';
import { IDENTITY } from '../register';
import { Jaw, ToothLibrary, ensureLibrary, jawOf, jawOrder } from './library';
import { JawPlacement, Waxup, curveMidline } from './waxup';
export type { Waxup };

export type WaxTool = 'position' | 'parts' | 'freeform';

export class WaxState {
  readonly model = new Waxup();
  /** the Waxup panel is open: teeth react to the mouse */
  editing = false;
  tool: WaxTool = 'position';
  /** move single teeth or the whole jaw */
  scope: 'tooth' | 'jaw' = 'tooth';
  chain = true;
  mirror = false;
  selected: number | null = null;
  hover: number | null = null;
  hoverPart: { fdi: number; i: number } | null = null;
  brushRadius = 1.5;
  /** 0..1 */
  brushStrength = 0.5;
  color: [number, number, number] = [246, 244, 238];
  opacity = 0.9;
  visible: Record<Jaw, boolean> = { upper: true, lower: true };
  /** outlines in the slices */
  contours = true;
  /** open the Waxup panel (set by the interface) */
  openPanel: () => void = () => {};

  /** Changes that affect drawing (views compare it). */
  key(): string {
    const m = this.model;
    return JSON.stringify([
      m.teeth.map((t) => [t.fdi, t.geo, t.ver ?? 0, t.T]),
      this.selected, this.hover, this.hoverPart, this.editing && this.tool, this.scope,
      this.color, this.opacity, this.visible, this.contours,
    ]);
  }

  /** Teeth that are drawn. */
  shown() {
    return this.model.teeth.filter((t) => this.visible[t.jaw]);
  }

  /** Forget everything (new scan). */
  clear() {
    this.model.teeth = [];
    this.model.placement = {};
    this.selected = this.hover = null;
    this.hoverPart = null;
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
  for (const fdi of fdis) {
    const jaw = jawOf(fdi);
    if (!model.placement[jaw]) {
      const pl = placementFor(app, jaw, lib);
      if (!pl) return 'Draw the panoramic curve first.';
      model.placement[jaw] = pl;
    }
    model.add(fdi);
  }
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
  app.changed();
}

