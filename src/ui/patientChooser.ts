// A folder with scans of several patients: show them side by side (name, ID, birth date, scan,
// a picture of it) and let the user open one – or sort the files into a folder per patient.

import type { PatientGroup } from '../dicom';
import { formatDicomDate, formatPatientName, patientFolderName } from '../dicomMeta';
import { writeZip } from '../zip';
import { deliverFile } from './save';
import { escapeHtml, hideLoading, setStatus, showLoading } from './shell';

type DirHandle = FileSystemDirectoryHandle;
type DirPicker = (o: { id?: string; mode?: 'read' | 'readwrite'; startIn?: unknown }) => Promise<DirHandle>;

/** File names unique within one folder (files of nested folders may share a name). */
function uniqueNames(files: File[]): string[] {
  const used = new Set<string>();
  return files.map((f) => {
    const base = f.name || 'image';
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) {
      const dot = base.lastIndexOf('.');
      name = dot > 0 ? `${base.slice(0, dot)}-${k}${base.slice(dot)}` : `${base}-${k}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/**
 * Copy each patient's files into a folder of its own, in a folder the user chooses (the one the
 * scans were opened from, by default). The original files are left as they are. Where the browser
 * cannot write folders, each patient's files are handed over as a ZIP instead.
 */
async function sortIntoFolders(patients: PatientGroup[], startIn: unknown): Promise<string | null> {
  const total = patients.reduce((n, p) => n + p.files.length, 0);
  const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
  if (picker) {
    let dir: DirHandle;
    try {
      dir = await picker({ id: 'qdp-sort', mode: 'readwrite', ...(startIn ? { startIn } : {}) });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
      throw e;
    }
    let done = 0;
    try {
      for (let i = 0; i < patients.length; i++) {
        const p = patients[i];
        const sub = await dir.getDirectoryHandle(patientFolderName(p, i), { create: true });
        const names = uniqueNames(p.files);
        for (let k = 0; k < p.files.length; k++) {
          const fh = await sub.getFileHandle(names[k], { create: true });
          const w = await fh.createWritable();
          await w.write(p.files[k]);
          await w.close();
          showLoading('Creating patient folders…', ++done / total);
        }
      }
    } finally {
      hideLoading();
    }
    return `Created ${patients.length} patient folders in “${dir.name}” (${total} files copied – the original files are unchanged).`;
  }
  // no folder access in this browser: one ZIP per patient
  for (let i = 0; i < patients.length; i++) {
    const p = patients[i];
    const names = uniqueNames(p.files);
    showLoading(`Packing ${i + 1} of ${patients.length}…`, i / patients.length);
    const entries = await Promise.all(p.files.map(async (f, k) => ({ name: names[k], data: new Uint8Array(await f.arrayBuffer()) })));
    const zip = await writeZip(entries);
    hideLoading();
    const folder = patientFolderName(p, i);
    if (!(await deliverFile(zip, `${folder}.zip`, { description: 'Patient folder (ZIP)', accept: { 'application/zip': ['.zip'] } }))) return null;
  }
  return `Saved ${patients.length} patient folders as ZIP files (${total} files – the original files are unchanged).`;
}

/** Ask which patient to open: their index, or null (cancelled). */
export function choosePatient(patients: PatientGroup[], opts: { startIn?: unknown } = {}): Promise<number | null> {
  hideLoading();
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal-backdrop';
    const card = (p: PatientGroup, i: number) => {
      const name = formatPatientName(p.name) || 'Unnamed patient';
      const facts = [
        p.id ? `ID <b>${escapeHtml(p.id)}</b>` : '',
        p.birthDate ? `born ${escapeHtml(formatDicomDate(p.birthDate))}` : '',
        p.sex ? escapeHtml(p.sex) : '',
      ].filter(Boolean);
      const scans = p.series
        .map((s) => `${escapeHtml(s.description || 'Scan')} · ${s.slices} images · ${s.cols}×${s.rows}`)
        .join('<br>');
      return `<li class="pc-card">
        <canvas class="pc-preview" data-i="${i}" width="1" height="1" aria-hidden="true"></canvas>
        <div class="pc-info">
          <div class="pc-name">${escapeHtml(name)}</div>
          <div class="pc-facts">${facts.join(' · ') || '<span class="muted">no ID or birth date in the files</span>'}</div>
          <div class="pc-scan muted">${p.studyDate ? `Scan of ${escapeHtml(formatDicomDate(p.studyDate))}<br>` : ''}${scans}</div>
          <div class="pc-files muted">${p.files.length} files</div>
        </div>
        <button class="primary pc-open" data-i="${i}">Open</button>
      </li>`;
    };
    m.innerHTML = `
      <div class="modal patient-chooser" role="dialog" aria-modal="true" aria-labelledby="pc-title">
        <header><h2 id="pc-title">${patients.length} patients in these files</h2><button class="modal-close" title="Cancel (Esc)">×</button></header>
        <p class="muted">The folder holds scans of more than one patient. Open one – or sort the files into a folder per patient first.</p>
        <ul class="pc-list">${patients.map(card).join('')}</ul>
        <p class="pc-done hidden" role="status"></p>
        <footer>
          <button class="pc-cancel">Cancel</button><span class="grow"></span>
          <button class="pc-sort" title="Copy each patient's files into a folder of its own (named after the patient); the original files stay as they are">Create a folder for each patient…</button>
        </footer>
      </div>`;
    const done = (v: number | null) => {
      window.removeEventListener('keydown', onKey, true);
      m.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      done(null);
    };
    window.addEventListener('keydown', onKey, true);
    m.querySelector<HTMLButtonElement>('.modal-close')!.onclick = () => done(null);
    m.querySelector<HTMLButtonElement>('.pc-cancel')!.onclick = () => done(null);
    m.querySelectorAll<HTMLButtonElement>('.pc-open').forEach((b) => (b.onclick = () => done(Number(b.dataset.i))));
    const sortBtn = m.querySelector<HTMLButtonElement>('.pc-sort')!;
    sortBtn.onclick = async () => {
      sortBtn.disabled = true;
      try {
        const msg = await sortIntoFolders(patients, opts.startIn);
        if (msg) {
          const note = m.querySelector<HTMLElement>('.pc-done')!;
          note.textContent = `${msg} Open a patient below, or later from their own folder.`;
          note.classList.remove('hidden');
          setStatus(msg);
        }
      } catch (e) {
        setStatus(`Could not create the patient folders: ${(e as Error).message}`, true);
      } finally {
        sortBtn.disabled = false;
      }
    };
    document.body.append(m);
    m.querySelector<HTMLButtonElement>('.pc-open')!.focus();
    // pictures of each scan, to tell them apart at a glance
    patients.forEach(async (p, i) => {
      const img = await p.preview();
      const c = m.querySelector<HTMLCanvasElement>(`.pc-preview[data-i="${i}"]`);
      if (!img || !c) return;
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    });
  });
}
