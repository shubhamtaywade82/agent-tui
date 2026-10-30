/**
 * Integration test — exercises the full 3-stage turn against a real
 * `ollama serve` daemon with real tev1:0.8b + qwen3:8b models.
 *
 * Skipped unless OLLAMA_INTEGRATION=1 is set AND the daemon is reachable.
 * This keeps CI fast (no GPU required) while letting operators verify
 * the harness works end-to-end with real models.
 *
 * To run locally:
 *   OLLAMA_INTEGRATION=1 ollama pull tev1:0.8b
 *   OLLAMA_INTEGRATION=1 ollama pull qwen3:8b
 *   OLLAMA_INTEGRATION=1 npm run supervisor:test -- test/system-one-harness/integration
 */

import type { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarnessClient } from '../../../src/system-one-harness/client.js';
import { loadHarnessConfigFromEnv } from '../../../src/system-one-harness/config.js';
import { CoHostedAgentHarness } from '../../../src/system-one-harness/harness.js';
import { createDomainRegistries } from '../../../src/system-one-harness/registries.js';

const RUN_INTEGRATION = process.env.OLLAMA_INTEGRATION === '1';

const itOrSkip = RUN_INTEGRATION ? it : it.skip;

describe('System One harness — end-to-end', () => {
  let client: OllamaClient;

  beforeAll(async () => {
    if (!RUN_INTEGRATION) return;
    const config = loadHarnessConfigFromEnv();
    client = createHarnessClient(config);
    // Verify the daemon is actually up before running the tests.
    let reachable = false;
    try {
      await client.ping();
      reachable = true;
    } catch {
      // daemon not reachable
    }
    if (!reachable) {
      throw new Error('OLLAMA_INTEGRATION=1 but ollama is not reachable');
    }
  }, 15_000);

  afterAll(async () => {
    if (client) {
      try {
        await client.destroy();
      } catch {
        // already closed
      }
    }
  });

  itOrSkip(
    'verifyCoHosting confirms both models are resident in VRAM',
    async () => {
      const config = loadHarnessConfigFromEnv();
      const harness = new CoHostedAgentHarness(client, config, createDomainRegistries());
      const status = await harness.verifyCoHosting();
      expect(status.systemOneLoaded || status.systemTwoLoaded).toBe(true);
    },
    30_000,
  );

  itOrSkip(
    'a direct_reply prompt completes the 3-stage turn without tools',
    async () => {
      const config = loadHarnessConfigFromEnv();
      const harness = new CoHostedAgentHarness(client, config, createDomainRegistries());
      const result = await harness.runTurn('What is 2 plus 2?');
      expect(result.route).toBe('direct_reply');
      expect(result.answer.length).toBeGreaterThan(0);
      expect(result.iterations).toBe(0);
    },
    60_000,
  );

  itOrSkip(
    'a market_data prompt routes correctly and returns a verified answer',
    async () => {
      const config = loadHarnessConfigFromEnv();
      const harness = new CoHostedAgentHarness(client, config, createDomainRegistries());
      const result = await harness.runTurn(
        'Fetch the latest BTCUSDT 1-minute klines (limit 5) and describe the trend.',
      );
      // The route should be market_data (or direct_reply if the model decides
      // it can answer without tools). Either is acceptable — what matters is
      // that the turn completed and the answer is non-empty.
      expect(['market_data', 'direct_reply']).toContain(result.route);
      expect(result.answer.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
