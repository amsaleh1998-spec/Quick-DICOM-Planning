// Waxup: the tooth library, placement on the patient's arch, chain mode, mirroring, sculpting.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contralateral, jawOrder, parseLibrary, unpackLibrary } from '../../src/waxup/library';
import { JawPlacement, Waxup, mirrorPlane, reflection, rotateScaleAbout, toothWorld, translation } from '../../src/waxup/waxup';
import { applyChain, chainOf, chainsOf, contacts, discPin, flipped, mirroredVertices, settleChain, snapshot, toothAxes, toothPin } from '../../src/waxup/chain';
import { applyPart, brush, startPart } from '../../src/waxup/sculpt';
import { IDENTITY, applyV, compose } from '../../src/register';
import type { Frame, Vec2, Vec3 } from '../../src/math';

const lib = parseLibrary(await unpackLibrary(JSON.parse(readFileSync('public/library/teeth-generic.json', 'utf8'))));

/** a U-shaped patient curve (planning a = left, b = posterior): front at b = 0 */
const curve: Vec2[] = [];
for (let a = -34; a <= 34; a += 4) curve.push([a, 0.045 * a * a]);
const F: Frame = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const placement = (level: number, buccal = 0): JawPlacement => ({ O: [0, 0, 0], F, ctrl: curve, sMid: 0, level, buccal, scale: 1, adjust: [...IDENTITY] });

function waxup() {
  const w = new Waxup();
  w.lib = lib;
  const mid = (() => {
    // arc length of the front of the curve
    let L = 0;
    for (let i = 1; i < curve.length; i++) {
      if (curve[i][0] > 0) return L + Math.hypot(0 - curve[i - 1][0], 0 - curve[i - 1][1]);
      L += Math.hypot(curve[i][0] - curve[i - 1][0], curve[i][1] - curve[i - 1][1]);
    }
    return L;
  })();
  w.placement.lower = { ...placement(40), sMid: mid };
  w.placement.upper = { ...placement(40, 1.5), sMid: mid };
  return w;
}

describe('tooth library', () => {
  it('has 32 closed crowns with FDI numbers and parts', () => {
    expect(lib.teeth.size).toBe(32);
    for (const fdi of [...jawOrder('upper'), ...jawOrder('lower')]) {
      const t = lib.teeth.get(fdi)!;
      expect(t.idx.length % 3).toBe(0);
      expect(t.parts.length).toBe(fdi % 10 <= 3 ? 1 : fdi % 10 <= 5 ? 2 : 4);
      // closed: every edge used twice
      const e = new Map<string, number>();
      for (let i = 0; i < t.idx.length; i += 3)
        for (let k = 0; k < 3; k++) {
          const a = t.idx[i + k], b = t.idx[i + ((k + 1) % 3)];
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          e.set(key, (e.get(key) ?? 0) + 1);
        }
      expect([...e.values()].every((n) => n === 2)).toBe(true);
    }
  });

  it('is laid out like the mouth: right teeth on the right, upper crowns above the occlusal plane', () => {
    expect(lib.teeth.get(16)!.centroid[0]).toBeLessThan(-15); // patient right = -x
    expect(lib.teeth.get(26)!.centroid[0]).toBeGreaterThan(15);
    expect(lib.teeth.get(46)!.centroid[0]).toBeLessThan(-15);
    for (const t of lib.teeth.values()) {
      if (t.jaw === 'upper') expect(t.centroid[2]).toBeGreaterThan(1);
      else expect(t.centroid[2]).toBeLessThan(-1);
    }
    // incisors in front, molars behind
    expect(lib.teeth.get(11)!.centroid[1]).toBeLessThan(lib.teeth.get(16)!.centroid[1] - 20);
    // mirror pairs
    expect(lib.teeth.get(14)!.centroid[0]).toBeCloseTo(-lib.teeth.get(24)!.centroid[0], 0);
    expect(contralateral(36)).toBe(46);
  });
});

describe('placement on the arch', () => {
  it('sets every tooth up along the curve, in order, without overlapping its neighbours much', () => {
    const w = waxup();
    for (const f of [...jawOrder('upper'), ...jawOrder('lower')]) w.add(f);
    for (const jaw of ['upper', 'lower'] as const) {
      const ts = w.jawTeeth(jaw);
      const xs = ts.map((t) => w.center(t)[0]);
      // patient right -> left = increasing a (x)
      for (let i = 1; i < 8; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1] - 0.5);
      for (let i = 9; i < 16; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1] - 0.5);
      // near the curve (within the arch width)
      for (const t of ts) {
        const c = w.center(t);
        const nearest = Math.min(...curve.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
        expect(nearest).toBeLessThan(6);
      }
      // neighbours: overlap along the arch below 1.5 mm
      for (let i = 0; i + 1 < ts.length; i++) {
        const md = toothAxes(w, ts[i]).md;
        const gap = (a: Vec3, b: Vec3) => (b[0] - a[0]) * md[0] + (b[1] - a[1]) * md[1] + (b[2] - a[2]) * md[2];
        expect(gap(contacts(w, ts[i]).b, contacts(w, ts[i + 1]).a)).toBeGreaterThan(-1.5);
      }
    }
    // occlusal plane at 40: upper crowns above, lower below
    for (const t of w.teeth) {
      const z = w.center(t)[2];
      if (t.jaw === 'upper') expect(z).toBeGreaterThan(40);
      else expect(z).toBeLessThan(40);
    }
    // the first molars sit at the back, the incisors at the front
    expect(w.center(w.tooth(46)!)[1]).toBeGreaterThan(w.center(w.tooth(41)!)[1] + 15);
  });

  it('keeps library size and shape', () => {
    const w = waxup();
    const t = w.add(36);
    expect(Waxup.scaleOf(t)).toBeCloseTo(1, 6);
    const wm = toothWorld(t);
    const tpl = lib.teeth.get(36)!;
    // a rigid placement: distances between vertices are unchanged
    const d0 = Math.hypot(tpl.pos[0] - tpl.pos[30], tpl.pos[1] - tpl.pos[31], tpl.pos[2] - tpl.pos[32]);
    const d1 = Math.hypot(wm.pos[0] - wm.pos[30], wm.pos[1] - wm.pos[31], wm.pos[2] - wm.pos[32]);
    expect(d1).toBeCloseTo(d0, 4);
  });
});

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** largest distance between the touching contacts of neighbours */
const worstContact = (w: Waxup, ts: ReturnType<Waxup['jawTeeth']>) =>
  Math.max(...ts.slice(1).map((t, i) => dist(contacts(w, ts[i]).b, contacts(w, t).a)));
/** a lower arch set up in contact */
function lowerArch() {
  const w = waxup();
  for (const f of jawOrder('lower')) w.add(f);
  for (const c of chainsOf(w, 'lower')) settleChain(w, c, new Set(), true);
  return w;
}

describe('chain mode', () => {
  it('knows the axes and contacts of a tooth', () => {
    const w = waxup();
    for (const f of [35, 36, 37]) w.add(f);
    const t = w.tooth(36)!;
    const ax = toothAxes(w, t);
    expect(ax.oc[2]).toBeGreaterThan(0.95); // lower tooth: occlusal = up
    const c = contacts(w, t);
    // a = towards the previous tooth in arch order (35), b = towards the next (37)
    expect(dist(c.a, w.center(w.tooth(35)!))).toBeLessThan(dist(c.b, w.center(w.tooth(35)!)));
    expect(dist(c.a, c.b)).toBeGreaterThan(8);
    expect(chainOf(w, t).map((x) => x.fdi)).toEqual([35, 36, 37]);
  });

  it('sets the arch up in contact, the midline staying', () => {
    const w = waxup();
    for (const f of jawOrder('lower')) w.add(f);
    const mid0 = contacts(w, w.tooth(41)!).b;
    for (const c of chainsOf(w, 'lower')) settleChain(w, c, new Set(), true);
    const ts = w.jawTeeth('lower');
    expect(worstContact(w, ts)).toBeLessThan(0.1);
    expect(dist(contacts(w, w.tooth(41)!).b, mid0)).toBeLessThan(1);
    for (const t of ts) expect(Waxup.scaleOf(t)).toBeCloseTo(1, 3);
  });

  it('chain: moves the whole chain, or bends it towards a pinned tooth', () => {
    let w = lowerArch();
    let ts = w.jawTeeth('lower');
    let c0 = ts.map((t) => w.center(t));
    applyChain(snapshot(w, ts), { tooth: ts.indexOf(w.tooth(36)!) }, { kind: 'move', d: [0, 0, 2] }, { mode: 'chain', scalable: true, contact: true });
    ts.forEach((t, i) => expect(w.center(t)[2] - c0[i][2]).toBeCloseTo(2, 3));

    w = lowerArch();
    ts = w.jawTeeth('lower');
    c0 = ts.map((t) => w.center(t));
    const pinned = w.tooth(33)!;
    const T33 = pinned.T.slice();
    applyChain(snapshot(w, ts, new Set([toothPin(33)])), { tooth: ts.indexOf(w.tooth(36)!) }, { kind: 'move', d: [2, 0, 0] }, { mode: 'chain', scalable: true, contact: true });
    expect(pinned.T).toEqual(T33);
    const moved = (fdi: number) => dist(w.center(w.tooth(fdi)!), c0[ts.indexOf(w.tooth(fdi)!)]);
    expect(moved(36)).toBeCloseTo(2, 3);
    expect(moved(37)).toBeCloseTo(2, 1);
    expect(moved(34)).toBeGreaterThan(0.05);
    expect(moved(34)).toBeLessThan(moved(35));
    expect(moved(42)).toBeLessThan(1e-6); // beyond the pin
    expect(worstContact(w, ts)).toBeLessThan(0.05);
  });

  it('single: a grown tooth pushes its neighbours along the tube; against a pin they are squeezed', () => {
    let w = lowerArch();
    let ts = w.jawTeeth('lower');
    const t44 = w.tooth(44)!;
    const y45 = w.center(w.tooth(45)!)[1];
    applyChain(snapshot(w, ts), { tooth: ts.indexOf(t44) }, { kind: 'set', T: compose(rotateScaleAbout(w.center(t44), [0, 0, 1], 0, 1.2), t44.T) }, { mode: 'single', scalable: true, contact: true });
    expect(worstContact(w, ts)).toBeLessThan(0.1);
    expect(w.center(w.tooth(45)!)[1]).toBeGreaterThan(y45 + 0.3); // pushed distally
    expect(Waxup.scaleOf(w.tooth(45)!)).toBeCloseTo(1, 2);

    w = lowerArch();
    ts = w.jawTeeth('lower');
    const a44 = w.tooth(44)!;
    const T46 = w.tooth(46)!.T.slice();
    applyChain(snapshot(w, ts, new Set([toothPin(46)])), { tooth: ts.indexOf(a44) }, { kind: 'set', T: compose(rotateScaleAbout(w.center(a44), [0, 0, 1], 0, 1.2), a44.T) }, { mode: 'single', scalable: true, contact: true });
    expect(w.tooth(46)!.T).toEqual(T46);
    expect(Waxup.scaleOf(w.tooth(45)!)).toBeLessThan(0.97);
  });

  it('tube: the teeth slide along the arch', () => {
    const w = lowerArch();
    const ts = w.jawTeeth('lower');
    const snap = snapshot(w, ts);
    const c0 = ts.map((t) => w.center(t));
    applyChain(snap, { tooth: ts.indexOf(w.tooth(31)!) }, { kind: 'slide', ds: 3 }, { mode: 'tube', scalable: true, contact: true });
    ts.forEach((t, i) => expect(dist(w.center(t), c0[i])).toBeGreaterThan(2));
    // still on the tube, still in contact
    for (const t of ts) {
      const c = contacts(w, t);
      expect(dist(c.a, snap.tube.at(snap.tube.closest(c.a)))).toBeLessThan(0.3);
    }
    expect(worstContact(w, ts)).toBeLessThan(0.1);
  });

  it('a disc moves its end of the chain; the teeth are stretched up to the other end', () => {
    const w = waxup();
    for (const f of [34, 35, 36]) w.add(f);
    const ts = w.jawTeeth('lower');
    settleChain(w, ts, new Set(), true);
    const snap = snapshot(w, ts);
    const aEnd = contacts(w, ts[0]).a;
    const t = snap.tube.tangent(snap.S[3]);
    applyChain(snap, { disc: 'b' }, { kind: 'move', d: [t[0] * 2, t[1] * 2, t[2] * 2] }, { mode: 'chain', scalable: true, contact: true });
    expect(dist(contacts(w, ts[0]).a, aEnd)).toBeLessThan(0.01);
    for (const x of ts) expect(Waxup.scaleOf(x)).toBeGreaterThan(1.03);
    expect(worstContact(w, ts)).toBeLessThan(0.05);
    expect(discPin(ts, 'a')).toBe('a34');
  });
});

describe('mirroring', () => {
  it('mirrors a change to the other side', () => {
    const w = waxup();
    w.add(13);
    w.add(23);
    const a = w.tooth(13)!, b = w.tooth(23)!;
    const cb = w.center(b);
    // move 13 to the patient's right (-x) by 1 mm: 23 moves to the left (+x)
    w.transformTooth(a, translation([-1, 0, 0]), true);
    const cb2 = w.center(b);
    expect(cb2[0] - cb[0]).toBeCloseTo(1, 2);
    expect(Math.abs(cb2[1] - cb[1])).toBeLessThan(0.15);
  });

  it('1-to-1: the tooth on the other side becomes the exact mirror image', () => {
    const w = waxup();
    const a = w.add(13), b = w.add(23);
    w.transformTooth(a, rotateScaleAbout(w.center(a), [0, 1, 0], 0.2, 1.1));
    const M = (() => {
      const { p, n } = mirrorPlane(w.placement.upper!);
      return reflection(p, n);
    })();
    b.T = compose(compose(M, a.T), [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    b.pos = mirroredVertices(a, b, M);
    b.idx = flipped(a.idx);
    const wa = toothWorld(a).pos, wb = toothWorld(b).pos;
    for (let i = 0; i < wa.length; i += 99) {
      const m = applyV(M, [wa[i], wa[i + 1], wa[i + 2]]);
      expect(dist(m, [wb[i], wb[i + 1], wb[i + 2]])).toBeLessThan(1e-3);
    }
    // its own place: near where its library tooth would be
    expect(dist(w.center(b), w.center(waxup().add(23)))).toBeLessThan(2.5);
    expect(flipped(flipped(a.idx))).toBe(a.idx);
  });

  it('moves the whole jaw, and teeth added later follow', () => {
    const w = waxup();
    w.add(36);
    w.transformJaw('lower', translation([0, 0, 2]));
    const t = w.add(46);
    const ref = waxup().add(46);
    expect(w.center(t)[2] - waxup().center(ref)[2]).toBeCloseTo(2, 6);
  });
});

describe('sculpting', () => {
  it('adds and removes material along the normals, and moves a cusp with a falloff', () => {
    const tpl = lib.teeth.get(36)!;
    const pos = new Float32Array(tpl.pos);
    const tip = tpl.parts[0];
    const before = pos.slice();
    expect(brush(pos, tpl.idx, tip, 1.5, 0.2, 'add')).toBeGreaterThan(5);
    // material added: the vertex nearest the tip moved outwards (up, for a lower tooth)
    let k = 0, best = Infinity;
    for (let i = 0; i < pos.length / 3; i++) {
      const d = Math.hypot(before[i * 3] - tip[0], before[i * 3 + 1] - tip[1], before[i * 3 + 2] - tip[2]);
      if (d < best) [best, k] = [d, i];
    }
    expect(pos[k * 3 + 2]).toBeGreaterThan(before[k * 3 + 2] + 0.1);
    brush(pos, tpl.idx, tip, 1.5, 0.2, 'remove');
    expect(pos[k * 3 + 2]).toBeCloseTo(before[k * 3 + 2], 1);
    // part: the tip region rises 1 mm, the far side of the tooth stays
    const pd = startPart(pos, tip, tpl.partRadius);
    applyPart(pos, pd, [0, 0, 1], 1, [0, 0, 1], 0);
    expect(pos[k * 3 + 2]).toBeGreaterThan(before[k * 3 + 2] + 0.8);
    const far = tpl.parts[3];
    let kf = 0;
    best = Infinity;
    for (let i = 0; i < pos.length / 3; i++) {
      const d = Math.hypot(before[i * 3] - far[0], before[i * 3 + 1] - far[1], before[i * 3 + 2] - far[2]);
      if (d < best) [best, kf] = [d, i];
    }
    expect(pos[kf * 3 + 2]).toBeLessThan(before[kf * 3 + 2] + 0.3);
    expect(applyV(IDENTITY, [1, 2, 3])).toEqual([1, 2, 3]);
  });
});
