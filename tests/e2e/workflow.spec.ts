// The main path: open a CBCT, plan, segment, import a scan, export, save and reopen the project.
import { readFileSync } from 'node:fs';
import { archStl, clickView, dicomFiles, expect, openDemo, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  // the native save dialog cannot be driven: projects are saved as downloads
  await page.addInitScript(() => ((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined));
});

test('opens a DICOM series from the start screen, straight into Plan when set', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#start-screen')).toBeVisible();
  await page.click('#btn-settings');
  await page.check('#set-open-plan');
  await page.keyboard.press('Escape');
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  await expect(page.locator('#start-screen')).toBeHidden();
  expect(await page.evaluate(() => window.app.mode)).toBe('plan');
  // planning starts with the panoramic curve
  await expect(page.locator('#panel-curve')).toBeVisible();
  await expect(page.locator('#btn-draw-curve')).toHaveText('Finish curve'); // already drawing
  expect(await page.evaluate(() => window.app.drawing)).toEqual([]);
  await expect(page.locator('#patient-badge')).toHaveText('TEST, Loader');
  await expect(page).toHaveTitle(/^TEST, Loader/);
  // the patient popover shows the volume and the DICOM tags
  await page.click('#patient-chip');
  await expect(page.locator('#vol-info')).toContainText('80 × 70 × 50 voxels');
  await page.click('#btn-tags');
  await expect(page.locator('.modal-backdrop').last()).toContainText("Patient's NamePNTest^Loader");
});

test('plans implants, segments, imports a scan, exports, saves and reopens the project', async ({ page }) => {
  await openDemo(page);
  await page.click('[data-mode="plan"]');
  await expect(page.locator('#panel-curve')).toBeVisible();
  // implant from the panel button
  await page.click('[data-panel="implants"]');
  await page.click('#btn-add-lower');
  await clickView(page, 'planAxial', 0.3, 0.75);
  await expect.poll(() => page.evaluate(() => window.app.implants.length)).toBe(1);
  await expect(page.locator('[data-panel="implants"] .rail-badge')).toHaveText('1');
  await page.fill('#imp-d', '4.5');
  await page.dispatchEvent('#imp-d', 'input');
  expect(await page.evaluate(() => window.app.implants[0].diameter)).toBe(4.5);
  await expect(page.locator('#implant-list li')).toContainText('Ø4.5');

  // view settings inside the views
  await page.click('#btn-vr-menu');
  await page.click('#vr-mode [data-vr="mip"]');
  expect(await page.evaluate(() => window.app.vr.mode)).toBe('mip');
  await page.click('#vr-mode [data-vr="surface"]');
  await page.keyboard.press('Escape');
  await page.click('#pano-mode [data-pm="slice"]');
  expect(await page.evaluate(() => window.app.panoMode)).toBe('slice');
  await page.click('#pano-mode [data-pm="slab"]');
  await page.click('#btn-pano-menu');
  await page.$eval('#spacing', (e: HTMLInputElement) => ((e.value = '3'), e.dispatchEvent(new Event('input'))));
  expect(await page.evaluate(() => window.app.crossSpacing)).toBe(3);
  await page.keyboard.press('Escape');

  // segment from a preset + opacity
  await page.click('[data-panel="segments"]');
  await page.click('[data-seg-preset="1"]');
  expect(await page.evaluate(() => window.app.seg.segments.length)).toBe(1);
  await page.$eval('#seg-opacity', (e: HTMLInputElement) => ((e.value = '0.5'), e.dispatchEvent(new Event('input'))));
  expect(await page.evaluate(() => window.app.seg.segments[0].opacity)).toBe(0.5);
  await page.keyboard.press('Escape');

  // intraoral scan: import opens the placement dialog
  await page.click('[data-panel="scans"]');
  await page.setInputFiles('#scan-input', archStl());
  await expect(page.locator('.scan-place')).toBeVisible({ timeout: 30_000 });
  await page.click('.scan-place .modal-close');
  await expect(page.locator('[data-panel="scans"] .rail-badge')).toHaveText('1');

  // STL export dialog: one implant → a download
  await page.click('#btn-export-menu');
  await page.click('#btn-export-stl');
  await expect(page.locator('.export-stl')).toBeVisible();
  await page.click('.export-stl .modal-close');

  // patient rename
  await page.click('#patient-chip');
  await page.fill('#pt-last', 'ROE');
  await page.dispatchEvent('#pt-last', 'input');
  await expect(page.locator('#patient-badge')).toContainText('ROE');
  await page.keyboard.press('Escape');

  // save → reopen: the plan comes back
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#btn-save-project')]);
  const file = test.info().outputPath('plan.qdp.zip');
  await dl.saveAs(file);
  expect(readFileSync(file).subarray(0, 2).toString()).toBe('PK');
  await page.goto('./');
  await page.setInputFiles('#project-input', file);
  await page.waitForFunction(() => !!window.app.vol, null, { timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(() => [window.app.implants.length, window.app.seg.segments.length, window.app.scans.length, window.app.implants[0]?.diameter]))
    .toEqual([1, 1, 1, 4.5]);
  await expect(page.locator('#patient-badge')).toContainText('ROE');
});

test('Plan opens on the panoramic curve until there is one, then on the last panel used', async ({ page }) => {
  await openDemo(page);
  await page.click('[data-mode="plan"]');
  await expect(page.locator('#panel-curve')).toBeVisible();
  expect(await page.evaluate(() => !!window.app.drawing)).toBe(true);
  await page.click('[data-panel="implants"]');
  await page.click('[data-mode="mpr"]');
  expect(await page.evaluate(() => window.app.drawing)).toBeNull(); // nothing drawn: dropped
  await page.click('[data-mode="plan"]');
  await expect(page.locator('#panel-curve')).toBeVisible(); // still no curve
  await page.evaluate(() => window.app.addCurve([[-20, 0], [0, 15], [20, 0]]));
  await page.click('[data-panel="implants"]');
  await page.click('[data-mode="mpr"]');
  await page.click('[data-mode="plan"]');
  await expect(page.locator('#panel-plan')).toBeVisible();
});

test('drawing the curve leads on to the implants', async ({ page }) => {
  await openDemo(page);
  await page.click('[data-mode="plan"]');
  for (const [x, y] of [[0.25, 0.6], [0.4, 0.38], [0.6, 0.38], [0.75, 0.6]]) await clickView(page, 'planAxial', x, y);
  await page.click('#btn-draw-curve'); // Finish curve
  await expect(page.locator('#panel-plan')).toBeVisible();
  await expect(page.locator('#btn-add-lower')).toBeVisible();
  expect(await page.evaluate(() => window.app.curves.length)).toBe(1);
});

test('closing with an unsaved plan asks first, not after saving', async ({ page }) => {
  const asked: string[] = [];
  page.on('dialog', (d) => asked.push(d.type())); // (accepted by the fixture)
  await page.goto('./');
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  await expect(page.locator('#btn-save-project')).not.toHaveClass(/dirty/); // nothing planned yet
  await page.click('[data-mode="plan"]');
  await page.keyboard.press('Escape');
  await page.click('[data-panel="implants"]');
  await page.click('#btn-add-lower');
  await clickView(page, 'planAxial', 0.5, 0.5);
  await expect(page.locator('#btn-save-project')).toHaveClass(/dirty/);
  // saved: no question when leaving
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-save-project')]);
  await dl.path();
  await expect(page.locator('#btn-save-project')).not.toHaveClass(/dirty/);
  // changed again: leaving asks
  await page.fill('#imp-l', '12');
  await page.dispatchEvent('#imp-l', 'input');
  await expect(page.locator('#btn-save-project')).toHaveClass(/dirty/);
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toEqual(['beforeunload']);
});

test('opening another scan over an unsaved plan asks: cancel, save, or leave it', async ({ page }) => {
  await page.goto('./');
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  await page.click('[data-mode="plan"]');
  await page.keyboard.press('Escape');
  await page.click('[data-panel="implants"]');
  await page.click('#btn-add-lower');
  await clickView(page, 'planAxial', 0.5, 0.5);
  await expect(page.locator('#btn-save-project')).toHaveClass(/dirty/);
  const openDemoFromMenu = async () => {
    await page.click('#btn-open-menu');
    await page.click('#btn-demo');
  };
  // Cancel: the plan stays
  await openDemoFromMenu();
  await expect(page.locator('.ask-save')).toBeVisible();
  await expect(page.locator('.ask-save')).toContainText('TEST, Loader');
  await page.click('.ask-save .as-cancel');
  await expect(page.locator('.ask-save')).toBeHidden();
  expect(await page.evaluate(() => [window.app.vol.info.source.includes('slices'), window.app.implants.length])).toEqual([true, 1]);
  // Save…: saved, then replaced
  await openDemoFromMenu();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.ask-save .as-save')]);
  await dl.path();
  await expect.poll(() => page.evaluate(() => window.app.vol.info.source)).toBe('Demo phantom');
  // a new plan on another scan, then Don't save
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => window.app.vol.info.source !== 'Demo phantom');
  await page.click('[data-mode="plan"]');
  await page.keyboard.press('Escape');
  await page.click('[data-panel="implants"]');
  await page.click('#btn-add-lower');
  await clickView(page, 'planAxial', 0.5, 0.5);
  await expect(page.locator('#btn-save-project')).toHaveClass(/dirty/);
  await openDemoFromMenu();
  await page.click('.ask-save .as-discard');
  await expect.poll(() => page.evaluate(() => window.app.vol.info.source)).toBe('Demo phantom');
  // the demo itself never asks
  await page.keyboard.press('Escape');
  await page.click('[data-panel="implants"]');
  await page.click('#btn-add-lower');
  await clickView(page, 'planAxial', 0.3, 0.75);
  await openDemoFromMenu();
  await expect(page.locator('.ask-save')).toHaveCount(0);
});

test('rail, help sheet and keyboard', async ({ page }) => {
  await openDemo(page);
  await page.click('#rail-collapse');
  await expect(page.locator('#sidebar')).toBeHidden();
  await page.click('#rail-collapse');
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.keyboard.press('?');
  await expect(page.locator('.help-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.help-sheet')).toBeHidden();
  await page.keyboard.press('2');
  expect(await page.evaluate(() => window.app.mode)).toBe('plan');
  await page.keyboard.press('1');
  expect(await page.evaluate(() => window.app.mode)).toBe('mpr');
  // reorient tools
  await page.click('#mpr-tools [data-tool="crop"]');
  expect(await page.evaluate(() => window.app.mprTool)).toBe('crop');
  await expect(page.locator('#mpr-status')).toContainText('Tilt');
  // settings
  await page.click('#btn-settings');
  await page.click('#input-seg [data-input="trackpad"]');
  expect(await page.evaluate(() => window.app.input)).toBe('trackpad');
  await page.click('#input-seg [data-input="mouse"]');
  await page.click('#rd-seg [data-rd="wl"]');
  expect(await page.evaluate(() => window.app.rightDrag)).toBe('wl');
});

test('phones get the mobile version, which opens the demo', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  await expect(page).toHaveURL(/mobile\.html/);
  await page.click('#m-empty-demo');
  await page.waitForFunction(() => !!window.app?.vol);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('in the installed app the window title starts with the app name, then the patient (what the taskbar shows)', async ({ page }) => {
  // an installed app window: display-mode standalone
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (/display-mode:\s*standalone/.test(q) ? ({ ...real(q), matches: true } as MediaQueryList) : real(q));
  });
  await page.goto('./');
  await expect(page).toHaveTitle('QDP');
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  // Chrome / Edge show the page title of an app window only when it begins with the app's name
  await expect(page).toHaveTitle(/^QDP – TEST, Loader( · .+)?$/);
  // the installed app's name is short, so the taskbar has room for the patient
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.name).toBe('QDP');
});
