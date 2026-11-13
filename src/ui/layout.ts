// The two layouts (① Reorient, ② Plan), the mode tabs and the panel rail.

import type { Mode } from '../app';
import { flipFrom } from './motion';
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
  rail.onChange();
  // … and it is already drawing: the first click in the axial view is the first point
  if (noCurve && !app.drawing && !app.placing) app.startDrawing();
}
tabButtons.forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
document.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach((b) => (b.onclick = () => setMode(b.dataset.goto as Mode)));

// once the curve is drawn, the next step is placing implants
app.onCurveDrawn = () => rail.select('implants');

// teeth of the waxup react to the mouse only while its panel is open (so they never get in the
// way of implant planning, where their outlines overlap the implant heads)
// The waxup is worked on mainly in 3D: opening its panel enlarges the 3D view (⤢ or M shows all
// views), leaving it restores the layout. Not when the panel opens because a tooth was grabbed in
// the 3D view: the view must not change size under the mouse.
let grabbing = false;
let enlarged = false;
app.wax.openPanel = (grabbed = false) => {
  grabbing = grabbed;
  rail.select('waxup');
  grabbing = false;
};
const v3dMax = () => app.view3d.el.classList.contains('max');
// a click on an implant (in a view or the Objects list) shows the Implants panel with it
app.openImplantsPanel = () => {
  if (app.mode === 'plan' && (rail.current !== 'implants' || !rail.open)) rail.select('implants');
};
rail.onChange = () => {
  // a panel's tools stop when another panel is shown: left on, they would keep taking the clicks
  // in the views (picking segments, adding nerve points, placing an implant) and keep a click
  // outside an implant from deselecting it
  if (app.segTool === 'nerve' && rail.current !== 'nerves') app.setSegTool(null);
  if ((app.segTool === 'grow' || app.segTool === 'cut') && rail.current !== 'segments') app.setSegTool(null);
  if (app.placing && rail.current !== 'implants') app.placing = null;
  const on = app.mode === 'plan' && rail.current === 'waxup' && rail.open;
  if (app.wax.editing === on) return;
  app.wax.editing = on;
  if (on) {
    // tools of other panels would take the clicks (segment clicks, cuts, nerve tracing, ruler, implant placing)
    if (app.segTool) app.setSegTool(null);
    if (app.ruler) app.setRuler(false);
    app.placing = null;
  }
  if (on && !grabbing && app.vol && !v3dMax()) {
    app.toggleMaximize(app.view3d, false);
    enlarged = true;
  } else if (!on) {
    app.wax.hover = null;
    if (enlarged && v3dMax()) app.toggleMaximize(app.view3d, false);
    enlarged = false;
  }
  app.changed();
};

// ---- drawing a panoramic curve: the axial view grows ---------------------------------------
// While a curve is tapped out (the first one when ② Plan opens, an added one, or a redrawn one)
// the axial view takes the larger part of the window and the other views make room on the right;
// when the curve is done they all take their places back. Each view moves from where it is on
// screen to its new tile, scaled evenly (never stretched) – the views keep their field of view
// across their shorter side, so the picture lines up all the way and the scale stays right.
let curveLayout = false;
function syncCurveLayout() {
  const on = !!app.vol && !!app.drawing;
  if (on === curveLayout) return;
  curveLayout = on;
  const ax = app.planAxial.el;
  const views = Array.from(planLayout.children).filter((e): e is HTMLElement => e instanceof HTMLElement && e.classList.contains('view'));
  const before = new Map(views.map((e) => [e, e.getBoundingClientRect()])); // where they are now (mid-flight too)
  planLayout.classList.toggle('drawing-curve', on);
  ax.classList.toggle('draw-target', on);
  let k = 0;
  for (const el of views) {
    const b = before.get(el)!;
    if (el === ax) {
      // grows with a touch of settle; going back it slides under the views returning over it
      flipFrom(el, b, on ? { response: 0.5, damping: 0.8, z: 6 } : { response: 0.42, z: 4 });
    } else {
      // the others follow one after another; the panoramic of the new curve settles softly
      const pano = el === app.pano.el && !on;
      flipFrom(el, b, { response: pano ? 0.5 : 0.42, damping: pano ? 0.85 : 1, delay: 22 * k++, z: 5 });
    }
  }
  app.requestRender();
}

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
  syncCurveLayout();
  rail.setBadges({
    implants: app.implants.length,
    segments: app.seg.segments.length,
    nerves: app.nerves.filter((n) => n.pts.length >= 2).length,
    scans: app.scans.length,
    waxup: app.wax.model.teeth.length,
  });
  if (vol && !planOpened && !planNudged && app.mode === 'mpr') {
    planNudged = true;
    tabButtons.find((b) => b.dataset.mode === 'plan')?.classList.add('nudge');
  }
}
