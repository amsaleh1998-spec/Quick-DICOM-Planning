// The desktop AI service (Windows, installed with public/windows/Install-QDP-AI.cmd): the full
// DentalSegmentator model in the official nnU-Net v2 on this computer, reached at 127.0.0.1 – the
// scan never leaves the computer. This side sends the scan region in nnU-Net's (SimpleITK) axis
// order and turns the labels it gets back into the app's label grid, like the browser engine does.

import type { Vec3 } from '../math';
import { modelAxes } from './dsPlan';

export const SERVICE_URL = 'http://127.0.0.1:47423';
/** nnU-Net's transpose_forward for DentalSegmentator: model axis = SimpleITK axis [1, 0, 2] */
const ITK_TO_MODEL = [1, 0, 2];

export interface ServiceStatus {
  service: 'qdp-ai';
  version: string;
  model: string;
  modelFound: boolean;
  /** 'starting' while the service loads PyTorch and checks the card (e.g. just after login) */
  device: 'cuda' | 'cpu' | 'starting' | string;
  gpu: string | null;
  /** why the graphics card is not used (e.g. a PyTorch build without kernels for it) – then device is 'cpu' */
  gpuError?: string | null;
  torch?: string | null;
  busy: boolean;
  loadError: string | null;
}

/** The service's status, or null when it does not answer (not installed / not running). */
export async function probeService(timeoutMs = 4000): Promise<ServiceStatus | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${SERVICE_URL}/status`, { signal: ac.signal, cache: 'no-store' });
    if (!r.ok) return null;
    const s = (await r.json()) as ServiceStatus;
    return s.service === 'qdp-ai' ? s : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** How the region's world axes map to SimpleITK's array axes (index 0 slowest). */
export function itkLayout(dims: [number, number, number], spacing: Vec3, patientAffine?: number[]) {
  const { ax, sg } = modelAxes(patientAffine);
  // SimpleITK axis t is model axis ITK_TO_MODEL[t]: world axis w[t], reversed when flip[t]
  const w = ITK_TO_MODEL.map((k) => ax[k]) as [number, number, number];
  const flip = ITK_TO_MODEL.map((k) => sg[k] < 0) as [boolean, boolean, boolean];
  const itkDims = w.map((a) => dims[a]) as [number, number, number];
  const itkSpacing = w.map((a) => spacing[a]) as Vec3;
  // offset of world voxel (i, j, k) in the SimpleITK array: strides per world axis
  const itkStride = [itkDims[1] * itkDims[2], itkDims[2], 1];
  const stride = [0, 0, 0], base = [0, 0, 0];
  for (let t = 0; t < 3; t++) {
    stride[w[t]] = flip[t] ? -itkStride[t] : itkStride[t];
    base[w[t]] = flip[t] ? (dims[w[t]] - 1) * itkStride[t] : 0;
  }
  const offset0 = base[0] + base[1] + base[2];
  return { itkDims, itkSpacing, stride, offset0 };
}

/** World-ordered voxels (x fastest) -> SimpleITK-ordered array. */
export function toItk<T extends Int16Array | Uint8Array>(data: T, dims: [number, number, number], L: ReturnType<typeof itkLayout>): T {
  const out = new (data.constructor as { new (n: number): T })(data.length);
  const [nx, ny, nz] = dims;
  const [sx, sy, sz] = L.stride;
  for (let k = 0, o = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      let q = L.offset0 + j * sy + k * sz;
      for (let i = 0; i < nx; i++, o++, q += sx) out[q] = data[o];
    }
  return out;
}

/** SimpleITK-ordered array -> world order (x fastest). */
export function fromItk<T extends Int16Array | Uint8Array>(arr: T, dims: [number, number, number], L: ReturnType<typeof itkLayout>): T {
  const out = new (arr.constructor as { new (n: number): T })(arr.length);
  const [nx, ny, nz] = dims;
  const [sx, sy, sz] = L.stride;
  for (let k = 0, o = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      let q = L.offset0 + j * sy + k * sz;
      for (let i = 0; i < nx; i++, o++, q += sx) out[o] = arr[q];
    }
  return out;
}

export interface LabelGrid {
  nx: number;
  ny: number;
  nz: number;
  gs: Vec3;
}

/**
 * Labels of the region (world order, voxel centres at origin + index × spacing) on the app's label
 * grid: inside the region (and within half a label voxel of `out`, when given – the browser
 * engine's rule) the class of the region voxel – the margin interpolated where the neighbours
 * agree, so surfaces stay smooth –, background elsewhere.
 */
export function regionToLabels(
  cls: Uint8Array,
  margin: Uint8Array,
  dims: [number, number, number],
  spacing: Vec3,
  origin: Vec3,
  label: LabelGrid,
  out?: { lo: Vec3; hi: Vec3 },
  classes = 6,
): { cls: Uint8Array; margin: Uint8Array; counts: number[] } {
  const { nx, ny, nz, gs } = label;
  const n = nx * ny * nz;
  const rc = new Uint8Array(n);
  const rm = new Uint8Array(n).fill(255);
  const counts = new Array(classes).fill(0);
  const lo = [0, 1, 2].map((a) => (out ? out.lo[a] - gs[a] / 2 - 1e-6 : -Infinity));
  const hi = [0, 1, 2].map((a) => (out ? out.hi[a] + gs[a] / 2 + 1e-6 : Infinity));
  // per label-grid axis: the two region voxels around it and the fraction (or outside)
  const axis = (a: number, m: number) => {
    const i0 = new Int32Array(m), i1 = new Int32Array(m), f = new Float32Array(m), ok = new Uint8Array(m);
    for (let i = 0; i < m; i++) {
      const wpos = i * gs[a];
      const u = (wpos - origin[a]) / spacing[a];
      ok[i] = wpos >= lo[a] && wpos <= hi[a] && u >= -0.5 && u <= dims[a] - 0.5 ? 1 : 0;
      const uc = Math.min(dims[a] - 1, Math.max(0, u));
      i0[i] = Math.floor(uc);
      i1[i] = Math.min(dims[a] - 1, i0[i] + 1);
      f[i] = uc - i0[i];
    }
    return { i0, i1, f, ok };
  };
  const X = axis(0, nx), Y = axis(1, ny), Z = axis(2, nz);
  const sy = dims[0], sz = dims[0] * dims[1];
  const c = new Int32Array(8), w = new Float32Array(8);
  for (let k = 0, o = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        if (!(X.ok[i] & Y.ok[j] & Z.ok[k])) {
          counts[0]++;
          continue;
        }
        const fx = X.f[i], fy = Y.f[j], fz = Z.f[k];
        let best = 0, bw = -1, same = true;
        for (let q = 0; q < 8; q++) {
          const xi = q & 1 ? X.i1[i] : X.i0[i], yi = q & 2 ? Y.i1[j] : Y.i0[j], zi = q & 4 ? Z.i1[k] : Z.i0[k];
          c[q] = xi + yi * sy + zi * sz;
          w[q] = (q & 1 ? fx : 1 - fx) * (q & 2 ? fy : 1 - fy) * (q & 4 ? fz : 1 - fz);
          if (w[q] > bw) {
            bw = w[q];
            best = q;
          }
          if (cls[c[q]] !== cls[c[0]]) same = false;
        }
        let l: number, m: number;
        if (same) {
          l = cls[c[0]];
          m = 0;
          for (let q = 0; q < 8; q++) m += margin[c[q]] * w[q];
        } else {
          // classes meet here: the nearest voxel's class; its margin shrinks towards the border
          l = cls[c[best]];
          m = margin[c[best]] * bw;
        }
        rc[o] = l;
        rm[o] = Math.max(1, Math.min(255, Math.round(m)));
        counts[l]++;
      }
  return { cls: rc, margin: rm, counts };
}

export interface ServiceProgress {
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  phase: string;
  done: number;
  total: number;
  message: string;
  seconds: number;
}

/**
 * Run the full model on the service: the region (world order) goes in SimpleITK order, the result
 * comes back in world order (class and margin per region voxel). `signal` cancels it.
 */
export async function segmentOnService(
  data: Int16Array,
  dims: [number, number, number],
  spacing: Vec3,
  patientAffine: number[] | undefined,
  onProgress: (p: ServiceProgress) => void,
  signal: AbortSignal,
): Promise<{ cls: Uint8Array; margin: Uint8Array }> {
  const L = itkLayout(dims, spacing, patientAffine);
  const body = toItk(data, dims, L);
  const r = await fetch(`${SERVICE_URL}/segment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-QDP-Dims': L.itkDims.join(','),
      'X-QDP-Spacing': L.itkSpacing.join(','),
      // (?aimirror=0: without the mirrored passes – for comparing with the browser engine)
      'X-QDP-Mirroring': new URLSearchParams(location.search).get('aimirror') === '0' ? '0' : '1',
    },
    body: body as unknown as BodyInit,
    signal,
  });
  if (!r.ok) throw new Error(`the AI service refused the scan (${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status})`);
  const { job } = (await r.json()) as { job: string };
  const cancel = () => void fetch(`${SERVICE_URL}/jobs/${job}`, { method: 'DELETE' }).catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  for (;;) {
    await new Promise((res) => setTimeout(res, 700));
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const s = (await (await fetch(`${SERVICE_URL}/jobs/${job}`, { cache: 'no-store', signal })).json()) as ServiceProgress;
    onProgress(s);
    if (s.state === 'done') break;
    if (s.state === 'error') throw new Error(s.message || 'the AI service failed');
    if (s.state === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
  }
  signal.removeEventListener('abort', cancel);
  const buf = new Uint8Array(await (await fetch(`${SERVICE_URL}/jobs/${job}/result`, { cache: 'no-store', signal })).arrayBuffer());
  const n = data.length;
  if (buf.length !== 2 * n) throw new Error('the AI service sent an incomplete result');
  return { cls: fromItk(buf.subarray(0, n), dims, L), margin: fromItk(buf.subarray(n), dims, L) };
}
