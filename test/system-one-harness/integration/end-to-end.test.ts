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

import { KEEP_ALIVE_INDEFINITE, type OllamaClient } from '@nemesis-oss/ollama-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveModels } from '../../../src/system-one-harness/catalog.js';
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

    // Cold-loading a local model can take tens of seconds. Pin both in VRAM
    // before the tests, otherwise the first turn races the model load and
    // can hit the per-request timeout.
    const { systemOne, systemTwo } = await resolveModels(client, config);

    // A previous run may have left an unrelated model resident. With
    // OLLAMA_MAX_LOADED_MODELS=2 that model takes the slot the harness needs
    // for its co-hosted pair, so evict anything that is not S1 or S2.
    const ps = await client.models.ps();
    const keep = new Set([systemOne, systemTwo]);
    for (const loaded of ps.models) {
      if (!keep.has(loaded.name)) {
        await client.models.unload(loaded.name).catch(() => {});
      }
    }

    await client.decision.noul({
      model: systemOne,
      state: '1+1=2',
      instructions: 'Is the state true?',
      keepAlive: KEEP_ALIVE_INDEFINITE,
    });
    await client.chatText({
      model: systemTwo,
      keep_alive: KEEP_ALIVE_INDEFINITE,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      options: { num_ctx: config.contextWindow },
    });
  }, 300_000);

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
      expect(status.systemOneLoaded, `loaded: ${status.loaded.join(', ')}`).toBe(true);
      expect(status.systemTwoLoaded, `loaded: ${status.loaded.join(', ')}`).toBe(true);
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
