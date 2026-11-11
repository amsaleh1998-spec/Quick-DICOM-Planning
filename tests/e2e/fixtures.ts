// Shared helpers of the browser tests: generated test files, a page that fails the test on any
// script error, and small helpers to reach the app state.
import { test as base, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestSeries } from '../../scripts/make-test-dicom.mjs';
import { makeTestImplantLibrary } from '../../scripts/make-test-implant-library.mjs';
import { stlBytes, tubeMesh } from '../../src/stl';
import type { Vec3 } from '../../src/math';

const dir = join(tmpdir(), `qdp-e2e-${process.pid}`);

/** The synthetic DICOM series (50 slices, made-up patient TEST^Loader) as files on disk. */
export function dicomFiles(): string[] {
  const d = join(dir, 'dicom');
  mkdirSync(d, { recursive: true });
  return makeTestSeries().map((f) => {
    const p = join(d, f.name);
    writeFileSync(p, f.data);
    return p;
  });
}

/** The made-up implant library (brand Testco) as a .qdplib file on disk. */
export function implantLibraryFile(library = 1): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `testco-implant-library-v${library}.qdplib`);
  writeFileSync(p, makeTestImplantLibrary({ library }));
  return p;
}

/** Import the test implant library (kept in the browser for the rest of the test). */
export async function importTestLibrary(page: Page, library = 1) {
  await page.setInputFiles('#lib-input', implantLibraryFile(library));
  await page.waitForFunction((v) => !!document.getElementById('lib-status')?.textContent?.includes(`Version ${v} · imported`), library);
}

/** A small arch-shaped surface (a tube along a U) as an STL file, like an intraoral scan. */
export function archStl(name = 'upper-arch.stl'): string {
  mkdirSync(dir, { recursive: true });
  const path: Vec3[] = [];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const a = Math.PI * (1 - t);
    path.push([25 * Math.cos(a), 20 * Math.sin(a), 2 * Math.sin(3 * a)]);
  }
  const p = join(dir, name);
  writeFileSync(p, stlBytes(tubeMesh(path, 3, 16), 'arch'));
  return p;
}

declare global {
  interface Window {
    // the app instance (exposed by the page for tests and debugging)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app: any;
  }
}

export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => void d.accept());
      await use(errors);
      expect(errors, 'no script errors in the page').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** Point at a fraction of a view: `view` is a property path of the app, e.g. 'planAxial' or 'crossViews.1'. */
export async function inView(page: Page, view: string, fx: number, fy: number): Promise<[number, number]> {
  const r = await page.evaluate((path) => {
    const v = path.split('.').reduce((o, k) => o[k], window.app);
    const b = (v.el as HTMLElement).getBoundingClientRect();
    return [b.x, b.y, b.width, b.height];
  }, view);
  return [r[0] + r[2] * fx, r[1] + r[3] * fy];
}

export async function clickView(page: Page, view: string, fx: number, fy: number) {
  const [x, y] = await inView(page, view, fx, fy);
  await page.mouse.click(x, y);
}

/** Open the demo volume from the start screen. */
export async function openDemo(page: Page) {
  await page.goto('./');
  await page.click('[data-act="demo"]');
  await page.waitForFunction(() => !!window.app.vol);
}
