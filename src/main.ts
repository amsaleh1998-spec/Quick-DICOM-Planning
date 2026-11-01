import { App, Jaw, Mode, MprTool, RenderMode, saveInputPreference } from './app';
import { MUA_HEIGHTS } from './implant';
import { applyProjectState, buildProject, projectFileName, readProject } from './project';
import { initTrackpadGuide, showTrackpadGuide } from './tutorial';

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

async function loadFiles(files: File[]) {
  if (!files.length) return;
  if (files.length === 1 && /\.(zip|qdp)$/i.test(files[0].name)) {
    await openProject(files[0]);
    return;
  }
  try {
    showLoading('Reading files…', 0);
    const vol = await loadDicomFiles(files, (stage, f) => showLoading(`${stage}…`, f));
    app.setVolume(vol);
    setMode('mpr');
    setStatus(`Loaded ${vol.nx}×${vol.ny}×${vol.nz} voxels`);
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message, true);
  } finally {
    hideLoading();
  }
}

// ---- projects ----------------------------------------------------------------------
async function openProject(file: File) {
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
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message, true);
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
    setStatus('Demo phantom loaded – the occlusal plane is tilted a few degrees; try Ctrl+Alt+drag in the sagittal view.');
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
function setMode(m: Mode) {
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  mprLayout.classList.toggle('hidden', m !== 'mpr');
  planLayout.classList.toggle('hidden', m !== 'plan');
  $('panel-mpr').classList.toggle('hidden', m !== 'mpr');
  $('panel-plan').classList.toggle('hidden', m !== 'plan');
  moveView3d(m === 'mpr' ? mprLayout : planLayout);
  app.setMode(m);
}
tabButtons.forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));

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
  else app.startDrawing();
};
$('btn-clear-curve').onclick = () => app.clearCurve();
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
defL.onchange = () => (app.defaultLength = clampNum(defL.value, 4, 20, 10));
const impD = $<HTMLInputElement>('imp-d');
const impL = $<HTMLInputElement>('imp-l');
impD.oninput = () => {
  const imp = app.selectedImplant();
  if (imp && impD.value) {
    imp.diameter = clampNum(impD.value, 1, 10, imp.diameter);
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
$('btn-upright').onclick = () => app.selectedId !== null && app.uprightImplant(app.selectedId);
$('btn-deselect').onclick = () => app.selectImplant(null, false);
$('btn-delete').onclick = () => app.selectedId !== null && app.deleteImplant(app.selectedId);

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
  if (e.key === 'Escape') {
    if (app.drawing) app.cancelDrawing();
    else if (app.ruler) app.setRuler(false);
    else if (app.placing) {
      app.placing = null;
      app.changed();
    } else app.selectImplant(null, false);
  } else if (e.key === 'Enter' && app.drawing) {
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
  }
});

// ---- state -> UI -----------------------------------------------------------------
const implantList = $('implant-list');
function refreshUi() {
  const vol = app.vol;
  $('vol-info').innerHTML = vol
    ? [
        vol.info.patientName ? `<div>${escapeHtml(vol.info.patientName.replace(/\^/g, ' '))}</div>` : '',
        vol.info.seriesDescription ? `<div>${escapeHtml(vol.info.seriesDescription)}</div>` : '',
        `<div>${vol.nx} × ${vol.ny} × ${vol.nz} voxels</div>`,
        `<div>${vol.spacing.map((s) => s.toFixed(3)).join(' × ')} mm</div>`,
        `<div class="small">${escapeHtml(vol.info.source)}</div>`,
      ].join('')
    : 'Open a DICOM series (files or folder, or drag &amp; drop) or load the demo volume.';

  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === app.mprTool));
  const tilt = [0, 1, 2].map((i) => app.viewTiltDeg(i));
  $('mpr-status').textContent = vol
    ? `Tilt – axial ${tilt[0].toFixed(1)}°, coronal ${tilt[1].toFixed(1)}°, sagittal ${tilt[2].toFixed(1)}°` +
      (app.cropIsFull() ? '' : ' · crop active')
    : '';

  const draw = $('btn-draw-curve');
  draw.textContent = app.drawing ? 'Finish curve' : app.curve ? 'Redraw panoramic curve' : 'Draw panoramic curve';
  draw.classList.toggle('active', !!app.drawing);
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
  if (document.activeElement !== defL) defL.value = String(app.defaultLength);

  implantList.innerHTML = '';
  for (const imp of app.implants) {
    const li = document.createElement('li');
    li.className = imp.id === app.selectedId ? 'sel' : '';
    const ab = imp.abutment ? ` · MUA ${imp.abutment.angle}°/${imp.abutment.gingivalHeight}` : '';
    li.innerHTML = `<span>${escapeHtml(imp.name)}</span><span class="dim">Ø${imp.diameter.toFixed(1)} × ${imp.length.toFixed(1)} · ${app.implantTilt(imp).toFixed(0)}°${ab}</span>`;
    li.onclick = () => app.selectImplant(imp.id, true);
    implantList.append(li);
  }
  const sel = app.selectedImplant();
  $('implant-edit').classList.toggle('hidden', !sel);
  if (sel) {
    if (document.activeElement !== impD) impD.value = sel.diameter.toFixed(1);
    if (document.activeElement !== impL) impL.value = sel.length.toFixed(1);
    const others = app.implants.filter((i) => i !== sel);
    const lines = [`Inclination ${app.implantTilt(sel).toFixed(1)}° from vertical`];
    if (sel.abutment) {
      const d = app.prostheticAxis(sel);
      const t = (Math.acos(Math.min(1, Math.abs(d[0] * app.frame[2][0] + d[1] * app.frame[2][1] + d[2] * app.frame[2][2]))) * 180) / Math.PI;
      lines.push(`Abutment axis ${t.toFixed(1)}° from vertical`);
    }
    $('imp-info').innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
    // parallel-to options
    const prev = parallelTo.value;
    parallelTo.innerHTML = others.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
    if (others.some((o) => String(o.id) === prev)) parallelTo.value = prev;
    $('parallel-row').classList.toggle('hidden', !others.length);
    // abutment
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
}
app.onStateChange = refreshUi;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

refreshUi();
app.onWindowChange();
app.requestRender();
