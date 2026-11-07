// DICOM loading and patient coordinates (the base of every export).
import { describe, expect, it } from 'vitest';
import { TEST_SERIES } from '../../scripts/make-test-dicom.mjs';
import { formatPatientName } from '../../src/dicomMeta';
import { applyAffine, resampleVolume } from '../../src/volume';
import { identityFrame, rotateFrame } from '../../src/math';
import type { Vec3 } from '../../src/math';
import { centroid, dist, loadTestSeries } from './helpers';

const { cols, rows, slices, ps, dz, topZ } = TEST_SERIES;
const lowestZ = topZ - (slices - 1) * dz;
/** where the generator put things, in DICOM patient coordinates (LPS, mm) */
const SPHERE_LPS: Vec3 = [16, 14, lowestZ + 12.25];
const SPHERE_HU = 1000;
const MARKER_HU = 2500;

describe('DICOM loader', () => {
  it('reads the series: size, spacing, patient', async () => {
    const v = await loadTestSeries();
    expect([v.nx, v.ny, v.nz].sort((a, b) => a - b)).toEqual([cols, rows, slices].sort((a, b) => a - b));
    expect([...v.spacing].sort()).toEqual([ps, ps, dz].sort());
    expect(formatPatientName(v.info.patientName)).toBe('TEST, Loader');
    expect(v.info.modality).toBe('CT');
    expect(v.info.patientAffine).toBeDefined();
  });

  it.each([
    ['without file extensions', { noExt: true }],
    ['without preamble, implicit VR', { raw: 'implicit' as const }],
    ['without preamble, explicit VR', { raw: 'explicit' as const }],
  ])('reads files %s', async (_name, opts) => {
    const v = await loadTestSeries(opts);
    expect(v.nx * v.ny * v.nz).toBe(cols * rows * slices);
  });

  it('maps voxels to the patient coordinates of the files', async () => {
    const v = await loadTestSeries();
    const A = v.info.patientAffine!;
    // the sphere's centre lands where the generator put it
    const s = centroid(v, (x) => x === SPHERE_HU);
    expect(s.n).toBeGreaterThan(1000);
    expect(dist(applyAffine(A, s.c), SPHERE_LPS)).toBeLessThan(0.1);
    // every marker voxel is in the patient's left-anterior-superior corner (LPS: high x, low y, high z)
    let n = 0;
    for (let k = 0; k < v.nz; k++)
      for (let j = 0; j < v.ny; j++)
        for (let i = 0; i < v.nx; i++) {
          if (v.data[(k * v.ny + j) * v.nx + i] !== MARKER_HU) continue;
          const p = applyAffine(A, [i * v.spacing[0], j * v.spacing[1], k * v.spacing[2]]);
          expect(p[0]).toBeGreaterThan(26 - 1e-6);
          expect(p[1]).toBeLessThan(4 + 1e-6);
          expect(p[2]).toBeGreaterThan(lowestZ + 20 - 1e-6);
          n++;
        }
    expect(n).toBeGreaterThan(100);
  });

  it('keeps patient coordinates through reorientation and crop', async () => {
    const v = await loadTestSeries();
    const before = applyAffine(v.info.patientAffine!, centroid(v, (x) => x === SPHERE_HU).c);
    // tilt 12° around one axis and 7° around another, crop around the sphere, 0.3 mm voxels
    let F = rotateFrame(identityFrame(), [1, 0, 0], (12 * Math.PI) / 180);
    F = rotateFrame(F, [0, 0, 1], (7 * Math.PI) / 180);
    const O: Vec3 = [v.nx * v.spacing[0] * 0.4, v.ny * v.spacing[1] * 0.4, v.nz * v.spacing[2] * 0.5];
    const r = await resampleVolume(v, O, F, [-14, -14, -14], [14, 14, 14], 0.3);
    // interpolated values: the sphere is where it is about 1000 HU
    const after = applyAffine(r.info.patientAffine!, centroid(r, (x) => x > 500 && x < 1500).c);
    expect(dist(before, after)).toBeLessThan(0.15);
  });
});
