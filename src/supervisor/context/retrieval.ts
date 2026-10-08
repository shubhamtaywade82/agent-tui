/**
 * Hybrid retriever — §6 (Retrieval Layer).
 *
 * Combines pgvector semantic search with PostgreSQL full-text search (TSV)
 * for exact term matching. Results are merged, deduplicated, optionally
 * reranked, permission-filtered, and capped to `topK`.
 *
 * §6.4 — "Retrieve only the smallest high-signal evidence needed for the
 * current step." This module is the boundary that prevents the 131K
 * MiniCPM5 context window from being abused.
 */
import { Pool } from 'pg';
import { supervisorConfig } from '../config.js';
import { logger } from '../observability/logger.js';

export interface RetrievalResult {
  chunkId: string;
  source: 'vector' | 'fts' | 'both';
  score: number; // normalised 0..1, higher is better
  content: string;
  metadata: Record<string, unknown>;
  citation: string;
}

export interface HybridRetrieverDeps {
  /** Override the internal Pool (used in tests). */
  pool?: Pool;
}

export class HybridRetriever {
  private readonly pool: Pool;

  constructor(deps: HybridRetrieverDeps = {}) {
    this.pool = deps.pool ?? new Pool({ connectionString: supervisorConfig.database.url, max: 5 });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;

        CREATE TABLE IF NOT EXISTS chunks (
          chunk_id UUID PRIMARY KEY,
          namespace TEXT NOT NULL,
          source_uri TEXT NOT NULL,
          content TEXT NOT NULL,
          embedding vector(768),
          metadata JSONB NOT NULL DEFAULT '{}',
          tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
        CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin(tsv);
        CREATE INDEX IF NOT EXISTS chunks_namespace_idx ON chunks(namespace);
      `);
    } finally {
      client.release();
    }
  }

  /**
   * Hybrid retrieve. `queryEmbedding` should be a 768-d vector from the
   * same embedder used at ingest time. If omitted, only FTS is performed.
   */
  async retrieve(params: {
    query: string;
    queryEmbedding?: number[];
    namespace?: string;
    topK?: number;
    minScore?: number;
    rerank?: boolean;
    permissionFilter?: Record<string, unknown>;
  }): Promise<RetrievalResult[]> {
    const topK = params.topK ?? supervisorConfig.retrieval.topK;
    const minScore = params.minScore ?? supervisorConfig.retrieval.minScore;
    const rerank = params.rerank ?? supervisorConfig.retrieval.rerank;
    const namespace = params.namespace ?? 'default';

    const client = await this.pool.connect();
    try {
      const vectorResults: RetrievalResult[] = [];
      if (params.queryEmbedding && params.queryEmbedding.length === 768) {
        const v = await client.query(
          `SELECT chunk_id, source_uri, content, metadata,
                  1 - (embedding <=> $1::vector) AS score
             FROM chunks
            WHERE namespace = $2
              AND (metadata @> $3 OR $3 = '{}'::jsonb)
            ORDER BY embedding <=> $1::vector
            LIMIT $4`,
          [
            `[${params.queryEmbedding.join(',')}]`,
            namespace,
            params.permissionFilter ?? {},
            topK * 2,
          ],
        );
        for (const row of v.rows) {
          vectorResults.push({
            chunkId: row.chunk_id,
            source: 'vector',
            score: Number(row.score),
            content: row.content,
            metadata: row.metadata,
            citation: row.source_uri,
          });
        }
      }

      const f = await client.query(
        `SELECT chunk_id, source_uri, content, metadata,
                ts_rank(tsv, plainto_tsquery('english', $1)) AS score
           FROM chunks
          WHERE namespace = $2
            AND tsv @@ plainto_tsquery('english', $1)
            AND (metadata @> $3 OR $3 = '{}'::jsonb)
          ORDER BY score DESC
          LIMIT $4`,
        [params.query, namespace, params.permissionFilter ?? {}, topK * 2],
      );
      const ftsResults: RetrievalResult[] = f.rows.map((row) => ({
        chunkId: row.chunk_id,
        source: 'fts',
        score: Number(row.score),
        content: row.content,
        metadata: row.metadata,
        citation: row.source_uri,
      }));

      // Merge and deduplicate. Mark items found by both sources as 'both'
      // and bump their score.
      const byId = new Map<string, RetrievalResult>();
      for (const r of vectorResults) {
        if (r.score >= minScore) byId.set(r.chunkId, r);
      }
      for (const r of ftsResults) {
        const existing = byId.get(r.chunkId);
        if (existing) {
          existing.source = 'both';
          existing.score = Math.min(1, existing.score + 0.15);
        } else if (r.score > 0) {
          // Normalise FTS rank into 0..1 with a soft cap
          byId.set(r.chunkId, { ...r, score: Math.min(1, r.score * 10) });
        }
      }

      let merged = [...byId.values()];
      if (rerank) {
        merged = this.rerank(params.query, merged);
      }
      merged.sort((a, b) => b.score - a.score);
      return merged.slice(0, topK);
    } finally {
      client.release();
    }
  }

  /**
   * Cheap deterministic reranker: cosine-like text overlap on token sets.
   * In production this should be replaced by a cross-encoder model; the
   * contract (input/output shape) stays the same.
   */
  private rerank(query: string, results: RetrievalResult[]): RetrievalResult[] {
    const qTokens = new Set(
      query
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 3),
    );
    return results.map((r) => {
      const rTokens = new Set(
        r.content
          .toLowerCase()
          .split(/\W+/)
          .filter((t) => t.length > 3),
      );
      let overlap = 0;
      for (const t of qTokens) if (rTokens.has(t)) overlap++;
      const jaccard = qTokens.size === 0 ? 0 : overlap / (qTokens.size + rTokens.size - overlap);
      return { ...r, score: 0.7 * r.score + 0.3 * jaccard };
    });
  }

  /**
   * Ingest helper used by the file indexer (§5) and the code indexer (§12).
   */
  async ingest(params: {
    chunkId?: string;
    namespace: string;
    sourceUri: string;
    content: string;
    embedding?: number[];
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const chunkId = params.chunkId ?? crypto.randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO chunks (chunk_id, namespace, source_uri, content, embedding, metadata)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (chunk_id) DO UPDATE SET
           content=EXCLUDED.content, embedding=EXCLUDED.embedding, metadata=EXCLUDED.metadata`,
        [
          chunkId,
          params.namespace,
          params.sourceUri,
          params.content,
          params.embedding ? `[${params.embedding.join(',')}]` : null,
          params.metadata ?? {},
        ],
      );
    } finally {
      client.release();
    }
    logger.debug(
      { chunkId, sourceUri: params.sourceUri, namespace: params.namespace },
      'chunk ingested',
    );
    return chunkId;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
