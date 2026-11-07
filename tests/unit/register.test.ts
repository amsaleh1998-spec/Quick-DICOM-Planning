// Scan alignment: point-pair fit (Horn / Kabsch) and surface refinement (ICP).
import { describe, expect, it } from 'vitest';
import { Affine, Target, applyV, axisAngle, compose, fitRigid, fitStats, fromRot, icp, invert } from '../../src/register';
import { originalTransform } from '../../src/scans';
import type { Vec3 } from '../../src/math';
import { dist } from './helpers';

/** a rigid motion: rotation of `deg` about a tilted axis, then a shift */
const motion = (deg: number, t: Vec3): Affine => {
  const ax: Vec3 = [0.3, -0.5, 0.81];
  const n = Math.hypot(...ax);
  return fromRot(axisAngle([ax[0] / n, ax[1] / n, ax[2] / n], (deg * Math.PI) / 180), t);
};

/** deterministic pseudo-random numbers */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** A bumpy, asymmetric dental-arch-like surface: points and normals. */
function surface(): { pts: Float32Array; nrm: Float32Array } {
  const pts: number[] = [];
  const nrm: number[] = [];
  const h = (x: number, y: number) => 4 * Math.exp(-((x - 5) ** 2 + (y + 3) ** 2) / 30) + 2 * Math.sin(x / 3) * Math.cos(y / 4) + 0.05 * x * y;
  for (let x = -20; x <= 20; x += 0.5)
    for (let y = -15; y <= 15; y += 0.5) {
      const z = h(x, y);
      const dx = (h(x + 0.01, y) - h(x - 0.01, y)) / 0.02;
      const dy = (h(x, y + 0.01) - h(x, y - 0.01)) / 0.02;
      const n = Math.hypot(dx, dy, 1);
      pts.push(x, y, z);
      nrm.push(-dx / n, -dy / n, 1 / n);
    }
  return { pts: Float32Array.from(pts), nrm: Float32Array.from(nrm) };
}

describe('registration', () => {
  it('fits point pairs exactly without noise and closely with noise', () => {
    const T = motion(23, [4, -7, 2.5]);
    const r = rng(7);
    const P: Vec3[] = Array.from({ length: 6 }, () => [r() * 40 - 20, r() * 30 - 15, r() * 20 - 10]);
    const Q = P.map((p) => applyV(T, p));
    const fit = fitRigid(P, Q);
    for (let i = 0; i < 12; i++) expect(fit[i]).toBeCloseTo(T[i], 6);
    // 0.2 mm noise on the clicked points
    const noisy = Q.map((q) => q.map((v) => v + (r() - 0.5) * 0.4) as Vec3);
    const fit2 = fitRigid(P, noisy);
    for (const p of P) expect(dist(applyV(fit2, p), applyV(T, p))).toBeLessThan(0.35);
  });

  it('refines a rough placement onto the surface (ICP)', () => {
    const target = surface();
    const tg = new Target(target.pts, target.nrm);
    // the "scan": every 7th surface point, moved away by a known motion
    const M = motion(4, [1.2, -0.8, 0.6]);
    const src: number[] = [];
    const srcN: number[] = [];
    const Mi = invert(M);
    for (let i = 0; i < target.pts.length; i += 21) {
      const p = applyV(Mi, [target.pts[i], target.pts[i + 1], target.pts[i + 2]]);
      src.push(...p);
      const n = applyV(fromRot([Mi[0], Mi[1], Mi[2], Mi[4], Mi[5], Mi[6], Mi[8], Mi[9], Mi[10]]), [target.nrm[i], target.nrm[i + 1], target.nrm[i + 2]]);
      srcN.push(...n);
    }
    const s = Float32Array.from(src);
    const before = fitStats(s, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], tg);
    const T = icp(s, Float32Array.from(srcN), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], tg);
    const after = fitStats(s, T, tg);
    expect(before.rms).toBeGreaterThan(0.3);
    expect(after.rms).toBeLessThan(0.05);
    // and it is the motion that was applied
    const err = compose(T, Mi);
    for (const p of [[0, 0, 0], [15, 10, 3], [-15, -10, 0]] as Vec3[]) expect(dist(applyV(err, applyV(M, p)), applyV(M, p))).toBeLessThan(0.1);
  });

  it('places a scan exported in DICOM coordinates back where it was', () => {
    const patientAffine = [-1, 0, 0, 120, 0, -1, 0, 95, 0, 0, 1, -40]; // a mirrored, shifted scanner frame
    const w: Vec3 = [33, 21, 17];
    const inFile = applyV(patientAffine, w); // exported STL vertex
    expect(dist(applyV(originalTransform(patientAffine), inFile), w)).toBeLessThan(1e-9);
  });
});
