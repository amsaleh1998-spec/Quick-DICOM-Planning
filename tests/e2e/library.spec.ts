// No implant library is on the website: a library file is imported from the computer and kept in
// the browser (loads with no network), a newer version replaces it, an older one is only taken on
// request, and it can be removed. Uses the made-up test library.
import { type Page } from '@playwright/test';
import { clickView, expect, implantLibraryFile, openDemo, test } from './fixtures';

const stores = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('qdp-implant-library-v')));
const status = (page: Page) => page.locator('#lib-status');

async function planWithImplant(page: Page) {
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('Enter');
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', 0.4, 0.55);
}

test('nothing on the website: import a library file, use it offline, update it, remove it', async ({ page }) => {
  test.setTimeout(180_000);
  // the website holds no library (whatever the server answers, it is not a catalogue)
  const r = await page.request.get('/implants/index.json');
  expect(r.ok() && /json/.test(r.headers()['content-type'] ?? '')).toBe(false);

  await planWithImplant(page);
  // no library yet: generic only, and the way to import one
  await expect(page.locator('#lib-box')).toHaveAttribute('open', '');
  await expect(status(page)).toContainText('No implant library');
  await expect(page.locator('#lib-badge')).toBeVisible();
  await expect(page.locator('#imp-brand option')).toHaveText(['Generic', 'Import an implant library…']);

  // import version 1
  await page.setInputFiles('#lib-input', implantLibraryFile(1));
  await expect(status(page)).toContainText('Version 1');
  await expect(status(page)).toContainText('imported');
  await expect(page.locator('#lib-badge')).toBeHidden();
  expect(await stores(page)).toEqual(['qdp-implant-library-v1']);
  await expect(page.locator('#imp-brand option')).toHaveText(['Generic', 'Testco']);

  // a new session with no network: the catalogue and the meshes come from the browser
  await page.route('**/*.qdplib', (r) => r.abort());
  await page.reload();
  await planWithImplant(page);
  await page.selectOption('#imp-brand', 'Testco');
  await page.selectOption('#imp-system', 'Taper TX');
  const id = await page.evaluate(() => window.app.selectedImplant().lib.id as string);
  await expect.poll(() => page.evaluate((id) => window.app.libraryMeshLoaded(id), id)).toBe(true);

  // version 2 replaces version 1
  await page.setInputFiles('#lib-input', implantLibraryFile(2));
  await expect(status(page)).toContainText('Version 2');
  await expect.poll(() => stores(page)).toEqual(['qdp-implant-library-v2']);
  // the plan's implant keeps its model
  expect(await page.evaluate(() => window.app.implants[0].lib?.id)).toBe(id);

  // an older version is only taken when asked: declined here
  await page.evaluate(() => {
    const w = window as unknown as { confirm: (m: string) => boolean; asked?: string };
    w.confirm = (m: string) => ((w.asked = m), false);
  });
  await page.setInputFiles('#lib-input', implantLibraryFile(1));
  await expect.poll(() => page.evaluate(() => (window as unknown as { asked?: string }).asked ?? '')).toContain('older');
  await expect(status(page)).toContainText('Version 2');
  expect(await stores(page)).toEqual(['qdp-implant-library-v2']);

  // not a library file
  await page.setInputFiles('#lib-input', { name: 'notes.qdplib', mimeType: 'application/octet-stream', buffer: Buffer.from('hello') });
  await expect(status(page)).toContainText('not an implant library file');

  // remove it (the question is answered yes)
  await page.evaluate(() => ((window as unknown as { confirm: () => boolean }).confirm = () => true));
  await page.click('#btn-lib-remove');
  await expect(status(page)).toContainText('No implant library');
  await expect.poll(() => stores(page)).toEqual([]);
  // the plan keeps the implant's model (drawn as a generic implant until a library is imported)
  expect(await page.evaluate(() => window.app.implants[0].lib?.id)).toBe(id);
});

test('a library file dropped on the viewer is imported (the open scan stays)', async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  const vol = await page.evaluate(() => window.app.vol.id);
  await page.setInputFiles('#file-input', implantLibraryFile(1));
  await expect(page.locator('#lib-status')).toContainText('Version 1');
  expect(await page.evaluate(() => window.app.vol.id)).toBe(vol);
});
