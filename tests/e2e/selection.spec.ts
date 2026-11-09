// A click outside every implant deselects the selected one; a click on an implant selects it, and
// drags (orbiting the 3D view) or clicks with a tool in use keep the selection.
import { type Page } from '@playwright/test';
import { clickView, expect, inView, openDemo, test } from './fixtures';

const selected = (page: Page) => page.evaluate(() => window.app.selectedId as number | null);
/** Screen point of the selected implant's centre in a view. */
async function onImplant(page: Page, view: string): Promise<[number, number]> {
  return page.evaluate((view) => {
    const a = window.app;
    const v = view.split('.').reduce((o: any, k: string) => o[k], a);
    const s = v.screenPoint(a.selectedImplant().center);
    const b = v.el.getBoundingClientRect();
    return [b.x + s[0], b.y + s[1]] as [number, number];
  }, view);
}

test('a click outside every implant deselects it', async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('Enter');
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', 0.4, 0.55);
  const id = await selected(page);
  expect(id).not.toBeNull();

  // a click on the implant keeps it selected
  const [ix, iy] = await onImplant(page, 'crossViews.1');
  await page.mouse.click(ix, iy);
  expect(await selected(page)).toBe(id);

  // orbiting the 3D view (a drag) keeps it
  const [x0, y0] = await inView(page, 'view3d', 0.2, 0.2);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 60, y0 + 20, { steps: 5 });
  await page.mouse.up();
  expect(await selected(page)).toBe(id);

  // a click with the ruler keeps it
  await page.keyboard.press('r');
  await clickView(page, 'crossViews.1', 0.1, 0.1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('r');
  expect(await selected(page)).toBe(id);
  await page.evaluate(() => { window.app.ruler = false; window.app.pendingMeasurement = null; });

  // a click on nothing (here: the corner of a cross-section) deselects
  await clickView(page, 'crossViews.1', 0.08, 0.92);
  expect(await selected(page)).toBeNull();

  // a click on the implant in the panoramic selects it again; a click beside it in 3D deselects
  const [px, py] = await (async () => {
    await page.evaluate((id) => window.app.selectImplant(id, true), id);
    const p = await onImplant(page, 'pano');
    await page.evaluate(() => window.app.selectImplant(null, false));
    return p;
  })();
  await page.mouse.click(px, py);
  expect(await selected(page)).toBe(id);
  await clickView(page, 'view3d', 0.08, 0.5);
  expect(await selected(page)).toBeNull();
});
