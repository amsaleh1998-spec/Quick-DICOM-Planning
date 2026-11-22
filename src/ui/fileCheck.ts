// "Test file access" (Settings): runs, one by one and each with a time limit, the browser calls
// that opening from Recent, double-clicking a scan and the scans folder rely on (the browser's
// file handles and their permissions, kept in its storage) – and shows which one fails or does
// not answer, with the times, ready to copy and send.

import { listRecent } from './recent';
import { withLimit } from '../folderFiles';
import { escapeHtml } from './shell';

type Perm = 'granted' | 'denied' | 'prompt';
type AnyHandle = FileSystemHandle & {
  queryPermission?(o: { mode: 'read' }): Promise<Perm>;
  values?(): AsyncIterable<FileSystemHandle>;
  resolve?(h: FileSystemHandle): Promise<string[] | null>;
  getFile?(): Promise<File>;
};
const LIMIT = 10000;

export function showFileCheck() {
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.innerHTML = `
    <div class="modal file-check" role="dialog" aria-modal="true" aria-labelledby="fc-title">
      <header><h2 id="fc-title">Test file access</h2><button class="modal-close" title="Close (Esc)">×</button></header>
      <p class="muted">Opening from <b>Recent</b>, double-clicking a scan and the <b>scans folder</b> use the browser's file access, which it keeps between visits. This runs those steps one by one, each with a ${LIMIT / 1000} s limit, to see which one does not work. Nothing is changed.</p>
      <ol class="fc-steps"></ol>
      <footer>
        <button class="primary fc-pick">Choose a folder to test…</button>
        <span class="grow"></span>
        <button class="fc-copy">Copy the results</button>
        <button class="fc-close">Close</button>
      </footer>
    </div>`;
  const q = <T extends HTMLElement>(s: string) => m.querySelector<T>(s)!;
  const list = q<HTMLOListElement>('.fc-steps');
  const lines: string[] = [];
  /** Run one step: shown while it runs, then ✓ / ✗ with its time and result. */
  const step = async <T,>(label: string, run: () => Promise<T>, describe: (v: T) => string = (v) => String(v)): Promise<T | undefined> => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="fc-state">…</span> ${escapeHtml(label)} <span class="fc-res muted"></span>`;
    list.append(li);
    const t0 = performance.now();
    try {
      const v = await withLimit(run(), label, LIMIT);
      const ms = Math.round(performance.now() - t0);
      const d = describe(v);
      li.querySelector('.fc-state')!.textContent = '✓';
      li.classList.add('ok');
      li.querySelector('.fc-res')!.textContent = `${d} · ${ms} ms`;
      lines.push(`OK   ${label}: ${d} (${ms} ms)`);
      return v;
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const msg = `${(e as Error).name}: ${(e as Error).message}`;
      li.querySelector('.fc-state')!.textContent = '✗';
      li.classList.add('bad');
      li.querySelector('.fc-res')!.textContent = `${msg} · ${ms} ms`;
      lines.push(`FAIL ${label}: ${msg} (${ms} ms)`);
      return undefined;
    }
  };

  const runBasics = async () => {
    const ua = navigator as Navigator & { userAgentData?: { getHighEntropyValues(k: string[]): Promise<Record<string, string>> } };
    await step(
      'Browser and system',
      async () => {
        const hi = await ua.userAgentData?.getHighEntropyValues(['platform', 'platformVersion', 'fullVersionList']).catch(() => null);
        const brands = (hi?.fullVersionList as unknown as { brand: string; version: string }[] | undefined)?.filter((b) => !/not.?a.?brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`);
        const installed = matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches;
        return `${brands?.join(', ') ?? navigator.userAgent} · ${hi?.platform ?? ''} ${hi?.platformVersion ?? ''} · ${installed ? 'installed app' : 'browser tab'}`;
      },
    );
    const recents = await step('Read the Recent list (browser storage)', () => listRecent(), (l) => `${l.length} item${l.length === 1 ? '' : 's'}`);
    const first = recents?.[0];
    if (first) {
      const h = first.handles[0] as AnyHandle;
      const perm = await step(`Access to Recent “${first.label}”`, async () => (await h.queryPermission?.({ mode: 'read' })) ?? 'no check');
      if (perm === 'granted' && h.kind === 'directory')
        await step(`List Recent “${first.label}”`, async () => firstEntries(h), (n) => `${n} entries seen`);
      if (perm === 'granted' && h.kind === 'file') await step(`Read Recent “${first.label}”`, async () => (await h.getFile!()).size, (s) => `${(s / 1048576).toFixed(1)} MB`);
    }
  };

  const firstEntries = async (dir: AnyHandle, max = 20): Promise<number> => {
    let n = 0;
    const it = dir.values!()[Symbol.asyncIterator]();
    while (n < max) {
      const r = await it.next();
      if (r.done) break;
      n++;
    }
    return n;
  };

  q<HTMLButtonElement>('.fc-pick').onclick = async () => {
    const picker = (window as unknown as { showDirectoryPicker?: (o: unknown) => Promise<AnyHandle> }).showDirectoryPicker;
    if (!picker) {
      lines.push('FAIL showDirectoryPicker: not available in this browser');
      return;
    }
    let dir: AnyHandle;
    try {
      dir = await picker({ id: 'qdp-file-check', mode: 'read' });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') await step('Choose a folder', () => Promise.reject(e));
      return;
    }
    q<HTMLButtonElement>('.fc-pick').disabled = true;
    await step(`Chosen folder “${dir.name}”: access`, async () => (await dir.queryPermission?.({ mode: 'read' })) ?? 'no check');
    await step('List the folder', () => firstEntries(dir), (n) => `${n} entries seen`);
    // a file in it (or in its first subfolders)
    const file = await step('Find a file in it', async () => {
      const find = async (d: AnyHandle, level: number): Promise<AnyHandle | null> => {
        for await (const h of d.values!() as AsyncIterable<AnyHandle>) {
          if (h.kind === 'file') return h;
          if (level < 3) {
            const f = await find(h, level + 1);
            if (f) return f;
          }
        }
        return null;
      };
      const f = await find(dir, 0);
      if (!f) throw new Error('no file in the folder');
      return f;
    }, (f) => f.name);
    if (file) {
      await step('Read the file', async () => (await file.getFile!()).size, (s) => `${(s / 1024).toFixed(0)} kB`);
      await step('Locate the file in the folder', async () => (await dir.resolve!(file)) ?? [], (p) => p.join(' / '));
    }
    // keep the folder's handle in the browser's storage and read it back (as Recent / scans folder do)
    const DB = 'qdp-file-check';
    const open = () =>
      new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const saved = await step('Keep the folder in browser storage', async () => {
      const db = await open();
      await new Promise<void>((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(dir, 'dir');
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      db.close();
      return 'saved';
    });
    if (saved) {
      const back = await step('Read it back', async () => {
        const db = await open();
        const h = await new Promise<AnyHandle>((res, rej) => {
          const r = db.transaction('kv').objectStore('kv').get('dir');
          r.onsuccess = () => res(r.result as AnyHandle);
          r.onerror = () => rej(r.error);
        });
        db.close();
        if (!h) throw new Error('nothing read back');
        return h;
      }, (h) => `“${h.name}”`);
      if (back) {
        await step('Read-back folder: same folder', async () => String(await back.isSameEntry(dir)));
        await step('Read-back folder: access', async () => (await back.queryPermission?.({ mode: 'read' })) ?? 'no check');
        await step('Read-back folder: list', () => firstEntries(back), (n) => `${n} entries seen`);
      }
      indexedDB.deleteDatabase(DB);
    }
    lines.push('done');
  };

  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    m.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  window.addEventListener('keydown', onKey, true);
  q<HTMLButtonElement>('.modal-close').onclick = close;
  q<HTMLButtonElement>('.fc-close').onclick = close;
  q<HTMLButtonElement>('.fc-copy').onclick = async () => {
    const text = `Quick DICOM Planning – file access test (${new Date().toISOString()})\n${lines.join('\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      q('.fc-copy').textContent = 'Copied';
    } catch {
      q('.fc-copy').textContent = 'Could not copy – take a screenshot';
    }
  };
  document.body.append(m);
  void runBasics();
}
