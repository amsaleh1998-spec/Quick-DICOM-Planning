// While a panoramic curve is drawn the axial view is bigger (not full screen); it goes back to its
// tile when the curve is done, and grows again for an additional curve. The picture keeps its
// field of view across the change, so the scale and the drawn points stay right.
import { type Page } from '@playwright/test';
import { clickView, expect, openDemo, test } from './fixtures';

const axial = (page: Page) =>
  page.evaluate(() => {
    const v = window.app.planAxial;
    const L = (v.el.parentElement as HTMLElement).getBoundingClientRect();
    return { w: v.w, h: v.h, layoutW: L.width, layoutH: L.height, mmAcross: v.vs.scale * Math.min(v.w, v.h) };
  });
const settled = (page: Page) => page.waitForFunction(() => !document.querySelector('#layout-plan')!.getAnimations({ subtree: true }).some((a) => a.playState === 'running'));

async function drawArch(page: Page) {
  for (const [x, y] of [[0.3, 0.68], [0.34, 0.45], [0.42, 0.33], [0.5, 0.3], [0.58, 0.33], [0.66, 0.45], [0.7, 0.68]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(40);
  }
}

test('the axial view is bigger while a curve is drawn, and for an added curve', async ({ page }) => {
  await openDemo(page);
  const before = await axial(page); // in ① the plan layout is hidden: measure it in ② after the curve
  expect(before.w).toBe(0);

  // ② Plan with no curve: drawing starts, the axial view takes the larger part of the window
  await page.keyboard.press('2');
  await expect(page.locator('#layout-plan')).toHaveClass(/drawing-curve/);
  await settled(page);
  const big = await axial(page);
  expect(big.w).toBeGreaterThan(big.layoutW * 0.45);
  expect(big.h).toBeGreaterThan(big.layoutH * 0.9);
  expect(big.w).toBeLessThan(big.layoutW * 0.8); // not full screen: the other views are still there
  for (const v of ['pano', 'tang', 'view3d'] as const) expect(await page.evaluate((v) => window.app[v].el.offsetWidth, v)).toBeGreaterThan(80);

  await drawArch(page);
  const drawn = await page.evaluate(() => window.app.drawing!.map((p: number[]) => [...p]));
  await page.keyboard.press('Enter');
  await expect(page.locator('#layout-plan')).not.toHaveClass(/drawing-curve/);
  await settled(page);
  const small = await axial(page);
  expect(small.w * small.h).toBeLessThan(big.w * big.h * 0.5);
  // same field of view (mm across the shorter side) at both sizes: the scale stays right
  expect(Math.abs(small.mmAcross - big.mmAcross)).toBeLessThan(0.01);
  // the curve is where it was drawn
  const ctrl = await page.evaluate(() => window.app.curve!.ctrl.map((p: number[]) => [...p]));
  expect(ctrl).toEqual(drawn);

  // an additional curve: bigger again, and back when it is done
  await page.click('[data-panel="curve"]');
  await page.click('#btn-add-curve');
  await expect(page.locator('#layout-plan')).toHaveClass(/drawing-curve/);
  await settled(page);
  expect((await axial(page)).w).toBe(big.w);
  await drawArch(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#layout-plan')).not.toHaveClass(/drawing-curve/);
  expect(await page.evaluate(() => window.app.curves.length)).toBe(2);

  // Esc while drawing: back too
  await page.evaluate(() => window.app.startDrawing(true));
  await expect(page.locator('#layout-plan')).toHaveClass(/drawing-curve/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#layout-plan')).not.toHaveClass(/drawing-curve/);
});
