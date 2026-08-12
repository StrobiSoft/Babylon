import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['backend/test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['backend/src/**/*.ts'],
      exclude: ['backend/src/main.ts', 'backend/src/migrate-cli.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
});
