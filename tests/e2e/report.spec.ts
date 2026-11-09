// Planning report: a PDF with an overview, the implant list and one page per implant.
import { clickView, expect, openDemo, test } from './fixtures';
import { readFileSync } from 'node:fs';

test('planning report: PDF with one page per implant', async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => ((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined));
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('Enter');
  for (const fx of [0.38, 0.62]) {
    await page.click('#btn-add-lower');
    await clickView(page, 'pano', fx, 0.55);
  }
  expect(await page.evaluate(() => window.app.implants.length)).toBe(2);
  const before = await page.evaluate(() => ({ sel: window.app.selectedId, mode: window.app.mode }));

  await page.click('#btn-export-menu');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 180_000 }), page.click('#btn-export-report')]);
  expect(dl.suggestedFilename()).toMatch(/_planning_report_\d{4}-\d\d-\d\d\.pdf$/);
  const pdf = readFileSync((await dl.path())!).toString('latin1');
  expect(pdf.startsWith('%PDF-')).toBe(true);
  // overview + implant list + 2 implant pages
  expect(pdf.match(/\/Type \/Page\b(?!s)/g)?.length).toBe(4);
  expect(pdf.match(/\/Subtype \/Image/g)!.length).toBeGreaterThanOrEqual(1 + 2 * 7);
  await expect(page.locator('#status-msg')).toContainText('Planning report saved (2 implants)');
  // the app is as it was
  expect(await page.evaluate(() => ({ sel: window.app.selectedId, mode: window.app.mode }))).toEqual(before);
  expect(await page.locator('.view.max').count()).toBe(0);
});
