// Chain mode of the waxup (the way dental CAD setups arrange the teeth of a bridge): the teeth of
// a run of neighbouring positions form a chain, shown as a tube through the contacts between the
// teeth with a placement disc at each end and a control point under every tooth and disc. A click
// on a control point pins it: pinned teeth and discs stay where they are.
//
// Every operation starts from a snapshot taken when the drag begins. Each tooth hangs on its two
// chain nodes (its contacts with the neighbours, or the disc at an end); an operation moves the
// nodes and every tooth follows its pair of nodes – turned to their new direction and, with "teeth
// scalable", stretched to their new distance – so teeth in contact stay in contact.
//   chain:  the dragged tooth carries the chain along; the influence fades towards pinned teeth /
//           discs (a rotation also fades towards the ends of the chain)
//   single: only the dragged tooth changes; with "keep in contact" its neighbours slide along the
//           tube, squeezed or stretched against pinned teeth / discs
//   tube:   the teeth slide along the tube; the arch itself stays

import { Vec3, add, cross, dot, length, normalize, scale, sub } from '../math';
import { Affine, applyV, compose, fromRot, invert, rotV, rotateOnto } from '../register';
import { ArchCurve } from '../curve';
import { Jaw, ToothLibrary, ToothTemplate, jawOrder } from './library';
import { WaxTooth, Waxup, archPose, det3, rotateScaleAbout, translation } from './waxup';

export type ChainMode = 'chain' | 'single' | 'tube';

// ---- tooth axes and contacts ------------------------------------------------------------

/** Unit axes of a tooth: along the chain (towards the next tooth in arch order), buccal, occlusal. */
export interface ToothAxes {
  md: Vec3;
  bl: Vec3;
  oc: Vec3;
}

const libAxesCache = new WeakMap<ToothTemplate, ToothAxes>();
/** Axes of a library tooth (library coordinates), from the library arch at its centroid. */
export function libAxes(lib: ToothLibrary, tpl: ToothTemplate): ToothAxes {
  let a = libAxesCache.get(tpl);
  if (!a) {
    // the library arch runs patient right -> left, like the FDI order of a jaw
    const L = new ArchCurve(lib.arch[tpl.jaw]);
    const cp = L.at(L.nearest(tpl.centroid[0], tpl.centroid[1]).s);
    a = { md: [cp.t[0], cp.t[1], 0], bl: [cp.n[0], cp.n[1], 0], oc: tpl.jaw === 'upper' ? [0, 0, -1] : [0, 0, 1] };
    libAxesCache.set(tpl, a);
  }
  return a;
}

/** Axes of a tooth in the world (follow the tooth's own turns). */
export function toothAxes(m: Waxup, t: WaxTooth): ToothAxes {
  const a = libAxes(m.lib!, m.template(t.fdi));
  const md = normalize(rotV(t.T, a.md));
  const o = rotV(t.T, a.oc);
  const oc = normalize(sub(o, scale(md, dot(o, md))));
  let bl = cross(oc, md);
  if (dot(bl, rotV(t.T, a.bl)) < 0) bl = scale(bl, -1);
  return { md, bl, oc };
}

interface LibContacts {
  ver: number;
  /** contact towards the previous / next tooth in arch order (library coordinates) */
  a: Vec3;
  b: Vec3;
  /** extent of the crown from the centroid towards the gingiva and buccally (mm) */
  ging: number;
  buc: number;
}
const contactCache = new WeakMap<Float32Array, LibContacts>();

function libContacts(m: Waxup, t: WaxTooth): LibContacts {
  const c = contactCache.get(t.pos);
  const ver = t.ver ?? 0;
  if (c && c.ver === ver) return c;
  const tpl = m.template(t.fdi);
  const ax = libAxes(m.lib!, tpl);
  const p = t.pos;
  let lo = Infinity, hi = -Infinity, g = 0, bu = 0;
  for (let i = 0; i < p.length; i += 3) {
    const d = p[i] * ax.md[0] + p[i + 1] * ax.md[1];
    if (d < lo) lo = d;
    if (d > hi) hi = d;
    const h = -((p[i] - tpl.centroid[0]) * ax.oc[0] + (p[i + 1] - tpl.centroid[1]) * ax.oc[1] + (p[i + 2] - tpl.centroid[2]) * ax.oc[2]);
    if (h > g) g = h;
    const b = (p[i] - tpl.centroid[0]) * ax.bl[0] + (p[i + 1] - tpl.centroid[1]) * ax.bl[1];
    if (b > bu) bu = b;
  }
  // the contact: mean of the vertices within 0.25 mm of the extreme
  const mean = (near: (d: number) => boolean): Vec3 => {
    const s: Vec3 = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < p.length; i += 3) {
      if (!near(p[i] * ax.md[0] + p[i + 1] * ax.md[1])) continue;
      s[0] += p[i];
      s[1] += p[i + 1];
      s[2] += p[i + 2];
      n++;
    }
    return scale(s, 1 / Math.max(1, n));
  };
  const out = { ver, a: mean((d) => d <= lo + 0.25), b: mean((d) => d >= hi - 0.25), ging: g, buc: bu };
  contactCache.set(t.pos, out);
  return out;
}

/** Contacts of a tooth with its neighbours (world): a = towards the previous tooth in arch order. */
export function contacts(m: Waxup, t: WaxTooth): { a: Vec3; b: Vec3 } {
  const c = libContacts(m, t);
  return { a: applyV(t.T, c.a), b: applyV(t.T, c.b) };
}

/**
 * Control point of a tooth (world): just outside its crown, buccally and towards the gingiva – so
 * it is beside the tooth seen from the occlusal side and below it seen from the buccal side.
 */
export function controlPoint(m: Waxup, t: WaxTooth): Vec3 {
  const tpl = m.template(t.fdi);
  const ax = libAxes(m.lib!, tpl);
  const c = libContacts(m, t);
  const s = Math.cbrt(Math.abs(det3(t.T))) || 1;
  return applyV(t.T, add(tpl.centroid, add(scale(ax.bl, c.buc + 1.5 / s), scale(ax.oc, -c.ging * 0.75))));
}

// ---- chains -----------------------------------------------------------------------------

/** Runs of neighbouring teeth of a jaw (arch order). */
export function chainsOf(m: Waxup, jaw: Jaw): WaxTooth[][] {
  const out: WaxTooth[][] = [];
  let run: WaxTooth[] = [];
  for (const fdi of jawOrder(jaw)) {
    const t = m.tooth(fdi);
    if (t) run.push(t);
    else if (run.length) {
      out.push(run);
      run = [];
    }
  }
  if (run.length) out.push(run);
  return out;
}

export function chainOf(m: Waxup, t: WaxTooth): WaxTooth[] {
  return chainsOf(m, t.jaw).find((c) => c.includes(t)) ?? [t];
}

/** Pin keys: a tooth, or the disc at the start (a) / end (b) of the chain a tooth begins / ends. */
export const toothPin = (fdi: number) => `t${fdi}`;
export const discPin = (chain: WaxTooth[], end: 'a' | 'b') => (end === 'a' ? `a${chain[0].fdi}` : `b${chain[chain.length - 1].fdi}`);

// ---- the tube -----------------------------------------------------------------------------

/** Smooth curve through points (Catmull-Rom), by arc length; straight beyond the ends. */
export class Tube {
  readonly pts: Vec3[] = [];
  private cum: number[] = [];
  /** arc length of every node */
  readonly S: number[] = [];
  readonly length: number;

  constructor(nodes: Vec3[], per = 8) {
    const n = nodes.length;
    this.pts.push(nodes[0]);
    this.cum.push(0);
    this.S.push(0);
    let L = 0;
    for (let i = 0; i + 1 < n; i++) {
      const p0 = nodes[Math.max(0, i - 1)], p1 = nodes[i], p2 = nodes[i + 1], p3 = nodes[Math.min(n - 1, i + 2)];
      for (let k = 1; k <= per; k++) {
        const t = k / per, t2 = t * t, t3 = t2 * t;
        const q: Vec3 = [0, 0, 0];
        for (let d = 0; d < 3; d++)
          q[d] = 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3);
        if (k === per) q.splice(0, 3, ...p2);
        L += length(sub(q, this.pts[this.pts.length - 1]));
        this.pts.push(q);
        this.cum.push(L);
      }
      this.S.push(L);
    }
    this.length = L;
  }

  private endDir(end: 0 | 1): Vec3 {
    const P = this.pts;
    const n = P.length;
    if (n < 2) return [1, 0, 0];
    return end === 0 ? normalize(sub(P[1], P[0])) : normalize(sub(P[n - 1], P[n - 2]));
  }

  at(s: number): Vec3 {
    const P = this.pts, c = this.cum, n = P.length;
    if (n === 1) return P[0];
    if (s <= 0) return add(P[0], scale(this.endDir(0), s));
    if (s >= this.length) return add(P[n - 1], scale(this.endDir(1), s - this.length));
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    const f = c[hi] > c[lo] ? (s - c[lo]) / (c[hi] - c[lo]) : 0;
    return add(P[lo], scale(sub(P[hi], P[lo]), f));
  }

  tangent(s: number): Vec3 {
    return normalize(sub(this.at(s + 0.5), this.at(s - 0.5)));
  }

  /** Arc length of the point of the tube (or its straight extensions) nearest to p. */
  closest(p: Vec3): number {
    const P = this.pts, c = this.cum;
    let best = Infinity, bs = 0;
    for (let i = 0; i + 1 < P.length; i++) {
      const d = sub(P[i + 1], P[i]);
      const l2 = dot(d, d);
      let t = l2 > 0 ? dot(sub(p, P[i]), d) / l2 : 0;
      if (i > 0 || t > 0) t = Math.max(0, t);
      if (i + 2 < P.length || t < 1) t = Math.min(1, t);
      const q = add(P[i], scale(d, t));
      const dd = length(sub(p, q));
      if (dd < best) {
        best = dd;
        bs = c[i] + t * (c[i + 1] - c[i]);
      }
    }
    return bs;
  }
}

// ---- snapshot ------------------------------------------------------------------------------

export interface ChainSnap {
  teeth: WaxTooth[];
  T0: Affine[];
  /** n + 1 nodes: the a disc, the contacts between the teeth, the b disc */
  nodes: Vec3[];
  tube: Tube;
  /** arc length of every node */
  S: number[];
  /** nodes that stay (pinned discs, contacts of pinned teeth) */
  pinned: boolean[];
  toothPinned: boolean[];
}

export function snapshot(m: Waxup, teeth: WaxTooth[], pins: ReadonlySet<string> = new Set()): ChainSnap {
  const n = teeth.length;
  const C = teeth.map((t) => contacts(m, t));
  const tp = teeth.map((t) => pins.has(toothPin(t.fdi)));
  const nodes: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    if (k === 0) nodes.push(C[0].a);
    else if (k === n) nodes.push(C[n - 1].b);
    else if (tp[k - 1] && !tp[k]) nodes.push(C[k - 1].b);
    else if (tp[k] && !tp[k - 1]) nodes.push(C[k].a);
    else nodes.push(scale(add(C[k - 1].b, C[k].a), 0.5));
  }
  const tube = new Tube(nodes);
  const pinned = nodes.map((_, k) => (k > 0 && tp[k - 1]) || (k < n && tp[k]) || (k === 0 && pins.has(discPin(teeth, 'a'))) || (k === n && pins.has(discPin(teeth, 'b'))));
  return { teeth, T0: teeth.map((t) => t.T.slice()), nodes, tube, S: tube.S, pinned, toothPinned: tp };
}

// ---- operations -------------------------------------------------------------------------------

const MIN_SCALE = 0.5;
const MAX_SCALE = 2;
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const smooth = (x: number) => x * x * (3 - 2 * x);
export const toothScale = (T: Affine) => Math.cbrt(Math.abs(det3(T)));

/**
 * Transform carrying the segment x0–x1 onto y0–y1: turned onto the new direction, moved onto its
 * middle, and – when `scalable` – scaled to its length (`f` forces a scale). `s0`: the tooth's own
 * scale, to keep it within limits.
 */
export function chordMap(x0: Vec3, x1: Vec3, y0: Vec3, y1: Vec3, scalable: boolean, s0 = 1, f?: number): Affine {
  const u = sub(x1, x0), v = sub(y1, y0);
  const lu = length(u), lv = length(v);
  const mx = mid(x0, x1), my = mid(y0, y1);
  if (lu < 1e-6 || lv < 1e-6) return translation(sub(my, mx));
  let k = f ?? (scalable ? lv / lu : 1);
  k = Math.min(MAX_SCALE / s0, Math.max(MIN_SCALE / s0, k));
  const R = rotateOnto(scale(u, 1 / lu), scale(v, 1 / lv)).map((r) => r * k);
  const t: Vec3 = [
    my[0] - (R[0] * mx[0] + R[1] * mx[1] + R[2] * mx[2]),
    my[1] - (R[3] * mx[0] + R[4] * mx[1] + R[5] * mx[2]),
    my[2] - (R[6] * mx[0] + R[7] * mx[1] + R[8] * mx[2]),
  ];
  return fromRot(R, t);
}

/** What happens to the chain. */
export type ChainOp =
  /** chain / tube mode: the dragged tooth (and the chain, fading) */
  | { kind: 'move'; d: Vec3 }
  | { kind: 'rotate'; axis: Vec3; angle: number; c: Vec3 }
  | { kind: 'scale'; f: number; c: Vec3 }
  /** tube mode: along the tube (mm) */
  | { kind: 'slide'; ds: number }
  /** single mode: the dragged tooth's new transform */
  | { kind: 'set'; T: Affine };

export type ChainDriver = { tooth: number } | { disc: 'a' | 'b' };

export interface ChainOpts {
  mode: ChainMode;
  scalable: boolean;
  contact: boolean;
}

/** The op as a transform at influence w (0..1). */
function weighted(op: ChainOp, w: number): Affine {
  switch (op.kind) {
    case 'move':
      return translation(scale(op.d, w));
    case 'rotate':
      return rotateScaleAbout(op.c, op.axis, op.angle * w, 1);
    case 'scale':
      return rotateScaleAbout(op.c, [0, 0, 1], 0, Math.pow(op.f, w));
    default:
      return translation([0, 0, 0]);
  }
}

/**
 * Influence of a driver on nodes lo..hi: 1 there, fading smoothly to 0 at the nearest pinned node
 * on each side (`ends`: the ends of the chain count as pinned); 1 on a side without one.
 */
function influence(snap: ChainSnap, lo: number, hi: number, ends: boolean, linear = false): (s: number) => number {
  const { S, pinned } = snap;
  const n = S.length - 1;
  let aL: number | null = null, aR: number | null = null;
  for (let k = lo - 1; k >= 0; k--) if (pinned[k]) { aL = S[k]; break; }
  for (let k = hi + 1; k <= n; k++) if (pinned[k]) { aR = S[k]; break; }
  if (aL === null && ends && lo > 0) aL = S[0];
  if (aR === null && ends && hi < n) aR = S[n];
  const sLo = S[lo], sHi = S[hi];
  const f = (x: number) => (linear ? 1 - x : 1 - smooth(x));
  return (s) => {
    if (s >= sLo && s <= sHi) return 1;
    if (s > sHi) return aR === null ? 1 : s >= aR ? 0 : f((s - sHi) / (aR - sHi));
    return aL === null ? 1 : s <= aL ? 0 : f((sLo - s) / (sLo - aL));
  };
}

/**
 * New arc positions of the nodes on one side of a node that moved along the tube by `ds`: shifted
 * by ds or, up to a pinned node, stretched / squeezed between the moved node and the pinned one.
 */
function spread(snap: ChainSnap, from: number, ds: number, dir: 1 | -1, out: (Vec3 | null)[], arcs: (number | null)[]) {
  const { S, pinned, tube } = snap;
  const n = S.length - 1;
  let anchor = -1;
  for (let k = from + dir; k >= 0 && k <= n; k += dir) if (pinned[k]) { anchor = k; break; }
  if (anchor < 0) {
    for (let k = from + dir; k >= 0 && k <= n; k += dir) {
      out[k] = tube.at(S[k] + ds);
      arcs[k] = S[k] + ds;
    }
    return;
  }
  const sA = S[anchor];
  // at least 1 mm per tooth is left before the pinned node
  const minRoom = Math.abs(anchor - from);
  const sMoved = dir > 0 ? Math.min(S[from] + ds, sA - minRoom) : Math.max(S[from] + ds, sA + minRoom);
  const room0 = S[from] - sA;
  const f = Math.abs(room0) > 1e-6 ? (sMoved - sA) / room0 : 1;
  for (let k = from + dir; k !== anchor; k += dir) {
    arcs[k] = sA + (S[k] - sA) * f;
    out[k] = tube.at(arcs[k]!);
  }
}

/** Apply an operation to a chain (sets the teeth's transforms from the snapshot). */
export function applyChain(snap: ChainSnap, driver: ChainDriver, op: ChainOp, o: ChainOpts) {
  const { teeth, T0, nodes: N0, S, pinned, tube } = snap;
  const n = teeth.length;
  const nodes: (Vec3 | null)[] = new Array(n + 1).fill(null); // null = unchanged
  /** new arc length of nodes moved along the tube (the teeth between them keep their size there) */
  const arcs: (number | null)[] = new Array(n + 1).fill(null);
  const T = T0.map((x) => x.slice());
  const fixed = snap.toothPinned.slice();
  /** provisional transform of every free tooth (before following its nodes) */
  const pre: Affine[] = T0.map(() => translation([0, 0, 0]));
  const lo = 'tooth' in driver ? driver.tooth : driver.disc === 'a' ? 0 : n;
  const hi = 'tooth' in driver ? driver.tooth + 1 : lo;
  const setNode = (k: number, p: Vec3) => {
    if (!pinned[k]) nodes[k] = p;
  };
  const centre = (k: number) => (S[k] + S[k + 1]) / 2;
  let relayAll = false;

  if ('disc' in driver) {
    // an end of the chain: the other end stays (as if pinned), the teeth in between are spread
    if (pinned[lo]) return;
    const sn: ChainSnap = { ...snap, pinned: pinned.map((p, k) => p || k === (lo === 0 ? n : 0)) };
    if (o.mode === 'tube' && op.kind === 'slide') {
      setNode(lo, tube.at(S[lo] + op.ds));
      arcs[lo] = S[lo] + op.ds;
      spread(sn, lo, op.ds, lo === 0 ? 1 : -1, nodes, arcs);
    } else if (op.kind === 'move') {
      const w = influence(sn, lo, hi, false, true);
      for (let k = 0; k <= n; k++) if (!sn.pinned[k] || k === lo) setNode(k, add(N0[k], scale(op.d, w(S[k]))));
      for (let k = 0; k < n; k++) pre[k] = weighted(op, w(centre(k)));
    }
    relayAll = true;
  } else {
    const g = driver.tooth;
    fixed[g] = true;
    if (o.mode === 'single' || op.kind === 'set') {
      T[g] = op.kind === 'set' ? op.T : compose(weighted(op, 1), T0[g]);
      if (o.contact || o.mode === 'tube') {
        const D = compose(T[g], invert(T0[g]));
        const a = applyV(D, N0[lo]), b = applyV(D, N0[hi]);
        setNode(lo, a);
        setNode(hi, b);
        const dsB = dot(sub(b, N0[hi]), tube.tangent(S[hi])), dsA = dot(sub(a, N0[lo]), tube.tangent(S[lo]));
        // the neighbours keep their size when nothing squeezes them (see the arc lengths below)
        arcs[hi] = S[hi] + dsB;
        arcs[lo] = S[lo] + dsA;
        if (!pinned[hi]) spread(snap, hi, dsB, 1, nodes, arcs);
        if (!pinned[lo]) spread(snap, lo, dsA, -1, nodes, arcs);
      }
    } else if (op.kind === 'slide') {
      // tube: the dragged tooth slides along the tube, the others follow (or are spread)
      const a = tube.at(S[lo] + op.ds), b = tube.at(S[hi] + op.ds);
      T[g] = compose(chordMap(N0[lo], N0[hi], a, b, false, toothScale(T0[g])), T0[g]);
      setNode(lo, a);
      setNode(hi, b);
      arcs[lo] = S[lo] + op.ds;
      arcs[hi] = S[hi] + op.ds;
      if (!pinned[hi]) spread(snap, hi, op.ds, 1, nodes, arcs);
      if (!pinned[lo]) spread(snap, lo, op.ds, -1, nodes, arcs);
    } else {
      // chain (and tube rotation / scaling): weighted by the influence along the chain
      const D = weighted(op, 1);
      T[g] = compose(D, T0[g]);
      const w = influence(snap, lo, hi, op.kind === 'rotate');
      for (let k = 0; k <= n; k++) setNode(k, k === lo || k === hi ? applyV(D, N0[k]) : applyV(weighted(op, w(S[k])), N0[k]));
      for (let k = 0; k < n; k++) pre[k] = weighted(op, w(centre(k)));
      relayAll = true;
    }
  }

  const follow = o.contact || o.mode === 'tube' || 'disc' in driver;
  for (let k = 0; k < n; k++) {
    if (fixed[k]) continue;
    if (!follow) {
      if (relayAll) T[k] = compose(pre[k], T0[k]);
      continue;
    }
    const y0 = nodes[k] ?? N0[k], y1 = nodes[k + 1] ?? N0[k + 1];
    if (!nodes[k] && !nodes[k + 1] && !relayAll) continue;
    const P = pre[k];
    // both ends moved along the tube: the size follows the arc length, not the chord
    const a0 = nodes[k] ? arcs[k] : S[k], a1 = nodes[k + 1] ? arcs[k + 1] : S[k + 1];
    const f = a0 !== null && a1 !== null && S[k + 1] - S[k] > 1e-6 ? (o.scalable ? (a1 - a0) / (S[k + 1] - S[k]) : 1) : undefined;
    const M = chordMap(applyV(P, N0[k]), applyV(P, N0[k + 1]), y0, y1, o.scalable, toothScale(compose(P, T0[k])), f);
    T[k] = compose(M, compose(P, T0[k]));
  }
  teeth.forEach((t, k) => (t.T = T[k]));
}

// ---- contacts closed -------------------------------------------------------------------------

/**
 * Lay the teeth of a chain in contact along their tube. `fixed` teeth stay; free teeth between two
 * fixed ones fill the space (scaled when `scalable`, else centred), others are stacked from the
 * fixed side – or, with nothing fixed, outwards from the midline (or the middle of the chain).
 */
export function settleChain(m: Waxup, teeth: WaxTooth[], fixed: ReadonlySet<WaxTooth>, scalable: boolean) {
  const n = teeth.length;
  if (!n || teeth.every((t) => fixed.has(t))) return;
  const snap = snapshot(m, teeth);
  const { tube } = snap;
  const C = teeth.map((t) => contacts(m, t));
  const W = C.map((c) => length(sub(c.b, c.a)));
  const isFixed = teeth.map((t) => fixed.has(t));
  const place = (k: number, a: Vec3, b: Vec3, f: number) => {
    const t = teeth[k];
    t.T = compose(chordMap(C[k].a, C[k].b, a, b, false, toothScale(t.T), f), t.T);
  };
  // each tooth starts where the previous one ends (exact contacts), heading along the tube
  const forward = (from: number, to: number, P0: Vec3, s0: number, f: number) => {
    let P = P0, s = s0;
    for (let k = from; k <= to; k++) {
      const w = W[k] * f;
      const Q = add(P, scale(normalize(sub(tube.at(s + w), P)), w));
      place(k, P, Q, f);
      P = Q;
      s += w;
    }
  };
  const backward = (from: number, to: number, P0: Vec3, s0: number, f: number) => {
    let P = P0, s = s0;
    for (let k = from; k >= to; k--) {
      const w = W[k] * f;
      const Q = add(P, scale(normalize(sub(tube.at(s - w), P)), w));
      place(k, Q, P, f);
      P = Q;
      s -= w;
    }
  };
  if (!isFixed.some(Boolean)) {
    // the midline stays (between x1 and y1), or the middle of the chain
    let k0 = -1;
    for (let k = 1; k < n; k++) if (Math.floor(teeth[k].fdi / 10) !== Math.floor(teeth[k - 1].fdi / 10)) k0 = k;
    if (k0 > 0) {
      forward(k0, n - 1, snap.nodes[k0], snap.S[k0], 1);
      backward(k0 - 1, 0, snap.nodes[k0], snap.S[k0], 1);
    } else {
      const total = W.reduce((a, b) => a + b, 0);
      const s0 = (snap.S[0] + snap.S[n]) / 2 - total / 2;
      forward(0, n - 1, tube.at(s0), s0, 1);
    }
    return;
  }
  for (let k = 0; k < n; ) {
    if (isFixed[k]) {
      k++;
      continue;
    }
    let j = k;
    while (j + 1 < n && !isFixed[j + 1]) j++;
    const left = k > 0 ? tube.closest(C[k - 1].b) : null;
    const right = j + 1 < n ? tube.closest(C[j + 1].a) : null;
    let total = 0;
    for (let i = k; i <= j; i++) total += W[i];
    if (left !== null && right !== null) {
      // between two fixed teeth: filled (scaled) or centred
      const room = Math.max(0, right - left);
      if (scalable) forward(k, j, C[k - 1].b, left, total > 0 ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, room / total)) : 1);
      else forward(k, j, tube.at(left + (room - total) / 2), left + (room - total) / 2, 1);
    } else if (left !== null) forward(k, j, C[k - 1].b, left, 1);
    else if (right !== null) backward(j, k, C[j + 1].a, right, 1);
    k = j + 1;
  }
}

/** Back to the place on the arch (shapes kept), then contacts closed against the teeth kept. */
export function resetPositions(m: Waxup, which: (t: WaxTooth) => boolean, scalable: boolean) {
  if (!m.lib) return;
  const keep = new Set<WaxTooth>();
  for (const t of m.teeth) {
    const pl = m.placement[t.jaw];
    if (which(t) && pl) t.T = archPose(m.lib, pl, t.fdi);
    else keep.add(t);
  }
  for (const jaw of ['upper', 'lower'] as Jaw[]) for (const c of chainsOf(m, jaw)) settleChain(m, c, keep, scalable);
}

// ---- drawing --------------------------------------------------------------------------------------

export interface ChainControls {
  teeth: WaxTooth[];
  tube: Tube;
  /** control point of every tooth (world) */
  points: { fdi: number; key: string; w: Vec3 }[];
  discs: { end: 'a' | 'b'; key: string; c: Vec3; normal: Vec3; up: Vec3; r: number; ctl: Vec3 }[];
}

/** Tube, discs and control points of every chain of the shown teeth. */
export function chainControls(m: Waxup, shown: (jaw: Jaw) => boolean): ChainControls[] {
  const out: ChainControls[] = [];
  if (!m.lib) return out;
  for (const jaw of ['upper', 'lower'] as Jaw[]) {
    if (!shown(jaw)) continue;
    for (const teeth of chainsOf(m, jaw)) {
      const snap = snapshot(m, teeth);
      const n = teeth.length;
      const points = teeth.map((t) => ({ fdi: t.fdi, key: toothPin(t.fdi), w: controlPoint(m, t) }));
      const discs = (['a', 'b'] as const).map((end) => {
        const k = end === 'a' ? 0 : n;
        const t = teeth[end === 'a' ? 0 : n - 1];
        const c = snap.nodes[k];
        const normal = snap.tube.tangent(snap.S[k]);
        const ax = toothAxes(m, t);
        const up = normalize(sub(ax.oc, scale(normal, dot(ax.oc, normal))));
        // the control point hangs below the disc like the tooth's below the tooth
        const ctl = add(c, sub(points[end === 'a' ? 0 : n - 1].w, m.center(t)));
        return { end, key: discPin(teeth, end), c, normal, up, r: 4.2 * toothScale(t.T), ctl };
      });
      out.push({ teeth, tube: snap.tube, points, discs });
    }
  }
  return out;
}

// ---- mirroring -------------------------------------------------------------------------------------

const flipCache = new WeakMap<Uint32Array, Uint32Array>();
/** Triangles with the opposite winding (for mirrored geometry). */
export function flipped(idx: Uint32Array): Uint32Array {
  let f = flipCache.get(idx);
  if (!f) {
    f = new Uint32Array(idx.length);
    for (let i = 0; i < idx.length; i += 3) {
      f[i] = idx[i];
      f[i + 1] = idx[i + 2];
      f[i + 2] = idx[i + 1];
    }
    flipCache.set(idx, f);
    flipCache.set(f, idx);
  }
  return f;
}

/** Vertices of `src` mirrored by the world reflection M, in the library coordinates of `dst`. */
export function mirroredVertices(src: WaxTooth, dst: WaxTooth, M: Affine): Float32Array {
  const A = compose(invert(dst.T), compose(M, src.T));
  const p = src.pos;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = A[0] * x + A[1] * y + A[2] * z + A[3];
    out[i + 1] = A[4] * x + A[5] * y + A[6] * z + A[7];
    out[i + 2] = A[8] * x + A[9] * y + A[10] * z + A[11];
  }
  return out;
}
