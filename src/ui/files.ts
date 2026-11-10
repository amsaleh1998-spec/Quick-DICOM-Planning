// Opening scans and projects: Open menu and pickers, Recent, the start screen, drag & drop,
// files double-clicked in Explorer / Finder (installed app), and saving projects.

import { applyProjectState, buildProject, projectFileName, projectHasWaxup, readProject } from '../project';
import { ensureLibrary } from '../waxup/library';
import { isZipFile, zipEntriesAsFiles } from '../zip';
import { findScanFolder, parentOf, rememberScanFolder, type FolderHit, type ScanDir } from '../scanFolders';
import { formatDicomDate, formatPatientName } from '../dicomMeta';
import { filesFromDataTransfer, loadDicomFiles } from '../dicom';
import { choosePatient } from './patientChooser';
import { createPhantom } from '../volume';
import { closePopovers } from './popover';
import { RecentEntry, RecentSource, addRecent, ago, handlesFromDrop, listRecent, readRecent, recentFromHandles, removeRecent } from './recent';
import { $, app, escapeHtml, hideLoading, setStatus, showLoading } from './shell';
import { setMode } from './layout';
import { HELPER_LOG, OS_MAC, showHelperHelp } from './install';
import { deliverFile, exportHooks } from './save';
import { showExportStl } from '../exportStl';
import { importScans } from './scansPanel';

/** Load DICOM files, a ZIP of them or a project. Resolves to an error message, or null on success. */
export async function loadFiles(files: File[]): Promise<string | null> {
  if (!files.length) return 'No files received.';
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

async function filesFromDirectory(dir: DirHandle, maxDepth = 4, depth = 0): Promise<File[]> {
  const out: File[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') out.push(await entry.getFile());
    else if (depth < maxDepth) out.push(...(await filesFromDirectory(entry, maxDepth, depth + 1)));
  }
  return out;
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
    await rememberScanFolder(dir);
    const path = launchHandle ? await dir.resolve(launchHandle) : null;
    if (path) {
      await loadFolderOf({ root: dir, path });
      setStatus(`“${dir.name}” remembered – double-clicked scans inside it now open directly.`);
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
$('lb-helper').onclick = () => showHelperHelp();

type LaunchQueue = { setConsumer(cb: (p: { files?: FileSystemFileHandle[] }) => void): void };
const launchQueue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
launchQueue?.setConsumer(async (params) => {
  const handles = params.files ?? [];
  if (!handles.length) return; // ordinary start, no file
  hideLaunchBanner();
  launchHandle = handles[0];
  launchFile = null;
  pendingRecent = handles.length <= 2 ? { kind: /\.(zip|qdp)$/i.test(handles[0].name) ? 'project' : 'files', handles, depth: 0 } : null;
  const what = handles.length > 1 ? `${handles.length} files` : `“${handles[0].name}”`;
  console.info('[launch] received', handles.map((h) => h.name));
  setStatus(`Opening ${what}…`);
  showLoading(`Opening ${what}…`, 0);
  try {
    const files = await Promise.all(handles.map((h) => h.getFile()));
    launchFile = files[0];
    if (files.length > 1 || /\.(zip|qdp)$/i.test(files[0].name) || (await isZipFile(files[0]))) {
      // several files selected in Explorer, a project, or a whole series bundled by the
      // Windows helper (a ZIP named .dcm): open them as they are, no folder access needed
      const err = await loadFiles(files);
      if (err) showLaunchBanner('error', err);
      return;
    }
    const hit = await findScanFolder(handles[0]);
    if (hit?.permission === 'granted') {
      await loadFolderOf(hit);
      return;
    }
    pendingHit = hit;
    showLaunchBanner(hit ? 'allow' : 'setup', hit?.root.name);
  } catch (e) {
    console.error(e);
    showLaunchBanner(
      'error',
      (e as Error).name === 'SecurityError'
        ? 'the browser does not let web apps read files in this location (system folders such as AppData or the temp folder, or hidden folders whose name starts with a dot in your user folder). If you double-clicked with the Windows / Mac helper, run its latest version once (Install app → helper) – it keeps its files in a permitted folder; otherwise move the scan to a normal folder such as Documents.'
        : `${(e as Error).name}: ${(e as Error).message}`,
    );
  } finally {
    hideLoading();
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
    setMode(pf.state.mode);
    applyProjectState(app, pf, entries);
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
    const ok = await deliverFile(blob, name);
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
$('btn-open-project').onclick = () => void pickAndOpen('project');
projectInput.onchange = () => {
  const f = projectInput.files?.[0];
  if (f) openProject(f);
  projectInput.value = '';
};

const fileInput = $<HTMLInputElement>('file-input');
const folderInput = $<HTMLInputElement>('folder-input');
// "Open scans directly in ② Plan"
const OPEN_PLAN_KEY = 'qdp.openPlan';
function openInPlan(): boolean {
  try {
    return localStorage.getItem(OPEN_PLAN_KEY) === '1';
  } catch {
    return false;
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
  const info = app.vol?.info;
  if (!src || !info) return;
  const name = formatPatientName(info.patientName) || info.seriesDescription?.trim() || src.handles[0]?.name || 'Scan';
  const sub = [info.studyDate ? formatDicomDate(info.studyDate) : '', src.kind === 'project' ? 'project' : src.kind === 'folder' ? 'folder' : 'file'].filter(Boolean).join(' · ');
  void addRecent(src, name, sub).then(() => renderRecent());
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
        ? { id: 'qdp-open', types: [{ description: 'Quick DICOM Planning project', accept: { 'application/zip': ['.zip', '.qdp'] } }] }
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
  try {
    const files = await readRecent(e);
    pendingRecent = { kind: e.kind, handles: e.handles, depth: e.depth };
    if (e.kind === 'project') await openProject(files[0]);
    else await loadFiles(files);
  } catch (err) {
    const gone = (err as Error).name === 'NotFoundError';
    if (gone) await removeRecent(e.id);
    setStatus(gone ? `“${e.label}” is no longer there (moved or deleted) – removed from the recent list.` : (err as Error).message, true);
    void renderRecent();
  }
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
