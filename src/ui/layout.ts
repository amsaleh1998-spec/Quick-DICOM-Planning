// The two layouts (① Reorient, ② Plan), the mode tabs and the panel rail.

import type { Mode } from '../app';
import { Rail } from './rail';
import { mountViewTools } from './viewTools';
import { $, app } from './shell';

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

mountViewTools(app.view3d.el, app.pano.el);
export const rail = new Rail($('rail'), $('sidebar'), $('status-hint'));

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

// mode tabs
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tabs button'));
// pulse the "Implant planning" tab once after the first volume loads, until it has been opened
let planOpened = false;
let planNudged = false;
export function setMode(m: Mode) {
  if (m === 'plan') {
    planOpened = true;
    tabButtons.forEach((b) => b.classList.remove('nudge'));
  }
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  mprLayout.classList.toggle('hidden', m !== 'mpr');
  planLayout.classList.toggle('hidden', m !== 'plan');
  rail.setMode(m);
  // planning starts with the panoramic curve; once there is one, the last panel used comes back
  const noCurve = m === 'plan' && !!app.vol && !app.curves.length;
  if (noCurve) rail.prefer('curve');
  moveView3d(m === 'mpr' ? mprLayout : planLayout);
  if (m !== 'plan' && app.drawing && !app.drawing.length) app.cancelDrawing(); // nothing drawn yet
  app.setMode(m);
  // … and it is already drawing: the first click in the axial view is the first point
  if (noCurve && !app.drawing && !app.placing) app.startDrawing();
}
tabButtons.forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
document.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach((b) => (b.onclick = () => setMode(b.dataset.goto as Mode)));

// once the curve is drawn, the next step is placing implants
app.onCurveDrawn = () => rail.select('implants');

/** Start screen, rail badges, the unsaved dot on Save, and the one-time nudge towards ② Plan. */
export function refreshLayout() {
  const vol = app.vol;
  // unsaved plan: a dot on Save
  const save = $('btn-save-project');
  const dirty = app.unsaved;
  if (save.classList.contains('dirty') !== dirty) {
    save.classList.toggle('dirty', dirty);
    save.title = dirty ? 'Save the plan – it has changes that are not saved yet (Ctrl+S)' : 'Save the CBCT, plan and views to a project file (Ctrl+S)';
  }

  $('start-screen').classList.toggle('hidden', !!vol);
  rail.setBadges({
    implants: app.implants.length,
    segments: app.seg.segments.length,
    nerves: app.nerves.filter((n) => n.pts.length >= 2).length,
    scans: app.scans.length,
  });
  if (vol && !planOpened && !planNudged && app.mode === 'mpr') {
    planNudged = true;
    tabButtons.find((b) => b.dataset.mode === 'plan')?.classList.add('nudge');
  }
}
