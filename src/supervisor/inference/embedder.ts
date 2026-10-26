/**
 * OllamaEmbedder — Phase 4 embedding provider.
 *
 * Wraps Ollama's `/api/embed` endpoint to produce query embeddings at
 * retrieve time and chunk embeddings at ingest time. Without a real
 * embedder, the hybrid retriever silently degrades to keyword-only
 * search — the pre-Phase-4 behaviour. This module closes that gap.
 *
 * ## Contract
 *
 *   - `embed(text)` returns a `number[]` of length `config.embedding.dimension`.
 *   - `embedBatch(texts[])` batches up to `config.embedding.batchSize`
 *     texts per `/api/embed` call. Larger batches are split.
 *   - On dimension mismatch (the model returned N≠expected dims), throws
 *     `EmbeddingDimensionMismatchError` — silently storing 1024-dim
 *     vectors in a 768-dim column would corrupt the pgvector index.
 *   - On transport error, throws — the caller (the retriever) decides
 *     whether to fall back to keyword-only search or fail loudly.
 *
 * ## Why not the existing OllamaBackend
 *
 * `OllamaBackend.invoke()` is for chat completions; the `/api/embed`
 * endpoint has a different request/response shape. The SDK exposes
 * `client.embed()` directly; this module is a thin typed wrapper that
 * adds dimension validation and batching.
 */
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import type { SupervisorConfig } from '../config.js';
import { logger } from '../observability/logger.js';

export class EmbeddingDimensionMismatchError extends Error {
  override readonly cause: unknown;
  constructor(
    public readonly expected: number,
    public readonly actual: number,
    public readonly model: string,
  ) {
    super(
      `embedding dimension mismatch: model ${model} returned ${actual}-dim vectors ` +
        `but config.embedding.dimension is ${expected}. ` +
        `Update EMBEDDING_DIMENSION or re-create the chunks table with vector(${actual}).`,
    );
    this.name = 'EmbeddingDimensionMismatchError';
    this.cause = { expected, actual, model };
  }
}

export class EmbeddingTransportError extends Error {
  constructor(
    message: string,
    public override readonly cause: unknown,
  ) {
    super(message);
    this.name = 'EmbeddingTransportError';
  }
}

export interface EmbedderDeps {
  config: SupervisorConfig;
  /** Fetch seam for tests; production uses the runtime's global fetch. */
  fetchImpl?: typeof fetch;
}

export class OllamaEmbedder {
  private readonly client: OllamaClient;
  private readonly model: string;
  private readonly expectedDimension: number;
  private readonly batchSize: number;
  private readonly truncate: boolean;
  private readonly modelVersion: string;
  private dimensionVerified = false;

  constructor(deps: EmbedderDeps) {
    this.client = new OllamaClient({
      baseUrl: deps.config.inference.ollamaHost,
      ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
    });
    this.model = deps.config.embedding.model;
    this.expectedDimension = deps.config.embedding.dimension;
    this.batchSize = deps.config.embedding.batchSize;
    this.truncate = deps.config.embedding.truncate;
    this.modelVersion = deps.config.embedding.modelVersion;
  }

  /** Stable version label stored on each chunk at ingest time. */
  get modelVersionLabel(): string {
    return this.modelVersion;
  }

  /** The configured model name (for health checks + logging). */
  get modelName(): string {
    return this.model;
  }

  /** The configured vector dimension. */
  get dimension(): number {
    return this.expectedDimension;
  }

  /**
   * Embed a single text. Returns a vector of length `expectedDimension`.
   * Throws `EmbeddingDimensionMismatchError` if the model returns a
   * different dimension, and `EmbeddingTransportError` on network
   * failures.
   *
   * The first call verifies the model's actual output dimension; the
   * check is cached so subsequent calls skip the validation overhead.
   */
  async embed(text: string): Promise<number[]> {
    const vectors = await this.embedBatch([text]);
    const v = vectors[0];
    if (!v) {
      throw new EmbeddingTransportError('embed returned no vectors', undefined);
    }
    return v;
  }

  /**
   * Embed multiple texts in batches. Returns a flat array of vectors,
   * one per input text, in input order. Batches larger than
   * `batchSize` are split into multiple `/api/embed` calls.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.callEmbedApi(batch);
      if (!this.dimensionVerified) {
        this.verifyDimension(vectors);
        this.dimensionVerified = true;
      }
      results.push(...vectors);
    }
    return results;
  }

  /**
   * Health check — verifies the model is reachable and produces
   * vectors of the expected dimension. Called by the retriever on
   * init() and by `GET /v1/healthz`.
   */
  async health(): Promise<{ ok: boolean; dimension?: number; latencyMs?: number }> {
    const started = Date.now();
    try {
      const v = await this.embed('health check');
      return { ok: true, dimension: v.length, latencyMs: Date.now() - started };
    } catch (e) {
      logger.warn({ err: e, model: this.model }, 'OllamaEmbedder health check failed');
      return { ok: false, latencyMs: Date.now() - started };
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async callEmbedApi(inputs: string[]): Promise<number[][]> {
    try {
      const r = await this.client.embed({
        model: this.model,
        input: inputs,
        truncate: this.truncate,
      });
      return r.embeddings.map((v) => [...v]);
    } catch (e) {
      throw new EmbeddingTransportError(
        `/api/embed call failed for model ${this.model}: ${(e as Error).message}`,
        e,
      );
    }
  }

  private verifyDimension(vectors: number[][]): void {
    if (vectors.length === 0) return;
    const actual = vectors[0]?.length ?? 0;
    if (actual !== this.expectedDimension) {
      throw new EmbeddingDimensionMismatchError(this.expectedDimension, actual, this.model);
    }
  }
}
