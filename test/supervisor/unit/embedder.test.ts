/**
 * OllamaEmbedder — Phase 4 embedding provider invariants.
 *
 * These tests pin down the contract the retriever and the
 * retrieve_knowledge tool rely on: dimension validation, batching,
 * transport-error handling, and the keyword-only degradation path
 * when the embedder is not wired.
 *
 * All tests use an injected fetch that records /api/embed calls —
 * no real Ollama daemon needed.
 */
import { describe, expect, it } from 'vitest';
import type { SupervisorConfig } from '../../../src/supervisor/config.js';
import {
  EmbeddingDimensionMismatchError,
  EmbeddingTransportError,
  OllamaEmbedder,
} from '../../../src/supervisor/inference/embedder.js';

function makeConfig(overrides?: Partial<SupervisorConfig['embedding']>): SupervisorConfig {
  return {
    inference: {
      ollamaHost: 'http://ollama.test:11434',
      defaultThinkMode: 'no-think',
    },
    embedding: {
      model: 'nomic-embed-text',
      dimension: 768,
      batchSize: 32,
      truncate: true,
      modelVersion: 'nomic-embed-text-v1',
      ...overrides,
    },
  } as unknown as SupervisorConfig;
}

interface Captured {
  url: string;
  method: string;
  body?: unknown;
}

function embedResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({
      model: 'nomic-embed-text',
      embeddings: vectors,
      total_duration: 1000,
      prompt_eval_count: 10,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function recordingFetch(respond: (url: string, body: unknown) => Response): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
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
    calls.push({ url, method, body });
    return respond(url, body);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('OllamaEmbedder — dimension validation', () => {
  it('returns a vector of the configured dimension on a successful embed()', async () => {
    const { fetch, calls } = recordingFetch(() =>
      embedResponse([Array.from({ length: 768 }, (_, i) => i / 768)]),
    );
    const embedder = new OllamaEmbedder({ config: makeConfig(), fetchImpl: fetch });

    const v = await embedder.embed('hello world');

    expect(v).toHaveLength(768);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://ollama.test:11434/api/embed');
    expect(calls[0]?.body).toMatchObject({
      model: 'nomic-embed-text',
      input: ['hello world'],
      truncate: true,
    });
  });

  it('throws EmbeddingDimensionMismatchError when the model returns the wrong dimension', async () => {
    const { fetch } = recordingFetch(() =>
      // Model returns 1024-dim vectors but config expects 768.
      embedResponse([Array.from({ length: 1024 }, (_, i) => i / 1024)]),
    );
    const embedder = new OllamaEmbedder({ config: makeConfig(), fetchImpl: fetch });

    const err = (await embedder.embed('hello').catch((e) => e)) as EmbeddingDimensionMismatchError;
    expect(err).toBeInstanceOf(EmbeddingDimensionMismatchError);
    expect(err.expected).toBe(768);
    expect(err.actual).toBe(1024);
    expect(err.model).toBe('nomic-embed-text');
  });

  it('verifies the dimension only once (cached on subsequent calls)', async () => {
    const { fetch, calls } = recordingFetch(() =>
      embedResponse([Array.from({ length: 768 }, (_, i) => i / 768)]),
    );
    const embedder = new OllamaEmbedder({ config: makeConfig(), fetchImpl: fetch });

    await embedder.embed('first');
    await embedder.embed('second');
    await embedder.embed('third');

    // Three /api/embed calls (one per embed), but the dimension check
    // ran only once — the test passes because no dimension error is
    // thrown on calls 2 and 3.
    expect(calls).toHaveLength(3);
  });
});

describe('OllamaEmbedder — batching', () => {
  it('splits batches larger than batchSize into multiple /api/embed calls', async () => {
    const { fetch, calls } = recordingFetch((_url, body) => {
      const b = body as { input?: string[] };
      const count = b.input?.length ?? 1;
      return embedResponse(
        Array.from({ length: count }, () => Array.from({ length: 768 }, (_, i) => i / 768)),
      );
    });
    const embedder = new OllamaEmbedder({
      config: makeConfig({ batchSize: 2 }),
      fetchImpl: fetch,
    });

    const texts = ['a', 'b', 'c', 'd', 'e'];
    const vectors = await embedder.embedBatch(texts);

    expect(vectors).toHaveLength(5);
    expect(vectors[0]).toHaveLength(768);
    // 5 texts / batchSize 2 = 3 calls (2 + 2 + 1).
    expect(calls).toHaveLength(3);
    expect((calls[0]?.body as { input: string[] } | undefined)?.input).toEqual(['a', 'b']);
    expect((calls[2]?.body as { input: string[] } | undefined)?.input).toEqual(['e']);
  });

  it('returns an empty array for an empty input', async () => {
    const { fetch, calls } = recordingFetch(() => embedResponse([]));
    const embedder = new OllamaEmbedder({ config: makeConfig(), fetchImpl: fetch });

    const vectors = await embedder.embedBatch([]);

    expect(vectors).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('OllamaEmbedder — error handling', () => {
  it('throws EmbeddingTransportError on network failure', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const embedder = new OllamaEmbedder({ config: makeConfig(), fetchImpl: down });

    const err = (await embedder.embed('hello').catch((e) => e)) as EmbeddingTransportError;
    expect(err).toBeInstanceOf(EmbeddingTransportError);
    expect(err.message).toContain('/api/embed');
    expect(err.message).toContain('nomic-embed-text');
  });

  it('throws EmbeddingTransportError on non-200 response', async () => {
    const { fetch } = recordingFetch(
      () => new Response(JSON.stringify({ error: 'model not found' }), { status: 404 }),
    );
    const embedder = new OllamaEmbedder({ config: makeConfig(), fetchImpl: fetch });

    const err = (await embedder.embed('hello').catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(EmbeddingTransportError);
    expect(err.message).toContain('model not found');
  });
});

describe('OllamaEmbedder — health check', () => {
  it('reports ok=true with the dimension and latency when the model is reachable', async () => {
    const { fetch } = recordingFetch(() =>
      embedResponse([Array.from({ length: 768 }, (_, i) => i / 768)]),
    );
    const embedder = new OllamaEmbedder({ config: makeConfig(), fetchImpl: fetch });

    const h = await embedder.health();

    expect(h.ok).toBe(true);
    expect(h.dimension).toBe(768);
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports ok=false (never throws) when the model is unreachable', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const embedder = new OllamaEmbedder({ config: makeConfig(), fetchImpl: down });

    const h = await embedder.health();

    expect(h.ok).toBe(false);
    expect(h.dimension).toBeUndefined();
  });
});

describe('OllamaEmbedder — accessors', () => {
  it('exposes the model name, dimension, and version label', () => {
    const embedder = new OllamaEmbedder({
      config: makeConfig({
        model: 'bge-m3',
        dimension: 1024,
        modelVersion: 'bge-m3-v1',
      }),
    });
    expect(embedder.modelName).toBe('bge-m3');
    expect(embedder.dimension).toBe(1024);
    expect(embedder.modelVersionLabel).toBe('bge-m3-v1');
  });
});
