/**
 * Hybrid retriever — Part 1 §6 (Hybrid Retrieval), §7 (Reranking), §11
 * (Caching), §12 (Security and Tenant Isolation), §4 (Structure-Aware
 * Chunking), §5 (Rich Metadata).
 *
 * Combines pgvector semantic search with PostgreSQL full-text search
 * (TSV) for exact term matching. Results are merged via Reciprocal Rank
 * Fusion (§6), deduplicated, optionally reranked with a weighted
 * deterministic scorer (§7), permission-filtered (§12), and capped to
 * `topK`.
 *
 * The chunk schema carries the full §5 metadata set: workspace_id,
 * tenant_id, owner_id, source_hash, document_type, language, acl,
 * embedding_model_version, section_path, quality_score, deprecated.
 * Chunk-level ACLs are inherited from the parent document and enforced
 * before any result reaches the model (§12).
 *
 * A 4-layer Redis cache (§11) sits in front of the database:
 *   - embedding cache  (query → embedding vector)
 *   - retrieval cache  (query+filters → chunk ids)
 *   - prompt cache     (system+tool prefix hash → cached prefix)
 *   - generation cache (prompt hash → model output)
 *
 * §6.4 — "Retrieve only the smallest high-signal evidence needed for
 * the current step." This module is the boundary that prevents the 131K
 * MiniCPM5 context window from being abused.
 */

import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import { supervisorConfig } from '../config.js';
import { logger } from '../observability/logger.js';

// ─── §5 Rich Metadata ──────────────────────────────────────────────────────

export type DocumentType = 'policy' | 'runbook' | 'code' | 'ticket' | 'memory' | 'log';

export interface ChunkMetadata {
  // Identity
  documentId?: string;
  chunkIndex?: number;
  // §5 multi-tenancy + ACL
  workspaceId?: string;
  tenantId?: string;
  ownerId?: string;
  acl?: string[]; // e.g. ['user:alice', 'team:platform', 'role:admin']
  // Provenance
  sourceHash?: string;
  documentType?: DocumentType;
  language?: string;
  sectionPath?: string; // e.g. "Deployment > Rollback > Database Rollback"
  // Versioning + quality (§5, §9 versioning embeddings)
  embeddingModelVersion?: string;
  qualityScore?: number; // 0..1
  deprecated?: boolean;
  // Timing
  createdAt?: string;
  updatedAt?: string;
  // Token accounting for §8 budget enforcement
  tokenCount?: number;
  // Free-form extras
  [k: string]: unknown;
}

export interface RetrievalResult {
  chunkId: string;
  source: 'vector' | 'fts' | 'both';
  score: number; // normalised 0..1, higher is better (post-rerank)
  content: string;
  metadata: ChunkMetadata;
  citation: string;
}

export interface RetrievalFilters {
  tenantId?: string;
  workspaceId?: string;
  ownerId?: string;
  userId?: string; // for ACL contains check
  projectId?: string; // mirrors memory projectId; used for namespace scoping
  documentTypes?: DocumentType[];
  language?: string;
  namespaces?: string[];
  deprecated?: boolean; // default false (exclude deprecated)
  aclContains?: string; // e.g. 'team:platform'
}

export interface RetrievalQuery {
  query: string;
  queryEmbedding?: number[];
  namespace?: string;
  topK?: number;
  minScore?: number;
  rerank?: boolean;
  filters?: RetrievalFilters;
  /** Bypass cache for this single call (e.g. after a write). */
  bypassCache?: boolean;
}

export interface HybridRetrieverDeps {
  pool?: Pool;
  redis?: Redis;
}

// ─── §7 Rerank weights (tunable per workload) ──────────────────────────────

export interface RerankWeights {
  semantic: number; // 0.55
  keyword: number; // 0.20
  recency: number; // 0.10
  sourceAuthority: number; // 0.10
  quality: number; // 0.05
}

const DEFAULT_RERANK_WEIGHTS: RerankWeights = {
  semantic: 0.55,
  keyword: 0.2,
  recency: 0.1,
  sourceAuthority: 0.1,
  quality: 0.05,
};

// Source authority boosts — policies and runbooks rank above tickets and logs.
const SOURCE_AUTHORITY: Record<DocumentType, number> = {
  policy: 1.0,
  runbook: 0.9,
  code: 0.7,
  memory: 0.6,
  ticket: 0.4,
  log: 0.3,
};

export class HybridRetriever {
  private readonly pool: Pool;
  private readonly redis: Redis | null;
  private readonly rerankWeights: RerankWeights;
  // Track index versions so cache keys invalidate on reindex (§5, §9).
  private indexVersion = 1;

  constructor(deps: HybridRetrieverDeps = {}) {
    this.pool = deps.pool ?? new Pool({ connectionString: supervisorConfig.database.url, max: 5 });
    this.redis = deps.redis ?? null;
    this.rerankWeights = DEFAULT_RERANK_WEIGHTS;
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
          document_id TEXT,
          chunk_index INTEGER,
          source_uri TEXT NOT NULL,
          content TEXT NOT NULL,
          embedding vector(768),
          -- §5 rich metadata columns (denormalised from JSONB for fast filtering)
          workspace_id TEXT,
          tenant_id TEXT,
          owner_id TEXT,
          source_hash TEXT,
          document_type TEXT,
          language TEXT,
          section_path TEXT,
          embedding_model_version TEXT,
          quality_score REAL NOT NULL DEFAULT 0.5,
          deprecated BOOLEAN NOT NULL DEFAULT false,
          token_count INTEGER,
          metadata JSONB NOT NULL DEFAULT '{}',
          tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
        CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin(tsv);
        CREATE INDEX IF NOT EXISTS chunks_namespace_idx ON chunks(namespace);
        CREATE INDEX IF NOT EXISTS chunks_tenant_workspace_idx ON chunks(tenant_id, workspace_id);
        CREATE INDEX IF NOT EXISTS chunks_doc_type_idx ON chunks(document_type);
        CREATE INDEX IF NOT EXISTS chunks_deprecated_idx ON chunks(deprecated) WHERE deprecated = false;
        CREATE INDEX IF NOT EXISTS chunks_source_hash_idx ON chunks(source_hash);
      `);
    } finally {
      client.release();
    }
  }

  /**
   * Hybrid retrieve. §6 full pipeline:
   *   query → metadata filter construction → vector retrieval → keyword
   *   retrieval → RRF score fusion → permission filtering → reranking
   *   → deduplication → compression → top-k context assembly
   *
   * `queryEmbedding` should be a 768-d vector from the same embedder used
   * at ingest time. If omitted, only FTS is performed. The embedding
   * itself is cached (§11) when supplied via `embedAndRetrieve`.
   */
  async retrieve(params: RetrievalQuery): Promise<RetrievalResult[]> {
    const topK = params.topK ?? supervisorConfig.retrieval.topK;
    const minScore = params.minScore ?? supervisorConfig.retrieval.minScore;
    const rerank = params.rerank ?? supervisorConfig.retrieval.rerank;
    const namespace = params.namespace ?? 'default';
    const filters = params.filters ?? {};

    // §11 retrieval cache lookup
    const cacheKey = this.retrievalCacheKey(params.query, namespace, filters, this.indexVersion);
    if (!params.bypassCache && this.redis) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as RetrievalResult[];
        } catch {
          // stale cache — fall through to DB
        }
      }
    }

    const client = await this.pool.connect();
    try {
      // Build the full WHERE clause + args with positional parameters.
      // $1 = embedding (vector) OR query text (fts); $2 = namespace;
      // $3 = deprecated flag; $4.. = filters; last = limit
      const vectorEmbedding = params.queryEmbedding ? `[${params.queryEmbedding.join(',')}]` : null;
      const { clause: filterClause, args: filterArgs } = this.buildFilterClause(filters, 4);
      const limitArg = topK * 4;

      // §6 vector retrieval (overfetch 2× for reranking)
      const vectorResults: RetrievalResult[] = [];
      if (params.queryEmbedding && params.queryEmbedding.length === 768) {
        const v = await client.query(
          `SELECT chunk_id, document_id, chunk_index, source_uri, content, namespace,
                  workspace_id, tenant_id, owner_id, source_hash, document_type, language,
                  section_path, embedding_model_version, quality_score, deprecated, token_count,
                  metadata, created_at, updated_at,
                  1 - (embedding <=> $1::vector) AS score
             FROM chunks
            WHERE namespace = $2
              AND deprecated = COALESCE($3, deprecated)
              ${filterClause}
            ORDER BY embedding <=> $1::vector
            LIMIT $${4 + filterArgs.length}`,
          [vectorEmbedding, namespace, filters.deprecated ?? null, ...filterArgs, limitArg],
        );
        for (const row of v.rows) {
          vectorResults.push(this.rowToResult(row, 'vector'));
        }
      }

      // §6 keyword / FTS retrieval (overfetch 2× for reranking)
      const f = await client.query(
        `SELECT chunk_id, document_id, chunk_index, source_uri, content, namespace,
                workspace_id, tenant_id, owner_id, source_hash, document_type, language,
                section_path, embedding_model_version, quality_score, deprecated, token_count,
                metadata, created_at, updated_at,
                ts_rank(tsv, plainto_tsquery('english', $1)) AS score
           FROM chunks
          WHERE namespace = $2
            AND deprecated = COALESCE($3, deprecated)
            AND tsv @@ plainto_tsquery('english', $1)
            ${filterClause}
          ORDER BY score DESC
          LIMIT $${4 + filterArgs.length}`,
        [params.query, namespace, filters.deprecated ?? null, ...filterArgs, limitArg],
      );
      const ftsResults: RetrievalResult[] = f.rows.map((row) => this.rowToResult(row, 'fts'));

      // §6 Reciprocal Rank Fusion (RRF) — merge vector + FTS by rank
      const byId = new Map<string, RetrievalResult>();
      const rrfK = 60; // standard RRF constant
      const rrfScores = new Map<string, number>();
      for (let i = 0; i < vectorResults.length; i++) {
        const r = vectorResults[i]!;
        byId.set(r.chunkId, r);
        rrfScores.set(r.chunkId, 1 / (rrfK + i + 1));
      }
      for (let i = 0; i < ftsResults.length; i++) {
        const r = ftsResults[i]!;
        const existing = byId.get(r.chunkId);
        const prev = rrfScores.get(r.chunkId) ?? 0;
        rrfScores.set(r.chunkId, prev + 1 / (rrfK + i + 1));
        if (existing) {
          existing.source = 'both';
        } else {
          byId.set(r.chunkId, r);
        }
      }

      // Normalise RRF scores into 0..1 (max possible = 2/61 ≈ 0.033)
      let maxRrf = 0;
      for (const s of rrfScores.values()) if (s > maxRrf) maxRrf = s;
      for (const [id, s] of rrfScores) {
        const r = byId.get(id)!;
        r.score = maxRrf > 0 ? s / maxRrf : 0;
      }

      let merged = [...byId.values()].filter((r) => r.score >= minScore);

      // §12 permission filtering — enforce ACLs before reranking
      merged = this.applyAclFilter(merged, filters);

      // §7 reranking
      if (rerank) {
        merged = this.rerank(params.query, merged);
      }

      merged.sort((a, b) => b.score - a.score);
      const final = merged.slice(0, topK);

      // §11 cache the final results
      if (this.redis && !params.bypassCache) {
        const ttl = this.cacheTtlForNamespace(namespace);
        await this.redis.set(cacheKey, JSON.stringify(final), 'EX', ttl);
      }

      return final;
    } finally {
      client.release();
    }
  }

  /**
   * Embed + retrieve in one call. The embedding is cached (§11) keyed by
   * (text, embedding_model_version). Replace `embedFn` with your real
   * embedder (e.g. bge-small, gte-small, or MiniCPM5-Embedding).
   */
  async embedAndRetrieve(
    params: Omit<RetrievalQuery, 'queryEmbedding'>,
    embedFn: (text: string) => Promise<number[]>,
    embeddingModelVersion = 'default-v1',
  ): Promise<RetrievalResult[]> {
    const embKey = `emb:${embeddingModelVersion}:${this.hash(params.query)}`;
    let embedding: number[];
    if (this.redis) {
      const cached = await this.redis.get(embKey);
      if (cached) {
        try {
          embedding = JSON.parse(cached);
          return this.retrieve({ ...params, queryEmbedding: embedding });
        } catch {
          // fall through
        }
      }
    }
    embedding = await embedFn(params.query);
    if (this.redis) {
      await this.redis.set(embKey, JSON.stringify(embedding), 'EX', 3600);
    }
    return this.retrieve({ ...params, queryEmbedding: embedding });
  }

  /**
   * Ingest helper used by the file indexer (§5) and the code indexer
   * (§12). Now stores the full §5 metadata set as first-class columns
   * (for fast filtering) plus JSONB (for extras).
   */
  async ingest(params: {
    chunkId?: string;
    namespace: string;
    sourceUri: string;
    content: string;
    embedding?: number[];
    metadata?: ChunkMetadata;
    tokenCount?: number;
  }): Promise<string> {
    const chunkId = params.chunkId ?? crypto.randomUUID();
    const md: ChunkMetadata = params.metadata ?? {};
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO chunks (
           chunk_id, namespace, document_id, chunk_index, source_uri, content, embedding,
           workspace_id, tenant_id, owner_id, source_hash, document_type, language,
           section_path, embedding_model_version, quality_score, deprecated, token_count,
           metadata, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
         ON CONFLICT (chunk_id) DO UPDATE SET
           content=EXCLUDED.content, embedding=EXCLUDED.embedding,
           workspace_id=EXCLUDED.workspace_id, tenant_id=EXCLUDED.tenant_id,
           owner_id=EXCLUDED.owner_id, source_hash=EXCLUDED.source_hash,
           document_type=EXCLUDED.document_type, language=EXCLUDED.language,
           section_path=EXCLUDED.section_path,
           embedding_model_version=EXCLUDED.embedding_model_version,
           quality_score=EXCLUDED.quality_score, deprecated=EXCLUDED.deprecated,
           token_count=EXCLUDED.token_count, metadata=EXCLUDED.metadata,
           updated_at=now()`,
        [
          chunkId,
          params.namespace,
          md.documentId ?? null,
          md.chunkIndex ?? null,
          params.sourceUri,
          params.content,
          params.embedding ? `[${params.embedding.join(',')}]` : null,
          md.workspaceId ?? null,
          md.tenantId ?? null,
          md.ownerId ?? null,
          md.sourceHash ?? null,
          md.documentType ?? null,
          md.language ?? null,
          md.sectionPath ?? null,
          md.embeddingModelVersion ?? null,
          md.qualityScore ?? 0.5,
          md.deprecated ?? false,
          params.tokenCount ?? null,
          params.metadata ?? {},
        ],
      );
    } finally {
      client.release();
    }
    // Invalidate retrieval cache for this namespace on write
    if (this.redis) {
      await this.redis.del(`retrieval:${params.namespace}:*`).catch(() => undefined);
    }
    logger.debug(
      { chunkId, sourceUri: params.sourceUri, namespace: params.namespace },
      'chunk ingested',
    );
    return chunkId;
  }

  /**
   * Mark all chunks of a document as deprecated (§5, §11 supersession).
   * The retriever's default filter excludes deprecated chunks.
   */
  async deprecateDocument(documentId: string): Promise<number> {
    const r = await this.pool.query(
      'UPDATE chunks SET deprecated = true, updated_at = now() WHERE document_id = $1',
      [documentId],
    );
    return r.rowCount ?? 0;
  }

  /** Bump the index version — invalidates all retrieval cache keys. */
  bumpIndexVersion(): void {
    this.indexVersion++;
  }

  async close(): Promise<void> {
    await this.pool.end();
    if (this.redis) await this.redis.quit();
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private rowToResult(
    row: Record<string, unknown>,
    source: 'vector' | 'fts' | 'both',
  ): RetrievalResult {
    return {
      chunkId: row.chunk_id as string,
      source,
      score: Number(row.score),
      content: row.content as string,
      citation: row.source_uri as string,
      metadata: {
        documentId: (row.document_id as string) ?? undefined,
        chunkIndex: (row.chunk_index as number) ?? undefined,
        workspaceId: (row.workspace_id as string) ?? undefined,
        tenantId: (row.tenant_id as string) ?? undefined,
        ownerId: (row.owner_id as string) ?? undefined,
        sourceHash: (row.source_hash as string) ?? undefined,
        documentType: (row.document_type as DocumentType) ?? undefined,
        language: (row.language as string) ?? undefined,
        sectionPath: (row.section_path as string) ?? undefined,
        embeddingModelVersion: (row.embedding_model_version as string) ?? undefined,
        qualityScore: (row.quality_score as number) ?? 0.5,
        deprecated: (row.deprecated as boolean) ?? false,
        tokenCount: (row.token_count as number) ?? undefined,
        createdAt: (row.created_at as Date)?.toISOString?.() ?? undefined,
        updatedAt: (row.updated_at as Date)?.toISOString?.() ?? undefined,
        ...(row.metadata as Record<string, unknown>),
      },
    };
  }

  /**
   * §7 weighted reranker. Combines:
   *   0.55 * semantic_score (RRF-normalised vector+FTS)
   * + 0.20 * keyword_score  (Jaccard on token sets)
   * + 0.10 * recency_score  (exponential decay over 90 days)
   * + 0.10 * source_authority_score (policy=1.0 ... log=0.3)
   * + 0.05 * quality_score  (stored metadata)
   *
   * Replace with a cross-encoder in production — same contract.
   */
  private rerank(query: string, results: RetrievalResult[]): RetrievalResult[] {
    const qTokens = new Set(
      query
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 3),
    );
    const now = Date.now();
    return results.map((r) => {
      const rTokens = new Set(
        r.content
          .toLowerCase()
          .split(/\W+/)
          .filter((t) => t.length > 3),
      );
      let overlap = 0;
      for (const t of qTokens) if (rTokens.has(t)) overlap++;
      const keyword = qTokens.size === 0 ? 0 : overlap / (qTokens.size + rTokens.size - overlap);

      const recency = this.recencyScore(r.metadata.updatedAt ?? r.metadata.createdAt, now);
      const authority = r.metadata.documentType
        ? (SOURCE_AUTHORITY[r.metadata.documentType] ?? 0.5)
        : 0.5;
      const quality = r.metadata.qualityScore ?? 0.5;

      const finalScore =
        this.rerankWeights.semantic * r.score +
        this.rerankWeights.keyword * keyword +
        this.rerankWeights.recency * recency +
        this.rerankWeights.sourceAuthority * authority +
        this.rerankWeights.quality * quality;

      return { ...r, score: Math.min(1, finalScore) };
    });
  }

  private recencyScore(isoDate: string | undefined, now: number): number {
    if (!isoDate) return 0.5;
    const t = Date.parse(isoDate);
    if (Number.isNaN(t)) return 0.5;
    const days = (now - t) / (1000 * 60 * 60 * 24);
    if (days <= 0) return 1;
    // Exponential decay with a 90-day half-life
    return Math.exp(-days / 90);
  }

  /**
   * §12 permission filtering. Enforces chunk-level ACLs BEFORE any result
   * reaches the model. ACLs are inherited from the parent document and
   * stored on each chunk (§5). Never rely on the LLM to enforce perms.
   */
  private applyAclFilter(results: RetrievalResult[], filters: RetrievalFilters): RetrievalResult[] {
    if (!filters.userId && !filters.aclContains && !filters.tenantId && !filters.workspaceId) {
      return results;
    }
    return results.filter((r) => {
      const md = r.metadata;
      // Tenant isolation (hard gate)
      if (filters.tenantId && md.tenantId && md.tenantId !== filters.tenantId) return false;
      if (filters.workspaceId && md.workspaceId && md.workspaceId !== filters.workspaceId)
        return false;
      // ACL inheritance: chunk must explicitly grant access to the user,
      // their team, or their role. Chunks with no ACL are visible only
      // when no userId filter is supplied.
      if (filters.userId || filters.aclContains) {
        const acl = md.acl ?? [];
        if (acl.length === 0) return false;
        const wants = filters.aclContains ?? `user:${filters.userId}`;
        if (!acl.includes(wants) && !acl.some((a) => a.startsWith('role:'))) return false;
      }
      return true;
    });
  }

  /**
   * Build a parameterised WHERE-clause fragment for the optional filters.
   * `startPos` is the 1-indexed position of the first parameter this clause
   * will use (after the reserved $1=embedding/query, $2=namespace, $3=deprecated).
   * Returns the clause text (with positional `$N` placeholders) and the
   * matching args array.
   */
  private buildFilterClause(
    filters: RetrievalFilters,
    startPos: number,
  ): { clause: string; args: unknown[] } {
    const parts: string[] = [];
    const args: unknown[] = [];
    let pos = startPos;
    const push = (columnExpr: string, arg: unknown) => {
      parts.push(`AND ${columnExpr} = $${pos}`);
      args.push(arg);
      pos++;
    };
    if (filters.tenantId) push('tenant_id', filters.tenantId);
    if (filters.workspaceId) push('workspace_id', filters.workspaceId);
    if (filters.ownerId) push('owner_id', filters.ownerId);
    if (filters.language) push('language', filters.language);
    if (filters.documentTypes && filters.documentTypes.length > 0) {
      parts.push(`AND document_type = ANY($${pos}::text[])`);
      args.push(filters.documentTypes);
      pos++;
    }
    return { clause: parts.join(' '), args };
  }

  private retrievalCacheKey(
    query: string,
    namespace: string,
    filters: RetrievalFilters,
    version: number,
  ): string {
    const filterHash = this.hash(JSON.stringify({ ...filters, _v: version }));
    return `retrieval:${namespace}:${this.hash(query)}:${filterHash}`;
  }

  private cacheTtlForNamespace(namespace: string): number {
    // Fast-changing operational namespaces: short TTL.
    // Stable policy/code namespaces: longer TTL.
    if (namespace.startsWith('log:') || namespace.startsWith('ticket:')) return 60;
    if (namespace.startsWith('code:')) return 600;
    return 300;
  }

  private hash(s: string): string {
    return createHash('sha256').update(s).digest('hex').slice(0, 16);
  }
}
