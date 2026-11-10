// A click outside every implant deselects the selected one (a few pixels of wobble included, and
// with the Waxup panel open); a click on an implant selects it, and drags (orbiting the 3D view)
// or clicks with a tool in use keep the selection; a panel's tools stop when another panel is
// shown; a click on an implant shows the Implants panel.
import { type Page } from '@playwright/test';
import { clickView, expect, inView, openDemo, test } from './fixtures';

const selected = (page: Page) => page.evaluate(() => window.app.selectedId as number | null);
/** Screen point of the selected implant's centre in a view. */
async function onImplant(page: Page, view: string): Promise<[number, number]> {
  return page.evaluate((view) => {
    const a = window.app;
    const v = view.split('.').reduce((o: any, k: string) => o[k], a);
    const s = v.screenPoint(a.selectedImplant().center);
    const b = v.el.getBoundingClientRect();
    return [b.x + s[0], b.y + s[1]] as [number, number];
  }, view);
}

test('a click outside every implant deselects it', async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('Enter');
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', 0.4, 0.55);
  const id = await selected(page);
  expect(id).not.toBeNull();

  // a click on the implant keeps it selected
  const [ix, iy] = await onImplant(page, 'crossViews.1');
  await page.mouse.click(ix, iy);
  expect(await selected(page)).toBe(id);

  // orbiting the 3D view (a drag) keeps it
  const [x0, y0] = await inView(page, 'view3d', 0.2, 0.2);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 60, y0 + 20, { steps: 5 });
  await page.mouse.up();
  expect(await selected(page)).toBe(id);

  // a click with the ruler keeps it
  await page.keyboard.press('r');
  await clickView(page, 'crossViews.1', 0.1, 0.1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('r');
  expect(await selected(page)).toBe(id);
  await page.evaluate(() => { window.app.ruler = false; window.app.pendingMeasurement = null; });

  // a click on nothing (here: the corner of a cross-section) deselects
  await clickView(page, 'crossViews.1', 0.08, 0.92);
  expect(await selected(page)).toBeNull();

  // a click on the implant in the panoramic selects it again; a click beside it in 3D deselects
  const [px, py] = await (async () => {
    await page.evaluate((id) => window.app.selectImplant(id, true), id);
    const p = await onImplant(page, 'pano');
    await page.evaluate(() => window.app.selectImplant(null, false));
    return p;
  })();
  await page.mouse.click(px, py);
  expect(await selected(page)).toBe(id);
  await clickView(page, 'view3d', 0.08, 0.5);
  expect(await selected(page)).toBeNull();

  // a click whose hand moves a few pixels is still a click
  await page.evaluate((id) => window.app.selectImplant(id, true), id);
  const [wx, wy] = await inView(page, 'crossViews.0', 0.1, 0.9);
  await page.mouse.move(wx, wy);
  await page.mouse.down();
  await page.mouse.move(wx + 3, wy + 3);
  await page.mouse.up();
  expect(await selected(page)).toBeNull();

  // with the Waxup panel open too
  await page.click('[data-panel="waxup"]');
  await page.evaluate((id) => window.app.selectImplant(id, true), id);
  await clickView(page, 'view3d', 0.06, 0.5);
  expect(await selected(page)).toBeNull();

  // a segment pick left on in the Segments panel stops when another panel is shown – it no longer
  // takes the clicks (and keeps a click outside from deselecting)
  await page.click('[data-panel="segments"]');
  await page.click('[data-seg-preset="0"]');
  expect(await page.evaluate(() => window.app.segTool)).toBe('grow');
  await page.click('[data-panel="implants"]');
  expect(await page.evaluate(() => window.app.segTool)).toBeNull();
  await page.evaluate((id) => window.app.selectImplant(id, true), id);
  await clickView(page, 'crossViews.1', 0.08, 0.92);
  expect(await selected(page)).toBeNull();

  // a click on an implant from another panel shows the Implants panel with it
  await page.click('[data-panel="segments"]');
  await expect(page.locator('#panel-plan')).toBeHidden();
  await page.evaluate((id) => window.app.selectImplant(id, true), id);
  const [qx, qy] = await onImplant(page, 'pano');
  await page.evaluate(() => window.app.selectImplant(null, false));
  await page.mouse.click(qx, qy);
  expect(await selected(page)).toBe(id);
  await expect(page.locator('#panel-plan')).toBeVisible();
  await expect(page.locator('#implant-edit')).toBeVisible();
});

test('any click or tap off the implant in the 3D view or a cross-section deselects it (mouse, pen, touch)', async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) {
    await clickView(page, 'planAxial', x, y);
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('Enter');
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', 0.4, 0.55);
  const id = await selected(page);
  const spots: [string, number, number][] = [
    ['view3d', 0.5, 0.15], ['view3d', 0.5, 0.5], ['view3d', 0.15, 0.85], ['view3d', 0.85, 0.5],
    ['crossViews.0', 0.5, 0.2], ['crossViews.1', 0.3, 0.5], ['crossViews.1', 0.8, 0.85], ['crossViews.2', 0.15, 0.6], ['tang', 0.2, 0.3],
  ];
  // a pointer of each kind, sent as the browser would (down, a little wobble, up)
  const press = (view: string, fx: number, fy: number, pointerType: string) =>
    page.evaluate(
      ([view, fx, fy, pointerType]) => {
        const v = (view as string).split('.').reduce((o: any, k: string) => o[k], window.app);
        const c = v.ovCanvas as HTMLCanvasElement, r = c.getBoundingClientRect();
        const x = r.x + r.width * (fx as number), y = r.y + r.height * (fy as number);
        const ev = (type: string, dx: number) =>
          c.dispatchEvent(new PointerEvent(type, { clientX: x + dx, clientY: y, pointerId: 1, pointerType: pointerType as string, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true }));
        ev('pointerdown', 0);
        ev('pointermove', 2);
        ev('pointerup', 2);
      },
      [view, fx, fy, pointerType] as const,
    );
  for (const touchUi of [false, true]) {
    await page.evaluate((t) => (window.app.touchUi = t), touchUi);
    for (const kind of touchUi ? ['touch', 'pen'] : ['mouse', 'pen']) {
      for (const [v, fx, fy] of spots) {
        await page.evaluate((id) => window.app.selectImplant(id, true), id);
        await press(v, fx, fy, kind);
        expect(await selected(page), `${kind} on ${v} at ${fx},${fy}${touchUi ? ' (touch interface)' : ''}`).toBeNull();
      }
    }
  }
  // curve drawing left on (it takes clicks in the axial view only) does not stop it elsewhere
  await page.evaluate(() => (window.app.touchUi = false));
  await page.evaluate(() => window.app.startDrawing());
  for (const [v, fx, fy] of [['view3d', 0.5, 0.15], ['crossViews.1', 0.3, 0.5]] as const) {
    await page.evaluate((id) => window.app.selectImplant(id, true), id);
    await clickView(page, v, fx, fy);
    expect(await selected(page), `click on ${v} while drawing a curve`).toBeNull();
  }
  await page.evaluate(() => window.app.cancelDrawing());
  // real mouse clicks too
  for (const [v, fx, fy] of spots) {
    await page.evaluate((id) => window.app.selectImplant(id, true), id);
    await clickView(page, v, fx, fy);
    expect(await selected(page), `click on ${v} at ${fx},${fy}`).toBeNull();
  }
});
