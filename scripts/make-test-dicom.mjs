// Small synthetic uncompressed DICOM series for testing the loader (also used by the automated
// tests in tests/):
//   node scripts/make-test-dicom.mjs <outDir> [--noext] [--raw | --raw-explicit]
//   --noext         file names without an extension (IM000001 …)
//   --raw           no 128-byte preamble / DICM header, implicit VR little endian
//   --raw-explicit  no preamble / header, explicit VR little endian
// The volume (80 × 70 × 50 voxels, 0.4 × 0.4 × 0.5 mm, slices written in descending order) contains
// a sphere (radius 8 mm, centre 16 / 14 / 12.25 mm from the first voxel) and a bright cube marker
// in the patient's left-anterior-superior corner so orientation can be verified.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TEST_SERIES = { cols: 80, rows: 70, slices: 50, ps: 0.4, dz: 0.5, intercept: -1000, topZ: 100 };

/** The series as files: [{ name, data }] (data: Buffer). */
/**
 * `patient`: the made-up patient written into the files; `uid` / `prefix`: another series (a
 * second patient in the same folder needs its own series UID and file names).
 */
export function makeTestSeries({ noExt = false, raw = null, patient = null, uid = null, prefix = 'IMG', slices: nSlices = 50 } = {}) {
  const pat = { name: 'Test^Loader', id: 'PAT-0042', birth: '19800615', sex: 'F', ...(patient ?? {}) };
  const files = [];
  const cols = 80;
  const rows = 70;
  const slices = nSlices;
  const ps = 0.4; // pixel spacing
  const dz = 0.5; // slice spacing
  const intercept = -1000;
  const seriesUid = uid ?? '1.2.826.0.1.3680043.8.498.1';

  function el(group, elem, vr, value) {
    if (raw === 'implicit' && group !== 0x0002) return elImplicit(group, elem, vr, value);
    let bytes;
    if (typeof value === 'string') {
      let s = value;
      if (s.length % 2) s += vr === 'UI' ? '\0' : ' ';
      bytes = Buffer.from(s, 'latin1');
    } else bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
    const head = Buffer.alloc(long ? 12 : 8);
    head.writeUInt16LE(group, 0);
    head.writeUInt16LE(elem, 2);
    head.write(vr, 4, 'latin1');
    if (long) head.writeUInt32LE(bytes.length, 8);
    else head.writeUInt16LE(bytes.length, 6);
    return Buffer.concat([head, bytes]);
  }
  const us = (v) => new Uint16Array([v]);

  /** Sequence with defined length (items given as encoded data sets). */
  function seq(group, elem, items) {
    const enc = items.map((ds) => {
      const h = Buffer.alloc(8);
      h.writeUInt16LE(0xfffe, 0);
      h.writeUInt16LE(0xe000, 2);
      h.writeUInt32LE(ds.length, 4);
      return Buffer.concat([h, ds]);
    });
    const body = Buffer.concat(enc);
    if (raw === 'implicit') {
      const h = Buffer.alloc(8);
      h.writeUInt16LE(group, 0);
      h.writeUInt16LE(elem, 2);
      h.writeUInt32LE(body.length, 4);
      return Buffer.concat([h, body]);
    }
    const h = Buffer.alloc(12);
    h.writeUInt16LE(group, 0);
    h.writeUInt16LE(elem, 2);
    h.write('SQ', 4, 'latin1');
    h.writeUInt32LE(body.length, 8);
    return Buffer.concat([h, body]);
  }

  function elImplicit(group, elem, vr, value) {
    let bytes;
    if (typeof value === 'string') {
      let s = value;
      if (s.length % 2) s += vr === 'UI' ? '\0' : ' ';
      bytes = Buffer.from(s, 'latin1');
    } else bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const head = Buffer.alloc(8);
    head.writeUInt16LE(group, 0);
    head.writeUInt16LE(elem, 2);
    head.writeUInt32LE(bytes.length, 4);
    return Buffer.concat([head, bytes]);
  }

  for (let k = 0; k < slices; k++) {
    const z = 100 - k * dz; // positions written in descending order
    const px = new Uint16Array(rows * cols);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = i * ps;
        const y = j * ps;
        const zz = (slices - 1 - k) * dz; // height above the lowest slice
        let v = 0; // air (-1000 after rescale)
        if (Math.hypot(x - 16, y - 14, zz - 12.25) < 8) v = 2000;
        // marker: patient left (high x), anterior (low y), superior (high z)
        if (x > 26 && y < 4 && zz > 20) v = 3500;
        px[j * cols + i] = v;
      }
    }
    const meta = Buffer.concat([
      el(0x0002, 0x0001, 'OB', new Uint8Array([0, 1])),
      el(0x0002, 0x0002, 'UI', '1.2.840.10008.5.1.4.1.1.2'),
      el(0x0002, 0x0003, 'UI', `${seriesUid}.${k + 1}`),
      el(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1'),
    ]);
    const groupLen = Buffer.alloc(12);
    groupLen.writeUInt16LE(2, 0);
    groupLen.writeUInt16LE(0, 2);
    groupLen.write('UL', 4, 'latin1');
    groupLen.writeUInt16LE(4, 6);
    groupLen.writeUInt32LE(meta.length, 8);
    const ds = Buffer.concat([
      el(0x0008, 0x0060, 'CS', 'CT'),
      el(0x0008, 0x103e, 'LO', 'Synthetic test series'),
      el(0x0008, 0x0070, 'LO', 'Synthetic Imaging Inc.'),
      el(0x0008, 0x1090, 'LO', 'CBCT-Test 3000'),
      el(0x0009, 0x0010, 'LO', 'PRIVATE CREATOR'),
      el(0x0009, 0x1001, 'LO', 'private value'),
      seq(0x0008, 0x1140, [
        Buffer.concat([el(0x0008, 0x1150, 'UI', '1.2.840.10008.5.1.4.1.1.2'), el(0x0008, 0x1155, 'UI', `${seriesUid}.99`)]),
      ]),
      el(0x0010, 0x0010, 'PN', pat.name),
      el(0x0010, 0x0020, 'LO', pat.id),
      el(0x0010, 0x0030, 'DA', pat.birth),
      el(0x0010, 0x0040, 'CS', pat.sex),
      el(0x0018, 0x0060, 'DS', '90'),
      el(0x0018, 0x0050, 'DS', String(dz)),
      el(0x0020, 0x000e, 'UI', seriesUid),
      el(0x0020, 0x0013, 'IS', String(k + 1)),
      el(0x0020, 0x0032, 'DS', `0\\0\\${z}`),
      el(0x0020, 0x0037, 'DS', '1\\0\\0\\0\\1\\0'),
      el(0x0028, 0x0002, 'US', us(1)),
      el(0x0028, 0x0004, 'CS', 'MONOCHROME2'),
      el(0x0028, 0x0010, 'US', us(rows)),
      el(0x0028, 0x0011, 'US', us(cols)),
      el(0x0028, 0x0030, 'DS', `${ps}\\${ps}`),
      el(0x0028, 0x0100, 'US', us(16)),
      el(0x0028, 0x0101, 'US', us(16)),
      el(0x0028, 0x0102, 'US', us(15)),
      el(0x0028, 0x0103, 'US', us(0)),
      el(0x0028, 0x1052, 'DS', String(intercept)),
      el(0x0028, 0x1053, 'DS', '1'),
      el(0x7fe0, 0x0010, 'OW', px),
    ]);
    const file = raw ? ds : Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), groupLen, meta, ds]);
    // shuffle file names relative to slice order
    const n = String((k * 37) % slices).padStart(4, '0');
    files.push({ name: noExt ? `IM${n}` : `${prefix}${n}.dcm`, data: file });
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const out = args.find((a) => !a.startsWith('--')) ?? 'test-output/dicom';
  const raw = args.includes('--raw') ? 'implicit' : args.includes('--raw-explicit') ? 'explicit' : null;
  const files = makeTestSeries({ noExt: args.includes('--noext'), raw });
  mkdirSync(out, { recursive: true });
  for (const f of files) writeFileSync(join(out, f.name), f.data);
  console.log(`Wrote ${files.length} slices to ${out}`);
}
