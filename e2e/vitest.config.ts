import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'integration',
    include: ['integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['integration/global-setup.ts'],
    // All files share one dev node; run them one after another.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
