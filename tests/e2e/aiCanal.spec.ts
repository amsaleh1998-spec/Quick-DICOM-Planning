// After the automatic segmentation the mandibular canals become nerve paths (one per side) and the
// canal segment is removed; undo takes the whole result back in one step.
import { expect, openDemo, test } from './fixtures';

test('the segmented canals become nerve paths, and the canal segment goes', async ({ page }) => {
  await openDemo(page);
  const r = await page.evaluate(async () => {
    const a = window.app;
    type N = { side: string; pts: unknown[] };
    const traced = () => (a.nerves as N[]).filter((v) => v.pts.length >= 2);
    const g = a.seg;
    const n = g.nx * g.ny * g.nz;
    const cls = new Uint8Array(n);
    const counts = new Array(6).fill(0);
    // a mandible block, and a canal tube on each side (Ø 3 mm, 40 mm apart, front to back)
    const cx = a.vol.extent[0] / 2, cz = a.vol.extent[2] * 0.35;
    for (let k = 0, idx = 0; k < g.nz; k++)
      for (let j = 0; j < g.ny; j++)
        for (let i = 0; i < g.nx; i++, idx++) {
          const x = i * g.gs[0], y = j * g.gs[1], z = k * g.gs[2];
          if (y < a.vol.extent[1] * 0.25 || y > a.vol.extent[1] * 0.75) continue;
          const tube = Math.min(Math.hypot(x - (cx - 20), z - cz), Math.hypot(x - (cx + 20), z - cz)) <= 1.5;
          if (tube) cls[idx] = 5;
          else if (Math.abs(z - cz) < 6 && Math.abs(x - cx) < 28) cls[idx] = 2;
          counts[cls[idx]]++;
        }
    const nerves = await new Promise<string[]>((done) =>
      a.applyAiSegmentation({ cls, margin: new Uint8Array(n).fill(200), counts }, 'test', null, (s: string[]) => done(s)),
    );
    await new Promise((res) => setTimeout(res, 300));
    a.commitHistory();
    const after = {
      nerves: nerves.sort(),
      traced: traced().map((v) => v.side).sort(),
      segments: (g.segments as { ai?: { cls: number } }[]).map((s) => s.ai?.cls),
    };
    a.undo();
    const undone = { segments: g.segments.length, nerves: traced().length };
    a.redo();
    return { after, undone, redone: [g.segments.length, traced().length] };
  });
  expect(r.after).toEqual({ nerves: ['left', 'right'], traced: ['left', 'right'], segments: [2] });
  expect(r.undone).toEqual({ segments: 0, nerves: 0 });
  expect(r.redone).toEqual([1, 2]);
});
