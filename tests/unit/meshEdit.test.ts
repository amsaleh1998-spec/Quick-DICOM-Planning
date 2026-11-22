// Mesh editing: parts, removing islands, trimming with a lasso, closing holes watertight and
// facing the right way.
import { describe, expect, it } from 'vitest';
import { boundaryLoops, brushCut, brushSmooth, components, fillHoles, keepTriangles, trimLasso } from '../../src/meshEdit';
import type { MeshData } from '../../src/meshio';
import type { Vec3 } from '../../src/math';

/** Closed box [0,s]³ made of n×n quads per face, outward facing; shifted by `o`. */
function box(n: number, s: number, o: Vec3 = [0, 0, 0]): MeshData {
  const pos: number[] = [], idx: number[] = [];
  const vid = new Map<string, number>();
  const v = (p: Vec3) => {
    const k = p.map((x) => x.toFixed(5)).join(',');
    let i = vid.get(k);
    if (i === undefined) {
      i = pos.length / 3;
      vid.set(k, i);
      pos.push(p[0] + o[0], p[1] + o[1], p[2] + o[2]);
    }
    return i;
  };
  // each face: axis, side; (u, w) the in-plane axes, ordered so u × w points outwards
  for (const [ax, side] of [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]] as const) {
    let u = (ax + 1) % 3, w = (ax + 2) % 3;
    if (side === 0) [u, w] = [w, u];
    const P = (i: number, j: number): Vec3 => {
      const p: Vec3 = [0, 0, 0];
      p[ax] = side * s;
      p[u] = (i / n) * s;
      p[w] = (j / n) * s;
      return p;
    };
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const a = v(P(i, j)), b = v(P(i + 1, j)), c = v(P(i + 1, j + 1)), d = v(P(i, j + 1));
        idx.push(a, b, c, a, c, d);
      }
  }
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx), col: null };
}

function merge(a: MeshData, b: MeshData): MeshData {
  const off = a.pos.length / 3;
  return { pos: Float32Array.from([...a.pos, ...b.pos]), idx: Uint32Array.from([...a.idx, ...Array.from(b.idx, (i) => i + off)]), col: null };
}

/** Every edge in exactly two triangles, in opposite directions (closed, consistently facing). */
function closedAndOriented(m: MeshData) {
  const dir = new Map<string, number>();
  for (let t = 0; t < m.idx.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const k2 = `${m.idx[t + k]}>${m.idx[t + ((k + 1) % 3)]}`;
      dir.set(k2, (dir.get(k2) ?? 0) + 1);
    }
  for (const [e, c] of dir) {
    if (c !== 1) return false;
    const [a, b] = e.split('>');
    if (dir.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

/** Signed volume (positive when the surface faces outwards). */
function volume(m: MeshData) {
  let V = 0;
  const p = (i: number) => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
  for (let t = 0; t < m.idx.length; t += 3) {
    const [a, b, c] = [p(m.idx[t]), p(m.idx[t + 1]), p(m.idx[t + 2])];
    V += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return V;
}

describe('mesh editing', () => {
  const big = box(6, 10);
  it('the test box is closed and faces outwards', () => {
    expect(closedAndOriented(big)).toBe(true);
    expect(volume(big)).toBeCloseTo(1000, 3);
  });

  it('finds the parts and removes the islands', () => {
    const m = merge(big, box(2, 1, [20, 0, 0]));
    const { part, sizes } = components(m);
    expect(sizes.length).toBe(2);
    const main = part[0];
    const kept = keepTriangles(m, (t) => part[t] === main);
    expect(kept.idx.length).toBe(big.idx.length);
    expect(kept.pos.length).toBe(big.pos.length); // unused vertices dropped
    expect(closedAndOriented(kept)).toBe(true);
  });

  it('trims with a lasso (looking down -z) and closes the hole again', () => {
    // orthographic view from above: screen = (x, y); the lasso a square inside the top face
    const screen = (p: Vec3): [number, number] => [p[0], p[1]];
    const lasso: [number, number][] = [
      [2.5, 2.5],
      [7.5, 2.5],
      [7.5, 7.5],
      [2.5, 7.5],
    ];
    // only the visible side (top face, z = 10): the bottom stays
    const top = trimLasso(big, lasso, screen, (p) => p[2] > 9.99);
    expect(top.idx.length).toBeLessThan(big.idx.length);
    // a jagged hole (triangles touching at a corner can split it into loops sharing a vertex)
    expect(boundaryLoops(top).length).toBeGreaterThanOrEqual(1);
    const closed = fillHoles(top);
    expect(closedAndOriented(closed)).toBe(true);
    expect(volume(closed)).toBeCloseTo(1000, 3); // flat cap, the box again
    // through: top and bottom both cut
    const through = trimLasso(big, lasso, screen);
    expect(boundaryLoops(through).length).toBeGreaterThanOrEqual(2);
    const closed2 = fillHoles(through);
    expect(closedAndOriented(closed2)).toBe(true);
    expect(volume(closed2)).toBeCloseTo(1000, 3);
  });

  it('closes a non-convex (U-shaped) hole', () => {
    const screen = (p: Vec3): [number, number] => [p[0], p[1]];
    const U: [number, number][] = [
      [0.8, 0.8], [9.2, 0.8], [9.2, 9.2], [6.8, 9.2], [6.8, 3.2], [3.2, 3.2], [3.2, 9.2], [0.8, 9.2],
    ];
    const cut = trimLasso(big, U, screen, (p) => p[2] > 9.99);
    expect(boundaryLoops(cut).length).toBeGreaterThanOrEqual(1);
    const closed = fillHoles(cut);
    expect(closedAndOriented(closed)).toBe(true);
    expect(volume(closed)).toBeCloseTo(1000, 3);
  });

  it('the cut brush removes the surface under it (and the hole closes again)', () => {
    const cut = brushCut(big, [[5, 5, 10], [6, 5, 10]], 2);
    expect(cut.idx.length).toBeLessThan(big.idx.length);
    // only near the brush: the bottom is untouched
    let bottom = 0;
    for (let t = 0; t < cut.idx.length; t += 3) if ([0, 1, 2].every((k) => cut.pos[cut.idx[t + k] * 3 + 2] < 0.01)) bottom++;
    expect(bottom).toBe(6 * 6 * 2);
    expect(boundaryLoops(cut).length).toBeGreaterThanOrEqual(1);
    expect(closedAndOriented(fillHoles(cut))).toBe(true);
    // nowhere near the mesh: the same mesh back
    expect(brushCut(big, [[50, 50, 50]], 2)).toBe(big);
  });

  it('the smooth brush smooths only where it is brushed', () => {
    // a bump on the top face
    const bumpy = { ...big, pos: new Float32Array(big.pos) };
    let bump = -1;
    for (let v = 0; v < bumpy.pos.length / 3; v++)
      if (Math.abs(bumpy.pos[v * 3] - 5) < 0.01 && Math.abs(bumpy.pos[v * 3 + 1] - 5) < 0.01 && bumpy.pos[v * 3 + 2] > 9.99) bump = v;
    expect(bump).toBeGreaterThanOrEqual(0);
    bumpy.pos[bump * 3 + 2] = 12;
    const far = (m: MeshData) => Array.from(m.pos).filter((_, i) => i % 3 === 2 && m.pos[i] < 0.01).length;
    const sm = brushSmooth(bumpy, [[5, 5, 11]], 3);
    expect(sm.pos[bump * 3 + 2]).toBeLessThan(11.2); // the bump is flattened
    expect(bumpy.pos[bump * 3 + 2]).toBe(12); // a copy: the original is unchanged
    // far from the brush nothing moved
    for (let i = 0; i < sm.pos.length; i += 3) if (sm.pos[i + 2] < 0.01) expect(sm.pos[i + 2]).toBe(bumpy.pos[i + 2]);
    expect(far(sm)).toBe(far(bumpy));
    expect(sm.idx).toBe(bumpy.idx);
    // the strength: more rounds per dab flatten the bump more
    const weak = brushSmooth(bumpy, [[5, 5, 11]], 3, 1);
    const strong = brushSmooth(bumpy, [[5, 5, 11]], 3, 20);
    expect(strong.pos[bump * 3 + 2]).toBeLessThan(weak.pos[bump * 3 + 2]);
    expect(weak.pos[bump * 3 + 2]).toBeLessThan(12);
  });
});
