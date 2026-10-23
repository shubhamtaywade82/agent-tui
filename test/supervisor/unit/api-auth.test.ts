/**
 * Supervisor HTTP API auth and CORS. Uses Fastify inject, so no port, database
 * or model backend is needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../../src/supervisor/api/server.js';
import { resolveBearerToken } from '../../../src/utils/auth.js';

const KEY = 'supervisor-test-key-0123456789';
const ALLOWED = 'https://dashboard.example';

type App = Awaited<ReturnType<typeof createServer>>;

describe('supervisor API: bearer auth', () => {
  let app: App;

  beforeAll(async () => {
    // Routes only touch these when a handler runs; the auth tests stop before that.
    app = await createServer({
      supervisor: {} as never,
      store: {} as never,
      apiKey: KEY,
      corsOrigins: [],
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('rejects a protected route without a token, with a Bearer challenge', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/metrics' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Bearer');
    expect(r.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a wrong token of the same length', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      headers: { authorization: `Bearer ${'x'.repeat(KEY.length)}` },
    });
    expect(r.statusCode).toBe(401);
  });

  it('lets a valid token through to the route', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(r.statusCode).not.toBe(401);
  });

  it('keeps the liveness probe and the OpenAPI docs reachable without a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).not.toBe(401);
  });

  it('does not treat a lookalike path as public', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/healthz-admin' });
    expect(r.statusCode).toBe(401);
  });
});

describe('supervisor API: CORS', () => {
  it('sends no CORS headers when no origin is allowlisted', async () => {
    const app = await createServer({
      supervisor: {} as never,
      store: {} as never,
      apiKey: KEY,
      corsOrigins: [],
    });
    await app.ready();
    const r = await app.inject({
      method: 'OPTIONS',
      url: '/v1/runs',
      headers: { origin: ALLOWED, 'access-control-request-method': 'POST' },
    });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('echoes only allowlisted origins', async () => {
    const app = await createServer({
      supervisor: {} as never,
      store: {} as never,
      apiKey: KEY,
      corsOrigins: [ALLOWED],
    });
    await app.ready();
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/v1/runs',
      headers: { origin: ALLOWED, 'access-control-request-method': 'POST' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED);
    const other = await app.inject({
      method: 'OPTIONS',
      url: '/v1/runs',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});

describe('supervisor API: startup token rules', () => {
  it('refuses a non-loopback bind without a configured key', () => {
    expect(() => resolveBearerToken({ host: '0.0.0.0', envName: 'SUPERVISOR_API_KEY' })).toThrow(
      /SUPERVISOR_API_KEY/,
    );
  });

  it('generates a token for loopback when none is configured', () => {
    const t = resolveBearerToken({ host: '127.0.0.1', envName: 'SUPERVISOR_API_KEY' });
    expect(t.generated).toBe(true);
    expect(t.token.length).toBeGreaterThanOrEqual(32);
  });
});
