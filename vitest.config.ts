import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/supervisor/**/*.test.ts'],
    exclude: ['test/supervisor/integration/**', 'node_modules/**'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: 'threads',
    coverage: {
      provider: 'v8',
      include: ['src/supervisor/**/*.ts'],
      exclude: ['**/index.ts', '**/*.d.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
