/// <reference lib="webworker" />
// Runs DentalSegmentator (Dot et al., J Dent 2024; nnU-Net) off the main thread with
// ONNX Runtime Web: WebGPU when the browser offers it, otherwise WebAssembly (CPU).
import type * as OrtNs from 'onnxruntime-web';
import { DS_MODEL } from './dsPlan';
import { DsEngine, EngineInput, nonzeroBox } from './dsEngine';
import { GpuInfo, findGpu, gpuBuffersTooSmall } from './gpu';

type Ort = typeof OrtNs;

export interface StartMsg {
  type: 'start';
  modelBase: string;
  ortBase: string;
  input: EngineInput;
  prefer: 'auto' | 'wasm';
}

export type WorkerMsg =
  | { type: 'progress'; phase: 'download'; done: number; total: number }
  | { type: 'progress'; phase: 'init'; device: string; gpu?: string }
  | { type: 'progress'; phase: 'run'; done: number; total: number; skipped: number; device: string; gpu?: string; msPerTile: number }
  | { type: 'progress'; phase: 'finish' }
  | { type: 'note'; text: string }
  | { type: 'done'; cls: Uint8Array; margin: Uint8Array; counts: number[]; device: string; seconds: number; tiles: number; skipped: number }
  | { type: 'error'; message: string };

interface Manifest {
  version: string;
  graph: { file: string; bytes: number; sha256: string };
  graph2d?: { file: string; bytes: number; sha256: string };
  weights: { externalPath: string; fp16Bytes: number; chunks: { file: string; bytes: number; sha256: string }[] };
}

const post = (m: WorkerMsg, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

async function sha256(buf: ArrayBuffer): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Model file from the browser cache, or downloaded (and checked) once. */
async function modelFile(base: string, cacheName: string, f: { file: string; bytes: number; sha256: string }, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  const url = base + f.file;
  const cache = typeof caches !== 'undefined' ? await caches.open(cacheName).catch(() => null) : null;
  const hit = cache ? await cache.match(url) : undefined;
  if (hit) {
    const buf = await hit.arrayBuffer();
    if (buf.byteLength === f.bytes) {
      onBytes(f.bytes);
      return buf;
    }
  }
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok || !res.body) throw new Error(`Could not download the model (${f.file}: HTTP ${res.status}).`);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    onBytes(value.length);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  if ((await sha256(buf.buffer)) !== f.sha256) throw new Error(`The downloaded model file ${f.file} is damaged – please try again.`);
  if (cache) await cache.put(url, new Response(buf.slice().buffer, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => undefined);
  return buf.buffer;
}

/** fp16 weights -> fp32 */
function widen(parts: ArrayBuffer[]): Uint8Array {
  const T = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 31;
    const m = h & 1023;
    T[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  const n = parts.reduce((a, p) => a + p.byteLength, 0) / 2;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    const h = new Uint16Array(p);
    for (let i = 0; i < h.length; i++) out[o + i] = T[h[i]];
    o += h.length;
  }
  return new Uint8Array(out.buffer);
}

self.onmessage = async (e: MessageEvent<StartMsg>) => {
  if (e.data.type !== 'start') return;
  const { modelBase, ortBase, input, prefer } = e.data;
  try {
    const t0 = performance.now();
    // ---- model --------------------------------------------------------------------
    const man: Manifest = await (await fetch(modelBase + 'manifest.json', { cache: 'no-cache' })).json();
    const cacheName = `qdp-ai-dentalsegmentator-${man.version}`;
    const files = [man.graph, ...(man.graph2d ? [man.graph2d] : []), ...man.weights.chunks];
    const total = files.reduce((a, f) => a + f.bytes, 0);
    let done = 0;
    const onBytes = (n: number) => {
      done += n;
      post({ type: 'progress', phase: 'download', done, total });
    };
    const graph3d = new Uint8Array(await modelFile(modelBase, cacheName, man.graph, onBytes));
    const graph2d = man.graph2d ? new Uint8Array(await modelFile(modelBase, cacheName, man.graph2d, onBytes)) : null;
    const chunks: ArrayBuffer[] = [];
    for (const c of man.weights.chunks) chunks.push(await modelFile(modelBase, cacheName, c, onBytes));
    const weights = widen(chunks);
    chunks.length = 0;

    // ---- runtime ------------------------------------------------------------------
    const ort: Ort = await import(/* @vite-ignore */ ortBase + 'ort.webgpu.min.mjs');
    ort.env.wasm.wasmPaths = ortBase;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4)) : 1;
    ort.env.logLevel = 'error';
    const external = [{ path: man.weights.externalPath, data: weights }];
    let gpu: GpuInfo | null = null;
    const create = async (device: 'webgpu' | 'wasm') => {
      post({ type: 'progress', phase: 'init', device, gpu: device === 'webgpu' ? gpu?.label : undefined });
      return ort.InferenceSession.create(device === 'webgpu' && graph2d ? graph2d : graph3d, {
        executionProviders: [device],
        externalData: external,
        graphOptimizationLevel: 'all',
      });
    };
    let device: 'webgpu' | 'wasm' = 'wasm';
    let session: OrtNs.InferenceSession | null = null;
    if (prefer === 'auto') {
      const found = await findGpu();
      const why = typeof found === 'string' ? found : gpuBuffersTooSmall(found) ? `the graphics card (${found.label}) has too little memory for the model` : null;
      if (why) post({ type: 'note', text: `Running on the CPU (${why}) – this takes much longer than on a graphics card.` });
      else {
        gpu = found as GpuInfo;
        // the adapter we checked (high-performance), not whatever the runtime would pick
        ort.env.webgpu.adapter = gpu.adapter as OrtNs.Env.WebGpuFlags['adapter'];
        ort.env.webgpu.powerPreference = 'high-performance';
        try {
          session = await create('webgpu');
          device = 'webgpu';
        } catch (err) {
          post({ type: 'note', text: `The graphics card could not run the model (${(err as Error).message.slice(0, 160)}) – using the CPU instead.` });
        }
      }
    }
    if (!session) session = await create('wasm');
    if (device === 'wasm' && !self.crossOriginIsolated)
      post({ type: 'note', text: 'Using one CPU core only – reload the app once to let it use all cores.' });

    // ---- sliding window -----------------------------------------------------------
    const box = nonzeroBox(input.data, input.dims, input.spacing, input.roiLo, input.roiHi, input.origin);
    const eng = new DsEngine({ ...input, roiLo: box.lo, roiHi: box.hi });
    if ((input as { debug?: boolean }).debug) {
      let sum = 0;
      for (let i = 0; i < input.data.length; i++) sum += input.data[i];
      post({ type: 'note', text: `debug dims ${input.dims} origin ${input.origin} roi ${input.roiLo.map((v) => v.toFixed(1))}..${input.roiHi.map((v) => v.toFixed(1))} box ${box.lo.map((v) => v.toFixed(1))}..${box.hi.map((v) => v.toFixed(1))} data mean ${(sum / input.data.length).toFixed(1)} grid n ${eng.grid.n} c0 ${eng.grid.c0.map((v) => v.toFixed(2))} steps ${eng.grid.steps.map((s) => s.join('/'))}` });
    }
    const [P0, P1, P2] = DS_MODEL.patch;
    const bufs = [new Float32Array(P0 * P1 * P2), new Float32Array(P0 * P1 * P2)];
    const tiles = eng.tiles;
    let skipped = 0;
    let ran = 0;
    let runMs = 0;
    const run = async (x: Float32Array): Promise<Float32Array> => {
      const feeds = { input: new ort.Tensor('float32', x, [1, 1, P0, P1, P2]) };
      try {
        const r = await session!.run(feeds);
        return r.logits.data as Float32Array;
      } catch (err) {
        if (device !== 'webgpu') throw err;
        // e.g. lost GPU / out of memory: continue on the CPU
        post({ type: 'note', text: `The graphics card failed (${(err as Error).message.slice(0, 160)}) – continuing on the CPU.` });
        await session!.release().catch(() => undefined);
        device = 'wasm';
        session = await create('wasm');
        const r = await session.run(feeds);
        return r.logits.data as Float32Array;
      }
    };
    // fill the next tile while the GPU works on the current one
    let nextUse = eng.fillTile(tiles[0], bufs[0]);
    for (let i = 0; i < tiles.length; i++) {
      const cur = bufs[i & 1];
      const use = nextUse;
      const ts = performance.now();
      const pending = use ? run(cur) : null;
      if (i + 1 < tiles.length) nextUse = eng.fillTile(tiles[i + 1], bufs[(i + 1) & 1]);
      if (pending) {
        const logits = await pending;
        runMs += performance.now() - ts;
        ran++;
        if ((input as { debug?: boolean }).debug) {
          const nv = P0 * P1 * P2;
          const cnt = [0, 0, 0, 0, 0, 0];
          for (let v = 0; v < nv; v++) {
            let b = 0;
            for (let c = 1; c < 6; c++) if (logits[c * nv + v] > logits[b * nv + v]) b = c;
            cnt[b]++;
          }
          let mean = 0;
          for (let v = 0; v < nv; v++) mean += cur[v];
          post({ type: 'note', text: `debug tile ${tiles[i].join(',')}: input mean ${(mean / nv).toFixed(3)} argmax ${cnt.join(' ')} logits[0..3] ${Array.from(logits.slice(0, 3), (x) => x.toFixed(2)).join(' ')} len ${logits.length}` });
        }
        eng.addTile(tiles[i], logits);
      } else {
        skipped++;
        eng.addTile(tiles[i], null);
      }
      post({ type: 'progress', phase: 'run', done: i + 1, total: tiles.length, skipped, device, gpu: device === 'webgpu' ? gpu?.label : undefined, msPerTile: ran ? runMs / ran : 0 });
    }
    post({ type: 'progress', phase: 'finish' });
    const res = eng.finish();
    await session.release().catch(() => undefined);
    post(
      { type: 'done', cls: res.cls, margin: res.margin, counts: res.counts, device, seconds: (performance.now() - t0) / 1000, tiles: tiles.length, skipped },
      [res.cls.buffer, res.margin.buffer],
    );
  } catch (err) {
    post({ type: 'error', message: (err as Error).message || String(err) });
  }
};
