// Implants in the panoramic: in a slice only what the curved surface cuts of them (nothing when
// the slice passes beside the implant); in a slab the whole implant as a shaded 3D model.
import { type Page } from '@playwright/test';
import { clickView, expect, openDemo, test } from './fixtures';

/** Implant-green pixels in the panoramic around the implant, and how much their brightness varies. */
const greens = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const a = window.app;
    const pv = a.pano;
    const c = pv.capture() as HTMLCanvasElement;
    const k = c.width / pv.w;
    const p = pv.project(a.implants[0].center);
    const R = Math.round(10 / pv.vs.scale);
    const d = c.getContext('2d')!.getImageData(Math.round((p.x - R) * k), Math.round((p.y - R) * k), Math.round(2 * R * k), Math.round(2 * R * k)).data;
    const lum: number[] = [];
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 40 && d[i + 1] > d[i + 2] + 15) lum.push(d[i + 1]);
    const mean = lum.reduce((s, v) => s + v, 0) / Math.max(1, lum.length);
    const sd = Math.sqrt(lum.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, lum.length));
    return { n: lum.length, sd };
  });

test('panoramic: the cut of the implant in a slice, the whole implant in 3D in a slab', async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) await clickView(page, 'planAxial', x, y);
  await page.keyboard.press('Enter');
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', 0.4, 0.55);
  await expect.poll(() => page.evaluate(() => window.app.implants.length)).toBe(1);
  // a closer look at it, not selected (green)
  await page.evaluate(() => {
    const a = window.app;
    const pv = a.pano;
    const pr = pv.project(a.implants[0].center);
    pv.vs.scale = 0.05;
    pv.vs.panU = pr.s - a.curve!.length / 2;
    pv.vs.panV = -pv.cAt(pr.y);
    a.selectImplant(null, false);
  });

  // slab: the implant whole, shaded (its brightness varies across the body)
  await page.evaluate(() => window.app.setPanoMode('slab'));
  const slab = await greens(page);
  expect(slab.n).toBeGreaterThan(500);
  expect(slab.sd).toBeGreaterThan(12);
  // also when the slab is moved off the implant (it is drawn whole, in front)
  await page.evaluate(() => ((window.app.panoOffset = 8), window.app.changed()));
  expect((await greens(page)).n).toBeGreaterThan(500);

  // slice through the implant: its section, flat (one fill colour and the outline)
  await page.evaluate(() => ((window.app.panoOffset = 0), window.app.setPanoMode('slice')));
  const cut = await greens(page);
  expect(cut.n).toBeGreaterThan(300);
  // a slice beside the implant cuts nothing (only its green label is left)
  await page.evaluate(() => ((window.app.panoOffset = 8), window.app.changed()));
  expect((await greens(page)).n).toBeLessThan(cut.n * 0.25);
});
