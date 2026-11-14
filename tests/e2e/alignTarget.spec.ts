// An intraoral scan named upper / lower is aligned by default to that jaw's teeth from the
// automatic segmentation (also a wax-up whose name says the jaw).
import { archStl, expect, openDemo, test } from './fixtures';

test('a scan is aligned to its own jaw’s teeth from the automatic segmentation by default', async ({ page }) => {
  test.setTimeout(150_000);
  await openDemo(page);
  // an automatic segmentation: the four jaw / teeth classes, as small blocks
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const a = window.app;
        const g = a.seg;
        const n = g.nx * g.ny * g.nz;
        const cls = new Uint8Array(n);
        const counts = new Array(6).fill(0);
        for (let k = 0, idx = 0; k < g.nz; k++)
          for (let j = 0; j < g.ny; j++)
            for (let i = 0; i < g.nx; i++, idx++) {
              const c = 1 + Math.floor((4 * i) / g.nx); // four slabs side by side
              if (j > g.ny * 0.4 && j < g.ny * 0.6 && k > g.nz * 0.4 && k < g.nz * 0.6) {
                cls[idx] = c;
                counts[c]++;
              }
            }
        a.applyAiSegmentation({ cls, margin: new Uint8Array(n).fill(200), counts }, 'test', null, () => done());
      }),
  );
  await page.click('[data-panel="scans"]');
  const cases: [string, string][] = [
    ['Lower_scan.stl', 'Segment: Lower teeth'],
    ['UpperJaw.stl', 'Segment: Upper teeth'],
    ['Waxup_lower.stl', 'Segment: Lower teeth'],
  ];
  for (const [file, target] of cases) {
    await page.setInputFiles('#scan-input', archStl(file));
    await expect(page.locator('.scan-place')).toBeVisible({ timeout: 30_000 });
    await page.click('.scan-place #pl-go'); // "Align to the CBCT" is the default
    const sel = page.locator('.scan-align #sa-target');
    await expect(sel).toBeVisible();
    expect(await sel.evaluate((s: HTMLSelectElement) => s.selectedOptions[0].textContent), file).toBe(target);
    await expect(page.locator('.scan-align #sa-jaw')).toHaveValue(/lower/i.test(file) ? 'lower' : 'upper');
    await page.keyboard.press('Escape');
    await expect(page.locator('.scan-align')).toBeHidden();
  }
});
