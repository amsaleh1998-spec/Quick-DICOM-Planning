// Waxup: library teeth set up on the patient's arch, then positioned, scaled and shaped.
//
// Every tooth keeps its library vertices (until they are sculpted) and one transform library ->
// world (rotation × uniform scale + translation). Teeth of a jaw are first placed along the
// panoramic curve (each library tooth keeps its position along its library arch); after that every
// change is a change of that transform or of the vertices.

import { ArchCurve } from '../curve';
import { Frame, Vec2, Vec3, dot, normalize } from '../math';
import { vertexNormals } from '../meshio';
import { Affine, applyV, compose, invert } from '../register';
import { Jaw, ToothLibrary, ToothTemplate, contralateral, jawOrder } from './library';
import { RELIEF, ToothGroup, abrade, groupOf, reliefScale } from './occlusion';

export interface WaxTooth {
  fdi: number;
  jaw: Jaw;
  /** vertices (library coordinates): the template's until sculpted, then a copy per edit */
  pos: Float32Array;
  idx: Uint32Array;
  /** library -> world */
  T: Affine;
  /** geometry id: a new vertex array for every sculpting stroke (undo); 0 = the library's */
  geo: number;
  /** bumped while a stroke changes the vertices in place (render caches) */
  ver?: number;
}

/** How new teeth of a jaw are set up: the patient's curve and the occlusal plane at the time. */
export interface JawPlacement {
  /** planning frame */
  O: Vec3;
  F: Frame;
  /** panoramic curve (planning a, b) */
  ctrl: Vec2[];
  /** arc length of the midline on the curve */
  sMid: number;
  /** occlusal plane (planning c) */
  level: number;
  /** extra buccal offset of the whole jaw (mm) */
  buccal: number;
  scale: number;
  /** later moves / turns / scaling of the whole jaw (world), applied to teeth added afterwards too */
  adjust: Affine;
}

let nextGeo = 1;
export const newGeo = () => nextGeo++;
export function reserveGeo(id: number) {
  nextGeo = Math.max(nextGeo, id + 1);
}

// ---- arch placement ------------------------------------------------------------------

const archCache = new WeakMap<Vec2[], { curve: ArchCurve; mid: number }>();
function libArch(lib: ToothLibrary, jaw: Jaw) {
  const pts = lib.arch[jaw];
  let c = archCache.get(pts);
  if (!c) {
    const curve = new ArchCurve(pts);
    const front = Math.min(...pts.map((p) => p[1]));
    c = { curve, mid: curve.nearest(0, front).s };
    archCache.set(pts, c);
  }
  return c;
}

/** Arc length of the midline of a patient curve: its most anterior point (front of the U). */
export function curveMidline(curve: ArchCurve): number {
  let best = 0;
  let bestB = Infinity;
  for (let s = 0; s <= curve.length; s += 0.5) {
    const b = curve.position(s)[1];
    if (b < bestB) {
      bestB = b;
      best = s;
    }
  }
  // a curve over one side only has its front at an end: take the middle instead
  if (best < curve.length * 0.15 || best > curve.length * 0.85) return curve.length / 2;
  return best;
}

/** library -> world for a tooth set up on the jaw's arch. */
export function archPose(lib: ToothLibrary, pl: JawPlacement, fdi: number): Affine {
  const t = lib.teeth.get(fdi)!;
  const { curve: L, mid } = libArch(lib, t.jaw);
  const c = t.centroid;
  const ls = L.nearest(c[0], c[1]).s;
  const la = L.at(ls);
  const off = (c[0] - la.p[0]) * la.n[0] + (c[1] - la.p[1]) * la.n[1];
  const P = new ArchCurve(pl.ctrl);
  const k = pl.scale;
  const cp = P.at(pl.sMid + (ls - mid) * k);
  const d = Math.atan2(cp.t[1], cp.t[0]) - Math.atan2(la.t[1], la.t[0]);
  const cs = Math.cos(d) * k, sn = Math.sin(d) * k;
  // planning coordinates: Rz(d)·k·(v - c) + target
  const R = [cs, -sn, 0, sn, cs, 0, 0, 0, k];
  const tgt: Vec3 = [cp.p[0] + cp.n[0] * (off * k + pl.buccal), cp.p[1] + cp.n[1] * (off * k + pl.buccal), pl.level + c[2] * k];
  const tp: Vec3 = [
    tgt[0] - (R[0] * c[0] + R[1] * c[1] + R[2] * c[2]),
    tgt[1] - (R[3] * c[0] + R[4] * c[1] + R[5] * c[2]),
    tgt[2] - (R[6] * c[0] + R[7] * c[1] + R[8] * c[2]),
  ];
  // planning -> world: w = O + Σ F[k] · p[k]
  const F = pl.F;
  const G = (r: number, kk: number) => F[kk][r];
  const out = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let cc = 0; cc < 3; cc++) out[r * 4 + cc] = G(r, 0) * R[cc] + G(r, 1) * R[3 + cc] + G(r, 2) * R[6 + cc];
    out[r * 4 + 3] = pl.O[r] + G(r, 0) * tp[0] + G(r, 1) * tp[1] + G(r, 2) * tp[2];
  }
  return compose(pl.adjust, out);
}

/** Mirror plane of a jaw (midsagittal): a point and the unit normal (world, towards patient left). */
export function mirrorPlane(pl: JawPlacement): { p: Vec3; n: Vec3 } {
  const P = new ArchCurve(pl.ctrl);
  const cp = P.at(pl.sMid);
  const F = pl.F;
  const w = (a: number, b: number, c: number): Vec3 => [
    pl.O[0] + F[0][0] * a + F[1][0] * b + F[2][0] * c,
    pl.O[1] + F[0][1] * a + F[1][1] * b + F[2][1] * c,
    pl.O[2] + F[0][2] * a + F[1][2] * b + F[2][2] * c,
  ];
  const p0 = applyV(pl.adjust, w(cp.p[0], cp.p[1], pl.level));
  const p1 = applyV(pl.adjust, w(cp.p[0] + cp.t[0], cp.p[1] + cp.t[1], pl.level));
  return { p: p0, n: normalize([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]) };
}

/** Reflection about a plane as an (improper) affine. */
export function reflection(p: Vec3, n: Vec3): Affine {
  const d = dot(p, n);
  const m = (i: number, j: number) => (i === j ? 1 : 0) - 2 * n[i] * n[j];
  return [m(0, 0), m(0, 1), m(0, 2), 2 * d * n[0], m(1, 0), m(1, 1), m(1, 2), 2 * d * n[1], m(2, 0), m(2, 1), m(2, 2), 2 * d * n[2]];
}

// ---- the waxup ------------------------------------------------------------------------

export class Waxup {
  teeth: WaxTooth[] = [];
  placement: Partial<Record<Jaw, JawPlacement>> = {};
  /** templates the unsculpted teeth share */
  lib: ToothLibrary | null = null;
  /** -1 pointed … 0 library … 1 flat, for the front teeth (13–23, 33–43) and the back teeth */
  abrasion: Record<ToothGroup, number> = { anterior: 0, posterior: 0 };

  /** Library shape of a tooth with its group's abrasion (own vertices when abraded). */
  private libraryShape(tpl: ToothTemplate): { pos: Float32Array; geo: number } {
    const g = groupOf(tpl.fdi);
    const v = this.abrasion[g];
    return v ? { pos: abrade(tpl.pos, tpl.jaw, reliefScale(v), RELIEF[g]), geo: newGeo() } : { pos: tpl.pos, geo: 0 };
  }

  tooth(fdi: number | null): WaxTooth | null {
    return this.teeth.find((t) => t.fdi === fdi) ?? null;
  }

  jawTeeth(jaw: Jaw): WaxTooth[] {
    const order = jawOrder(jaw);
    return this.teeth.filter((t) => t.jaw === jaw).sort((a, b) => order.indexOf(a.fdi) - order.indexOf(b.fdi));
  }

  template(fdi: number): ToothTemplate {
    const t = this.lib?.teeth.get(fdi);
    if (!t) throw new Error(`No library tooth ${fdi}`);
    return t;
  }

  /** Add a tooth at its place on the arch (the jaw must have a placement). */
  add(fdi: number): WaxTooth {
    const existing = this.tooth(fdi);
    if (existing) return existing;
    const tpl = this.template(fdi);
    const pl = this.placement[tpl.jaw];
    if (!pl || !this.lib) throw new Error('Set up the arch first');
    const sh = this.libraryShape(tpl);
    const t: WaxTooth = { fdi, jaw: tpl.jaw, pos: sh.pos, idx: tpl.idx, T: archPose(this.lib, pl, fdi), geo: sh.geo };
    this.teeth.push(t);
    return t;
  }

  remove(fdi: number) {
    this.teeth = this.teeth.filter((t) => t.fdi !== fdi);
  }

  /** Back to the library shape and its place on the arch. */
  reset(fdi: number) {
    const t = this.tooth(fdi);
    const pl = t && this.placement[t.jaw];
    if (!t || !pl || !this.lib) return;
    const tpl = this.template(fdi);
    const sh = this.libraryShape(tpl);
    t.pos = sh.pos;
    t.idx = tpl.idx;
    t.geo = sh.geo;
    t.T = archPose(this.lib, pl, fdi);
  }

  /** Current tips of a tooth's parts (library coordinates): the vertices nearest the template's tips. */
  partTips(t: WaxTooth): Vec3[] {
    const tpl = this.template(t.fdi);
    // mirrored from the other side (1-to-1): its own vertices nearest the template's tips
    const vi = t.idx === tpl.idx ? partVertices(tpl) : partVerticesOf(t, tpl);
    return vi.map((i) => [t.pos[i * 3], t.pos[i * 3 + 1], t.pos[i * 3 + 2]] as Vec3);
  }

  /** Centre of a tooth (world): its library centroid. */
  center(t: WaxTooth): Vec3 {
    return applyV(t.T, this.template(t.fdi).centroid);
  }

  /** Uniform scale of a tooth (1 = library size). */
  static scaleOf(t: WaxTooth): number {
    return Math.cbrt(Math.abs(det3(t.T)));
  }

  /** Apply a world transform to a tooth (and, in mirror mode, its reflection to the other side). */
  transformTooth(t: WaxTooth, D: Affine, mirror = false) {
    t.T = compose(D, t.T);
    if (!mirror) return;
    const other = this.tooth(contralateral(t.fdi));
    const pl = this.placement[t.jaw];
    if (!other || !pl) return;
    const { p, n } = mirrorPlane(pl);
    const M = reflection(p, n);
    other.T = compose(compose(M, compose(D, M)), other.T);
  }

  /** Apply a world transform to every tooth of a jaw (new teeth of the jaw follow too). */
  transformJaw(jaw: Jaw, D: Affine) {
    for (const t of this.teeth) if (t.jaw === jaw) t.T = compose(D, t.T);
    const pl = this.placement[jaw];
    if (pl) pl.adjust = compose(D, pl.adjust);
  }

  /** Centre of a jaw's teeth (world). */
  jawCenter(jaw: Jaw): Vec3 | null {
    const ts = this.teeth.filter((t) => t.jaw === jaw);
    if (!ts.length) return null;
    const c: Vec3 = [0, 0, 0];
    for (const t of ts) {
      const p = this.center(t);
      c[0] += p[0] / ts.length;
      c[1] += p[1] / ts.length;
      c[2] += p[2] / ts.length;
    }
    return c;
  }
}

const partVertexCache = new WeakMap<ToothTemplate, number[]>();
/** Vertex index at each part tip of a template (topology never changes, so the index stays valid). */
export function partVertices(tpl: ToothTemplate): number[] {
  let v = partVertexCache.get(tpl);
  if (!v) {
    v = tpl.parts.map((tip) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < tpl.pos.length; i += 3) {
        const d = (tpl.pos[i] - tip[0]) ** 2 + (tpl.pos[i + 1] - tip[1]) ** 2 + (tpl.pos[i + 2] - tip[2]) ** 2;
        if (d < bd) [bd, best] = [d, i / 3];
      }
      return best;
    });
    partVertexCache.set(tpl, v);
  }
  return v;
}

const ownPartCache = new WeakMap<Uint32Array, number[]>();
/** Part vertices of a tooth whose mesh is not the template's (mirrored from the other side). */
function partVerticesOf(t: WaxTooth, tpl: ToothTemplate): number[] {
  let v = ownPartCache.get(t.idx);
  if (!v) {
    v = tpl.parts.map((tip) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < t.pos.length; i += 3) {
        const d = (t.pos[i] - tip[0]) ** 2 + (t.pos[i + 1] - tip[1]) ** 2 + (t.pos[i + 2] - tip[2]) ** 2;
        if (d < bd) [bd, best] = [d, i / 3];
      }
      return best;
    });
    ownPartCache.set(t.idx, v);
  }
  return v;
}

export function det3(m: Affine): number {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
}

/** Transform turning by `angle` (radians) about the axis through `c`, then scaling by `s` about c. */
export function rotateScaleAbout(c: Vec3, axis: Vec3, angle: number, s = 1): Affine {
  const [x, y, z] = normalize(axis);
  const co = Math.cos(angle), si = Math.sin(angle), C = 1 - co;
  const R = [co + x * x * C, x * y * C - z * si, x * z * C + y * si, y * x * C + z * si, co + y * y * C, y * z * C - x * si, z * x * C - y * si, z * y * C + x * si, co + z * z * C].map((v) => v * s);
  const t: Vec3 = [c[0] - (R[0] * c[0] + R[1] * c[1] + R[2] * c[2]), c[1] - (R[3] * c[0] + R[4] * c[1] + R[5] * c[2]), c[2] - (R[6] * c[0] + R[7] * c[1] + R[8] * c[2])];
  return [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2]];
}

export const translation = (d: Vec3): Affine => [1, 0, 0, d[0], 0, 1, 0, d[1], 0, 0, 1, d[2]];

// ---- world geometry (cached) -------------------------------------------------------------

interface WorldMesh {
  key: string;
  pos: Float32Array;
  nrm: Float32Array;
  min: Vec3;
  max: Vec3;
}
const worldCache = new WeakMap<WaxTooth, WorldMesh>();

export const toothKey = (t: WaxTooth) => `${t.geo}.${t.ver ?? 0}|${t.T.join(',')}`;

/** Vertices and normals of a tooth in world coordinates, with its bounding box. */
export function toothWorld(t: WaxTooth): WorldMesh {
  const key = toothKey(t);
  const c = worldCache.get(t);
  if (c && c.key === key && c.pos.length === t.pos.length) return c;
  const src = t.pos;
  const T = t.T;
  const pos = new Float32Array(src.length);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    const wx = T[0] * x + T[1] * y + T[2] * z + T[3];
    const wy = T[4] * x + T[5] * y + T[6] * z + T[7];
    const wz = T[8] * x + T[9] * y + T[10] * z + T[11];
    pos[i] = wx;
    pos[i + 1] = wy;
    pos[i + 2] = wz;
    if (wx < min[0]) min[0] = wx;
    if (wy < min[1]) min[1] = wy;
    if (wz < min[2]) min[2] = wz;
    if (wx > max[0]) max[0] = wx;
    if (wy > max[1]) max[1] = wy;
    if (wz > max[2]) max[2] = wz;
  }
  const out = { key, pos, nrm: vertexNormals(pos, t.idx), min, max };
  worldCache.set(t, out);
  return out;
}

// ---- library <-> world -------------------------------------------------------------------

/** World vector -> library vector of a tooth (inverse of its linear part). */
export function toLibDir(t: WaxTooth, d: Vec3): Vec3 {
  const inv = invert(t.T);
  return [inv[0] * d[0] + inv[1] * d[1] + inv[2] * d[2], inv[4] * d[0] + inv[5] * d[1] + inv[6] * d[2], inv[8] * d[0] + inv[9] * d[1] + inv[10] * d[2]];
}
export function toLibPoint(t: WaxTooth, p: Vec3): Vec3 {
  return applyV(invert(t.T), p);
}

/** Copy-on-write: give the tooth its own vertex array before sculpting it. */
export function beginGeometryEdit(t: WaxTooth): Float32Array {
  t.pos = new Float32Array(t.pos);
  t.geo = newGeo();
  return t.pos;
}

