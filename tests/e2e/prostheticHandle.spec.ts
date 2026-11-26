// The top of the prosthetic axis is a handle: dragging it tilts the implant around its apex (the
// coronal part moves), in any view – also for an implant that was not selected.
import { clickView, expect, openDemo, test } from './fixtures';

test('dragging the top of the prosthetic axis moves the coronal part of the implant', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) await clickView(page, 'planAxial', x, y);
  await page.keyboard.press('Enter');
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', 0.4, 0.6);
  await expect.poll(() => page.evaluate(() => window.app.implants.length)).toBe(1);
  // its prosthetic axis on; nothing selected
  await page.evaluate(() => {
    const a = window.app;
    a.implants[0].showProstheticAxis = true;
    a.selectImplant(null, false);
  });
  const before = await page.evaluate(() => {
    const a = window.app;
    const imp = a.implants[0];
    const L = imp.length / 2;
    const apex = imp.center.map((c: number, k: number) => c + imp.axis[k] * L);
    const plat = imp.center.map((c: number, k: number) => c - imp.axis[k] * L);
    const pv = a.pano;
    const ed = (pv as unknown as { editor: { prostheticTop(i: unknown): number[] } }).editor;
    const top = pv.screenPoint(ed.prostheticTop(imp) as [number, number, number])!;
    const r = pv.el.getBoundingClientRect();
    return { apex, plat, axis: [...imp.axis], x: r.x + top[0], y: r.y + top[1] };
  });
  await page.waitForTimeout(200);
  // drag the top of the guide sideways
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(before.x + i * 6, before.y + i, { steps: 1 });
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const a = window.app;
    const imp = a.implants[0];
    const L = imp.length / 2;
    return {
      apex: imp.center.map((c: number, k: number) => c + imp.axis[k] * L),
      plat: imp.center.map((c: number, k: number) => c - imp.axis[k] * L),
      axis: [...imp.axis],
      selected: a.selectedId === imp.id,
    };
  });
  const angle = (Math.acos(Math.min(1, before.axis.reduce((s: number, v: number, k: number) => s + v * after.axis[k], 0))) * 180) / Math.PI;
  const moved = Math.hypot(...after.plat.map((v: number, k: number) => v - before.plat[k]));
  const apexMoved = Math.hypot(...after.apex.map((v: number, k: number) => v - before.apex[k]));
  expect(angle).toBeGreaterThan(3); // tilted
  expect(moved).toBeGreaterThan(0.5); // the coronal part moved
  expect(apexMoved).toBeLessThan(1e-6); // around the apex
  expect(after.selected).toBe(true); // and selected by the drag
  // undo takes it back in one step
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => [...window.app.implants[0].axis]);
  expect(undone.map((v: number) => v.toFixed(6))).toEqual(before.axis.map((v: number) => v.toFixed(6)));
});

test('in 3D, dragging the prosthetic axis moves the implant (it keeps its direction)', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('2');
  for (const [x, y] of [[0.22, 0.72], [0.27, 0.45], [0.38, 0.3], [0.5, 0.26], [0.62, 0.3], [0.73, 0.45], [0.78, 0.72]]) await clickView(page, 'planAxial', x, y);
  await page.keyboard.press('Enter');
  await page.click('#btn-add-lower');
  await clickView(page, 'pano', 0.4, 0.6);
  await expect.poll(() => page.evaluate(() => window.app.implants.length)).toBe(1);
  // shown from the placement; nothing selected (no rotation handles); the 3D view large, from the front
  expect(await page.evaluate(() => window.app.implants[0].showProstheticAxis)).toBe(true);
  await page.evaluate(() => {
    const a = window.app;
    a.selectImplant(null, false);
    if (!a.view3d.el.classList.contains('max')) a.toggleMaximize(a.view3d, false);
    a.view3d.setPreset('front');
    a.changed();
  });
  await page.waitForTimeout(500);
  // a point halfway up the axis (8 mm above the platform), well away from the body and the top ring
  const before = await page.evaluate(() => {
    const a = window.app;
    const imp = a.implants[0];
    const up = imp.axis.map((v: number) => -v);
    const plat = imp.center.map((c: number, k: number) => c - imp.axis[k] * (imp.length / 2));
    const mid = plat.map((c: number, k: number) => c + up[k] * 8);
    const s = (a.view3d as unknown as { projectPoint(w: number[]): number[] }).projectPoint(mid);
    const r = a.view3d.el.getBoundingClientRect();
    return { center: [...imp.center], axis: [...imp.axis], x: r.x + s[0], y: r.y + s[1] };
  });
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(before.x + i * 5, before.y, { steps: 1 });
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const a = window.app;
    const imp = a.implants[0];
    return { center: [...imp.center], axis: [...imp.axis], selected: a.selectedId === imp.id, orbit: [...a.view3d.fwd] };
  });
  expect(Math.hypot(...after.center.map((v: number, k: number) => v - before.center[k]))).toBeGreaterThan(1); // moved
  after.axis.forEach((v: number, k: number) => expect(v).toBeCloseTo(before.axis[k], 6)); // not tilted
  expect(after.selected).toBe(true);
  // undo takes it back in one step
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => [...window.app.implants[0].center]);
  undone.forEach((v: number, k: number) => expect(v).toBeCloseTo(before.center[k], 6));
});
