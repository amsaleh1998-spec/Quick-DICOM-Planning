// Waxup: library teeth set up on the arch, exocad-style editing in 3D and in the panoramic,
// undo, project round trip, STL export.
import { type Page } from '@playwright/test';
import { clickView, expect, openDemo, test } from './fixtures';

// a smaller window: the 3D view is rendered in software in CI
test.use({ viewport: { width: 1200, height: 760 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => ((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined));
});

async function curveAndLowerArch(page: Page) {
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('Enter');
  await page.click('[data-panel="waxup"]');
  // the waxup is worked on in 3D: its panel enlarges the 3D view
  expect(await page.evaluate(() => window.app.view3d.el.classList.contains('max'))).toBe(true);
  await page.click('#wax-all-lower');
  await expect.poll(() => page.evaluate(() => window.app.wax.model.teeth.length), { timeout: 20_000 }).toBe(14);
}

/** screen position of a tooth's centre in the 3D view / the panoramic */
const in3d = (page: Page, fdi: number) =>
  page.evaluate((fdi) => {
    const a = window.app;
    const s = a.view3d.projectPoint(a.wax.model.center(a.wax.model.tooth(fdi)));
    const r = a.view3d.el.getBoundingClientRect();
    return [r.x + s[0], r.y + s[1]] as [number, number];
  }, fdi);
const inPano = (page: Page, fdi: number) =>
  page.evaluate((fdi) => {
    const a = window.app;
    const pr = a.pano.project(a.wax.model.center(a.wax.model.tooth(fdi)));
    const r = a.pano.el.getBoundingClientRect();
    return [r.x + pr.x, r.y + pr.y] as [number, number];
  }, fdi);
const center = (page: Page, fdi: number) => page.evaluate((fdi) => window.app.wax.model.center(window.app.wax.model.tooth(fdi)), fdi);
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** 3D view enlarged (true) or all views shown (false) */
const maximize3d = (page: Page, on: boolean) =>
  page.evaluate((on) => {
    const a = window.app;
    if (a.view3d.el.classList.contains('max') !== on) a.toggleMaximize(a.view3d);
    a.changed();
  }, on);
const topView = async (page: Page) => {
  await page.evaluate(() => (window.app.view3d.setPreset('top'), window.app.changed()));
  await page.waitForTimeout(600);
};

test('teeth are set up on the arch and edited like in a dental CAD', async ({ page }) => {
  test.setTimeout(300_000);
  await curveAndLowerArch(page);
  expect(await page.evaluate(() => window.app.wax.editing)).toBe(true);
  await expect(page.locator('[data-panel="waxup"] .rail-badge')).toHaveText('14');
  await expect(page.locator('#wax-chart button.on')).toHaveCount(14);

  await maximize3d(page, true);
  await topView(page);

  // drag = move
  let q = await in3d(page, 36);
  const c0 = await center(page, 36);
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 30, q[1], { steps: 5 });
  await page.mouse.up();
  expect(dist(await center(page, 36), c0)).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.app.wax.selected)).toBe(36);
  await expect(page.locator('#wax-sel-name')).toHaveText('Tooth 36');

  // Shift+drag = scale (Simple: the neighbour stays)
  q = await in3d(page, 36);
  const n0 = await center(page, 37);
  await page.keyboard.down('Shift');
  await page.mouse.move(q[0] + 20, q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 60, q[1], { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(page.locator('#wax-sel-info')).not.toHaveText(/^100 %/);
  expect(dist(await center(page, 37), n0)).toBeLessThan(1e-6);

  // Ctrl+drag = rotate, and undo brings it back
  const T0 = await page.evaluate(() => window.app.wax.model.tooth(36).T.slice());
  q = await in3d(page, 36);
  await page.keyboard.down('Control');
  await page.mouse.move(q[0] + 30, q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0], q[1] + 30, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  expect(await page.evaluate(() => window.app.wax.model.tooth(36).T)).not.toEqual(T0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('#status-msg')).toContainText('Undo: waxup');
  const T1 = await page.evaluate(() => window.app.wax.model.tooth(36).T);
  T1.forEach((v: number, i: number) => expect(v).toBeCloseTo(T0[i], 6));

  // cusps: drag a dot
  await page.click('[data-wtab="advanced"]');
  await page.click('[data-wv="cusps"]');
  const tip = await page.evaluate(() => {
    const a = window.app;
    const t = a.wax.model.tooth(36);
    const p = a.wax.model.partTips(t)[0];
    const T = t.T;
    const w = [0, 1, 2].map((r) => T[r * 4] * p[0] + T[r * 4 + 1] * p[1] + T[r * 4 + 2] * p[2] + T[r * 4 + 3]);
    const s = a.view3d.projectPoint(w);
    const r = a.view3d.el.getBoundingClientRect();
    return [r.x + s[0], r.y + s[1]];
  });
  await page.mouse.move(tip[0], tip[1]);
  await expect.poll(() => page.evaluate(() => window.app.wax.hoverPart?.fdi)).toBe(36);
  await page.mouse.down();
  await page.mouse.move(tip[0] + 12, tip[1] - 10, { steps: 4 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.app.wax.model.tooth(36).geo)).toBeGreaterThan(0);
  await expect(page.locator('#wax-sel-info')).toContainText('shaped');

  // freeform: a stroke over 46
  await page.click('[data-wv="freeform"]');
  q = await in3d(page, 46);
  await page.mouse.move(q[0] - 6, q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 10, q[1] + 4, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.app.wax.model.tooth(46).geo)).toBeGreaterThan(0);

});

test('teeth are moved in the panoramic, deleted, and moved as a whole jaw', async ({ page }) => {
  test.setTimeout(300_000);
  await curveAndLowerArch(page);
  // panoramic: drag 43 upwards
  await maximize3d(page, false);
  await page.waitForTimeout(400);
  const p43 = await inPano(page, 43);
  const z0 = (await center(page, 43))[2];
  await page.mouse.move(p43[0], p43[1]);
  await page.mouse.down();
  await page.mouse.move(p43[0], p43[1] - 25, { steps: 5 });
  await page.mouse.up();
  expect((await center(page, 43))[2] - z0).toBeGreaterThan(1);
  // Del removes the selected tooth
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => window.app.wax.model.tooth(43))).toBeNull();
  await expect(page.locator('[data-panel="waxup"] .rail-badge')).toHaveText('13');

  // whole jaw
  await page.check('#wax-move-all');
  const j0 = await center(page, 31);
  const p44 = await inPano(page, 44);
  await page.mouse.move(p44[0], p44[1]);
  await page.mouse.down();
  await page.mouse.move(p44[0], p44[1] + 20, { steps: 5 });
  await page.mouse.up();
  expect(j0[2] - (await center(page, 31))[2]).toBeGreaterThan(1);

  // another panel: the panel's own tools are off (the 3D view still lets teeth be grabbed)
  await page.click('[data-panel="implants"]');
  expect(await page.evaluate(() => window.app.wax.editing)).toBe(false);
});

test('in 3D a tooth is grabbed from any panel; leaving the panel restores the layout', async ({ page }) => {
  test.setTimeout(300_000);
  await curveAndLowerArch(page);
  // leaving the Waxup panel shows all views again
  await page.click('[data-panel="implants"]');
  expect(await page.evaluate(() => [window.app.wax.editing, window.app.view3d.el.classList.contains('max')])).toEqual([false, false]);
  await maximize3d(page, true);
  await topView(page);
  // a drag that starts on a tooth moves it, and opens the Waxup panel with it
  let q = await in3d(page, 36);
  const c0 = await center(page, 36);
  await page.mouse.move(q[0], q[1]);
  await expect(page.locator('#status-msg')).toContainText('Tooth 36');
  await page.mouse.down();
  await page.mouse.move(q[0] + 30, q[1], { steps: 5 });
  await page.mouse.up();
  expect(dist(await center(page, 36), c0)).toBeGreaterThan(1);
  await expect(page.locator('#panel-waxup')).toBeVisible();
  expect(await page.evaluate(() => [window.app.wax.editing, window.app.wax.selected])).toEqual([true, 36]);
  // a drag on empty space rotates the view, the teeth stay
  const before = await page.evaluate(() => window.app.wax.model.teeth.map((t: { T: number[] }) => t.T.join()).join('|'));
  const fwd0 = await page.evaluate(() => window.app.view3d.fwd.slice());
  const r = await page.evaluate(() => {
    const e = window.app.view3d.el.getBoundingClientRect();
    return [e.x + 30, e.y + e.height - 40];
  });
  await page.mouse.move(r[0], r[1]);
  await page.mouse.down();
  await page.mouse.move(r[0] + 60, r[1] - 20, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.app.wax.model.teeth.map((t: { T: number[] }) => t.T.join()).join('|'))).toBe(before);
  expect(await page.evaluate(() => window.app.view3d.fwd)).not.toEqual(fwd0);
  // cusps tool: dragging the body (not a dot) moves the tooth
  await topView(page);
  await page.click('[data-wtab="advanced"]');
  await page.click('[data-wv="cusps"]');
  q = await in3d(page, 46);
  const m0 = await center(page, 46);
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 25, q[1], { steps: 4 });
  await page.mouse.up();
  expect(dist(await center(page, 46), m0)).toBeGreaterThan(1);
});

test('tools left on in other panels do not block the waxup', async ({ page }) => {
  test.setTimeout(300_000);
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('Enter');
  // a segment's "Click to add" left on, then nerve tracing left on
  await page.click('[data-panel="segments"]');
  await page.click('[data-seg-preset="1"]');
  expect(await page.evaluate(() => window.app.segTool)).toBe('grow');
  await page.click('[data-panel="nerves"]');
  await page.click('#btn-nerve-right');
  expect(await page.evaluate(() => window.app.segTool)).toBe('nerve');
  await page.click('[data-panel="waxup"]');
  expect(await page.evaluate(() => window.app.segTool)).toBeNull();
  await page.click('#wax-all-lower');
  await expect.poll(() => page.evaluate(() => window.app.wax.model.teeth.length), { timeout: 20_000 }).toBe(14);
  await topView(page);
  const q = await in3d(page, 36);
  const c0 = await center(page, 36);
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 30, q[1], { steps: 5 });
  await page.mouse.up();
  expect(dist(await center(page, 36), c0)).toBeGreaterThan(1);
});

test('symmetry changes the other side too', async ({ page }) => {
  test.setTimeout(300_000);
  await curveAndLowerArch(page);
  await page.click('[data-wtab="advanced"]');
  await page.click('#wax-sym');
  await expect(page.locator('#wax-sym')).toHaveAttribute('aria-pressed', 'true');
  await page.click('[data-wtab="simple"]');
  await maximize3d(page, false);
  await page.waitForTimeout(300);
  const a0 = await center(page, 33);
  const b0 = await center(page, 43);
  const p = await inPano(page, 33);
  await page.mouse.move(p[0], p[1]);
  await page.mouse.down();
  await page.mouse.move(p[0], p[1] - 20, { steps: 4 });
  await page.mouse.up();
  const a1 = await center(page, 33);
  const b1 = await center(page, 43);
  expect(a1[2] - a0[2]).toBeGreaterThan(1);
  expect(b1[2] - b0[2]).toBeCloseTo(a1[2] - a0[2], 1);
});

test('the waxup is saved with the project and exported as STL', async ({ page }) => {
  test.setTimeout(300_000);
  await curveAndLowerArch(page);
  // shape one tooth
  await page.click('[data-wtab="advanced"]');
  await page.click('[data-wv="freeform"]');
  await maximize3d(page, true);
  await topView(page);
  const q = await in3d(page, 36);
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 8, q[1], { steps: 4 });
  await page.mouse.up();
  const before = await page.evaluate(() => {
    const t = window.app.wax.model.tooth(36);
    return { T: t.T, sum: Array.from(t.pos as Float32Array).reduce((a, b) => a + b, 0), n: window.app.wax.model.teeth.length };
  });
  // export dialog lists the jaw
  await page.click('#btn-export-menu');
  await page.click('#btn-export-stl');
  await expect(page.locator('.export-stl')).toContainText('Lower teeth (31, 32');
  await page.click('.export-stl .modal-close');
  // save and reopen
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#btn-save-project')]);
  const file = test.info().outputPath('waxup.qdp.zip');
  await dl.saveAs(file);
  await page.goto('./');
  await page.setInputFiles('#project-input', file);
  await page.waitForFunction(() => window.app.wax.model.teeth.length > 0, null, { timeout: 60_000 });
  const after = await page.evaluate(() => {
    const t = window.app.wax.model.tooth(36);
    return { T: t.T, sum: Array.from(t.pos as Float32Array).reduce((a, b) => a + b, 0), n: window.app.wax.model.teeth.length, shaped: t.geo > 0 };
  });
  expect(after.n).toBe(before.n);
  expect(after.shaped).toBe(true);
  expect(after.sum).toBeCloseTo(before.sum, 1);
  after.T.forEach((v: number, i: number) => expect(v).toBeCloseTo(before.T[i], 6));
  // a freshly opened project has nothing to save or undo
  await expect(page.locator('#btn-save-project')).not.toHaveClass(/dirty/);
  expect(await page.evaluate(() => window.app.undoCount)).toBe(0);
});

/** screen position of a chain control point (tooth or disc) in the 3D view */
const controlIn3d = (page: Page, key: string) =>
  page.evaluate((key) => {
    const a = window.app;
    const r = a.view3d.el.getBoundingClientRect();
    for (const c of a.view3d.waxEditor.controls()) {
      for (const p of c.points) if (p.key === key) return add(a.view3d.projectPoint(p.w));
      for (const d of c.discs) if (d.key === key) return add(a.view3d.projectPoint(d.ctl));
    }
    return null;
    function add(s: number[]) {
      return [r.x + s[0], r.y + s[1]] as [number, number];
    }
  }, key);
const discIn3d = (page: Page, key: string) =>
  page.evaluate((key) => {
    const a = window.app;
    const r = a.view3d.el.getBoundingClientRect();
    for (const c of a.view3d.waxEditor.controls())
      for (const d of c.discs) if (d.key === key) {
        const s = a.view3d.projectPoint(d.c);
        return [r.x + s[0], r.y + s[1]] as [number, number];
      }
    return null;
  }, key);
const Ts = (page: Page) => page.evaluate(() => Object.fromEntries(window.app.wax.model.teeth.map((t: { fdi: number; T: number[] }) => [t.fdi, t.T.slice()])));
/** largest distance between the touching contacts of neighbours (lower jaw) */
const worstContact = (page: Page) =>
  page.evaluate(() => {
    const w = window.app.wax;
    const ts = w.model.jawTeeth('lower');
    let worst = 0;
    for (let i = 0; i + 1 < ts.length; i++) {
      const b = w.contacts(ts[i]).b, a = w.contacts(ts[i + 1]).a;
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    return worst;
  });
/** mesial-distal width of a tooth (world) */
const width = (page: Page, fdi: number) =>
  page.evaluate((fdi) => {
    const w = window.app.wax;
    const t = w.model.tooth(fdi);
    const md = w.axes(t).md;
    const T = t.T, p = t.pos;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const v = [0, 1, 2].map((r) => T[r * 4] * p[i] + T[r * 4 + 1] * p[i + 1] + T[r * 4 + 2] * p[i + 2] + T[r * 4 + 3]);
      const d = v[0] * md[0] + v[1] * md[1] + v[2] * md[2];
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return hi - lo;
  }, fdi);

test('chain tab: pins, chain / single / tube, discs, reset and contacts', async ({ page }) => {
  test.setTimeout(300_000);
  await curveAndLowerArch(page);
  await page.click('[data-wtab="chain"]');
  await maximize3d(page, true);
  await topView(page);
  // the setup is in contact
  expect(await worstContact(page)).toBeLessThan(0.15);

  // click the green point of 33: pinned
  let q = (await controlIn3d(page, 't33'))!;
  await page.mouse.move(q[0], q[1]);
  await expect(page.locator('#status-msg')).toContainText('Click to pin tooth 33');
  await page.mouse.down();
  await page.mouse.up();
  expect(await page.evaluate(() => [...window.app.wax.pins])).toEqual(['t33']);

  // chain: dragging 36 carries 34–37 along, 33 and the right side stay
  let before = await Ts(page);
  const c0 = { 34: await center(page, 34), 36: await center(page, 36), 42: await center(page, 42) };
  q = await in3d(page, 36);
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 30, q[1], { steps: 5 });
  await page.mouse.up();
  let after = await Ts(page);
  expect(after[33]).toEqual(before[33]);
  expect(after[42]).toEqual(before[42]);
  const m36 = dist(await center(page, 36), c0[36]);
  const m34 = dist(await center(page, 34), c0[34]);
  expect(m36).toBeGreaterThan(1);
  expect(m34).toBeGreaterThan(0.05);
  expect(m34).toBeLessThan(m36);
  expect(await worstContact(page)).toBeLessThan(0.15);
  // one undo step brings the whole chain back
  await page.click('#wax-undo');
  expect(await Ts(page)).toEqual(before);

  // single: Shift+drag grows 44, its neighbours slide away and stay in contact
  await page.click('[data-cm="single"]');
  before = await Ts(page);
  const y45 = await center(page, 45);
  q = await in3d(page, 44);
  await page.keyboard.down('Shift');
  await page.mouse.move(q[0] + 10, q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 60, q[1], { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(dist(await center(page, 45), y45)).toBeGreaterThan(0.2);
  expect(await worstContact(page)).toBeLessThan(0.2);
  expect((await Ts(page))[33]).toEqual(before[33]);

  // tube: the teeth slide along the arch
  await page.click('[data-cm="tube"]');
  await expect(page.locator('#wax-contact')).toBeDisabled();
  const t31 = await center(page, 31);
  q = await in3d(page, 31);
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] - 30, q[1], { steps: 5 });
  await page.mouse.up();
  expect(dist(await center(page, 31), t31)).toBeGreaterThan(0.5);

  // a disc: seen from the front, drag the end behind 37 – the other end stays
  await page.click('[data-cm="chain"]');
  await page.evaluate(() => (window.app.view3d.setPreset('front'), window.app.changed()));
  await page.waitForTimeout(600);
  before = await Ts(page);
  const aEnd = await page.evaluate(() => window.app.wax.contacts(window.app.wax.model.tooth(47)).a);
  q = (await discIn3d(page, 'b37'))!;
  await page.mouse.move(q[0], q[1]);
  await expect(page.locator('#status-msg')).toContainText('End of the chain');
  await page.mouse.down();
  await page.mouse.move(q[0] - 20, q[1] - 10, { steps: 5 });
  await page.mouse.up();
  after = await Ts(page);
  expect(after[37]).not.toEqual(before[37]);
  const aEnd2 = await page.evaluate(() => window.app.wax.contacts(window.app.wax.model.tooth(47)).a);
  expect(dist(aEnd2, aEnd)).toBeLessThan(0.01);

  // reset (keep pinned): the teeth go back on the arch, 33 stays
  const p33 = (await Ts(page))[33];
  await page.click('#wax-creset');
  await page.click('[data-reset="unpinned"]');
  expect((await Ts(page))[33]).toEqual(p33);
  expect(await worstContact(page)).toBeLessThan(0.3);

  // keep in contact off: a single tooth moves alone; on again: contacts are closed
  await page.click('[data-cm="single"]');
  await page.uncheck('#wax-contact');
  await topView(page);
  before = await Ts(page);
  q = await in3d(page, 42);
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0], q[1] - 25, { steps: 5 });
  await page.mouse.up();
  after = await Ts(page);
  expect(after[42]).not.toEqual(before[42]);
  expect(after[41]).toEqual(before[41]);
  expect(await worstContact(page)).toBeGreaterThan(0.5);
  await page.check('#wax-contact');
  expect(await worstContact(page)).toBeLessThan(0.3);
});

test('simple limits, scaling in one direction, axis handles and 1-to-1 mirroring', async ({ page }) => {
  test.setTimeout(300_000);
  await curveAndLowerArch(page);
  await maximize3d(page, true);
  // occlusal direction only (seen from the front): a slanted drag moves the tooth only up / down
  await page.evaluate(() => (window.app.view3d.setPreset('front'), window.app.changed()));
  await page.waitForTimeout(600);
  await page.check('input[name="wax-limit"][value="oc"]');
  const c0 = await center(page, 41);
  let q = await in3d(page, 41);
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 30, q[1] - 20, { steps: 5 });
  await page.mouse.up();
  const c1 = await center(page, 41);
  const ax = await page.evaluate(() => window.app.wax.axes(window.app.wax.model.tooth(41)));
  const mv = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
  const along = mv[0] * ax.oc[0] + mv[1] * ax.oc[1] + mv[2] * ax.oc[2];
  expect(Math.abs(along)).toBeGreaterThan(0.5);
  expect(Math.hypot(mv[0] - along * ax.oc[0], mv[1] - along * ax.oc[1], mv[2] - along * ax.oc[2])).toBeLessThan(0.01);
  await page.check('input[name="wax-limit"][value="all"]');
  await topView(page);

  // Ctrl+Shift: scaled in one direction only (the tooth is no longer scaled the same in all directions)
  q = await in3d(page, 36);
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 40, q[1], { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  const sv = await page.evaluate(() => {
    const T = window.app.wax.model.tooth(36).T;
    return [0, 1, 2].map((c) => Math.hypot(T[c], T[4 + c], T[8 + c]));
  });
  expect(Math.max(...sv) - Math.min(...sv)).toBeGreaterThan(0.05);

  // advanced, axis scaling: drag the red handle of 46 outwards
  await page.click('[data-wtab="advanced"]');
  await expect(page.locator('[data-wv="axis"]')).toHaveClass(/active/);
  await page.evaluate(() => ((window.app.wax.selected = 46), window.app.changed()));
  const h = await page.evaluate(() => {
    const a = window.app;
    const ed = a.view3d.waxEditor;
    const hs = ed.axisHandles(a.wax.model.tooth(46));
    const r = a.view3d.el.getBoundingClientRect();
    const s = a.view3d.projectPoint(hs[0].p);
    const c = a.view3d.projectPoint(a.wax.model.center(a.wax.model.tooth(46)));
    return { h: [r.x + s[0], r.y + s[1]], c: [r.x + c[0], r.y + c[1]] };
  });
  const w0 = await width(page, 46);
  await page.mouse.move(h.h[0], h.h[1]);
  await expect.poll(() => page.evaluate(() => window.app.wax.hoverCtl)).toMatch(/^ax:46:/);
  await page.mouse.down();
  await page.mouse.move(h.h[0] + (h.h[0] - h.c[0]) * 0.4, h.h[1] + (h.h[1] - h.c[1]) * 0.4, { steps: 5 });
  await page.mouse.up();
  expect(await width(page, 46)).toBeGreaterThan(w0 * 1.15);

  // 1-to-1 mirroring: 46 becomes the mirror image of 36 when a cusp of 36 is moved
  await page.click('#wax-one');
  await page.click('[data-wv="cusps"]');
  await page.evaluate(() => ((window.app.wax.selected = 36), window.app.changed()));
  const tip = await page.evaluate(() => {
    const a = window.app;
    const t = a.wax.model.tooth(36);
    const p = a.wax.model.partTips(t)[0];
    const T = t.T;
    const w = [0, 1, 2].map((r) => T[r * 4] * p[0] + T[r * 4 + 1] * p[1] + T[r * 4 + 2] * p[2] + T[r * 4 + 3]);
    const s = a.view3d.projectPoint(w);
    const r = a.view3d.el.getBoundingClientRect();
    return [r.x + s[0], r.y + s[1]];
  });
  await page.mouse.move(tip[0], tip[1]);
  await expect.poll(() => page.evaluate(() => window.app.wax.hoverPart?.fdi)).toBe(36);
  await page.mouse.down();
  await page.mouse.move(tip[0] + 8, tip[1] - 8, { steps: 4 });
  await page.mouse.up();
  // the other tooth's vertices are this one's, mirrored across the library midline
  const sym = await page.evaluate(() => {
    const m = window.app.wax.model;
    const a = m.tooth(36).pos, b = m.tooth(46).pos;
    if (a.length !== b.length) return Infinity;
    let worst = 0;
    for (let i = 0; i < a.length; i += 3) worst = Math.max(worst, Math.abs(a[i] + b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    return worst;
  });
  expect(sym).toBeLessThan(1e-4);
  expect(await page.evaluate(() => window.app.wax.model.tooth(36).geo)).toBeGreaterThan(0);
  // saved with the project as its own mesh
  expect(await page.evaluate(() => window.app.wax.model.tooth(46).idx !== window.app.wax.model.lib.teeth.get(46).idx)).toBe(true);
});

test('antagonist cutting and abrasion', async ({ page }) => {
  test.setTimeout(300_000);
  await curveAndLowerArch(page);
  await page.click('#wax-all-upper');
  await expect.poll(() => page.evaluate(() => window.app.wax.model.teeth.length), { timeout: 20_000 }).toBe(28);
  await page.click('[data-wtab="advanced"]');
  // the lower teeth are the upper teeth's antagonist (and the other way round)
  await expect(page.locator('[data-ant-src="upper"]')).toHaveText('Against: lower waxup teeth');
  await expect(page.locator('[data-ant-src="lower"]')).toHaveText('Against: upper waxup teeth');

  // cut on for the upper jaw: 16 pushed down into the lower teeth is cut, and undo restores it
  await page.click('[data-cut="upper"]');
  await expect(page.locator('[data-cut="upper"]')).toHaveAttribute('aria-pressed', 'true');
  await page.click('[data-wtab="simple"]');
  await page.check('input[name="wax-limit"][value="oc"]');
  await maximize3d(page, true);
  // seen from the patient's right side, where 16 is in front
  for (const side of ['right', 'left']) {
    await page.evaluate((side) => (window.app.view3d.setPreset(side), window.app.changed()), side);
    await page.waitForTimeout(600);
    const q = await in3d(page, 16);
    const hit = await page.evaluate((q) => {
      const r = window.app.view3d.el.getBoundingClientRect();
      return window.app.view3d.toothAt([q[0] - r.x, q[1] - r.y])?.fdi;
    }, q);
    if (hit === 16) break;
  }
  // the lowest point of 16 (along the vertical) before and after
  const lowest = () =>
    page.evaluate(() => {
      const w = window.app.wax;
      const t = w.model.tooth(16);
      const up = window.app.frame[2];
      const T = t.T, p = t.pos;
      let lo = Infinity;
      for (let i = 0; i < p.length; i += 3) {
        const v = [0, 1, 2].map((r) => T[r * 4] * p[i] + T[r * 4 + 1] * p[i + 1] + T[r * 4 + 2] * p[i + 2] + T[r * 4 + 3]);
        lo = Math.min(lo, v[0] * up[0] + v[1] * up[1] + v[2] * up[2]);
      }
      return lo;
    });
  const lo0 = await lowest();
  const q = await in3d(page, 16);
  await page.mouse.move(q[0], q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0], q[1] + 40, { steps: 6 });
  await page.mouse.up();
  const moved = await page.evaluate(() => window.app.wax.model.tooth(16).geo);
  expect(moved).toBeGreaterThan(0);
  expect(await lowest()).toBeLessThan(lo0);
  await page.click('#wax-undo');
  expect(await page.evaluate(() => window.app.wax.model.tooth(16).geo)).toBe(0);

  // apply to all: the lower teeth against the upper ones
  await page.click('[data-wtab="advanced"]');
  await page.click('[data-cut-all="lower"]');
  await expect(page.locator('#status-msg')).toContainText(/lower tooth reaches into the antagonist|lower teeth cut/);

  // abrasion: the back teeth worn flat, the front teeth unchanged; undo brings the library shape back
  await page.click('[data-ag="posterior"]');
  const top = (fdi: number) => page.evaluate((fdi) => Math.max(...Array.from(window.app.wax.model.tooth(fdi).pos as Float32Array).filter((_, i) => i % 3 === 2)), fdi);
  const top46 = await top(46), top41 = await top(41);
  await page.evaluate(() => {
    const s = document.getElementById('wax-abr') as HTMLInputElement;
    s.value = '0.8';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#wax-abr-val')).toHaveText('flat 80 %');
  expect(await top(46)).toBeLessThan(top46 - 0.8);
  expect(await top(41)).toBeCloseTo(top41, 5);
  // teeth added later get the same abrasion
  await page.click('#wax-chart button[data-fdi="48"]');
  await expect.poll(() => page.evaluate(() => window.app.wax.model.tooth(48)?.geo ?? -1)).toBeGreaterThan(0);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(page.locator('#wax-abr-val')).toHaveText('library');
  expect(await top(46)).toBeCloseTo(top46, 5);
});
