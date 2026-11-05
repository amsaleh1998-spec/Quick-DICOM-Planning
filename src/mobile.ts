/**
 * Simplified phone UI: one full-screen view at a time, touch gestures, and a
 * settings sheet. A viewer for CBCT scans and plans made on the desktop.
 */
import { App } from './app';
import { loadDicomFiles, setMaxVoxels } from './dicom';
import { apicalDiameterOf, isTapered } from './implant';
import { NERVE_SAFETY_MM } from './nerve';
import { applyProjectState, readProject } from './project';
import { setLabelGridBudget } from './segment';
import { setUiPreference } from './uiMode';
import { createPhantom } from './volume';
import { View3D } from './views/View3D';

// Phones have far less memory and GPU power than desktops.
setMaxVoxels(110_000_000);
setLabelGridBudget(24_000_000);
View3D.textureBudget = 32_000_000;
View3D.pixelBudget = 380_000;

if (new URLSearchParams(location.search).get('ui') === 'mobile') setUiPreference(null);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const app = new App();
app.touchUi = true;
app.input = 'mouse';
// exposed for debugging / automated tests
(window as unknown as { app: App }).app = app;

// ---- layouts ---------------------------------------------------------------------
/** MPR: 2×2 grid (axial, coronal, sagittal, 3D) · Plan: axial + panoramic + cross-sections · 3D: full screen */
type Tab = 'mpr' | 'plan' | '3d';
const LAYOUT: Record<Tab, HTMLElement> = { mpr: $('m-layout-mpr'), plan: $('m-layout-plan'), '3d': $('m-layout-3d') };
const AREAS = ['ax', 'co', 'sa'];
app.mprViews.forEach((v, i) => {
  v.el.style.gridArea = AREAS[i];
  LAYOUT.mpr.append(v.el);
});
app.planAxial.el.style.gridArea = 'pax';
app.pano.el.style.gridArea = 'pano';
app.crossViews.forEach((v, i) => {
  v.el.style.gridArea = `cs${i + 1}`;
  v.title = `CS ${i + 1}`; // narrow on a phone
});
LAYOUT.plan.append(app.planAxial.el, app.pano.el, ...app.crossViews.map((v) => v.el));
app.view3d.el.style.gridArea = 'v3d';
LAYOUT.mpr.append(app.view3d.el);

const HINTS: Record<Tab, string> = {
  mpr: 'Swipe in a view to scroll · tap to move the crosshair · pinch to zoom · ⤢ = full screen · “Rotate axes” to tilt the planes',
  plan: 'Tap “Draw curve”, then tap along the arch in the axial view · swipe a cross-section to move along the arch',
  '3d': 'Drag to rotate · pinch to zoom · two fingers to move · double-tap to reset',
};
let tab: Tab = 'mpr';
const hinted = new Set<Tab>();
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#m-tabs button'));

/** The 3D view lives in the MPR grid or alone in the 3D tab. */
function place3d(target: HTMLElement) {
  const el = app.view3d.el;
  if (el.parentElement === target) return;
  if (el.classList.contains('max')) {
    el.classList.remove('max');
    el.parentElement?.classList.remove('has-max');
  }
  target.append(el);
}

function setTab(t: Tab) {
  tab = t;
  app.cancelPendingMeasurement();
  place3d(t === '3d' ? LAYOUT['3d'] : LAYOUT.mpr);
  for (const [k, el] of Object.entries(LAYOUT)) el.classList.toggle('hidden', k !== t);
  if (t !== 'mpr' && app.mprTool === 'rotate') app.mprTool = 'navigate';
  if (t === 'plan') app.setMode('plan');
  else if (app.drawing) app.cancelDrawing();
  app.activeView = t === 'plan' ? app.planAxial : t === '3d' ? app.view3d : app.mprViews[0];
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.v === t));
  $('m-tools').classList.toggle('hidden', t === '3d');
  document.querySelectorAll<HTMLElement>('.m-tools-row').forEach((r) => r.classList.toggle('hidden', r.dataset.for !== t));
  if (!hinted.has(t)) {
    hinted.add(t);
    showHint(HINTS[t]);
  }
  refresh();
  app.requestRender();
}
tabButtons.forEach((b) => (b.onclick = () => setTab(b.dataset.v as Tab)));

// ---- MPR tools: rotate the planes -------------------------------------------------
$('m-rotate').onclick = () => {
  app.mprTool = app.mprTool === 'rotate' ? 'navigate' : 'rotate';
  if (app.mprTool === 'rotate') app.setRuler(false);
  if (app.mprTool === 'rotate') showHint('Drag around the centre of a view to tilt the other two planes · tap “Rotate axes” again when done');
  app.changed();
};
$('m-straighten').onclick = () => app.straightenViews();
$('m-reset-rot').onclick = () => app.resetRotation();

// ---- Plan tools: panoramic curve ----------------------------------------------------
$('m-draw').onclick = () => {
  if (app.drawing) {
    if (app.drawing.length < 2) {
      toast('Tap at least two points along the arch first.', true);
      return;
    }
    app.finishCurve();
    showHint('Swipe a cross-section to move along the arch · drag a curve point to adjust it · swipe the axial view to change its level');
  } else {
    app.setRuler(false);
    app.startDrawing();
    showHint('Drag your finger (or tap point by point) along the arch in the axial view, from the patient’s right to left, then tap “Done”');
  }
};
$('m-undo-pt').onclick = () => {
  if (app.drawing?.length) {
    app.drawing.pop();
    app.changed();
  }
};
$('m-clear-curve').onclick = () => app.clearCurve();

// ---- ruler (both tool strips) ---------------------------------------------------------
document.querySelectorAll<HTMLButtonElement>('.m-ruler').forEach(
  (b) =>
    (b.onclick = () => {
      const on = !app.ruler;
      if (on) app.mprTool = 'navigate';
      app.setRuler(on);
      if (on) showHint('Drag from the start to the end point (or tap the start, then the end) · drag a ruler end to adjust · double-tap a ruler to delete it');
    }),
);
document.querySelectorAll<HTMLButtonElement>('.m-clear-rulers').forEach((b) => (b.onclick = () => app.clearMeasurements()));

// ---- messages / loading -----------------------------------------------------------
let toastTimer = 0;
function toast(msg: string, error = false) {
  const el = $('m-toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), error ? 6000 : 3500);
}
let hintTimer = 0;
function showHint(msg: string) {
  const el = $('m-hint');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => el.classList.add('hidden'), 4500);
}
$('m-toast').onclick = () => $('m-toast').classList.add('hidden');

function showLoading(text: string, f: number) {
  $('m-loading').classList.remove('hidden');
  $('m-loading-text').textContent = text;
  $('m-loading-bar').style.width = `${Math.round(f * 100)}%`;
}
const hideLoading = () => $('m-loading').classList.add('hidden');
app.onStatus = (msg, error) => error && toast(msg, true);
app.onBusy = (text) => (text ? showLoading(text, 0.6) : hideLoading());

// ---- opening ---------------------------------------------------------------------------
function afterLoad() {
  $('m-empty').classList.add('hidden');
  $('m-tabs').classList.remove('hidden');
  $('m-settings').removeAttribute('disabled');
  app.mprTool = 'navigate';
  setTab(app.curve ? 'plan' : 'mpr');
}

async function openProject(file: File) {
  try {
    showLoading('Opening project…', 0.2);
    const buf = await file.arrayBuffer();
    showLoading('Unpacking project…', 0.5);
    const { volume, file: pf } = await readProject(buf);
    app.setVolume(volume);
    applyProjectState(app, pf);
    // the desktop layout (maximized view, zoom per view) does not apply on a phone
    for (const el of Object.values(LAYOUT)) el.classList.remove('has-max');
    for (const v of app.views) v.el.classList.remove('max');
    app.fitAll();
    afterLoad();
    toast(`Project opened (saved ${new Date(pf.savedAt).toLocaleDateString()})`);
  } catch (e) {
    console.error(e);
    toast((e as Error).message, true);
  } finally {
    // segment rebuilding shows its own progress
    if (!app.seg.segments.some((s) => s.seeds.length)) hideLoading();
  }
}

async function loadFiles(files: File[]) {
  if (!files.length) return;
  if (files.length === 1 && /\.(zip|qdp)$/i.test(files[0].name)) return openProject(files[0]);
  try {
    showLoading('Reading files…', 0);
    const vol = await loadDicomFiles(files, (stage, f) => showLoading(`${stage}…`, f));
    app.setVolume(vol);
    afterLoad();
    toast(`${vol.nx}×${vol.ny}×${vol.nz} voxels loaded`);
  } catch (e) {
    console.error(e);
    toast((e as Error).message, true);
  } finally {
    hideLoading();
  }
}

async function loadDemo() {
  showLoading('Generating demo scan…', 0.3);
  await new Promise((r) => setTimeout(r, 40));
  try {
    app.setVolume(createPhantom());
    afterLoad();
  } finally {
    hideLoading();
  }
}

const fileInput = $<HTMLInputElement>('m-file-input');
const projectInput = $<HTMLInputElement>('m-project-input');
fileInput.onchange = () => {
  loadFiles(Array.from(fileInput.files ?? []));
  fileInput.value = '';
};
projectInput.onchange = () => {
  const f = projectInput.files?.[0];
  if (f) openProject(f);
  projectInput.value = '';
};
const pickFiles = () => fileInput.click();
const pickProject = () => projectInput.click();
$('m-empty-files').onclick = pickFiles;
$('m-empty-project').onclick = pickProject;
$('m-empty-demo').onclick = loadDemo;
$('m-open-files').onclick = () => (closeSheets(), pickFiles());
$('m-open-project').onclick = () => (closeSheets(), pickProject());
$('m-open-demo').onclick = () => (closeSheets(), loadDemo());

// ---- sheets ------------------------------------------------------------------------------
const backdrop = $('m-backdrop');
function openSheet(id: string) {
  closeSheets();
  $(id).classList.add('open');
  backdrop.classList.remove('hidden');
  refresh();
}
function closeSheets() {
  document.querySelectorAll('.m-sheet.open').forEach((s) => s.classList.remove('open'));
  backdrop.classList.add('hidden');
}
backdrop.onclick = closeSheets;
document.querySelectorAll<HTMLElement>('[data-close], .m-grab').forEach((b) => (b.onclick = closeSheets));
$('m-open').onclick = () => openSheet('m-open-sheet');
$('m-settings').onclick = () => openSheet('m-set-sheet');

// ---- settings ------------------------------------------------------------------------------
const level = $<HTMLInputElement>('m-level');
const width = $<HTMLInputElement>('m-width');
level.oninput = () => app.setWindow(Number(level.value), app.wl.width);
width.oninput = () => app.setWindow(app.wl.center, Number(width.value));
$('m-auto-wl').onclick = () => app.autoWindow();
app.onWindowChange = () => {
  if (document.activeElement !== level) level.value = String(app.wl.center);
  if (document.activeElement !== width) width.value = String(app.wl.width);
};

const vrButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#m-vr-mode button'));
vrButtons.forEach(
  (b) =>
    (b.onclick = () => {
      app.vr.mode = b.dataset.vr as typeof app.vr.mode;
      app.changed();
    }),
);
const thr = $<HTMLInputElement>('m-thr');
thr.oninput = () => {
  const vol = app.vol;
  if (!vol) return;
  app.vr.lo = Number(thr.value);
  if (app.vr.hi < app.vr.lo) app.vr.hi = vol.max;
  app.changed();
};
$('m-auto-thr').onclick = () => {
  if (!app.vol) return;
  app.vr.lo = Math.round(app.vol.boneThreshold());
  app.vr.hi = app.vol.max;
  app.changed();
};
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(
  (b) =>
    (b.onclick = () => {
      app.view3d.setPreset(b.dataset.preset as 'front');
      closeSheets();
      if (tab === 'plan') setTab('3d');
    }),
);

/** Jump to an implant: cross-section through it (or the axial slice) and select it. */
function focusImplant(id: number) {
  const imp = app.implantById(id);
  if (!imp) return;
  app.selectImplant(id, true);
  app.X = imp.center;
  app.changed();
  closeSheets();
  setTab(app.curve ? 'plan' : 'mpr');
}

// ---- state -> UI ----------------------------------------------------------------------------
function setList(el: HTMLElement, key: string, build: () => HTMLLIElement[]) {
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(...build());
}

function li(html: string, onClick?: () => void): HTMLLIElement {
  const e = document.createElement('li');
  e.innerHTML = html;
  if (onClick) e.onclick = onClick;
  return e;
}

function toggleRow(label: string, swatch: string, sub: string, on: boolean, onChange: (v: boolean) => void): HTMLLIElement {
  const e = li(
    `<span class="m-swatch" style="background:${swatch}"></span><span class="m-name">${esc(label)}</span><span class="m-sub">${esc(sub)}</span>` +
      `<label class="m-switch"><input type="checkbox" ${on ? 'checked' : ''} aria-label="Show ${esc(label)}" /><span></span></label>`,
  );
  const input = e.querySelector('input')!;
  input.onchange = () => onChange(input.checked);
  return e;
}

const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

function refresh() {
  const vol = app.vol;
  const info = vol?.info;
  $('m-title').textContent = info ? (info.patientName ?? '').replace(/\^/g, ' ').trim() || info.seriesDescription || '' : '';
  const who = $('m-title').textContent ?? '';
  document.title = who ? `${who} – Quick DICOM Planning` : 'Quick DICOM Planning';
  if (!vol) return;

  // tool strips
  $('m-rotate').classList.toggle('active', app.mprTool === 'rotate');
  document.querySelectorAll('.m-ruler').forEach((b) => b.classList.toggle('active', app.ruler));
  document.querySelectorAll('.m-clear-rulers').forEach((b) => b.classList.toggle('hidden', !app.measurements.length));
  const tilt = Math.max(...[0, 1, 2].map((i) => app.viewTiltDeg(i)));
  $('m-tilt').textContent = tilt > 0.05 ? `tilt ${tilt.toFixed(1)}°` : '';
  const draw = $('m-draw');
  draw.textContent = app.drawing ? 'Done' : app.curve ? 'Redraw curve' : 'Draw curve';
  draw.classList.toggle('active', !!app.drawing);
  $('m-undo-pt').classList.toggle('hidden', !app.drawing);
  $('m-clear-curve').classList.toggle('hidden', !!app.drawing || !app.curve);
  $('m-plan-info').textContent = app.drawing
    ? `${app.drawing.length} point${app.drawing.length === 1 ? '' : 's'}`
    : app.curve
      ? `arch ${app.curve.length.toFixed(0)} mm`
      : '';

  // image
  const range = Math.max(1, vol.max - vol.min);
  const step = String(Math.max(1, Math.round(range / 500)));
  level.min = String(vol.min);
  level.max = String(vol.max);
  width.min = '1';
  width.max = String(range);
  level.step = width.step = step;
  app.onWindowChange();
  // 3D
  vrButtons.forEach((b) => b.classList.toggle('active', b.dataset.vr === app.vr.mode));
  thr.min = String(vol.min);
  thr.max = String(vol.max);
  thr.step = step;
  if (document.activeElement !== thr) thr.value = String(app.vr.lo);
  $('m-thr-val').textContent = String(Math.round(app.vr.lo));

  // implants
  const imps = app.implants;
  $('m-implants-box').classList.toggle('hidden', !imps.length);
  setList($('m-implants'), JSON.stringify([imps, app.selectedId, app.nerves.map((n) => n.pts)]), () =>
    imps.map((imp) => {
      const dia = isTapered(imp) ? `Ø${imp.diameter.toFixed(1)}→${apicalDiameterOf(imp).toFixed(1)}` : `Ø${imp.diameter.toFixed(1)}`;
      const near = app.nerveDistances(imp).filter((x) => x.d < NERVE_SAFETY_MM);
      const warn = near.length ? `<span class="m-warn">⚠ ${near.map((x) => `${Math.max(0, x.d).toFixed(1)} mm to ${esc(x.nerve.name)}`).join(', ')}</span>` : '';
      const ab = imp.abutment ? ` · MUA ${imp.abutment.angle}°` : '';
      const e = li(
        `<span class="m-swatch m-imp"></span><span class="m-name">${esc(imp.name)}</span><span class="m-sub">${dia} × ${imp.length.toFixed(1)} mm · ${app.implantTilt(imp).toFixed(0)}°${ab}</span>${warn}<span class="m-chev">›</span>`,
        () => focusImplant(imp.id),
      );
      e.classList.toggle('sel', imp.id === app.selectedId);
      e.classList.add('m-tap');
      return e;
    }),
  );

  // segments
  const segs = app.seg.segments.filter((s) => s.seeds.length);
  $('m-segments-box').classList.toggle('hidden', !segs.length);
  setList($('m-segments'), JSON.stringify([segs.map((s) => [s.id, s.name, s.color, s.visible, s.voxels]), app.showUnsegmented]), () => [
    ...segs.map((s) =>
      toggleRow(s.name, rgb(s.color), `${((s.voxels * app.seg.voxelVolume) / 1000).toFixed(1)} cm³`, s.visible, (v) => app.setSegmentVisible(s.id, v)),
    ),
    toggleRow('Other bone (3D)', '#d9cfb8', 'not segmented', app.showUnsegmented, (v) => {
      app.showUnsegmented = v;
      app.changed();
    }),
  ]);

  // nerves
  const nerves = app.nerves.filter((n) => n.pts.length >= 2);
  $('m-nerves-box').classList.toggle('hidden', !nerves.length);
  setList($('m-nerves'), JSON.stringify(nerves.map((n) => [n.id, n.name, n.visible, n.diameter])), () =>
    nerves.map((n) =>
      toggleRow(n.name, '#ffd60a', `Ø${n.diameter.toFixed(1)} mm`, n.visible, (v) => {
        n.visible = v;
        app.changed();
      }),
    ),
  );

  $('m-vol-info').textContent = `${vol.nx} × ${vol.ny} × ${vol.nz} voxels · ${vol.spacing.map((s) => s.toFixed(2)).join(' × ')} mm · ${vol.info.source}`;
}
app.onStateChange = refresh;

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// keep the page itself from zooming / bouncing (views handle pinch themselves)
for (const g of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(g, (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

refresh();
app.requestRender();
