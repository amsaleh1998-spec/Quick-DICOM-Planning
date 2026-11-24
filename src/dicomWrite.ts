// Export the volume as a DICOM series: one CT image file per slice (Part 10, explicit VR little
// endian, 16-bit signed, no compression), in the original patient coordinates – so the series
// lines up with the original scan and with plans exported in DICOM coordinates, also after
// "Apply rotate + crop". Patient and study are kept; the series and every image are new.

import type { Volume } from './volume';

const CT_IMAGE = '1.2.840.10008.5.1.4.1.1.2';
const EXPLICIT_LE = '1.2.840.10008.1.2.1';
/** Implementation class UID of this writer (a UUID-derived UID, 2.25.<128-bit number>). */
const IMPLEMENTATION_UID = '2.25.270128404413125658374017395410383294209';
const LONG_VR = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

/** A new globally unique UID (2.25 + a random 128-bit number). */
export function newUid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return `2.25.${n.toString()}`;
}

/** A decimal string (DS): at most 16 characters. */
function ds(v: number): string {
  if (Object.is(v, -0) || Math.abs(v) < 1e-9) return '0';
  for (let p = 10; p > 0; p--) {
    const s = String(Number(v.toPrecision(p)));
    if (s.length <= 16) return s;
  }
  return String(Math.round(v));
}

class Writer {
  private parts: Uint8Array[] = [];
  length = 0;
  private enc = new TextEncoder();

  private push(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.length;
  }

  private header(group: number, element: number, vr: string, len: number) {
    const long = LONG_VR.has(vr);
    const h = new DataView(new ArrayBuffer(long ? 12 : 8));
    h.setUint16(0, group, true);
    h.setUint16(2, element, true);
    h.setUint8(4, vr.charCodeAt(0));
    h.setUint8(5, vr.charCodeAt(1));
    if (long) h.setUint32(8, len, true);
    else h.setUint16(6, len, true);
    this.push(new Uint8Array(h.buffer));
  }

  /** A text element (padded to an even length: UIs with a NUL, the rest with a space). */
  str(group: number, element: number, vr: string, value: string) {
    let b = this.enc.encode(value);
    if (b.length % 2) {
      const p = new Uint8Array(b.length + 1);
      p.set(b);
      p[b.length] = vr === 'UI' ? 0 : 0x20;
      b = p;
    }
    this.header(group, element, vr, b.length);
    this.push(b);
  }

  us(group: number, element: number, v: number) {
    this.header(group, element, 'US', 2);
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.push(b);
  }

  ul(group: number, element: number, v: number) {
    this.header(group, element, 'UL', 4);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.push(b);
  }

  bytes(group: number, element: number, vr: string, b: Uint8Array) {
    this.header(group, element, vr, b.length);
    this.push(b);
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export interface DicomExportOptions {
  /** Series Description (default: the original one + " (Quick DICOM Planning)") */
  description?: string;
  /** Series Number (default 900) */
  seriesNumber?: number;
}

/** A value of the original series' first file (e.g. "0020,000D"), if it was kept. */
function metaValue(vol: Volume, tag: string): string | undefined {
  const v = vol.info.meta?.find((m) => m.tag === tag)?.value?.trim();
  return v || undefined;
}

/**
 * The volume as DICOM files (one per slice, named IM00001.dcm …). `onProgress` gets 0…1.
 * Without patient coordinates (e.g. the demo), the volume's own coordinates are used.
 */
export async function volumeToDicom(vol: Volume, opts: DicomExportOptions = {}, onProgress?: (f: number) => void): Promise<{ name: string; data: Uint8Array }[]> {
  const { nx, ny, nz, spacing: sp, data, info } = vol;
  const A = info.patientAffine ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  // world -> patient (LPS): p = R·w + t; slice k lies at w = (0, 0, k·dz), rows along x, columns along y
  const rowDir = [A[0], A[4], A[8]], colDir = [A[1], A[5], A[9]], sliceDir = [A[2], A[6], A[10]];
  const t = [A[3], A[7], A[11]];
  const studyUid = metaValue(vol, '0020,000D') ?? newUid();
  // same patient coordinates as the original: same frame of reference
  const frameUid = metaValue(vol, '0020,0052') ?? newUid();
  const seriesUid = newUid();
  const description = (opts.description ?? `${info.seriesDescription?.trim() || 'CBCT'} (Quick DICOM Planning)`).slice(0, 64);
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const da = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
  const tm = `${pad(today.getHours())}${pad(today.getMinutes())}${pad(today.getSeconds())}`;
  const win = info.defaultWindow;
  const orientation = [...rowDir, ...colDir].map(ds).join('\\');
  const pixelSpacing = `${ds(sp[1])}\\${ds(sp[0])}`; // row spacing (between rows = y), column spacing (x)
  const sliceBytes = nx * ny * 2;
  const files: { name: string; data: Uint8Array }[] = [];
  for (let k = 0; k < nz; k++) {
    const sopUid = newUid();
    const pos = [0, 1, 2].map((c) => t[c] + sliceDir[c] * k * sp[2]);
    // the slice location along the slice normal (row × column)
    const n = [rowDir[1] * colDir[2] - rowDir[2] * colDir[1], rowDir[2] * colDir[0] - rowDir[0] * colDir[2], rowDir[0] * colDir[1] - rowDir[1] * colDir[0]];
    const loc = pos[0] * n[0] + pos[1] * n[1] + pos[2] * n[2];

    const w = new Writer();
    w.str(0x0008, 0x0008, 'CS', 'DERIVED\\SECONDARY\\AXIAL');
    w.str(0x0008, 0x0012, 'DA', da);
    w.str(0x0008, 0x0013, 'TM', tm);
    w.str(0x0008, 0x0016, 'UI', CT_IMAGE);
    w.str(0x0008, 0x0018, 'UI', sopUid);
    if (info.studyDate) w.str(0x0008, 0x0020, 'DA', info.studyDate);
    w.str(0x0008, 0x0021, 'DA', da);
    w.str(0x0008, 0x0023, 'DA', da);
    w.str(0x0008, 0x0060, 'CS', (info.modality || 'CT').slice(0, 16));
    if (info.manufacturer) w.str(0x0008, 0x0070, 'LO', info.manufacturer.slice(0, 64));
    if (info.institution) w.str(0x0008, 0x0080, 'LO', info.institution.slice(0, 64));
    w.str(0x0008, 0x103e, 'LO', description);
    if (info.model) w.str(0x0008, 0x1090, 'LO', info.model.slice(0, 64));
    w.str(0x0010, 0x0010, 'PN', info.patientName ?? '');
    w.str(0x0010, 0x0020, 'LO', info.patientId ?? '');
    w.str(0x0010, 0x0030, 'DA', info.birthDate ?? '');
    w.str(0x0010, 0x0040, 'CS', info.sex ?? '');
    w.str(0x0018, 0x0050, 'DS', ds(sp[2]));
    w.str(0x0018, 0x1020, 'LO', 'Quick DICOM Planning');
    w.str(0x0020, 0x000d, 'UI', studyUid);
    w.str(0x0020, 0x000e, 'UI', seriesUid);
    w.str(0x0020, 0x0011, 'IS', String(opts.seriesNumber ?? 900));
    w.str(0x0020, 0x0013, 'IS', String(k + 1));
    w.str(0x0020, 0x0032, 'DS', pos.map(ds).join('\\'));
    w.str(0x0020, 0x0037, 'DS', orientation);
    w.str(0x0020, 0x0052, 'UI', frameUid);
    w.str(0x0020, 0x1041, 'DS', ds(loc));
    w.us(0x0028, 0x0002, 1);
    w.str(0x0028, 0x0004, 'CS', 'MONOCHROME2');
    w.us(0x0028, 0x0010, ny);
    w.us(0x0028, 0x0011, nx);
    w.str(0x0028, 0x0030, 'DS', pixelSpacing);
    w.us(0x0028, 0x0100, 16);
    w.us(0x0028, 0x0101, 16);
    w.us(0x0028, 0x0102, 15);
    w.us(0x0028, 0x0103, 1); // signed
    if (win) {
      w.str(0x0028, 0x1050, 'DS', ds(win.center));
      w.str(0x0028, 0x1051, 'DS', ds(win.width));
    }
    w.str(0x0028, 0x1052, 'DS', '0');
    w.str(0x0028, 0x1053, 'DS', '1');
    w.str(0x0028, 0x1054, 'LO', 'HU');
    // the slice's voxels as 16-bit little endian
    const px = new Uint8Array(sliceBytes);
    const dv = new DataView(px.buffer);
    const off = k * nx * ny;
    for (let i = 0; i < nx * ny; i++) dv.setInt16(i * 2, data[off + i], true);
    w.bytes(0x7fe0, 0x0010, 'OW', px);
    const body = w.concat();

    // file meta information (group 0002), preceded by the 128-byte preamble and "DICM"
    const meta = new Writer();
    meta.bytes(0x0002, 0x0001, 'OB', new Uint8Array([0, 1]));
    meta.str(0x0002, 0x0002, 'UI', CT_IMAGE);
    meta.str(0x0002, 0x0003, 'UI', sopUid);
    meta.str(0x0002, 0x0010, 'UI', EXPLICIT_LE);
    meta.str(0x0002, 0x0012, 'UI', IMPLEMENTATION_UID);
    meta.str(0x0002, 0x0013, 'SH', 'QDP_1');
    const metaBody = meta.concat();
    const groupLen = new Writer();
    groupLen.ul(0x0002, 0x0000, metaBody.length);
    const gl = groupLen.concat();

    const out = new Uint8Array(132 + gl.length + metaBody.length + body.length);
    out.set([0x44, 0x49, 0x43, 0x4d], 128); // "DICM"
    out.set(gl, 132);
    out.set(metaBody, 132 + gl.length);
    out.set(body, 132 + gl.length + metaBody.length);
    files.push({ name: `IM${String(k + 1).padStart(5, '0')}.dcm`, data: out });
    if (k % 16 === 15) {
      onProgress?.((k + 1) / nz);
      await new Promise((r) => setTimeout(r, 0)); // let the page show the progress
    }
  }
  onProgress?.(1);
  return files;
}
