// Dual scan protocol: the denture CBCT is opened next to the patient's, its radiopaque markers are
// matched, and the segmented denture lands where the denture sits in the patient's scan.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { applyT, makeDualScanSeries } from '../../scripts/make-dual-scan-test.mjs';

function seriesFiles() {
  const s = makeDualScanSeries();
  const out: Record<string, string[]> = {};
  for (const [k, files] of Object.entries(s)) {
    const d = join(tmpdir(), `qdp-e2e-dual-${process.pid}`, k);
    mkdirSync(d, { recursive: true });
    out[k] = files.map((f) => {
      const p = join(d, f.name);
      writeFileSync(p, f.data);
      return p;
    });
  }
  return out as { denture: string[]; patient: string[] };
}

test('the denture is segmented from its own CBCT and placed in the patient’s by its markers', async ({ page }) => {
  test.setTimeout(150_000);
  const files = seriesFiles();
  await page.goto('./');
  await page.setInputFiles('#file-input', files.patient);
  await page.waitForFunction(() => !!window.app.vol);
  await page.click('[data-panel="scans"]');
  await page.click('#btn-dual-scan');
  await expect(page.locator('.dual-scan .ds-files')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dual-scan')).toBeHidden();
  // (the file dialog itself is not driven here: the input it opens is filled directly)
  await page.setInputFiles('#dual-files', files.denture);
  const result = page.locator('.dual-scan .ds-result');
  await expect(result).toContainText('7 of 7 markers matched', { timeout: 60_000 });
  // the patient's scan is still the open one
  expect(await page.evaluate(() => window.app.vol!.nz)).toBe(110);
  // one window: markers, the threshold, the 3D denture and its editing tools
  const win = page.locator('.dual-big');
  await expect(win.locator('.mv')).toBeVisible();
  // the overlay over the 3D drawing stays see-through (a black one hid the denture once)
  expect(await win.locator('.mv-ov').evaluate((c) => getComputedStyle(c).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  const thr = Number(await win.locator('.ds-thr').inputValue());
  expect(thr).toBeGreaterThan(-700);
  expect(thr).toBeLessThan(120);
  const tris = async () => Number(((await win.locator('.me-stats').textContent()) ?? '').replace(/\D/g, ''));
  await expect.poll(tris, { timeout: 60_000 }).toBeGreaterThan(1000);
  await expect(win.locator('.ds-busy')).toBeHidden({ timeout: 60_000 });
  await expect(win.locator('.me-parts')).toContainText('One part');
  await expect(win.locator('.me-holes')).toContainText('No holes');
  const before = await tris();
  const box = (await win.locator('.mv').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const drag = async (pts: number[][]) => {
    await page.mouse.move(pts[0][0], pts[0][1]);
    await page.mouse.down();
    for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.up();
  };
  // lasso through the middle: the arch is cut in two
  await win.locator('[data-mode="lasso"]').click();
  await drag([[cx - 30, cy - 260], [cx + 30, cy - 260], [cx + 30, cy + 260], [cx - 30, cy + 260], [cx - 30, cy - 260]]);
  await expect.poll(tris).toBeLessThan(before);
  await expect(win.locator('.me-parts')).toContainText('2 parts');
  const afterLasso = await tris();
  // the threshold changes: the denture is segmented again, live, and the cut is applied again
  const setThr = async (v: number, release: boolean) =>
    win.locator('.ds-thr').evaluate(
      (el: HTMLInputElement, [v, release]) => {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (release) el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      [v, release] as const,
    );
  await setThr(thr + 200, false); // while dragging: a quick preview
  await expect(win.locator('.ds-thr-v')).toHaveText(String(thr + 200));
  await expect.poll(tris).not.toBe(afterLasso);
  await setThr(thr + 200, true); // let go: full detail
  await expect(win.locator('.ds-busy')).toBeHidden({ timeout: 60_000 });
  await expect(win.locator('.me-parts')).toContainText('2 parts');
  await setThr(thr, true);
  await expect(win.locator('.ds-busy')).toBeHidden({ timeout: 60_000 });
  await expect.poll(tris).toBe(afterLasso);
  // cut brush across the view
  await win.locator('[data-mode="cut"]').click();
  await drag([[cx - 220, cy + 40], [cx + 220, cy + 120]]);
  await expect.poll(tris).toBeLessThan(afterLasso);
  const afterCut = await tris();
  // smooth brush: same triangles, one more step to undo
  await win.locator('[data-mode="smooth"]').click();
  await drag([[cx - 220, cy - 60], [cx + 220, cy - 20]]);
  await page.keyboard.press('Control+z'); // the smoothing undone
  await expect.poll(tris).toBe(afterCut);
  await page.keyboard.press('Control+z'); // the cut undone
  await expect.poll(tris).toBe(afterLasso);
  await page.keyboard.press('Control+y');
  await expect.poll(tris).toBe(afterCut);
  // islands and holes
  await page.keyboard.press('Escape'); // back to Select (the window stays open)
  await expect(win.locator('[data-mode="select"]')).toHaveClass(/active/);
  await win.locator('.me-largest').click();
  await expect(win.locator('.me-parts')).toContainText('One part');
  await win.locator('.me-fill').click();
  await expect(win.locator('.me-holes')).toContainText('No holes');
  await win.locator('.ds-create').click();
  await expect(win).toBeHidden({ timeout: 60_000 });
  const scan = await page.evaluate(() => {
    const s = window.app.scans[window.app.scans.length - 1];
    return { kind: s.kind, name: s.name, T: s.transform, placement: s.placement, tris: s.mesh.idx.length / 3 };
  });
  expect(scan.kind).toBe('denture');
  expect(scan.placement).toMatchObject({ method: 'markers', markers: 7 });
  expect(scan.tris).toBeGreaterThan(1000);
  // points of the denture land where the test data put the worn denture
  const at = (m: number[], p: number[]) => [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);
  for (const p of [
    [25, 12, 9],
    [10, 30, 6],
    [40, 32, 12],
  ]) {
    const q = at(scan.T!, p), e = applyT(p);
    expect(Math.hypot(q[0] - e[0], q[1] - e[1], q[2] - e[2])).toBeLessThan(0.5);
  }
  await expect(page.locator('#scan-list')).toContainText('Denture');
  await expect(page.locator('#scan-edit')).toContainText('placed by 7 radiopaque markers');
});
