// Desktop AI service: the scan goes to nnU-Net in SimpleITK axis order (index 0 = superior,
// 1 = posterior, 2 = patient left, as SimpleITK reads an LPS scan), and the labels come back to the
// app's grid.
import { describe, expect, it } from 'vitest';
import { fromItk, itkLayout, regionToLabels, toItk } from '../../src/ai/desktopAi';
import type { Vec3 } from '../../src/math';

const dims: [number, number, number] = [5, 4, 3];
const spacing: Vec3 = [0.3, 0.4, 0.5];
const ramp = () => Int16Array.from({ length: dims[0] * dims[1] * dims[2] }, (_, i) => i);

/** affines (world -> LPS) for every axis permutation and direction */
function affines(): number[][] {
  const out: number[][] = [];
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const p of perms)
    for (let s = 0; s < 8; s++) {
      const R = new Array(9).fill(0);
      for (let a = 0; a < 3; a++) R[p[a] * 3 + a] = s & (1 << a) ? -1 : 1; // world axis a -> LPS axis p[a]
      out.push([R[0], R[1], R[2], 10, R[3], R[4], R[5], -5, R[6], R[7], R[8], 3]);
    }
  return out;
}

describe('desktop AI service: axes', () => {
  it('a plain LPS volume goes as (z, y, x): x fastest, no flips', () => {
    const L = itkLayout(dims, spacing, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(L.itkDims).toEqual([3, 4, 5]);
    expect(L.itkSpacing).toEqual([0.5, 0.4, 0.3]);
    expect(Array.from(toItk(ramp(), dims, L))).toEqual(Array.from(ramp()));
  });

  it('for every orientation: back and forth is the same, and the array axes point S, P, L', () => {
    for (const A of affines()) {
      const L = itkLayout(dims, spacing, A);
      const v = ramp();
      const itk = toItk(v, dims, L);
      expect(Array.from(fromItk(itk, dims, L))).toEqual(Array.from(v));
      // LPS position of a world voxel
      const lps = (i: number, j: number, k: number) => {
        const w = [i * spacing[0], j * spacing[1], k * spacing[2]];
        return [0, 1, 2].map((r) => A[r * 4] * w[0] + A[r * 4 + 1] * w[1] + A[r * 4 + 2] * w[2] + A[r * 4 + 3]);
      };
      // find where world voxels landed, and check one step along each array axis
      const where = new Map<number, number>();
      for (let q = 0; q < itk.length; q++) where.set(itk[q], q);
      const [, d1, d2] = L.itkDims;
      const idx = (q: number) => [Math.floor(q / (d1 * d2)), Math.floor(q / d2) % d1, q % d2];
      const world = (o: number) => [o % dims[0], Math.floor(o / dims[0]) % dims[1], Math.floor(o / (dims[0] * dims[1]))];
      const pos = new Map<string, number[]>();
      for (let o = 0; o < v.length; o++) pos.set(idx(where.get(v[o])!).join(','), lps(...(world(o) as [number, number, number])));
      const want = [[0, 0, 1], [0, 1, 0], [1, 0, 0]]; // S, P, L
      for (let t = 0; t < 3; t++) {
        const a = [0, 0, 0], b = [0, 0, 0];
        b[t] = 1;
        const pa = pos.get(a.join(','))!, pb = pos.get(b.join(','))!;
        const d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        const n = Math.hypot(...d);
        expect(d.map((x) => x / n)).toEqual(want[t].map((x) => expect.closeTo(x, 6)));
        expect(n).toBeCloseTo(L.itkSpacing[t], 6);
      }
    }
  });
});

describe('desktop AI service: labels on the app grid', () => {
  it('the same grid: the labels as they are, inside the region only', () => {
    const n = dims[0] * dims[1] * dims[2];
    const cls = Uint8Array.from({ length: n }, (_, i) => (i % 7 === 0 ? 2 : 1));
    const margin = new Uint8Array(n).fill(80);
    const r = regionToLabels(cls, margin, dims, spacing, [0, 0, 0], { nx: dims[0], ny: dims[1], nz: dims[2], gs: spacing });
    expect(Array.from(r.cls)).toEqual(Array.from(cls));
    expect(r.counts[1] + r.counts[2]).toBe(n);
    // only a part of it written: the rest is background (margin 255)
    const part = regionToLabels(cls, margin, dims, spacing, [0, 0, 0], { nx: dims[0], ny: dims[1], nz: dims[2], gs: spacing }, { lo: [0, 0, 0.8], hi: [10, 10, 10] });
    for (let o = 0; o < n; o++) {
      const k = Math.floor(o / (dims[0] * dims[1]));
      // within half a voxel of the box counts as inside (as in the browser engine): from 0.55 mm
      if (k * spacing[2] < 0.55) {
        expect(part.cls[o]).toBe(0);
        expect(part.margin[o]).toBe(255);
      } else expect(part.cls[o]).toBe(cls[o]);
    }
  });

  it('a coarser app grid samples the region (smooth margins where the class agrees)', () => {
    const big: [number, number, number] = [20, 20, 20];
    const n = big[0] * big[1] * big[2];
    const cls = new Uint8Array(n), margin = new Uint8Array(n);
    for (let k = 0, o = 0; k < 20; k++)
      for (let j = 0; j < 20; j++)
        for (let i = 0; i < 20; i++, o++) {
          cls[o] = i < 10 ? 1 : 4;
          margin[o] = 40 + 2 * i;
        }
    const r = regionToLabels(cls, margin, big, [0.2, 0.2, 0.2], [1, 1, 1], { nx: 10, ny: 10, nz: 10, gs: [0.5, 0.5, 0.5] });
    // label voxel (4, 4, 4) at 2 mm = region (5, 5, 5): class 1; (6, 4, 4) at 3 mm = region 10: class 4
    expect(r.cls[4 + 40 + 400]).toBe(1);
    expect(r.cls[6 + 40 + 400]).toBe(4);
    expect(r.margin[4 + 40 + 400]).toBe(50);
    // outside the region (0 mm, 0.5 mm: before its first voxel at 1 mm − half a voxel): background
    expect(r.cls[0]).toBe(0);
    expect(r.cls[1 + 10 + 100]).toBe(0);
  });
});
