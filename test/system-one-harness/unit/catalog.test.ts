/**
 * Catalog + auto-pick logic — pure unit tests for pickFirstAvailable and
 * NoModelAvailableError, plus mock-server-backed tests for listLocalModels
 * and resolveModels.
 */

import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { createMockOllamaServer } from '@nemesis-oss/ollama-sdk/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  listLocalModels,
  NoModelAvailableError,
  pickFirstAvailable,
  resolveModels,
} from '../../../src/system-one-harness/catalog.js';

describe('catalog', () => {
  describe('pickFirstAvailable (pure)', () => {
    it('returns the first catalog entry that is locally available', () => {
      expect(
        pickFirstAvailable(['tev1:0.8b', 'qwen2.5:1.5b'], ['qwen2.5:1.5b', 'llama3.2:1b']),
      ).toBe('qwen2.5:1.5b');
    });

    it('walks the catalog in order, not the available list', () => {
      expect(pickFirstAvailable(['phi3.5:3.8b', 'tev1:0.8b'], ['tev1:0.8b', 'phi3.5:3.8b'])).toBe(
        'phi3.5:3.8b',
      );
    });

    it('throws NoModelAvailableError when nothing matches', () => {
      expect(() => pickFirstAvailable(['tev1:0.8b'], ['qwen3:8b'])).toThrow(NoModelAvailableError);
    });

    it('the error message lists the exact ollama pull commands', () => {
      try {
        pickFirstAvailable(['tev1:0.8b', 'qwen2.5:1.5b'], ['qwen3:8b']);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(NoModelAvailableError);
        expect((e as Error).message).toContain('ollama pull tev1:0.8b');
        expect((e as Error).message).toContain('ollama pull qwen2.5:1.5b');
      }
    });
  });

  describe('listLocalModels + resolveModels (mock server)', () => {
    let server: ReturnType<typeof createMockOllamaServer>;
    let client: OllamaClient;

    beforeAll(async () => {
      server = createMockOllamaServer();
      server.register('/api/version', {
        rawBody: JSON.stringify({ version: '0.40.5' }),
        headers: { 'content-type': 'application/json' },
      });
      server.register('/api/ps', {
        rawBody: JSON.stringify({
          models: [{ name: 'tev1:0.8b' }, { name: 'qwen3:8b' }],
        }),
        headers: { 'content-type': 'application/json' },
      });
      await server.start();
      client = new OllamaClient({ baseUrl: server.baseUrl });
    });

    afterAll(async () => {
      await server.stop();
    });

    it('listLocalModels returns the model names from /api/ps', async () => {
      const names = await listLocalModels(client);
      expect(names).toEqual(['tev1:0.8b', 'qwen3:8b']);
    });

    it('resolveModels auto-picks S1 from the catalog and S2 from the catalog', async () => {
      const { systemOne, systemTwo } = await resolveModels(client, {
        systemOneCatalog: ['tev1:0.8b', 'qwen2.5:1.5b'],
        systemTwoCatalog: ['qwen3:8b', 'deepseek-coder:6.7b'],
      });
      expect(systemOne).toBe('tev1:0.8b');
      expect(systemTwo).toBe('qwen3:8b');
    });

    it('resolveModels honors pinned overrides', async () => {
      const { systemOne, systemTwo } = await resolveModels(client, {
        systemOneModel: 'tev1:0.8b',
        systemOneCatalog: ['qwen2.5:1.5b'],
        systemTwoModel: 'qwen3:8b',
        systemTwoCatalog: ['deepseek-coder:6.7b'],
      });
      expect(systemOne).toBe('tev1:0.8b');
      expect(systemTwo).toBe('qwen3:8b');
    });

    it('resolveModels walks past unavailable catalog entries', async () => {
      const { systemOne } = await resolveModels(client, {
        // tev1:0.8b is NOT in the mock's /api/ps; qwen3:8b IS (but it's an S2 model)
        systemOneCatalog: ['qwen2.5:1.5b', 'tev1:0.8b'],
        systemTwoCatalog: ['qwen3:8b'],
      });
      expect(systemOne).toBe('tev1:0.8b');
    });

    it('resolveModels throws when no S2 catalog model is available', async () => {
      await expect(
        resolveModels(client, {
          systemOneCatalog: ['tev1:0.8b'],
          systemTwoCatalog: ['gpt-4o', 'claude-3-5-sonnet'],
        }),
      ).rejects.toThrow(NoModelAvailableError);
    });
  });

  describe('listLocalModels resilience', () => {
    it('returns an empty array when the daemon is unreachable', async () => {
      const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:1' });
      const names = await listLocalModels(client);
      expect(names).toEqual([]);
    });
  });
});
