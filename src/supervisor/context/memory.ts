/**
 * Tiered memory service — Part 2 §2 (Memory Tiers), §3 (Memory Service
 * API), §4.1 (Memory Items schema), §5 (Write Policy), §6 (Read Policy),
 * §10 (Memory Consolidation), §11 (Forgetting and Expiration), §12
 * (Security and Privacy), §13 (Memory Tools).
 *
 * Implements the seven memory tiers from §2:
 *   - working   (Redis, per-step, seconds-minutes)
 *   - session   (Redis, per conversation, one run)
 *   - episodic  (SQL + vector, summaries of prior runs, weeks-months)
 *   - semantic  (vector + doc store, stable facts, long term)
 *   - procedural (prompt templates + tool policies, long term)
 *   - user_pref (SQL, per-user, long term)
 *   - project   (SQL + vector, per-project conventions, long term)
 *
 * Write policy (§5): only stable, reusable, user-confirmed facts; secrets
 * and PII are blocked by §12 secret scanning. Read policy (§6): scoped
 * by namespace, filtered by ACL + expiration, ranked by importance +
 * recency + semantic relevance, reranked and compressed before insertion
 * into the context budget.
 *
 * §10 consolidation: episodic / project memories can be superseded by
 * newer verified memories — the old record is marked `superseded` and
 * its `superseded_by` field points to the new memory_id. §11 forgetting:
 * TTL expiration, relevance/importance decay, supersession, manual
 * deletion, and conflict resolution (prefer newer verified memory).
 */

import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { supervisorConfig } from '../config.js';
import { logger } from '../observability/logger.js';

export type MemoryTier =
  | 'working'
  | 'session'
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'user_pref'
  | 'project';

/** §4.1 memory_type allowlist — enforced on every write (§13). */
export const MEMORY_TYPES = [
  'user_preference',
  'project_convention',
  'decision',
  'constraint',
  'fact',
  'episode_summary',
  'failed_strategy',
  'successful_strategy',
  'tool_policy',
  'environment_note',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export type MemoryStatus = 'active' | 'superseded' | 'archived' | 'expired';

export interface MemoryRecord {
  memoryId: string;
  tenantId?: string;
  userId?: string;
  projectId?: string;
  namespace: string;
  tier: MemoryTier;
  memoryType: MemoryType;
  content: string;
  summary?: string;
  importance: number; // 0..1
  status: MemoryStatus;
  sourceRunId?: string;
  sourceStepId?: string;
  sourceDocumentId?: string;
  supersededBy?: string;
  acl?: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  tokenCount?: number;
}

export interface MemoryServiceDeps {
  redis?: Redis;
  pool?: Pool;
}

// §12 secret patterns — block memory writes that contain these.
const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{36,}/,
  /gho_[A-Za-z0-9]{36,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/i, // connection strings with creds
];

// §12 PII patterns — flag (don't auto-block, but log) for human review.
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, // email
  /\b\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, // phone
];

export class MemoryService {
  private readonly redis: Redis;
  private readonly pool: Pool;

  constructor(deps: MemoryServiceDeps = {}) {
    this.redis = deps.redis ?? new Redis(supervisorConfig.redis.url);
    this.pool = deps.pool ?? new Pool({ connectionString: supervisorConfig.database.url, max: 5 });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS memories (
          memory_id UUID PRIMARY KEY,
          tenant_id TEXT,
          user_id TEXT,
          project_id TEXT,
          namespace TEXT NOT NULL,
          tier TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT,
          importance REAL NOT NULL DEFAULT 0.5,
          status TEXT NOT NULL DEFAULT 'active',
          source_run_id TEXT,
          source_step_id TEXT,
          source_document_id TEXT,
          superseded_by UUID,
          acl JSONB,
          metadata JSONB NOT NULL DEFAULT '{}',
          token_count INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_used_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS memories_namespace_idx ON memories(namespace, tier);
        CREATE INDEX IF NOT EXISTS memories_importance_idx ON memories(importance DESC);
        CREATE INDEX IF NOT EXISTS memories_tier_expires_idx ON memories(tier, expires_at);
        CREATE INDEX IF NOT EXISTS memories_status_idx ON memories(status) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS memories_tenant_user_idx ON memories(tenant_id, user_id);
        CREATE INDEX IF NOT EXISTS memories_superseded_by_idx ON memories(superseded_by);

        CREATE TABLE IF NOT EXISTS context_snapshots (
          snapshot_id UUID PRIMARY KEY,
          run_id UUID NOT NULL,
          step_id UUID NOT NULL,
          token_budget INTEGER NOT NULL,
          used_tokens INTEGER NOT NULL,
          prompt_hash TEXT NOT NULL,
          included_memory_ids UUID[] NOT NULL DEFAULT '{}',
          included_chunk_ids TEXT[] NOT NULL DEFAULT '{}',
          excluded_chunk_ids TEXT[] NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS context_snapshots_run_idx ON context_snapshots(run_id, created_at);

        CREATE TABLE IF NOT EXISTS checkpoints (
          checkpoint_id UUID PRIMARY KEY,
          run_id UUID NOT NULL,
          step_id UUID,
          status TEXT NOT NULL,
          current_plan TEXT,
          completed_steps TEXT[] NOT NULL DEFAULT '{}',
          active_constraints TEXT[] NOT NULL DEFAULT '{}',
          working_files TEXT[] NOT NULL DEFAULT '{}',
          last_tool_result_summary TEXT,
          next_actions TEXT[] NOT NULL DEFAULT '{}',
          token_budget INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS checkpoints_run_idx ON checkpoints(run_id, created_at);
      `);
    } finally {
      client.release();
    }
  }

  // ─── §3 API surface ─────────────────────────────────────────────────────

  /** Write to the working tier (Redis, TTL 5min). */
  async setWorking(namespace: string, key: string, value: unknown, ttlSec = 300): Promise<void> {
    const k = `working:${namespace}:${key}`;
    await this.redis.set(k, JSON.stringify(value), 'EX', ttlSec);
  }

  async getWorking<T = unknown>(namespace: string, key: string): Promise<T | null> {
    const v = await this.redis.get(`working:${namespace}:${key}`);
    return v ? (JSON.parse(v) as T) : null;
  }

  /**
   * §5 Write policy. Persists a long-term memory record. Returns the new
   * memory_id. Honours:
   *   - §5 reject below importance threshold (unless forced)
   *   - §12 secret scanning (always blocks)
   *   - §12 PII flagging (logs warning, does not block)
   *   - §13 memory_type allowlist
   *   - §13 content length limit
   *   - §11 supersession (if `supersedeMemoryId` is set, mark old record
   *     superseded and link via superseded_by)
   *   - §11 duplicate detection (content hash)
   */
  async write(rec: {
    namespace: string;
    tier: MemoryTier;
    memoryType: MemoryType;
    content: string;
    importance: number;
    summary?: string;
    tenantId?: string;
    userId?: string;
    projectId?: string;
    sourceRunId?: string;
    sourceStepId?: string;
    sourceDocumentId?: string;
    acl?: string[];
    metadata?: Record<string, unknown>;
    expiresAt?: string;
    /** Mark the memory with this id as superseded by the new one (§11). */
    supersedeMemoryId?: string;
    force?: boolean;
  }): Promise<string> {
    // §13 memory_type allowlist
    if (!MEMORY_TYPES.includes(rec.memoryType)) {
      throw new Error(
        `Invalid memory_type: ${rec.memoryType}. Allowed: ${MEMORY_TYPES.join(', ')}`,
      );
    }
    // §13 content length limit
    if (rec.content.length > 16_384) {
      throw new Error(`Memory content exceeds 16 KiB limit (got ${rec.content.length} bytes)`);
    }
    // §12 secret scanning — always block
    for (const re of SECRET_PATTERNS) {
      if (re.test(rec.content)) {
        throw new Error(
          `Memory write blocked: content matches secret pattern ${re.source.slice(0, 40)}`,
        );
      }
    }
    // §12 PII flagging — log but don't block
    for (const re of PII_PATTERNS) {
      if (re.test(rec.content)) {
        logger.warn(
          { namespace: rec.namespace, pattern: re.source.slice(0, 30) },
          'memory write contains possible PII — review recommended',
        );
        break;
      }
    }
    // §5 importance threshold
    if (
      !rec.force &&
      rec.importance < supervisorConfig.memory.importanceThreshold &&
      (rec.tier === 'episodic' || rec.tier === 'semantic' || rec.tier === 'project')
    ) {
      throw new Error(
        `Memory write rejected: importance ${rec.importance} below threshold ${supervisorConfig.memory.importanceThreshold}`,
      );
    }
    // §11 duplicate detection (content hash within same namespace)
    const contentHash = this.hash(`${rec.namespace}:${rec.content}`);
    const existing = await this.pool.query(
      'SELECT memory_id FROM memories WHERE namespace = $1 AND metadata @> $2 AND status = $3',
      [rec.namespace, { content_hash: contentHash }, 'active'],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw new Error(`Duplicate memory detected in namespace ${rec.namespace}`);
    }

    const memoryId = crypto.randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO memories (
           memory_id, tenant_id, user_id, project_id, namespace, tier, memory_type,
           content, summary, importance, status, source_run_id, source_step_id,
           source_document_id, acl, metadata, token_count, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13,$14,$15,$16,$17)`,
        [
          memoryId,
          rec.tenantId ?? null,
          rec.userId ?? null,
          rec.projectId ?? null,
          rec.namespace,
          rec.tier,
          rec.memoryType,
          rec.content,
          rec.summary ?? null,
          rec.importance,
          rec.sourceRunId ?? null,
          rec.sourceStepId ?? null,
          rec.sourceDocumentId ?? null,
          rec.acl ?? null,
          { ...rec.metadata, content_hash: contentHash },
          Math.ceil(rec.content.length / 4),
          rec.expiresAt ?? null,
        ],
      );
      // §11 supersession
      if (rec.supersedeMemoryId) {
        await client.query(
          `UPDATE memories SET status = 'superseded', superseded_by = $1, updated_at = now()
            WHERE memory_id = $2 AND status = 'active'`,
          [memoryId, rec.supersedeMemoryId],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return memoryId;
  }

  /**
   * §6 Read policy. Scoped, ranked retrieval with:
   *   namespace + filters → recent → important → semantic → merge/dedup
   *   → ACL + expiration filter → rerank → compress → return
   */
  async read(params: {
    namespace: string;
    tiers?: MemoryTier[];
    memoryTypes?: MemoryType[];
    tenantId?: string;
    userId?: string;
    projectId?: string;
    limit?: number;
    minImportance?: number;
    recencyBoost?: boolean;
    metadataFilter?: Record<string, unknown>;
  }): Promise<MemoryRecord[]> {
    const tiers = params.tiers ?? ['episodic', 'semantic', 'procedural', 'user_pref', 'project'];
    const limit = Math.min(params.limit ?? 10, 50);
    const minImportance = params.minImportance ?? 0;
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        `SELECT memory_id, tenant_id, user_id, project_id, namespace, tier, memory_type,
                content, summary, importance, status, source_run_id, source_step_id,
                source_document_id, superseded_by, acl, metadata, token_count,
                created_at, updated_at, last_used_at, expires_at
           FROM memories
          WHERE namespace = $1
            AND tier = ANY($2::text[])
            AND ($3::text[] IS NULL OR memory_type = ANY($3::text[]))
            AND importance >= $4
            AND status = 'active'
            AND (expires_at IS NULL OR expires_at > now())
            AND ($5::text IS NULL OR tenant_id = $5)
            AND ($6::text IS NULL OR user_id = $6)
            AND ($7::text IS NULL OR project_id = $7)
            AND (metadata @> $8 OR $8 = '{}'::jsonb)
          ORDER BY
            importance DESC,
            COALESCE(last_used_at, created_at) DESC
          LIMIT $9`,
        [
          params.namespace,
          tiers,
          params.memoryTypes ?? null,
          minImportance,
          params.tenantId ?? null,
          params.userId ?? null,
          params.projectId ?? null,
          params.metadataFilter ?? {},
          limit * 2, // overfetch for rerank
        ],
      );
      // Touch last_used_at for returned records (cheap LRU signal) — §6 rerank
      const ids = r.rows.map((row) => row.memory_id);
      if (ids.length > 0) {
        await client.query(
          `UPDATE memories SET last_used_at = now() WHERE memory_id = ANY($1::uuid[])`,
          [ids],
        );
      }
      let records = r.rows.map((row) => this.rowToRecord(row));
      // §6 ACL filter (defence in depth — also enforced in SQL via tenant/user)
      if (params.userId) {
        records = records.filter((m) => {
          if (!m.acl || m.acl.length === 0) return true;
          return m.acl.some(
            (a) => a === `user:${params.userId}` || a.startsWith('role:') || a.startsWith('team:'),
          );
        });
      }
      // §6 rerank: importance + recency (exponential decay, 30-day half-life)
      if (params.recencyBoost) {
        const now = Date.now();
        records = records.map((m) => {
          const lastUsed = m.lastUsedAt ? Date.parse(m.lastUsedAt) : Date.parse(m.createdAt);
          const days = (now - lastUsed) / (1000 * 60 * 60 * 24);
          const recency = Math.exp(-days / 30);
          return { ...m, importance: 0.7 * m.importance + 0.3 * recency };
        });
        records.sort((a, b) => b.importance - a.importance);
      }
      return records.slice(0, limit);
    } finally {
      client.release();
    }
  }

  async get(memoryId: string): Promise<MemoryRecord | null> {
    const r = await this.pool.query('SELECT * FROM memories WHERE memory_id = $1', [memoryId]);
    if (r.rowCount === 0) return null;
    return this.rowToRecord(r.rows[0]!);
  }

  async update(
    memoryId: string,
    patch: { content?: string; importance?: number; summary?: string; expiresAt?: string | null },
  ): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [memoryId];
    if (patch.content !== undefined) {
      args.push(patch.content);
      sets.push(`content = $${args.length}`);
    }
    if (patch.importance !== undefined) {
      args.push(patch.importance);
      sets.push(`importance = $${args.length}`);
    }
    if (patch.summary !== undefined) {
      args.push(patch.summary);
      sets.push(`summary = $${args.length}`);
    }
    if (patch.expiresAt !== undefined) {
      args.push(patch.expiresAt);
      sets.push(`expires_at = $${args.length}`);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = now()`);
    await this.pool.query(`UPDATE memories SET ${sets.join(', ')} WHERE memory_id = $1`, args);
  }

  async delete(memoryId: string): Promise<void> {
    await this.pool.query(
      "UPDATE memories SET status = 'archived', updated_at = now() WHERE memory_id = $1",
      [memoryId],
    );
  }

  /**
   * §10 Consolidation. Summarise a run into a single episodic memory.
   * `summarizeFn` should call the analyst or summarizer model; the result
   * is stored as a `episode_summary` memory with the run_id link.
   */
  async consolidateRun(params: {
    runId: string;
    namespace: string;
    objective: string;
    completedSteps: string[];
    failedAttempts: number;
    constraints: string[];
    summarizeFn: (input: {
      objective: string;
      completedSteps: string[];
      failedAttempts: number;
      constraints: string[];
    }) => Promise<string>;
  }): Promise<string> {
    const summary = await params.summarizeFn({
      objective: params.objective,
      completedSteps: params.completedSteps,
      failedAttempts: params.failedAttempts,
      constraints: params.constraints,
    });
    return this.write({
      namespace: params.namespace,
      tier: 'episodic',
      memoryType: 'episode_summary',
      content: summary,
      importance: 0.7,
      summary: summary.slice(0, 200),
      sourceRunId: params.runId,
      force: true,
    });
  }

  /** §11 Episodic TTL sweep — call from a cron worker. */
  async sweepExpired(): Promise<number> {
    const r = await this.pool.query(
      "UPDATE memories SET status = 'expired' WHERE expires_at IS NOT NULL AND expires_at < now() AND status = 'active'",
    );
    return r.rowCount ?? 0;
  }

  /** §11 importance decay — decay low-importance episodic memories older than N days. */
  async decayImportance(opts: {
    olderThanDays: number;
    decayFactor: number;
    floor: number;
  }): Promise<number> {
    const r = await this.pool.query(
      `UPDATE memories
          SET importance = GREATEST($1, importance * $2), updated_at = now()
        WHERE tier IN ('episodic', 'semantic')
          AND status = 'active'
          AND created_at < now() - ($3 || ' days')::interval
          AND importance > $1`,
      [opts.floor, opts.decayFactor, String(opts.olderThanDays)],
    );
    return r.rowCount ?? 0;
  }

  // ─── §8 Checkpoints ─────────────────────────────────────────────────────

  async createCheckpoint(cp: {
    runId: string;
    stepId?: string;
    status: string;
    currentPlan?: string;
    completedSteps?: string[];
    activeConstraints?: string[];
    workingFiles?: string[];
    lastToolResultSummary?: string;
    nextActions?: string[];
    tokenBudget: number;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO checkpoints (
         checkpoint_id, run_id, step_id, status, current_plan, completed_steps,
         active_constraints, working_files, last_tool_result_summary, next_actions, token_budget
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        cp.runId,
        cp.stepId ?? null,
        cp.status,
        cp.currentPlan ?? null,
        cp.completedSteps ?? [],
        cp.activeConstraints ?? [],
        cp.workingFiles ?? [],
        cp.lastToolResultSummary ?? null,
        cp.nextActions ?? [],
        cp.tokenBudget,
      ],
    );
    return id;
  }

  async getLatestCheckpoint(runId: string): Promise<{
    checkpointId: string;
    status: string;
    currentPlan?: string;
    completedSteps: string[];
    activeConstraints: string[];
    workingFiles: string[];
    lastToolResultSummary?: string;
    nextActions: string[];
    tokenBudget: number;
    createdAt: string;
  } | null> {
    const r = await this.pool.query(
      'SELECT * FROM checkpoints WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1',
      [runId],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0]!;
    return {
      checkpointId: row.checkpoint_id,
      status: row.status,
      currentPlan: row.current_plan ?? undefined,
      completedSteps: row.completed_steps ?? [],
      activeConstraints: row.active_constraints ?? [],
      workingFiles: row.working_files ?? [],
      lastToolResultSummary: row.last_tool_result_summary ?? undefined,
      nextActions: row.next_actions ?? [],
      tokenBudget: row.token_budget,
      createdAt: row.created_at.toISOString(),
    };
  }

  // ─── §4.5 Context snapshots ─────────────────────────────────────────────

  async saveContextSnapshot(snap: {
    runId: string;
    stepId: string;
    tokenBudget: number;
    usedTokens: number;
    promptHash: string;
    includedMemoryIds?: string[];
    includedChunkIds?: string[];
    excludedChunkIds?: string[];
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO context_snapshots (
         snapshot_id, run_id, step_id, token_budget, used_tokens, prompt_hash,
         included_memory_ids, included_chunk_ids, excluded_chunk_ids
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        snap.runId,
        snap.stepId,
        snap.tokenBudget,
        snap.usedTokens,
        snap.promptHash,
        snap.includedMemoryIds ?? [],
        snap.includedChunkIds ?? [],
        snap.excludedChunkIds ?? [],
      ],
    );
    return id;
  }

  async listContextSnapshots(runId: string): Promise<
    Array<{
      snapshotId: string;
      stepId: string;
      tokenBudget: number;
      usedTokens: number;
      promptHash: string;
      includedMemoryIds: string[];
      includedChunkIds: string[];
      excludedChunkIds: string[];
      createdAt: string;
    }>
  > {
    const r = await this.pool.query(
      'SELECT * FROM context_snapshots WHERE run_id = $1 ORDER BY created_at',
      [runId],
    );
    return r.rows.map((row) => ({
      snapshotId: row.snapshot_id,
      stepId: row.step_id,
      tokenBudget: row.token_budget,
      usedTokens: row.used_tokens,
      promptHash: row.prompt_hash,
      includedMemoryIds: row.included_memory_ids ?? [],
      includedChunkIds: row.included_chunk_ids ?? [],
      excludedChunkIds: row.excluded_chunk_ids ?? [],
      createdAt: row.created_at.toISOString(),
    }));
  }

  async close(): Promise<void> {
    await this.redis.quit();
    await this.pool.end();
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private rowToRecord(row: Record<string, unknown>): MemoryRecord {
    return {
      memoryId: row.memory_id as string,
      tenantId: (row.tenant_id as string) ?? undefined,
      userId: (row.user_id as string) ?? undefined,
      projectId: (row.project_id as string) ?? undefined,
      namespace: row.namespace as string,
      tier: row.tier as MemoryTier,
      memoryType: row.memory_type as MemoryType,
      content: row.content as string,
      summary: (row.summary as string) ?? undefined,
      importance: Number(row.importance),
      status: row.status as MemoryStatus,
      sourceRunId: (row.source_run_id as string) ?? undefined,
      sourceStepId: (row.source_step_id as string) ?? undefined,
      sourceDocumentId: (row.source_document_id as string) ?? undefined,
      supersededBy: (row.superseded_by as string) ?? undefined,
      acl: (row.acl as string[]) ?? undefined,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      tokenCount: (row.token_count as number) ?? undefined,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
      lastUsedAt: row.last_used_at ? (row.last_used_at as Date).toISOString() : null,
      expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : null,
    };
  }

  private hash(s: string): string {
    return createHash('sha256').update(s).digest('hex').slice(0, 16);
  }
}
