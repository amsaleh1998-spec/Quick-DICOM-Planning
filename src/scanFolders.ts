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
export async function rememberScanFolder(dir: ScanDir): Promise<void> {
  const list = await readList();
  const keep: ScanDir[] = [];
  for (const d of list) {
    try {
      if (await d.isSameEntry(dir)) continue;
      if ((await dir.resolve(d)) !== null) continue; // d lies inside the new folder
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
  for (const root of await readList()) {
    try {
      const path = await root.resolve(file);
      if (!path) continue;
      const permission = (await root.queryPermission?.({ mode: 'read' })) ?? 'granted';
      const hit = { root, path, permission };
      if (permission === 'granted') return hit;
      fallback ??= hit;
    } catch {
      /* folder moved or deleted */
    }
  }
  return fallback;
}

/** The directory that directly contains the file. */
export async function parentOf(hit: { root: ScanDir; path: string[] }): Promise<FileSystemDirectoryHandle> {
  let dir: FileSystemDirectoryHandle = hit.root;
  for (const name of hit.path.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
  return dir;
}
