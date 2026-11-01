import { App, Mode, MprTool } from './app';
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
  app.panoSlab = Number(slab.value);
  app.changed();
};
spacing.oninput = () => {
  app.crossSpacing = Number(spacing.value);
  app.changed();
};
$('btn-add-implant').onclick = () => {
  if (!app.vol) return;
  if (app.placing) {
    app.placing = false;
    app.changed();
  } else app.startPlacing();
};
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
  if (imp && impL.value) {
    imp.length = clampNum(impL.value, 2, 30, imp.length);
    app.changed();
  }
};
$('btn-upright').onclick = () => app.selectedId !== null && app.uprightImplant(app.selectedId);
$('btn-deselect').onclick = () => app.selectImplant(null, false);
$('btn-delete').onclick = () => app.selectedId !== null && app.deleteImplant(app.selectedId);

function clampNum(v: string, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// ---- keyboard ---------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'Escape') {
    if (app.drawing) app.cancelDrawing();
    else if (app.placing) {
      app.placing = false;
      app.changed();
    } else app.selectImplant(null, false);
  } else if (e.key === 'Enter' && app.drawing) {
    app.finishCurve();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && app.selectedId !== null && app.mode === 'plan') {
    app.deleteImplant(app.selectedId);
  } else if (e.key === 'f' || e.key === 'F') {
    app.fitAll();
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
  const add = $('btn-add-implant');
  add.textContent = app.placing ? 'Click in a view to place… (Esc)' : 'Add implant';
  add.classList.toggle('active', app.placing);
  slab.value = String(app.panoSlab);
  $('slab-val').textContent = `${app.panoSlab} mm`;
  spacing.value = String(app.crossSpacing);
  $('spacing-val').textContent = `${app.crossSpacing} mm`;
  if (document.activeElement !== defD) defD.value = String(app.defaultDiameter);
  if (document.activeElement !== defL) defL.value = String(app.defaultLength);

  implantList.innerHTML = '';
  for (const imp of app.implants) {
    const li = document.createElement('li');
    li.className = imp.id === app.selectedId ? 'sel' : '';
    li.innerHTML = `<span>${escapeHtml(imp.name)}</span><span class="dim">Ø${imp.diameter.toFixed(1)} × ${imp.length.toFixed(1)}</span>`;
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
    for (const o of others) lines.push(`∠ to ${o.name}: ${app.implantAngle(sel, o).toFixed(1)}°`);
    $('imp-info').innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  }
}
app.onStateChange = refreshUi;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

refreshUi();
app.onWindowChange();
app.requestRender();
