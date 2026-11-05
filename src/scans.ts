// Intraoral scans (and other surface models: antagonist, wax-up …) placed in the CBCT.

import type { MeshData } from './meshio';
import { vertexNormals } from './meshio';
import { Affine, invert } from './register';

export type ScanKind = 'upper' | 'lower' | 'antagonist' | 'waxup' | 'other';

export const SCAN_KINDS: { kind: ScanKind; label: string; color: [number, number, number] }[] = [
  { kind: 'upper', label: 'Upper jaw', color: [242, 196, 178] },
  { kind: 'lower', label: 'Lower jaw', color: [178, 210, 242] },
  { kind: 'antagonist', label: 'Antagonist', color: [205, 205, 212] },
  { kind: 'waxup', label: 'Wax-up', color: [250, 226, 140] },
  { kind: 'other', label: 'Other', color: [186, 236, 190] },
];

export type PlacementMethod = 'original' | 'points' | 'surface' | 'copy';

export interface Placement {
  method: PlacementMethod;
  /** copy: name of the scan the alignment was copied from */
  from?: string;
  /** fit quality of a matching (mm / fraction of points within 0.5 mm) */
  rms?: number;
  within05?: number;
  /** target surface used for matching */
  target?: string;
}

export interface Scan {
  id: number;
  name: string;
  kind: ScanKind;
  fileName: string;
  /** mesh in the file's own coordinates */
  mesh: MeshData;
  /** scan -> world (volume mm), 3×4 row-major; null = not placed yet */
  transform: Affine | null;
  placement: Placement | null;
  color: [number, number, number];
  /** use the file's vertex colours (PLY / OBJ) */
  vertexColors: boolean;
  opacity: number;
  visible: boolean;
}

let nextScanId = 1;
export function reserveScanIds(maxId: number) {
  nextScanId = Math.max(nextScanId, maxId + 1);
}

/** Guess the kind from the file name (TRIOS, iTero, Medit … exports usually say upper/lower). */
export function guessKind(name: string): ScanKind {
  const n = name.toLowerCase();
  if (/wax|diag|setup|set-up|prosth|design|crown/.test(n)) return 'waxup';
  if (/antag/.test(n)) return 'antagonist';
  if (/upper|maxill|oberk|\bmx\b|_ok\b|\bok_|superior|\bu[-_ ]?jaw/.test(n)) return 'upper';
  if (/lower|mandib|unterk|\bmd\b|_uk\b|\buk_|inferior|\bl[-_ ]?jaw/.test(n)) return 'lower';
  return 'other';
}

export function createScan(fileName: string, mesh: MeshData, kind = guessKind(fileName)): Scan {
  const k = SCAN_KINDS.find((x) => x.kind === kind)!;
  return {
    id: nextScanId++,
    name: `${k.label}${kind === 'other' ? ` – ${fileName.replace(/\.[^.]+$/, '')}` : ''}`,
    kind,
    fileName,
    mesh,
    transform: null,
    placement: null,
    color: [...k.color],
    vertexColors: !!mesh.col,
    opacity: 1,
    visible: true,
  };
}

/** Scan -> world for the original coordinates: the file is in DICOM patient coordinates (LPS). */
export function originalTransform(patientAffine: Affine | undefined): Affine {
  return patientAffine ? invert(patientAffine) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
}

// ---- world-space cache ---------------------------------------------------------------

interface WorldCache {
  key: string;
  pos: Float32Array;
  nrm: Float32Array;
}
const cache = new WeakMap<Scan, WorldCache>();
const localNormals = new WeakMap<MeshData, Float32Array>();

export function scanNormals(m: MeshData): Float32Array {
  let n = localNormals.get(m);
  if (!n) {
    n = vertexNormals(m.pos, m.idx);
    localNormals.set(m, n);
  }
  return n;
}

/** Vertex positions and normals in world coordinates (cached per transform). */
export function scanWorld(s: Scan): { pos: Float32Array; nrm: Float32Array } | null {
  const T = s.transform;
  if (!T) return null;
  const key = T.join(',');
  const c = cache.get(s);
  if (c && c.key === key) return c;
  const src = s.mesh.pos;
  const srcN = scanNormals(s.mesh);
  const pos = new Float32Array(src.length);
  const nrm = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    pos[i] = T[0] * x + T[1] * y + T[2] * z + T[3];
    pos[i + 1] = T[4] * x + T[5] * y + T[6] * z + T[7];
    pos[i + 2] = T[8] * x + T[9] * y + T[10] * z + T[11];
    const nx = srcN[i], ny = srcN[i + 1], nz = srcN[i + 2];
    nrm[i] = T[0] * nx + T[1] * ny + T[2] * nz;
    nrm[i + 1] = T[4] * nx + T[5] * ny + T[6] * nz;
    nrm[i + 2] = T[8] * nx + T[9] * ny + T[10] * nz;
  }
  const out = { key, pos, nrm };
  cache.set(s, out);
  return out;
}

/** Changes that affect drawing (for view caches). */
export function scansKey(scans: Scan[]): string {
  return JSON.stringify(scans.map((s) => [s.id, s.visible, s.color, s.opacity, s.vertexColors, s.transform]));
}

export function placementLabel(s: Scan): string {
  const p = s.placement;
  if (!p || !s.transform) return 'not placed';
  const fit = p.within05 != null ? ` · ${(p.within05 * 100).toFixed(0)} % within 0.5 mm` : '';
  switch (p.method) {
    case 'original':
      return 'original position';
    case 'copy':
      return `alignment of ${p.from ?? 'another scan'}`;
    case 'points':
      return `matched by points${fit}`;
    default:
      return `matched by surfaces${fit}`;
  }
}
