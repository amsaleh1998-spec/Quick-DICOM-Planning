// Waxup occlusion: cutting the teeth with the antagonist's surface, and abrasion of the relief.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLibrary, unpackLibrary } from '../../src/waxup/library';
import { JawPlacement, Waxup, toothWorld } from '../../src/waxup/waxup';
import { HeightField, abrade, cutTooth, jawFrame, reliefScale } from '../../src/waxup/occlusion';
import { IDENTITY } from '../../src/register';
import type { Frame, Vec2 } from '../../src/math';

const lib = parseLibrary(await unpackLibrary(JSON.parse(readFileSync('public/library/teeth-generic.json', 'utf8'))));
const curve: Vec2[] = [];
for (let a = -34; a <= 34; a += 4) curve.push([a, 0.045 * a * a]);
const F: Frame = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const pl = (): JawPlacement => ({ O: [0, 0, 0], F, ctrl: curve, sMid: 37, level: 40, buccal: 0, scale: 1, adjust: [...IDENTITY] });

function waxup() {
  const w = new Waxup();
  w.lib = lib;
  w.placement.upper = pl();
  w.placement.lower = pl();
  return w;
}

/** a flat square (two triangles) at height z, around (0, 0) */
function plane(z: number, half = 100) {
  const pos = new Float32Array([-half, -half, z, half, -half, z, half, half, z, -half, half, z]);
  return { pos, idx: new Uint32Array([0, 1, 2, 0, 2, 3]) };
}

const zs = (p: Float32Array) => Array.from(p).filter((_, i) => i % 3 === 2);

describe('antagonist cutting', () => {
  it('pushes an upper tooth back onto a lower antagonist, the rest of the tooth untouched', () => {
    const w = waxup();
    const t = w.add(16);
    const f = jawFrame(w.placement.upper!);
    expect(f.level).toBeCloseTo(40, 6);
    const before = zs(toothWorld(t).pos);
    const lowest = Math.min(...before);
    expect(lowest).toBeLessThan(40.6);
    const hf = new HeightField(f, true, -100, -100, 100, 100, 20, 60);
    const ant = plane(40.6);
    hf.add(ant.pos, ant.idx);
    expect(hf.at(0, 0)).toBeCloseTo(40.6, 4);
    expect(hf.at(300, 0)).toBeNaN();
    const cut = cutTooth(hf, t.T, t.pos, 0)!;
    expect(cut).not.toBeNull();
    t.pos = cut;
    t.ver = 1;
    const after = zs(toothWorld(t).pos);
    expect(Math.min(...after)).toBeGreaterThan(40.6 - 1e-3);
    // vertices that did not reach the antagonist keep their place
    after.forEach((z, i) => {
      if (before[i] > 40.6) expect(z).toBeCloseTo(before[i], 4);
    });
    // a gap is kept on request
    const hf2 = new HeightField(f, true, -100, -100, 100, 100, 20, 60);
    hf2.add(ant.pos, ant.idx);
    const t2 = w.add(26);
    t2.pos = cutTooth(hf2, t2.T, t2.pos, 0.2) ?? t2.pos;
    t2.ver = 1;
    expect(Math.min(...zs(toothWorld(t2).pos))).toBeGreaterThan(40.8 - 1e-3);
  });

  it('cuts a lower tooth against the underside of an upper antagonist, and leaves a tooth clear of it alone', () => {
    const w = waxup();
    const t = w.add(36);
    const f = jawFrame(w.placement.lower!);
    const hf = new HeightField(f, false, -100, -100, 100, 100, 20, 60);
    const ant = plane(39.4);
    hf.add(ant.pos, ant.idx);
    t.pos = cutTooth(hf, t.T, t.pos, 0)!;
    t.ver = 1;
    expect(Math.max(...zs(toothWorld(t).pos))).toBeLessThan(39.4 + 1e-3);
    const far = new HeightField(f, false, -100, -100, 100, 100, 20, 60);
    const high = plane(45);
    far.add(high.pos, high.idx);
    expect(cutTooth(far, w.tooth(36)!.T, lib.teeth.get(36)!.pos, 0)).toBeNull();
  });
});

describe('abrasion', () => {
  const top = (p: Float32Array, s: number) => Math.max(...zs(p).map((z) => s * z));
  it('wears the cusps flat or makes them pointed; the cervical part stays', () => {
    const tpl = lib.teeth.get(36)!; // lower: occlusal = +z
    const flat = abrade(tpl.pos, 'lower', reliefScale(1), 2.2);
    const pointed = abrade(tpl.pos, 'lower', reliefScale(-1), 2.2);
    const t0 = top(tpl.pos, 1);
    expect(top(flat, 1)).toBeLessThan(t0 - 1.2);
    expect(top(pointed, 1)).toBeGreaterThan(t0 + 0.9);
    // more than 2.6 mm below the cusp tips nothing moves
    for (let i = 2; i < tpl.pos.length; i += 3) if (tpl.pos[i] < t0 - 2.6) expect(flat[i]).toBe(tpl.pos[i]);
    // upper teeth: occlusal = -z
    const up = lib.teeth.get(16)!;
    expect(top(abrade(up.pos, 'upper', reliefScale(1), 2.2), -1)).toBeLessThan(top(up.pos, -1) - 1.2);
    // in steps from the slider's start equals in one go
    const half = abrade(tpl.pos, 'lower', reliefScale(0.5), 2.2);
    const k0 = reliefScale(0.5);
    const again = abrade(half, 'lower', reliefScale(1) / k0, 2.2 * k0);
    expect(top(again, 1)).toBeCloseTo(top(flat, 1), 1);
  });

  it('applies to teeth added later and to a reset tooth', () => {
    const w = waxup();
    w.abrasion.posterior = 1;
    const t = w.add(36);
    expect(t.geo).toBeGreaterThan(0);
    expect(top(t.pos, 1)).toBeLessThan(top(lib.teeth.get(36)!.pos, 1) - 1);
    const front = w.add(31);
    expect(front.geo).toBe(0);
    w.abrasion.posterior = 0;
    w.reset(36);
    expect(w.tooth(36)!.pos).toBe(lib.teeth.get(36)!.pos);
  });
});
