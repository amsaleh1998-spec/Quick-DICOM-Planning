// Rulers are deleted with a right click, or selected with a click and deleted with Backspace /
// Delete (also once the mouse has moved on). A right-drag that starts on a ruler still zooms.
import { type Page } from '@playwright/test';
import { clickView, expect, inView, openDemo, test } from './fixtures';

const count = (page: Page) => page.evaluate(() => window.app.measurements.length);

async function ruler(page: Page) {
  await page.keyboard.press('r');
  await clickView(page, 'mprViews.0', 0.3, 0.45);
  await clickView(page, 'mprViews.0', 0.7, 0.45);
  await expect.poll(() => page.evaluate(() => window.app.ruler)).toBe(false); // the tool switches off after the second click
}

test('a ruler is deleted by a right click, or by a click and Backspace / Delete', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // right click on the ruler: deleted
  await ruler(page);
  expect(await count(page)).toBe(1);
  const [mx, my] = await inView(page, 'mprViews.0', 0.5, 0.45);
  await page.mouse.click(mx, my, { button: 'right' });
  expect(await count(page)).toBe(0);

  // a right-drag that starts on a ruler zooms and keeps it
  await ruler(page);
  const scale = await page.evaluate(() => window.app.mprViews[0].vs.scale);
  await page.mouse.move(mx, my);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(mx, my + 40, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  expect(await count(page)).toBe(1);
  expect(await page.evaluate(() => window.app.mprViews[0].vs.scale)).not.toBe(scale);
  await page.evaluate(() => (window.app.mprViews[0].vs.fitted = false));
  await page.waitForTimeout(300);

  // a click selects it (without moving the crosshair); Backspace deletes it, the mouse elsewhere
  const id = await page.evaluate(() => window.app.measurements[0].id);
  const X = await page.evaluate(() => [...window.app.X]);
  const [cx, cy] = await inView(page, 'mprViews.0', 0.5, 0.45);
  await page.mouse.click(cx, cy);
  expect(await page.evaluate(() => window.app.selectedMeasurementId)).toBe(id);
  expect(await page.evaluate(() => [...window.app.X])).toEqual(X);
  const [ox, oy] = await inView(page, 'mprViews.1', 0.5, 0.5);
  await page.mouse.move(ox, oy);
  await page.keyboard.press('Backspace');
  expect(await count(page)).toBe(0);

  // Delete works the same; a click elsewhere or Esc lets the ruler go (then Delete leaves it)
  await ruler(page);
  await page.mouse.click(cx, cy);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.app.selectedMeasurementId)).toBeNull();
  await page.mouse.move(ox, oy);
  await page.keyboard.press('Delete');
  expect(await count(page)).toBe(1);
  await page.mouse.click(cx, cy);
  await page.mouse.move(ox, oy);
  await page.keyboard.press('Delete');
  expect(await count(page)).toBe(0);
  // and undo brings it back
  await page.keyboard.press('Control+z');
  expect(await count(page)).toBe(1);
});
