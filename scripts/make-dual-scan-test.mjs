// A synthetic dual scan for the tests: a denture (acrylic horseshoe with 7 radiopaque markers, and a
// loose block like a scanning support) scanned alone, and the same denture in the "patient's" scan,
// moved by a known rigid transform T, together with bone, a metal restoration, small bright
// artefacts that look like markers, and noise. Values are HU.
//
//   node scripts/make-dual-scan-test.mjs <outDir>   writes denture/ and patient/ DICOM series
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTestSeries } from './make-test-dicom.mjs';

const rad = (d) => (d * Math.PI) / 180;

/** Rigid transform denture -> patient (3×4 row-major): rotation about z, then x, then a shift. */
function makeT() {
  const az = rad(12), ax = rad(-8);
  const Rz = [Math.cos(az), -Math.sin(az), 0, Math.sin(az), Math.cos(az), 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, Math.cos(ax), -Math.sin(ax), 0, Math.sin(ax), Math.cos(ax)];
  const R = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => Rx[r * 3] * Rz[c] + Rx[r * 3 + 1] * Rz[3 + c] + Rx[r * 3 + 2] * Rz[6 + c]));
  const t = [14, 11, 13];
  return [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2]];
}
export const T = makeT();
export const applyT = (p, m = T) => [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);
function invertT(m) {
  const R = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const t = [m[3], m[7], m[11]];
  const ti = [0, 1, 2].map((r) => -(R[r * 3] * t[0] + R[r * 3 + 1] * t[1] + R[r * 3 + 2] * t[2]));
  return [R[0], R[1], R[2], ti[0], R[3], R[4], R[5], ti[1], R[6], R[7], R[8], ti[2]];
}
const Tinv = invertT(T);

// denture geometry (denture scan world, mm): an elliptic horseshoe band, open towards +y
const C = [25, 30];
const OUTER = [18, 20];
const INNER = [11, 13];
const Z0 = 5, Z1 = 13;
const inEllipse = (x, y, [a, b]) => ((x - C[0]) / a) ** 2 + ((y - C[1]) / b) ** 2 <= 1;
const inBand = (x, y, z) => z >= Z0 && z <= Z1 && y <= C[1] + 8 && inEllipse(x, y, OUTER) && !inEllipse(x, y, INNER);
const inSupport = (x, y, z) => x >= 2 && x <= 8 && y >= 40 && y <= 44 && z >= 0.5 && z <= 4;

/** The 7 markers (denture scan world, mm): along the middle of the band, unevenly spaced. */
export const MARKERS = [-80, -52, -21, 6, 33, 61, 86].map((deg, i) => {
  const th = rad(deg);
  return [C[0] + 14.5 * Math.sin(th), C[1] - 16.5 * Math.cos(th), 9 + (i % 3) - 1];
});
export const MARKER_R = 0.9;
const nearMarker = (p) => MARKERS.some((m) => Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]) <= MARKER_R);

/** Deterministic noise in [-a, a] from the position. */
const noise = (x, y, z, a) => {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return (s - Math.floor(s) - 0.5) * 2 * a;
};

export const DENTURE_GRID = { cols: 130, rows: 120, slices: 45, ps: 0.4, dz: 0.4 };
export function dentureValue(x, y, z) {
  let v = -1000;
  if (inBand(x, y, z) || inSupport(x, y, z)) v = 150;
  if (nearMarker([x, y, z])) v = 3000;
  return v + noise(x, y, z, 40);
}

// patient scan: soft tissue box, a bone slab above the denture, a metal crown, marker-like artefacts
const ARTEFACTS = [
  [20, 54, 34],
  [52, 18, 36],
  [8, 30, 31],
  [44, 50, 6],
];
export const PATIENT_GRID = { cols: 170, rows: 160, slices: 110, ps: 0.45, dz: 0.45 };
export function patientValue(x, y, z) {
  let v = -1000;
  if (x > 3 && x < 73 && y > 3 && y < 69 && z > 2 && z < 46) v = 40; // soft tissue
  if (x > 10 && x < 66 && y > 8 && y < 62 && z > 30 && z < 40) v = 1000; // bone
  if (Math.hypot(x - 60, y - 55, z - 20) < 3.2) v = 3200; // metal crown (too big for a marker)
  if (ARTEFACTS.some((a) => Math.hypot(x - a[0], y - a[1], z - a[2]) <= 0.8)) v = 2900;
  const d = applyT([x, y, z], Tinv); // the denture, worn
  if (inBand(d[0], d[1], d[2])) v = Math.max(v, 150);
  if (nearMarker(d)) v = 3000;
  return v + noise(x, y, z, 60);
}

/** The two series as DICOM files. */
export function makeDualScanSeries() {
  return {
    denture: makeTestSeries({
      ...DENTURE_GRID,
      voxel: dentureValue,
      patient: { name: 'Dual^Scan', id: 'DS-1' },
      uid: '1.2.826.0.1.3680043.8.498.71',
      prefix: 'DEN',
      description: 'Denture alone (dual scan)',
    }),
    patient: makeTestSeries({
      ...PATIENT_GRID,
      voxel: patientValue,
      patient: { name: 'Dual^Scan', id: 'DS-1' },
      uid: '1.2.826.0.1.3680043.8.498.72',
      prefix: 'PAT',
      description: 'Patient with denture (dual scan)',
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] ?? 'test-output/dual-scan';
  const s = makeDualScanSeries();
  for (const [k, files] of Object.entries(s)) {
    mkdirSync(join(out, k), { recursive: true });
    for (const f of files) writeFileSync(join(out, k, f.name), f.data);
  }
  console.log(`Wrote ${out}/denture and ${out}/patient`);
}
