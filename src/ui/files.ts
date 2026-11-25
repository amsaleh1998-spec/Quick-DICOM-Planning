// Opening scans and projects: Open menu and pickers, Recent, the start screen, drag & drop,
// files double-clicked in Explorer / Finder (installed app), and saving projects.

import { applyProjectState, buildProject, projectFileName, projectHasWaxup, readProject } from '../project';
import { volumeToDicom } from '../dicomWrite';
import { ensureLibrary } from '../waxup/library';
import { isZipFile, writeZip, zipEntriesAsFiles } from '../zip';
import { findScanFolder, parentOf, rememberScanFolder, type FolderHit, type ScanDir } from '../scanFolders';
import { formatDicomDate, formatPatientName } from '../dicomMeta';
import { filesFromDataTransfer, loadDicomFiles } from '../dicom';
import { choosePatient } from './patientChooser';
import { createPhantom } from '../volume';
import { closePopovers } from './popover';
import { addRecent, ago, clearRecent, handlesFromDrop, listRecent, readRecent, RecentEntry, recentFromHandles, RecentSource, removeRecent } from './recent';
import { DirLike, folderFiles, withLimit } from '../folderFiles';
import { showFileCheck } from './fileCheck';
import { $, app, cancellableWait, escapeHtml, hideLoading, setStatus, showLoading, timed } from './shell';
import { rail, setMode } from './layout';
import type { PanelId } from './rail';
import { HELPER_LOG, OS_MAC, showHelperHelp } from './install';
import { PROJECT_MIME, deliverFile, exportHooks } from './save';
import { showExportStl } from '../exportStl';
import { importScans } from './scansPanel';

/** Load DICOM files, a ZIP of them or a project. Resolves to an error message, or null on success. */
export async function loadFiles(files: File[]): Promise<string | null> {
  if (!files.length) return 'No files received.';
  // an implant library file: imported, the open scan and plan stay
  if (files.length === 1 && /\.qdplib$/i.test(files[0].name)) {
    pendingRecent = null;
    const { importLibraryFile } = await import('./libraryPanel');
    return (await importLibraryFile(files[0])) ? null : 'The implant library was not imported.';
  }
  if (!(await askToSave())) return ((pendingRecent = null), null);
  if (files.length === 1 && (await isZipFile(files[0]))) {
    // a project, or a ZIP of DICOM files (e.g. a whole series handed over by the Windows helper)
    showLoading('Unpacking…', 0);
    let entries: File[] | null = null;
    let zipError = '';
    try {
      entries = await zipEntriesAsFiles(files[0]);
    } catch (e) {
      zipError = (e as Error).message;
      console.error(e);
    }
    if (!entries && !/\.(zip|qdp)$/i.test(files[0].name)) {
      hideLoading();
      const msg = `Could not unpack “${files[0].name}” (${(files[0].size / 1048576).toFixed(1)} MB): ${zipError}`;
      setStatus(msg, true);
      return msg;
    }
    if (!entries || entries.some((f) => f.name === 'project.json')) return openProject(files[0]);
    files = entries;
  }
  try {
    showLoading('Reading files…', 0);
    const vol = await loadDicomFiles(files, (stage, f) => showLoading(`${stage}…`, f), {
      // a folder with several patients: choose one (or sort them into folders first)
      choosePatient: async (patients) => {
        const pick = await choosePatient(patients, { startIn: openedDir ?? undefined });
        if (pick !== null) showLoading('Reading files…', 1);
        return pick;
      },
    });
    app.setVolume(vol);
    setMode(openInPlan() ? 'plan' : 'mpr');
    setStatus(`Loaded ${vol.nx}×${vol.ny}×${vol.nz} voxels from ${vol.info.source}`);
    noteRecent();
    return null;
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      setStatus('Nothing opened.');
      return null;
    }
    console.error(e);
    setStatus((e as Error).message, true);
    return (e as Error).message;
  } finally {
    hideLoading();
    openedDir = null;
  }
}

/** The folder the files being opened come from (where patient folders are created by default). */
let openedDir: FileSystemDirectoryHandle | null = null;

// ---- installed app: open DICOM files from Windows Explorer ------------------------
// The manifest registers .dcm/.dicom/.dic/.ima; Chrome/Edge hand the double-clicked file to
// the app through the launch queue, but never the other files of its folder. So the user
// grants access to a scans folder once (remembered, see scanFolders.ts); after that every
// file double-clicked inside it loads its whole folder straight away.

type DirHandle = { kind: 'directory'; name: string; values(): AsyncIterable<FileHandleLike | DirHandle> };
type FileHandleLike = { kind: 'file'; name: string; getFile(): Promise<File> };

/** The files of a folder, with the progress in the loading box (and time limits). */
function filesFromDirectory(dir: DirHandle, maxDepth = 4): Promise<File[]> {
  return folderFiles(dir as unknown as DirLike, maxDepth, showLoading);
}

let launchHandle: FileSystemFileHandle | null = null;
let launchFile: File | null = null;
let pendingHit: FolderHit | null = null;
const launchBanner = $('launch-banner');
const hideLaunchBanner = () => launchBanner.classList.add('hidden');

/** Load every file in the folder that contains the launched file (that folder only). */
async function loadFolderOf(hit: { root: ScanDir; path: string[] }) {
  hideLaunchBanner();
  try {
    showLoading('Reading folder…', 0);
    const dir = await parentOf(hit);
    pendingRecent = { kind: 'folder', handles: [dir as unknown as FileSystemHandle], depth: 0 };
    const files = await filesFromDirectory(dir as unknown as DirHandle, 0);
    const err = await loadFiles(files.length ? files : launchFile ? [launchFile] : []);
    if (err) showLaunchBanner('error', err);
  } catch (e) {
    showLaunchBanner('error', `${(e as Error).name}: ${(e as Error).message}`);
  } finally {
    hideLoading();
  }
}


function showLaunchBanner(kind: 'setup' | 'allow' | 'error', detail = '') {
  const folderName = detail;
  $('lb-file').textContent = launchFile ? `“${launchFile.name}”` : launchHandle ? `“${launchHandle.name}”` : '';
  $('lb-msg').innerHTML =
    kind === 'error'
      ? `<span class="lb-error">Could not open it: ${escapeHtml(detail)}</span> ` +
        `If you use the ${OS_MAC ? 'Mac' : 'Windows'} helper, please send the text of <b>${HELPER_LOG}</b>. ` +
        'You can still load the folder yourself:'
      : kind === 'setup'
      ? `One-time setup: choose the folder where your scans are saved (e.g. ${OS_MAC ? '<b>Documents/CBCT</b> or <b>Dropbox</b>' : '<b>D:\\CBCT</b> or <b>Documents\\Scans</b>'} – ` +
        'the higher up, the better). From then on, double-clicking a scan anywhere inside it opens the whole series directly.'
      : `Allow access to your scans folder <b>${escapeHtml(folderName)}</b> again to open the series. ` +
        'Choose <b>Allow on every visit</b> if offered, so it opens directly next time.';
  $('lb-folder').textContent = kind === 'allow' ? 'Allow' : kind === 'error' ? 'Choose folder' : 'Choose scans folder';
  launchBanner.dataset.kind = kind;
  if (kind !== 'error') setStatus('');
  launchBanner.classList.remove('hidden');
}

$('lb-folder').onclick = async () => {
  if (launchBanner.dataset.kind === 'allow' && pendingHit) {
    const hit = pendingHit;
    const perm = await hit.root.requestPermission?.({ mode: 'read' });
    if (perm === 'granted') await loadFolderOf(hit);
    else setStatus('Folder access was not allowed.', true);
    return;
  }
  const picker = (window as unknown as { showDirectoryPicker?: (o: unknown) => Promise<ScanDir> }).showDirectoryPicker;
  if (!picker) {
    hideLaunchBanner();
    folderInput.click(); // browsers without the picker: ordinary folder dialog
    return;
  }
  try {
    const dir = await picker({ startIn: launchHandle ?? undefined, id: 'scans-folder', mode: 'read' });
    hideLaunchBanner();
    showLoading(`Opening “${dir.name}”…`, 0);
    // remembered alongside – if the browser's storage does not answer, the scan still opens
    const remembered = withLimit(rememberScanFolder(dir), 'Remembering the scans folder', 8000).then(
      () => true,
      (e) => (console.warn('[scans folder]', e), false),
    );
    let path: string[] | null = null;
    try {
      path = launchHandle ? await withLimit(dir.resolve(launchHandle), 'Finding the scan in the folder', 5000) : null;
    } catch (e) {
      console.warn('[scans folder]', e);
    }
    if (path) {
      await loadFolderOf({ root: dir, path });
      setStatus(
        (await remembered)
          ? `“${dir.name}” remembered – double-clicked scans inside it now open directly.`
          : `Opened – but the browser did not keep “${dir.name}” (Settings → Test file access… shows why).`,
        !(await remembered),
      );
      return;
    }
    // the chosen folder doesn't contain the file: load what was chosen
    hideLaunchBanner();
    showLoading('Reading folder…', 0);
    await loadFiles(await filesFromDirectory(dir as unknown as DirHandle));
  } catch (e) {
    if ((e as Error).name !== 'AbortError') setStatus((e as Error).message, true);
  } finally {
    hideLoading();
  }
};
$('lb-close').onclick = hideLaunchBanner;
$('btn-file-check').onclick = () => {
  closePopovers();
  showFileCheck();
};
$('lb-helper').onclick = () => showHelperHelp();

type LaunchQueue = { setConsumer(cb: (p: { files?: FileSystemFileHandle[] }) => void): void };
const launchQueue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
/** Counts the openings (double-click, Recent): one that was cancelled or overtaken is dropped. */
let openGen = 0;

launchQueue?.setConsumer(async (params) => {
  const handles = params.files ?? [];
  if (!handles.length) return; // ordinary start, no file
  hideLaunchBanner();
  const my = ++openGen;
  const stale = () => my !== openGen;
  launchHandle = handles[0];
  launchFile = null;
  pendingRecent = handles.length <= 2 ? { kind: /\.(zip|qdp)$/i.test(handles[0].name) ? 'project' : 'files', handles, depth: 0 } : null;
  const what = handles.length > 1 ? `${handles.length} files` : `“${handles[0].name}”`;
  console.info('[launch] received', handles.map((h) => h.name));
  const t0 = performance.now();
  const step = (s: string) => console.info(`[launch] ${s} (${Math.round(performance.now() - t0)} ms)`);
  setStatus(`Opening ${what}…`);
  showLoading(`Opening ${what}…`, 0);
  // the browser does not always answer (a file still being written, a drive gone to sleep…): the
  // steps below have time limits, and the wait can be cancelled to reach Recent / Open
  cancellableWait(
    () => {
      openGen++;
      setStatus(`Stopped opening ${what} – open it from Recent or the Open menu.`, true);
    },
    { label: 'Choose the folder…', run: () => void pickAndOpen('folder') },
  );
  try {
    const files = await timed(Promise.all(handles.map((h) => h.getFile())), 15000, 'Reading the file');
    step('file read');
    if (stale()) return;
    launchFile = files[0];
    const bundle = files.length > 1 || /\.(zip|qdp)$/i.test(files[0].name) || (await timed(isZipFile(files[0]), 15000, 'Reading the start of the file'));
    step(bundle ? 'files / ZIP' : 'single file');
    if (stale()) return;
    if (bundle) {
      // several files selected in Explorer, a project, or a whole series bundled by the
      // Windows helper (a ZIP named .dcm): open them as they are, no folder access needed
      cancellableWait(null); // from here on the loading shows its progress
      const err = await loadFiles(files);
      if (err) showLaunchBanner('error', err);
      return;
    }
    let hit: Awaited<ReturnType<typeof findScanFolder>> = null;
    try {
      hit = await timed(findScanFolder(handles[0]), 8000, 'Looking up your scans folders');
    } catch (e) {
      console.warn('[launch]', e); // no remembered folder answered: choose it again
    }
    step(hit ? `in scans folder “${hit.root.name}” (${hit.permission})` : 'not in a remembered scans folder');
    if (stale()) return;
    if (hit?.permission === 'granted') {
      cancellableWait(null);
      await loadFolderOf(hit);
      return;
    }
    pendingHit = hit;
    showLaunchBanner(hit ? 'allow' : 'setup', hit?.root.name);
  } catch (e) {
    if (stale()) return;
    console.error(e);
    const name = (e as Error).name;
    showLaunchBanner(
      'error',
      name === 'SecurityError'
        ? 'the browser does not let web apps read files in this location (system folders such as AppData or the temp folder, or hidden folders whose name starts with a dot in your user folder). If you double-clicked with the Windows / Mac helper, run its latest version once (Install app → helper) – it keeps its files in a permitted folder; otherwise move the scan to a normal folder such as Documents.'
        : name === 'TimeoutError'
          ? `${(e as Error).message} (the file may still be copying, or on a drive that is asleep or disconnected). Try again in a moment.`
          : `${name}: ${(e as Error).message}`,
    );
  } finally {
    if (!stale()) hideLoading();
  }
});

// ---- projects ----------------------------------------------------------------------
export async function openProject(file: File): Promise<string | null> {
  if (!(await askToSave())) return ((pendingRecent = null), null);
  try {
    showLoading('Opening project…', 0.2);
    const buf = await file.arrayBuffer();
    showLoading('Unpacking project…', 0.5);
    const { volume, file: pf, entries } = await readProject(buf);
    if (projectHasWaxup(pf)) {
      showLoading('Loading the tooth library…', 0.8);
      await ensureLibrary();
    }
    showLoading('Restoring views…', 0.9);
    app.setVolume(volume);
    setMode(pf.state.mode, { restoring: true });
    applyProjectState(app, pf, entries);
    // the plan as it was left: the panel that was open (with its implant still selected) – or, in an
    // older project, the implants when one is selected; a plan without a curve starts drawing one
    const panel = pf.state.panel as PanelId | undefined;
    if (panel) rail.select(panel);
    else if (app.mode === 'plan' && app.selectedImplant()) rail.select('implants');
    if (app.mode === 'plan' && !app.curves.length) {
      rail.prefer('curve');
      if (!app.drawing) app.startDrawing();
    }
    setStatus(`Project "${file.name}" restored (saved ${new Date(pf.savedAt).toLocaleString()})`);
    noteRecent();
    return null;
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message, true);
    return (e as Error).message;
  } finally {
    hideLoading();
  }
}

export async function saveProject(): Promise<boolean> {
  if (!app.vol) {
    setStatus('Nothing to save – open a CBCT first.', true);
    return false;
  }
  try {
    showLoading('Packing project…', 0);
    const blob = await buildProject(app, (f) => showLoading('Compressing volume…', f));
    hideLoading();
    const name = projectFileName(app);
    // saved through the browser's save dialog: listed under Recent right away, like an opened project
    const ok = await deliverFile(blob, name, undefined, (h) => {
      void addRecent({ kind: 'project', handles: [h], depth: 0 }, ...recentLabel('project', h.name)).then(() => renderRecent());
    });
    if (ok) app.markSaved();
    setStatus(ok ? `Project saved as ${name} (${(blob.size / 1e6).toFixed(1)} MB)` : 'Save cancelled');
    return ok;
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message, true);
    return false;
  } finally {
    hideLoading();
  }
}

const projectInput = $<HTMLInputElement>('project-input');
$('btn-save-project').onclick = () => saveProject();
$('btn-export-stl').onclick = () => showExportStl(app, exportHooks);
$('btn-export-dicom').onclick = () => {
  closePopovers();
  void exportDicom();
};

/** The volume as a DICOM series, one file per slice, in a ZIP. */
async function exportDicom() {
  const vol = app.vol;
  if (!vol) {
    setStatus('Open a CBCT first.', true);
    return;
  }
  try {
    showLoading('Writing DICOM files…', 0);
    const files = await volumeToDicom(vol, {}, (f) => showLoading('Writing DICOM files…', f * 0.5));
    const base = projectFileName(app).replace(/\.qdp$/, '');
    const blob = await writeZip(
      files.map((f) => ({ name: `${base}_DICOM/${f.name}`, data: f.data })),
      (f) => showLoading('Packing the series…', 0.5 + f * 0.5),
    );
    hideLoading();
    const name = `${base}_DICOM.zip`;
    const ok = await deliverFile(blob, name, { description: 'DICOM series (ZIP)', accept: { 'application/zip': ['.zip'] } });
    setStatus(ok ? `Exported ${files.length} DICOM images (${vol.nx}×${vol.ny}×${vol.nz} voxels) as ${name} (${(blob.size / 1e6).toFixed(1)} MB)` : 'Export cancelled');
  } catch (e) {
    console.error(e);
    setStatus(`DICOM export failed: ${(e as Error).message}`, true);
  } finally {
    hideLoading();
  }
}
$('btn-open-project').onclick = () => void pickAndOpen('project');
projectInput.onchange = () => {
  const f = projectInput.files?.[0];
  if (f) openProject(f);
  projectInput.value = '';
};

const fileInput = $<HTMLInputElement>('file-input');
const folderInput = $<HTMLInputElement>('folder-input');
// "Open scans directly in ② Plan" – on unless turned off (a new key: on again for everyone who
// had it off before it became the default)
const OPEN_PLAN_KEY = 'qdp.openPlan.v2';
function openInPlan(): boolean {
  try {
    return localStorage.getItem(OPEN_PLAN_KEY) !== '0';
  } catch {
    return true;
  }
}
const setOpenPlan = $<HTMLInputElement>('set-open-plan');
setOpenPlan.checked = openInPlan();
setOpenPlan.onchange = () => {
  try {
    localStorage.setItem(OPEN_PLAN_KEY, setOpenPlan.checked ? '1' : '0');
  } catch {
    /* not remembered */
  }
};

// File pickers give handles (Chrome / Edge), so the scan can be listed under Recent; elsewhere
// (or when a picker is not allowed) the ordinary file dialogs are used.
type OpenPicker = (o: unknown) => Promise<FileSystemFileHandle[]>;
type DirPicker = (o: unknown) => Promise<FileSystemDirectoryHandle>;
const pickers = window as unknown as { showOpenFilePicker?: OpenPicker; showDirectoryPicker?: DirPicker };
let pendingRecent: RecentSource | null = null;

/** The load that just succeeded becomes the first Recent entry. */
function noteRecent() {
  const src = pendingRecent;
  pendingRecent = null;
  if (!src || !app.vol) return;
  void addRecent(src, ...recentLabel(src.kind, src.handles[0]?.name)).then(() => renderRecent());
}

/** Name and second line of a Recent entry for the open scan: patient, scan date and kind. */
function recentLabel(kind: RecentSource['kind'], fileName?: string): [string, string] {
  const info = app.vol?.info;
  const name = formatPatientName(info?.patientName ?? '') || info?.seriesDescription?.trim() || fileName || 'Scan';
  const sub = [info?.studyDate ? formatDicomDate(info.studyDate) : '', kind === 'project' ? 'project' : kind === 'folder' ? 'folder' : 'file'].filter(Boolean).join(' · ');
  return [name, sub];
}

export async function pickAndOpen(kind: 'files' | 'folder' | 'project') {
  try {
    if (kind === 'folder') {
      if (!pickers.showDirectoryPicker) return folderInput.click();
      const dir = await pickers.showDirectoryPicker({ id: 'qdp-open', mode: 'read' });
      openedDir = dir;
      showLoading('Reading folder…', 0);
      const files = await filesFromDirectory(dir as unknown as DirHandle, 4);
      pendingRecent = { kind: 'folder', handles: [dir], depth: 4 };
      await loadFiles(files);
      return;
    }
    if (!pickers.showOpenFilePicker) return kind === 'project' ? projectInput.click() : fileInput.click();
    const handles = await pickers.showOpenFilePicker(
      kind === 'project'
        ? { id: 'qdp-open', types: [{ description: 'Quick DICOM Planning project (.qdp, or .qdp.zip from older versions)', accept: { [PROJECT_MIME]: ['.qdp'], 'application/zip': ['.zip'] } }] }
        : { id: 'qdp-open', multiple: true },
    );
    const files = await Promise.all(handles.map((h) => h.getFile()));
    pendingRecent = handles.length <= 2 ? { kind: kind === 'project' || /\.(zip|qdp)$/i.test(files[0].name) ? 'project' : 'files', handles, depth: 0 } : null;
    if (kind === 'project') await openProject(files[0]);
    else await loadFiles(files);
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'AbortError') return;
    if (name === 'SecurityError' || name === 'TypeError') {
      // pickers not allowed here (e.g. inside a frame): ordinary dialogs
      (kind === 'folder' ? folderInput : kind === 'project' ? projectInput : fileInput).click();
      return;
    }
    setStatus((e as Error).message, true);
  } finally {
    hideLoading();
  }
}

async function openRecentEntry(e: RecentEntry) {
  closePopovers();
  hideLaunchBanner();
  const my = ++openGen;
  try {
    showLoading(`Opening “${e.label}”…`, 0);
    console.info('[recent] opening', e.kind, e.label);
    cancellableWait(
      () => {
        openGen++;
        setStatus(`Stopped opening “${e.label}”.`, true);
      },
      // the browser may not answer for a remembered folder / file (its access is asked again):
      // a picker grants it straight away
      { label: e.kind === 'folder' ? 'Choose the folder…' : 'Choose the file…', run: () => void pickAndOpen(e.kind === 'folder' ? 'folder' : e.kind) },
    );
    const files = await readRecent(e, (text, f) => {
      console.info('[recent]', text);
      if (my === openGen) showLoading(text, f);
    });
    if (my !== openGen) return;
    cancellableWait(null);
    pendingRecent = { kind: e.kind, handles: e.handles, depth: e.depth };
    if (e.kind === 'project') await openProject(files[0]);
    else await loadFiles(files);
  } catch (err) {
    if (my !== openGen) return;
    hideLoading();
    if ((err as Error).name === 'StaleAccessError') return askToChooseAgain(e);
    const gone = (err as Error).name === 'NotFoundError';
    if (gone) await removeRecent(e.id);
    setStatus(gone ? `“${e.label}” is no longer there (moved or deleted) – removed from the recent list.` : (err as Error).message, true);
    void renderRecent();
  }
}

/**
 * A Recent item the browser no longer answers for (kept from before a browser / Windows update):
 * choosing it once more in a picker gives fresh access, and Recent keeps the new choice.
 */
function askToChooseAgain(e: RecentEntry) {
  const what = e.kind === 'folder' ? 'folder' : 'file';
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.innerHTML = `
    <div class="modal ask-save" role="alertdialog" aria-modal="true" aria-labelledby="ca-title">
      <header><h2 id="ca-title">Choose “${escapeHtml(e.label)}” once more</h2><button class="modal-close" title="Cancel (Esc)">×</button></header>
      <p>The browser no longer opens this ${what} from Recent – this happens to items kept from before a browser or Windows update. Choose the ${what} once more; Recent keeps the new choice.</p>
      <footer><button class="ca-cancel">Cancel</button><span class="grow"></span><button class="ca-go primary">Choose the ${what}…</button></footer>
    </div>`;
  const done = () => {
    window.removeEventListener('keydown', onKey, true);
    m.remove();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    done();
  };
  window.addEventListener('keydown', onKey, true);
  m.querySelector<HTMLButtonElement>('.modal-close')!.onclick = done;
  m.querySelector<HTMLButtonElement>('.ca-cancel')!.onclick = done;
  m.querySelector<HTMLButtonElement>('.ca-go')!.onclick = () => {
    done();
    // the stale item goes; the one chosen now takes its place once it has opened
    void removeRecent(e.id).then(() => renderRecent());
    void pickAndOpen(e.kind === 'folder' ? 'folder' : e.kind); // (in this click: the picker may open)
  };
  document.body.append(m);
  m.querySelector<HTMLButtonElement>('.ca-go')!.focus();
}

// Clear: a second click within a few seconds empties the list
for (const b of document.querySelectorAll<HTMLButtonElement>('.recent-clear')) {
  let armed = -Infinity;
  b.onclick = async (ev) => {
    ev.stopPropagation(); // (the Open menu stays open)
    if (performance.now() - armed > 3000) {
      armed = performance.now();
      b.textContent = 'Clear all?';
      b.classList.add('danger');
      setTimeout(() => {
        if (performance.now() - armed < 2900) return;
        b.textContent = 'Clear';
        b.classList.remove('danger');
      }, 3000);
      return;
    }
    armed = -Infinity;
    b.textContent = 'Clear';
    b.classList.remove('danger');
    await clearRecent();
    await renderRecent();
    setStatus('Recent list cleared (the files themselves are unchanged).');
  };
}

/** Recent list in the Open menu and on the start screen. */
export async function renderRecent() {
  const list = await listRecent();
  const html = (e: RecentEntry) =>
    `<span class="name">${escapeHtml(e.label)}</span><span class="dim">${escapeHtml(e.sub)} · ${escapeHtml(ago(e.when))}</span>`;
  const menu = $('open-recent');
  menu.classList.toggle('hidden', !list.length);
  const items = menu.querySelector<HTMLElement>('.recent-items')!;
  items.innerHTML = '';
  for (const e of list) {
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.className = 'recent-item';
    b.innerHTML = html(e);
    b.onclick = () => void openRecentEntry(e);
    items.append(b);
  }
  const start = $('start-recent');
  start.classList.toggle('hidden', !list.length);
  const ul = start.querySelector<HTMLElement>('ul')!;
  ul.innerHTML = '';
  for (const e of list) {
    const li = document.createElement('li');
    li.innerHTML = html(e);
    li.title = 'Open again';
    li.onclick = () => void openRecentEntry(e);
    ul.append(li);
  }
}
void renderRecent();

// start screen (no scan open)
$('start-screen').addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'open-files') void pickAndOpen('files');
  else if (act === 'open-folder') void pickAndOpen('folder');
  else if (act === 'open-project') void pickAndOpen('project');
  else if (act === 'demo') $('btn-demo').click();
});
$('btn-open').onclick = () => void pickAndOpen('files');
$('btn-open-folder').onclick = () => void pickAndOpen('folder');
fileInput.onchange = () => {
  loadFiles(Array.from(fileInput.files ?? []));
  fileInput.value = '';
};
folderInput.onchange = () => {
  loadFiles(Array.from(folderInput.files ?? []));
  folderInput.value = '';
};
$('btn-demo').onclick = async () => {
  if (!(await askToSave())) return;
  showLoading('Generating demo volume…', 0.3);
  await new Promise((r) => setTimeout(r, 30));
  try {
    app.setVolume(createPhantom());
    if (app.mode === 'plan') setMode('plan'); // ready to draw the curve
    setStatus('Demo phantom loaded (mandible + maxilla in occlusion) – the occlusal plane is tilted a few degrees; try Ctrl+Alt+drag in the sagittal view.');
  } finally {
    hideLoading();
  }
};


const drop = $('drop-overlay');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  drop.classList.remove('hidden');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    drop.classList.add('hidden');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.add('hidden');
  if (!e.dataTransfer) return;
  // both read the items synchronously (they are gone after the first await)
  const handles = handlesFromDrop(e.dataTransfer);
  const files = await filesFromDataTransfer(e.dataTransfer);
  // surface models (intraoral scans) go into the open CBCT
  const meshes = files.filter((f) => /\.(stl|ply|obj)$/i.test(f.name));
  if (meshes.length && meshes.length === files.length) {
    if (!app.vol) setStatus('Open a CBCT first, then drop the intraoral scan onto it.', true);
    else await importScans(meshes);
    return;
  }
  pendingRecent = recentFromHandles(await handles);
  loadFiles(files);
});

// Closing the app (or the tab) with an unsaved plan: the browser asks whether to leave. Browsers
// only offer their own Leave / Cancel question – Cancel keeps the app open to save (Ctrl+S).
window.addEventListener('beforeunload', (e) => {
  if (!app.unsaved) return;
  e.preventDefault();
  e.returnValue = ''; // older browsers
});

// Opening another scan replaces the plan: ask first when it has unsaved changes.
let mayReplace: number | null = null; // volume whose plan the user chose to save or leave

/** Resolves to true when the current plan may be replaced (saved, not wanted, or nothing to save). */
function askToSave(): Promise<boolean> {
  const vol = app.vol;
  if (!vol || !app.unsaved || mayReplace === vol.id) return Promise.resolve(true);
  hideLoading();
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = `
      <div class="modal ask-save" role="alertdialog" aria-modal="true" aria-labelledby="as-title">
        <header><h2 id="as-title">Save the plan first?</h2><button class="modal-close" title="Cancel (Esc)">×</button></header>
        <p>The plan of <b>${escapeHtml(formatPatientName(vol.info.patientName) || vol.info.seriesDescription || 'this scan')}</b> has changes that are not saved.
          Opening another scan replaces it.</p>
        <footer><button class="as-cancel">Cancel</button><span class="grow"></span><button class="as-discard danger">Don't save</button><button class="as-save primary">Save…</button></footer>
      </div>`;
    const done = (ok: boolean) => {
      window.removeEventListener('keydown', onKey, true);
      m.remove();
      if (ok) mayReplace = vol.id;
      else setStatus('Kept the current plan.');
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      done(false);
    };
    window.addEventListener('keydown', onKey, true);
    m.querySelector<HTMLButtonElement>('.modal-close')!.onclick = () => done(false);
    m.querySelector<HTMLButtonElement>('.as-cancel')!.onclick = () => done(false);
    m.querySelector<HTMLButtonElement>('.as-discard')!.onclick = () => done(true);
    m.querySelector<HTMLButtonElement>('.as-save')!.onclick = async () => {
      m.style.display = 'none';
      if (await saveProject()) done(true);
      else m.style.display = ''; // not saved: ask again
    };
    document.body.append(m);
    m.querySelector<HTMLButtonElement>('.as-save')!.focus();
  });
}
