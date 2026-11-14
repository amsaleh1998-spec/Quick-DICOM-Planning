// After segmenting, the 3D view shows only the segments, the segments in the whole scan (the rest
// of the scan as before, with the threshold working on it), or the whole scan as before
// segmenting. In the slices each segment is shown or not on its own; by default only nerve canals.
import { type Page } from '@playwright/test';
import { clickView, expect, openDemo, test } from './fixtures';

/** Share of the 3D view covered by rendered surface, and by the mandible segment's blue. */
const covered = (page: Page, view = 'view3d') =>
  page.evaluate(async (view) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = (window.app as unknown as Record<string, { capture(): HTMLCanvasElement }>)[view].capture();
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    let blue = 0;
    for (let i = 0; i < d.length; i += 16) {
      if (Math.max(d[i], d[i + 1], d[i + 2]) > 70) n++; // (the background is darker)
      if (d[i + 2] > d[i] + 30 && d[i + 2] > 60) blue++; // (also the light tint in the slices)
    }
    return { all: n / (d.length / 16), blue: blue / (d.length / 16) };
  }, view);
const mode = (page: Page) => page.evaluate(() => window.app.seg3dMode);

test('3D: segments, segments + scan, or the whole scan; segments shown in the slices one by one', async ({ page }) => {
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
  await page.evaluate(() => {
    window.app.seg.segments[0].color = [60, 120, 255]; // an unmistakable blue
    window.app.changed();
  });
  // while clicking it, the segment shows in the slices
  expect(await page.evaluate(() => window.app.segmentInSlices(window.app.seg.segments[0]))).toBe(true);
  await page.keyboard.press('Escape');

  // ---- 3D ---- (the demo is one connected piece of bone, so the segment is all of it)
  await expect(page.locator('#seg-3d-mode')).toBeVisible();
  await expect(page.locator('#seg-3d-mode button')).toHaveText(['Segments', 'Segments + scan', 'Whole scan']);
  const eye3d = page.locator('#seg-list li').first().locator('[data-act="3d"]');
  await page.click('#seg-3d-mode [data-m="segments"]');
  const segsOnly = await covered(page);
  expect(segsOnly.blue).toBeGreaterThan(0.01);
  // hidden there, nothing is left
  await eye3d.click();
  await expect(eye3d).toHaveAttribute('aria-pressed', 'false');
  expect((await covered(page)).all).toBeLessThan(segsOnly.all * 0.1); // (the axes in the corner remain)
  await eye3d.click();

  // segments + scan: the segment in its colour, in the whole rendering
  await page.click('#seg-3d-mode [data-m="both"]');
  expect(await mode(page)).toBe('both');
  const both = await covered(page);
  expect(both.blue).toBeGreaterThan(segsOnly.blue * 0.8);
  expect(both.all).toBeGreaterThan(segsOnly.all * 0.9);
  // a segment hidden in 3D is part of the scan there: nothing goes missing, it is just not coloured
  await eye3d.click();
  const bothHidden = await covered(page);
  expect(bothHidden.blue).toBeLessThan(both.blue * 0.2);
  expect(bothHidden.all).toBeGreaterThan(both.all * 0.8);
  await eye3d.click();

  // the whole scan, as before segmenting: no segment colour
  await page.click('#seg-3d-mode [data-m="scan"]');
  expect(await page.evaluate(() => window.app.show3dSegments)).toBe(false);
  const whole = await covered(page);
  expect(whole.blue).toBeLessThan(both.blue * 0.2);
  expect(Math.abs(whole.all - bothHidden.all)).toBeLessThan(0.02); // the same scan
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
  expect((await covered(page)).all).toBeLessThan(whole.all * 0.9);
  await page.evaluate((lo) => {
    window.app.vr.lo = lo;
    window.app.changed();
  }, lo);

  // back to the segments (from the 3D menu)
  await page.click('#btn-vr-menu');
  await page.click('#vr-3d-mode [data-m="segments"]');
  expect(await mode(page)).toBe('segments');
  await page.keyboard.press('Escape');
  expect(Math.abs((await covered(page)).all - segsOnly.all)).toBeLessThan(0.02);

  // ---- slices: the mandible is not tinted by default; "Slices" shows it, and only it ----
  const slicesBtn = page.locator('#seg-list li').first().locator('[data-act="slices"]');
  await expect(slicesBtn).toHaveAttribute('aria-pressed', 'false');
  const plain = await covered(page, 'planAxial');
  expect(plain.blue).toBeLessThan(0.002);
  await slicesBtn.click();
  await expect(slicesBtn).toHaveAttribute('aria-pressed', 'true');
  expect((await covered(page, 'planAxial')).blue).toBeGreaterThan(0.01);
  // a second segment stays out of the slices until it is switched on
  await page.click('[data-seg-preset="4"]');
  await page.keyboard.press('Escape');
  const second = page.locator('#seg-list li').nth(1).locator('[data-act="slices"]');
  await expect(second).toHaveAttribute('aria-pressed', 'false');
  // the switch for all of them still hides every one
  await page.locator('#seg-show-2d').uncheck();
  expect((await covered(page, 'planAxial')).blue).toBeLessThan(0.002);
  await page.locator('#seg-show-2d').check();
  await slicesBtn.click();
  expect((await covered(page, 'planAxial')).blue).toBeLessThan(0.002);
});
