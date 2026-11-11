// A small made-up implant library for the tests (the real libraries are private and never in the
// repository): brand "Testco" with a tapered bone-level system ("Taper TX", Ø 3.5–5 × 8–14 mm) and a
// tissue-level one ("Tissue TL", a collar above the platform), in the app's library file format –
// a ZIP with index.json and one deflated QDPI binary per system (see scripts/make-implant-library.py).
//
//   node scripts/make-test-implant-library.mjs [out.qdplib] [--library N]

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const QUANT = 500;
const SEG = 24;

/** A threaded tapered body (platform at z = 0, apex at z = -L) and an optional collar above it. */
function implantMesh(d, L, collar) {
  const rings = [];
  if (collar) {
    rings.push([collar.h, d / 2 + collar.flare - 0.3]);
    rings.push([collar.h * 0.5, d / 2 + collar.flare]);
  }
  rings.push([0, d / 2]);
  const pitch = 0.4;
  for (let z = -pitch, k = 0; z > -L + 0.05; z -= pitch, k++) {
    const t = -z / L;
    const core = d / 2 - 0.6 * t * t;
    rings.push([z, core + (k % 2 ? 0.1 : -0.05)]);
  }
  rings.push([-L, d / 2 - 0.9]);
  const pos = [];
  for (const [z, r] of rings) for (let s = 0; s < SEG; s++) pos.push([r * Math.cos((2 * Math.PI * s) / SEG), r * Math.sin((2 * Math.PI * s) / SEG), z]);
  const top = pos.length;
  pos.push([0, 0, rings[0][0]]);
  const bottom = pos.length;
  pos.push([0, 0, -L]);
  const idx = [];
  for (let i = 0; i + 1 < rings.length; i++)
    for (let s = 0; s < SEG; s++) {
      const a = i * SEG + s, b = i * SEG + ((s + 1) % SEG), c = a + SEG, e = b + SEG;
      idx.push([a, c, b], [b, c, e]);
    }
  const last = (rings.length - 1) * SEG;
  for (let s = 0; s < SEG; s++) {
    idx.push([top, s, (s + 1) % SEG]);
    idx.push([bottom, last + ((s + 1) % SEG), last + s]);
  }
  return { pos, idx };
}

/** What the app needs to know of a size (as scripts/make-implant-library.py measures it). */
function measure(pos, L) {
  const z = pos.map((p) => p[2]);
  const r = pos.map((p) => Math.hypot(p[0], p[1]));
  const zmin = Math.min(...z), zmax = Math.max(...z);
  const zp = Math.min(0, zmax);
  const length = zp - zmin;
  const bone = z.map((v) => v <= zp + 1e-6);
  const dia = 2 * Math.max(...r.filter((_, i) => bone[i]));
  let apex = 2 * Math.max(...r.filter((_, i) => z[i] <= zmin + Math.min(1.5, length * 0.2)));
  const r0 = dia / 2;
  for (let i = 0; i < z.length; i++) {
    if (!bone[i]) continue;
    const t = (zp - z[i]) / Math.max(length, 1e-6);
    if (t > 0.02) apex = Math.max(apex, 2 * ((r[i] - r0 * (1 - t)) / t));
  }
  const round = (v) => Math.round(v * 1000) / 1000;
  return { zp: round(zp), len: round(length), dia: round(dia), apex: round(Math.min(apex, dia)), top: round(zmax - zp) };
}

function systemFile(brand, system, sizes) {
  const blobs = [];
  const meta = [];
  let offset = 0;
  for (const s of sizes) {
    const { pos, idx } = implantMesh(s.d, s.L, s.collar);
    const q = new Int16Array(pos.length * 3);
    pos.forEach((p, i) => p.forEach((v, k) => (q[i * 3 + k] = Math.round(v * QUANT))));
    const ix = new Uint16Array(idx.flat());
    const blob = Buffer.concat([Buffer.from(q.buffer), Buffer.from(ix.buffer)]);
    const label = `${s.d} × ${s.L} mm`;
    meta.push({ label, prefix: '', d: s.d, L: s.L, ...measure(pos, s.L), nv: pos.length, nt: idx.length, offset });
    blobs.push(blob);
    offset += blob.length;
  }
  const header = Buffer.from(JSON.stringify({ format: 'QDPI', brand, system, quant: QUANT, sizes: meta }));
  const head = Buffer.alloc(12);
  head.write('QDPI', 0, 'latin1');
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(header.length, 8);
  const data = deflateSync(Buffer.concat([head, header, ...blobs]));
  return { data, sizes: meta.map(({ nv, nt, offset, ...rest }) => rest) };
}

// ---- a minimal ZIP writer (entries stored) ----
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function zip(entries) {
  const parts = [];
  const dir = [];
  let off = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name);
    const crc = crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(n.length, 26);
    parts.push(loc, n, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE(off, 42);
    dir.push(cen, n);
    off += 30 + n.length + data.length;
  }
  const d = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(d.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, d, end]);
}

/** The test library as a .qdplib file (bytes). */
export function makeTestImplantLibrary({ library = 1 } = {}) {
  const taper = [];
  for (const d of [3.5, 4, 4.5, 5]) for (const L of [8, 10, 12, 14]) taper.push({ d, L });
  const tissue = [8, 10, 12].map((L) => ({ d: 4.1, L, collar: { h: 1.8, flare: 0.4 } }));
  const systems = [
    ['Testco', 'Taper TX', 'systems/testco-taper-tx.qdpi', taper],
    ['Testco', 'Tissue TL', 'systems/testco-tissue-tl.qdpi', tissue],
  ];
  const files = [];
  const brand = { name: 'Testco', systems: [] };
  for (const [b, name, file, sizes] of systems) {
    const s = systemFile(b, name, sizes);
    files.push({ name: file, data: s.data });
    brand.systems.push({ name, file, bytes: s.data.length, sizes: s.sizes });
  }
  const index = { format: 'qdp-implant-library', version: 1, library, quant: QUANT, brands: [brand] };
  return new Uint8Array(zip([{ name: 'index.json', data: Buffer.from(JSON.stringify(index)) }, ...files]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const out = args.find((a) => !a.startsWith('--')) ?? 'test-output/testco-implant-library.qdplib';
  const library = args.includes('--library') ? Number(args[args.indexOf('--library') + 1]) : 1;
  writeFileSync(out, makeTestImplantLibrary({ library }));
  console.log(`Wrote ${out} (library version ${library})`);
}
