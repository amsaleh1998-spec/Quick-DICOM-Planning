// STL export: closed, outward-facing surfaces in DICOM patient coordinates.
import { describe, expect, it } from 'vitest';
import { TEST_SERIES } from '../../scripts/make-test-dicom.mjs';
import { Segmentation } from '../../src/segment';
import { Tris, coneMesh, isoSurface, meshToTris, stlBytes, transformTris } from '../../src/stl';
import { readStl } from '../../src/meshio';
import type { Vec3 } from '../../src/math';
import { centroid, dist, loadTestSeries } from './helpers';

/** Every edge is shared by exactly two triangles, once in each direction (closed, consistently oriented). */
function isClosed(tris: Tris): boolean {
  const key = (t: number, k: number) => `${tris[t + 3 * k].toFixed(4)},${tris[t + 3 * k + 1].toFixed(4)},${tris[t + 3 * k + 2].toFixed(4)}`;
  const edges = new Map<string, number>();
  for (let t = 0; t < tris.length; t += 9)
    for (let k = 0; k < 3; k++) {
      const a = key(t, k), b = key(t, (k + 1) % 3);
      edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) ?? 0) + 1);
    }
  for (const [e, n] of edges) {
    const [a, b] = e.split('|');
    if (n !== 1 || edges.get(`${b}|${a}`) !== 1) return false;
  }
  return edges.size > 0;
}

/** Signed volume (positive when the triangles face outwards) and the volume centroid. */
function solid(tris: Tris): { volume: number; c: Vec3 } {
  let V = 0;
  const c = [0, 0, 0];
  for (let t = 0; t < tris.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.subarray(t, t + 9);
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    V += v;
    c[0] += (v * (ax + bx + cx)) / 4;
    c[1] += (v * (ay + by + cy)) / 4;
    c[2] += (v * (az + bz + cz)) / 4;
  }
  return { volume: V, c: [c[0] / V, c[1] / V, c[2] / V] };
}

describe('segment STL export', () => {
  it('is a closed sphere of the right size, at the right place in patient coordinates', async () => {
    const vol = await loadTestSeries();
    const seg = new Segmentation();
    seg.reset(vol);
    const g = seg.addSegment('Sphere')!;
    const centre = centroid(vol, (x) => x === 1000).c;
    expect(seg.grow(g, centre, 500, 1500, null).added).toBeGreaterThan(1000);
    const field = seg.segmentField(g, 1)!;
    const tris = meshToTris(await isoSurface(field));
    expect(isClosed(tris)).toBe(true);
    const world = solid(tris);
    const r = 8;
    expect(world.volume).toBeGreaterThan(((4 / 3) * Math.PI * r ** 3) * 0.9);
    expect(world.volume).toBeLessThan(((4 / 3) * Math.PI * r ** 3) * 1.1);
    expect(dist(world.c, centre)).toBeLessThan(0.1);

    // as exported: DICOM patient coordinates, still facing outwards
    transformTris(tris, vol.info.patientAffine!);
    const lps = solid(tris);
    expect(lps.volume).toBeCloseTo(world.volume, 0);
    const { slices, dz, topZ } = TEST_SERIES;
    expect(dist(lps.c, [16, 14, topZ - (slices - 1) * dz + 12.25])).toBeLessThan(0.15);

    // binary STL round trip
    const bytes = stlBytes(tris, 'Sphere', 'LPS');
    expect(new TextDecoder().decode(bytes.subarray(0, 9))).toBe('SPACE=LPS');
    const back = readStl(bytes.buffer as ArrayBuffer);
    expect(back.idx.length / 3).toBe(tris.length / 9);
  });

  it('builds closed implant solids of the right volume', () => {
    const tris = coneMesh([0, 0, 0], [0, 0, 10], 2, 1.5, 72);
    expect(isClosed(tris)).toBe(true);
    const frustum = (Math.PI * 10 * (2 * 2 + 2 * 1.5 + 1.5 * 1.5)) / 3;
    expect(solid(tris).volume).toBeGreaterThan(frustum * 0.99);
    expect(solid(tris).volume).toBeLessThan(frustum * 1.001);
  });

  it('keeps triangles outward-facing through a mirroring affine', () => {
    const tris = coneMesh([0, 0, 0], [0, 0, 10], 2, 2, 36);
    transformTris(tris, [-1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(solid(tris).volume).toBeGreaterThan(0);
  });
});
