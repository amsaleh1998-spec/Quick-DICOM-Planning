import { defineConfig } from '@playwright/test';

// Browser tests of the built app (npm run build first): npm run test:e2e
// The service worker is blocked so the tests can serve their own files and nothing is cached.
const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: CI ? 2 : 3,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:4173/',
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'only-on-failure',
    browserName: 'chromium',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/',
    reuseExistingServer: !CI,
    timeout: 60_000,
  },
});
