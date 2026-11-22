// The files of a folder (and its subfolders), read through the browser's file system handles –
// with progress, a few at a time, and time limits: a folder on a slow, network or sleeping drive
// must not leave the app waiting without end.

type Entry = { kind: 'file' | 'directory'; name: string };
type FileLike = Entry & { kind: 'file'; getFile(): Promise<File> };
export type DirLike = Entry & { kind: 'directory'; values(): AsyncIterable<FileLike | DirLike> };

/** How long one answer of the browser may take (ms). */
export const STEP_LIMIT = 15000;

/** The promise, or a TimeoutError naming `what` when it does not settle in time. */
export function withLimit<T>(p: Promise<T>, what: string, ms = STEP_LIMIT): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(Object.assign(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`), { name: 'TimeoutError' })), ms);
    }),
  ]);
}

/**
 * All files in `dir`, down to `depth` levels of subfolders. `progress(text, fraction)` is told
 * what is going on: first the files found, then the files read.
 */
export async function folderFiles(dir: DirLike, depth: number, progress?: (text: string, f: number) => void): Promise<File[]> {
  // 1. the file handles (listing only – fast)
  const handles: FileLike[] = [];
  let lastShown = 0;
  const walk = async (d: DirLike, level: number) => {
    const it = d.values()[Symbol.asyncIterator]();
    for (;;) {
      const r = await withLimit(it.next(), `Listing the folder “${d.name}”`);
      if (r.done) break;
      const h = r.value;
      if (h.kind === 'file') {
        handles.push(h);
        if (handles.length - lastShown >= 25) {
          lastShown = handles.length;
          progress?.(`Looking through “${dir.name}”… ${handles.length.toLocaleString()} files`, 0);
        }
      } else if (level < depth) await walk(h, level + 1);
    }
  };
  progress?.(`Looking through “${dir.name}”…`, 0);
  await walk(dir, 0);
  // 2. the files, a few at a time
  const out: File[] = new Array(handles.length);
  const BATCH = 16;
  for (let i = 0; i < handles.length; i += BATCH) {
    const part = handles.slice(i, i + BATCH);
    const files = await Promise.all(part.map((h) => withLimit(h.getFile(), `Reading “${h.name}”`)));
    files.forEach((f, k) => (out[i + k] = f));
    progress?.(`Reading files… ${Math.min(i + BATCH, handles.length).toLocaleString()} of ${handles.length.toLocaleString()}`, Math.min(1, (i + BATCH) / handles.length));
  }
  return out;
}
