// Export ▾ → DICOM series: a ZIP of one image per slice, which opens again as the same volume.
import { dicomFiles, expect, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  // the native save dialog cannot be driven: the export is a download
  await page.addInitScript(() => ((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined));
});

test('the volume is exported as a DICOM series and opens again the same', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('./');
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  const before = await page.evaluate(() => {
    const v = window.app.vol!;
    let sum = 0;
    for (let i = 0; i < v.data.length; i += 7) sum += v.data[i];
    return { dims: [v.nx, v.ny, v.nz], spacing: [...v.spacing], sum, affine: v.info.patientAffine };
  });
  await page.click('#btn-export-menu');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-dicom')]);
  expect(dl.suggestedFilename()).toMatch(/^Test_Loader_\d{4}-\d\d-\d\d_\d{4}_DICOM\.zip$/);
  await expect(page.locator('#status-msg')).toContainText(`Exported ${before.dims[2]} DICOM images`);
  // open the exported ZIP: the same voxels, spacing and patient coordinates
  await page.evaluate(() => window.app.markSaved());
  await page.setInputFiles('#file-input', (await dl.path())!);
  await expect(page.locator('#status-msg')).toContainText('Loaded');
  const after = await page.evaluate(() => {
    const v = window.app.vol!;
    let sum = 0;
    for (let i = 0; i < v.data.length; i += 7) sum += v.data[i];
    return { dims: [v.nx, v.ny, v.nz], spacing: [...v.spacing], sum, affine: v.info.patientAffine, desc: v.info.seriesDescription };
  });
  expect(after.dims).toEqual(before.dims);
  expect(after.spacing).toEqual(before.spacing);
  expect(after.sum).toBe(before.sum);
  after.affine!.forEach((x: number, i: number) => expect(x).toBeCloseTo(before.affine![i], 4));
  expect(after.desc).toContain('(Quick DICOM Planning)');
});
