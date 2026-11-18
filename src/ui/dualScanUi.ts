// Dual scan protocol (Scans panel → Dual scan): open the CBCT of the denture alone, find its
// radiopaque markers there and in the patient's CBCT, match them, let the user set the acrylic
// threshold (previewed), and add the segmented denture as a scan placed by the markers.

import { autoDentureThreshold, autoMarkerThreshold, dentureMask, dentureSurface, findMarkers, matchMarkers, Marker, MarkerMatch } from '../dualScan';
import { loadDicomFiles } from '../dicom';
import { SCAN_KINDS, createScan } from '../scans';
import { MeshEditor, guardedCancel } from './meshEditor';
import type { Volume } from '../volume';
import type { Vec3 } from '../math';
import { isZipFile, zipEntriesAsFiles } from '../zip';
import { choosePatient } from './patientChooser';
import { $, app, hideLoading, setStatus, showLoading } from './shell';

const filesInput = $<HTMLInputElement>('dual-files');
const folderInput = $<HTMLInputElement>('dual-folder');

const DENTURE_COLOUR = [...SCAN_KINDS.find((k) => k.kind === 'denture')!.color] as [number, number, number];

/** Most candidates the matcher looks at in the patient's scan (the most marker-like ones). */
const MAX_CANDIDATES = 40;

interface Found {
  tD: number;
  D: Marker[];
  P: Marker[];
  tP: number;
  match: MarkerMatch | null;
}

/** Markers in both scans and their match; the patient's scan is tried at a few thresholds. */
export function findAndMatch(denture: Volume, patient: Volume, tD = autoMarkerThreshold(denture)): Found {
  const D = findMarkers(denture, tD);
  const medD = D.length ? D.map((m) => m.mm3).sort((a, b) => a - b)[D.length >> 1] : 1;
  let best: Found = { tD, D, P: [], tP: tD, match: null };
  const tried = new Set<number>();
  for (const tP of [tD, autoMarkerThreshold(patient), Math.round((tD + autoMarkerThreshold(patient)) / 2)]) {
    if (tried.has(tP)) continue;
    tried.add(tP);
    let P = findMarkers(patient, tP);
    if (P.length > MAX_CANDIDATES) P = [...P].sort((a, b) => Math.abs(Math.log(a.mm3 / medD)) - Math.abs(Math.log(b.mm3 / medD))).slice(0, MAX_CANDIDATES);
    const match = D.length >= 3 && P.length >= 3 ? matchMarkers(D.map((m) => m.p), P.map((m) => m.p)) : null;
    const n = match?.pairs.length ?? 0, bn = best.match?.pairs.length ?? 0;
    if (!best.P.length || n > bn || (n === bn && n && match!.rms < best.match!.rms)) best = { tD, D, P, tP, match };
    if (match && match.pairs.length === D.length) break;
  }
  return best;
}

$('btn-dual-scan').onclick = () => {
  if (!app.vol) {
    setStatus('Open the patient’s CBCT (with the denture in the mouth) first – the denture is placed in it.', true);
    return;
  }
  openSourceDialog();
};

/** First step: where the denture CBCT comes from. */
function openSourceDialog() {
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.innerHTML = `
    <div class="modal dual-scan" role="dialog" aria-modal="true" aria-labelledby="ds-title">
      <header><h2 id="ds-title">Dual scan – denture CBCT</h2><button class="modal-close" title="Cancel (Esc)">×</button></header>
      <p class="intro">Open the CBCT of the <b>denture alone</b> (scanned with its radiopaque markers). Its markers are matched with the ones in this patient's CBCT, and the denture – segmented from its own scan – is placed where it sits in the mouth.</p>
      <div class="ds-pick">
        <button class="primary ds-files">DICOM files or ZIP…</button>
        <button class="ds-folder">Folder…</button>
      </div>
    </div>`;
  const done = () => {
    window.removeEventListener('keydown', onKey, true);
    m.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    done();
  };
  window.addEventListener('keydown', onKey, true);
  m.querySelector<HTMLButtonElement>('.modal-close')!.onclick = done;
  m.querySelector<HTMLButtonElement>('.ds-files')!.onclick = () => {
    done();
    filesInput.click();
  };
  m.querySelector<HTMLButtonElement>('.ds-folder')!.onclick = () => {
    done();
    folderInput.click();
  };
  document.body.append(m);
  m.querySelector<HTMLButtonElement>('.ds-files')!.focus();
}

for (const input of [filesInput, folderInput])
  input.onchange = async () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) await loadDenture(files);
  };

/** Read the denture CBCT (files, a folder's files or a ZIP) – without touching the open case. */
export async function loadDenture(files: File[]) {
  const patient = app.vol;
  if (!patient) return;
  let denture: Volume;
  try {
    if (files.length === 1 && (await isZipFile(files[0]))) {
      showLoading('Unpacking…', 0);
      files = await zipEntriesAsFiles(files[0]);
    }
    showLoading('Reading the denture scan…', 0);
    denture = await loadDicomFiles(files, (stage, f) => showLoading(`Denture scan: ${stage}…`, f), {
      choosePatient: async (patients) => {
        hideLoading();
        const pick = await choosePatient(patients);
        if (pick !== null) showLoading('Reading the denture scan…', 1);
        return pick;
      },
    });
  } catch (e) {
    hideLoading();
    if ((e as Error).name !== 'AbortError') setStatus(`Denture scan: ${(e as Error).message}`, true);
    return;
  }
  showLoading('Finding the radiopaque markers…', 0.5);
  await new Promise((r) => setTimeout(r, 30));
  let found: Found;
  try {
    found = findAndMatch(denture, patient);
  } finally {
    hideLoading();
  }
  showDualScan(denture, patient, found);
}

// ---- the result dialog -----------------------------------------------------------------------

/** Maximum projections of the denture scan from above (z) and from the front (y), grey 0–255. */
function projections(vol: Volume, lo: number, hi: number) {
  const { nx, ny, nz, data } = vol;
  const top = new Int16Array(nx * ny).fill(-32768);
  const front = new Int16Array(nx * nz).fill(-32768);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const row = j * nx + k * nx * ny;
      for (let i = 0; i < nx; i++) {
        const v = data[row + i];
        if (v > top[i + j * nx]) top[i + j * nx] = v;
        if (v > front[i + k * nx]) front[i + k * nx] = v;
      }
    }
  const g = (v: number) => Math.max(0, Math.min(255, ((v - lo) / (hi - lo)) * 255));
  return { top: Uint8ClampedArray.from(top, g), front: Uint8ClampedArray.from(front, g) };
}

function showDualScan(denture: Volume, patient: Volume, found: Found) {
  const { nx, ny, nz, spacing: sp } = denture;
  let tAcrylic = autoDentureThreshold(denture, found.tD);
  const lo = Math.max(denture.min, -1000);
  const proj = projections(denture, lo, found.tD);
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.innerHTML = `
    <div class="modal dual-scan dual-big" role="dialog" aria-modal="true" aria-labelledby="ds-title">
      <header><h2 id="ds-title">Dual scan – segment the denture and place it</h2><button class="modal-close" title="Cancel (Esc)">×</button></header>
      <div class="ds-body">
        <aside class="ds-side">
          <section>
            <h3>Markers</h3>
            <p class="ds-result" role="status"></p>
            <div class="ds-views">
              <figure><canvas class="ds-top"></canvas><figcaption>Denture scan from above</figcaption></figure>
              <figure><canvas class="ds-front"></canvas><figcaption>From the front</figcaption></figure>
            </div>
            <div class="ds-legend muted small"><span class="ds-dot ok"></span> matched <span class="ds-dot miss"></span> not found in the patient's CBCT <span class="ds-swatch"></span> denture</div>
            <details>
              <summary>Marker threshold</summary>
              <label class="ds-mrow">Threshold <input class="ds-mthr" type="number" step="10" /> <button class="ds-refind">Find again</button></label>
              <p class="muted small">Markers are small, very bright blobs (0.15–60 mm³, under 7 mm across), found in both scans and matched by the distances between them. At least 3 are needed; 5 or more, spread around the arch, give a reliable placement.</p>
            </details>
          </section>
          <section>
            <h3>Segmentation</h3>
            <label class="ds-thr-row">Denture (acrylic) threshold <output class="ds-thr-v"></output></label>
            <input class="ds-thr" type="range" step="1" />
            <p class="muted small">The 3D denture follows the slider. Your edits are applied again to the new segmentation.</p>
          </section>
        </aside>
        <div class="ds-3d"><span class="ds-busy hidden">Segmenting…</span></div>
      </div>
      <footer>
        <button class="ds-cancel">Cancel</button><span class="grow"></span>
        <button class="primary ds-create" title="Add the denture as a scan, placed in this patient's CBCT by its markers">Place in the patient’s CBCT</button>
      </footer>
    </div>`;
  const $m = <T extends HTMLElement>(s: string) => m.querySelector<T>(s)!;
  const result = $m<HTMLElement>('.ds-result');
  const thr = $m<HTMLInputElement>('.ds-thr');
  const thrV = $m<HTMLOutputElement>('.ds-thr-v');
  const mthr = $m<HTMLInputElement>('.ds-mthr');
  const create = $m<HTMLButtonElement>('.ds-create');
  const cTop = $m<HTMLCanvasElement>('.ds-top');
  const cFront = $m<HTMLCanvasElement>('.ds-front');
  const busy = $m<HTMLElement>('.ds-busy');
  thr.min = String(Math.round(lo));
  thr.max = String(found.tD - 1);
  thr.value = String(tAcrylic);
  thrV.textContent = `${tAcrylic}`;
  mthr.value = String(found.tD);
  /** the slider's track is filled up to its thumb (style.css) */
  const fill = () => thr.style.setProperty('--fill', `${((Number(thr.value) - Number(thr.min)) / Math.max(1, Number(thr.max) - Number(thr.min))) * 100}%`);
  fill();

  // the 3D denture and its editor
  const editor = new MeshEditor({ pos: new Float32Array(0), idx: new Uint32Array(0), col: null }, { color: DENTURE_COLOUR });
  $m('.ds-3d').prepend(editor.view);
  $m('.ds-body').append(editor.tools);
  /** the base mesh in the editor is the full-resolution segmentation at tAcrylic */
  let fullAt: number | null = null;
  let gen = 0;
  let firstShown = false;
  const segment = async (full: boolean) => {
    const my = ++gen;
    busy.classList.remove('hidden');
    busy.textContent = full ? 'Segmenting…' : 'Preview…';
    await new Promise((r) => setTimeout(r, 0));
    if (my !== gen) return;
    const t = tAcrylic;
    const mesh = await dentureSurface(denture, t, undefined, full ? 30_000_000 : 2_500_000);
    if (my !== gen) return; // the slider moved on
    editor.setBase(mesh, !firstShown);
    firstShown = true;
    fullAt = full ? t : null;
    busy.classList.add('hidden');
    refreshCreate();
  };
  const refreshCreate = () => {
    create.disabled = (found.match?.pairs.length ?? 0) < 3 || !editor.mesh.idx.length;
  };
  editor.onChange = refreshCreate;

  const showResult = () => {
    const { D, P, match } = found;
    const n = match?.pairs.length ?? 0;
    refreshCreate();
    if (D.length < 3) result.innerHTML = `<b class="err">Only ${D.length} marker${D.length === 1 ? '' : 's'} found in the denture scan</b> – at least 3 are needed. Try a lower marker threshold below.`;
    else if (n < 3) result.innerHTML = `<b class="err">The markers could not be matched</b> – ${D.length} in the denture scan, ${P.length} candidate${P.length === 1 ? '' : 's'} in this CBCT. Is the denture worn in this scan? Try another marker threshold below.`;
    else
      result.innerHTML = `<b class="ok">${n} of ${D.length} markers matched</b> · fit ${match!.rms.toFixed(2)} mm${n < 5 ? ' · <span class="warn">few markers – check the placement</span>' : ''}${match!.rms > 0.5 ? ' · <span class="warn">loose fit – check the placement</span>' : ''}`;
  };

  // previews: the projections, the segmented denture tinted, the markers circled
  const sx = sp[0], sy = sp[1], sz = sp[2];
  const scale = Math.min(268 / (nx * sx), 190 / (ny * sy));
  const setup = (c: HTMLCanvasElement, w: number, h: number, hmm: number) => {
    c.width = w;
    c.height = h;
    c.style.width = `${Math.round(nx * sx * scale)}px`;
    c.style.height = `${Math.round(hmm * scale)}px`;
  };
  setup(cTop, nx, ny, ny * sy);
  setup(cFront, nx, nz, nz * sz);
  const draw = () => {
    const mask = dentureMask(denture, tAcrylic, 1_500_000);
    const st = mask.step;
    const paint = (c: HTMLCanvasElement, grey: Uint8ClampedArray, w: number, h: number, inMask: (i: number, j: number) => boolean, flipY: boolean) => {
      const img = new ImageData(w, h);
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++) {
          const g = grey[i + j * w];
          const o = 4 * (i + (flipY ? h - 1 - j : j) * w);
          const t = inMask(i, j);
          img.data[o] = t ? g * 0.55 + 244 * 0.45 : g;
          img.data[o + 1] = t ? g * 0.55 + 140 * 0.45 : g;
          img.data[o + 2] = t ? g * 0.55 + 180 * 0.45 : g;
          img.data[o + 3] = 255;
        }
      c.getContext('2d')!.putImageData(img, 0, 0);
    };
    // projected masks
    const topM = new Uint8Array(mask.nx * mask.ny), frontM = new Uint8Array(mask.nx * mask.nz);
    for (let c = 0; c < mask.nz; c++)
      for (let b = 0; b < mask.ny; b++)
        for (let a = 0; a < mask.nx; a++)
          if (mask.mask[a + b * mask.nx + c * mask.nx * mask.ny]) {
            topM[a + b * mask.nx] = 1;
            frontM[a + c * mask.nx] = 1;
          }
    paint(cTop, proj.top, nx, ny, (i, j) => !!topM[((i / st) | 0) + ((j / st) | 0) * mask.nx], false);
    paint(cFront, proj.front, nx, nz, (i, k) => !!frontM[((i / st) | 0) + ((k / st) | 0) * mask.nx], true);
    // markers
    const matched = new Set(found.match?.pairs.map(([a]) => a) ?? []);
    const ring = (c: HTMLCanvasElement, x: number, y: number, ok: boolean) => {
      const g = c.getContext('2d')!;
      g.lineWidth = Math.max(1, 1.6 / scale / sx);
      g.strokeStyle = ok ? '#4ade80' : '#fb923c';
      g.beginPath();
      g.arc(x, y, 2.4 / sx, 0, Math.PI * 2);
      g.stroke();
    };
    found.D.forEach((d, i) => {
      const p: Vec3 = d.p;
      ring(cTop, p[0] / sx, p[1] / sy, matched.has(i));
      ring(cFront, p[0] / sx, nz - 1 - p[2] / sz, matched.has(i));
    });
  };
  // the slider: a quick preview while it moves, full detail when it is let go
  let previewTimer = 0;
  thr.oninput = () => {
    tAcrylic = Number(thr.value);
    thrV.textContent = `${tAcrylic}`;
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      draw();
      void segment(false);
    }, 40);
  };
  thr.onchange = () => {
    tAcrylic = Number(thr.value);
    clearTimeout(previewTimer);
    draw();
    void segment(true);
  };
  $m<HTMLButtonElement>('.ds-refind').onclick = () => {
    const t = Number(mthr.value);
    if (!Number.isFinite(t)) return;
    found = findAndMatch(denture, patient, Math.round(t));
    thr.max = String(found.tD - 1);
    if (tAcrylic >= found.tD) {
      tAcrylic = autoDentureThreshold(denture, found.tD);
      thr.value = String(tAcrylic);
      thrV.textContent = `${tAcrylic}`;
      void segment(true);
    }
    fill();
    showResult();
    draw();
  };

  const done = () => {
    gen++; // drop a segmentation on its way
    window.removeEventListener('keydown', onKey, true);
    clearTimeout(previewTimer);
    editor.dispose();
    m.remove();
  };
  const cancel = guardedCancel($m<HTMLButtonElement>('.ds-cancel'), () => editor.edited, done);
  const onKey = (e: KeyboardEvent) => {
    if (!editor.key(e)) {
      if (e.key !== 'Escape') return;
      cancel();
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', onKey, true);
  $m<HTMLButtonElement>('.modal-close').onclick = cancel;
  $m<HTMLButtonElement>('.ds-cancel').onclick = cancel;
  create.onclick = async () => {
    const match = found.match;
    if (!match || match.pairs.length < 3) return;
    create.disabled = true;
    try {
      // the full-resolution segmentation (if the last one was a preview), with the edits
      if (fullAt !== tAcrylic) {
        showLoading('Segmenting the denture…', 0.5);
        await segment(true);
      }
    } finally {
      hideLoading();
    }
    const mesh = editor.mesh;
    if (!mesh.idx.length) {
      refreshCreate();
      return;
    }
    const scan = createScan(denture.info.seriesDescription || 'Denture CBCT', mesh, 'denture');
    scan.transform = match.T;
    scan.placement = { method: 'markers', rms: match.rms, markers: match.pairs.length };
    app.scans.push(scan);
    app.activeScanId = scan.id;
    done();
    app.changed();
    setStatus(`Denture placed by ${match.pairs.length} radiopaque markers (fit ${match.rms.toFixed(2)} mm) – ${(mesh.idx.length / 3).toLocaleString()} triangles.`);
  };
  document.body.append(m);
  // (for the browser tests and the demo recording: the window's mesh editor)
  (m as unknown as { __editor: MeshEditor }).__editor = editor;
  showResult();
  draw();
  void segment(true);
  create.focus();
}
