// Implant libraries: a manufacturer's implant for the selected implant and for new ones, generic
// again, undo, and the project round trip.
import { type Page } from '@playwright/test';
import { clickView, expect, openDemo, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => ((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined));
});

async function curveAndImplant(page: Page) {
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('Enter');
  await addLower(page, 0.4);
}
async function addLower(page: Page, fx: number) {
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', fx, 0.55);
}
const sel = (page: Page) => page.evaluate(() => {
  const i = window.app.selectedImplant();
  return i && { lib: i.lib?.id ?? null, d: i.diameter, L: i.length, top: i.lib?.top ?? 0 };
});

test('library implants: choose a model, defaults for new implants, generic again, undo, project', async ({ page }) => {
  test.setTimeout(240_000);
  await curveAndImplant(page);
  await expect(page.locator('#imp-brand option')).not.toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#imp-generic')).toBeVisible();

  await page.selectOption('#imp-brand', 'Straumann');
  await page.selectOption('#imp-system', 'BLX SLActive');
  let s = (await sel(page))!;
  expect(s.lib).toMatch(/^Straumann \/ BLX SLActive \/ /);
  await expect(page.locator('#imp-generic')).toBeHidden();
  await expect(page.locator('#implant-list li.sel')).toContainText('BLX SLActive');

  await page.selectOption('#imp-size', '4.5 × 12 mm');
  s = (await sel(page))!;
  expect(s.lib).toBe('Straumann / BLX SLActive / 4.5 × 12 mm');
  expect(s.L).toBeCloseTo(12, 0);
  expect(s.d).toBeGreaterThan(4.4);
  // the slices show the cut through its mesh once it has loaded
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('implants/straumann-blx-slactive.json')))).toBe(true);

  // the model chosen last is the default for new implants
  await addLower(page, 0.6);
  expect((await sel(page))!.lib).toBe('Straumann / BLX SLActive / 4.5 × 12 mm');
  expect(await page.evaluate(() => window.app.implants.length)).toBe(2);

  // generic again: the size is kept and can be typed
  await page.selectOption('#imp-brand', '');
  s = (await sel(page))!;
  expect(s.lib).toBeNull();
  expect(s.L).toBeCloseTo(12, 0);
  await expect(page.locator('#imp-generic')).toBeVisible();
  await page.keyboard.press('Control+z');
  expect((await sel(page))!.lib).toBe('Straumann / BLX SLActive / 4.5 × 12 mm');

  // saved with the project
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#btn-save-project')]);
  const file = test.info().outputPath('lib.qdp.zip');
  await dl.saveAs(file);
  await page.goto('./');
  await page.setInputFiles('#project-input', file);
  await page.waitForFunction(() => window.app.implants.length === 2, null, { timeout: 60_000 });
  const libs = await page.evaluate(() => window.app.implants.map((i: { lib?: { id: string } | null }) => i.lib?.id ?? null));
  expect(libs).toEqual(['Straumann / BLX SLActive / 4.5 × 12 mm', 'Straumann / BLX SLActive / 4.5 × 12 mm']);
});

test('dragging a library implant steps through its sizes (BLX 4 × 10 → 4 × 12 → 4 × 8, Ø → 4.5)', async ({ page }) => {
  test.setTimeout(180_000);
  await curveAndImplant(page);
  await expect(page.locator('#imp-brand option')).not.toHaveCount(1, { timeout: 15_000 });
  await page.selectOption('#imp-brand', 'Straumann');
  await page.selectOption('#imp-system', 'BLX SLActive');
  await page.selectOption('#imp-size', '4 × 10 mm');
  const size = () => page.evaluate(() => window.app.selectedImplant().lib.id.split(' / ')[2]);
  /** a point of the selected implant in the panoramic: h along the axis from the centre, r across it */
  const at = (h: number, r: number) =>
    page.evaluate(([h, r]) => {
      const a = window.app;
      const i = a.selectedImplant();
      const c = i.center.map((v: number, k: number) => v + i.axis[k] * h);
      const p = a.pano.project(c);
      const q = a.pano.project(c.map((v: number, k: number) => v + a.frame[0][k] * 0.001));
      const bx = a.pano.el.getBoundingClientRect();
      // across the axis on screen: the patient-left direction projected (the implant is vertical)
      const sx = Math.sign(q.x - p.x) || 1;
      return [bx.x + p.x + (sx * r) / a.pano.vs.scale, bx.y + p.y, a.pano.vs.scale] as [number, number, number];
    }, [h, r]);
  const len = await page.evaluate(() => window.app.selectedImplant().length);
  // apex: 2.5 mm further
  let [x, y, sc] = await at(len / 2, 0);
  await page.mouse.move(x, y);
  await page.mouse.down();
  const dir = (await page.evaluate(() => window.app.selectedImplant().axis[2])) < 0 ? 1 : -1; // screen y of "apical"
  await page.mouse.move(x, y + (dir * 2.5) / sc, { steps: 8 });
  await expect(page.locator('.dim-badge').first()).toContainText('BLX SLActive 4 × 12 mm');
  await page.mouse.up();
  expect(await size()).toBe('4 × 12 mm');
  // and back up (drags move sizes at half speed for control: 7 mm = 3.5 mm shorter)
  const len2 = await page.evaluate(() => window.app.selectedImplant().length);
  [x, y, sc] = await at(len2 / 2, 0);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - (dir * 7) / sc, { steps: 12 });
  await page.mouse.up();
  expect(await size()).toBe('4 × 8 mm');
  // the side: wider, the length stays
  const d = await page.evaluate(() => window.app.selectedImplant().diameter);
  [x, y, sc] = await at(-1, d / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 0.4 / sc, y, { steps: 6 });
  await page.mouse.up();
  expect(await size()).toMatch(/^4\.5 × 8 mm$/);
});
