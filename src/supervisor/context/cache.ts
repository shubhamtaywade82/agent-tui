/**
 * 4-layer cache — Part 1 §11 (Cache Retrieval and Prompt Results).
 *
 *   - embedding cache  (query text → embedding vector)
 *   - retrieval cache  (query + filters → chunk ids)
 *   - prompt cache     (system + tool prefix hash → cached prefix)
 *   - generation cache (prompt hash → model output)
 *
 * Backed by Redis. TTLs follow §11:
 *   - operational docs: short TTL (60s)
 *   - policy docs:      longer TTL (600s)
 *   - code indexes:     invalidate on file hash change
 *
 * The embedding cache and retrieval cache are also embedded directly into
 * HybridRetriever (§6) for call-site convenience; this module exposes the
 * prompt + generation caches that the engine itself consumes.
 */

import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { supervisorConfig } from '../config.js';

export interface CacheEntry<T> {
  value: T;
  createdAt: number;
  ttlSec: number;
}

export class CacheService {
  private readonly redis: Redis;

  constructor(redis?: Redis) {
    this.redis = redis ?? new Redis(supervisorConfig.redis.url);
  }

  // ─── Prompt prefix cache (§11) ──────────────────────────────────────────

  /**
   * Cache the deterministic prefix of a prompt (system + tool definitions +
   * output schema). The cache stores the *prefix string* keyed by its hash;
   * callers can reuse the prefix across calls and only send the variable
   * tail to the model. This pairs well with vLLM's automatic prefix
   * caching (APC) and SGLang's RadixAttention.
   */
  async getPromptPrefix(prefix: string): Promise<string | null> {
    const key = `prompt_prefix:${this.hash(prefix)}`;
    const v = await this.redis.get(key);
    return v ?? null;
  }

  async setPromptPrefix(prefix: string, ttlSec = 600): Promise<void> {
    const key = `prompt_prefix:${this.hash(prefix)}`;
    await this.redis.set(key, prefix, 'EX', ttlSec);
  }

  // ─── Generation cache (§11) ─────────────────────────────────────────────

  /**
   * Cache a model's response keyed by (model, prompt hash, options hash).
   * Only safe to use when temperature=0 and the model is deterministic.
   * The caller decides whether to bypass (e.g. for creative tasks).
   */
  async getGeneration(params: {
    model: string;
    prompt: string;
    optionsHash?: string;
  }): Promise<string | null> {
    const key = `gen:${params.model}:${this.hash(params.prompt)}:${params.optionsHash ?? 'default'}`;
    return this.redis.get(key);
  }

  async setGeneration(params: {
    model: string;
    prompt: string;
    output: string;
    optionsHash?: string;
    ttlSec?: number;
  }): Promise<void> {
    const key = `gen:${params.model}:${this.hash(params.prompt)}:${params.optionsHash ?? 'default'}`;
    await this.redis.set(key, params.output, 'EX', params.ttlSec ?? 3600);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  async invalidatePattern(pattern: string): Promise<number> {
    // SCAN-based delete to avoid blocking the Redis server with KEYS.
    let count = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) {
        await this.redis.del(...keys);
        count += keys.length;
      }
    } while (cursor !== '0');
    return count;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private hash(s: string): string {
    return createHash('sha256').update(s).digest('hex').slice(0, 16);
  }
}
