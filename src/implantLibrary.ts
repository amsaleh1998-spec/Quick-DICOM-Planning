// Implant libraries: manufacturer implants (built by scripts/make-implant-library.py into
// public/implants). The catalogue (brands -> systems -> sizes with their measured dimensions) is
// small and loaded at start; the meshes of a system are fetched when one of its implants is used.
//
// Mesh coordinates: the implant platform at the origin, the axis along z, coronal = +z, the apex at
// z = -len. Parts above the platform (tissue-level collars, ball heads) have z > 0 up to `top`.

import { Vec3, cross, normalize, perpendicular, scale } from './math';

export interface LibSize {
  label: string;
  prefix: string;
  /** nominal diameter / length (from the manufacturer's name) */
  d: number;
  L: number;
  /** measured: platform level in the file, length platform -> apex, widest diameter in bone, apex diameter, connection height */
  zp: number;
  len: number;
  dia: number;
  apex: number;
  top: number;
}
export interface LibSystem {
  name: string;
  file: string;
  sizes: LibSize[];
}
export interface LibBrand {
  name: string;
  systems: LibSystem[];
}
export interface ImplantIndex {
  brands: LibBrand[];
}
export interface LibMesh {
  pos: Float32Array;
  idx: Uint32Array;
}
/** What an implant remembers of its library model. */
export interface ImplantModel {
  /** "Brand / System / label" */
  id: string;
  /** connection height above the platform (where an abutment sits) */
  top: number;
}

export const IMPLANT_INDEX_URL = './implants/index.json';

export const modelId = (brand: string, system: string, label: string) => `${brand} / ${system} / ${label}`;

let index: ImplantIndex | null = null;
let indexLoading: Promise<ImplantIndex> | null = null;
/** Called when a system's meshes arrive (the app redraws). */
export let onMeshesLoaded: () => void = () => {};
export function setOnMeshesLoaded(f: () => void) {
  onMeshesLoaded = f;
}

export function loadImplantIndex(): Promise<ImplantIndex> {
  indexLoading ??= fetch(IMPLANT_INDEX_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`Implant library not available (${r.status})`);
      return r.json() as Promise<ImplantIndex>;
    })
    .then((ix) => (index = ix))
    .catch((e) => {
      indexLoading = null;
      throw e;
    });
  return indexLoading;
}
export function implantIndex(): ImplantIndex | null {
  return index;
}
export function setImplantIndex(ix: ImplantIndex) {
  index = ix;
}

/** Brand, system and size of a model id (catalogue loaded). */
export function findModel(id: string): { brand: LibBrand; system: LibSystem; size: LibSize } | null {
  if (!index) return null;
  for (const brand of index.brands)
    for (const system of brand.systems)
      for (const size of system.sizes) if (modelId(brand.name, system.name, size.label) === id) return { brand, system, size };
  return null;
}

// ---- meshes -----------------------------------------------------------------------------------

const meshes = new Map<string, LibMesh>();
const systemLoads = new Map<string, Promise<void>>();

/** Parse a system file (the decompressed binary) into meshes by model id. */
export function parseSystem(buf: ArrayBuffer): Map<string, LibMesh> {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'QDPI') throw new Error('Not an implant library file');
  const hlen = dv.getUint32(8, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hlen))) as {
    brand: string;
    system: string;
    quant: number;
    sizes: (LibSize & { nv: number; nt: number; offset: number })[];
  };
  const base = 12 + hlen;
  const out = new Map<string, LibMesh>();
  for (const s of h.sizes) {
    const q = new Int16Array(buf.slice(base + s.offset, base + s.offset + s.nv * 6));
    const pos = new Float32Array(s.nv * 3);
    for (let i = 0; i < s.nv * 3; i++) pos[i] = q[i] / h.quant - (i % 3 === 2 ? s.zp : 0);
    const ix = new Uint16Array(buf.slice(base + s.offset + s.nv * 6, base + s.offset + s.nv * 6 + s.nt * 6));
    out.set(modelId(h.brand, h.system, s.label), { pos, idx: Uint32Array.from(ix) });
  }
  return out;
}

async function unpack(f: { format: string; encoding: string; data: string }): Promise<ArrayBuffer> {
  if (f.format !== 'qdp-implant-system') throw new Error('Not an implant library file');
  const bin = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
  const out = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(out).arrayBuffer();
}

/** Fetch the meshes of a system (once). */
export function loadSystem(system: LibSystem): Promise<void> {
  let p = systemLoads.get(system.file);
  if (!p) {
    p = fetch(`./implants/${system.file}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Implant library file missing (${r.status})`);
        return r.json();
      })
      .then(unpack)
      .then((buf) => {
        for (const [id, m] of parseSystem(buf)) meshes.set(id, m);
        onMeshesLoaded();
      })
      .catch((e) => {
        systemLoads.delete(system.file);
        throw e;
      });
    systemLoads.set(system.file, p);
  }
  return p;
}

/** The mesh of a model if loaded; otherwise starts loading it (and returns null for now). */
export function meshOf(id: string): LibMesh | null {
  const m = meshes.get(id);
  if (m) return m;
  const f = findModel(id);
  if (f) void loadSystem(f.system).catch(() => {});
  return null;
}

/** Library mesh -> world for an implant: platform at `platform`, apex along `axis`. */
export function implantFrame(platform: Vec3, axis: Vec3): { o: Vec3; e1: Vec3; e2: Vec3; e3: Vec3 } {
  const e3 = scale(axis, -1);
  const e1 = normalize(perpendicular(e3));
  const e2 = cross(e3, e1);
  return { o: platform, e1, e2, e3 };
}

/** World vertices of a library mesh placed at an implant (cached per implant and pose). */
const worldCache = new WeakMap<object, { key: string; m: LibMesh; pos: Float32Array }>();
export function meshWorld(owner: object, m: LibMesh, platform: Vec3, axis: Vec3): Float32Array {
  const key = `${platform.join(',')}|${axis.join(',')}`;
  const c = worldCache.get(owner);
  if (c && c.key === key && c.m === m) return c.pos;
  const { o, e1, e2, e3 } = implantFrame(platform, axis);
  const p = m.pos;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = o[0] + e1[0] * x + e2[0] * y + e3[0] * z;
    out[i + 1] = o[1] + e1[1] * x + e2[1] * y + e3[1] * z;
    out[i + 2] = o[2] + e1[2] * x + e2[2] * y + e3[2] * z;
  }
  worldCache.set(owner, { key, m, pos: out });
  return out;
}

// ---- sizes -----------------------------------------------------------------------------------

/**
 * The size of a system nearest to a diameter and length (nominal). `change`: the dimension being
 * chosen (matched first; the other stays as close as it can).
 */
export function nearestSize(system: LibSystem, d: number, L: number, change: 'd' | 'L' | null = null): LibSize {
  const [wd, wl] = change === 'd' ? [1, 0.05] : change === 'L' ? [0.05, 1] : [3, 1];
  let best = system.sizes[0];
  let bs = Infinity;
  for (const s of system.sizes) {
    const sc = Math.abs(s.d - d) * wd + Math.abs(s.L - L) * wl;
    if (sc < bs) [bs, best] = [sc, s];
  }
  return best;
}
