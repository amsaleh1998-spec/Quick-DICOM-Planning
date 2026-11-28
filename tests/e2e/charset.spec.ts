// Patient names in other scripts: the file's Specific Character Set (0008,0005) is honoured –
// Russian in UTF-8, Arabic in ISO-8859-6 – in the patient chip, the DICOM tags, and a DICOM export.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestSeries } from '../../scripts/make-test-dicom.mjs';
import { expect, test } from './fixtures';

function series(name: string, charset: string, bytes: Buffer): string[] {
  const d = join(tmpdir(), `qdp-charset-${process.pid}-${name}`);
  mkdirSync(d, { recursive: true });
  return makeTestSeries({ charset, patient: { name: bytes } }).map((f) => {
    const p = join(d, f.name);
    writeFileSync(p, f.data);
    return p;
  });
}
/** ISO-8859-6: Arabic letters U+0621..U+0652 -> 0xC1..0xF2 */
const iso6 = (s: string) => Buffer.from(Array.from(s, (ch) => (ch.charCodeAt(0) >= 0x621 && ch.charCodeAt(0) <= 0x652 ? ch.charCodeAt(0) - 0x560 : ch.charCodeAt(0))));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => ((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined));
});

test('Russian (UTF-8): the name as written, also in the DICOM tags and after a DICOM export', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('./');
  await page.setInputFiles('#file-input', series('ru', 'ISO_IR 192', Buffer.from('Морозов^Николай', 'utf8')));
  await page.waitForFunction(() => !!window.app.vol);
  await expect(page.locator('#patient-badge')).toHaveText('МОРОЗОВ, Николай');
  await page.click('#patient-chip');
  await page.click('#btn-tags');
  await expect(page.locator('.modal-backdrop').last()).toContainText("Patient's NamePNМорозов^Николай");
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // exported (UTF-8, declared) and opened again: the same name
  await page.click('#btn-export-menu');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-dicom')]);
  await expect(page.locator('#status-msg')).toContainText('Exported');
  await page.evaluate(() => window.app.markSaved());
  await page.setInputFiles('#file-input', (await dl.path())!);
  await expect(page.locator('#status-msg')).toContainText('Loaded');
  expect(await page.evaluate(() => window.app.vol!.info.patientName)).toBe('Морозов^Николай');
});

test('Arabic (ISO-8859-6): the name as written', async ({ page }) => {
  await page.goto('./');
  await page.setInputFiles('#file-input', series('ar', 'ISO_IR 127', iso6('محمد^أحمد')));
  await page.waitForFunction(() => !!window.app.vol);
  await expect(page.locator('#patient-badge')).toHaveText('محمد, أحمد');
  expect(await page.evaluate(() => window.app.vol!.info.patientName)).toBe('محمد^أحمد');
});
