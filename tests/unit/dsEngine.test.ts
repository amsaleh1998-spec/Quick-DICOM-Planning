// Automatic segmentation engine (tiling, normalisation, axes, blending, resampling back to the
// label grid) with a stand-in for the network that labels by intensity – the answer is known.
import { describe, expect, it } from 'vitest';
import { DsEngine, nonzeroBox } from '../../src/ai/dsEngine';
import { DS_MODEL, slidingSteps } from '../../src/ai/dsPlan';
import type { Vec3 } from '../../src/math';

const { mean, std, classes: NC, patch } = DS_MODEL;
const norm = (hu: number) => (hu - mean) / std;

/** fake network: class 2 above 500 HU, class 3 above 2000 HU (logits [NC][P0][P1][P2]) */
function fakeNet(input: Float32Array): Float32Array {
  const n = input.length;
  const out = new Float32Array(NC * n);
  const a = norm(500), b = norm(2000);
  for (let i = 0; i < n; i++) {
    const x = input[i];
    out[2 * n + i] = 6 * (x - a);
    out[3 * n + i] = 6 * (x - a) + 12 * (x - b);
  }
  return out;
}

describe('segmentation engine', () => {
  it('places tiles like nnU-Net', () => {
    expect(slidingSteps(100, 128, 0.5)).toEqual([0]);
    expect(slidingSteps(300, 128, 0.5)).toEqual([0, 57, 115, 172]);
  });

  it('reproduces the labels of a known volume on the label grid', () => {
    const dims: [number, number, number] = [100, 120, 80];
    const sp: Vec3 = [0.5, 0.5, 0.5];
    const sphere: Vec3 = [15, 18, 20];
    const truth = (x: number, y: number, z: number) =>
      x > 32 && x < 44 && y > 40 && y < 52 && z > 8 && z < 30 ? 3 : Math.hypot(x - sphere[0], y - sphere[1], z - sphere[2]) < 10 ? 2 : 0;
    const data = new Int16Array(dims[0] * dims[1] * dims[2]);
    const want = new Uint8Array(data.length);
    let o = 0;
    for (let k = 0; k < dims[2]; k++)
      for (let j = 0; j < dims[1]; j++)
        for (let i = 0; i < dims[0]; i++, o++) {
          const c = truth(i * sp[0], j * sp[1], k * sp[2]);
          want[o] = c;
          data[o] = c === 3 ? 2500 : c === 2 ? 1000 : -500;
        }
    const hi: Vec3 = [(dims[0] - 1) * sp[0], (dims[1] - 1) * sp[1], (dims[2] - 1) * sp[2]];
    const box = nonzeroBox(data, dims, sp, [0, 0, 0], hi);
    const eng = new DsEngine({ data, dims, spacing: sp, roiLo: box.lo, roiHi: box.hi, step: 0.5, label: { nx: dims[0], ny: dims[1], nz: dims[2], gs: sp } });
    expect(eng.tiles.length).toBeGreaterThan(1); // blending between tiles is exercised
    const input = new Float32Array(patch[0] * patch[1] * patch[2]);
    for (const t of eng.tiles) eng.addTile(t, eng.fillTile(t, input) ? fakeNet(input) : null);
    const res = eng.finish();
    for (const c of [2, 3]) {
      let inter = 0, a = 0, b = 0;
      for (let i = 0; i < want.length; i++) {
        if (res.cls[i] === c) a++;
        if (want[i] === c) b++;
        if (res.cls[i] === c && want[i] === c) inter++;
      }
      expect((2 * inter) / (a + b)).toBeGreaterThan(0.95); // Dice (small objects: edges count a lot)
      expect(res.counts[c]).toBe(a);
    }
    // away from the edges (more than one model voxel) every label is right
    let wrong = 0, checked = 0;
    o = 0;
    for (let k = 0; k < dims[2]; k++)
      for (let j = 0; j < dims[1]; j++)
        for (let i = 0; i < dims[0]; i++, o++) {
          const [x, y, z] = [i * sp[0], j * sp[1], k * sp[2]];
          const c = want[o];
          let edge = false;
          for (const [dx, dy, dz] of [[0.6, 0, 0], [-0.6, 0, 0], [0, 0.6, 0], [0, -0.6, 0], [0, 0, 0.6], [0, 0, -0.6]])
            if (truth(x + dx, y + dy, z + dz) !== c) edge = true;
          if (edge) continue;
          checked++;
          if (res.cls[o] !== c) wrong++;
        }
    expect(checked).toBeGreaterThan(want.length * 0.9);
    expect(wrong).toBe(0);
  });
});
