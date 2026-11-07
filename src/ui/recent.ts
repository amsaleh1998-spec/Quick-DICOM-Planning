// Recently opened scans and projects, for one-click reopening (start screen, Open ▾ menu).
// Only possible where the browser gives the app file / folder handles (Chrome, Edge): the
// handles are kept in IndexedDB, and reopening asks for read access again if needed.

type Perm = 'granted' | 'denied' | 'prompt';
interface PermHandle extends FileSystemHandle {
  queryPermission?(o: { mode: 'read' }): Promise<Perm>;
  requestPermission?(o: { mode: 'read' }): Promise<Perm>;
}

export interface RecentEntry {
  id: string;
  /** patient (or file) name */
  label: string;
  /** scan date, kind */
  sub: string;
  kind: 'folder' | 'files' | 'project';
  handles: FileSystemHandle[];
  /** folder: how deep to look for files */
  depth: number;
  when: number;
}

/** What is being opened right now (set before loading, stored once the load succeeded). */
export type RecentSource = Pick<RecentEntry, 'kind' | 'handles' | 'depth'>;

const DB = 'qdp-recent';
const STORE = 'kv';
const KEY = 'list';
const MAX = 8;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listRecent(): Promise<RecentEntry[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as RecentEntry[] | undefined) ?? []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function write(list: RecentEntry[]) {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(list, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* storage unavailable: nothing is remembered */
  }
}

async function sameEntry(a: FileSystemHandle[], b: FileSystemHandle[]): Promise<boolean> {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    try {
      if (!(await a[i].isSameEntry(b[i]))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function addRecent(src: RecentSource, label: string, sub: string): Promise<void> {
  if (!src.handles.length) return;
  const list = await listRecent();
  const keep: RecentEntry[] = [];
  for (const e of list) if (!(e.kind === src.kind && (await sameEntry(e.handles, src.handles)))) keep.push(e);
  const entry: RecentEntry = { ...src, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label, sub, when: Date.now() };
  await write([entry, ...keep].slice(0, MAX));
}

export async function removeRecent(id: string): Promise<void> {
  await write((await listRecent()).filter((e) => e.id !== id));
}

type DirLike = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };
async function filesIn(dir: DirLike, depth: number, level = 0): Promise<File[]> {
  const out: File[] = [];
  for await (const h of dir.values()) {
    if (h.kind === 'file') out.push(await (h as FileSystemFileHandle).getFile());
    else if (level < depth) out.push(...(await filesIn(h as DirLike, depth, level + 1)));
  }
  return out;
}

/** Read access (asks if needed – call from a click) and the files of the entry. */
export async function readRecent(e: RecentEntry): Promise<File[]> {
  for (const h of e.handles as PermHandle[]) {
    let p = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (p !== 'granted') p = (await h.requestPermission?.({ mode: 'read' })) ?? 'denied';
    if (p !== 'granted') throw new Error('Access to the files was not allowed.');
  }
  if (e.kind === 'folder') return filesIn(e.handles[0] as DirLike, e.depth);
  return Promise.all((e.handles as FileSystemFileHandle[]).map((h) => h.getFile()));
}

export function ago(t: number): string {
  const d = (Date.now() - t) / 1000;
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400 * 1.5) return `${Math.round(d / 3600)} h ago`;
  const days = Math.round(d / 86400);
  return days < 14 ? `${days} days ago` : new Date(t).toLocaleDateString();
}
