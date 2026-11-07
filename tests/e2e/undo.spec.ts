// One undo / redo history across implants, curves, rulers, nerves, segments and scans.
import { type Page } from '@playwright/test';
import { archStl, clickView, expect, openDemo, test } from './fixtures';

const undo = async (page: Page) => {
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
};
const redo = async (page: Page) => {
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(200);
};
const state = (page: Page) =>
  page.evaluate(() => {
    const a = window.app;
    return {
      implants: a.implants.length,
      curves: a.curves.length,
      rulers: a.measurements.length,
      nervePts: a.nerves[0]?.pts.length ?? 0,
      segments: a.seg.segments.length,
      seeds: a.seg.segments[0]?.seeds.length ?? 0,
      voxels: a.seg.segments[0]?.voxels ?? 0,
      segOpacity: a.seg.segments[0]?.opacity ?? 1,
      scans: a.scans.length,
      scanOpacity: a.scans[0]?.opacity ?? 1,
    };
  });

test('every kind of change is undone and redone, one step each', async ({ page }) => {
  test.setTimeout(180_000);
  await openDemo(page);
  await page.keyboard.press('2');

  // panoramic curve: clicked point by point, Enter
  await page.click('[data-panel="curve"]');
  await page.click('#btn-draw-curve');
  for (const [x, y] of [[0.25, 0.6], [0.35, 0.4], [0.5, 0.33], [0.65, 0.4], [0.75, 0.6]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(100);
  }
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).curves).toBe(1);

  // implant placed and deleted straight away: two steps
  await page.click('[data-panel="implants"]');
  await page.click('#btn-add-lower');
  await clickView(page, 'planAxial', 0.32, 0.5);
  await page.mouse.move(5, 5);
  await page.keyboard.press('Delete');
  expect((await state(page)).implants).toBe(0);
  await undo(page);
  expect((await state(page)).implants).toBe(1);
  await expect(page.locator('#status-msg')).toContainText('Undo: implants');
  // a typed value is one step
  await page.click('#implant-list li');
  await page.fill('#imp-d', '5');
  await page.dispatchEvent('#imp-d', 'input');
  await page.waitForTimeout(600);
  await undo(page);
  expect(await page.evaluate(() => window.app.implants[0].diameter)).not.toBe(5);
  await redo(page);
  expect(await page.evaluate(() => window.app.implants[0].diameter)).toBe(5);

  // ruler
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press('r');
  await clickView(page, 'planAxial', 0.6, 0.2);
  await clickView(page, 'planAxial', 0.66, 0.25);
  await page.keyboard.press('r');
  expect((await state(page)).rulers).toBe(1);
  await undo(page);
  expect((await state(page)).rulers).toBe(0);

  // nerve: each point is a step
  await page.click('[data-panel="nerves"]');
  await page.click('#btn-nerve-right');
  await clickView(page, 'crossViews.1', 0.5, 0.65);
  await clickView(page, 'crossViews.1', 0.5, 0.7);
  await clickView(page, 'pano', 0.3, 0.7);
  const pts = (await state(page)).nervePts;
  expect(pts).toBe(3);
  await undo(page);
  expect((await state(page)).nervePts).toBe(pts - 1);
  await page.keyboard.press('Escape');

  // segment: new, opacity, click to grow (rebuilds on undo)
  await page.click('[data-panel="segments"]');
  await page.click('#seg-manual summary');
  await page.click('[data-seg-preset="1"]');
  await page.waitForTimeout(500);
  await page.$eval('#seg-opacity', (e: HTMLInputElement) => ((e.value = '0.3'), e.dispatchEvent(new Event('input'))));
  await page.waitForTimeout(600);
  if ((await page.evaluate(() => window.app.segTool)) !== 'grow') await page.click('#btn-seg-grow');
  await page.evaluate(() => (window.app.view3d.setPreset('front'), window.app.changed()));
  await page.waitForTimeout(800);
  await clickView(page, 'view3d', 0.5, 0.62);
  await expect.poll(async () => (await state(page)).voxels, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await undo(page);
  await expect.poll(async () => { const s = await state(page); return [s.seeds, s.voxels]; }).toEqual([0, 0]);
  await undo(page);
  expect((await state(page)).segOpacity).not.toBe(0.3);
  await undo(page);
  expect((await state(page)).segments).toBe(0);
  await redo(page);
  await redo(page);
  await redo(page);
  await expect.poll(async () => { const s = await state(page); return [s.segments, s.segOpacity, s.voxels > 0]; }).toEqual([1, 0.3, true]);

  // undoing an implant change leaves the segmentation alone (no rebuild)
  await page.click('[data-panel="implants"]');
  await page.click('#implant-list li');
  await page.fill('#imp-l', '12');
  await page.dispatchEvent('#imp-l', 'input');
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const a = window.app;
    const busy = a.onBusy;
    a.onBusy = (t: string | null) => ((window as unknown as { rebuilt?: boolean }).rebuilt ||= !!t, busy(t));
  });
  await undo(page);
  expect(await page.evaluate(() => (window as unknown as { rebuilt?: boolean }).rebuilt ?? false)).toBe(false);
  expect(await page.evaluate(() => window.app.implants[0].length)).not.toBe(12);

  // scan: opacity, delete; undo brings it back with its mesh
  await page.click('[data-panel="scans"]');
  await page.setInputFiles('#scan-input', archStl());
  await expect(page.locator('.scan-place')).toBeVisible({ timeout: 30_000 });
  await page.click('.scan-place .modal-close');
  await page.$eval('#scan-opacity', (e: HTMLInputElement) => ((e.value = '0.4'), e.dispatchEvent(new Event('input'))));
  await page.waitForTimeout(600);
  await page.click('#btn-scan-delete');
  expect((await state(page)).scans).toBe(0);
  await undo(page);
  expect(await state(page)).toMatchObject({ scans: 1, scanOpacity: 0.4 });
  expect(await page.evaluate(() => window.app.scans[0].mesh.idx.length)).toBeGreaterThan(0);
  await undo(page);
  expect((await state(page)).scanOpacity).not.toBe(0.4);

  // the ↶ button all the way back: an empty plan, then nothing left to undo
  await expect(page.locator('#btn-undo')).toBeEnabled();
  const n = await page.evaluate(() => window.app.undoCount);
  for (let i = 0; i < n; i++) await page.click('#btn-undo');
  await expect.poll(async () => { const s = await state(page); return [s.implants, s.curves, s.segments, s.nervePts, s.scans]; }).toEqual([0, 0, 0, 0, 0]);
  await expect(page.locator('#btn-undo')).toBeDisabled();
});

test('automatic segmentation is one step', async ({ page }) => {
  await openDemo(page);
  const r = await page.evaluate(async () => {
    const a = window.app;
    const g = a.seg;
    const n = g.nx * g.ny * g.nz;
    const cls = new Uint8Array(n);
    for (let i = 0; i < n; i += 7) cls[i] = 2;
    a.applyAiSegmentation({ cls, margin: new Uint8Array(n).fill(200), counts: [0, 0, Math.ceil(n / 7)] }, 'test');
    const layer = g.ai;
    await new Promise((res) => setTimeout(res, 600));
    a.commitHistory();
    const made = g.segments.length;
    a.undo();
    const gone = g.segments.length === 0 && g.ai === null;
    a.redo();
    return { made, gone, back: g.ai === layer && g.segments.length === made };
  });
  expect(r).toEqual({ made: 1, gone: true, back: true });
});

test('a new scan starts a new history', async ({ page }) => {
  await openDemo(page);
  await page.click('[data-mode="plan"]');
  await page.click('#btn-add-lower');
  await clickView(page, 'planAxial', 0.3, 0.75);
  await expect.poll(() => page.evaluate(() => window.app.undoCount)).toBeGreaterThan(0);
  await page.click('#btn-open-menu');
  await page.click('#btn-demo');
  await expect.poll(() => page.evaluate(() => [window.app.undoCount, window.app.redoCount])).toEqual([0, 0]);
});
