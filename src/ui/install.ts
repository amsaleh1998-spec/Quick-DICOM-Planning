// "Install app", and the Windows / Mac helper that opens whole series with a double-click.

import { $, escapeHtml, setStatus } from './shell';

export const OS_WIN = /Windows/.test(navigator.userAgent);
export const OS_MAC = !OS_WIN && /Macintosh|Mac OS X/.test(navigator.userAgent) && navigator.maxTouchPoints < 2;
export const HELPER_LOG = OS_MAC
  ? '~/Library/Application Support/QuickDICOMPlanning/log.txt'
  : '%LOCALAPPDATA%\\QuickDICOMPlanning\\log.txt';

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
  setStatus('Installed. Double-click a .dcm file in Explorer (choose QDP the first time) to open it here.');
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
export function showHelperHelp() {
  showInfoModal('Open whole scans with a double-click', helperSection());
  bindHelperButtons();
}
function showInstallHelp() {
  const ua = navigator.userAgent;
  const isEdge = /Edg\//.test(ua);
  const isChrome = !isEdge && /Chrome\//.test(ua) && !/OPR\//.test(ua);
  const inFrame = window.top !== window.self;
  const appUrl = 'https://quickdicom.app/';
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
        (older Chrome versions: <b>Install QDP…</b> directly in the menu).</li>
    </ol>`;
  } else {
    steps = `<p>This browser can't install web apps that open files. Open <a href="${appUrl}" target="_blank" rel="noopener">${appUrl}</a>
      in <b>Google Chrome</b> or <b>Microsoft Edge</b> (Edge is built into Windows) and click <b>Install app</b> there.</p>`;
  }
  const after = OS_MAC
    ? `After installing, select any <b>.dcm</b> file in Finder → <b>File → Get Info</b> (⌘I) → <b>Open with</b>:
        <b>QDP</b> → <b>Change All…</b>`
    : `After installing, right-click any <b>.dcm</b> file in Windows Explorer → <b>Open with</b> →
        <b>Choose another app</b> → <b>QDP</b> (the installed app) and tick <b>Always use this app</b>.`;
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
