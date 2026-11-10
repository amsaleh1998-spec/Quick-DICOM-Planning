// Implants are named after the tooth they replace: guessed from where they sit on the arch, and
// chosen on the tooth chart of the implant's jaw (teeth of other implants cannot be taken twice).
import { type Page } from '@playwright/test';
import { clickView, expect, openDemo, test } from './fixtures';

const sel = (page: Page) => page.evaluate(() => window.app.selectedImplant().name as string);

test('implants are named after their tooth, chosen on the tooth chart', async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('Enter');

  // a lower implant on the patient's right side of the arch, one on the left, an upper one
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', 0.2, 0.6);
  const a = await sel(page);
  expect(a).toMatch(/^4[1-8]$/); // right side of the mandible: quadrant 4
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', 0.8, 0.6);
  expect(await sel(page)).toMatch(/^3[1-8]$/);
  await page.click('#btn-add-upper');
  await clickView(page, 'pano', 0.3, 0.35);
  expect(await sel(page)).toMatch(/^1[1-8]$/);

  // the chart shows the implant's jaw: its tooth marked
  await expect(page.locator('#imp-jaw')).toHaveText('Maxilla');
  await expect(page.locator('#imp-teeth .tooth')).toHaveCount(16);
  await expect(page.locator(`#imp-teeth .tooth.cur`)).toHaveAttribute('data-tooth', await sel(page));

  // back to the first lower implant: choose another tooth, a taken one is refused
  const first = await page.evaluate(() => window.app.implants[0].id as number);
  await page.evaluate((id) => window.app.selectImplant(id, true), first);
  await expect(page.locator('#imp-jaw')).toHaveText('Mandible');
  const other = await page.evaluate(() => window.app.implants[1].name as string);
  await expect(page.locator(`#imp-teeth [data-tooth="${other}"]`)).toHaveClass(/taken/);
  await page.locator(`#imp-teeth [data-tooth="${other}"]`).click({ force: true });
  expect(await sel(page)).toBe(a);
  const free = a === '46' ? '45' : '46';
  await page.click(`#imp-teeth [data-tooth="${free}"]`);
  expect(await sel(page)).toBe(free);
  await expect(page.locator('#imp-name')).toHaveValue(free);
  await expect(page.locator('#implant-list li.sel')).toContainText(free);
  // undo brings the old name back
  await page.keyboard.press('Control+z');
  expect(await sel(page)).toBe(a);
});
