// The demo, scene by scene: every scene drives the real app with real mouse / keyboard / drag events
// through the Stage (lib/stage.cjs). Positions are computed from the app's own state at run time
// (view rectangles, world -> screen), so the scenes do not depend on pixel constants.

const path = require('path');
const fs = require('fs');
const { plan, spline } = require('./lib/plan.cjs');

// ---- helpers: questions to the page --------------------------------------------------------------

/** Rectangle of an app view ('planAxial', 'pano', 'crossViews.1', 'tang', 'view3d', 'mprViews.0' …). */
const viewRect = (page, view) =>
  page.evaluate((view) => {
    const v = view.split('.').reduce((o, k) => o[k], window.app);
    const b = v.el.getBoundingClientRect();
    return [b.x, b.y, b.width, b.height];
  }, view);

/** Centre of a button inside a view (maximize, reset …). */
const viewButton = (page, view, sel) =>
  page.evaluate(
    ([view, sel]) => {
      const v = view.split('.').reduce((o, k) => o[k], window.app);
      const b = v.el.querySelector(sel).getBoundingClientRect();
      return [b.x + b.width / 2, b.y + b.height / 2];
    },
    [view, sel],
  );

/** World point -> page coordinates in a planar view. */
const worldToPage = (page, view, w) =>
  page.evaluate(
    ([view, w]) => {
      const v = view.split('.').reduce((o, k) => o[k], window.app);
      const b = v.el.getBoundingClientRect();
      const s = v.worldToScreen(w);
      return [b.x + s[0], b.y + s[1]];
    },
    [view, w],
  );

/** Panoramic: page coordinates of arc length s (mm along the curve) and height c (mm above the volume centre). */
const panoPoint = (page, s, c) =>
  page.evaluate(
    ([s, c]) => {
      const v = window.app.pano;
      const b = v.el.getBoundingClientRect();
      return [b.x + v.xOf(s), b.y + v.yOf(c)];
    },
    [s, c],
  );

/** An option of an open (in-page) select picker, by its text. */
const optionPoint = (page, sel, text) =>
  page.evaluate(
    ([sel, text]) => {
      const o = [...document.querySelectorAll(`${sel} option`)].find((o) => o.textContent.trim() === text);
      if (!o) throw new Error(`no option ${text}`);
      const b = o.getBoundingClientRect();
      return [b.x + Math.min(60, b.width / 2), b.y + b.height / 2];
    },
    [sel, text],
  );

/**
 * A list longer than the room under its select scrolls: bring an option into view with the wheel
 * (the pointer goes into the list first), as far as it takes to have it in the middle of the list.
 */
async function scrollToOption(st, sel, text) {
  const q = () =>
    st.page.evaluate(
      ([sel, text]) => {
        const s = document.querySelector(sel);
        const rect = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        const o = [...s.options].find((o) => o.textContent.trim() === text);
        if (!o) throw new Error(`no option ${text}`);
        const r = rect(o);
        const hit = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2);
        return { option: r, shown: hit === o || o.contains(hit), checked: rect([...s.options].find((o) => o.selected)), top: rect(s).y + rect(s).h, bottom: innerHeight };
      },
      [sel, text],
    );
  const a = await q();
  const by = a.option.y + a.option.h / 2 - (a.top + a.bottom) / 2; // the option to the middle of the list
  if (a.shown && by < a.option.h) return false;
  await st.moveTo([a.checked.x + Math.min(70, a.checked.w / 2), a.checked.y + a.checked.h / 2], { dur: 0.4 });
  await st.hold(0.1);
  await st.wheel(by / 100, { dur: 0.5, delta: 10, native: true });
  await st.hold(0.15);
  if (!(await q()).shown) throw new Error(`option ${text} is not in view`);
  return true;
}

const implantState = (page) =>
  page.evaluate(() => {
    const a = window.app;
    return a.implants.map((i) => ({
      id: i.id, name: i.name, lib: i.lib?.id ?? null, len: i.length, dia: i.diameter, center: i.center, axis: i.axis,
      platform: i.center.map((v, k) => v - (i.axis[k] * i.length) / 2), tilt: a.implantTilt(i),
    }));
  });

/**
 * A new implant is named after the tooth at its place (counted off along the panoramic curve in mean
 * tooth widths). Where that is not the tooth the plan means, pick it in the panel's tooth chart.
 */
async function nameAfterTooth(st, tooth) {
  const name = await st.page.evaluate(() => window.app.selectedImplant().name);
  if (name === tooth) return false;
  await st.click(`#imp-teeth .tooth[data-tooth="${tooth}"] circle`, { after: 0.45 });
  const now = await st.page.evaluate(() => window.app.selectedImplant().name);
  if (now !== tooth) throw new Error(`implant is named ${now}, not ${tooth}`);
  return true;
}

const loadedIdle = (page) => page.evaluate(() => !!window.app.vol && document.getElementById('loading').classList.contains('hidden'));

// ---- scenes ----------------------------------------------------------------------------------

/** Drop the CBCT on the start screen; it loads; automatic window. */
async function open(st, cfg) {
  st.begin('open');
  await st.rect('dropzone', '.start-drop');
  const desk = [st.W + 150, st.H - 170]; // beside the window: where the files come from
  await st.page.mouse.move(st.W - 4, st.H - 4);
  st.x = desk[0];
  st.y = desk[1];
  await st.hold(0.7);
  const zone = await st.point('.start-drop');
  await st.dragFiles(cfg.dicomFiles, desk, [zone[0] + 30, zone[1] + 10], { dur: 1.1, label: 'Demo CBCT' });
  st.mark('open.dropped');
  await st.realtime(loadedIdle, { label: 'load', every: 120 });
  st.mark('open.loaded');
  await st.rect('viewport', '#viewport');
  await st.rect('mpr3d', await viewRect(st.page, 'view3d'));
  await st.hold(0.9);
  await st.click('#btn-auto-wl');
  st.mark('open.auto');
  await st.hold(0.9);
}

/** Automatic segmentation of the maxilla (DentalSegmentator, in the browser). */
async function ai(st) {
  st.begin('ai');
  await st.click('#rail [data-panel="segments"]');
  await st.hold(0.2);
  await st.click('#btn-ai-seg');
  await st.hold(0.5);
  await st.rect('aiDialog', '.modal.ai-seg');
  await st.click({ sel: '.ai-seg label.check:has(input[name="ai-jaw"][value="upper"])', fx: 0.18 }, { after: 0.15 });
  await st.click({ sel: '.ai-seg label.check:has(input[name="ai-step"][value="1"])', fx: 0.12 }, { after: 0.25 });
  await st.click('#ai-go');
  st.mark('ai.start');
  // it runs in a background worker: close the window and keep the scan in view
  await st.realtime((page) => page.evaluate(() => !document.querySelector('#ai-hide').classList.contains('hidden') && /Segmenting|Preparing/.test(document.querySelector('#ai-phase').textContent)), { label: 'aiStart', every: 150 });
  await st.hold(0.4);
  await st.click('#ai-hide');
  await st.rect('aiPill', '.ai-pill');
  await st.moveTo(await st.page.evaluate(() => { const b = window.app.view3d.el.getBoundingClientRect(); return [b.x + b.width * 0.78, b.y + b.height * 0.8]; }));
  st.mark('ai.background');
  await st.realtime((page) => page.evaluate(() => window.app.seg.segments.some((s) => s.voxels > 0) && !document.querySelector('.modal.ai-seg')), { label: 'ai', every: 1500 });
  st.mark('ai.done');
  await st.rect('mpr3d', await viewRect(st.page, 'view3d'));
  await st.hold(1.4);
}

/** Intraoral scans: drop the upper scan, match it to the CBCT teeth by surface patches; the lower scan copies the alignment. */
async function scans(st, cfg) {
  st.begin('scans');
  const vp = await st.point('#viewport');
  await st.dragFiles([cfg.upperStl], [st.W + 150, st.H - 230], [vp[0] - 40, vp[1] + 20], { dur: 1.0, label: 'upper.stl' });
  await st.realtime((page) => page.evaluate(() => !!document.querySelector('.modal.scan-place')), { label: 'read', every: 100 });
  await st.hold(0.5);
  await st.rect('placeDialog', '.modal.scan-place');
  // Waits are recorded in real time (the editor shows them as a time-lapse): the button is
  // released and the clock runs freely until the app is ready again.
  await st.click('#pl-go', { after: 0 });
  const ready = (label) => (page) => page.evaluate((label) => /Click a point/.test(document.querySelector('#sa-help')?.textContent ?? '') && document.querySelectorAll('.sa-panes .mv-title')[1]?.textContent === `CBCT – ${label}`, label);
  await st.realtime(ready('Segment: Maxilla & upper skull'), { label: 'surface', every: 200 });
  await st.rect('alignDialog', '.modal.scan-align');
  await st.hold(0.5);
  // match on the teeth: choose that segment as the CBCT surface
  await st.click('#sa-target', { after: 0.3 });
  await st.click(await optionPoint(st.page, '#sa-target', 'Segment: Upper teeth'), { after: 0 });
  await st.realtime(ready('Segment: Upper teeth'), { label: 'surface2', every: 80 });
  await st.hold(0.5);
  const panes = await st.page.evaluate(() => [...document.querySelectorAll('.sa-panes > .mv')].map((e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }));
  await st.rect('paneScan', panes[0]);
  await st.rect('paneCbct', panes[1]);
  // Pairs of points: the same spot on the scan and on the CBCT. Each scan point is picked on the scan
  // surface; where it lies in the CBCT is known from the scan's alignment (plan.scanToCbct).
  // (The app exposes the two 3D panes of this window for its own tests.)
  const pick = (fx, fy) =>
    st.page.evaluate(([fx, fy]) => {
      const v = [...document.querySelectorAll('.modal-backdrop')].map((m) => m.__viewers).find(Boolean)[0];
      const hit = v.pickAt(v.el.clientWidth * fx, v.el.clientHeight * fy);
      return hit ? hit.p : null;
    }, [fx, fy]);
  const project = (which, p) =>
    st.page.evaluate(([which, p]) => {
      const v = [...document.querySelectorAll('.modal-backdrop')].map((m) => m.__viewers).find(Boolean)[which];
      const b = v.el.getBoundingClientRect();
      const s = v.project(p, v.el.clientWidth, v.el.clientHeight);
      return [b.x + s[0], b.y + s[1]];
    }, [which, p]);
  const T = plan.scanToCbct;
  const toWorld = (p) => [T[0] * p[0] + T[1] * p[1] + T[2] * p[2] + T[3], T[4] * p[0] + T[5] * p[1] + T[6] * p[2] + T[7], T[8] * p[0] + T[9] * p[1] + T[10] * p[2] + T[11]];
  st.mark('scans.patches');
  for (const [fx, fy] of plan.scanPoints) {
    const p = await pick(fx, fy);
    if (!p) throw new Error(`no scan surface at ${fx}, ${fy}`);
    await st.click(await project(0, p), { after: 0.1 });
    await st.click(await project(1, toWorld(p)), { after: 0.1 });
  }
  await st.hold(0.25);
  await st.click('#sa-match', { after: 0 });
  await st.realtime((page) => page.evaluate(() => !document.querySelector('#sa-accept').classList.contains('hidden')), { label: 'match', every: 50 });
  st.mark('scans.matched');
  // what the app says about the fit (the editor quotes it in a caption)
  st.log.info = { ...(st.log.info ?? {}), match: await st.page.evaluate(() => document.querySelector('#sa-result').textContent) };
  console.log('  match:', st.log.info.match);
  if (!/^✓/.test(st.log.info.match.trim())) throw new Error('the app is not sure of the match');
  await st.rect('alignResult', '#sa-result');
  await st.hold(1.3);
  await st.click('#sa-accept');
  await st.hold(0.7);
  st.mark('scans.accepted');
  // the lower scan comes from the same scanner session: it copies the upper scan's alignment
  await st.dragFiles([cfg.lowerStl], [st.W + 150, st.H - 230], [vp[0] - 20, vp[1] + 30], { dur: 0.9, label: 'lower.stl' });
  await st.realtime((page) => page.evaluate(() => !!document.querySelector('.modal.scan-place')), { label: 'read2', every: 100 });
  await st.hold(0.4);
  await st.click({ sel: '.scan-place label.opt:has(input[value="copy"])', fx: 0.05 }, { after: 0.2 });
  await st.click('#pl-go');
  st.mark('scans.done');
  await st.rect('mpr3d', await viewRect(st.page, 'view3d'));
  await st.hold(1.3);
}

/** Plan: the panoramic curve, drawn in one stroke along the maxillary ridge (the axial view is larger while it is drawn). */
async function curve(st) {
  st.begin('curve');
  await st.rect('planTiles', '#viewport');
  await st.click('.tabs [data-mode="plan"]');
  // the views move apart for the drawing: wait until they have landed
  await st.hold(1.0);
  const r = await viewRect(st.page, 'planAxial');
  await st.rect('planArea', r);
  st.mark('curve.open');
  await st.moveTo([r[0] + r[2] * 0.5, r[1] + r[3] * 0.42]);
  await st.wheel(-plan.levelNotches, { dur: 1.1 });
  await st.hold(0.3);
  st.mark('curve.level');
  const stroke = await st.page.evaluate((pts) => {
    const a = window.app, v = a.planAxial, b = v.el.getBoundingClientRect();
    return pts.map((p) => {
      const s = v.worldToScreen([p[0] + a.O[0], p[1] + a.O[1], a.O[2] + a.focusC]);
      return [b.x + s[0], b.y + s[1]];
    });
  }, spline(plan.arch, 0.25));
  await st.drag(stroke, { dur: 1.7, before: 0.15, after: 0 });
  st.mark('curve.drawn');
  // the views take their places back, the new panoramic among them
  await st.hold(1.6);
  st.mark('curve.settled');
  await st.hold(0.9);
  for (const [name, v] of [['pano', 'pano'], ['cs1', 'crossViews.0'], ['cs2', 'crossViews.1'], ['cs3', 'crossViews.2'], ['tang', 'tang'], ['plan3d', 'view3d'], ['planAxialTile', 'planAxial']]) await st.rect(name, await viewRect(st.page, v));
  console.log('  curve:', await st.page.evaluate(() => (window.app.curve ? { len: +window.app.curve.length.toFixed(1), n: window.app.curve.ctrl.length, level: +window.app.focusC.toFixed(2) } : { drawing: window.app.drawing && window.app.drawing.length })));
}

// ---- implants: helpers ---------------------------------------------------------------------------

/** A planned implant (platform and axis in DICOM patient coordinates) in the app's coordinates. */
const inApp = (page, t) =>
  page.evaluate((t) => {
    const A = window.app.vol.info.patientAffine ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const m = [A.slice(0, 3), A.slice(4, 7), A.slice(8, 11)], tr = [A[3], A[7], A[11]];
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const inv = [0, 1, 2].map((i) => [0, 1, 2].map((j) => { const r = [0, 1, 2].filter((k) => k !== j), c = [0, 1, 2].filter((k) => k !== i); return ((i + j) % 2 ? -1 : 1) * (m[r[0]][c[0]] * m[r[1]][c[1]] - m[r[0]][c[1]] * m[r[1]][c[0]]) / det; }));
    const mul = (v) => inv.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
    const ax = mul(t.axis), n = Math.hypot(...ax);
    return { plat: mul(t.plat.map((x, k) => x - tr[k])), axis: ax.map((x) => x / n) };
  }, t);

/** The selected implant and its target in a view: page points to drag from and to, and how far off it still is. */
const aim = (page, view, T) =>
  page.evaluate(([view, T]) => {
    const a = window.app, imp = a.selectedImplant(), v = view.split('.').reduce((o, k) => o[k], a), b = v.el.getBoundingClientRect();
    const pg = (w) => { const s = v.worldToScreen(w); return [b.x + s[0], b.y + s[1]]; };
    const L = imp.length, plat = imp.center.map((x, k) => x - (imp.axis[k] * L) / 2);
    const hd = v.editor.handles(imp).apical, R = Math.hypot(...hd.map((x, k) => x - plat[k]));
    return {
      centre: pg(imp.center), plat: pg(plat), apical: pg(hd),
      toCentre: pg(T.plat.map((x, k) => x + (imp.axis[k] * L) / 2)), toApical: pg(plat.map((x, k) => x + T.axis[k] * R)),
      mm: Math.hypot(...plat.map((x, k) => x - T.plat[k])), deg: (Math.acos(Math.min(1, imp.axis.reduce((s, x, k) => s + x * T.axis[k], 0))) * 180) / Math.PI,
    };
  }, [view, T]);

/** Drag the implant by its body in a view until its platform is on the target's (as far as this view's plane goes). */
async function moveBody(st, view, T, o = {}) {
  const g = await aim(st.page, view, T);
  const d = [g.toCentre[0] - g.centre[0], g.toCentre[1] - g.centre[1]];
  if (Math.hypot(...d) < 1) return false;
  await st.drag([g.centre, [g.centre[0] + d[0], g.centre[1] + d[1]]], { dur: 0.6, before: 0.15, after: 0.3, ...o });
  return true;
}

/** Turn the implant around its platform with the A handle in a view, onto the target axis (as seen in this view). */
async function tilt(st, view, T, o = {}) {
  const g = await aim(st.page, view, T);
  const r = Math.hypot(g.apical[0] - g.plat[0], g.apical[1] - g.plat[1]);
  const a0 = Math.atan2(g.apical[1] - g.plat[1], g.apical[0] - g.plat[0]);
  let da = Math.atan2(g.toApical[1] - g.plat[1], g.toApical[0] - g.plat[0]) - a0;
  if (da > Math.PI) da -= 2 * Math.PI;
  if (da < -Math.PI) da += 2 * Math.PI;
  if (Math.abs(da) * r < 1) return false;
  const n = Math.max(8, Math.round(Math.abs(da) * 60));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push([g.plat[0] + r * Math.cos(a0 + (da * i) / n), g.plat[1] + r * Math.sin(a0 + (da * i) / n)]);
  await st.drag(pts, { dur: 0.5 + Math.abs(da) * 0.8, before: 0.15, after: 0.3, ...o });
  return true;
}

/** Body and axis onto the target: in the cross-section, then what is left of it in the tangential view. */
async function pose(st, T, name) {
  await moveBody(st, 'crossViews.1', T);
  st.mark(`implants.tilt${name}`);
  await tilt(st, 'crossViews.1', T);
  await tilt(st, 'tang', T);
  // what the first passes left (the views turn with the implant): small corrections
  for (let i = 0; i < 3; i++) {
    const g = await aim(st.page, 'tang', T);
    if (g.mm < 0.05 && g.deg < 0.15) break;
    if (g.mm >= 0.05) (await moveBody(st, 'tang', T, { dur: 0.35 })) || (await moveBody(st, 'crossViews.1', T, { dur: 0.35 }));
    if ((await aim(st.page, 'tang', T)).deg >= 0.15) (await tilt(st, 'crossViews.1', T, { dur: 0.35 })) , (await tilt(st, 'tang', T, { dur: 0.35 }));
  }
  const g = await aim(st.page, 'tang', T);
  console.log(`  ${name}: platform ${g.mm.toFixed(3)} mm, axis ${g.deg.toFixed(2)}° off the plan`);
  if (g.mm > 0.15 || g.deg > 0.5) throw new Error(`implant ${name} is not on its planned position`);
}

/** Bring a control of the side panel into view (the panel scrolls once the abutment section is open). */
async function reveal(st, sel) {
  const r = await st.page.evaluate((sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { y: b.y, b: b.bottom, x: b.x + b.width / 2, H: innerHeight }; }, sel);
  const by = r.b - (r.H - 150);
  if (by <= 0) return;
  await st.moveTo([r.x, Math.min(r.y, r.H - 200)], { dur: 0.3 });
  await st.wheel(by / 100, { dur: 0.4, delta: 10, native: true });
  await st.hold(0.15);
}

/** Choose an option of a select of the side panel. */
async function choose(st, sel, text, o = {}) {
  await reveal(st, sel);
  await st.click(sel, { after: 0.35 });
  if (o.mark) st.mark(o.mark);
  await scrollToOption(st, sel, text);
  await st.moveTo(await optionPoint(st.page, sel, text), { dur: 0.45 });
  await st.hold(0.1);
  await st.click(undefined, { after: o.after ?? 0.4 });
}

/** The multi-unit abutment of the selected implant, in the panel's abutment section. */
async function abutment(st, m) {
  const page = st.page;
  if (!(await page.evaluate(() => document.querySelector('#ab-type').closest('details').open))) {
    await reveal(st, '#implant-edit details.sub summary');
    await st.click({ sel: '#implant-edit details.sub summary', fx: 0.2 }, { after: 0.4 });
  }
  await choose(st, '#ab-type', m.type);
  await choose(st, '#ab-height', m.gh);
  if (m.rotation !== undefined && m.rotation !== (await page.evaluate(() => window.app.selectedImplant().abutment.rotation))) {
    // turn the angled head: drag the rotation slider, the last steps with the arrow keys
    await reveal(st, '#ab-rot');
    const x = (v) => page.evaluate((v) => { const e = document.querySelector('#ab-rot'), b = e.getBoundingClientRect(), th = 16; return [b.x + th / 2 + ((v - +e.min) / (+e.max - +e.min)) * (b.width - th), b.y + b.height / 2]; }, v);
    const value = () => page.evaluate(() => +document.querySelector('#ab-rot').value);
    await st.drag([await x(await value()), await x(m.rotation)], { dur: 0.9, before: 0.15, after: 0.2 });
    for (let i = 0; i < 12 && (await value()) !== m.rotation; i++) await st.key((await value()) < m.rotation ? 'ArrowRight' : 'ArrowLeft', { after: 0.08 });
    if ((await value()) !== m.rotation) throw new Error('abutment rotation not set');
  }
  await st.hold(0.3);
}

/** Implants at 24 and 26 as planned (lib/plan.cjs): placed in the panoramic, a manufacturer's implant from the library, brought into position in the cross-section and the tangential view, multi-unit abutments. */
async function implants(st) {
  st.begin('implants');
  const page = st.page;
  for (const [name, v] of [['pano', 'pano'], ['cs1', 'crossViews.0'], ['cs2', 'crossViews.1'], ['cs3', 'crossViews.2'], ['tang', 'tang'], ['plan3d', 'view3d'], ['planAxialTile', 'planAxial']]) await st.rect(name, await viewRect(page, v));
  await st.rect('sidebar', '#sidebar');
  const T24 = await inApp(page, plan.i24), T26 = await inApp(page, plan.i26);
  // where to click in the panoramic for a new implant whose platform is to be at `plat` (it comes vertical, or parallel to the selected one)
  const clickFor = (T, len) => page.evaluate(([T, len]) => {
    const a = window.app, ref = a.selectedImplant(), ax = ref ? ref.axis : [0, 0, a.frame[2][2] >= 0 ? 1 : -1];
    const c = T.plat.map((x, k) => x + (ax[k] * len) / 2);
    const s = a.curve.nearest(c[0] - a.O[0], c[1] - a.O[1]).s, v = a.pano, b = v.el.getBoundingClientRect();
    return [b.x + v.xOf(s), b.y + v.yOf(c[2] - a.O[2])];
  }, [T, len]);
  // zoom the panoramic onto the upper left quadrant
  await st.moveTo(await panoPoint(page, plan.panoZoom.s, plan.panoZoom.c));
  await st.wheel(-plan.panoZoom.notches, { dur: 0.7, ctrl: true, delta: 20 });
  await st.hold(0.35);

  // ---- 24 ----
  await st.click('#btn-add-upper');
  await st.hold(0.15);
  await st.click(await clickFor(T24, 10), { after: 0.7 });
  st.mark('implants.placed24');
  await st.rect('impEdit', '#implant-edit');
  await st.rect('toothChart', '#imp-teeth');
  // closer: the cross-sections (they share their zoom) and the tangential view, around the implant
  const centre = (view) => page.evaluate((view) => { const a = window.app, v = view.split('.').reduce((o, k) => o[k], a), b = v.el.getBoundingClientRect(); const s = v.worldToScreen(a.selectedImplant().center); return [b.x + s[0], b.y + s[1]]; }, view);
  await st.moveTo(await centre('crossViews.1'));
  await st.wheel(-plan.crossZoom, { dur: 0.6, ctrl: true, delta: 20 });
  await st.hold(0.15);
  await st.moveTo(await centre('tang'));
  await st.wheel(-plan.tangZoom, { dur: 0.4, ctrl: true, delta: 20 });
  await st.hold(0.2);
  st.mark('implants.zoomed');
  // a manufacturer's implant from the library
  await st.click('#imp-brand', { after: 0.45 });
  st.mark('implants.brandList');
  await st.rect('brandList', await page.evaluate(() => { const o = [...document.querySelectorAll('#imp-brand option')]; const a = o[0].getBoundingClientRect(), b = o[o.length - 1].getBoundingClientRect(); return [a.x - 6, a.y - 6, a.width + 12, b.bottom - a.y + 12]; }));
  await st.moveTo(await optionPoint(page, '#imp-brand', plan.brand), { dur: 0.75 });
  await st.hold(0.15);
  await st.click(undefined, { after: 0.2 });
  await st.realtime((page) => page.evaluate(() => { const i = window.app.implants[0]; return !!i?.lib && window.app.libraryMeshLoaded(i.lib.id); }), { label: 'mesh', every: 60 });
  st.mark('implants.library');
  await st.hold(0.5);
  await choose(st, '#imp-size', plan.i24.size, { mark: 'implants.sizeList24' });
  st.mark('implants.sized24');
  await nameAfterTooth(st, plan.i24.tooth); // (the app's own name for this place)
  await pose(st, T24, '24');
  st.mark('implants.tilted24');
  await abutment(st, plan.i24.mua);
  st.mark('implants.mua24');

  // ---- 26: comes parallel to 24 with the same implant and abutment ----
  await st.click('#btn-add-upper');
  await st.hold(0.15);
  await st.click(await clickFor(T26, await page.evaluate(() => window.app.selectedImplant().length)), { after: 0.7 });
  st.mark('implants.placed26');
  // (counted off in mean tooth widths, this place is the tooth before)
  if (await nameAfterTooth(st, plan.i26.tooth)) st.mark('implants.named26');
  // a wider, shorter implant for the molar site: the sizes of the same system
  await choose(st, '#imp-size', plan.i26.size, { mark: 'implants.sizeList' });
  st.mark('implants.sized26');
  await pose(st, T26, '26');
  st.mark('implants.tilted26');
  await abutment(st, plan.i26.mua);
  st.mark('implants.done');
  // look at the whole plan: move the pointer out of the way
  await st.moveTo(await panoPoint(page, 60, 30), { dur: 0.6 });
  await st.hold(1.0);
  console.log('  implants:', JSON.stringify((await implantState(page)).map((i) => ({ name: i.name, lib: i.lib, tilt: +i.tilt.toFixed(1), plat: i.platform.map((v) => +v.toFixed(2)) }))), JSON.stringify(await page.evaluate(() => window.app.implants.map((i) => i.abutment))));
}

/** 3D: the plan in the segmented jaw with the scans; hide the upper scan to see the implants in the bone. */
async function hero(st, cfg) {
  st.begin('hero');
  const page = st.page;
  await st.click(await viewButton(page, 'view3d', '.max-btn'));
  await st.hold(0.7);
  // deselect the implant (after the click: Esc is the app's while no list or field has the keyboard)
  await st.key('Escape', { after: 0.3 });
  if (await page.evaluate(() => !!window.app.selectedImplant())) throw new Error('the implant is still selected');
  st.mark('hero.ready');
  const r = await viewRect(page, 'view3d');
  await st.rect('hero3d', r);
  await st.rect('objects', '#objects');
  // From here every frame is a new 3D picture. The app draws a draft while the view keeps changing and
  // the full picture 300 ms after it stops: with more app time than that per frame, every frame is full quality.
  const Q = cfg && cfg.draft3d ? undefined : plan.hero.appMs;
  // turn the model: front -> the patient's left, slightly from below
  const c = [r[0] + r[2] * 0.52, r[1] + r[3] * 0.5];
  await st.moveTo(c);
  await st.hold(0.1, Q);
  await st.drag([c, [c[0] + plan.hero.orbit1[0], c[1] + plan.hero.orbit1[1]]], { dur: 2.2, before: 0.1, after: 0.3, appMs: Q });
  st.mark('hero.turned');
  // closer: a pinch (Ctrl + wheel, in small steps) glides; a notch of the plain wheel would jump 12 %
  await st.moveTo(await page.evaluate(() => { const a = window.app, v = a.view3d, b = v.el.getBoundingClientRect(); const i = a.implants[0]; const s = v.screenPoint(i.center); return [b.x + s[0] + 20, b.y + s[1] + 10]; }), { appMs: Q });
  st.mark('hero.zoom');
  await st.wheel(-plan.hero.zoom, { dur: 0.9, ctrl: true, delta: 2, appMs: Q });
  st.mark('hero.zoomed');
  await st.hold(0.4, Q);
  // hide the upper scan: the implants in the bone, between the roots
  const eye = await page.evaluate(() => { const li = [...document.querySelectorAll('#obj-groups li')].find((l) => l.querySelector('.nm')?.textContent === 'Upper jaw'); const b = li.querySelector('.vis-btn').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
  await st.click(eye, { after: 0.5, appMs: Q });
  st.mark('hero.scanHidden');
  const c2 = [r[0] + r[2] * 0.6, r[1] + r[3] * 0.62];
  await st.moveTo(c2, { appMs: Q });
  await st.drag([c2, [c2[0] + plan.hero.orbit2[0], c2[1] + plan.hero.orbit2[1]]], { dur: 2.4, before: 0.1, after: 0.2, appMs: Q, ease: (t) => t * t * (3 - 2 * t) });
  st.mark('hero.end');
  await st.moveTo([r[0] + r[2] * 0.93, r[1] + r[3] * 0.9], { appMs: Q, dur: 0.5 });
  await st.hold(0.9, Q);
}

/** Export: the planning report (PDF). */
async function report(st, cfg) {
  st.begin('report');
  const page = st.page;
  await st.click('#btn-export-menu', { after: 0.4 });
  await st.rect('exportMenu', '#pop-export');
  const dl = page.waitForEvent('download', { timeout: 600_000 });
  await st.click('#btn-export-report');
  st.mark('report.start');
  let file = null;
  dl.then(async (d) => {
    const out = path.join(cfg.outDir, 'report.pdf');
    await d.saveAs(out);
    file = out;
  });
  await st.realtime(async () => !!file && (await loadedIdle(page)), { label: 'report', every: 250 });
  st.mark('report.done');
  await st.hold(0.8);
  console.log('  report:', file, fs.statSync(file).size);
}

module.exports = { open, ai, scans, curve, implants, hero, report, viewRect, implantState, scrollToOption, optionPoint };
