// The dual scan protocol, scene by scene (see scenes.cjs for the implant demo): the patient's CBCT
// taken with the denture in the mouth, the denture's own CBCT matched to it by its radiopaque
// markers, the denture cleaned up and placed.

const path = require('path');
const fs = require('fs');
const { plan } = require('./lib/plan-dual.cjs');
const { spline } = require('./lib/plan.cjs');

const series = (cfg, name) => { const d = path.join(cfg.dataDir, name); return fs.readdirSync(d).filter((f) => f.endsWith('.dcm')).sort().map((f) => path.join(d, f)); };
const loadedIdle = (page) => page.evaluate(() => !!window.app.vol && document.getElementById('loading').classList.contains('hidden'));
const viewRect = (page, view) => page.evaluate((view) => { const b = view.split('.').reduce((o, k) => o[k], window.app).el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }, view);
/** The mesh editor of the dual scan window (the app exposes it for its tests). */
const ED = `[...document.querySelectorAll('.modal-backdrop')].map((e) => e.__editor).find(Boolean)`;
const camera = (page) => page.evaluate(`(() => { const v = ${ED}.viewer, b = v.el.getBoundingClientRect(); return { ...v.camera(), rect: [b.x, b.y, b.width, b.height] }; })()`);
/** Points of the denture scan on screen (null where behind the camera). */
const project = (page, pts) => page.evaluate(`((pts) => { const v = ${ED}.viewer, b = v.el.getBoundingClientRect(); return pts.map((p) => { const s = v.project(p, v.el.clientWidth, v.el.clientHeight); return s ? [b.x + s[0], b.y + s[1]] : null; }); })(${JSON.stringify(pts)})`);
const editorState = (page) => page.evaluate(() => ({ parts: document.querySelector('.me-parts').textContent, holes: document.querySelector('.me-holes').textContent, stats: document.querySelector('.me-stats').textContent }));

// the viewer's orbit, as it turns the camera for a drag (src/meshViewer.ts): to find the drag that ends on a view
const rot = (v, k, a) => { const c = Math.cos(a), s = Math.sin(a), d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2]; const x = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]]; return v.map((q, i) => q * c + x[i] * s + k[i] * d * (1 - c)); };
function dragFor(cam, target) {
  const n = 40, t = Math.hypot(...target), goal = target.map((x) => x / t);
  let best = null;
  for (let dx = -520; dx <= 520; dx += 8) for (let dy = -400; dy <= 400; dy += 8) {
    let f = cam.fwd, r = cam.right, u = cam.up;
    for (let i = 0; i < n; i++) { const a = 0.006; let f2 = rot(f, u, (-dx / n) * a); const r2 = rot(r, u, (-dx / n) * a); f2 = rot(f2, r2, (-dy / n) * a); u = rot(u, r2, (-dy / n) * a); f = f2; r = r2; }
    const e = 1 - (f[0] * goal[0] + f[1] * goal[1] + f[2] * goal[2]) + 0.15 * Math.abs(r[2]) + 1e-7 * (dx * dx + dy * dy);
    if (!best || e < best.e) best = { e, dx, dy };
  }
  return best;
}
/** Turn the model with a drag (the Select tool) so that the camera looks along `target`. */
async function lookAlong(st, target, o = {}) {
  const cam = await camera(st.page), d = dragFor(cam, target);
  const c = [cam.rect[0] + cam.rect[2] * (o.fx ?? 0.5) - d.dx / 2, cam.rect[1] + cam.rect[3] * (o.fy ?? 0.5) - d.dy / 2];
  await st.drag([c, [c[0] + d.dx, c[1] + d.dy]], { dur: o.dur ?? 1.5, before: 0.15, after: o.after ?? 0.4 });
}

/** The patient's CBCT opens (in the installed app: by double-clicking a DICOM file; the editor shows that before this scene). */
async function dopen(st, cfg) {
  st.begin('dopen');
  await st.hold(0.3);
  await st.page.setInputFiles('#file-input', series(cfg, 'patient with denture'));
  await st.realtime(loadedIdle, { label: 'load', every: 100 });
  st.mark('dopen.loaded');
  await st.rect('viewport', '#viewport');
  await st.rect('mpr3d', await viewRect(st.page, 'view3d'));
  await st.moveTo(await st.page.evaluate(() => { const b = window.app.view3d.el.getBoundingClientRect(); return [b.x + b.width * 0.3, b.y + b.height * 0.7]; }), { dur: 0.7 });
  await st.hold(1.2);
}

/** Plan: the panoramic curve along the mandible. */
async function dcurve(st) {
  st.begin('dcurve');
  await st.rect('planTiles', '#viewport');
  await st.click('.tabs [data-mode="plan"]');
  await st.hold(1.0);
  const r = await viewRect(st.page, 'planAxial');
  await st.rect('planArea', r);
  st.mark('dcurve.open');
  const stroke = await st.page.evaluate((pts) => {
    const a = window.app, v = a.planAxial, b = v.el.getBoundingClientRect();
    return pts.map((p) => { const s = v.worldToScreen([p[0] + a.O[0], p[1] + a.O[1], a.O[2] + a.focusC]); return [b.x + s[0], b.y + s[1]]; });
  }, spline(plan.arch, 0.25));
  await st.drag(stroke, { dur: 1.7, before: 0.3, after: 0 });
  st.mark('dcurve.drawn');
  await st.hold(1.6);
  st.mark('dcurve.settled');
  await st.hold(0.9);
  for (const [name, v] of [['pano', 'pano'], ['plan3d', 'view3d'], ['planAxialTile', 'planAxial']]) await st.rect(name, await viewRect(st.page, v));
  console.log('  curve:', await st.page.evaluate(() => (window.app.curve ? { len: +window.app.curve.length.toFixed(1) } : null)));
}

/** Scans panel -> Dual scan: the CBCT of the denture alone; its markers are found and matched by the app. */
async function dscan(st, cfg) {
  st.begin('dscan');
  const page = st.page;
  await st.click('#rail [data-panel="scans"]', { after: 0.5 });
  await st.rect('dualBox', await page.evaluate(() => { const b = document.querySelector('#btn-dual-scan').closest('.dual-head').parentElement.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }));
  await st.rect('sidebar', '#sidebar');
  await st.click('#btn-dual-scan', { after: 0.6 });
  st.mark('dscan.source');
  await st.rect('sourceDialog', '.modal.dual-scan');
  await st.hold(0.5);
  // the folder is chosen in the system's dialog (not part of the page)
  const chooser = page.waitForEvent('filechooser', { timeout: 30_000 });
  await st.click('.ds-folder', { after: 0 });
  await (await chooser).setFiles(path.join(cfg.dataDir, 'denture only'));
  st.mark('dscan.chosen');
  await st.realtime((page) => page.evaluate(() => !!document.querySelector('.ds-create') && document.querySelector('.ds-busy').classList.contains('hidden') && /triangles/.test(document.querySelector('.me-stats')?.textContent ?? '')), { label: 'denture', every: 250 });
  st.mark('dscan.window');
  st.log.info = { ...(st.log.info ?? {}), markers: await page.evaluate(() => document.querySelector('.ds-result').textContent) };
  console.log('  markers:', st.log.info.markers);
  await st.rect('dualWindow', '.modal.dual-scan');
  await st.rect('dualSide', '.ds-side');
  await st.rect('dual3d', '.ds-3d');
  await st.rect('dualTools', '.me-tools');
  await st.moveTo(await st.point({ sel: '.ds-result', fx: 0.75, fy: 2.2 }), { dur: 0.7 });
  await st.hold(2.2);
}

/** The denture cleaned up: the sheet it lay on cut loose with the cut brush, islands removed, holes closed, the place smoothed. */
async function dclean(st) {
  st.begin('dclean');
  const page = st.page;
  for (const [n, s] of [['dualWindow', '.modal.dual-scan'], ['dual3d', '.ds-3d'], ['dualTools', '.me-tools'], ['dualSide', '.ds-side']]) await st.rect(n, s);
  // turn it over
  await lookAlong(st, plan.below, { dur: 1.6 });
  // closer
  const cam = await camera(page);
  await st.moveTo([cam.rect[0] + cam.rect[2] * 0.56, cam.rect[1] + cam.rect[3] * 0.5], { dur: 0.4 });
  await st.wheel(-3, { dur: 0.6 });
  await st.hold(0.3);
  st.mark('dclean.below');
  const lines = plan.sheet.lines.map(([a, b]) => { const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5)); return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, plan.sheet.z]); });
  await st.click('.me-tools [data-mode="cut"]', { after: 0.3 });
  for (const [i, l] of lines.entries()) {
    const pts = (await project(page, l)).filter(Boolean);
    await st.drag(pts, { dur: 1.3, before: 0.3, after: 0.4 });
  }
  st.mark('dclean.cut');
  let s = await editorState(page);
  console.log('  after the cut:', s.parts, '|', s.holes);
  if (!/parts/.test(s.parts) || /One part/.test(s.parts)) throw new Error('the sheet is still attached');
  await st.hold(0.4);
  await st.click('.me-keep', { after: 1.1 });
  st.mark('dclean.islands');
  s = await editorState(page);
  console.log('  islands removed:', s.parts, '|', s.holes, '|', s.stats);
  if (!(await page.evaluate(() => document.querySelector('.me-fill').disabled))) await st.click('.me-fill', { after: 1.2 });
  st.mark('dclean.holes');
  console.log('  holes closed:', (await editorState(page)).holes);
  // smooth where the sheet was: a larger brush, two passes
  await st.click('.me-tools [data-mode="smooth"]', { after: 0.25 });
  const slider = async (v) => page.evaluate((v) => { const e = document.querySelector('.me-radius'), b = e.getBoundingClientRect(), th = 16; return [b.x + th / 2 + ((v - +e.min) / (+e.max - +e.min)) * (b.width - th), b.y + b.height / 2]; }, v);
  await st.drag([await slider(await page.evaluate(() => +document.querySelector('.me-radius').value)), await slider(plan.smoothRadius)], { dur: 0.5, before: 0.1, after: 0.25 });
  // back and forth over the closed hole, a little to each side of the line and beyond its ends
  const [la, lb] = plan.sheet.lines[0], len = Math.hypot(lb[0] - la[0], lb[1] - la[1]), dir = [(lb[0] - la[0]) / len, (lb[1] - la[1]) / len];
  for (const [pass, off] of [-0.9, 0.9, -0.3, 0.5].entries()) {
    const n = Math.ceil((len + 5) / 0.5);
    const l = Array.from({ length: n + 1 }, (_, i) => { const t = -2.5 + ((len + 5) * i) / n; return [la[0] + dir[0] * t - dir[1] * off, la[1] + dir[1] * t + dir[0] * off, plan.sheet.z]; });
    const pts = (await project(page, pass % 2 ? l.reverse() : l)).filter(Boolean);
    await st.drag(pts, { dur: 1.0, before: 0.15, after: 0.2 });
  }
  st.mark('dclean.smooth');
  // the whole denture again
  await st.click('.me-tools [data-mode="select"]', { after: 0.2 });
  await st.click('.me-fit', { after: 0.5 });
  await lookAlong(st, [0.55, 0.62, -0.56], { dur: 1.4, after: 0.6 });
  st.mark('dclean.done');
}

/** Placed in the patient's CBCT by the markers: its outline in the slices, the denture on the jaw in 3D. */
async function dplace(st, cfg) {
  st.begin('dplace');
  const page = st.page;
  await st.click('.ds-create', { after: 0 });
  await st.realtime((page) => page.evaluate(() => !document.querySelector('.ds-create') && window.app.scans.length > 0 && document.getElementById('loading').classList.contains('hidden')), { label: 'place', every: 200 });
  st.mark('dplace.placed');
  for (const [name, v] of [['pano', 'pano'], ['cs1', 'crossViews.0'], ['cs3', 'crossViews.2'], ['tang', 'tang'], ['plan3d', 'view3d'], ['planAxialTile', 'planAxial']]) await st.rect(name, await viewRect(page, v));
  await st.rect('viewport', '#viewport');
  await st.moveTo(await page.evaluate(() => { const b = window.app.pano.el.getBoundingClientRect(); return [b.x + b.width * 0.5, b.y + b.height * 0.8]; }), { dur: 0.7 });
  await st.hold(2.2);
  // 3D
  const Q = cfg && cfg.draft3d ? undefined : plan.hero.appMs;
  await st.click(await page.evaluate(() => { const b = window.app.view3d.el.querySelector('.max-btn').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }));
  await st.hold(0.7);
  st.mark('dplace.max');
  const r = await viewRect(page, 'view3d');
  await st.rect('hero3d', r);
  await st.rect('objects', '#objects');
  const c = [r[0] + r[2] * 0.56, r[1] + r[3] * 0.52];
  await st.moveTo(c);
  await st.hold(0.2, Q);
  await st.drag([c, [c[0] + plan.hero.orbit[0], c[1] + plan.hero.orbit[1]]], { dur: 2.6, before: 0.1, after: 0.3, appMs: Q, ease: (t) => t * t * (3 - 2 * t) });
  st.mark('dplace.turned');
  await st.moveTo([r[0] + r[2] * 0.9, r[1] + r[3] * 0.88], { appMs: Q, dur: 0.5 });
  await st.hold(1.0, Q);
}

module.exports = { dopen, dcurve, dscan, dclean, dplace };
