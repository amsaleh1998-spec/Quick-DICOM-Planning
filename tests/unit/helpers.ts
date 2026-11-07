import { makeTestSeries } from '../../scripts/make-test-dicom.mjs';
import { loadDicomFiles } from '../../src/dicom';
import type { Vec3 } from '../../src/math';
import { Volume } from '../../src/volume';

export const testSeriesFiles = (opts?: Parameters<typeof makeTestSeries>[0]) =>
  makeTestSeries(opts).map((f) => new File([f.data as BlobPart], f.name));

export const loadTestSeries = (opts?: Parameters<typeof makeTestSeries>[0]) => loadDicomFiles(testSeriesFiles(opts), () => {});

/** World position (mm) of voxel (i, j, k). */
export const voxelWorld = (v: Volume, i: number, j: number, k: number): Vec3 => [i * v.spacing[0], j * v.spacing[1], k * v.spacing[2]];

/** Centroid (world mm) of the voxels whose value passes `test`. */
export function centroid(v: Volume, test: (value: number) => boolean): { c: Vec3; n: number } {
  let n = 0;
  const s = [0, 0, 0];
  for (let k = 0; k < v.nz; k++)
    for (let j = 0; j < v.ny; j++)
      for (let i = 0; i < v.nx; i++) {
        if (!test(v.data[(k * v.ny + j) * v.nx + i])) continue;
        const w = voxelWorld(v, i, j, k);
        s[0] += w[0];
        s[1] += w[1];
        s[2] += w[2];
        n++;
      }
  return { c: [s[0] / n, s[1] / n, s[2] / n], n };
}

export const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A synthetic volume: f(world) gives the value of every voxel. */
export function makeVolume(dims: [number, number, number], spacing: number, f: (p: Vec3) => number, patientAffine?: number[]): Volume {
  const data = new Int16Array(dims[0] * dims[1] * dims[2]);
  let o = 0;
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) data[o++] = f([i * spacing, j * spacing, k * spacing]);
  return new Volume(dims, [spacing, spacing, spacing], data, { source: 'test', patientAffine } as Volume['info']);
}
