// Mesh editor (Scans panel → Edit mesh…): double-click the part to keep and remove the islands;
// the edit is one step of the app's undo.
import { expect, openDemo, test } from './fixtures';

test('double-click a part, remove the islands, undo in the app', async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  // a scan made of a big box and a small loose one (an island) to its right
  await page.evaluate(() => {
    const pos: number[] = [], idx: number[] = [];
    const cube = (c: number[], h: number) => {
      const o = pos.length / 3;
      for (let i = 0; i < 8; i++) pos.push(c[0] + (i & 1 ? h : -h), c[1] + (i & 2 ? h : -h), c[2] + (i & 4 ? h : -h));
      const f = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5];
      idx.push(...f.map((i) => i + o));
    };
    cube([40, 40, 30], 10);
    cube([70, 40, 30], 2);
    const a = window.app;
    a.scans.push({
      id: 900, name: 'Boxes', kind: 'other', fileName: 'boxes.stl',
      mesh: { pos: Float32Array.from(pos), idx: Uint32Array.from(idx), col: null },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], placement: { method: 'original' },
      color: [200, 200, 210], vertexColors: false, opacity: 1, visible: true,
    });
    a.activeScanId = 900;
    a.changed();
  });
  await page.click('[data-panel="scans"]');
  await page.click('#btn-scan-mesh');
  const ed = page.locator('.mesh-editor');
  await expect(ed).toBeVisible();
  await expect(ed.locator('.me-parts')).toContainText('2 parts');
  await expect(ed.locator('.me-del')).toBeDisabled(); // nothing selected yet
  // the big box: left of the middle (the view is framed on both boxes)
  const box = (await ed.locator('.mv').boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2 - box.height * 0.19, box.y + box.height / 2);
  await expect(ed.locator('.me-parts')).toContainText('One selected');
  await ed.locator('.me-keep').click();
  await expect(ed.locator('.me-parts')).toContainText('One part');
  await expect(ed.locator('.me-stats')).toHaveText('12 triangles');
  await ed.locator('.me-ok').click();
  await expect(ed).toBeHidden();
  expect(await page.evaluate(() => window.app.scans.find((s: { id: number }) => s.id === 900)!.mesh.idx.length / 3)).toBe(12);
  await expect(page.locator('#scan-info')).toContainText('12 triangles');
  // the edit is undone like any other
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.app.scans.find((s: { id: number }) => s.id === 900)!.mesh.idx.length / 3)).toBe(24);
});
