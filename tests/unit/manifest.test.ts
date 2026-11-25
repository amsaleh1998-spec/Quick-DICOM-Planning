// The installed app registers itself for DICOM files and for .qdp projects (Windows / macOS "Open with").
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8')) as {
  file_handlers: { action: string; accept: Record<string, string[]> }[];
};
const exts = manifest.file_handlers.flatMap((h) => Object.values(h.accept).flat());

describe('manifest file handlers', () => {
  it('opens DICOM files and .qdp projects', () => {
    expect(exts).toEqual(expect.arrayContaining(['.dcm', '.dicom', '.dic', '.ima', '.qdp']));
    for (const h of manifest.file_handlers) expect(h.action).toBe('./');
  });
});
