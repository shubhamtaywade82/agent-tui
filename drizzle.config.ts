import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/supervisor/db/schema.ts',
  out: './supervisor/drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://supervisor:supervisor@localhost:5432/supervisor',
  },
  verbose: true,
  strict: true,
});
