// Recent scans: what was opened (also by drag & drop) is listed on the start screen and reopens
// with one click. Needs a normal browser profile – file handles kept in IndexedDB.
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { dicomFiles, expect, test } from './fixtures';

let ctx: BrowserContext;
let page: Page;
const errors: string[] = [];

test.beforeAll(async () => {
  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'qdp-profile-')), {
    baseURL: 'http://localhost:4173/',
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
  });
  // the test series, fetched by the page to build a "dropped folder" in its private file system
  const files = dicomFiles();
  await ctx.route('**/__fixtures/**', (route) => {
    const name = decodeURIComponent(route.request().url().split('/__fixtures/')[1]);
    if (name === 'list') return route.fulfill({ body: files.map((f) => basename(f)).join('\n') });
    const f = files.find((p) => basename(p) === name);
    return f ? route.fulfill({ body: readFileSync(f) }) : route.fulfill({ status: 404 });
  });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterAll(async () => {
  await ctx.close();
  expect(errors).toEqual([]);
});

test('a dropped folder is listed under Recent and reopens from the start screen', async () => {
  await page.goto('./');
  await expect(page.locator('#start-recent')).toBeHidden();
  // drop the series folder (a directory handle, as Chrome / Edge give for a real drop)
  await page.evaluate(async () => {
    const names = (await (await fetch('__fixtures/list')).text()).split('\n');
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('CBCT DOE Jane', { create: true });
    const files: File[] = [];
    for (const n of names) {
      const blob = await (await fetch(`__fixtures/${n}`)).blob();
      const fh = await dir.getFileHandle(n, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      files.push(new File([blob], n));
    }
    const dt = { items: [{ kind: 'file', getAsFileSystemHandle: () => Promise.resolve(dir), webkitGetAsEntry: () => null }], files };
    const ev = new Event('drop', { cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    window.dispatchEvent(ev);
  });
  await page.waitForFunction(() => !!window.app.vol);
  // stored once the scan has loaded (the list is rendered again then)
  await expect(page.locator('#start-recent li')).toHaveCount(1);
  await page.reload();
  const item = page.locator('#start-recent li').first();
  await expect(item).toContainText('TEST, Loader');
  await expect(item).toContainText('folder');
  await item.click();
  await page.waitForFunction(() => !!window.app.vol);
  expect(await page.evaluate(() => window.app.vol.nx * window.app.vol.ny * window.app.vol.nz)).toBe(80 * 70 * 50);
  // also in the Open menu
  await page.click('#btn-open-menu');
  await expect(page.locator('#open-recent .recent-item').first()).toContainText('TEST, Loader');
});

test('a dropped STL is not listed under Recent', async () => {
  await page.goto('./');
  const before = await page.locator('#start-recent li').count();
  await page.evaluate(() => {
    const ev = new Event('drop', { cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { items: [], files: [new File([new Uint8Array(84)], 'upper.stl')] } });
    window.dispatchEvent(ev);
  });
  await expect(page.locator('#status-msg')).toContainText('Open a CBCT first');
  await page.reload();
  await expect(page.locator('#start-recent li')).toHaveCount(before);
});
