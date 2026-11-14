// A saved project opens as it was left: no curve drawing when it has a curve (the axial view
// keeps its tile), the panel that was open, and the implant that was selected.
import { type Page } from '@playwright/test';
import { clickView, dicomFiles, expect, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  // the native save dialog cannot be driven: projects are saved as downloads
  await page.addInitScript(() => ((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined));
});

async function saveAndReopen(page: Page, name: string) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#btn-save-project')]);
  const file = test.info().outputPath(name);
  await dl.saveAs(file);
  // another panel in between (the browser remembers the last one; the project must win)
  await page.click('[data-panel="segments"]');
  await page.goto('./');
  await page.setInputFiles('#project-input', file);
  await page.waitForFunction(() => !!window.app.vol, null, { timeout: 60_000 });
}

test('a project opens with its panel and selected implant, and without drawing a curve', async ({ page }) => {
  await page.goto('./');
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.25, 0.6], [0.4, 0.35], [0.6, 0.35], [0.75, 0.6]]) await clickView(page, 'planAxial', x, y);
  await page.keyboard.press('Enter');
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', 0.45, 0.55);
  await expect.poll(() => page.evaluate(() => window.app.implants.length)).toBe(1);
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', 0.6, 0.55);
  await expect.poll(() => page.evaluate(() => window.app.implants.length)).toBe(2);
  // the first one selected, in the Implants panel
  const first = await page.evaluate(() => window.app.implants[0].id as number);
  await page.locator('#implant-list li').first().click();
  expect(await page.evaluate(() => window.app.selectedId)).toBe(first);
  await expect(page.locator('#panel-plan')).toBeVisible();

  await saveAndReopen(page, 'implants.qdp.zip');
  expect(await page.evaluate(() => window.app.mode)).toBe('plan');
  // the curve is there: no drawing, the axial view in its tile
  expect(await page.evaluate(() => window.app.drawing)).toBeNull();
  await expect(page.locator('#layout-plan')).not.toHaveClass(/drawing-curve/);
  // the Implants panel, with the same implant selected
  await expect(page.locator('#panel-plan')).toBeVisible();
  expect(await page.evaluate(() => window.app.selectedId)).toBe(first);
  await expect(page.locator('#implant-list li.sel')).toHaveCount(1);

  // another panel saved: that one comes back
  await page.click('[data-panel="nerves"]');
  await saveAndReopen(page, 'nerves.qdp.zip');
  await expect(page.locator('#panel-nerves')).toBeVisible();
  await expect(page.locator('#layout-plan')).not.toHaveClass(/drawing-curve/);
});
