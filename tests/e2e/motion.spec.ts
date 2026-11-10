// Motion: menus grow from their button and fold back before hiding; a flick keeps the 3D model
// turning until it settles (not after a pause, not with less motion asked for); a view grows
// out of its tile when maximized, evenly, and ends at its real size.
import { type Page } from '@playwright/test';
import { expect, openDemo, test } from './fixtures';

/**
 * A flick at a real mouse's rate (a move every 8 ms), released `pause` ms after the last move. The
 * page's clock is stepped by hand while the events are sent, so a busy test machine cannot slow it.
 */
function flick(page: Page, pause: number) {
  return page.evaluate(
    (pause) =>
      new Promise<boolean>((done) => {
        const v = window.app.view3d, c = v.ovCanvas as HTMLCanvasElement, r = c.getBoundingClientRect();
        const x0 = r.x + r.width / 2 - 60, y = r.y + r.height / 2;
        const realNow = performance.now.bind(performance);
        let t = realNow();
        performance.now = () => t;
        const ev = (type: string, x: number) =>
          c.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true }));
        ev('pointerdown', x0);
        for (let i = 1; i <= 10; i++) {
          t += 8;
          ev('pointermove', x0 + i * 10);
        }
        t += pause;
        ev('pointerup', x0 + 100);
        performance.now = realNow;
        const a = v.fwd.join();
        setTimeout(() => done(v.fwd.join() !== a), 250);
      }),
    pause,
  );
}

for (const reduce of [false, true]) {
  test(`motion${reduce ? ' (reduced)' : ''}: menus, flick, maximize`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
    await openDemo(page);
    await page.keyboard.press('2');
    const menu = () => page.evaluate(() => {
      const e = document.getElementById('pop-export')!;
      const c = getComputedStyle(e);
      return { hidden: e.classList.contains('hidden'), op: +c.opacity, moved: c.transform !== 'none' };
    });

    await page.click('#btn-export-menu');
    await expect.poll(async () => (await menu()).op).toBe(1);
    await page.keyboard.press('Escape');
    const closing = await menu();
    expect(closing.hidden).toBe(false); // folding away first …
    await expect.poll(async () => (await menu()).hidden).toBe(true); // … then hidden

    expect(await flick(page, 5)).toBe(!reduce); // keeps turning after a flick
    await page.waitForTimeout(2500);
    expect(await flick(page, 120)).toBe(false); // not after a pause before letting go

    // maximize and restore: grows evenly (never stretched) and ends at the view's real size
    const view = () =>
      page.evaluate(() => {
        const v = window.app.crossViews[1];
        const m = getComputedStyle(v.el).transform;
        const k = m === 'none' ? [1, 0, 0, 1] : m.slice(7, -1).split(',').map(Number);
        return { moving: m !== 'none', even: Math.abs(k[0] - k[3]) < 1e-3, w: v.w, h: v.h, cw: v.el.clientWidth, ch: v.el.clientHeight, canvas: v.ovCanvas.width, dpr: v.dpr };
      });
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.app.toggleMaximize(window.app.crossViews[1]));
      const mid = await view();
      expect(mid.moving).toBe(!reduce);
      expect(mid.even).toBe(true);
      await expect.poll(async () => (await view()).moving).toBe(false);
      // the size it renders at follows the layout (the resize is reported a frame later)
      await expect.poll(async () => { const e = await view(); return [e.w, e.h, e.canvas]; }).toEqual(await page.evaluate(() => {
        const v = window.app.crossViews[1];
        return [v.el.clientWidth, v.el.clientHeight, Math.round(v.el.clientWidth * v.dpr)];
      }));
    }
  });
}
