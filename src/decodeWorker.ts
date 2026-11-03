/// <reference lib="webworker" />
// Decodes compressed DICOM frames off the main thread.
import { CodecKind, FrameMeta, decodeFrame } from './codecs';

interface Job {
  id: number;
  kind: CodecKind;
  bytes: Uint8Array;
  meta: FrameMeta;
}

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, kind, bytes, meta } = e.data;
  try {
    const out = await decodeFrame(kind, bytes, meta);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, out }, [out.buffer]);
  } catch (err) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, error: (err as Error).message || String(err) });
  }
};
