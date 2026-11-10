// The implant library can be downloaded into the browser: implants then load from there (no
// network), a newer published version is offered as an update, and the download can be removed.
import { type Page } from '@playwright/test';
import { clickView, expect, openDemo, test } from './fixtures';

const box = (page: Page) => page.locator('#lib-box');
const stores = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('qdp-implant-library-v')));

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
  await expect(page.locator('#imp-brand option')).not.toHaveCount(1, { timeout: 15_000 });
}

test('download the implant library, load from it offline, update to a newer version, remove it', async ({ page }) => {
  test.setTimeout(240_000);
  await planWithImplant(page);
  await box(page).locator('summary').click();
  await expect(page.locator('#lib-status')).toContainText('Version 1');
  await expect(page.locator('#btn-lib-download')).toHaveText(/^Download \(\d+ MB\)$/);
  await expect(page.locator('#lib-badge')).toBeHidden();

  // download
  await page.click('#btn-lib-download');
  await expect(page.locator('#lib-status')).toContainText('downloaded', { timeout: 120_000 });
  await expect(page.locator('#lib-status')).toContainText('load instantly');
  expect(await stores(page)).toEqual(['qdp-implant-library-v1']);
  const entries = await page.evaluate(async () => (await (await caches.open('qdp-implant-library-v1')).keys()).length);
  expect(entries).toBe(64 + 2); // every system, the catalogue and the download record
  await expect(page.locator('#btn-lib-remove')).toBeVisible();

  // a new session without the network for the library: catalogue and meshes come from the download
  const fetched: string[] = [];
  await page.route('**/implants/**', (r) => {
    fetched.push(r.request().url());
    return r.abort();
  });
  await page.reload();
  await planWithImplant(page);
  await page.selectOption('#imp-brand', 'Straumann');
  await page.selectOption('#imp-system', 'BLX SLActive');
  const id = await page.evaluate(() => window.app.selectedImplant().lib.id as string);
  await expect.poll(() => page.evaluate((id) => window.app.libraryMeshLoaded(id), id)).toBe(true);
  await box(page).locator('summary').click();
  await expect(page.locator('#lib-status')).toContainText('could not check for updates');
  // only the update check went to the server
  expect(fetched.every((u) => u.endsWith('/implants/index.json'))).toBe(true);

  // version 2 is published: it is offered, downloaded, and replaces version 1
  await page.unroute('**/implants/**');
  await page.route('**/implants/index.json', async (r) => {
    const res = await r.fetch();
    const ix = await res.json();
    ix.library = 2;
    return r.fulfill({ response: res, json: ix });
  });
  await page.reload();
  await planWithImplant(page);
  await expect(page.locator('#lib-badge')).toBeVisible();
  await box(page).locator('summary').click();
  await expect(page.locator('#lib-status')).toContainText('Version 2');
  await expect(page.locator('#lib-status')).toContainText('is available');
  await expect(page.locator('#btn-lib-download')).toHaveText(/^Update to version 2 \(\d+ MB\)$/);
  await page.click('#btn-lib-download');
  await expect(page.locator('#lib-badge')).toBeHidden({ timeout: 120_000 });
  await expect(page.locator('#lib-status')).toContainText('Version 2');
  await expect(page.locator('#lib-status')).toContainText('downloaded');
  expect(await stores(page)).toEqual(['qdp-implant-library-v2']);

  // remove: loaded from the server again
  await page.click('#btn-lib-remove');
  await expect(page.locator('#btn-lib-download')).toHaveText(/^Download \(\d+ MB\)$/);
  await expect.poll(() => stores(page)).toEqual([]);
});
