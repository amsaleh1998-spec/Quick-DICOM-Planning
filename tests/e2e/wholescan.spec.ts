// After segmenting, the 3D view can show the whole scan again (as before segmenting, with the
// threshold working on it) – or the segments, with or without the bone outside them.
import { type Page } from '@playwright/test';
import { clickView, expect, openDemo, test } from './fixtures';

/** Share of the 3D view covered by rendered surface (not background). */
const covered = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = window.app.view3d.capture() as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] > 3 * 110) n++;
    return n / (d.length / 16);
  });

test('3D: segments or the whole scan, and the threshold works on the whole scan', async ({ page }) => {
  test.setTimeout(150_000);
  await openDemo(page);
  await page.keyboard.press('2');
  await page.click('[data-panel="segments"]');
  // no segments yet: nothing to choose
  await expect(page.locator('#seg-3d-mode')).toBeHidden();

  // a segment, grown from a click
  await page.click('[data-seg-preset="1"]');
  if ((await page.evaluate(() => window.app.segTool)) !== 'grow') await page.click('#btn-seg-grow');
  await page.evaluate(() => (window.app.view3d.setPreset('front'), window.app.changed()));
  await page.waitForTimeout(800);
  await clickView(page, 'view3d', 0.5, 0.62);
  await expect.poll(() => page.evaluate(() => window.app.seg.segments[0]?.voxels ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  // segments only (no bone outside them)
  await expect(page.locator('#seg-3d-mode')).toBeVisible();
  await expect(page.locator('#seg-3d-mode button.active')).toHaveText('Segments');
  await page.locator('#seg-show-unseg').uncheck();
  const segsOnly = await covered(page);

  // the whole scan: more is drawn, the bone-outside option is not in the way
  await page.click('#seg-3d-mode [data-m="scan"]');
  expect(await page.evaluate(() => window.app.show3dSegments)).toBe(false);
  await expect(page.locator('#seg-show-unseg-row')).toBeHidden();
  const whole = await covered(page);
  expect(whole).toBeGreaterThan(segsOnly * 1.2);
  // the 3D menu and the Objects list say the same
  await page.click('#btn-vr-menu');
  await expect(page.locator('#vr-3d-mode button.active')).toHaveText('Whole scan');
  await page.keyboard.press('Escape');
  await expect(page.locator('#obj-groups [data-k="scan"]')).toBeVisible();

  // the threshold works on it: higher, less is drawn
  const lo = await page.evaluate(() => window.app.vr.lo as number);
  await page.evaluate((lo) => {
    window.app.vr.lo = lo + 1500;
    window.app.changed();
  }, lo);
  expect(await covered(page)).toBeLessThan(whole * 0.9);
  await page.evaluate((lo) => {
    window.app.vr.lo = lo;
    window.app.changed();
  }, lo);

  // back to the segments (from the 3D menu)
  await page.click('#btn-vr-menu');
  await page.click('#vr-3d-mode [data-m="segments"]');
  expect(await page.evaluate(() => window.app.show3dSegments)).toBe(true);
  await expect(page.locator('#seg-show-unseg-row')).toBeVisible();
  expect(Math.abs((await covered(page)) - segsOnly)).toBeLessThan(0.02);
});
