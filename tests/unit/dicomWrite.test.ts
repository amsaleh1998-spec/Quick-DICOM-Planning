// Exported DICOM series read back by the loader: same voxels, spacing, patient coordinates and
// patient – also for a volume rotated and cropped in the app.
import { describe, expect, it } from 'vitest';
import { loadDicomFiles } from '../../src/dicom';
import { volumeToDicom } from '../../src/dicomWrite';
import { identityFrame, rotateFrame } from '../../src/math';
import { applyAffine, resampleVolume, type Volume } from '../../src/volume';
import type { Vec3 } from '../../src/math';
import { loadTestSeries } from './helpers';

const reload = async (v: Volume) => loadDicomFiles((await volumeToDicom(v)).map((f) => new File([f.data as BlobPart], f.name)), () => {});
const worldToPatient = (v: Volume, i: number, j: number, k: number) => applyAffine(v.info.patientAffine!, [i * v.spacing[0], j * v.spacing[1], k * v.spacing[2]]);
const d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The same voxels at the same patient positions (the loader may store the axes in another order). */
function samePatientSpace(a: Volume, b: Volume) {
  expect(b.nx * b.ny * b.nz).toBe(a.nx * a.ny * a.nz);
  // map every voxel of b to a's index through the patient coordinates, compare values
  const inv = (v: Volume, p: Vec3) => {
    const A = v.info.patientAffine!;
    const q = [p[0] - A[3], p[1] - A[7], p[2] - A[11]];
    // R is orthonormal: R^T q
    return [0, 1, 2].map((c) => Math.round((A[c] * q[0] + A[4 + c] * q[1] + A[8 + c] * q[2]) / v.spacing[c]));
  };
  let checked = 0;
  for (let k = 0; k < b.nz; k += 3)
    for (let j = 0; j < b.ny; j += 3)
      for (let i = 0; i < b.nx; i += 3) {
        const [ia, ja, ka] = inv(a, worldToPatient(b, i, j, k));
        expect(b.data[i + j * b.nx + k * b.nx * b.ny]).toBe(a.data[ia + ja * a.nx + ka * a.nx * a.ny]);
        checked++;
      }
  expect(checked).toBeGreaterThan(1000);
}

describe('DICOM export', () => {
  it('a loaded series comes back the same', async () => {
    const v = await loadTestSeries();
    const files = await volumeToDicom(v);
    expect(files.length).toBe(v.nz);
    expect(files[0].name).toBe('IM00001.dcm');
    expect(String.fromCharCode(...files[0].data.slice(128, 132))).toBe('DICM');
    const r = await reload(v);
    expect([...r.spacing].sort()).toEqual([...v.spacing].sort());
    expect(r.info.patientName).toBe(v.info.patientName);
    expect(r.info.patientId).toBe(v.info.patientId);
    expect(r.info.studyDate).toBe(v.info.studyDate);
    expect(r.info.seriesDescription).toContain('(Quick DICOM Planning)');
    samePatientSpace(v, r);
    // the study is kept, the series is new
    const tag = (x: Volume, t: string) => x.info.meta!.find((m) => m.tag === t)?.value;
    // (the test series has no study UID: a new one is made; an existing one is kept)
    if (tag(v, '0020,000D')) expect(tag(r, '0020,000D')).toBe(tag(v, '0020,000D'));
    else expect(tag(r, '0020,000D')).toMatch(/^2\.25\.\d+$/);
    expect(tag(r, '0020,000E')).toBeTruthy();
    expect(tag(r, '0020,000E')).not.toBe(tag(v, '0020,000E'));
    if (tag(v, '0020,0052')) expect(tag(r, '0020,0052')).toBe(tag(v, '0020,0052'));
    else expect(tag(r, '0020,0052')).toBeTruthy();
  });

  it('a rotated and cropped volume keeps its place in the patient', async () => {
    const v = await loadTestSeries();
    const O: Vec3 = [v.nx * v.spacing[0] * 0.5, v.ny * v.spacing[1] * 0.5, v.nz * v.spacing[2] * 0.5];
    const F = rotateFrame(rotateFrame(identityFrame(), [0, 0, 1], 0.4), [1, 0, 0], -0.25);
    const rot = await resampleVolume(v, O, F, [-10, -9, -8], [10, 9, 8], 0.3);
    const r = await reload(rot);
    samePatientSpace(rot, r);
    // the corner voxel is at the same patient position (the loader keeps the slice order here)
    expect(d(worldToPatient(rot, 0, 0, 0), worldToPatient(r, 0, 0, 0))).toBeLessThan(0.01);
  });

  it('keeps the study and frame of reference of the original when it has them', async () => {
    const v = await loadTestSeries();
    v.info.meta = [...v.info.meta!, { tag: '0020,000D', vr: 'UI', name: 'Study Instance UID', value: '1.2.3.4.5' }, { tag: '0020,0052', vr: 'UI', name: 'Frame of Reference UID', value: '1.2.3.4.6' }];
    const r = await reload(v);
    const tag = (t: string) => r.info.meta!.find((m) => m.tag === t)?.value;
    expect(tag('0020,000D')).toBe('1.2.3.4.5');
    expect(tag('0020,0052')).toBe('1.2.3.4.6');
  });
});
