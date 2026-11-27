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

test('Settings → Test file access runs the browser steps and shows them', async ({ page }) => {
  await page.click('#btn-settings');
  await page.click('#btn-file-check');
  const fc = page.locator('.file-check');
  await expect(fc).toBeVisible();
  await expect(fc.locator('li.ok')).toHaveCount(2); // the browser, the Recent list
  await expect(fc.locator('li').nth(1)).toContainText('Read the Recent list');
  await expect(fc.locator('.fc-pick')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(fc).toBeHidden();
});

test('a double-clicked .qdp project opens the plan', async ({ page }) => {
  test.setTimeout(90_000);
  // a project to open: the test series, saved (as a download)
  await page.evaluate(() => ((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined));
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-save-project')]);
  expect(dl.suggestedFilename()).toMatch(/\.qdp$/);
  const bytes = readFileSync((await dl.path())!).toString('base64');
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { __launch?: unknown }).__launch);
  await page.evaluate((b64) => {
    // (a stand-in for the file handle: the test browser crashes reading its own storage's handles
    // back from IndexedDB, where Recent keeps them)
    const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'Loader_plan.qdp');
    const h = { kind: 'file', name: file.name, getFile: async () => file };
    (window as unknown as { __launch: (p: unknown) => void }).__launch({ files: [h] });
  }, bytes);
  await page.waitForFunction(() => !!window.app.vol, null, { timeout: 60_000 });
  await expect(page.locator('#status-msg')).toContainText('Project "Loader_plan.qdp" restored');
  await expect(page.locator('#launch-banner')).toBeHidden(); // no scans folder needed for a project
});

test('a .qdp handed over at once (as Edge / Chrome do while the app loads): listed under Recent, Save writes back to it', async ({ page }) => {
  test.setTimeout(90_000);
  // a project file (the test series, saved as a download)
  await page.evaluate(() => ((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined));
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-save-project')]);
  const bytes = readFileSync((await dl.path())!).toString('base64');
  // a new window of the app, started by the double-click: the browser has the file queued and hands it
  // to the consumer the moment it is set
  const p2 = await page.context().newPage();
  await p2.addInitScript((b64) => {
    const w = window as unknown as { written: number[] };
    w.written = [];
    const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'Loader_plan.qdp');
    // (a stand-in handle: its methods on the class, so Recent can store it in IndexedDB)
    class Handle {
      kind = 'file';
      name = file.name;
      async getFile() {
        return file;
      }
      async requestPermission() {
        return 'granted';
      }
      async createWritable() {
        return { write: async (b: Blob) => void w.written.push(b.size), close: async () => {} };
      }
    }
    Object.defineProperty(window, 'launchQueue', {
      configurable: true,
      value: { setConsumer: (cb: (p: unknown) => void) => cb({ files: [new Handle()] }) },
    });
  }, bytes);
  await p2.goto('./');
  await p2.waitForFunction(() => !!window.app.vol, null, { timeout: 60_000 });
  await expect(p2.locator('#status-msg')).toContainText('Project "Loader_plan.qdp" restored');
  // listed under Recent
  await p2.click('#btn-open-menu');
  await expect(p2.locator('#open-recent .recent-item').first()).toContainText('project');
  await p2.keyboard.press('Escape');
  // changed, saved: back into the same file, without a dialog
  expect(await p2.evaluate(() => window.app.projectFile?.name)).toBe('Loader_plan.qdp');
  await p2.evaluate(() => {
    const a = window.app;
    a.placing = 'lower';
    a.placeImplantAt(a.vol.center);
  });
  await p2.keyboard.press('Control+s');
  await expect(p2.locator('#status-msg')).toContainText('Project saved to Loader_plan.qdp');
  expect((await p2.evaluate(() => (window as unknown as { written: number[] }).written)).length).toBe(1);
  await p2.close();
});
