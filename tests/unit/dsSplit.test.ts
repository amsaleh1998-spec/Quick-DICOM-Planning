// Segmenting one jaw: where the scan is split between the maxilla and the mandible.
import { describe, expect, it } from 'vitest';
import { occlusalSplit } from '../../src/ai/dsPlan';
import type { Vec3 } from '../../src/math';

/** a synthetic scan along z (superior = +z): mandible below, maxilla above, crowns between */
function scan(teeth: boolean) {
  const dims: [number, number, number] = [40, 40, 100];
  const sp: Vec3 = [0.5, 0.5, 0.5];
  const data = new Int16Array(dims[0] * dims[1] * dims[2]);
  for (let k = 0; k < dims[2]; k++)
    for (let j = 8; j < 32; j++)
      for (let i = 8; i < 32; i++) {
        let v = 0;
        if (k >= 10 && k < 38) v = 700; // mandible
        if (k >= 62 && k < 90) v = 700; // maxilla
        // crowns: lower 38..50, upper 50..62 (an enamel shell of the crowns: their outer voxels)
        if (teeth && k >= 38 && k < 62 && (i % 4 === 0 || j % 4 === 0)) v = 2600;
        data[i + j * dims[0] + k * dims[0] * dims[1]] = v;
      }
  return { data, dims, sp, hi: [(dims[0] - 1) * 0.5, (dims[1] - 1) * 0.5, (dims[2] - 1) * 0.5] as Vec3 };
}

describe('occlusal split', () => {
  it('finds where the crowns meet', () => {
    const s = scan(true);
    const z = occlusalSplit(s.data, s.dims, s.sp, [0, 0, 0], s.hi, 2, 400);
    expect(z).toBeGreaterThan(22);
    expect(z).toBeLessThan(28); // the crowns meet at k = 50, z = 25 mm
  });
  it('without teeth: the gap between the ridges', () => {
    const s = scan(false);
    const z = occlusalSplit(s.data, s.dims, s.sp, [0, 0, 0], s.hi, 2, 400);
    expect(z).toBeGreaterThan(19);
    expect(z).toBeLessThan(31); // the gap runs from z = 19 to 31 mm
  });
});
