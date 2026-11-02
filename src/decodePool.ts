/**
 * Pool of decode workers (one per CPU core, max 8). A CBCT series has hundreds
 * of compressed slices; decoding them in parallel keeps loading fast. Falls
 * back to the main thread where workers cannot be created.
 */
import { CodecKind, FrameMeta, decodeFrame } from './codecs';

type Pending = { resolve: (a: Float32Array) => void; reject: (e: Error) => void };

export class DecodePool {
  private workers: Worker[] = [];
  private busy: number[] = [];
  private pending = new Map<number, Pending & { w: number }>();
  private nextId = 1;
  readonly size: number;

  constructor() {
    const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      try {
        const w = new Worker(new URL('./decodeWorker.ts', import.meta.url), { type: 'module' });
        const idx = this.workers.length;
        w.onmessage = (e: MessageEvent<{ id: number; out?: Float32Array; error?: string }>) => {
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          this.busy[idx]--;
          if (e.data.out) p.resolve(e.data.out);
          else p.reject(new Error(e.data.error ?? 'decode failed'));
        };
        w.onerror = (e) => {
          // fail everything queued on this worker (e.g. the worker script could not load)
          e.preventDefault();
          for (const [id, p] of this.pending) {
            if (p.w !== idx) continue;
            this.pending.delete(id);
            p.reject(new Error(e.message || 'decode worker failed'));
          }
        };
        this.workers.push(w);
        this.busy.push(0);
      } catch {
        break; // no workers here (e.g. opened from file://) – decode on the main thread
      }
    }
    this.size = Math.max(1, this.workers.length);
  }

  /** Decode one frame; `bytes` is transferred to the worker (pass a copy you do not need). */
  decode(kind: CodecKind, bytes: Uint8Array, meta: FrameMeta): Promise<Float32Array> {
    if (!this.workers.length) return decodeFrame(kind, bytes, meta);
    let w = 0;
    for (let i = 1; i < this.workers.length; i++) if (this.busy[i] < this.busy[w]) w = i;
    const id = this.nextId++;
    this.busy[w]++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, w });
      this.workers[w].postMessage({ id, kind, bytes, meta }, [bytes.buffer]);
    });
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
  }
}
