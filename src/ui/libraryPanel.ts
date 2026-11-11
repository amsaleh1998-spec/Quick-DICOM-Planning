// Implants panel → Implant library: no library is on the website – people import a library file
// (.qdplib) from their computer. It is kept in this browser (instant, also offline); a newer
// version imported later replaces it.

import { $, app } from './shell';
import { implantIndex, installLibrary, installedLibrary, loadImplantIndex, readLibraryFile, removeInstalledLibrary } from '../implantLibrary';
import { refreshImplantsPanel } from './implantsPanel';

const box = $<HTMLDetailsElement>('lib-box');
const status = $('lib-status');
const badge = $('lib-badge');
const bar = $('lib-progress');
const btnImport = $<HTMLButtonElement>('btn-lib-import');
const btnRemove = $<HTMLButtonElement>('btn-lib-remove');
const input = $<HTMLInputElement>('lib-input');

const mb = (b: number) => `${Math.max(1, Math.round(b / 1e6))} MB`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

let busy: number | null = null; // progress 0..1 while importing
let error = '';

function render() {
  const lib = installedLibrary();
  const ix = implantIndex();
  badge.classList.toggle('hidden', !!lib);
  bar.classList.toggle('hidden', busy === null);
  btnImport.classList.toggle('primary', !lib);
  btnImport.disabled = busy !== null;
  btnRemove.classList.toggle('hidden', !lib || busy !== null);
  let text: string;
  if (busy !== null) {
    const pct = Math.round(busy * 100);
    (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', String(pct));
    text = 'Importing the implant library …';
  } else if (lib) {
    const brands = ix?.brands.length;
    text = `<b>Version ${lib.library}</b> · imported ${day(lib.date)} · ${brands ? `${brands} brands, ` : ''}${lib.systems} systems, ${mb(lib.bytes)}. Kept in this browser: implants load instantly, also offline. Import a newer library file to update it.`;
  } else
    text =
      'No implant library in this browser – generic implants only. Import a library file (<b>.qdplib</b>) from your computer to plan with manufacturer implants; it stays in this browser.';
  if (error) text += `<br><span class="error-text">${error}</span>`;
  status.innerHTML = text;
}

/** Import a library file (also from a drop or the Implant selector). */
export async function importLibraryFile(file: File): Promise<boolean> {
  error = '';
  try {
    const lib = await readLibraryFile(file);
    const cur = installedLibrary();
    if (cur && lib.summary.library < cur.library && !confirm(`This file holds version ${lib.summary.library} of the implant library – older than version ${cur.library}, which is in use. Replace it with the older version?`)) return false;
    if (cur && lib.summary.library === cur.library && !confirm(`Version ${cur.library} of the implant library is already in use. Import it again?`)) return false;
    box.open = true;
    busy = 0;
    render();
    const meta = await installLibrary(lib, (f) => {
      busy = f;
      render();
    });
    // implants of the plan take the (possibly updated) models' dimensions
    for (const imp of app.implants) if (imp.lib) app.applyModel(imp, imp.lib.id);
    app.onStatus(`Implant library version ${meta.library} imported – ${meta.systems} systems, kept in this browser.`);
    return true;
  } catch (e) {
    const m = (e as Error).message;
    error = /quota/i.test(m) ? 'Not enough storage space in this browser for the library.' : m;
    box.open = true;
    return false;
  } finally {
    busy = null;
    refreshImplantsPanel();
    app.changed();
    render();
  }
}

/** Ask for a library file. */
export function chooseLibraryFile() {
  input.value = '';
  input.click();
}

btnImport.onclick = chooseLibraryFile;
input.onchange = () => {
  const f = input.files?.[0];
  if (f) void importLibraryFile(f);
};
btnRemove.onclick = async () => {
  if (!confirm('Remove the implant library from this browser? Plans keep their implants’ models; they are drawn as generic implants until a library is imported again.')) return;
  await removeInstalledLibrary();
  error = '';
  app.onStatus('Implant library removed from this browser.');
  refreshImplantsPanel();
  app.changed();
  render();
};

box.addEventListener('toggle', () => box.open && render());
void loadImplantIndex()
  .catch(() => null)
  .then(() => {
    // nothing imported yet: show where to do it
    if (!installedLibrary()) box.open = true;
    render();
  });
