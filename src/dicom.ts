import * as dicomParser from 'dicom-parser';
import type { DataSet } from 'dicom-parser';
import { Vec3, cross, dot, normalize } from './math';
import { Volume, VolumeInfo } from './volume';

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

function parseFile(name: string, buffer: ArrayBuffer): Slice[] {
  const bytes = new Uint8Array(buffer);
  let ds: DataSet;
  try {
    ds = dicomParser.parseDicom(bytes);
  } catch {
    // Some exports have no preamble/meta header – try raw implicit little endian.
    try {
      ds = dicomParser.parseDicom(bytes, { TransferSyntaxUID: '1.2.840.10008.1.2' });
    } catch {
      return [];
    }
  }
  const pixelEl = ds.elements.x7fe00010;
  if (!pixelEl) return [];
  const ts = str(ds, 'x00020010') ?? '1.2.840.10008.1.2';
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
    seriesDescription: str(ds, 'x0008103e'),
    studyDate: str(ds, 'x00080020'),
    modality: str(ds, 'x00080060'),
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
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.size < 132 && !/\.dcm$/i.test(f.name)) continue;
    try {
      const buf = await f.arrayBuffer();
      slices.push(...parseFile(f.name, buf));
    } catch (e) {
      compressedError = e as Error;
    }
    if (i % 20 === 0) {
      progress('Reading files', i / files.length);
      await tick();
    }
  }
  if (!slices.length) {
    throw compressedError ?? new Error('No DICOM images found in the selected files.');
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
  const info = { ...ref.info, source: `${series.length} slices${step > 1 ? ` (downsampled ×${step})` : ''}` };
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
