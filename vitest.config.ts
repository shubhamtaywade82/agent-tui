import { defineConfig } from 'vitest/config';

// The integration suite needs a real Postgres, so it is excluded from the
// default run unless TEST_DATABASE_URL is provided (CI sets it there).
const integrationExclude = process.env['TEST_DATABASE_URL']
  ? []
  : ['test/supervisor/integration/**'];

export default defineConfig({
  test: {
    include: ['test/supervisor/**/*.test.ts'],
    exclude: [...integrationExclude, 'node_modules/**'],
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
