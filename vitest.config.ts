import { defineConfig } from 'vitest/config';

// Unit tests (node): geometry, DICOM loading, coordinates, registration, meshes, segmentation
// engine, undo history. The browser tests are in tests/e2e (Playwright, see playwright.config.ts).
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
