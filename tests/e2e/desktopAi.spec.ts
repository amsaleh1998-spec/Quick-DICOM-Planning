// The desktop AI service, as the app sees it: a stand-in service on 127.0.0.1:47423 (the real one
// runs nnU-Net; here every voxel above 500 HU becomes "mandible") – found or not in the dialog,
// the scan sent in SimpleITK order, the labels back as AI segments.
import { createServer, type Server } from 'node:http';
import { dicomFiles, expect, test } from './fixtures';

let server: Server | null = null;
const seen: { dims?: number[]; spacing?: number[]; origin?: string } = {};

function startService(status: Record<string, unknown> = {}, startingCalls = 0) {
  let calls = 0;
  const jobs = new Map<string, Buffer>();
  server = createServer((req, res) => {
    const origin = req.headers.origin ?? '';
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, X-QDP-Dims, X-QDP-Spacing, X-QDP-Mirroring', 'Access-Control-Allow-Methods': 'GET, POST, DELETE' };
    const json = (o: unknown) => {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.url === '/status')
      return json({ service: 'qdp-ai', version: '1.0.0', model: 'test', modelFound: true, device: 'cuda', gpu: 'Test GPU', busy: false, loadError: null, ...status, ...(calls++ < startingCalls ? { device: 'starting' } : {}) });
    if (req.url === '/segment' && req.method === 'POST') {
      const dims = String(req.headers['x-qdp-dims']).split(',').map(Number);
      seen.dims = dims;
      seen.spacing = String(req.headers['x-qdp-spacing']).split(',').map(Number);
      seen.origin = origin;
      const parts: Buffer[] = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => {
        const body = Buffer.concat(parts);
        const n = body.length / 2;
        const out = Buffer.alloc(2 * n);
        for (let i = 0; i < n; i++) {
          const v = body.readInt16LE(2 * i);
          out[i] = v > 500 ? 2 : 0;
          out[n + i] = 120;
        }
        jobs.set('a'.repeat(32), out);
        json({ job: 'a'.repeat(32) });
      });
      return;
    }
    const m = req.url?.match(/^\/jobs\/(\w+)(\/result)?$/);
    if (m && jobs.has(m[1])) {
      if (!m[2]) return json({ state: 'done', phase: 'Finishing…', done: 4, total: 4, message: '', seconds: 1 });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream' });
      return res.end(jobs.get(m[1]));
    }
    res.writeHead(404, cors);
    res.end();
  });
  return new Promise<void>((ok) => server!.listen(47423, '127.0.0.1', () => ok()));
}

test.afterEach(async () => {
  await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
  server = null;
});

test('desktop AI service: not running, then found, then it segments', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('./');
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  await page.evaluate(() => document.getElementById('btn-ai-seg')!.click());
  const dlg = page.locator('.ai-seg');
  await expect(dlg).toBeVisible();
  // the browser is the default; the desktop service when chosen – not running yet
  await expect(dlg.locator('input[name="ai-engine"][value="browser"]')).toBeChecked();
  await dlg.locator('input[name="ai-engine"][value="desktop"]').check();
  await expect(dlg.locator('#ai-desktop')).toContainText('not running', { timeout: 10_000 });
  await expect(dlg.locator('#ai-desktop a')).toHaveAttribute('href', /windows\/Install-QDP-AI\.cmd$/);
  await expect(dlg.locator('#ai-go')).toBeDisabled();
  await expect(dlg.locator('.ai-browser-only').first()).toBeHidden(); // no quality choice: always the official settings
  await expect(dlg.locator('#ai-gpu')).toBeHidden(); // the browser's graphics card does not matter here
  // started: found
  await startService();
  await dlg.locator('.ai-recheck').click();
  await expect(dlg.locator('#ai-desktop')).toContainText('Connected – desktop AI service 1.0.0 on Test GPU');
  await expect(dlg.locator('#ai-go')).toBeEnabled();
  await dlg.locator('#ai-go').click();
  await expect(page.locator('#status-msg')).toContainText('full model, desktop AI service', { timeout: 60_000 });
  // the scan went in SimpleITK order (z, y, x) from the app's page
  const vol = await page.evaluate(() => [window.app.vol!.nx, window.app.vol!.ny, window.app.vol!.nz]);
  expect(seen.origin).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
  expect(seen.dims!.reduce((a, b) => a * b)).toBeGreaterThan(0.8 * vol[0] * vol[1] * vol[2]);
  // the result: an AI "Mandible" segment where the bone is
  const segs = await page.evaluate(() => window.app.seg.segments.filter((g: { ai?: unknown }) => g.ai).map((g: { name: string }) => g.name));
  expect(segs).toContain('Mandible');
  // the choice is remembered
  expect(await page.evaluate(() => localStorage.getItem('qdp.aiEngine'))).toBe('desktop');
});

test('desktop AI service: a graphics card PyTorch cannot run on is reported, with the fix', async ({ page }) => {
  await startService({ device: 'cpu', gpu: 'NVIDIA GeForce RTX 5070', gpuError: 'AcceleratorError: CUDA error: no kernel image is available for execution on the device' });
  await page.goto('./');
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  await page.evaluate(() => document.getElementById('btn-ai-seg')!.click());
  const dlg = page.locator('.ai-seg');
  await dlg.locator('input[name="ai-engine"][value="desktop"]').check();
  const desk = dlg.locator('#ai-desktop');
  await expect(desk).toContainText('the graphics card NVIDIA GeForce RTX 5070 cannot run the model');
  await expect(desk).toContainText('no kernel image');
  await expect(desk).toContainText('Run the installer again');
  await expect(desk.locator('a')).toHaveAttribute('href', /Install-QDP-AI\.cmd$/);
  await expect(dlg.locator('#ai-go')).toBeEnabled(); // it still works, on the CPU
});

test('desktop AI service: just started (after logging in), the dialog waits for it', async ({ page }) => {
  await startService({}, 2); // the first two answers: still loading PyTorch
  await page.goto('./');
  await page.setInputFiles('#file-input', dicomFiles());
  await page.waitForFunction(() => !!window.app.vol);
  await page.evaluate(() => document.getElementById('btn-ai-seg')!.click());
  const dlg = page.locator('.ai-seg');
  await dlg.locator('input[name="ai-engine"][value="desktop"]').check();
  await expect(dlg.locator('#ai-desktop')).toContainText('is starting');
  await expect(dlg.locator('#ai-go')).toBeDisabled();
  await expect(dlg.locator('#ai-desktop')).toContainText('Connected – desktop AI service 1.0.0 on Test GPU', { timeout: 15_000 });
  await expect(dlg.locator('#ai-go')).toBeEnabled();
});
