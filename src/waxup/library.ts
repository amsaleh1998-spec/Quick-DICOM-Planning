// Tooth library for the waxup: one closed crown per FDI position (18–28, 48–38), built from a
// generic exocad set by scripts/make-tooth-library.py. Coordinates per jaw: x = patient left,
// y = posterior, z = superior; the jaw's occlusal plane at z = 0, midline x = 0, front y = 0.

import type { Vec2, Vec3 } from '../math';

export type Jaw = 'upper' | 'lower';

export interface ToothTemplate {
  fdi: number;
  jaw: Jaw;
  /** crown centroid (library coordinates) */
  centroid: Vec3;
  /** vertices (library coordinates, absolute) and triangles */
  pos: Float32Array;
  idx: Uint32Array;
  /** tips of the movable parts (cusps / incisal edge), library coordinates */
  parts: Vec3[];
  /** radius (mm) of the region a part moves */
  partRadius: number;
}

export interface ToothLibrary {
  name: string;
  /** arch through the crown centroids, patient right -> left (x, y) */
  arch: Record<Jaw, Vec2[]>;
  teeth: Map<number, ToothTemplate>;
}

export const LIBRARY_URL = './library/teeth-generic.bin';

interface Header {
  format: string;
  name: string;
  quant: number;
  arch: Record<Jaw, Vec2[]>;
  teeth: { fdi: number; jaw: Jaw; centroid: Vec3; nv: number; nt: number; offset: number; parts: Vec3[]; partRadius: number }[];
}

/** Parse the (decompressed) library file. */
export function parseLibrary(buf: ArrayBuffer): ToothLibrary {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'QDPT') throw new Error('Not a tooth library');
  const hlen = dv.getUint32(8, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hlen))) as Header;
  const base = 12 + hlen;
  const teeth = new Map<number, ToothTemplate>();
  for (const t of h.teeth) {
    const q = new Int16Array(buf.slice(base + t.offset, base + t.offset + t.nv * 6));
    const pos = new Float32Array(t.nv * 3);
    for (let i = 0; i < t.nv; i++)
      for (let k = 0; k < 3; k++) pos[i * 3 + k] = q[i * 3 + k] * h.quant + t.centroid[k];
    const ix = new Uint16Array(buf.slice(base + t.offset + t.nv * 6, base + t.offset + t.nv * 6 + t.nt * 6));
    teeth.set(t.fdi, {
      fdi: t.fdi,
      jaw: t.jaw,
      centroid: t.centroid,
      pos,
      idx: Uint32Array.from(ix),
      parts: t.parts.map((p) => [p[0] + t.centroid[0], p[1] + t.centroid[1], p[2] + t.centroid[2]] as Vec3),
      partRadius: t.partRadius,
    });
  }
  return { name: h.name, arch: h.arch, teeth };
}

/** Inflate a zlib (deflate) stream. */
async function inflate(data: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('deflate');
  const out = new Blob([data]).stream().pipeThrough(ds);
  return new Response(out).arrayBuffer();
}

let loading: Promise<ToothLibrary> | null = null;

/** The library, downloaded once (about 1.5 MB). */
export function loadLibrary(): Promise<ToothLibrary> {
  loading ??= fetch(LIBRARY_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`Tooth library not available (${r.status})`);
      return r.arrayBuffer();
    })
    .then(inflate)
    .then(parseLibrary)
    .catch((e) => {
      loading = null;
      throw e;
    });
  return loading;
}

/** Synchronous access once loaded (project restore, tests). */
let loaded: ToothLibrary | null = null;
export function setLoadedLibrary(lib: ToothLibrary) {
  loaded = lib;
}
export function loadedLibrary(): ToothLibrary | null {
  return loaded;
}
export async function ensureLibrary(): Promise<ToothLibrary> {
  if (loaded) return loaded;
  loaded = await loadLibrary();
  return loaded;
}

/** FDI positions of a jaw, patient right -> left. */
export function jawOrder(jaw: Jaw): number[] {
  const [r, l] = jaw === 'upper' ? [1, 2] : [4, 3];
  return [...[8, 7, 6, 5, 4, 3, 2, 1].map((k) => r * 10 + k), ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => l * 10 + k)];
}

export const jawOf = (fdi: number): Jaw => (Math.floor(fdi / 10) <= 2 ? 'upper' : 'lower');

/** The same tooth on the other side (16 <-> 26, 36 <-> 46). */
export function contralateral(fdi: number): number {
  const q = Math.floor(fdi / 10);
  const k = fdi % 10;
  const m: Record<number, number> = { 1: 2, 2: 1, 3: 4, 4: 3 };
  return m[q] * 10 + k;
}
