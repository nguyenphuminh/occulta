import { defineConfig } from '@playwright/test';

/** UI tests of the wallet website against the dev node, with the desktop client as relayer and libp2p relay. */
export default defineConfig({
  testDir: './ui',
  testMatch: '**/*.spec.ts',
  globalSetup: './ui/global-setup.ts',
  // One dev node and one relayer: run the specs one after another.
  workers: 1,
  fullyParallel: false,
  timeout: 300_000,
  expect: { timeout: 60_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  outputDir: '../test-results',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
});
