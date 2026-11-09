// Planning report: a PDF with an overview, the implant list and one page per implant; the
// cross-sections follow the selected implant's axis.
import { type Page } from '@playwright/test';
import { clickView, expect, openDemo, test } from './fixtures';
import { readFileSync } from 'node:fs';

async function twoImplants(page: Page) {
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('Enter');
  for (const fx of [0.38, 0.62]) {
    await page.click('#btn-add-lower');
    await clickView(page, 'pano', fx, 0.55);
  }
  expect(await page.evaluate(() => window.app.implants.length)).toBe(2);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => ((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined));
});

test('cross-sections contain the selected implant axis, upright on screen', async ({ page }) => {
  test.setTimeout(120_000);
  await twoImplants(page);
  // tilt the selected implant bucco-lingually and mesio-distally
  const r = await page.evaluate(() => {
    const a = window.app;
    const F = a.frame;
    const imp = a.selectedImplant();
    const t = [-0.25 * F[0][0] + 0.3 * F[1][0] - F[2][0], -0.25 * F[0][1] + 0.3 * F[1][1] - F[2][1], -0.25 * F[0][2] + 0.3 * F[1][2] - F[2][2]];
    const n = Math.hypot(t[0], t[1], t[2]);
    imp.axis = t.map((x: number) => x / n);
    a.implantChanged(imp, true);
    const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const crossP = (p: number[], q: number[]) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const out = [];
    for (let k = 0; k < 3; k++) {
      const pl = a.crossPlane(k);
      const nP = crossP(pl.u, pl.v);
      const d = [0, 1, 2].map((i) => imp.center[i] - pl.center[i]);
      out.push({ axis: Math.abs(dot(nP, imp.axis)), uz: Math.abs(dot(pl.u, F[2])), tilt: (Math.acos(Math.abs(dot(pl.v, imp.axis))) * 180) / Math.PI, off: Math.abs(dot(d, nP)) });
    }
    a.selectImplant(null, false);
    const free = a.crossPlane(1);
    return { out, freeV: Math.abs(dot(free.v, F[2])), spacing: a.crossSpacing };
  });
  for (const o of r.out) {
    expect(o.axis).toBeLessThan(1e-6); // the axis lies in every cross-section
    expect(o.uz).toBeLessThan(1e-6); // the screen stays upright (its horizontal is level)
    expect(o.tilt).toBeGreaterThan(10); // so the buccal tilt shows
  }
  expect(r.out[1].off).toBeLessThan(1e-3); // the middle one goes through the implant
  expect(r.out[0].off).toBeCloseTo(r.spacing, 0);
  expect(r.freeV).toBeCloseTo(1, 6); // nothing selected: vertical again
});

test('planning report: PDF with one page per implant', async ({ page }) => {
  test.setTimeout(240_000);
  await twoImplants(page);
  const before = await page.evaluate(() => ({ sel: window.app.selectedId, mode: window.app.mode }));

  await page.click('#btn-export-menu');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 180_000 }), page.click('#btn-export-report')]);
  expect(dl.suggestedFilename()).toMatch(/_planning_report_\d{4}-\d\d-\d\d\.pdf$/);
  const pdf = readFileSync((await dl.path())!).toString('latin1');
  expect(pdf.startsWith('%PDF-')).toBe(true);
  // overview + implant list + 2 implant pages
  expect(pdf.match(/\/Type \/Page\b(?!s)/g)?.length).toBe(4);
  expect(pdf.match(/\/Subtype \/Image/g)!.length).toBeGreaterThanOrEqual(1 + 2 * 7);
  await expect(page.locator('#status-msg')).toContainText('Planning report saved (2 implants)');
  // the app is as it was
  expect(await page.evaluate(() => ({ sel: window.app.selectedId, mode: window.app.mode }))).toEqual(before);
  expect(await page.locator('.view.max').count()).toBe(0);
});
