// Dual scan: markers found in both scans, matched despite artefacts, the transform recovered, and
// the denture segmented without the loose support block.
import { describe, expect, it } from 'vitest';
import { autoDentureThreshold, autoMarkerThreshold, dentureMask, dentureSurface, findMarkers, matchMarkers } from '../../src/dualScan';
import { applyV } from '../../src/register';
import { Volume } from '../../src/volume';
import type { Vec3 } from '../../src/math';
import { DENTURE_GRID, MARKERS, PATIENT_GRID, T, applyT, dentureValue, patientValue } from '../../scripts/make-dual-scan-test.mjs';

function volumeOf(g: { cols: number; rows: number; slices: number; ps: number; dz: number }, f: (x: number, y: number, z: number) => number) {
  const data = new Int16Array(g.cols * g.rows * g.slices);
  for (let k = 0; k < g.slices; k++)
    for (let j = 0; j < g.rows; j++)
      for (let i = 0; i < g.cols; i++) data[i + j * g.cols + k * g.cols * g.rows] = Math.round(f(i * g.ps, j * g.ps, k * g.dz));
  return new Volume([g.cols, g.rows, g.slices], [g.ps, g.ps, g.dz], data, { source: 'test' });
}
const denture = volumeOf(DENTURE_GRID, dentureValue);
const patient = volumeOf(PATIENT_GRID, patientValue);
const d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('dual scan', () => {
  const tD = autoMarkerThreshold(denture);
  const D = findMarkers(denture, tD);
  const P = findMarkers(patient, tD);

  it('finds the 7 markers in the denture scan, where they are', () => {
    expect(D.length).toBe(7);
    for (const m of MARKERS) expect(Math.min(...D.map((x) => d(x.p, m as Vec3)))).toBeLessThan(0.25);
  });

  it('finds them in the patient scan too, with the marker-like artefacts but not the metal crown', () => {
    // 7 markers + 4 artefacts; the crown (≈ 137 mm³) is too big
    expect(P.length).toBe(11);
  });

  it('matches them and recovers the transform (artefacts left out)', () => {
    const m = matchMarkers(
      D.map((x) => x.p),
      P.map((x) => x.p),
    )!;
    expect(m).not.toBeNull();
    expect(m.pairs.length).toBe(7);
    expect(m.rms).toBeLessThan(0.25);
    // denture points anywhere on the denture land where T puts them
    for (const p of [...MARKERS, [25, 12, 9], [10, 30, 6], [40, 32, 12]] as Vec3[]) expect(d(applyV(m.T, p), applyT(p) as Vec3)).toBeLessThan(0.3);
  });

  it('works with markers missing in the patient scan and more artefacts', () => {
    const P2 = P.map((x) => x.p).filter((p) => d(p, applyT(MARKERS[2]) as Vec3) > 2 && d(p, applyT(MARKERS[5]) as Vec3) > 2);
    P2.push([62, 10, 8], [12, 60, 40], [5, 5, 5]);
    const m = matchMarkers(
      D.map((x) => x.p),
      P2,
    )!;
    expect(m.pairs.length).toBe(5);
    expect(d(applyV(m.T, [25, 12, 9]), applyT([25, 12, 9]) as Vec3)).toBeLessThan(0.3);
  });

  it('gives up with fewer than 3 markers', () => {
    expect(matchMarkers([MARKERS[0], MARKERS[1]] as Vec3[], P.map((x) => x.p))).toBeNull();
  });

  it('segments the denture (acrylic between air and markers), without the loose support', async () => {
    const t = autoDentureThreshold(denture, tD);
    expect(t).toBeGreaterThan(-700);
    expect(t).toBeLessThan(120);
    const mask = dentureMask(denture, t);
    // the horseshoe: about 36 × 28 mm, 8 mm high – the support block (left out) is far bigger in x/y reach
    const vox = (DENTURE_GRID.ps * mask.step) ** 2 * DENTURE_GRID.dz * mask.step;
    expect(mask.voxels * vox).toBeGreaterThan(2500);
    expect(mask.voxels * vox).toBeLessThan(5000);
    const at = (x: number, y: number, z: number) => {
      const a = Math.round(x / (DENTURE_GRID.ps * mask.step)), b = Math.round(y / (DENTURE_GRID.ps * mask.step)), c = Math.round(z / (DENTURE_GRID.dz * mask.step));
      return mask.mask[a + b * mask.nx + c * mask.nx * mask.ny];
    };
    expect(at(25, 12, 9)).toBe(1); // in the band
    expect(at(5, 42, 2)).toBe(0); // the support
    const mesh = await dentureSurface(denture, t);
    expect(mesh.idx.length).toBeGreaterThan(3000);
    // it lies around the band
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], mesh.pos[i + k]);
        mx[k] = Math.max(mx[k], mesh.pos[i + k]);
      }
    expect(mn[0]).toBeGreaterThan(5);
    expect(mx[1]).toBeLessThan(40);
    expect(mx[2] - mn[2]).toBeLessThan(10);
  });

  it('uses T as given (sanity check of the test data)', () => {
    expect(T.length).toBe(12);
  });
});
