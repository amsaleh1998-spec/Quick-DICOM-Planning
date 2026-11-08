// Implant library: the catalogue built from the manufacturer STLs, a system's meshes, size choice.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ImplantIndex, findModel, meshWorld, modelId, nearestSize, parseSystem, setImplantIndex } from '../../src/implantLibrary';
import { createImplant, implantParts, platformOf } from '../../src/implant';

const index = JSON.parse(readFileSync('public/implants/index.json', 'utf8')) as ImplantIndex;
setImplantIndex(index);
const system = (brand: string, name: string) => index.brands.find((b) => b.name === brand)!.systems.find((s) => s.name === name)!;
function meshes(file: string) {
  const f = JSON.parse(readFileSync(`public/implants/${file}`, 'utf8')) as { data: string };
  const buf = inflateSync(Buffer.from(f.data, 'base64'));
  return parseSystem(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

describe('implant library', () => {
  it('lists brands, systems and sizes with measured dimensions', () => {
    expect(index.brands.length).toBeGreaterThanOrEqual(14);
    const all = index.brands.flatMap((b) => b.systems.flatMap((s) => s.sizes));
    expect(all.length).toBeGreaterThan(1200);
    for (const z of all) {
      expect(z.len).toBeGreaterThan(3);
      expect(z.dia).toBeGreaterThan(1.8);
      expect(z.apex).toBeLessThanOrEqual(z.dia + 1e-9);
      expect(z.top).toBeGreaterThanOrEqual(0);
    }
    // the nominal size is close to the measured one for a common implant
    const blx = system('Straumann', 'BLX SLActive');
    const z = blx.sizes.find((s) => s.d === 4.5 && s.L === 12)!;
    expect(z.len).toBeCloseTo(12, 0);
    expect(z.dia).toBeGreaterThan(4.4);
    expect(z.dia).toBeLessThan(4.8);
    // a tissue-level implant has its connection above the platform
    expect(system('Straumann', 'TLX SP SLA').sizes[0].top).toBeGreaterThan(1.5);
    // registered trademark characters are restored in names
    expect(index.brands.find((b) => b.name === 'Nobel Biocare')!.systems.some((s) => s.name.includes('®'))).toBe(true);
  });

  it('reads a system file: the platform at the origin, the apex down the axis', () => {
    const blx = system('Straumann', 'BLX SLActive');
    const ms = meshes(blx.file);
    expect(ms.size).toBe(blx.sizes.length);
    for (const z of blx.sizes.slice(0, 6)) {
      const m = ms.get(modelId('Straumann', 'BLX SLActive', z.label))!;
      let zmin = Infinity, zmax = -Infinity, r = 0;
      for (let i = 0; i < m.pos.length; i += 3) {
        zmin = Math.min(zmin, m.pos[i + 2]);
        zmax = Math.max(zmax, m.pos[i + 2]);
        if (m.pos[i + 2] <= 0) r = Math.max(r, Math.hypot(m.pos[i], m.pos[i + 1]));
      }
      expect(-zmin).toBeCloseTo(z.len, 1);
      expect(zmax).toBeCloseTo(z.top, 1);
      expect(2 * r).toBeCloseTo(z.dia, 1);
      expect(m.idx.length / 3).toBeLessThanOrEqual(5000);
      expect(Math.max(...m.idx)).toBeLessThan(m.pos.length / 3);
    }
  });

  it('places a mesh at an implant and picks the nearest size', () => {
    const blx = system('Straumann', 'BLX SLActive');
    const z = nearestSize(blx, 4.4, 11.6);
    expect([z.d, z.L]).toEqual([4.5, 12]);
    // changing the length keeps the diameter, and the other way round
    expect(nearestSize(blx, 4.5, 15.5, 'L').d).toBe(4.5);
    expect(nearestSize(blx, 5.4, 12, 'd').L).toBe(12);
    const id = modelId('Straumann', 'BLX SLActive', z.label);
    expect(findModel(id)!.size).toBe(z);
    const m = meshes(blx.file).get(id)!;
    const imp = createImplant([10, 20, 30], [0, 0, -1], z.dia, z.len);
    imp.lib = { id, top: z.top };
    const w = meshWorld(imp, m, platformOf(imp), imp.axis);
    // apex at the far end of the axis from the platform
    let lowest = Infinity;
    for (let i = 2; i < w.length; i += 3) lowest = Math.min(lowest, w[i]);
    expect(lowest).toBeCloseTo(platformOf(imp)[2] - z.len, 1);
    // the abutment sits on the connection
    imp.abutment = { angle: 0, gingivalHeight: 2, rotation: 0 };
    const ab = implantParts(imp, null).find((p) => p.kind === 'abutment')!;
    const base = ab.center[2] - ab.half;
    expect(base).toBeCloseTo(platformOf(imp)[2] + z.top, 3);
  });
});
