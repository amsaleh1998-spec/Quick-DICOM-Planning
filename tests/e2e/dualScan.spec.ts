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
  // the acrylic threshold: between air and acrylic
  const thr = Number(await page.locator('.dual-scan .ds-thr').inputValue());
  expect(thr).toBeGreaterThan(-700);
  expect(thr).toBeLessThan(120);
  await page.click('.dual-scan .ds-create');
  await expect(page.locator('.dual-scan')).toBeHidden({ timeout: 60_000 });
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
