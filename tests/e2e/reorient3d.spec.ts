// ① Reorient in the 3D view: the crop box and the frame's axes are shown with the Crop / Rotate tool,
// a face handle crops (and the 3D rendering follows at once), a ring turns the frame.
import { expect, openDemo, test } from './fixtures';
import type { Page } from '@playwright/test';

type V3 = [number, number, number];

/** Page position of a world point in the 3D view. */
async function screenOf(page: Page, w: V3): Promise<[number, number]> {
  return page.evaluate((w) => {
    const v = window.app.view3d as unknown as { el: HTMLElement; projectPoint(w: number[]): [number, number] };
    const r = v.el.getBoundingClientRect();
    const s = v.projectPoint(w);
    return [r.left + s[0], r.top + s[1]];
  }, w);
}
const gizmo = (page: Page) =>
  page.evaluate(() => {
    const g = (window.app.view3d as unknown as { reorient: { face(a: number, s: string): { c: V3 }; ring(o: number, n?: number): V3[] } }).reorient;
    return { top: g.face(2, 'max').c, ring: g.ring(1, 16) };
  });

test.beforeEach(async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('1'); // ① Reorient
  await expect.poll(() => page.evaluate(() => window.app.mode)).toBe('mpr');
});

test('Crop: dragging the top face in 3D crops the box, and the 3D rendering at once', async ({ page }) => {
  await page.click('#mpr-tools [data-tool="crop"]');
  const before = await page.evaluate(() => window.app.crop.max[2]);
  const { top } = await gizmo(page);
  const [x, y] = await screenOf(page, top);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 60, { steps: 8 });
  // while dragging: the box is smaller and the 3D view has re-rendered with it
  const mid = await page.evaluate(() => window.app.crop.max[2]);
  expect(mid).toBeLessThan(before - 5);
  await page.waitForFunction((m) => ((window.app.view3d as unknown as { lastKey: string }).lastKey ?? '').includes(String(m)), mid);
  await page.mouse.up();
  expect(await page.evaluate(() => window.app.cropEdited)).toBe(true);
  // the camera did not turn
  await expect(page.locator('#mpr-status')).toContainText('crop active');
});

test('Rotate: dragging a ring in 3D turns the frame around that axis', async ({ page }) => {
  await page.click('#mpr-tools [data-tool="rotate"]');
  const F0 = await page.evaluate(() => window.app.frame.map((v: number[]) => [...v]));
  const { ring } = await gizmo(page);
  // the coronal (A–P) ring faces the camera: drag along it by an eighth of a turn – starting at
  // the top, where the sagittal ring (edge-on: a line) crosses it, which must not take over
  const a = await screenOf(page, ring[0]);
  const b = await screenOf(page, ring[2]);
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  await page.mouse.move((a[0] + b[0]) / 2 + 4, (a[1] + b[1]) / 2 + 4, { steps: 5 });
  await page.mouse.move(b[0], b[1], { steps: 5 });
  await page.mouse.up();
  const F1 = await page.evaluate(() => window.app.frame.map((v: number[]) => [...v]));
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  expect(dot(F1[1], F0[1])).toBeGreaterThan(0.999); // around A–P: that axis stays
  const turned = (Math.acos(Math.min(1, dot(F1[0], F0[0]))) * 180) / Math.PI;
  expect(turned).toBeGreaterThan(30);
  expect(turned).toBeLessThan(60); // about 45°
  // turning around A–P tilts the axial and sagittal planes, the coronal one stays
  await expect(page.locator('#mpr-status')).toContainText(/axial 4\d\.\d°, coronal 0\.0°, sagittal 4\d\.\d°/);
});

test('Navigate: no gizmo, dragging turns the 3D view', async ({ page }) => {
  await page.click('#mpr-tools [data-tool="navigate"]');
  const crop0 = await page.evaluate(() => JSON.stringify(window.app.crop));
  const cam0 = await page.evaluate(() => JSON.stringify((window.app.view3d as unknown as { getCamera(): unknown }).getCamera()));
  const { top } = await gizmo(page);
  const [x, y] = await screenOf(page, top);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 60, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => JSON.stringify(window.app.crop))).toBe(crop0);
  expect(await page.evaluate(() => JSON.stringify((window.app.view3d as unknown as { getCamera(): unknown }).getCamera()))).not.toBe(cam0);
});
