// Implant geometry, nerve safety distance, panoramic curve.
import { describe, expect, it } from 'vitest';
import { apexOf, createImplant, isTapered, platformOf, setApicalDiameter, setCoronalDiameter, setImplantAxis, setImplantLength } from '../../src/implant';
import { createNerve, implantNerveDistance, insertNervePoint, nerveLength } from '../../src/nerve';
import { ArchCurve } from '../../src/curve';
import { normalize, type Vec3 } from '../../src/math';
import { dist } from './helpers';

describe('implant', () => {
  it('keeps the platform when the length or the axis changes', () => {
    const imp = createImplant([10, 10, 10], [0, 0, -1], 4, 10);
    expect(platformOf(imp)).toEqual([10, 10, 15]);
    expect(apexOf(imp)).toEqual([10, 10, 5]);
    setImplantLength(imp, 13);
    expect(platformOf(imp)).toEqual([10, 10, 15]);
    expect(dist(platformOf(imp), apexOf(imp))).toBeCloseTo(13, 9);
    setImplantAxis(imp, normalize([0.3, 0, -1]));
    expect(dist(platformOf(imp), [10, 10, 15])).toBeLessThan(1e-9);
  });

  it('keeps a tapered apex between 1.5 mm and the platform diameter', () => {
    const imp = createImplant([0, 0, 0], [0, 0, 1], 4, 10);
    setApicalDiameter(imp, 3);
    expect(isTapered(imp)).toBe(true);
    setApicalDiameter(imp, 9);
    expect(imp.apicalDiameter).toBe(4);
    setApicalDiameter(imp, 0.2);
    expect(imp.apicalDiameter).toBe(1.5);
    setApicalDiameter(imp, 3.5);
    setCoronalDiameter(imp, 3);
    expect(imp.apicalDiameter).toBe(3);
  });
});

describe('nerve', () => {
  it('measures the surface-to-surface distance to an implant', () => {
    // straight canal along x, 2.5 mm wide, 6 mm below the apex of a vertical Ø4 implant
    const n = createNerve('right');
    n.pts = [[-20, 0, -6], [0, 0, -6], [20, 0, -6]];
    const imp = createImplant([0, 0, 5], [0, 0, -1], 4, 10); // apex at z = 0
    expect(implantNerveDistance(imp, n)).toBeCloseTo(6 - n.diameter / 2, 1);
    // beside the canal: radius counts
    const side = createImplant([0, 8, -6], [0, 0, -1], 4, 10);
    expect(implantNerveDistance(side, n)).toBeCloseTo(8 - 2 - n.diameter / 2, 1);
    expect(nerveLength(n)).toBeCloseTo(40, 0);
  });

  it('measures past the apex corner, along a tapered side, and reports overlap', () => {
    const n = createNerve('left');
    n.diameter = 2;
    // canal parallel to y, 3 mm beyond the apex face and 3 mm outside the apex edge
    const imp = createImplant([0, 0, 5], [0, 0, -1], 4, 10); // apex face z = 0, radius 2
    n.pts = [[5, -20, -3], [5, 0, -3], [5, 20, -3]];
    expect(implantNerveDistance(imp, n)).toBeCloseTo(Math.hypot(3, 3) - 1, 1);
    // tapered Ø4 → Ø2: beside the apex the radius is 1
    setApicalDiameter(imp, 2);
    n.pts = [[4, -20, 0.5], [4, 0, 0.5], [4, 20, 0.5]];
    expect(implantNerveDistance(imp, n)).toBeCloseTo(4 - 1.05 - 1, 1);
    // through the implant
    n.pts = [[0, -20, 3], [0, 0, 3], [0, 20, 3]];
    expect(implantNerveDistance(imp, n)).toBeLessThan(0);
  });

  it('puts points clicked in any order where they belong', () => {
    const pts: Vec3[] = [];
    for (const x of [0, 30, 10, 20, -5]) insertNervePoint(pts, [x, 0, 0]);
    expect(pts.map((p) => p[0])).toEqual([-5, 0, 10, 20, 30]);
  });
});

describe('panoramic curve', () => {
  it('has the length of its points and finds the nearest position', () => {
    const c = new ArchCurve([[-20, 0], [0, 0], [20, 0]]);
    expect(c.length).toBeCloseTo(40, 1);
    const nr = c.nearest(5, 3);
    expect(nr.s).toBeCloseTo(25, 0);
    expect(nr.dist).toBeCloseTo(3, 1);
  });
});
