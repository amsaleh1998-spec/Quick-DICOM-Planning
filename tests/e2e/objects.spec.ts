// Objects list (right), thresholds in the Segments panel and the 3D view, manual segments opaque.
import { expect, openDemo, test } from './fixtures';

test('lower threshold in the Segments panel and along the 3D view, in step; manual segments opaque', async ({ page }) => {
  await openDemo(page);
  await page.click('[data-panel="segments"]');
  // the manual section is open without a click
  await expect(page.locator('#seg-manual')).toBeVisible();
  await expect(page.locator('#seg-thr')).toBeVisible();
  await page.fill('#seg-thr-num', '900');
  await page.dispatchEvent('#seg-thr-num', 'change');
  expect(await page.evaluate(() => window.app.vr.lo)).toBe(900);
  await expect(page.locator('#v3d-thr-num')).toHaveValue('900');
  await expect(page.locator('#btn-vr-menu')).toContainText('900+');
  // the bar along the bottom of the 3D view
  await expect(page.locator('#v3d-thr')).toBeVisible();
  await page.$eval('#v3d-thr-range', (e: HTMLInputElement) => ((e.value = '650'), e.dispatchEvent(new Event('input'))));
  // (the slider snaps to its step)
  const lo = await page.evaluate(() => window.app.vr.lo);
  expect(Math.abs(lo - 650)).toBeLessThan(10);
  await expect(page.locator('#seg-thr-num')).toHaveValue(String(lo));
  // MIP has no threshold: the bar goes
  await page.evaluate(() => ((window.app.vr.mode = 'mip'), window.app.changed()));
  await expect(page.locator('#v3d-thr')).toBeHidden();
  await page.evaluate(() => ((window.app.vr.mode = 'surface'), window.app.changed()));
  // manual presets are opaque
  await page.click('[data-seg-preset="1"]');
  expect(await page.evaluate(() => window.app.seg.segments[0].opacity ?? 1)).toBe(1);
});

test('objects list: every surface with an eye, group eyes, collapse, resize', async ({ page }) => {
  await openDemo(page);
  const list = page.locator('#objects');
  await expect(list).toBeVisible();
  await expect(list).toContainText('Bone surface (3D)');
  // bone off and on again
  await page.click('#obj-groups [data-k="bone"]');
  expect(await page.evaluate(() => window.app.showUnsegmented)).toBe(false);
  await page.click('#obj-groups [data-k="bone"]');
  expect(await page.evaluate(() => window.app.showUnsegmented)).toBe(true);
  // a segment and an implant appear in the list
  await page.click('[data-panel="segments"]');
  await page.click('[data-seg-preset="2"]');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const a = window.app;
    a.placing = 'lower';
    a.placeImplantAt(a.vol.center);
  });
  await expect(list).toContainText('Tooth');
  await expect(list).toContainText('Implant 1');
  await expect(list).toContainText('Bone outside segments');
  await page.click('#obj-groups [data-k="seg1"]');
  expect(await page.evaluate(() => window.app.seg.segments[0].visible)).toBe(false);
  await page.click('#obj-groups [data-g="implants"]');
  expect(await page.evaluate(() => window.app.implants[0].hidden)).toBe(true);
  await page.click('#obj-groups [data-g="implants"]');
  expect(await page.evaluate(() => window.app.implants[0].hidden)).toBe(false);
  // prosthetic axes on their own eye
  await page.click('#obj-groups [data-k="axes"]');
  expect(await page.evaluate(() => window.app.implants[0].showProstheticAxis)).toBe(true);
  // resize by dragging the left edge, collapse, and both are remembered
  const box = (await page.locator('#objects').boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 79, box.y + 200, { steps: 4 });
  await page.mouse.up();
  const wide = (await page.locator('#objects').boundingBox())!.width;
  expect(wide).toBeGreaterThan(box.width + 60);
  await page.click('#obj-toggle');
  expect((await page.locator('#objects').boundingBox())!.width).toBeLessThan(40);
  await page.reload();
  expect((await page.locator('#objects').boundingBox())!.width).toBeLessThan(40);
  await page.click('#obj-toggle');
  expect(Math.round((await page.locator('#objects').boundingBox())!.width)).toBe(Math.round(wide));
});
