// Remembered "scan folders" for the installed app.
//
// When a DICOM file is double-clicked in Explorer, the browser hands the app only that one
// file. To load the rest of the series without asking every time, the user grants read access
// to a parent folder once (e.g. D:\CBCT or Downloads). Its handle is kept in IndexedDB; on the
// next launch we check whether the double-clicked file lies inside a remembered folder
// (`resolve`) and, if access is still granted, read the file's own folder directly.

type Perm = 'granted' | 'denied' | 'prompt';
export interface ScanDir extends FileSystemDirectoryHandle {
  queryPermission?(o: { mode: 'read' }): Promise<Perm>;
  requestPermission?(o: { mode: 'read' }): Promise<Perm>;
}

const DB = 'qdp-scan-folders';
const STORE = 'kv';
const KEY = 'folders';
const MAX = 20;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readList(): Promise<ScanDir[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as ScanDir[] | undefined) ?? []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function writeList(list: ScanDir[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(list, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* storage unavailable: the folder simply isn't remembered */
  }
}

export async function scanFolders(): Promise<ScanDir[]> {
  return readList();
}

/** Remember a granted folder (newest first). Folders inside it become redundant and are dropped. */
/** A promise, or `fallback` if it does not settle within `ms` (a stale handle may never answer). */
function orAfter<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return Promise.race([p, new Promise<F>((r) => setTimeout(() => r(fallback), ms))]);
}
const NO_ANSWER = Symbol('no answer');

export async function rememberScanFolder(dir: ScanDir): Promise<void> {
  const list = await readList();
  const keep: ScanDir[] = [];
  for (const d of list) {
    try {
      const same = await orAfter(d.isSameEntry(dir), 2000, NO_ANSWER);
      if (same === NO_ANSWER) continue; // kept from an earlier session and no longer answering: dropped
      if (same) continue;
      const inside = await orAfter(dir.resolve(d), 2000, NO_ANSWER);
      if (inside === NO_ANSWER || inside !== null) continue; // d lies inside the new folder (or is stale)
    } catch {
      /* stale handle: keep it, harmless */
    }
    keep.push(d);
  }
  await writeList([dir, ...keep].slice(0, MAX));
}

export async function forgetScanFolders(): Promise<void> {
  await writeList([]);
}

export interface FolderHit {
  root: ScanDir;
  /** path of the file relative to root, file name last */
  path: string[];
  permission: Perm;
}

/** Find a remembered folder that contains this file. Prefers one with access already granted. */
export async function findScanFolder(file: FileSystemFileHandle): Promise<FolderHit | null> {
  let fallback: FolderHit | null = null;
  const list = await readList();
  const stale: ScanDir[] = [];
  let found: FolderHit | null = null;
  for (const root of list) {
    try {
      // a folder on a drive that is asleep or gone, or kept from before a browser / Windows update,
      // may not answer: skip it after a while (and forget it when it does not answer at all)
      const path = await orAfter(root.resolve(file), 3000, NO_ANSWER);
      if (path === NO_ANSWER) {
        stale.push(root);
        continue;
      }
      if (!path) continue;
      const permission = await orAfter(root.queryPermission?.({ mode: 'read' }) ?? Promise.resolve('granted' as Perm), 3000, NO_ANSWER);
      if (permission === NO_ANSWER) {
        stale.push(root);
        continue;
      }
      const hit = { root, path, permission };
      if (permission === 'granted') {
        found = hit;
        break;
      }
      fallback ??= hit;
    } catch {
      /* folder moved or deleted */
    }
  }
  if (stale.length) {
    console.warn('[scans folder] no answer from', stale.map((s) => s.name), '– forgotten');
    void writeList(list.filter((d) => !stale.includes(d)));
  }
  return found ?? fallback;
}

/** The directory that directly contains the file. */
export async function parentOf(hit: { root: ScanDir; path: string[] }): Promise<FileSystemDirectoryHandle> {
  let dir: FileSystemDirectoryHandle = hit.root;
  for (const name of hit.path.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
  return dir;
}
