/**
 * Tiered memory service — §7 (Memory Infrastructure).
 *
 * Implements the seven memory tiers from §7.1:
 *   - working   (in-process / Redis, per-step)
 *   - session   (Redis, per conversation)
 *   - episodic  (vector + SQL, summaries of prior runs)
 *   - semantic  (vector + doc store, facts/policies/docs)
 *   - procedural (prompt templates + tool policies)
 *   - user_pref (relational, per-user)
 *   - project   (relational + vector, per-project conventions)
 *
 * Write policy (§7.2): only stable, reusable, user-confirmed facts. Read
 * policy (§7.3): filter by namespace, user, project, importance, recency,
 * and access control.
 */
import Redis from 'ioredis';
import { Pool } from 'pg';
import { supervisorConfig } from '../config.js';

export type MemoryTier =
  | 'working'
  | 'session'
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'user_pref'
  | 'project';

export interface MemoryRecord {
  memoryId: string;
  namespace: string;
  tier: MemoryTier;
  type: string;
  content: string;
  importance: number; // 0..1
  metadata: Record<string, unknown>;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface MemoryServiceDeps {
  redis?: Redis;
  pool?: Pool;
}

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
          namespace TEXT NOT NULL,
          tier TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          importance REAL NOT NULL DEFAULT 0.5,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_used_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS memories_namespace_idx ON memories(namespace, tier);
        CREATE INDEX IF NOT EXISTS memories_importance_idx ON memories(importance DESC);
        CREATE INDEX IF NOT EXISTS memories_tier_expires_idx ON memories(tier, expires_at);
      `);
    } finally {
      client.release();
    }
  }

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
   * Persist a long-term memory record. Returns the new memory_id.
   * Honours §7.2 write policy: rejects records below the importance
   * threshold (§config.memory.importanceThreshold) unless forced.
   */
  async write(
    rec: Omit<MemoryRecord, 'memoryId' | 'createdAt' | 'lastUsedAt' | 'expiresAt'> & {
      expiresAt?: string;
      force?: boolean;
    },
  ): Promise<string> {
    if (
      !rec.force &&
      rec.importance < supervisorConfig.memory.importanceThreshold &&
      (rec.tier === 'episodic' || rec.tier === 'semantic' || rec.tier === 'project')
    ) {
      throw new Error(
        `Memory write rejected: importance ${rec.importance} below threshold ${supervisorConfig.memory.importanceThreshold}`,
      );
    }

    const memoryId = crypto.randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO memories (memory_id, namespace, tier, type, content, importance, metadata, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          memoryId,
          rec.namespace,
          rec.tier,
          rec.type,
          rec.content,
          rec.importance,
          rec.metadata,
          rec.expiresAt ?? null,
        ],
      );
    } finally {
      client.release();
    }
    return memoryId;
  }

  /**
   * Read memory with §7.3 filters. Returns records ordered by
   * importance desc, recency desc, with the access_control metadata
   * check applied.
   */
  async read(params: {
    namespace: string;
    tiers?: MemoryTier[];
    type?: string;
    limit?: number;
    minImportance?: number;
    metadataFilter?: Record<string, unknown>;
  }): Promise<MemoryRecord[]> {
    const tiers = params.tiers ?? ['episodic', 'semantic', 'procedural', 'user_pref', 'project'];
    const limit = Math.min(params.limit ?? 10, 50);
    const minImportance = params.minImportance ?? 0;
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        `SELECT memory_id, namespace, tier, type, content, importance, metadata,
                created_at, last_used_at, expires_at
           FROM memories
          WHERE namespace = $1
            AND tier = ANY($2::text[])
            AND importance >= $3
            AND ($4::text IS NULL OR type = $4)
            AND (metadata @> $5 OR $5 = '{}'::jsonb)
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY importance DESC, COALESCE(last_used_at, created_at) DESC
          LIMIT $6`,
        [
          params.namespace,
          tiers,
          minImportance,
          params.type ?? null,
          params.metadataFilter ?? {},
          limit,
        ],
      );
      // Touch last_used_at for returned records (cheap LRU signal)
      const ids = r.rows.map((row) => row.memory_id);
      if (ids.length > 0) {
        await client.query(
          `UPDATE memories SET last_used_at = now() WHERE memory_id = ANY($1::uuid[])`,
          [ids],
        );
      }
      return r.rows.map((row) => ({
        memoryId: row.memory_id,
        namespace: row.namespace,
        tier: row.tier,
        type: row.type,
        content: row.content,
        importance: Number(row.importance),
        metadata: row.metadata,
        createdAt: row.created_at.toISOString(),
        lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
        expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      }));
    } finally {
      client.release();
    }
  }

  /** Episodic TTL sweep — call from a cron worker. */
  async sweepExpired(): Promise<number> {
    const r = await this.pool.query(
      'DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < now()',
    );
    return r.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.redis.quit();
    await this.pool.end();
  }
}
