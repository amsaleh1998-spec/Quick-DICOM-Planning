import { App, Jaw, Mode, MprTool, RenderMode, saveInputPreference } from './app';
import { MUA_HEIGHTS, apicalDiameterOf, isTapered, setApicalDiameter, setCoronalDiameter } from './implant';
import { NERVE_SAFETY_MM, nerveLength } from './nerve';
import { applyProjectState, buildProject, projectFileName, readProject } from './project';
import { initTrackpadGuide, showTrackpadGuide } from './tutorial';
import { isZipFile, zipEntriesAsFiles } from './zip';
import { findScanFolder, parentOf, rememberScanFolder, type FolderHit, type ScanDir } from './scanFolders';
import { formatDicomDate, formatPatientName, joinPersonName, splitPersonName } from './dicomMeta';
import { showTagViewer } from './tagViewer';
import { SpaceMouse } from './spacemouse';
import { isPhone } from './uiMode';

import { filesFromDataTransfer, loadDicomFiles } from './dicom';
import { createPhantom } from './volume';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const app = new App();
// exposed for debugging / automated tests
(window as unknown as { app: App }).app = app;

// ---- layouts ----------------------------------------------------------------
const mprLayout = $('layout-mpr');
const planLayout = $('layout-plan');
const areas = ['ax', 'co', 'sa'];
app.mprViews.forEach((v, i) => {
  v.el.style.gridArea = areas[i];
  mprLayout.append(v.el);
});
app.planAxial.el.style.gridArea = 'pax';
app.pano.el.style.gridArea = 'pano';
app.crossViews.forEach((v, i) => (v.el.style.gridArea = `cs${i + 1}`));
app.tang.el.style.gridArea = 'tang';
planLayout.append(app.planAxial.el, app.pano.el, ...app.crossViews.map((v) => v.el), app.tang.el);
app.view3d.el.style.gridArea = 'v3d';
mprLayout.append(app.view3d.el);

/** The 3D view lives in whichever layout is active. */
function moveView3d(target: HTMLElement) {
  const el = app.view3d.el;
  if (el.parentElement === target) return;
  if (el.classList.contains('max')) {
    el.classList.remove('max');
    el.parentElement?.classList.remove('has-max');
  }
  target.append(el);
}

// ---- status / loading ---------------------------------------------------------
const statusMsg = $('status-msg');
function setStatus(msg: string, error = false) {
  statusMsg.textContent = msg;
  statusMsg.classList.toggle('error', error);
}
app.onCursor = (t) => ($('status-cursor').textContent = t);

const loading = $('loading');
function showLoading(text: string, f: number) {
  loading.classList.remove('hidden');
  $('loading-text').textContent = text;
  $('loading-bar').style.width = `${Math.round(f * 100)}%`;
}
const hideLoading = () => loading.classList.add('hidden');
app.onStatus = (msg, error) => setStatus(msg, error);
app.onBusy = (text) => (text ? showLoading(text, 0.6) : hideLoading());

/** Load DICOM files, a ZIP of them or a project. Resolves to an error message, or null on success. */
async function loadFiles(files: File[]): Promise<string | null> {
  if (!files.length) return 'No files received.';
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
    const vol = await loadDicomFiles(files, (stage, f) => showLoading(`${stage}…`, f));
    app.setVolume(vol);
    setMode('mpr');
    setStatus(`Loaded ${vol.nx}×${vol.ny}×${vol.nz} voxels from ${vol.info.source}`);
    return null;
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message, true);
    return (e as Error).message;
  } finally {
    hideLoading();
  }
}

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
    const files = await filesFromDirectory(dir as unknown as DirHandle, 0);
    const err = await loadFiles(files.length ? files : launchFile ? [launchFile] : []);
    if (err) showLaunchBanner('error', err);
  } catch (e) {
    showLaunchBanner('error', `${(e as Error).name}: ${(e as Error).message}`);
  } finally {
    hideLoading();
  }
}

const OS_WIN = /Windows/.test(navigator.userAgent);
const OS_MAC = !OS_WIN && /Macintosh|Mac OS X/.test(navigator.userAgent) && navigator.maxTouchPoints < 2;
const HELPER_LOG = OS_MAC
  ? '~/Library/Application Support/QuickDICOMPlanning/log.txt'
  : '%LOCALAPPDATA%\\QuickDICOMPlanning\\log.txt';

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
    showLaunchBanner('error', `${(e as Error).name}: ${(e as Error).message}`);
  } finally {
    hideLoading();
  }
});

// "Install app" button. Chrome / Edge hand us an install prompt through `beforeinstallprompt`; when they
// haven't (yet), or in other browsers, the button opens step-by-step instructions instead.
let installPrompt: (Event & { prompt(): Promise<{ outcome: string } | void>; userChoice?: Promise<{ outcome: string }> }) | null = null;
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches;
if (isStandalone()) $('btn-install').classList.add('hidden');
else $('btn-install').classList.remove('hidden');
// inside the installed app on Windows: keep the helper one click away
if (isStandalone() && (OS_WIN || OS_MAC)) {
  $('btn-helper').classList.remove('hidden');
  $('btn-helper').textContent = OS_MAC ? 'Mac helper' : 'Windows helper';
}
$('btn-helper').onclick = () => showHelperHelp();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e as typeof installPrompt;
  $('btn-install').classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('btn-install').classList.add('hidden');
  hideInstallHelp();
  setStatus('Installed. Double-click a .dcm file in Explorer (choose Quick DICOM Planning the first time) to open it here.');
});

let infoModal: HTMLDivElement | null = null;
function hideInstallHelp() {
  if (infoModal) infoModal.style.display = 'none';
}
function showInfoModal(title: string, body: string) {
  if (!infoModal) {
    infoModal = document.createElement('div');
    infoModal.className = 'modal-backdrop';
    infoModal.addEventListener('pointerdown', (e) => {
      if (e.target === infoModal) hideInstallHelp();
    });
    document.body.append(infoModal);
  }
  infoModal.innerHTML = `
    <div class="modal install-help" role="dialog" aria-modal="true" aria-labelledby="ih-title">
      <header>
        <h2 id="ih-title">${title}</h2>
        <button class="modal-close" title="Close (Esc)">×</button>
      </header>
      ${body}
      <footer><span></span><button class="primary modal-ok">OK</button></footer>
    </div>`;
  infoModal.querySelector<HTMLButtonElement>('.modal-close')!.onclick = hideInstallHelp;
  infoModal.querySelector<HTMLButtonElement>('.modal-ok')!.onclick = hideInstallHelp;
  infoModal.style.display = '';
  infoModal.querySelector<HTMLButtonElement>('.modal-ok')!.focus();
}
const HELPER_URL = './windows/Install-QuickDICOM-Helper.cmd';
const MAC_HELPER_URL = new URL('./mac/install-helper.sh', document.baseURI).href;
const macCommand = () => `curl -fsSL ${MAC_HELPER_URL} | bash`;
const winHelperSection = () => `
  <h3>Never be asked for a folder (Windows helper)</h3>
  <p class="muted">Browsers give a web app only the one file you double-click. This small helper (installs for your
    Windows user only, no admin rights) packs the file's whole folder and hands it to the app, so a double-click opens
    the full series with <b>no questions at all</b>.</p>
  <ol>
    <li>${isStandalone() ? '' : 'Install the app first, then '}<button class="primary dl-helper">Download the helper</button>
      <span class="muted">(or <a href="${HELPER_URL}" download="Install-QuickDICOM-Helper.cmd">this link</a>; it is saved to your Downloads folder)</span></li>
    <li>Double-click the downloaded file. If the browser or Windows warns about it, choose <b>Keep</b>, then
      <b>More info → Run anyway</b>.</li>
    <li>In the window that opens, choose <b>Quick DICOM Planning (whole series)</b> and tick <b>Always use this app</b>.</li>
  </ol>
  <p class="muted">To remove it later, run <b>uninstall.cmd</b> in <b>%LOCALAPPDATA%\\QuickDICOMPlanning</b>.</p>`;
const macHelperSection = () => `
  <h3>Never be asked for a folder (Mac helper)</h3>
  <p class="muted">Browsers give a web app only the one file you double-click. This small helper adds
    <b>Quick DICOM Planning (whole series)</b> to your Applications folder (your user only, no password). It packs the
    file's whole folder and hands it to the app, so a double-click opens the full series with <b>no questions at all</b>.</p>
  <ol>
    <li>${isStandalone() ? 'Open' : 'Install the app first. Then open'} <b>Terminal</b> (⌘ Space, type <i>Terminal</i>, Return),
      paste this line and press Return:
      <div class="cmd-row"><code class="helper-cmd">${escapeHtml(macCommand())}</code><button class="primary copy-cmd">Copy</button></div></li>
    <li>If Terminal says so at the end: in Finder select any <b>.dcm</b> file → <b>File → Get Info</b> (⌘I) →
      <b>Open with</b>: choose <b>Quick DICOM Planning (whole series)</b> → <b>Change All…</b></li>
    <li>The first time you open a scan, macOS may ask to let the helper access a folder (Documents, Desktop,
      Dropbox …): click <b>Allow</b>, so it can read the other files of the scan.</li>
  </ol>
  <p class="muted">To remove it later, run <code>bash ~/Library/Application\\ Support/QuickDICOMPlanning/uninstall.sh</code> in Terminal.</p>`;
const helperSection = () =>
  OS_MAC
    ? macHelperSection()
    : OS_WIN
    ? winHelperSection()
    : `<h3>Helper</h3><p class="muted">The double-click helper is available for Windows and macOS.</p>`;
/** Save the helper via a blob: works the same in a browser tab and in the installed app window. */
async function downloadHelper() {
  try {
    const res = await fetch(HELPER_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const blob = new Blob([await res.arrayBuffer()], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Install-QuickDICOM-Helper.cmd';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setStatus('Helper downloaded – open it from your Downloads folder (or the download list, Ctrl+J).');
  } catch (e) {
    setStatus(`Could not download the helper: ${(e as Error).message}`, true);
  }
}
function bindHelperButtons() {
  infoModal?.querySelectorAll<HTMLButtonElement>('.dl-helper').forEach((b) => (b.onclick = () => downloadHelper()));
  infoModal?.querySelectorAll<HTMLButtonElement>('.copy-cmd').forEach(
    (b) =>
      (b.onclick = async () => {
        const text = macCommand();
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const code = b.parentElement?.querySelector('code');
          if (code) window.getSelection()?.selectAllChildren(code); // let the user press ⌘C
          document.execCommand?.('copy');
        }
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy'), 2000);
      }),
  );
}
function showHelperHelp() {
  showInfoModal('Open whole scans with a double-click', helperSection());
  bindHelperButtons();
}
function showInstallHelp() {
  const ua = navigator.userAgent;
  const isEdge = /Edg\//.test(ua);
  const isChrome = !isEdge && /Chrome\//.test(ua) && !/OPR\//.test(ua);
  const inFrame = window.top !== window.self;
  const appUrl = 'https://amsaleh1998-spec.github.io/Quick-DICOM-Planning/';
  let steps: string;
  if (inFrame) {
    steps = `<p>This copy of the app runs inside another page, and browsers can't install it from there.
      Open <a href="${appUrl}" target="_blank" rel="noopener">${appUrl}</a> in <b>Chrome</b> or <b>Edge</b> and click <b>Install app</b> there.</p>`;
  } else if (isEdge) {
    steps = `<ol>
      <li>Look at the right end of the address bar for the <b>App available</b> icon (a small square with a <b>+</b>) and click it, then <b>Install</b>.</li>
      <li>No icon? Open the <b>⋯</b> menu (top right) → <b>Apps</b> → <b>Install Quick DICOM Planning</b>.</li>
    </ol>`;
  } else if (isChrome) {
    steps = `<ol>
      <li>Look at the right end of the address bar for the <b>install</b> icon (a monitor with a down arrow) and click it, then <b>Install</b>.</li>
      <li>No icon? Open the <b>⋮</b> menu (top right) → <b>Cast, save and share</b> → <b>Install page as app…</b>
        (older Chrome versions: <b>Install Quick DICOM Planning…</b> directly in the menu).</li>
    </ol>`;
  } else {
    steps = `<p>This browser can't install web apps that open files. Open <a href="${appUrl}" target="_blank" rel="noopener">${appUrl}</a>
      in <b>Google Chrome</b> or <b>Microsoft Edge</b> (Edge is built into Windows) and click <b>Install app</b> there.</p>`;
  }
  const after = OS_MAC
    ? `After installing, select any <b>.dcm</b> file in Finder → <b>File → Get Info</b> (⌘I) → <b>Open with</b>:
        <b>Quick DICOM Planning</b> → <b>Change All…</b>`
    : `After installing, right-click any <b>.dcm</b> file in Windows Explorer → <b>Open with</b> →
        <b>Choose another app</b> → <b>Quick DICOM Planning</b> and tick <b>Always use this app</b>.`;
  showInfoModal(
    'Install Quick DICOM Planning',
    `${steps}
      <p class="muted">${after}</p>
      ${(OS_WIN || OS_MAC) && !inFrame ? helperSection() : ''}`,
  );
  bindHelperButtons();
}
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && infoModal && infoModal.style.display !== 'none') {
      e.stopImmediatePropagation();
      hideInstallHelp();
    }
  },
  true,
);
$('btn-install').onclick = async () => {
  if (installPrompt) {
    const p = installPrompt;
    installPrompt = null; // a prompt can only be used once
    await p.prompt();
    const choice = await p.userChoice;
    if (choice?.outcome === 'dismissed') setStatus('Installation cancelled. Click Install app again for instructions.');
    return;
  }
  showInstallHelp();
};

// offline support + installability (production build only; the dev server reloads too often)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker not registered', e));
}

// ---- projects ----------------------------------------------------------------------
async function openProject(file: File): Promise<string | null> {
  try {
    showLoading('Opening project…', 0.2);
    const buf = await file.arrayBuffer();
    showLoading('Unpacking project…', 0.5);
    const { volume, file: pf } = await readProject(buf);
    showLoading('Restoring views…', 0.9);
    app.setVolume(volume);
    setMode(pf.state.mode);
    applyProjectState(app, pf);
    setStatus(`Project "${file.name}" restored (saved ${new Date(pf.savedAt).toLocaleString()})`);
    return null;
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message, true);
    return (e as Error).message;
  } finally {
    hideLoading();
  }
}

type DownloadsNs = { save(r: { filename: string; data: Blob }): Promise<unknown> };
type ClaudeHost = { use(name: string): Promise<unknown> };

/** Hand the file to the user: hosted page capability, native save dialog, or a plain download. */
async function deliverFile(blob: Blob, filename: string): Promise<boolean> {
  const host = (window as unknown as { claude?: ClaudeHost }).claude;
  if (host?.use) {
    const dl = (await host.use('downloads').catch(() => null)) as DownloadsNs | null;
    if (dl) {
      try {
        await dl.save({ filename, data: blob });
        return true;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'declined') return false;
        throw new Error(`Saving failed (${code ?? (e as Error).message})`);
      }
    }
  }
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: 'Quick DICOM Planning project', accept: { 'application/zip': ['.zip'] } }],
      });
      const w = await (handle as unknown as { createWritable(): Promise<WritableStream & { write(b: Blob): Promise<void>; close(): Promise<void> }> }).createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      // e.g. not allowed in this frame – fall back to a normal download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

async function saveProject() {
  if (!app.vol) {
    setStatus('Nothing to save – open a CBCT first.', true);
    return;
  }
  try {
    showLoading('Packing project…', 0);
    const blob = await buildProject(app, (f) => showLoading('Compressing volume…', f));
    hideLoading();
    const name = projectFileName(app);
    const ok = await deliverFile(blob, name);
    setStatus(ok ? `Project saved as ${name} (${(blob.size / 1e6).toFixed(1)} MB)` : 'Save cancelled');
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message, true);
  } finally {
    hideLoading();
  }
}

const projectInput = $<HTMLInputElement>('project-input');
$('btn-save-project').onclick = () => saveProject();
$('btn-open-project').onclick = () => projectInput.click();
projectInput.onchange = () => {
  const f = projectInput.files?.[0];
  if (f) openProject(f);
  projectInput.value = '';
};

// ---- toolbar -------------------------------------------------------------------
const fileInput = $<HTMLInputElement>('file-input');
const folderInput = $<HTMLInputElement>('folder-input');
$('btn-open').onclick = () => fileInput.click();
$('btn-open-folder').onclick = () => folderInput.click();
fileInput.onchange = () => {
  loadFiles(Array.from(fileInput.files ?? []));
  fileInput.value = '';
};
folderInput.onchange = () => {
  loadFiles(Array.from(folderInput.files ?? []));
  folderInput.value = '';
};
$('btn-demo').onclick = async () => {
  showLoading('Generating demo volume…', 0.3);
  await new Promise((r) => setTimeout(r, 30));
  try {
    app.setVolume(createPhantom());
    setStatus('Demo phantom loaded (mandible + maxilla in occlusion) – the occlusal plane is tilted a few degrees; try Ctrl+Alt+drag in the sagittal view.');
  } finally {
    hideLoading();
  }
};

// drag & drop
const viewport = $('viewport');
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
  const files = await filesFromDataTransfer(e.dataTransfer);
  loadFiles(files);
});
void viewport;

// mode tabs
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tabs button'));
// pulse the "Implant planning" tab once after the first volume loads, until it has been opened
let planOpened = false;
let planNudged = false;
function setMode(m: Mode) {
  if (m === 'plan') {
    planOpened = true;
    tabButtons.forEach((b) => b.classList.remove('nudge'));
  }
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  mprLayout.classList.toggle('hidden', m !== 'mpr');
  planLayout.classList.toggle('hidden', m !== 'plan');
  $('panel-mpr').classList.toggle('hidden', m !== 'mpr');
  $('panel-plan').classList.toggle('hidden', m !== 'plan');
  moveView3d(m === 'mpr' ? mprLayout : planLayout);
  app.setMode(m);
}
tabButtons.forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
document.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach((b) => (b.onclick = () => setMode(b.dataset.goto as Mode)));

// window / level
const ww = $<HTMLInputElement>('ww');
const wc = $<HTMLInputElement>('wc');
app.onWindowChange = () => {
  if (document.activeElement !== ww) ww.value = String(Math.round(app.wl.width));
  if (document.activeElement !== wc) wc.value = String(Math.round(app.wl.center));
};
ww.oninput = () => app.setWindow(app.wl.center, Number(ww.value) || 1);
wc.oninput = () => app.setWindow(Number(wc.value) || 0, app.wl.width);
$('btn-auto-wl').onclick = () => app.autoWindow();

// ---- MPR panel -------------------------------------------------------------------
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#mpr-tools button'));
toolButtons.forEach(
  (b) =>
    (b.onclick = () => {
      app.mprTool = b.dataset.tool as MprTool;
      app.changed();
    }),
);
$('btn-straighten').onclick = () => app.straightenViews();
$('btn-reset-rot').onclick = () => app.resetRotation();
$('btn-reset-crop').onclick = () => app.resetCrop();
$('btn-apply').onclick = async () => {
  if (!app.vol) return;
  try {
    showLoading('Resampling volume…', 0);
    await app.applyCropAndRotation((f) => showLoading('Resampling volume…', f));
    setStatus(`Resampled to ${app.vol.nx}×${app.vol.ny}×${app.vol.nz} voxels (${app.vol.spacing[0].toFixed(2)} mm)`);
  } catch (e) {
    setStatus((e as Error).message, true);
  } finally {
    hideLoading();
  }
};

// ---- planning panel ---------------------------------------------------------------
$('btn-draw-curve').onclick = () => {
  if (!app.vol) return;
  if (app.drawing) app.finishCurve();
  else app.startDrawing(); // (re)draws the active curve
};
$('btn-add-curve').onclick = () => {
  if (!app.vol) return;
  if (app.drawing) app.cancelDrawing();
  app.startDrawing(true); // an additional curve
};
$('btn-clear-curve').onclick = () => app.clearCurve();
const curveList = $('curve-list');
curveList.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-id]');
  if (li) app.activateCurve(Number(li.dataset.id));
});
const curveName = $<HTMLInputElement>('curve-name');
curveName.oninput = () => {
  const sl = app.activeSlot();
  if (sl && curveName.value.trim()) app.renameCurve(sl.id, curveName.value);
};
const slab = $<HTMLInputElement>('slab');
const spacing = $<HTMLInputElement>('spacing');
slab.oninput = () => {
  if (app.panoMode === 'slab') app.panoSlab = Number(slab.value);
  else app.panoSlice = Number(slab.value);
  app.changed();
};
$('btn-pano-center').onclick = () => {
  app.panoOffset = 0;
  app.changed();
};
const panoModeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#pano-mode button'));
panoModeButtons.forEach((b) => (b.onclick = () => app.setPanoMode(b.dataset.pm as 'slab' | 'slice')));
spacing.oninput = () => {
  app.crossSpacing = Number(spacing.value);
  app.changed();
};
const placeButton = (jaw: Jaw) => () => {
  if (!app.vol) return;
  if (app.placing === jaw) {
    app.placing = null;
    app.changed();
  } else app.startPlacing(jaw);
};
$('btn-add-upper').onclick = placeButton('upper');
$('btn-add-lower').onclick = placeButton('lower');

// input device (mouse / trackpad) and the trackpad guide
const inputButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#input-seg button'));
function setInput(v: 'mouse' | 'trackpad') {
  app.input = v;
  saveInputPreference(v);
  app.changed();
}
inputButtons.forEach((b) => (b.onclick = () => setInput(b.dataset.input as 'mouse' | 'trackpad')));
$('btn-trackpad-guide').onclick = () => showTrackpadGuide();
// phone user on the full version: offer the way back
$('btn-mobile').classList.toggle('hidden', !isPhone());
initTrackpadGuide(setInput, () => app.input);
// Keep pinch / ctrl+wheel from zooming the whole page (and Safari's page pinch)
window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
for (const g of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(g, (e) => e.preventDefault());

// ruler / right-drag behaviour
$('btn-ruler').onclick = () => app.setRuler(!app.ruler);
$('btn-clear-measure').onclick = () => app.clearMeasurements();
const rdButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#rd-seg button'));
rdButtons.forEach(
  (b) =>
    (b.onclick = () => {
      app.rightDrag = b.dataset.rd as 'zoom' | 'wl';
      app.changed();
    }),
);
const defD = $<HTMLInputElement>('def-d');
const defL = $<HTMLInputElement>('def-l');
defD.onchange = () => (app.defaultDiameter = clampNum(defD.value, 2, 8, 4));
const defTapered = $<HTMLInputElement>('def-tapered');
defTapered.onchange = () => (app.defaultTapered = defTapered.checked);
defL.onchange = () => (app.defaultLength = clampNum(defL.value, 4, 20, 10));
const impName = $<HTMLInputElement>('imp-name');
impName.oninput = () => {
  const imp = app.selectedImplant();
  // keep typing smooth: store as typed, empty is fixed up on blur
  if (imp) {
    imp.name = impName.value.slice(0, 40);
    app.changed();
  }
};
impName.onblur = () => {
  const imp = app.selectedImplant();
  if (imp) app.renameImplant(imp.id, impName.value);
};
impName.onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === 'Escape') impName.blur();
};
const impD = $<HTMLInputElement>('imp-d');
const impTapered = $<HTMLInputElement>('imp-tapered');
const impAd = $<HTMLInputElement>('imp-ad');
impTapered.onchange = () => {
  const imp = app.selectedImplant();
  if (!imp) return;
  // default taper: apex 1 mm narrower than the platform
  if (impTapered.checked) setApicalDiameter(imp, Math.round((imp.diameter - 1) * 10) / 10);
  else imp.apicalDiameter = null;
  app.implantChanged(imp, true);
};
impAd.oninput = () => {
  const imp = app.selectedImplant();
  if (!imp || impAd.value === '') return;
  setApicalDiameter(imp, clampNum(impAd.value, 1.5, imp.diameter, apicalDiameterOf(imp)));
  app.implantChanged(imp, true);
};
const impL = $<HTMLInputElement>('imp-l');
impD.oninput = () => {
  const imp = app.selectedImplant();
  if (imp && impD.value) {
    setCoronalDiameter(imp, clampNum(impD.value, 1, 10, imp.diameter));
    app.changed();
  }
};
impL.oninput = () => {
  const imp = app.selectedImplant();
  if (imp && impL.value) app.setLength(imp.id, clampNum(impL.value, 2, 30, imp.length));
};

// parallel placement
const placeParallel = $<HTMLInputElement>('place-parallel');
placeParallel.onchange = () => (app.placeParallel = placeParallel.checked);
const parallelTo = $<HTMLSelectElement>('parallel-to');
$('btn-parallel').onclick = () => {
  if (app.selectedId !== null && parallelTo.value) app.makeParallel(app.selectedId, Number(parallelTo.value));
};
$('btn-flip').onclick = () => app.selectedId !== null && app.flipImplant(app.selectedId);

// abutments
const impAxis = $<HTMLInputElement>('imp-axis');
impAxis.onchange = () => {
  const imp = app.selectedImplant();
  if (!imp) return;
  imp.showProstheticAxis = impAxis.checked;
  app.changed();
};
const abType = $<HTMLSelectElement>('ab-type');
const abHeight = $<HTMLSelectElement>('ab-height');
const abRot = $<HTMLInputElement>('ab-rot');
abHeight.innerHTML = MUA_HEIGHTS.map((h) => `<option value="${h}">${h}</option>`).join('');
abHeight.value = '2';
abType.onchange = () => {
  const imp = app.selectedImplant();
  if (!imp) return;
  if (abType.value === 'none') imp.abutment = null;
  else {
    if (!imp.abutment) imp.showProstheticAxis = true; // adding an MUA shows its axis (can be switched off)
    const angle = Number(abType.value);
    imp.abutment = { angle, gingivalHeight: imp.abutment?.gingivalHeight ?? Number(abHeight.value), rotation: imp.abutment?.rotation ?? 0 };
  }
  app.changed();
};
abHeight.onchange = () => {
  const imp = app.selectedImplant();
  if (imp?.abutment) {
    imp.abutment.gingivalHeight = Number(abHeight.value);
    app.changed();
  }
};
abRot.oninput = () => {
  const imp = app.selectedImplant();
  if (imp?.abutment) {
    imp.abutment.rotation = Number(abRot.value);
    app.changed();
  }
};
$('btn-ab-auto').onclick = () => app.selectedId !== null && app.autoAlignAbutment(app.selectedId);

// ---- 3D panel ------------------------------------------------------------------
const vrButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#vr-mode button'));
vrButtons.forEach(
  (b) =>
    (b.onclick = () => {
      app.vr.mode = b.dataset.vr as RenderMode;
      app.changed();
    }),
);
const vrLo = $<HTMLInputElement>('vr-lo');
const vrHi = $<HTMLInputElement>('vr-hi');
const vrLoNum = $<HTMLInputElement>('vr-lo-num');
const vrHiNum = $<HTMLInputElement>('vr-hi-num');
const setLo = (v: number) => {
  if (!Number.isFinite(v)) return;
  app.vr.lo = v;
  if (app.vr.hi < v) app.vr.hi = v;
  app.changed();
};
const setHi = (v: number) => {
  if (!Number.isFinite(v)) return;
  app.vr.hi = v;
  if (app.vr.lo > v) app.vr.lo = v;
  app.changed();
};
vrLo.oninput = () => setLo(Number(vrLo.value));
vrHi.oninput = () => setHi(Number(vrHi.value));
vrLoNum.onchange = () => setLo(Number(vrLoNum.value));
vrHiNum.onchange = () => setHi(Number(vrHiNum.value));
$('btn-vr-auto').onclick = () => {
  if (!app.vol) return;
  app.vr.lo = Math.round(app.vol.boneThreshold());
  app.vr.hi = app.vol.max;
  app.changed();
};
document.querySelectorAll<HTMLButtonElement>('.presets button').forEach(
  (b) => (b.onclick = () => app.view3d.setPreset(b.dataset.preset as 'front')),
);
// ---- 3Dconnexion SpaceMouse --------------------------------------------------------
const spaceMouse = new SpaceMouse(app.view3d);
// the 3Dconnexion driver also scrolls/zooms with the cap: ignore wheel events meanwhile
spaceMouse.onActivity = () => (app.wheelBlockedUntil = performance.now() + 300);
(window as unknown as { spaceMouse: SpaceMouse }).spaceMouse = spaceMouse; // debugging / tests
const smButton = $<HTMLButtonElement>('btn-spacemouse');
const smSpeed = $<HTMLInputElement>('sm-speed');
const smInvRot = $<HTMLInputElement>('sm-inv-rot');
const smInvTr = $<HTMLInputElement>('sm-inv-tr');
function refreshSpaceMouse() {
  const on = !!spaceMouse.name;
  smButton.textContent = on && spaceMouse.via === 'hid' ? 'Disconnect' : 'Connect SpaceMouse';
  smButton.classList.toggle('hidden', !spaceMouse.supported);
  $('sm-status').textContent = on
    ? `${spaceMouse.name}${spaceMouse.via === 'gamepad' ? ' (game controller)' : ''}`
    : spaceMouse.supported
      ? ''
      : 'Use Chrome or Edge to connect one (other browsers only if they expose it as a game controller).';
  $('sm-settings').classList.toggle('hidden', !on);
  smSpeed.value = String(spaceMouse.settings.speed);
  $('sm-speed-val').textContent = `${spaceMouse.settings.speed.toFixed(1)}×`;
  smInvRot.checked = spaceMouse.settings.invertRotation;
  smInvTr.checked = spaceMouse.settings.invertTranslation;
}
spaceMouse.onChange = () => {
  refreshSpaceMouse();
  if (spaceMouse.name) setStatus(`SpaceMouse connected: ${spaceMouse.name}`);
};
smButton.onclick = async () => {
  if (spaceMouse.via === 'hid') {
    await spaceMouse.disconnect();
    return;
  }
  const err = await spaceMouse.connect();
  if (err) setStatus(err, true);
};
smSpeed.oninput = () => {
  spaceMouse.settings.speed = Number(smSpeed.value);
  spaceMouse.saveSettings();
  refreshSpaceMouse();
};
smInvRot.onchange = () => {
  spaceMouse.settings.invertRotation = smInvRot.checked;
  spaceMouse.saveSettings();
};
smInvTr.onchange = () => {
  spaceMouse.settings.invertTranslation = smInvTr.checked;
  spaceMouse.saveSettings();
};
refreshSpaceMouse();
spaceMouse.autoConnect();

$('btn-3d-reset').onclick = () => app.view3d.fit();
$('btn-upright').onclick = () => app.selectedId !== null && app.uprightImplant(app.selectedId);
$('btn-deselect').onclick = () => app.selectImplant(null, false);
$('btn-delete').onclick = () => app.selectedId !== null && app.deleteImplant(app.selectedId);

// ---- segmentation panel -------------------------------------------------------
document.querySelectorAll<HTMLButtonElement>('[data-seg-preset]').forEach(
  (b) => (b.onclick = () => app.newSegment(Number(b.dataset.segPreset))),
);
const segName = $<HTMLInputElement>('seg-name');
const segColor = $<HTMLInputElement>('seg-color');
segName.oninput = () => {
  const s = app.activeSegment();
  if (s) {
    s.name = segName.value.slice(0, 40);
    app.changed();
  }
};
segName.onblur = () => {
  const s = app.activeSegment();
  if (s && !s.name.trim()) {
    s.name = `Segment ${s.id}`;
    app.changed();
  }
};
segName.onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === 'Escape') segName.blur();
};
segColor.oninput = () => {
  const s = app.activeSegment();
  if (!s) return;
  const h = segColor.value;
  s.color = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  app.changed();
};
$('btn-seg-grow').onclick = () => app.setSegTool(app.segTool === 'grow' ? null : 'grow');
$('btn-seg-regrow').onclick = () => app.activeSegId !== null && app.regrowSegment(app.activeSegId);
$('btn-seg-undo').onclick = () => app.activeSegId !== null && app.undoSegmentClick(app.activeSegId);
$('btn-seg-clear').onclick = () => app.activeSegId !== null && app.clearSegment(app.activeSegId);
$('btn-seg-delete').onclick = () => app.activeSegId !== null && app.deleteSegment(app.activeSegId);
const segShowUnseg = $<HTMLInputElement>('seg-show-unseg');
const segShow2d = $<HTMLInputElement>('seg-show-2d');
segShowUnseg.onchange = () => {
  app.showUnsegmented = segShowUnseg.checked;
  app.changed();
};
segShow2d.onchange = () => {
  app.showSegOverlay = segShow2d.checked;
  app.changed();
};
$('btn-cut').onclick = () => (app.segTool === 'cut' ? app.setSegTool(null) : app.startCut());
const cutDepth = $<HTMLSelectElement>('cut-depth');
cutDepth.onchange = () => {
  app.cutDepth = cutDepth.value ? Number(cutDepth.value) : null;
  app.changed();
};
$('btn-nerve-right').onclick = () => app.traceNerve('right');
$('btn-nerve-left').onclick = () => app.traceNerve('left');
const nerveD = $<HTMLInputElement>('nerve-d');
nerveD.oninput = () => {
  const n = app.activeNerve();
  if (n && nerveD.value) {
    n.diameter = clampNum(nerveD.value, 0.5, 8, n.diameter);
    app.changed();
  }
};
$('btn-nerve-trace').onclick = () => {
  const n = app.activeNerve();
  if (!n) return;
  if (app.segTool === 'nerve') app.setSegTool(null);
  else app.traceNerve(n.side);
};
$('btn-nerve-undo').onclick = () => app.undoNervePoint();
$('btn-nerve-delete').onclick = () => app.activeNerveId !== null && app.deleteNerve(app.activeNerveId);

function clampNum(v: string, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// ---- keyboard ---------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveProject();
    return;
  }
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  // Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z or Ctrl+Y redo (implant changes; unlimited)
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    const redo = e.key === 'y' || e.key === 'Y' || e.shiftKey;
    doUndoRedo(redo);
    return;
  }
  if (e.key === 'Enter' && app.segTool === 'cut' && app.cutDraft) {
    app.finishCut();
    return;
  }
  if (e.key === 'Escape' && app.segTool) {
    app.setSegTool(null);
    return;
  }
  if (e.key === 'Escape') {
    if (app.drawing) app.cancelDrawing();
    else if (app.ruler) app.setRuler(false);
    else if (app.placing) {
      app.placing = null;
      app.changed();
    } else app.selectImplant(null, false);
  } else if (e.key === 'Enter' && app.drawing) {
    // the Draw button usually still has focus: don't let Enter also "press" it (that restarted drawing)
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    app.finishCurve();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && app.hoverMeasurementId !== null) {
    app.deleteMeasurement(app.hoverMeasurementId);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && app.selectedId !== null && app.mode === 'plan') {
    app.deleteImplant(app.selectedId);
  } else if (e.key === 'f' || e.key === 'F') {
    app.fitAll();
  } else if (e.key === 'r' || e.key === 'R') {
    app.setRuler(!app.ruler);
  } else if ((e.key === 'm' || e.key === 'M') && app.activeView) {
    app.toggleMaximize(app.activeView);
  } else if ((e.key === '1' || e.key === '2') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    setMode(e.key === '1' ? 'mpr' : 'plan');
  }
});

// ---- state -> UI -----------------------------------------------------------------
// ---- patient & DICOM tags ---------------------------------------------------
const ptLast = $<HTMLInputElement>('pt-last');
const ptFirst = $<HTMLInputElement>('pt-first');
function updatePatientBadge() {
  const badge = $('patient-badge');
  const label = app.vol ? formatPatientName(app.vol.info.patientName) : '';
  badge.textContent = label;
  badge.classList.toggle('hidden', !label);
}
const onNameInput = () => {
  if (!app.vol) return;
  // stored as a DICOM person name (Last^First) – saved with the project
  app.vol.info.patientName = joinPersonName(ptLast.value, ptFirst.value);
  updatePatientBadge();
};
ptLast.oninput = onNameInput;
ptFirst.oninput = onNameInput;
$('btn-tags').onclick = () => {
  const info = app.vol?.info;
  if (!info?.meta?.length) return;
  const who = formatPatientName(info.patientName);
  showTagViewer(info.meta, `First file of the series${who ? ` · ${who}` : ''}${info.seriesDescription ? ` · ${info.seriesDescription}` : ''}`);
};

// ---- undo / redo ---------------------------------------------------------------
function doUndoRedo(redo: boolean) {
  const ok = redo ? app.redoImplants() : app.undoImplants();
  if (!ok) setStatus(redo ? 'Nothing to redo' : 'Nothing to undo');
  else setStatus(`${redo ? 'Redo' : 'Undo'} – ${app.undoCount} step${app.undoCount === 1 ? '' : 's'} to undo, ${app.redoCount} to redo`);
}
$('btn-undo').onclick = () => doUndoRedo(false);
$('btn-redo').onclick = () => doUndoRedo(true);

const EYE =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/></svg>';
const EYE_OFF =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".55"/><path d="M2 14L14 2" stroke="currentColor" stroke-width="1.6"/></svg>';

const implantList = $('implant-list');
// eye / MUA toggles inside list entries (handled before the entry's own click = select)
for (const type of ['click', 'dblclick'] as const) {
  implantList.addEventListener(
    type,
    (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.vis-btn');
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      if (type === 'dblclick') return;
      const id = Number(btn.dataset.id);
      const imp = app.implantById(id);
      if (!imp) return;
      if (btn.dataset.kind === 'ab') app.setAbutmentHidden(id, !imp.abutmentHidden);
      else app.setImplantHidden(id, !imp.hidden);
    },
    true,
  );
}
$('btn-show-all-implants').onclick = () => app.showAllImplants();
const listItems = new Map<number, HTMLLIElement>();
function refreshUi() {
  const vol = app.vol;
  // patient
  const info = vol?.info;
  $('patient-fields').classList.toggle('hidden', !vol);
  if (info) {
    const { last, first } = splitPersonName(info.patientName);
    if (document.activeElement !== ptLast) ptLast.value = last;
    if (document.activeElement !== ptFirst) ptFirst.value = first;
    const sexes: Record<string, string> = { M: 'male', F: 'female', O: 'other' };
    const details = [
      info.patientId ? `ID ${info.patientId}` : '',
      info.birthDate ? `born ${formatDicomDate(info.birthDate)}` : '',
      info.sex ? sexes[info.sex] ?? info.sex : '',
    ].filter(Boolean);
    $('pt-details').textContent = details.join(' · ');
  }
  updatePatientBadge();

  if (vol && !planOpened && !planNudged && app.mode === 'mpr') {
    planNudged = true;
    tabButtons.find((b) => b.dataset.mode === 'plan')?.classList.add('nudge');
  }
  $('vol-info').innerHTML = vol
    ? [
        info!.seriesDescription ? `<div>${escapeHtml(info!.seriesDescription)}</div>` : '',
        info!.studyDate ? `<div>Study ${escapeHtml(formatDicomDate(info!.studyDate))}${info!.modality ? ` · ${escapeHtml(info!.modality)}` : ''}</div>` : '',
        info!.manufacturer || info!.model ? `<div>${escapeHtml([info!.manufacturer, info!.model].filter(Boolean).join(' '))}</div>` : '',
        `<div>${vol.nx} × ${vol.ny} × ${vol.nz} voxels</div>`,
        `<div>${vol.spacing.map((s) => s.toFixed(3)).join(' × ')} mm</div>`,
        `<div class="small">${escapeHtml(info!.source)}</div>`,
      ].join('')
    : 'Open a DICOM series (files or folder, or drag &amp; drop) or load the demo volume.';
  const tagsBtn = $('btn-tags');
  tagsBtn.classList.toggle('hidden', !vol);
  tagsBtn.textContent = info?.meta ? `DICOM tags (${info.meta.length})` : 'DICOM tags';
  tagsBtn.toggleAttribute('disabled', !info?.meta?.length);
  tagsBtn.title = info?.meta?.length ? 'Show every DICOM attribute of the series' : 'No DICOM tags (demo volume)';

  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === app.mprTool));
  const tilt = [0, 1, 2].map((i) => app.viewTiltDeg(i));
  $('mpr-status').textContent = vol
    ? `Tilt – axial ${tilt[0].toFixed(1)}°, coronal ${tilt[1].toFixed(1)}°, sagittal ${tilt[2].toFixed(1)}°` +
      (app.cropIsFull() ? '' : ' · crop active')
    : '';

  const draw = $('btn-draw-curve');
  draw.textContent = app.drawing ? 'Finish curve' : app.curve ? 'Redraw' : 'Draw panoramic curve';
  draw.classList.toggle('active', !!app.drawing);
  $('btn-add-curve').classList.toggle('hidden', !app.curve || !!app.drawing);
  $('btn-clear-curve').classList.toggle('hidden', !app.curve);
  // curve list (only useful with more than one curve)
  const sl = app.activeSlot();
  $('curve-name-row').classList.toggle('hidden', !sl);
  if (sl && document.activeElement !== curveName) curveName.value = sl.name;
  const listHtml =
    app.curves.length > 1
      ? app.curves
          .map(
            (c) =>
              `<li data-id="${c.id}" class="${c.id === app.activeCurveId ? 'sel' : ''}" title="Show this curve in the panoramic, cross-sections and tangential view">` +
              `<span class="dot"></span>${escapeHtml(c.name)}<span class="dim">${c.curve.length.toFixed(0)} mm</span></li>`,
          )
          .join('')
      : '';
  if (curveList.innerHTML !== listHtml) curveList.innerHTML = listHtml;
  for (const jaw of ['upper', 'lower'] as Jaw[]) {
    const b = $(`btn-add-${jaw}`);
    b.textContent = app.placing === jaw ? 'Click in a view… (Esc)' : `Add ${jaw} implant`;
    b.classList.toggle('active', app.placing === jaw);
  }
  $('btn-ruler').classList.toggle('active', app.ruler);
  $('btn-clear-measure').toggleAttribute('disabled', !app.measurements.length);
  rdButtons.forEach((b) => b.classList.toggle('active', b.dataset.rd === app.rightDrag));
  inputButtons.forEach((b) => b.classList.toggle('active', b.dataset.input === app.input));
  panoModeButtons.forEach((b) => b.classList.toggle('active', b.dataset.pm === app.panoMode));
  const isSlab = app.panoMode === 'slab';
  slab.min = isSlab ? '2' : '0';
  slab.max = isSlab ? '30' : '5';
  slab.step = isSlab ? '1' : '0.5';
  slab.value = String(app.panoThickness());
  $('slab-label').textContent = isSlab ? 'Slab thickness' : 'Slice thickness';
  $('slab-val').textContent = `${app.panoThickness()} mm`;
  $('pano-off').textContent = `${app.panoOffset > 0 ? '+' : ''}${app.panoOffset.toFixed(1)} mm ${app.panoOffset > 0 ? '(buccal)' : app.panoOffset < 0 ? '(lingual)' : ''}`;
  spacing.value = String(app.crossSpacing);
  $('spacing-val').textContent = `${app.crossSpacing} mm`;
  if (document.activeElement !== defD) defD.value = String(app.defaultDiameter);
  defTapered.checked = app.defaultTapered;
  if (document.activeElement !== defL) defL.value = String(app.defaultLength);

  // update the list in place (keeps elements alive so double-click works)
  const seen = new Set<number>();
  app.implants.forEach((imp, idx) => {
    seen.add(imp.id);
    let li = listItems.get(imp.id);
    if (!li) {
      li = document.createElement('li') as HTMLLIElement;
      const id = imp.id;
      li.title = 'Click to select · double-click to rename';
      li.onclick = () => {
        const imp = app.implantById(id);
        const sl = imp && app.curves.length > 1 ? app.curveForImplant(imp) : null;
        if (sl) app.activateCurve(sl.id); // e.g. an upper implant shows the maxilla curve
        app.selectImplant(id, true);
      };
      li.ondblclick = () => {
        app.selectImplant(id, true);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            impName.focus();
            impName.select();
          }),
        );
      };
      listItems.set(id, li);
    }
    const ab = imp.abutment ? ` · MUA ${imp.abutment.angle}°/${imp.abutment.gingivalHeight}` : '';
    const dia = isTapered(imp) ? `Ø${imp.diameter.toFixed(1)}→${apicalDiameterOf(imp).toFixed(1)}` : `Ø${imp.diameter.toFixed(1)}`;
    const near = app.nerveDistances(imp).some((x) => x.d < NERVE_SAFETY_MM);
    const warn = near ? ' <span class="warn" title="Closer than 2 mm to the nerve">⚠</span>' : '';
    const eye = `<button class="vis-btn${imp.hidden ? ' off' : ''}" data-id="${imp.id}" data-kind="imp" title="${imp.hidden ? 'Show' : 'Hide'} this implant">${imp.hidden ? EYE_OFF : EYE}</button>`;
    const muaBtn = imp.abutment
      ? `<button class="vis-btn mua${imp.abutmentHidden ? ' off' : ''}" data-id="${imp.id}" data-kind="ab" title="${imp.abutmentHidden ? 'Show' : 'Hide'} the abutment (MUA)">MUA</button>`
      : '';
    const html = `<span class="vis">${eye}${muaBtn}</span><span class="nm">${escapeHtml(imp.name)}${warn}</span><span class="dim">${dia} × ${imp.length.toFixed(1)} · ${app.implantTilt(imp).toFixed(0)}°${ab}</span>`;
    if (li.innerHTML !== html) li.innerHTML = html;
    li.className = (imp.id === app.selectedId ? 'sel' : '') + (imp.hidden ? ' hidden-imp' : '');
    if (implantList.children[idx] !== li) implantList.insertBefore(li, implantList.children[idx] ?? null);
  });
  ($('btn-undo') as HTMLButtonElement).disabled = app.undoCount === 0;
  ($('btn-redo') as HTMLButtonElement).disabled = app.redoCount === 0;
  $('btn-show-all-implants').classList.toggle('hidden', !app.implants.some((i) => i.hidden || (i.abutment && i.abutmentHidden)));
  for (const [id, li] of listItems) {
    if (!seen.has(id)) {
      li.remove();
      listItems.delete(id);
    }
  }
  const sel = app.selectedImplant();
  $('implant-edit').classList.toggle('hidden', !sel);
  if (sel) {
    if (document.activeElement !== impName) impName.value = sel.name;
    if (document.activeElement !== impD) impD.value = sel.diameter.toFixed(1);
    const tapered = sel.apicalDiameter !== null;
    impTapered.checked = tapered;
    impAd.disabled = !tapered;
    impAd.max = String(sel.diameter);
    $('imp-ad-label').classList.toggle('muted', !tapered);
    if (document.activeElement !== impAd) impAd.value = apicalDiameterOf(sel).toFixed(1);
    if (document.activeElement !== impL) impL.value = sel.length.toFixed(1);
    const others = app.implants.filter((i) => i !== sel);
    const lines = [`Inclination ${app.implantTilt(sel).toFixed(1)}° from vertical`];
    if (sel.abutment) {
      const d = app.prostheticAxis(sel);
      const t = (Math.acos(Math.min(1, Math.abs(d[0] * app.frame[2][0] + d[1] * app.frame[2][1] + d[2] * app.frame[2][2]))) * 180) / Math.PI;
      lines.push(`Abutment axis ${t.toFixed(1)}° from vertical`);
    }
    const nerveLines = app.nerveDistances(sel).map(
      ({ nerve, d }) =>
        `<div class="${d < NERVE_SAFETY_MM ? 'warn' : ''}">${escapeHtml(nerve.name)}: ${d <= 0 ? 'touches the nerve!' : `${d.toFixed(1)} mm`}${
          d > 0 && d < NERVE_SAFETY_MM ? ` (&lt; ${NERVE_SAFETY_MM} mm)` : ''
        }</div>`,
    );
    $('imp-info').innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('') + nerveLines.join('');
    // parallel-to options
    const prev = parallelTo.value;
    parallelTo.innerHTML = others.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
    if (others.some((o) => String(o.id) === prev)) parallelTo.value = prev;
    $('parallel-row').classList.toggle('hidden', !others.length);
    // abutment
    impAxis.checked = sel.showProstheticAxis;
    abType.value = sel.abutment ? String(sel.abutment.angle) : 'none';
    abHeight.disabled = !sel.abutment;
    if (sel.abutment) abHeight.value = String(sel.abutment.gingivalHeight);
    $('ab-rot-row').classList.toggle('hidden', !sel.abutment);
    if (sel.abutment && document.activeElement !== abRot) abRot.value = String(sel.abutment.rotation);
    $('ab-rot-val').textContent = sel.abutment ? `${sel.abutment.rotation}°` : '';
  }
  placeParallel.checked = app.placeParallel;

  // angle table
  const rows = app.angleTable();
  $('angles-box').classList.toggle('hidden', !rows.length);
  const anyAb = rows.some((r) => r.abutment !== null);
  $('angle-table').innerHTML =
    `<tr><th>Implants</th><th>Angle</th>${anyAb ? '<th>Abutments</th>' : ''}</tr>` +
    rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.a.name.replace('Implant ', '#'))} – ${escapeHtml(r.b.name.replace('Implant ', '#'))}</td><td>${r.implant.toFixed(1)}°</td>${
            anyAb ? `<td>${r.abutment === null ? '–' : r.abutment.toFixed(1) + '°'}</td>` : ''
          }</tr>`,
      )
      .join('');

  // 3D
  vrButtons.forEach((b) => b.classList.toggle('active', b.dataset.vr === app.vr.mode));
  if (vol) {
    for (const r of [vrLo, vrHi]) {
      r.min = String(vol.min);
      r.max = String(vol.max);
      r.step = String(Math.max(1, Math.round((vol.max - vol.min) / 500)));
    }
  }
  if (document.activeElement !== vrLo) vrLo.value = String(app.vr.lo);
  if (document.activeElement !== vrHi) vrHi.value = String(app.vr.hi);
  if (document.activeElement !== vrLoNum) vrLoNum.value = String(Math.round(app.vr.lo));
  if (document.activeElement !== vrHiNum) vrHiNum.value = String(Math.round(app.vr.hi));

  refreshSegUi();
}

const segList = $('seg-list');
const cutList = $('cut-list');
const nerveList = $('nerve-list');
const rgbCss = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const toHex = (c: [number, number, number]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

/** Rebuild a small list only when its content changed (keeps clicks working). */
function setList(el: HTMLElement, items: { key: string; html: string; sel: boolean; onClick: () => void; onButton?: (name: string) => void }[]) {
  const key = JSON.stringify(items.map((i) => [i.key, i.html, i.sel]));
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = it.html;
    li.className = it.sel ? 'sel' : '';
    li.onclick = (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (btn && it.onButton) {
        e.stopPropagation();
        it.onButton(btn.dataset.act ?? '');
      } else it.onClick();
    };
    el.append(li);
  }
}

function refreshSegUi() {
  const seg = app.seg;
  const tool = app.segTool;
  setList(
    segList,
    seg.segments.map((g) => {
      const cm3 = (g.voxels * seg.voxelVolume) / 1000;
      const info = g.seeds.length ? `${cm3.toFixed(2)} cm³` : 'empty – click it';
      return {
        key: String(g.id),
        sel: g.id === app.activeSegId,
        html: `<span class="swatch" style="background:${rgbCss(g.color)}"></span><span class="name">${escapeHtml(g.name)}</span><span class="dim">${info}</span><button data-act="eye" class="${g.visible ? '' : 'off'}" title="Show / hide">${g.visible ? 'Hide' : 'Show'}</button>`,
        onClick: () => app.selectSegment(g.id),
        onButton: () => app.setSegmentVisible(g.id, !g.visible),
      };
    }),
  );
  const s = app.activeSegment();
  $('seg-edit').classList.toggle('hidden', !s);
  if (s) {
    if (document.activeElement !== segName) segName.value = s.name;
    if (document.activeElement !== segColor) segColor.value = toHex(s.color);
    const grow = $('btn-seg-grow');
    grow.classList.toggle('active', tool === 'grow');
    grow.textContent = tool === 'grow' ? 'Clicking… (Esc)' : 'Click to add';
    const thr = s.seeds.length ? `${Math.round(Math.min(...s.seeds.map((d) => d.lo)))}–${Math.round(Math.max(...s.seeds.map((d) => d.hi)))}` : '–';
    $('seg-info').textContent = `${s.seeds.length} click${s.seeds.length === 1 ? '' : 's'} · threshold ${thr} · ${((s.voxels * seg.voxelVolume) / 1000).toFixed(2)} cm³`;
    $('btn-seg-regrow').toggleAttribute('disabled', !s.seeds.length);
    $('btn-seg-undo').toggleAttribute('disabled', !s.seeds.length);
  }
  segShowUnseg.checked = app.showUnsegmented;
  segShow2d.checked = app.showSegOverlay;
  const cutBtn = $('btn-cut');
  cutBtn.classList.toggle('active', tool === 'cut');
  cutBtn.textContent = tool === 'cut' ? 'Drawing… (Esc)' : 'Draw cut';
  cutDepth.value = app.cutDepth === null ? '' : String(app.cutDepth);
  setList(
    cutList,
    seg.cuts.map((c, i) => ({
      key: String(c.id),
      sel: false,
      html: `<span class="swatch" style="background:rgb(255,122,40)"></span><span class="name">Cut ${i + 1} · ${c.kind === 'pano' ? 'panoramic' : escapeHtml(c.viewName)}</span><span class="dim">${c.depth === null ? 'whole' : `±${c.depth} mm`}</span><button data-act="del" title="Delete this cut">✕</button>`,
      onClick: () => {},
      onButton: () => app.deleteCut(c.id),
    })),
  );
  setList(
    nerveList,
    app.nerves.map((n) => ({
      key: String(n.id),
      sel: n.id === app.activeNerveId,
      html: `<span class="swatch" style="background:#ffd60a"></span><span class="name">${escapeHtml(n.name)}</span><span class="dim">${n.pts.length} pts${n.pts.length >= 2 ? ` · ${nerveLength(n).toFixed(0)} mm` : ''}</span><button data-act="eye" class="${n.visible ? '' : 'off'}" title="Show / hide">${n.visible ? 'Hide' : 'Show'}</button>`,
      onClick: () => app.selectNerve(n.id),
      onButton: () => {
        n.visible = !n.visible;
        app.changed();
      },
    })),
  );
  for (const side of ['right', 'left'] as const) {
    const b = $(`btn-nerve-${side}`);
    const active = tool === 'nerve' && app.activeNerve()?.side === side;
    b.classList.toggle('active', active);
    b.textContent = active ? 'Tracing… (Esc)' : `${app.nerves.some((n) => n.side === side) ? 'Edit' : 'Trace'} ${side} nerve`;
  }
  const n = app.activeNerve();
  $('nerve-edit').classList.toggle('hidden', !n);
  if (n) {
    if (document.activeElement !== nerveD) nerveD.value = n.diameter.toFixed(1);
    const tr = $('btn-nerve-trace');
    tr.classList.toggle('active', tool === 'nerve');
    tr.textContent = tool === 'nerve' ? 'Done' : 'Add points';
    $('nerve-info').textContent =
      n.pts.length < 2 ? 'Click at least two points along the canal.' : `${n.pts.length} points · ${nerveLength(n).toFixed(1)} mm long`;
    $('btn-nerve-undo').toggleAttribute('disabled', !n.pts.length);
  }
  for (const id of ['btn-cut', 'btn-nerve-right', 'btn-nerve-left']) $(id).toggleAttribute('disabled', !app.vol);
  document.querySelectorAll<HTMLButtonElement>('[data-seg-preset]').forEach((b) => b.toggleAttribute('disabled', !app.vol));
}
app.onStateChange = refreshUi;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

refreshUi();
app.onWindowChange();
app.requestRender();
