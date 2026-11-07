// Nerve paths from the segmented mandibular canals (DentalSegmentator label 5): one centre line per
// side, so the implant-to-nerve distance warnings work without tracing the canal by hand.

import type { Vec3 } from '../math';
import type { Segmentation } from '../segment';

export interface CanalLine {
  /** patient side (world +x = patient left) */
  side: 'right' | 'left';
  pts: Vec3[];
  /** mean canal diameter (mm) */
  diameter: number;
}

/** `midX`: world x of the midline (e.g. the centre of the mandible), used when only one canal is found. */
export function canalCentrelines(seg: Segmentation, id: number, midX: number): CanalLine[] {
  const L = seg.labels;
  if (!L) return [];
  const { nx, ny, nz, gs } = seg;
  const pts: number[] = [];
  for (let k = 0, idx = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, idx++) if (L[idx] === id) pts.push(i * gs[0], j * gs[1], k * gs[2]);
  const n = pts.length / 3;
  if (n < 30) return [];
  // two sides: 2-means on x
  let c0 = Infinity, c1 = -Infinity;
  for (let i = 0; i < n; i++) {
    c0 = Math.min(c0, pts[i * 3]);
    c1 = Math.max(c1, pts[i * 3]);
  }
  const side = new Uint8Array(n);
  for (let it = 0; it < 20; it++) {
    let s0 = 0, s1 = 0, n0 = 0, n1 = 0;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3];
      side[i] = Math.abs(x - c1) < Math.abs(x - c0) ? 1 : 0;
      if (side[i]) {
        s1 += x;
        n1++;
      } else {
        s0 += x;
        n0++;
      }
    }
    if (!n0 || !n1) break;
    c0 = s0 / n0;
    c1 = s1 / n1;
  }
  // the two canals lie ≥ 3 cm apart; closer clusters are one canal
  const two = Math.abs(c1 - c0) >= 25;
  if (!two) side.fill(0);
  const vox = gs[0] * gs[1] * gs[2];
  const out: CanalLine[] = [];
  for (const sd of two ? [0, 1] : [0]) {
    // centroid of every 1 mm slab along the antero-posterior axis (y)
    const bins = new Map<number, { x: number; y: number; z: number; n: number }>();
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (side[i] !== sd) continue;
      count++;
      const b = Math.floor(pts[i * 3 + 1]);
      const e = bins.get(b) ?? { x: 0, y: 0, z: 0, n: 0 };
      e.x += pts[i * 3];
      e.y += pts[i * 3 + 1];
      e.z += pts[i * 3 + 2];
      e.n++;
      bins.set(b, e);
    }
    if (count < 20) continue;
    const keys = [...bins.keys()].sort((a, b) => a - b).filter((k) => bins.get(k)!.n >= 2);
    if (keys.length < 4) continue;
    const raw: Vec3[] = keys.map((k) => {
      const e = bins.get(k)!;
      return [e.x / e.n, e.y / e.n, e.z / e.n];
    });
    // light smoothing, then control points every ~4 mm
    const sm: Vec3[] = raw.map((_, i) => {
      const a = raw[Math.max(0, i - 1)], b = raw[i], c = raw[Math.min(raw.length - 1, i + 1)];
      return [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4, (a[2] + 2 * b[2] + c[2]) / 4];
    });
    const ctrl: Vec3[] = [sm[0]];
    let acc = 0;
    let len = 0;
    for (let i = 1; i < sm.length; i++) {
      const d = Math.hypot(sm[i][0] - sm[i - 1][0], sm[i][1] - sm[i - 1][1], sm[i][2] - sm[i - 1][2]);
      acc += d;
      len += d;
      if (acc >= 4 || i === sm.length - 1) {
        ctrl.push(sm[i]);
        acc = 0;
      }
    }
    if (len < 5) continue;
    const area = (count * vox) / len;
    const diameter = Math.min(4, Math.max(1.5, 2 * Math.sqrt(area / Math.PI)));
    const mx = ctrl.reduce((a, p) => a + p[0], 0) / ctrl.length;
    const mid = two ? (c0 + c1) / 2 : midX;
    out.push({ side: mx >= mid ? 'left' : 'right', pts: ctrl, diameter: Math.round(diameter * 10) / 10 });
  }
  return out;
}
