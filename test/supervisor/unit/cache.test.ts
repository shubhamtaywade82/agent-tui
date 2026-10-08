/**
 * Cache service — Part 1 §11 (Cache Retrieval and Prompt Results).
 */

import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheService } from '../../../src/supervisor/context/cache.js';

// Use a real Redis if TEST_REDIS_URL is set; otherwise skip.
// In CI without a Redis service, these tests are skipped.
const REDIS_URL =
  process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379/15';
const SKIP = !process.env.TEST_REDIS_URL;

describe.skipIf(SKIP)('CacheService', () => {
  let redis: Redis;
  let cache: CacheService;

  beforeEach(async () => {
    redis = new Redis(REDIS_URL);
    await redis.flushdb();
    cache = new CacheService(redis);
  });

  afterEach(async () => {
    await cache.close();
  });

  it('round-trips a prompt prefix', async () => {
    const prefix = 'You are the MiniCPM5 analyst.\n\nTools:\n- read_file\n';
    await cache.setPromptPrefix(prefix, 60);
    const got = await cache.getPromptPrefix(prefix);
    expect(got).toBe(prefix);
  });

  it('returns null for a missing prompt prefix', async () => {
    const got = await cache.getPromptPrefix('nonexistent prefix');
    expect(got).toBeNull();
  });

  it('round-trips a generation result', async () => {
    const prompt = 'What is 2+2?';
    await cache.setGeneration({ model: 'minicpm5-analyst', prompt, output: '4' });
    const got = await cache.getGeneration({ model: 'minicpm5-analyst', prompt });
    expect(got).toBe('4');
  });

  it('distinguishes generations by options hash', async () => {
    const prompt = 'Hello';
    await cache.setGeneration({ model: 'm', prompt, output: 'cold', optionsHash: 'temp0' });
    await cache.setGeneration({ model: 'm', prompt, output: 'creative', optionsHash: 'temp7' });
    expect(await cache.getGeneration({ model: 'm', prompt, optionsHash: 'temp0' })).toBe('cold');
    expect(await cache.getGeneration({ model: 'm', prompt, optionsHash: 'temp7' })).toBe(
      'creative',
    );
  });

  it('invalidatePattern deletes matching keys', async () => {
    await cache.setPromptPrefix('prefix-a', 60);
    await cache.setPromptPrefix('prefix-b', 60);
    await cache.setGeneration({ model: 'm', prompt: 'p1', output: 'o1' });
    const deleted = await cache.invalidatePattern('prompt_prefix:*');
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await cache.getPromptPrefix('prefix-a')).toBeNull();
  });
});
