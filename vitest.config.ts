import { defineConfig } from 'vitest/config';

// The supervisor's integration suite needs a real Postgres, so it is
// excluded from the default run unless TEST_DATABASE_URL is provided
// (CI sets it there). The system-one-harness integration suite needs a
// real `ollama serve` daemon, so it is excluded unless
// OLLAMA_INTEGRATION=1 is set.
const supervisorIntegrationExclude = process.env['TEST_DATABASE_URL']
  ? []
  : ['test/supervisor/integration/**'];
const systemOneIntegrationExclude =
  process.env['OLLAMA_INTEGRATION'] === '1' ? [] : ['test/system-one-harness/integration/**'];

export default defineConfig({
  test: {
    include: ['test/supervisor/**/*.test.ts', 'test/system-one-harness/**/*.test.ts'],
    exclude: [...supervisorIntegrationExclude, ...systemOneIntegrationExclude, 'node_modules/**'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: 'threads',
    coverage: {
      provider: 'v8',
      include: ['src/supervisor/**/*.ts', 'src/system-one-harness/**/*.ts'],
      exclude: ['**/index.ts', '**/*.d.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
