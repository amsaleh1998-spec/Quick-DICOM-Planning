// Implant library: a library file (here the made-up test library – the real ones are private),
// its catalogue, a system's meshes, size choice.
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { makeTestImplantLibrary } from '../../scripts/make-test-implant-library.mjs';
import { ImplantIndex, findModel, meshWorld, modelId, nearestSize, parseSystem, setImplantIndex } from '../../src/implantLibrary';
import { createImplant, implantParts, platformOf } from '../../src/implant';
import { readZip } from '../../src/zip';

const bytes = makeTestImplantLibrary({ library: 3 });
const entries = await readZip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
const index = JSON.parse(new TextDecoder().decode(entries.get('index.json'))) as ImplantIndex & { format: string };
setImplantIndex(index);
const system = (name: string) => index.brands[0].systems.find((s) => s.name === name)!;
function meshes(file: string) {
  const buf = inflateSync(entries.get(file)!);
  return parseSystem(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

describe('implant library file', () => {
  it('holds a versioned catalogue with measured dimensions, and every system file', () => {
    expect(index.format).toBe('qdp-implant-library');
    expect(index.library).toBe(3);
    for (const s of index.brands.flatMap((b) => b.systems)) {
      expect(entries.has(s.file)).toBe(true);
      expect(s.bytes).toBe(entries.get(s.file)!.length);
    }
    const all = index.brands.flatMap((b) => b.systems.flatMap((s) => s.sizes));
    for (const z of all) {
      expect(z.len).toBeGreaterThan(3);
      expect(z.apex).toBeLessThanOrEqual(z.dia + 1e-9);
      expect(z.top).toBeGreaterThanOrEqual(0);
    }
    const z = system('Taper TX').sizes.find((s) => s.d === 4.5 && s.L === 12)!;
    expect(z.len).toBeCloseTo(12, 1);
    expect(z.dia).toBeGreaterThan(4.4);
    expect(z.dia).toBeLessThan(4.8);
    // a tissue-level implant has its connection above the platform
    expect(system('Tissue TL').sizes[0].top).toBeGreaterThan(1.5);
  });

  it('reads a system file: the platform at the origin, the apex down the axis', () => {
    const tx = system('Taper TX');
    const ms = meshes(tx.file);
    expect(ms.size).toBe(tx.sizes.length);
    for (const z of tx.sizes) {
      const m = ms.get(modelId('Testco', 'Taper TX', z.label))!;
      let zmin = Infinity, zmax = -Infinity, r = 0;
      for (let i = 0; i < m.pos.length; i += 3) {
        zmin = Math.min(zmin, m.pos[i + 2]);
        zmax = Math.max(zmax, m.pos[i + 2]);
        if (m.pos[i + 2] <= 0) r = Math.max(r, Math.hypot(m.pos[i], m.pos[i + 1]));
      }
      expect(-zmin).toBeCloseTo(z.len, 1);
      expect(zmax).toBeCloseTo(z.top, 1);
      expect(2 * r).toBeCloseTo(z.dia, 1);
      expect(Math.max(...m.idx)).toBeLessThan(m.pos.length / 3);
    }
  });

  it('places a mesh at an implant and picks the nearest size', () => {
    const tx = system('Taper TX');
    const z = nearestSize(tx, 4.4, 11.6);
    expect([z.d, z.L]).toEqual([4.5, 12]);
    // changing the length keeps the diameter, and the other way round
    expect(nearestSize(tx, 4.5, 15.5, 'L').d).toBe(4.5);
    const z410 = tx.sizes.find((s) => s.d === 4 && s.L === 10)!;
    expect(nearestSize(tx, 4, 11.2, 'L', z410).label).toBe('4 × 12 mm');
    expect(nearestSize(tx, 4, 8.8, 'L', z410).label).toBe('4 × 8 mm');
    expect(nearestSize(tx, 4.6, 10, 'd', z410).label).toBe('4.5 × 10 mm');
    expect(nearestSize(tx, 5.4, 12, 'd').L).toBe(12);
    const id = modelId('Testco', 'Taper TX', z.label);
    expect(findModel(id)!.size).toBe(z);
    const m = meshes(tx.file).get(id)!;
    const imp = createImplant([10, 20, 30], [0, 0, -1], z.dia, z.len);
    imp.lib = { id, top: z.top };
    const w = meshWorld(imp, m, platformOf(imp), imp.axis);
    let lowest = Infinity;
    for (let i = 2; i < w.length; i += 3) lowest = Math.min(lowest, w[i]);
    expect(lowest).toBeCloseTo(platformOf(imp)[2] - z.len, 1);
    // the abutment sits on the connection
    imp.abutment = { angle: 0, gingivalHeight: 2, rotation: 0 };
    const ab = implantParts(imp, null).find((p) => p.kind === 'abutment')!;
    expect(ab.center[2] - ab.half).toBeCloseTo(platformOf(imp)[2] + z.top, 3);
  });
});
