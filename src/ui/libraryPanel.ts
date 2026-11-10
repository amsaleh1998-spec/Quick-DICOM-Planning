// Implants panel → Implant library: download the library into this browser so implants load
// instantly (also offline), see its version, update it when a newer one is published, or remove it.

import {
  DownloadedLibrary,
  LibrarySummary,
  cancelDownload,
  downloadLibrary,
  downloadedLibrary,
  implantIndex,
  loadImplantIndex,
  publishedLibrary,
  removeDownloadedLibrary,
  summarize,
} from '../implantLibrary';
import { refreshImplantsPanel } from './implantsPanel';
import { $, app } from './shell';

const box = $<HTMLDetailsElement>('lib-box');
const status = $('lib-status');
const badge = $('lib-badge');
const bar = $('lib-progress');
const btnDownload = $<HTMLButtonElement>('btn-lib-download');
const btnCancel = $<HTMLButtonElement>('btn-lib-cancel');
const btnRemove = $<HTMLButtonElement>('btn-lib-remove');

const mb = (b: number) => `${Math.max(1, Math.round(b / 1e6))} MB`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** The library on the server (null: not reachable); checked once per session. */
let published: LibrarySummary | null | undefined;
let busy: { done: number; total: number; library: number } | null = null;
let error = '';

function render() {
  const local: DownloadedLibrary | null = downloadedLibrary();
  const ix = implantIndex();
  const update = !!local && !!published && published.library > local.library;
  badge.classList.toggle('hidden', !update);
  bar.classList.toggle('hidden', !busy);
  btnCancel.classList.toggle('hidden', !busy);
  btnRemove.classList.toggle('hidden', !local || !!busy);
  const target = published ?? (ix ? summarize(ix) : null);
  const canDownload = !busy && !!target && (!local || update) && published !== null;
  btnDownload.classList.toggle('hidden', !canDownload);
  btnDownload.classList.toggle('primary', update);
  if (target) btnDownload.textContent = update ? `Update to version ${target.library} (${mb(target.bytes)})` : `Download (${mb(target.bytes)})`;

  let text: string;
  if (busy) {
    const pct = busy.total ? Math.min(100, Math.round((100 * busy.done) / busy.total)) : 0;
    (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', String(pct));
    text = `Downloading version ${busy.library} … ${mb(busy.done)} of ${mb(busy.total)}`;
  } else if (local) {
    text = `<b>Version ${local.library}</b> · downloaded ${day(local.date)} · ${local.systems} systems, ${mb(local.bytes)}. Implants load instantly, also offline.`;
    if (update) text += `<br><b>Version ${published!.library}</b> is available.`;
    else if (published === null) text += ' <span class="muted">(could not check for updates)</span>';
  } else if (target) {
    text = `<b>Version ${target.library}</b> · ${target.brands} brands, ${target.systems} systems. Each system is loaded from the server the first time it is used – download the library to have them all at once.`;
  } else text = 'The implant library cannot be reached (offline?) – generic implants only.';
  if (error) text += `<br><span class="error-text">${error}</span>`;
  status.innerHTML = text;
}

async function download() {
  error = '';
  const library = (published ?? summarize(implantIndex()!)).library;
  busy = { done: 0, total: 0, library };
  render();
  try {
    await downloadLibrary((done, total) => {
      busy = { done, total, library };
      render();
    });
    published = summarize(implantIndex()!);
    // implants of the plan take the (possibly updated) models' dimensions
    for (const imp of app.implants) if (imp.lib) app.applyModel(imp, imp.lib.id);
    app.onStatus(`Implant library version ${library} downloaded – implants load instantly.`);
  } catch (e) {
    const m = (e as Error).message;
    error = m === 'Download cancelled' ? m : /quota/i.test(m) ? 'Not enough storage space for the library.' : `Download failed: ${m}`;
  } finally {
    busy = null;
    refreshImplantsPanel();
    app.changed();
    render();
  }
}

btnDownload.onclick = () => void download();
btnCancel.onclick = () => cancelDownload();
btnRemove.onclick = async () => {
  await removeDownloadedLibrary();
  error = '';
  app.onStatus('Downloaded implant library removed – implants are loaded from the server as they are used.');
  render();
};

/** Show the state and check (once) whether a newer library is published. */
async function check() {
  await loadImplantIndex().catch(() => null);
  render();
  published = await publishedLibrary();
  render();
}
box.addEventListener('toggle', () => box.open && render());
void check();
