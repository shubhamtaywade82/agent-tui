/**
 * Supervisor CLI client — verifies the HTTP client used by
 * `agent-tui supervisor <sub>` and the TUI SupervisorPanel.
 *
 * Uses a stubbed fetch to verify: URL construction, auth header
 * injection, timeout handling, connection-refused error mapping, and
 * the list-truncation behaviour. No real supervisor needed.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stash env so each test starts from a clean slate.
const ENV_KEYS = ['SUPERVISOR_HTTP_HOST', 'SUPERVISOR_HTTP_PORT', 'SUPERVISOR_API_KEY'];
const ENV_STASH: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ENV_STASH[k] = process.env[k];

async function loadClient() {
  // Fresh module import so env-var changes take effect (config is read at
  // module load).
  const mod = await import('../src/cli-supervisor.js');
  return mod;
}

function resetEnv() {
  for (const k of ENV_KEYS) {
    if (ENV_STASH[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_STASH[k];
  }
}

describe('supervisor CLI client', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('builds the base URL from SUPERVISOR_HTTP_HOST/PORT with defaults', async () => {
    const mod = await loadClient();
    assert.equal(mod.supervisorBaseUrl(), 'http://127.0.0.1:7480');
  });

  it('honours custom host + port', async () => {
    process.env.SUPERVISOR_HTTP_HOST = 'sup.example.internal';
    process.env.SUPERVISOR_HTTP_PORT = '9999';
    const mod = await loadClient();
    assert.equal(mod.supervisorBaseUrl(), 'http://sup.example.internal:9999');
  });

  it('sends the bearer token when SUPERVISOR_API_KEY is set', async () => {
    process.env.SUPERVISOR_API_KEY = 'test-token-abc123';
    const mod = await loadClient();
    let gotHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: any, init?: any) => {
      // The client passes an init object with headers.
      gotHeaders = { ...(init?.headers ?? {}) };
      return new Response(JSON.stringify({ ok: true, ts: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await mod.getHealth();
    assert.equal(gotHeaders.authorization, 'Bearer test-token-abc123');
  });

  it('omits the auth header when no API key is set (loopback mode)', async () => {
    const mod = await loadClient();
    let sawAuth = false;
    globalThis.fetch = (async (_url: any, init?: any) => {
      if (init?.headers?.authorization) sawAuth = true;
      return new Response(JSON.stringify({ ok: true, ts: 'x' }), { status: 200 });
    }) as unknown as typeof fetch;

    await mod.getHealth();
    assert.equal(sawAuth, false);
  });

  it('throws a clear error on connection refused (supervisor not running)', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const mod = await loadClient();

    const err = (await mod.getHealth().catch((e) => e)) as Error;
    assert.ok(err.message.includes('cannot reach supervisor'), `got: ${err.message}`);
    assert.ok(err.message.includes('supervisor:serve'), `got: ${err.message}`);
  });

  it('throws a clear error on timeout', async () => {
    globalThis.fetch = (async (_input: any, init?: any) => {
      // Simulate an abort from the AbortController the client wires up.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }) as unknown as typeof fetch;
    const mod = await loadClient();

    const err = (await mod.getHealth().catch((e) => e)) as Error;
    assert.ok(err.message.includes('timed out'), `got: ${err.message}`);
  });

  it('includes the HTTP status and body in the error for a non-2xx response', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const mod = await loadClient();

    const err = (await mod.getHealth().catch((e) => e)) as Error;
    assert.ok(err.message.includes('HTTP 401'), `got: ${err.message}`);
    assert.ok(err.message.includes('unauthorized'), `got: ${err.message}`);
  });

  it('listRuns truncates to the requested limit locally', async () => {
    const all = Array.from({ length: 50 }, (_, i) => ({
      runId: `run-${i}`,
      status: 'COMPLETED',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ runs: all }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const mod = await loadClient();

    const { runs } = await mod.listRuns(5);
    assert.equal(runs.length, 5);
    assert.equal(runs[0]?.runId, 'run-0');
  });

  it('listRuns tolerates a missing runs array in the response', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const mod = await loadClient();

    const { runs } = await mod.listRuns(20);
    assert.deepEqual(runs, []);
  });
});

// Restore env when the process exits (node:test doesn't call beforeEach teardown).
process.on('exit', resetEnv);
