import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'circuits',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Witness generation and Groth16 proving are CPU-heavy; run files one after another.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
