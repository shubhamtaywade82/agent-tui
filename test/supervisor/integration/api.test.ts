/**
 * Integration test: full HTTP roundtrip against a real Postgres.
 *
 * Skipped unless `TEST_DATABASE_URL` is set. Run with:
 *   docker compose --profile test up -d
 *   TEST_DATABASE_URL=postgres://supervisor:supervisor@localhost:55432/supervisor_test \
 *     npx vitest run test/supervisor/integration/api.test.ts
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../../src/supervisor/api/server.js';
import { Supervisor } from '../../../src/supervisor/engine.js';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import { PgStateStore } from '../../../src/supervisor/state/store.js';

const SKIP = !process.env.TEST_DATABASE_URL && !process.env.CI;

describe.skipIf(SKIP)('Supervisor HTTP API (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let store: PgStateStore;
  let supervisor: Supervisor;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (url) {
      store = new PgStateStore(url);
    } else {
      container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
        .withUsername('supervisor')
        .withPassword('supervisor')
        .withDatabase('supervisor_test')
        .start();
      store = new PgStateStore(container.getConnectionUri());
    }
    await store.init();

    const backend = new MockBackend();
    // Queue enough responses for all test cases (5 POST /v1/runs calls)
    for (let i = 0; i < 6; i++) {
      backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
      backend.enqueue('minicpm5-analyst', () => 'Integration answer.');
    }

    supervisor = new Supervisor({ backend, store });
    app = await createServer({ supervisor, store });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (store) await store.close();
    if (container) await container.stop();
  });

  it('POST /v1/runs kicks off and completes a run', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      payload: { objective: 'Hello, integration world.' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { runId: string; status: string };
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.status).toBe('COMPLETED');
  });

  it('GET /v1/runs/:id returns the run', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      payload: { objective: 'Second run.' },
    });
    const { runId } = post.json() as { runId: string };
    const r = await app.inject({ method: 'GET', url: `/v1/runs/${runId}` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { runId: string };
    expect(body.runId).toBe(runId);
  });

  it('GET /v1/runs/:id/events returns persisted events', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      payload: { objective: 'Eventful run.' },
    });
    const { runId } = post.json() as { runId: string };
    const r = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/events` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { events: { type: string }[] };
    const types = body.events.map((e) => e.type);
    expect(types).toContain('run_created');
    expect(types).toContain('run_completed');
  });

  it('GET /v1/metrics returns non-zero counts after a run', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/metrics' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { runsTotal: number };
    expect(body.runsTotal).toBeGreaterThan(0);
  });

  it('GET /v1/healthz returns ok', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/healthz' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
