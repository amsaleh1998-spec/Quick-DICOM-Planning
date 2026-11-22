// Files double-clicked in Explorer (installed app): the browser hands them over through the launch
// queue. Faked here: a file of the browser's own storage, and a file the browser never delivers.
import { dicomFiles, expect, test } from './fixtures';
import { readFileSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'launchQueue', {
      configurable: true,
      value: { setConsumer: (cb: unknown) => ((window as unknown as { __launch: unknown }).__launch = cb) },
    });
  });
  await page.goto('./');
  await page.waitForFunction(() => !!(window as unknown as { __launch?: unknown }).__launch);
});

test('a double-clicked DICOM file outside a known scans folder asks for the folder', async ({ page }) => {
  const one = readFileSync(dicomFiles()[0]).toString('base64');
  await page.evaluate(async (b64) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scan', { create: true });
    const h = await dir.getFileHandle('IM000002.dcm', { create: true });
    const w = await h.createWritable();
    await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    await w.close();
    (window as unknown as { __launch: (p: unknown) => void }).__launch({ files: [h] });
  }, one);
  await expect(page.locator('#launch-banner')).toBeVisible();
  await expect(page.locator('#launch-banner')).toHaveAttribute('data-kind', 'setup');
  await expect(page.locator('#loading')).toBeHidden();
});

test('a file the browser never delivers: the wait can be cancelled, then anything else opens', async ({ page }) => {
  test.setTimeout(60_000);
  await page.evaluate(() => {
    const never = { kind: 'file', name: 'IM000002.dcm', getFile: () => new Promise(() => {}) };
    (window as unknown as { __launch: (p: unknown) => void }).__launch({ files: [never] });
  });
  await expect(page.locator('#loading')).toBeVisible();
  await expect(page.locator('#loading-text')).toHaveText('Opening “IM000002.dcm”…');
  // after a while without progress: Cancel
  await expect(page.locator('#loading-cancel')).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('#loading-alt')).toHaveText('Choose the folder…'); // a picker grants access at once
  await page.click('#loading-cancel');
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('#status-msg')).toContainText('Stopped opening “IM000002.dcm”');
  // the app is free again
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  // the late launch never comes back to replace it, and gives up with a message on its own
  await page.waitForTimeout(500);
  await expect(page.locator('#launch-banner')).toBeHidden();
});

test('without cancelling, the stuck step gives up with a message naming it', async ({ page }) => {
  test.setTimeout(60_000);
  await page.evaluate(() => {
    const never = { kind: 'file', name: 'IM000002.dcm', getFile: () => new Promise(() => {}) };
    (window as unknown as { __launch: (p: unknown) => void }).__launch({ files: [never] });
  });
  await expect(page.locator('#launch-banner')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#lb-msg')).toContainText('Reading the file did not answer within 15 s');
  await expect(page.locator('#loading')).toBeHidden();
});
