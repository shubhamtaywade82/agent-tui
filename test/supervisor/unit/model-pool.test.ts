/**
 * ModelPool — Phase 2 residency invariants.
 *
 * These tests pin down the contract the wrapping Backend relies on:
 *   - acquire() for an already-resident model is a fast path (no load).
 *   - acquire() for a non-resident model triggers a load.
 *   - At capacity, the LRU non-pinned resident is evicted before load.
 *   - Pinning prevents eviction.
 *   - When every resident is pinned at capacity, acquire() throws
 *     ModelPoolExhaustedError (the pool never silently exceeds the cap).
 *   - Non-allowlisted models pass through acquire() as a no-op.
 *   - Concurrent acquire() calls are serialised by the mutex.
 *
 * All tests use an injected fetch that records /api/ps and /api/generate
 * calls — no real Ollama daemon needed.
 */
import { describe, expect, it } from 'vitest';
import {
  ModelPool,
  ModelPoolExhaustedError,
} from '../../../src/supervisor/inference/model-pool.js';

interface Captured {
  method: string;
  url: string;
  body?: unknown;
}

/** Build a fetch impl that returns a /api/ps response listing `resident`. */
function makeFetch(
  resident: string[],
  captures: Captured[],
): {
  fetch: typeof fetch;
  setResident: (next: string[]) => void;
} {
  let current = [...resident];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    captures.push({ method, url, body });

    if (url.endsWith('/api/ps')) {
      return new Response(
        JSON.stringify({
          models: current.map((name) => ({
            name,
            size: 1024,
            expires_at: new Date(Date.now() + 300_000).toISOString(),
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/api/generate')) {
      // A load or unload request. For tests, treat the body's keep_alive
      // as the trigger: 0 = unload (remove from current), >0 = load (add).
      const b = body as { model?: string; keep_alive?: number } | undefined;
      if (b?.model) {
        if (b.keep_alive === 0) {
          current = current.filter((n) => n !== b.model);
        } else if (!current.includes(b.model)) {
          current.push(b.model);
        }
      }
      return new Response(JSON.stringify({ done: true, response: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, setResident: (next) => (current = [...next]) };
}

describe('ModelPool — residency invariants', () => {
  it('acquire() for an already-resident model is a fast path (no /api/generate call)', async () => {
    const captures: Captured[] = [];
    const { fetch } = makeFetch(['minicpm5-router'], captures);
    const pool = new ModelPool({
      ollamaHost: 'http://test',
      maxResident: 3,
      keepAliveMs: 300_000,
      allowlist: ['minicpm5-router', 'minicpm5-analyst'],
      alwaysRefresh: true,
      fetchImpl: fetch,
    });
    await pool.init();

    const handle = await pool.acquire('minicpm5-router');

    // After acquire(), the only /api/generate calls should be the
    // init-time ones (none — model already resident). The only
    // /api/ps call is the alwaysRefresh poll.
    const generateCalls = captures.filter((c) => c.url.endsWith('/api/generate'));
    expect(generateCalls).toEqual([]);
    expect(pool.snapshot().pinned).toContain('minicpm5-router');

    await handle.release();
    expect(pool.snapshot().pinned).not.toContain('minicpm5-router');
  });

  it('acquire() for a non-resident model triggers a load', async () => {
    const captures: Captured[] = [];
    const { fetch } = makeFetch([], captures);
    const pool = new ModelPool({
      ollamaHost: 'http://test',
      maxResident: 3,
      keepAliveMs: 300_000,
      allowlist: ['minicpm5-router'],
      alwaysRefresh: true,
      fetchImpl: fetch,
    });
    await pool.init();

    const handle = await pool.acquire('minicpm5-router');

    const generateCalls = captures.filter((c) => c.url.endsWith('/api/generate'));
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.body).toMatchObject({ model: 'minicpm5-router', keep_alive: 300_000 });
    expect(pool.snapshot().pinned).toContain('minicpm5-router');

    await handle.release();
  });

  it('evicts the LRU non-pinned resident before loading a fourth model', async () => {
    const captures: Captured[] = [];
    // Three models resident; the pool's maxResident is 3. The fourth
    // acquire() must evict one before loading.
    const { fetch } = makeFetch(
      ['minicpm5-router', 'minicpm5-analyst', 'minicpm5-toolagent'],
      captures,
    );
    const pool = new ModelPool({
      ollamaHost: 'http://test',
      maxResident: 3,
      keepAliveMs: 300_000,
      allowlist: [
        'minicpm5-router',
        'minicpm5-analyst',
        'minicpm5-toolagent',
        'minicpm5-summarizer',
      ],
      alwaysRefresh: true,
      fetchImpl: fetch,
    });
    await pool.init();

    const handle = await pool.acquire('minicpm5-summarizer');

    const generateCalls = captures.filter((c) => c.url.endsWith('/api/generate'));
    // Exactly two /api/generate calls: one unload (keep_alive: 0) and
    // one load (keep_alive: 300_000).
    expect(generateCalls).toHaveLength(2);
    const unloadCall = generateCalls.find(
      (c) => (c.body as { keep_alive?: number }).keep_alive === 0,
    );
    const loadCall = generateCalls.find(
      (c) => (c.body as { keep_alive?: number }).keep_alive === 300_000,
    );
    expect(unloadCall).toBeDefined();
    expect(loadCall).toBeDefined();
    // The loaded model must be the one we asked for.
    expect(loadCall?.body).toMatchObject({ model: 'minicpm5-summarizer' });
    // The evicted model must be one of the original three (LRU by
    // expires_at — all equal here, so any of them).
    const evictedName = (unloadCall?.body as { model?: string } | undefined)?.model;
    expect(['minicpm5-router', 'minicpm5-analyst', 'minicpm5-toolagent']).toContain(evictedName);

    await handle.release();
  });

  it('never evicts a pinned model — prefers an unpinned one', async () => {
    const captures: Captured[] = [];
    const { fetch } = makeFetch(
      ['minicpm5-router', 'minicpm5-analyst', 'minicpm5-toolagent'],
      captures,
    );
    const pool = new ModelPool({
      ollamaHost: 'http://test',
      maxResident: 3,
      keepAliveMs: 300_000,
      allowlist: [
        'minicpm5-router',
        'minicpm5-analyst',
        'minicpm5-toolagent',
        'minicpm5-summarizer',
      ],
      alwaysRefresh: true,
      fetchImpl: fetch,
    });
    await pool.init();

    // Pin minicpm5-router (the LRU by expires_at — all equal here,
    // so it would be the natural eviction target).
    const routerHandle = await pool.acquire('minicpm5-router');

    // Now acquire a fourth model. The pool must NOT evict
    // minicpm5-router; it must pick an unpinned resident.
    const summarizerHandle = await pool.acquire('minicpm5-summarizer');

    const generateCalls = captures.filter((c) => c.url.endsWith('/api/generate'));
    const unloadCall = generateCalls.find(
      (c) => (c.body as { keep_alive?: number }).keep_alive === 0,
    );
    const evictedName = (unloadCall?.body as { model?: string } | undefined)?.model;
    expect(evictedName).not.toBe('minicpm5-router');
    expect(['minicpm5-analyst', 'minicpm5-toolagent']).toContain(evictedName);

    await routerHandle.release();
    await summarizerHandle.release();
  });

  it('throws ModelPoolExhaustedError when every resident is pinned at capacity', async () => {
    const captures: Captured[] = [];
    const { fetch } = makeFetch(
      ['minicpm5-router', 'minicpm5-analyst', 'minicpm5-toolagent'],
      captures,
    );
    const pool = new ModelPool({
      ollamaHost: 'http://test',
      maxResident: 3,
      keepAliveMs: 300_000,
      allowlist: [
        'minicpm5-router',
        'minicpm5-analyst',
        'minicpm5-toolagent',
        'minicpm5-summarizer',
      ],
      alwaysRefresh: true,
      fetchImpl: fetch,
    });
    await pool.init();

    // Pin all three residents.
    const h1 = await pool.acquire('minicpm5-router');
    const h2 = await pool.acquire('minicpm5-analyst');
    const h3 = await pool.acquire('minicpm5-toolagent');

    // Fourth acquire() must throw — no eviction target available.
    await expect(pool.acquire('minicpm5-summarizer')).rejects.toBeInstanceOf(
      ModelPoolExhaustedError,
    );

    await h1.release();
    await h2.release();
    await h3.release();
  });

  it('passes through acquire() for non-allowlisted models (no /api/generate, no pin)', async () => {
    const captures: Captured[] = [];
    const { fetch } = makeFetch([], captures);
    const pool = new ModelPool({
      ollamaHost: 'http://test',
      maxResident: 3,
      keepAliveMs: 300_000,
      allowlist: ['minicpm5-router'],
      alwaysRefresh: true,
      fetchImpl: fetch,
    });
    await pool.init();

    // The cloud fallback model is NOT on the allowlist.
    const handle = await pool.acquire('gpt-4o');

    expect(pool.snapshot().pinned).toEqual([]);
    const generateCalls = captures.filter((c) => c.url.endsWith('/api/generate'));
    expect(generateCalls).toEqual([]);

    await handle.release();
  });

  it('serialises concurrent acquire() calls via the mutex (no race past the cap)', async () => {
    const captures: Captured[] = [];
    // Empty initially; both concurrent acquires will try to load.
    const { fetch } = makeFetch([], captures);
    const pool = new ModelPool({
      ollamaHost: 'http://test',
      maxResident: 2, // tight cap
      keepAliveMs: 300_000,
      allowlist: ['m1', 'm2', 'm3'],
      alwaysRefresh: true,
      fetchImpl: fetch,
    });
    await pool.init();

    // Fire two acquires concurrently. The mutex must serialise them
    // so the second sees the first's load and doesn't double-load.
    const [h1, h2] = await Promise.all([pool.acquire('m1'), pool.acquire('m1')]);

    const generateCalls = captures.filter((c) => c.url.endsWith('/api/generate'));
    // Only one load should have happened (the second acquire saw the
    // model already resident after the mutex released).
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.body).toMatchObject({ model: 'm1' });

    await h1.release();
    await h2.release();
  });

  it('reconcile() refreshes the residency cache from /api/ps', async () => {
    const captures: Captured[] = [];
    const { fetch, setResident } = makeFetch(['m1'], captures);
    const pool = new ModelPool({
      ollamaHost: 'http://test',
      maxResident: 3,
      keepAliveMs: 300_000,
      allowlist: ['m1', 'm2'],
      alwaysRefresh: false, // tests the explicit reconcile path
      fetchImpl: fetch,
    });
    await pool.init();
    expect(pool.snapshot().resident.map((r) => r.name)).toEqual(['m1']);

    // Externally-loaded model. The pool doesn't see it until reconcile.
    setResident(['m1', 'm2']);
    await pool.reconcile();
    expect(
      pool
        .snapshot()
        .resident.map((r) => r.name)
        .sort(),
    ).toEqual(['m1', 'm2']);
  });

  it('init() populates the residency cache and logs the resident set', async () => {
    const captures: Captured[] = [];
    const { fetch } = makeFetch(['m1', 'm2'], captures);
    const pool = new ModelPool({
      ollamaHost: 'http://test',
      maxResident: 3,
      keepAliveMs: 300_000,
      allowlist: ['m1', 'm2'],
      alwaysRefresh: false,
      fetchImpl: fetch,
    });
    await pool.init();
    expect(
      pool
        .snapshot()
        .resident.map((r) => r.name)
        .sort(),
    ).toEqual(['m1', 'm2']);
  });
});

describe('PooledOllamaBackend — wraps a Backend so every invoke goes through the pool', () => {
  it('calls acquire() before invoke() and release() after', async () => {
    const captures: Captured[] = [];
    const { fetch } = makeFetch(['m1'], captures);
    const pool = new ModelPool({
      ollamaHost: 'http://test',
      maxResident: 3,
      keepAliveMs: 300_000,
      allowlist: ['m1'],
      alwaysRefresh: true,
      fetchImpl: fetch,
    });
    await pool.init();

    // Stub inner backend that records its invoke() call.
    let invoked = false;
    const inner = {
      name: 'ollama',
      async invoke() {
        invoked = true;
        // While invoke() is in flight, the model must be pinned.
        expect(pool.snapshot().pinned).toContain('m1');
        return {
          content: 'ok',
          json: undefined,
          parsed: false,
          tokens: { prompt: 0, completion: 0 },
          latencyMs: 1,
          model: 'm1',
        };
      },
      async health() {
        return true;
      },
    };

    const { PooledOllamaBackend } = await import(
      '../../../src/supervisor/inference/pooled-ollama-backend.js'
    );
    const backend = new PooledOllamaBackend(inner as never, pool);

    await backend.invoke({ model: 'm1', prompt: 'p' });

    expect(invoked).toBe(true);
    // After invoke() returns, the pin is released.
    expect(pool.snapshot().pinned).not.toContain('m1');
  });

  it('releases the pin even when invoke() throws', async () => {
    const captures: Captured[] = [];
    const { fetch } = makeFetch(['m1'], captures);
    const pool = new ModelPool({
      ollamaHost: 'http://test',
      maxResident: 3,
      keepAliveMs: 300_000,
      allowlist: ['m1'],
      alwaysRefresh: true,
      fetchImpl: fetch,
    });
    await pool.init();

    const inner = {
      name: 'ollama',
      async invoke() {
        throw new Error('boom');
      },
      async health() {
        return true;
      },
    };

    const { PooledOllamaBackend } = await import(
      '../../../src/supervisor/inference/pooled-ollama-backend.js'
    );
    const backend = new PooledOllamaBackend(inner as never, pool);

    await expect(backend.invoke({ model: 'm1', prompt: 'p' })).rejects.toThrow('boom');
    // Pin released despite the error.
    expect(pool.snapshot().pinned).not.toContain('m1');
  });
});
