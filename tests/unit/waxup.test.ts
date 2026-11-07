// Waxup: the tooth library, placement on the patient's arch, chain mode, mirroring, sculpting.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { contralateral, jawOrder, parseLibrary } from '../../src/waxup/library';
import { JawPlacement, Waxup, chainLinks, gapAlong, repackChain, rotateScaleAbout, toothWorld, translation } from '../../src/waxup/waxup';
import { applyPart, brush, startPart } from '../../src/waxup/sculpt';
import { IDENTITY, applyV } from '../../src/register';
import type { Frame, Vec2, Vec3 } from '../../src/math';

const raw = inflateSync(readFileSync('public/library/teeth-generic.bin'));
const lib = parseLibrary(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);

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
      for (const l of chainLinks(w, jaw, [0, 0, 1])) expect(l.gap).toBeGreaterThan(-1.5);
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

describe('chain mode and mirror', () => {
  it('keeps every contact when one tooth grows or moves', () => {
    const w = waxup();
    for (const f of jawOrder('lower')) w.add(f);
    const up: Vec3 = [0, 0, 1];
    const links = chainLinks(w, 'lower', up);
    const before = links.map((l) => l.gap);
    const t = w.tooth(44)!;
    // scale 44 by 20 % and move it 1 mm buccally
    w.transformTooth(t, rotateScaleAbout(w.center(t), up, 0, 1.2));
    w.transformTooth(t, translation([-1, 0, 0]));
    repackChain(links, t);
    // the gaps along the links (as they were when the drag started) are unchanged
    const after = links.map((l) => gapAlong(l.a, l.b, l.u));
    for (let i = 0; i < before.length; i++) expect(after[i]).toBeCloseTo(before[i], 3);
    // 45 was pushed distally
    expect(w.center(w.tooth(45)!)[1]).toBeGreaterThan(w.center(w.tooth(44)!)[1]);
  });

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
