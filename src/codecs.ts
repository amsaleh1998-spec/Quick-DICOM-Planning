/**
 * Decoders for compressed DICOM pixel data (one frame at a time).
 * Used inside the decode workers (no DOM access) and as a main-thread fallback.
 *
 * - JPEG Lossless (Process 14, incl. SV1)  1.2.840.10008.1.2.4.57 / .70   jpeg-lossless-decoder-js
 * - JPEG Baseline (8 bit)                  1.2.840.10008.1.2.4.50         libjpeg-turbo (WASM)
 * - JPEG-LS (lossless / near-lossless)     1.2.840.10008.1.2.4.80 / .81   CharLS (WASM)
 * - JPEG 2000 (lossless / lossy)           1.2.840.10008.1.2.4.90 / .91   OpenJPEG (WASM)
 * - RLE Lossless                           1.2.840.10008.1.2.5            built in
 *
 * WASM decoders are loaded only when a file needs them.
 */
import { Decoder as LosslessDecoder } from 'jpeg-lossless-decoder-js';

export type CodecKind = 'jpeg-lossless' | 'jpeg-baseline' | 'jpeg-ls' | 'jpeg2000' | 'rle';

export const TRANSFER_SYNTAX_CODECS: Record<string, CodecKind> = {
  '1.2.840.10008.1.2.4.57': 'jpeg-lossless',
  '1.2.840.10008.1.2.4.70': 'jpeg-lossless',
  '1.2.840.10008.1.2.4.50': 'jpeg-baseline',
  '1.2.840.10008.1.2.4.80': 'jpeg-ls',
  '1.2.840.10008.1.2.4.81': 'jpeg-ls',
  '1.2.840.10008.1.2.4.90': 'jpeg2000',
  '1.2.840.10008.1.2.4.91': 'jpeg2000',
  '1.2.840.10008.1.2.5': 'rle',
};

export const CODEC_NAMES: Record<CodecKind, string> = {
  'jpeg-lossless': 'JPEG Lossless',
  'jpeg-baseline': 'JPEG Baseline',
  'jpeg-ls': 'JPEG-LS',
  jpeg2000: 'JPEG 2000',
  rle: 'RLE',
};

export interface FrameMeta {
  rows: number;
  cols: number;
  bitsAllocated: number;
  bitsStored: number;
  /** PixelRepresentation = 1 */
  signed: boolean;
}

/** Decode one compressed frame to stored pixel values (before rescale slope/intercept). */
export async function decodeFrame(kind: CodecKind, bytes: Uint8Array, meta: FrameMeta): Promise<Float32Array> {
  let out: Float32Array;
  switch (kind) {
    case 'rle':
      out = decodeRle(bytes, meta);
      break;
    case 'jpeg-lossless':
      out = decodeJpegLossless(bytes, meta);
      break;
    default:
      out = await decodeWasm(kind, bytes, meta);
  }
  if (out.length < meta.rows * meta.cols) {
    throw new Error(`${CODEC_NAMES[kind]} frame decoded to ${out.length} pixels, expected ${meta.rows * meta.cols}`);
  }
  return out.length === meta.rows * meta.cols ? out : out.subarray(0, meta.rows * meta.cols);
}

/** Unsigned decoder output -> signed values when PixelRepresentation = 1 (two's complement in BitsStored bits). */
function toFloat(src: ArrayLike<number>, n: number, meta: FrameMeta): Float32Array {
  const out = new Float32Array(n);
  if (!meta.signed) {
    for (let i = 0; i < n; i++) out[i] = src[i];
    return out;
  }
  const bits = Math.min(32, meta.bitsStored || meta.bitsAllocated);
  const mod = 2 ** bits;
  const half = mod / 2;
  for (let i = 0; i < n; i++) {
    const v = src[i] % mod;
    out[i] = v >= half ? v - mod : v;
  }
  return out;
}

// ---- JPEG Lossless (pure JS) --------------------------------------------------------

function decodeJpegLossless(bytes: Uint8Array, meta: FrameMeta): Float32Array {
  const dec = new LosslessDecoder();
  const numBytes = meta.bitsAllocated <= 8 ? 1 : 2;
  const data = padBeforeEoi(bytes);
  const res = dec.decode(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength, numBytes) as Uint8Array | Uint16Array;
  return toFloat(res, Math.min(res.length, meta.rows * meta.cols), meta);
}

/**
 * Insert a few zero bytes before the end-of-image marker. Without them the
 * decoder sees the marker while reading the very last pixel and stops one
 * pixel early (the bottom-right pixel stays 0). The padding is never decoded.
 */
function padBeforeEoi(b: Uint8Array): Uint8Array {
  let e = b.length - 2;
  while (e > Math.max(0, b.length - 16) && !(b[e] === 0xff && b[e + 1] === 0xd9)) e--;
  if (!(b[e] === 0xff && b[e + 1] === 0xd9)) e = b.length; // no marker found: just append the padding
  const out = new Uint8Array(b.length + 8);
  out.set(b.subarray(0, e));
  out.set(b.subarray(e), e + 8);
  return out;
}

// ---- RLE Lossless (DICOM PS3.5 Annex G) ------------------------------------------------

function decodeRle(bytes: Uint8Array, meta: FrameMeta): Float32Array {
  const n = meta.rows * meta.cols;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numSegments = dv.getUint32(0, true);
  const bytesPerSample = Math.ceil(meta.bitsAllocated / 8);
  if (numSegments !== bytesPerSample) throw new Error(`RLE: ${numSegments} segments, expected ${bytesPerSample} (colour images are not supported)`);
  const offsets: number[] = [];
  for (let s = 0; s < numSegments; s++) offsets.push(dv.getUint32(4 + 4 * s, true));
  // one byte plane per segment, most significant byte first
  const planes = offsets.map((start, s) => {
    const end = s + 1 < numSegments ? offsets[s + 1] : bytes.byteLength;
    const plane = new Uint8Array(n);
    let i = start;
    let o = 0;
    while (i < end && o < n) {
      const c = (bytes[i++] << 24) >> 24; // signed header byte
      if (c >= 0) {
        const len = Math.min(c + 1, n - o, end - i);
        plane.set(bytes.subarray(i, i + len), o);
        i += c + 1;
        o += len;
      } else if (c !== -128) {
        const len = Math.min(-c + 1, n - o);
        plane.fill(bytes[i++], o, o + len);
        o += len;
      }
    }
    return plane;
  });
  const raw = new Float64Array(n);
  for (let s = 0; s < numSegments; s++) {
    const p = planes[s];
    const mul = 2 ** (8 * (numSegments - 1 - s));
    for (let i = 0; i < n; i++) raw[i] += p[i] * mul;
  }
  return toFloat(raw, n, meta);
}

// ---- WASM decoders (CharLS, OpenJPEG, libjpeg-turbo) ------------------------------------

interface FrameInfo {
  width: number;
  height: number;
  bitsPerSample: number;
  componentCount: number;
  isSigned?: boolean;
}
interface WasmDecoder {
  getEncodedBuffer(len: number): Uint8Array;
  decode(): void;
  getDecodedBuffer(): Uint8Array;
  getFrameInfo(): FrameInfo;
  delete?(): void;
}
type WasmModule = Record<string, new () => WasmDecoder>;

const modules = new Map<CodecKind, Promise<WasmModule>>();

/** Load (once) the emscripten module of a codec, pointing it at its .wasm file. */
function loadModule(kind: CodecKind): Promise<WasmModule> {
  let m = modules.get(kind);
  if (!m) {
    m = (async () => {
      type Factory = (o: { locateFile: (f: string) => string }) => Promise<WasmModule>;
      let factory: Factory;
      let wasmUrl: string;
      if (kind === 'jpeg-ls') {
        factory = (await import('@cornerstonejs/codec-charls/decodewasmjs')).default as Factory;
        wasmUrl = (await import('@cornerstonejs/codec-charls/decodewasm?url')).default;
      } else if (kind === 'jpeg2000') {
        factory = (await import('@cornerstonejs/codec-openjpeg/decodewasmjs')).default as Factory;
        wasmUrl = (await import('@cornerstonejs/codec-openjpeg/decodewasm?url')).default;
      } else {
        factory = (await import('@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs')).default as Factory;
        wasmUrl = (await import('@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasm?url')).default;
      }
      return factory({ locateFile: (f) => (f.endsWith('.wasm') ? wasmUrl : f) });
    })();
    modules.set(kind, m);
  }
  return m;
}

const DECODER_CLASS: Partial<Record<CodecKind, string>> = {
  'jpeg-ls': 'JpegLSDecoder',
  jpeg2000: 'J2KDecoder',
  'jpeg-baseline': 'JPEGDecoder',
};

async function decodeWasm(kind: CodecKind, bytes: Uint8Array, meta: FrameMeta): Promise<Float32Array> {
  const mod = await loadModule(kind);
  const Cls = mod[DECODER_CLASS[kind]!];
  const dec = new Cls();
  try {
    dec.getEncodedBuffer(bytes.length).set(bytes);
    dec.decode();
    const info = dec.getFrameInfo();
    if (info.componentCount !== 1) throw new Error(`${CODEC_NAMES[kind]}: colour images are not supported`);
    const buf = dec.getDecodedBuffer();
    const n = info.width * info.height;
    // copy out of the WASM heap (offsets may be unaligned)
    const copy = buf.slice(0, info.bitsPerSample <= 8 ? n : n * 2);
    if (info.isSigned) {
      // JPEG 2000 carries signedness in the code stream
      const src = info.bitsPerSample <= 8 ? new Int8Array(copy.buffer) : new Int16Array(copy.buffer);
      return Float32Array.from(src);
    }
    // unsigned code stream (JPEG-LS has no sign): reinterpret using the DICOM header
    const src = info.bitsPerSample <= 8 ? copy : new Uint16Array(copy.buffer);
    return toFloat(src, n, meta);
  } finally {
    dec.delete?.();
  }
}
