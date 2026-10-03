import { defineConfig } from '@playwright/test';

/**
 * The live deployment from a user's side (npm run test:live): https://occulta.space on Arbitrum
 * Sepolia with the live relayer and libp2p relay. Slower than the dev chain: a public RPC and real blocks.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 20 * 60_000,
  expect: { timeout: 180_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report/live' }]],
  outputDir: '../../test-results/live',
  use: {
    baseURL: process.env.OCCULTA_LIVE_URL ?? 'https://occulta.space',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
});
