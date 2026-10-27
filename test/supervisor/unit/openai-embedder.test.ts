/**
 * OpenAIEmbedder — verifies the wire shape of the /v1/embeddings request,
 * the dimension validation, batching, error handling, and the health
 * check. Uses a recording fetch injected via the OpenAI SDK's `fetch`
 * constructor option — no real API call is made.
 */
import { describe, expect, it } from 'vitest';
import type { SupervisorConfig } from '../../../src/supervisor/config.js';
import {
  EmbeddingDimensionMismatchError,
  EmbeddingTransportError,
} from '../../../src/supervisor/inference/embedder.js';
import { OpenAIEmbedder } from '../../../src/supervisor/inference/openai-embedder.js';

const BASE = 'https://api.openai.com/v1';
const KEY = 'sk-test-key-1234';

function makeConfig(
  overrides: { model?: string; dimension?: number; batchSize?: number; modelVersion?: string } = {},
): SupervisorConfig {
  return {
    inference: {
      openai: { baseUrl: BASE, apiKey: KEY },
      defaultThinkMode: 'no-think',
    },
    context: { budgetTokens: 8192 },
    embedding: {
      model: overrides.model ?? 'text-embedding-3-small',
      dimension: overrides.dimension ?? 4,
      batchSize: overrides.batchSize ?? 32,
      truncate: true,
      modelVersion: overrides.modelVersion ?? 'text-embedding-3-small-v1',
    },
  } as unknown as SupervisorConfig;
}

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function recordingFetch(respond: () => Response): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ url, method: init?.method ?? 'POST', body });
    return respond();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function embeddingsResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: vectors.map((embedding, i) => ({ object: 'embedding', index: i, embedding })),
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 5, total_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeVector(dim: number): number[] {
  return Array.from({ length: dim }, (_, i) => (i + 1) / dim);
}

describe('OpenAIEmbedder — construction', () => {
  it('throws when no API key is available', () => {
    const cfg = makeConfig();
    cfg.inference.openai.apiKey = undefined;
    cfg.embedding.openaiApiKey = undefined;
    expect(() => new OpenAIEmbedder({ config: cfg })).toThrowError(/API key required/);
  });

  it('honours an explicit EMBEDDING_OPENAI_API_KEY over OPENAI_API_KEY', () => {
    const cfg = makeConfig();
    cfg.embedding.openaiApiKey = 'emb-key-xyz';
    expect(() => new OpenAIEmbedder({ config: cfg })).not.toThrow();
  });

  it('honours an explicit EMBEDDING_OPENAI_BASE_URL', () => {
    const cfg = makeConfig();
    cfg.embedding.openaiBaseUrl = 'https://api.voyageai.com/v1';
    expect(() => new OpenAIEmbedder({ config: cfg })).not.toThrow();
  });
});

describe('OpenAIEmbedder — accessors', () => {
  it('exposes the model name, dimension, and version label', () => {
    const cfg = makeConfig({
      model: 'voyage-3',
      dimension: 1024,
      modelVersion: 'voyage-3-v1',
    });
    const embedder = new OpenAIEmbedder({ config: cfg });
    expect(embedder.modelName).toBe('voyage-3');
    expect(embedder.dimension).toBe(1024);
    expect(embedder.modelVersionLabel).toBe('voyage-3-v1');
  });
});

describe('OpenAIEmbedder — embed', () => {
  it('sends a /v1/embeddings request with model + input', async () => {
    const { fetch, calls } = recordingFetch(() => embeddingsResponse([makeVector(4)]));
    const embedder = new OpenAIEmbedder({ config: makeConfig(), fetchImpl: fetch });

    await embedder.embed('hello world');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/embeddings`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({
      model: 'text-embedding-3-small',
      input: ['hello world'],
      encoding_format: 'float',
    });
  });

  it('returns the embedding vector of the expected dimension', async () => {
    const { fetch } = recordingFetch(() => embeddingsResponse([makeVector(4)]));
    const embedder = new OpenAIEmbedder({ config: makeConfig(), fetchImpl: fetch });

    const v = await embedder.embed('hello');
    expect(v).toHaveLength(4);
    expect(v[0]).toBeCloseTo(1 / 4);
  });

  it('throws EmbeddingDimensionMismatchError on dimension mismatch', async () => {
    // Config says 4 dims; model returns 8. Should throw — silently storing
    // 8-dim vectors in a 4-dim column would corrupt the index.
    const { fetch } = recordingFetch(() => embeddingsResponse([makeVector(8)]));
    const embedder = new OpenAIEmbedder({ config: makeConfig({ dimension: 4 }), fetchImpl: fetch });

    const err = (await embedder.embed('hello').catch((e) => e)) as EmbeddingDimensionMismatchError;
    expect(err).toBeInstanceOf(EmbeddingDimensionMismatchError);
    expect(err.expected).toBe(4);
    expect(err.actual).toBe(8);
    expect(err.model).toBe('text-embedding-3-small');
  });

  it('caches the dimension check after the first successful call', async () => {
    const { fetch, calls } = recordingFetch(() => embeddingsResponse([makeVector(4)]));
    const embedder = new OpenAIEmbedder({ config: makeConfig(), fetchImpl: fetch });

    await embedder.embed('first');
    await embedder.embed('second');
    await embedder.embed('third');

    expect(calls).toHaveLength(3);
  });
});

describe('OpenAIEmbedder — embedBatch', () => {
  it('returns one vector per input, in order', async () => {
    const { fetch } = recordingFetch(() =>
      embeddingsResponse([makeVector(4), makeVector(4), makeVector(4)]),
    );
    const embedder = new OpenAIEmbedder({ config: makeConfig(), fetchImpl: fetch });

    const vectors = await embedder.embedBatch(['a', 'b', 'c']);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
      expect(v).toHaveLength(4);
    }
  });

  it('returns an empty array on empty input', async () => {
    const { fetch } = recordingFetch(() => embeddingsResponse([]));
    const embedder = new OpenAIEmbedder({ config: makeConfig(), fetchImpl: fetch });

    const vectors = await embedder.embedBatch([]);
    expect(vectors).toEqual([]);
  });

  it('splits inputs larger than batchSize into multiple API calls', async () => {
    const { fetch, calls } = recordingFetch(() =>
      embeddingsResponse([makeVector(4), makeVector(4)]),
    );
    const embedder = new OpenAIEmbedder({
      config: makeConfig({ batchSize: 2 }),
      fetchImpl: fetch,
    });

    // 4 inputs, batchSize=2 → 2 API calls
    await embedder.embedBatch(['a', 'b', 'c', 'd']);

    expect(calls).toHaveLength(2);
    expect(calls[0].body?.input).toEqual(['a', 'b']);
    expect(calls[1].body?.input).toEqual(['c', 'd']);
  });
});

describe('OpenAIEmbedder — error handling', () => {
  it('throws EmbeddingTransportError on fetch failure', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const embedder = new OpenAIEmbedder({ config: makeConfig(), fetchImpl: down });

    const err = (await embedder.embed('hello').catch((e) => e)) as EmbeddingTransportError;
    expect(err).toBeInstanceOf(EmbeddingTransportError);
    expect(err.message).toContain('/v1/embeddings');
    expect(err.message).toContain('text-embedding-3-small');
  });

  it('throws EmbeddingTransportError on non-200 response', async () => {
    const { fetch } = recordingFetch(
      () => new Response(JSON.stringify({ error: 'model not found' }), { status: 404 }),
    );
    const embedder = new OpenAIEmbedder({ config: makeConfig(), fetchImpl: fetch });

    const err = (await embedder.embed('hello').catch((e) => e)) as EmbeddingTransportError;
    expect(err).toBeInstanceOf(EmbeddingTransportError);
    expect(err.message).toContain('model not found');
  });
});

describe('OpenAIEmbedder — health check', () => {
  it('reports ok=true with the dimension and latency when the model is reachable', async () => {
    const { fetch } = recordingFetch(() => embeddingsResponse([makeVector(4)]));
    const embedder = new OpenAIEmbedder({ config: makeConfig(), fetchImpl: fetch });

    const h = await embedder.health();

    expect(h.ok).toBe(true);
    expect(h.dimension).toBe(4);
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports ok=false (never throws) when the model is unreachable', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const embedder = new OpenAIEmbedder({ config: makeConfig(), fetchImpl: down });

    const h = await embedder.health();

    expect(h.ok).toBe(false);
    expect(h.dimension).toBeUndefined();
  });
});
