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
