// Waxup: library teeth set up on the arch, exocad-style editing in 3D and in the panoramic,
// undo, project round trip, STL export.
import { type Page } from '@playwright/test';
import { clickView, expect, openDemo, test } from './fixtures';

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

test('teeth are set up on the arch and edited like in a dental CAD', async ({ page }) => {
  test.setTimeout(180_000);
  await curveAndLowerArch(page);
  expect(await page.evaluate(() => window.app.wax.editing)).toBe(true);
  await expect(page.locator('[data-panel="waxup"] .rail-badge')).toHaveText('14');
  await expect(page.locator('#wax-chart button.on')).toHaveCount(14);

  await page.evaluate(() => {
    window.app.toggleMaximize(window.app.view3d);
    window.app.view3d.setPreset('top');
    window.app.changed();
  });
  await page.waitForTimeout(800);

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

  // Shift+drag = scale; chain mode pushes the neighbour
  q = await in3d(page, 36);
  const n0 = await center(page, 37);
  await page.keyboard.down('Shift');
  await page.mouse.move(q[0] + 20, q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 60, q[1], { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(page.locator('#wax-sel-info')).not.toHaveText(/^100 %/);
  expect(dist(await center(page, 37), n0)).toBeGreaterThan(0.2);

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

  // parts: drag a cusp dot
  await page.click('[data-wt="parts"]');
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
  await page.click('[data-wt="freeform"]');
  q = await in3d(page, 46);
  await page.mouse.move(q[0] - 6, q[1]);
  await page.mouse.down();
  await page.mouse.move(q[0] + 10, q[1] + 4, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.app.wax.model.tooth(46).geo)).toBeGreaterThan(0);

  // panoramic: drag 43 upwards
  await page.click('[data-wt="position"]');
  await page.evaluate(() => (window.app.toggleMaximize(window.app.view3d), window.app.changed()));
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
  await page.click('[data-ws="jaw"]');
  const j0 = await center(page, 31);
  const p44 = await inPano(page, 44);
  await page.mouse.move(p44[0], p44[1]);
  await page.mouse.down();
  await page.mouse.move(p44[0], p44[1] + 20, { steps: 5 });
  await page.mouse.up();
  expect(j0[2] - (await center(page, 31))[2]).toBeGreaterThan(1);

  // another panel: the teeth no longer react
  await page.click('[data-panel="implants"]');
  expect(await page.evaluate(() => window.app.wax.editing)).toBe(false);
});

test('mirror mode changes the other side too', async ({ page }) => {
  await curveAndLowerArch(page);
  await page.check('#wax-mirror');
  await page.uncheck('#wax-chain');
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
  test.setTimeout(150_000);
  await curveAndLowerArch(page);
  // shape one tooth
  await page.click('[data-wt="freeform"]');
  await page.evaluate(() => {
    window.app.toggleMaximize(window.app.view3d);
    window.app.view3d.setPreset('top');
    window.app.changed();
  });
  await page.waitForTimeout(600);
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
