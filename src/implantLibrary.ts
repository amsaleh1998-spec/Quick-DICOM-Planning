// Implant libraries: manufacturer implants (built by scripts/make-implant-library.py into
// public/implants). The catalogue (brands -> systems -> sizes with their measured dimensions) is
// small and loaded at start; the meshes of a system are fetched when one of its implants is used.
//
// The whole library can also be downloaded into the browser (Cache Storage, one store per library
// version): the catalogue and the meshes then come from there – instantly, and offline. The
// catalogue carries a library version (`library`); a newer published version is offered as an
// update, downloaded into a new store, and the old store is dropped once the new one is complete.
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
  /** size of the system file (bytes) */
  bytes?: number;
  sizes: LibSize[];
}
export interface LibBrand {
  name: string;
  systems: LibSystem[];
}
export interface ImplantIndex {
  /** library version: goes up with every update of the library */
  library?: number;
  brands: LibBrand[];
}
/** The library as downloaded into this browser. */
export interface DownloadedLibrary {
  library: number;
  bytes: number;
  systems: number;
  /** ISO date of the download */
  date: string;
}
/** What a catalogue holds. */
export interface LibrarySummary {
  library: number;
  bytes: number;
  systems: number;
  brands: number;
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

// ---- downloaded library (Cache Storage) -------------------------------------------------------

const STORE_PREFIX = 'qdp-implant-library-v';
/** Written last into a store: a store without it is an unfinished download. */
const META_URL = './implants/__downloaded.json';
const hasCaches = () => typeof caches !== 'undefined';
const abs = (u: string) => new URL(u, location.href).href;

/** The downloaded library in use (null: loaded from the server as needed). */
let local: { meta: DownloadedLibrary; store: string } | null = null;

export function summarize(ix: ImplantIndex): LibrarySummary {
  let bytes = 0, systems = 0;
  for (const b of ix.brands)
    for (const s of b.systems) {
      bytes += s.bytes ?? 0;
      systems++;
    }
  return { library: ix.library ?? 1, bytes, systems, brands: ix.brands.length };
}

/** The newest complete download in this browser. */
async function findDownload(): Promise<{ meta: DownloadedLibrary; store: string } | null> {
  if (!hasCaches()) return null;
  const names = (await caches.keys()).filter((n) => n.startsWith(STORE_PREFIX));
  names.sort((a, b) => Number(b.slice(STORE_PREFIX.length)) - Number(a.slice(STORE_PREFIX.length)));
  for (const store of names) {
    const r = await caches.match(abs(META_URL), { cacheName: store });
    if (r) return { meta: (await r.json()) as DownloadedLibrary, store };
  }
  return null;
}

export function downloadedLibrary(): DownloadedLibrary | null {
  return local?.meta ?? null;
}

/** The library published on the server now (null when it cannot be reached). */
export async function publishedLibrary(): Promise<LibrarySummary | null> {
  try {
    const r = await fetch(IMPLANT_INDEX_URL, { cache: 'no-cache' });
    return r.ok ? summarize((await r.json()) as ImplantIndex) : null;
  } catch {
    return null;
  }
}

let downloading: AbortController | null = null;

/**
 * Download the published library into this browser (a new store for its version); the older
 * store goes once the new one is complete. `onProgress`: bytes so far and in all.
 */
export async function downloadLibrary(onProgress: (done: number, total: number) => void): Promise<DownloadedLibrary> {
  if (!hasCaches()) throw new Error('This browser cannot keep files for offline use.');
  downloading?.abort();
  const ctl = (downloading = new AbortController());
  try {
    const res = await fetch(IMPLANT_INDEX_URL, { cache: 'no-cache', signal: ctl.signal });
    if (!res.ok) throw new Error(`Implant library not available (${res.status})`);
    const text = await res.text();
    const ix = JSON.parse(text) as ImplantIndex;
    const sum = summarize(ix);
    const store = STORE_PREFIX + sum.library;
    await caches.delete(store); // an unfinished earlier try
    const cache = await caches.open(store);
    const files = ix.brands.flatMap((b) => b.systems);
    let done = 0;
    onProgress(0, sum.bytes);
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const f = files[next++];
        const url = abs(`./implants/${f.file}`);
        const r = await fetch(url, { cache: 'no-cache', signal: ctl.signal });
        if (!r.ok) throw new Error(`Implant library file missing (${f.file}: ${r.status})`);
        await cache.put(url, r);
        done += f.bytes ?? 0;
        onProgress(done, sum.bytes);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    await cache.put(abs(IMPLANT_INDEX_URL), new Response(text, { headers: { 'Content-Type': 'application/json' } }));
    const meta: DownloadedLibrary = { library: sum.library, bytes: sum.bytes, systems: sum.systems, date: new Date().toISOString() };
    await cache.put(abs(META_URL), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    // the new version is complete: drop the others
    for (const n of await caches.keys()) if (n.startsWith(STORE_PREFIX) && n !== store) await caches.delete(n);
    // ask the browser to keep it when space runs low
    void navigator.storage?.persist?.().catch(() => false);
    useIndex(ix);
    local = { meta, store };
    return meta;
  } catch (e) {
    if (ctl.signal.aborted) throw new Error('Download cancelled');
    throw e;
  } finally {
    if (downloading === ctl) downloading = null;
  }
}

/** Stop a download in progress (what was stored so far is dropped on the next try). */
export function cancelDownload() {
  downloading?.abort();
}

/** Remove the downloaded library: it is loaded from the server again as needed. */
export async function removeDownloadedLibrary() {
  local = null; // first: nothing reads from it any more
  if (hasCaches()) for (const n of await caches.keys()) if (n.startsWith(STORE_PREFIX)) await caches.delete(n);
}

/** Switch to another catalogue (an update): meshes of the old one are dropped. */
function useIndex(ix: ImplantIndex) {
  index = ix;
  indexLoading = Promise.resolve(ix);
  meshes.clear();
  systemLoads.clear();
  onMeshesLoaded();
}
/** Called when a system's meshes arrive (the app redraws). */
export let onMeshesLoaded: () => void = () => {};
export function setOnMeshesLoaded(f: () => void) {
  onMeshesLoaded = f;
}

/** The catalogue: the downloaded one when there is one (no network), otherwise the server's. */
export function loadImplantIndex(): Promise<ImplantIndex> {
  indexLoading ??= (async () => {
    const d = await findDownload().catch(() => null);
    if (d) {
      const r = await caches.match(abs(IMPLANT_INDEX_URL), { cacheName: d.store });
      if (r) {
        local = d;
        return (index = (await r.json()) as ImplantIndex);
      }
    }
    const r = await fetch(IMPLANT_INDEX_URL);
    if (!r.ok) throw new Error(`Implant library not available (${r.status})`);
    return (index = (await r.json()) as ImplantIndex);
  })().catch((e) => {
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
/** Systems whose file could not be loaded, and when (retried after a while). */
const failed = new Map<string, number>();
const RETRY_MS = 15_000;

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
    const url = `./implants/${system.file}`;
    p = (async () => {
      // the downloaded copy, else the server
      // (match with cacheName only looks: it never creates a store that was just removed)
      const hit = local ? await caches.match(abs(url), { cacheName: local.store }) : undefined;
      const r = hit ?? (await fetch(url));
      if (!r.ok) throw new Error(`Implant library file missing (${r.status})`);
      return r.json();
    })()
      .then(unpack)
      .then((buf) => {
        for (const [id, m] of parseSystem(buf)) meshes.set(id, m);
        onMeshesLoaded();
      })
      .catch((e) => {
        systemLoads.delete(system.file);
        failed.set(system.file, performance.now());
        onMeshesLoaded(); // drawn as a generic shape meanwhile
        throw e;
      });
    failed.delete(system.file);
    systemLoads.set(system.file, p);
  }
  return p;
}

/** The mesh of a model if loaded; otherwise starts loading it (and returns null for now). */
export function meshOf(id: string): LibMesh | null {
  const m = meshes.get(id);
  if (m) return m;
  const f = findModel(id);
  if (f && performance.now() - (failed.get(f.system.file) ?? -Infinity) > RETRY_MS) void loadSystem(f.system).catch(() => {});
  return null;
}

/**
 * How a library model is drawn: its mesh, nothing yet ('pending' – the mesh is on its way, a
 * fraction of a second), or a generic shape ('none': not in the catalogue, or its file could not
 * be loaded).
 */
export function libraryShape(id: string): 'mesh' | 'pending' | 'none' {
  if (meshOf(id)) return 'mesh';
  const f = findModel(id);
  if (!f) return 'none';
  return performance.now() - (failed.get(f.system.file) ?? -Infinity) > RETRY_MS ? 'pending' : 'none';
}

/** Start loading these systems' meshes in the background (switching between them is then instant). */
export function preloadSystems(systems: LibSystem[]) {
  void (async () => {
    for (const s of systems) await loadSystem(s).catch(() => {});
  })();
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
 * The size of a system nearest to a nominal diameter and length (as the manufacturer names them).
 * `change`: the dimension being chosen, `from`: the current size. Changing the length keeps the
 * diameter and platform line (NC / RC …) when the system has that length for them; changing the
 * diameter keeps the length when it can.
 */
export function nearestSize(system: LibSystem, d: number, L: number, change: 'd' | 'L' | null = null, from?: LibSize): LibSize {
  let pool = system.sizes;
  if (change === 'L') {
    const same = pool.filter((s) => s.d === (from?.d ?? d) && (!from || s.prefix === from.prefix));
    if (same.length) pool = same;
  } else if (change === 'd') {
    const same = pool.filter((s) => s.L === (from?.L ?? L));
    if (same.length) pool = same;
  }
  const [wd, wl] = change === 'd' ? [1, 0.05] : change === 'L' ? [0.05, 1] : [3, 1];
  let best = pool[0];
  let bs = Infinity;
  for (const s of pool) {
    const sc = Math.abs(s.d - d) * wd + Math.abs(s.L - L) * wl;
    if (sc < bs) [bs, best] = [sc, s];
  }
  return best;
}
