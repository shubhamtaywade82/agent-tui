/**
 * OpenAI-compatible embedder — Phase 4 generalisation.
 *
 * Wraps the `/v1/embeddings` endpoint exposed by:
 *
 *   - OpenAI (`text-embedding-3-small`, `text-embedding-3-large`,
 *     `text-embedding-ada-002`)
 *   - Voyage AI (`voyage-3`, `voyage-2` — OpenAI-compatible API)
 *   - Cohere (`embed-english-v3.0` — via the OpenAI-compat shim)
 *   - Jina AI (`jina-embeddings-v3` — OpenAI-compatible API)
 *   - Nomic AI (`nomic-embed-text-v1.5` — via OpenAI-compat)
 *   - Azure OpenAI (set `EMBEDDING_OPENAI_BASE_URL` to the deployment URL)
 *   - Ollama's OpenAI-compat layer (`http://localhost:11434/v1` with any
 *     Ollama-pulled embedding model)
 *   - Any self-hosted embeddings service that exposes the OpenAI shape
 *
 * Shares the same contract as `OllamaEmbedder`: same dimension-validation,
 * same batching, same `EmbeddingDimensionMismatchError` /
 * `EmbeddingTransportError` taxonomy, same `health()` return shape. The
 * retriever treats both embedders interchangeably.
 *
 * ## Why a separate module instead of reusing OllamaEmbedder
 *
 * The wire shapes are different: Ollama's `/api/embed` returns
 * `{ embeddings: number[][] }`, OpenAI's `/v1/embeddings` returns
 * `{ data: [{ embedding: number[] }] }`. Keeping the two modules separate
 * keeps each one thin and the test fixtures realistic.
 */
import OpenAI from 'openai';
import type { SupervisorConfig } from '../config.js';
import { logger } from '../observability/logger.js';
import { EmbeddingDimensionMismatchError, EmbeddingTransportError } from './embedder.js';

export interface OpenAIEmbedderDeps {
  config: SupervisorConfig;
  /**
   * Override the base URL inferred from the OpenAI inference backend.
   * Use this when the embeddings endpoint differs from the chat endpoint
   * (e.g. chat via OpenAI, embeddings via Voyage).
   */
  baseUrl?: string;
  /** Override the API key. Inherits OPENAI_API_KEY by default. */
  apiKey?: string;
  /** Fetch seam for tests; production uses the OpenAI SDK's transport. */
  fetchImpl?: typeof fetch;
}

export class OpenAIEmbedder {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly expectedDimension: number;
  private readonly batchSize: number;
  private readonly modelVersion: string;
  private dimensionVerified = false;

  constructor(deps: OpenAIEmbedderDeps) {
    const cfg = deps.config;
    this.model = cfg.embedding.model;
    this.expectedDimension = cfg.embedding.dimension;
    this.batchSize = cfg.embedding.batchSize;
    this.modelVersion = cfg.embedding.modelVersion;

    const baseUrl = deps.baseUrl ?? cfg.embedding.openaiBaseUrl ?? cfg.inference.openai.baseUrl;
    const apiKey = deps.apiKey ?? cfg.embedding.openaiApiKey ?? cfg.inference.openai.apiKey;
    if (!apiKey) {
      throw new Error(
        'OpenAIEmbedder: API key required. Set OPENAI_API_KEY (or EMBEDDING_OPENAI_API_KEY) ' +
          'when EMBEDDING_PROVIDER=openai.',
      );
    }
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey,
      maxRetries: 2,
      timeout: 60_000,
      ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
    });
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
   * Throws `EmbeddingDimensionMismatchError` on dimension mismatch and
   * `EmbeddingTransportError` on network failures.
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
   * Embed multiple texts in batches. Returns one vector per input text,
   * in input order. Batches larger than `batchSize` are split into
   * multiple `/v1/embeddings` calls.
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
   * Health check — verifies the model is reachable and produces vectors
   * of the expected dimension. Called by the retriever on init() and by
   * `GET /v1/healthz`.
   */
  async health(): Promise<{ ok: boolean; dimension?: number; latencyMs?: number }> {
    const started = Date.now();
    try {
      const v = await this.embed('health check');
      return { ok: true, dimension: v.length, latencyMs: Date.now() - started };
    } catch (e) {
      logger.warn({ err: e, model: this.model }, 'OpenAIEmbedder health check failed');
      return { ok: false, latencyMs: Date.now() - started };
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async callEmbedApi(inputs: string[]): Promise<number[][]> {
    try {
      const r = await this.client.embeddings.create({
        model: this.model,
        input: inputs,
        // Request explicit float encoding — the OpenAI SDK otherwise defaults
        // to base64 internally (for perf) and decodes via Float32Array. Passing
        // 'float' here makes the wire response a plain JSON number array, which
        // is what OpenAI-compatible embeddings services (Voyage, Cohere, Jina,
        // self-hosted) return by default. OpenAI itself supports both formats.
        encoding_format: 'float',
      });
      // Sort by index to preserve input order — the API returns results in
      // the same order, but we sort defensively.
      const sorted = [...r.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return sorted.map((d) => [...d.embedding]);
    } catch (e) {
      throw new EmbeddingTransportError(
        `/v1/embeddings call failed for model ${this.model}: ${(e as Error).message}`,
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
