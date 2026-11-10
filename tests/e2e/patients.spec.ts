// A folder with scans of two (made-up) patients: both are shown to choose from, the files can be
// sorted into a folder per patient (copies; the originals stay), and the chosen one opens.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestSeries } from '../../scripts/make-test-dicom.mjs';
import { expect, test } from './fixtures';

function mixedFolder(): string[] {
  const d = join(tmpdir(), `qdp-e2e-mixed-${process.pid}`);
  mkdirSync(d, { recursive: true });
  const files = [
    ...makeTestSeries({ patient: { name: 'Doe^Jane', id: 'PAT-1001', birth: '19700101', sex: 'F' }, uid: '1.2.826.0.1.3680043.8.498.71', prefix: 'A', slices: 30 }),
    ...makeTestSeries({ patient: { name: 'Roe^Richard', id: 'PAT-2002', birth: '19650505', sex: 'M' }, uid: '1.2.826.0.1.3680043.8.498.72', prefix: 'B', slices: 40 }),
  ];
  return files.map((f) => {
    const p = join(d, f.name);
    writeFileSync(p, f.data);
    return p;
  });
}

test('two patients in one folder: tell them apart, sort into folders, open one', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  // the folder picker hands over a folder of the browser's private storage, so what is written can be read back
  await page.evaluate(() => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle('sorted', { create: true });
    };
  });
  await page.setInputFiles('#file-input', mixedFolder());

  const dlg = page.locator('.patient-chooser');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('h2')).toHaveText('2 patients in these files');
  const cards = dlg.locator('.pc-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: 'DOE, Jane' })).toContainText('PAT-1001');
  await expect(cards.filter({ hasText: 'DOE, Jane' })).toContainText('1970-01-01');
  await expect(cards.filter({ hasText: 'DOE, Jane' })).toContainText('30 images');
  await expect(cards.filter({ hasText: 'ROE, Richard' })).toContainText('40 images');
  // a picture of each scan
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLCanvasElement>('.pc-preview')].map((c) => c.width > 1))).toEqual([true, true]);

  // a folder per patient, named after them, with their files
  await dlg.locator('.pc-sort').click();
  await expect(dlg.locator('.pc-done')).toContainText('Created 2 patient folders');
  const sorted = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('sorted');
    const out: Record<string, number> = {};
    for await (const [name, h] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind !== 'directory') continue;
      let n = 0;
      for await (const _ of (h as unknown as { values(): AsyncIterable<unknown> }).values()) n++;
      out[name] = n;
    }
    return out;
  });
  expect(sorted).toEqual({ 'DOE Jane (ID PAT-1001)': 30, 'ROE Richard (ID PAT-2002)': 40 });

  // open the second patient
  await cards.filter({ hasText: 'ROE, Richard' }).locator('.pc-open').click();
  await expect(dlg).toBeHidden();
  await page.waitForFunction(() => !!window.app.vol);
  expect(await page.evaluate(() => window.app.vol.info.patientName)).toBe('Roe^Richard');
});

test('cancelling the choice opens nothing', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', mixedFolder());
  await expect(page.locator('.patient-chooser')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.patient-chooser')).toBeHidden();
  await expect(page.locator('#status-msg')).toContainText('Nothing opened');
  expect(await page.evaluate(() => !!window.app.vol)).toBe(false);
});
