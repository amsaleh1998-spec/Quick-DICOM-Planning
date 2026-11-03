import * as dicomParser from 'dicom-parser';
import type { DataSet } from 'dicom-parser';
import { Vec3, cross, dot, normalize } from './math';
import { Volume, VolumeInfo } from './volume';
import { extractMeta } from './dicomMeta';

const UNCOMPRESSED = new Set([
  '1.2.840.10008.1.2', // implicit VR little endian
  '1.2.840.10008.1.2.1', // explicit VR little endian
  '1.2.840.10008.1.2.2', // explicit VR big endian (retired)
]);

const MAX_VOXELS = 260_000_000;

interface Slice {
  seriesUid: string;
  position: Vec3 | null;
  instance: number;
  rows: number;
  cols: number;
  pixels: Float32Array | null;
  // decode lazily from the file buffer to keep memory down
  decode: () => Float32Array;
  rowDir: Vec3;
  colDir: Vec3;
  pixelSpacing: [number, number]; // [between rows (y), between columns (x)]
  sliceThickness: number;
  spacingBetween: number;
  info: VolumeInfo;
  /** parsed data set (for the metadata viewer) */
  ds: DataSet;
}

function str(ds: DataSet, tag: string): string | undefined {
  try {
    return ds.string(tag)?.trim();
  } catch {
    return undefined;
  }
}

function floats(ds: DataSet | undefined, tag: string): number[] | undefined {
  if (!ds) return undefined;
  const s = str(ds, tag);
  if (!s) return undefined;
  const v = s.split('\\').map(Number);
  return v.every((x) => Number.isFinite(x)) ? v : undefined;
}

function firstItem(ds: DataSet | undefined, tag: string): DataSet | undefined {
  return ds?.elements[tag]?.items?.[0]?.dataSet;
}

/** Find a tag either at top level or inside the (shared) functional group sequences. */
function lookupFloats(ds: DataSet, tag: string, groupSeqs: string[]): number[] | undefined {
  const direct = floats(ds, tag);
  if (direct) return direct;
  const shared = firstItem(ds, 'x52009229');
  for (const g of groupSeqs) {
    const v = floats(firstItem(shared, g), tag);
    if (v) return v;
  }
  const perFrame = firstItem(ds, 'x52009230');
  for (const g of groupSeqs) {
    const v = floats(firstItem(perFrame, g), tag);
    if (v) return v;
  }
  return undefined;
}

const IMPLICIT_LE = '1.2.840.10008.1.2';
const EXPLICIT_LE = '1.2.840.10008.1.2.1';
const EXPLICIT_BE = '1.2.840.10008.1.2.2';
const VRS = new Set(
  'AE AS AT CS DA DS DT FD FL IS LO LT OB OD OF OL OV OW PN SH SL SQ SS ST SV TM UC UI UL UN UR US UT UV'.split(' '),
);

/** Files that are certainly not DICOM (macOS metadata, thumbnails …) – skipped without parsing. */
export function isIgnorableFile(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  return base.startsWith('._') || base === '.DS_Store' || base === 'Thumbs.db' || /\.(jpe?g|png|gif|bmp|txt|xml|html?|pdf|exe|dll|ini|inf|db|js|css|json|zip|qdp)$/i.test(base);
}

const hasPart10Prefix = (b: Uint8Array) => b.length > 132 && b[128] === 0x44 && b[129] === 0x49 && b[130] === 0x43 && b[131] === 0x4d; // "DICM"

/**
 * Guess the encoding of a "raw" DICOM file (no 128-byte preamble / DICM marker,
 * as written by many scanners, often without a file extension). A DICOM data
 * set starts with a small, even group number (0000–0028); explicit-VR files
 * carry a two-letter VR code in bytes 4–5.
 */
function sniffRawSyntax(b: Uint8Array): string | null {
  if (b.length < 16) return null;
  const groupLE = b[0] | (b[1] << 8);
  const groupBE = (b[0] << 8) | b[1];
  const plausible = (g: number) => g <= 0x0028 && g % 2 === 0;
  const vr = String.fromCharCode(b[4], b[5]);
  if (VRS.has(vr)) {
    if (plausible(groupLE)) return EXPLICIT_LE;
    if (plausible(groupBE)) return EXPLICIT_BE;
  }
  return plausible(groupLE) ? IMPLICIT_LE : null;
}

/** Parse a DICOM file with or without the Part 10 header; returns data set + transfer syntax. */
function parseAny(bytes: Uint8Array): { ds: DataSet; ts: string } | null {
  if (hasPart10Prefix(bytes)) {
    try {
      const ds = dicomParser.parseDicom(bytes);
      return { ds, ts: str(ds, 'x00020010') ?? IMPLICIT_LE };
    } catch {
      // fall through: try the data set after the header as a raw stream
    }
  }
  const sniffed = sniffRawSyntax(bytes);
  if (!sniffed) return null;
  // try the sniffed syntax first, then the other little-endian flavour
  const order = sniffed === IMPLICIT_LE ? [IMPLICIT_LE, EXPLICIT_LE] : [sniffed, IMPLICIT_LE];
  for (const ts of order) {
    try {
      const ds = dicomParser.parseDicom(bytes, { TransferSyntaxUID: ts });
      if (ds.elements.x7fe00010 || ds.elements.x00280010) return { ds, ts };
    } catch {
      /* try next */
    }
  }
  return null;
}

function parseFile(name: string, buffer: ArrayBuffer): Slice[] {
  const bytes = new Uint8Array(buffer);
  const parsed = parseAny(bytes);
  if (!parsed) return [];
  const { ds } = parsed;
  const pixelEl = ds.elements.x7fe00010;
  if (!pixelEl) return [];
  const ts = parsed.ts;
  if (!UNCOMPRESSED.has(ts) || pixelEl.encapsulatedPixelData) {
    throw new Error(
      `"${name}" uses a compressed transfer syntax (${ts}). Only uncompressed DICOM is supported – export uncompressed or convert (e.g. "gdcmconv --raw").`,
    );
  }
  const rows = ds.uint16('x00280010') ?? 0;
  const cols = ds.uint16('x00280011') ?? 0;
  if (!rows || !cols) return [];
  const bits = ds.uint16('x00280100') ?? 16;
  const signed = (ds.uint16('x00280103') ?? 0) === 1;
  const spp = ds.uint16('x00280002') ?? 1;
  if (spp !== 1) return []; // colour images (e.g. screenshots) are skipped
  const frames = parseInt(str(ds, 'x00280008') ?? '1', 10) || 1;
  const photometric = str(ds, 'x00280004') ?? 'MONOCHROME2';
  const invert = photometric === 'MONOCHROME1';

  const rescale = lookupFloats(ds, 'x00281053', ['x00289145']);
  const intercept = lookupFloats(ds, 'x00281052', ['x00289145']);
  const slope = rescale?.[0] ?? 1;
  const inter = intercept?.[0] ?? 0;
  const spacing = lookupFloats(ds, 'x00280030', ['x00289110']) ?? [1, 1];
  const thickness = lookupFloats(ds, 'x00180050', ['x00289110'])?.[0] ?? 0;
  const between = lookupFloats(ds, 'x00180088', ['x00289110'])?.[0] ?? 0;
  const orient = lookupFloats(ds, 'x00200037', ['x00209116']) ?? [1, 0, 0, 0, 1, 0];
  const rowDir = normalize([orient[0], orient[1], orient[2]]);
  const colDir = normalize([orient[3], orient[4], orient[5]]);
  const wc = floats(ds, 'x00281050')?.[0];
  const ww = floats(ds, 'x00281051')?.[0];

  const info: VolumeInfo = {
    source: name,
    patientName: str(ds, 'x00100010'),
    patientId: str(ds, 'x00100020'),
    birthDate: str(ds, 'x00100030'),
    sex: str(ds, 'x00100040'),
    seriesDescription: str(ds, 'x0008103e'),
    studyDate: str(ds, 'x00080020'),
    modality: str(ds, 'x00080060'),
    institution: str(ds, 'x00080080'),
    manufacturer: str(ds, 'x00080070'),
    model: str(ds, 'x00081090'),
    defaultWindow: wc !== undefined && ww !== undefined && ww > 1 ? { center: wc, width: ww } : undefined,
  };

  const seriesUid = (str(ds, 'x0020000e') ?? 'unknown') + (frames > 1 ? `#${name}` : '');
  const instance = parseInt(str(ds, 'x00200013') ?? '0', 10) || 0;
  const bigEndian = ts === '1.2.840.10008.1.2.2';
  const frameBytes = rows * cols * (bits / 8);
  const perFrameSeq = ds.elements.x52009230?.items;
  const topPos = floats(ds, 'x00200032');

  const out: Slice[] = [];
  for (let f = 0; f < frames; f++) {
    let position: Vec3 | null = null;
    const pf = perFrameSeq?.[f]?.dataSet;
    const pfPos = floats(firstItem(pf, 'x00209113'), 'x00200032');
    if (pfPos) position = [pfPos[0], pfPos[1], pfPos[2]];
    else if (topPos && frames === 1) position = [topPos[0], topPos[1], topPos[2]];
    const offset = pixelEl.dataOffset + f * frameBytes;
    const decode = () => {
      const n = rows * cols;
      const res = new Float32Array(n);
      const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, Math.min(frameBytes, bytes.byteLength - offset));
      const le = !bigEndian;
      if (bits === 8) {
        for (let i = 0; i < n; i++) res[i] = signed ? dv.getInt8(i) : dv.getUint8(i);
      } else if (bits === 16) {
        for (let i = 0; i < n; i++) res[i] = signed ? dv.getInt16(i * 2, le) : dv.getUint16(i * 2, le);
      } else if (bits === 32) {
        for (let i = 0; i < n; i++) res[i] = signed ? dv.getInt32(i * 4, le) : dv.getUint32(i * 4, le);
      } else {
        throw new Error(`Unsupported BitsAllocated=${bits}`);
      }
      for (let i = 0; i < n; i++) {
        const v = res[i] * slope + inter;
        res[i] = invert ? -v : v;
      }
      return res;
    };
    out.push({
      seriesUid,
      position,
      instance: frames > 1 ? f : instance,
      rows,
      cols,
      pixels: null,
      decode,
      rowDir,
      colDir,
      pixelSpacing: [spacing[0], spacing[1] ?? spacing[0]],
      sliceThickness: thickness,
      spacingBetween: between,
      info,
      ds,
    });
  }
  return out;
}

export interface LoadProgress {
  (stage: string, fraction: number): void;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Map a direction to its dominant patient axis: returns [axis index, sign]. */
function dominantAxis(v: Vec3): [number, number] {
  const a = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  const i = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
  return [i, Math.sign(v[i]) || 1];
}

export async function loadDicomFiles(files: File[], progress: LoadProgress): Promise<Volume> {
  const slices: Slice[] = [];
  let compressedError: Error | null = null;
  let ignored = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // Any file name is accepted (many scanners write DICOM files without an extension).
    if (f.size < 64 || isIgnorableFile(f.webkitRelativePath || f.name)) {
      ignored++;
      continue;
    }
    try {
      const buf = await f.arrayBuffer();
      const got = parseFile(f.name, buf);
      if (!got.length) ignored++;
      slices.push(...got);
    } catch (e) {
      compressedError = e as Error;
    }
    if (i % 20 === 0) {
      progress('Reading files', i / files.length);
      await tick();
    }
  }
  if (!slices.length) {
    throw compressedError ?? new Error(`No DICOM images found in the selected files (${files.length} checked).`);
  }

  // Pick the series with the most slices of the most common size.
  const groups = new Map<string, Slice[]>();
  for (const s of slices) {
    const key = `${s.seriesUid}|${s.rows}x${s.cols}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  let series = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (series.length < 2) throw new Error('Need a volume (at least 2 slices); found only single images.');

  const ref = series[0];
  const normal = normalize(cross(ref.rowDir, ref.colDir));
  const hasPos = series.every((s) => s.position);
  if (hasPos) series.sort((a, b) => dot(a.position!, normal) - dot(b.position!, normal));
  else series.sort((a, b) => a.instance - b.instance);

  // Slice spacing from positions (median), falling back to header values.
  let dz = 0;
  if (hasPos) {
    const diffs: number[] = [];
    for (let i = 1; i < series.length; i++) diffs.push(dot(series[i].position!, normal) - dot(series[i - 1].position!, normal));
    diffs.sort((a, b) => a - b);
    dz = diffs[diffs.length >> 1];
    // Drop exact duplicates (same position twice).
    if (diffs.some((d) => Math.abs(d) < 1e-4)) {
      const uniq: Slice[] = [];
      for (const s of series) {
        if (!uniq.length || Math.abs(dot(s.position!, normal) - dot(uniq[uniq.length - 1].position!, normal)) > 1e-4) uniq.push(s);
      }
      series = uniq;
    }
  }
  if (!(dz > 1e-4)) dz = ref.spacingBetween || ref.sliceThickness || 1;

  const cols = ref.cols;
  const rows = ref.rows;
  let ni = cols;
  let nj = rows;
  let nk = series.length;
  let step = 1;
  while ((ni / step) * (nj / step) * (nk / step) > MAX_VOXELS) step++;
  ni = Math.floor(cols / step);
  nj = Math.floor(rows / step);
  nk = Math.floor(series.length / step);

  // Index axes: i along rows (rowDir), j along columns (colDir), k along the normal.
  // Reorder so that the stored volume is axis-aligned with LPS patient axes.
  const dirs: Vec3[] = [ref.rowDir, ref.colDir, normal];
  const map = dirs.map(dominantAxis); // index axis -> [patient axis, sign]
  const used = new Set(map.map((m) => m[0]));
  if (used.size !== 3) {
    // Degenerate/oblique; keep native index order.
    map[0] = [0, 1];
    map[1] = [1, 1];
    map[2] = [2, 1];
  }
  const nativeDims = [ni, nj, nk];
  const nativeSpacing = [ref.pixelSpacing[1] * step, ref.pixelSpacing[0] * step, dz * step];
  const dims: [number, number, number] = [0, 0, 0];
  const spacing: Vec3 = [1, 1, 1];
  for (let a = 0; a < 3; a++) {
    dims[map[a][0]] = nativeDims[a];
    spacing[map[a][0]] = nativeSpacing[a];
  }
  const strides = [1, dims[0], dims[0] * dims[1]];
  // For native index (i,j,k): out = base + i*si + j*sj + k*sk
  let base = 0;
  const st = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const [ax, sign] = map[a];
    st[a] = sign * strides[ax];
    if (sign < 0) base += (dims[ax] - 1) * strides[ax];
  }

  const data = new Int16Array(dims[0] * dims[1] * dims[2]);
  let clipped = false;
  for (let k = 0; k < nk; k++) {
    const sl = series[k * step];
    const px = sl.decode();
    const kOff = base + k * st[2];
    for (let j = 0; j < nj; j++) {
      const jOff = kOff + j * st[1];
      for (let i = 0; i < ni; i++) {
        let v: number;
        if (step === 1) v = px[j * cols + i];
        else {
          // box-average in-plane when downsampling
          let acc = 0;
          for (let b = 0; b < step; b++) for (let a = 0; a < step; a++) acc += px[(j * step + b) * cols + i * step + a];
          v = acc / (step * step);
        }
        v = Math.round(v);
        if (v > 32767) {
          v = 32767;
          clipped = true;
        } else if (v < -32768) {
          v = -32768;
          clipped = true;
        }
        data[jOff + i * st[0]] = v;
      }
    }
    if (k % 8 === 0) {
      progress('Building volume', k / nk);
      await tick();
    }
  }
  if (clipped) console.warn('Some voxel values were clipped to the 16-bit range.');
  let meta: VolumeInfo['meta'];
  try {
    meta = extractMeta(series[0].ds);
  } catch (e) {
    console.warn('Could not read DICOM metadata', e);
  }
  const info = {
    ...ref.info,
    meta,
    source: `${series.length} slices${step > 1 ? ` (downsampled ×${step})` : ''}${ignored ? ` · ${ignored} other file${ignored > 1 ? 's' : ''} ignored` : ''}`,
  };
  return new Volume(dims, spacing, data, info);
}

/** Recursively collect files from a drag & drop DataTransfer (supports folders). */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const e = item.webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (!entries.length) return Array.from(dt.files);
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}
