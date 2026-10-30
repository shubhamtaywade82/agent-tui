/**
 * CoHostedAgentHarness — the 3-stage turn controller.
 *
 * Scenarios:
 *   1. direct_reply route — bypasses the tool loop, answers directly.
 *   2. market_data route with a tool call — full 3-stage flow.
 *   3. verification failure — System 1 rejects the answer.
 *   4. low confidence routing — falls back to direct_reply.
 *
 * Uses the SDK's createMockOllamaServer with a responder on /v1/systemone
 * that inspects the question type to route the response (choice → route,
 * noul → verify).
 */

import { defineTool, OllamaClient, ToolRegistry } from '@nemesis-oss/ollama-sdk';
import { createMockOllamaServer } from '@nemesis-oss/ollama-sdk/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { HarnessConfig } from '../../../src/system-one-harness/config.js';
import { DEFAULT_CONFIG } from '../../../src/system-one-harness/config.js';
import {
  CoHostedAgentHarness,
  VerificationGateError,
} from '../../../src/system-one-harness/harness.js';
import type { DomainRoute } from '../../../src/system-one-harness/types.js';

const S1 = 'tev1:0.8b';
const S2 = 'qwen3:8b';

/** Build a config pinned to the mock's models. */
function pinnedConfig(overrides?: Partial<HarnessConfig>): HarnessConfig {
  return {
    ...DEFAULT_CONFIG,
    systemOneModel: S1,
    systemTwoModel: S2,
    systemOneCatalog: [S1],
    systemTwoCatalog: [S2],
    ...overrides,
  };
}

/** Build a registry with a simple echo tool (no network calls). */
function testRegistry(): ToolRegistry {
  const echo = defineTool({
    name: 'echo',
    description: 'Echo back the input text.',
    schema: z.object({ text: z.string() }),
    execute: async ({ text }) => ({ echoed: text }),
  });
  return new ToolRegistry([echo]);
}

interface MockSetup {
  readonly routeChoice: DomainRoute;
  readonly routeConfidence: number;
  readonly verifyNoul: number;
  readonly chatContent: string;
  readonly chatToolCalls?: unknown[];
}

/**
 * Stand up a mock server with the standard routes and a responder that
 * inspects /v1/systemone requests to return the right answer shape.
 */
function makeMockServer(setup: MockSetup) {
  const server = createMockOllamaServer();
  server.register('/api/version', {
    rawBody: JSON.stringify({ version: '0.40.5' }),
    headers: { 'content-type': 'application/json' },
  });
  server.register('/api/tags', {
    rawBody: JSON.stringify({ models: [{ name: S1 }, { name: S2 }] }),
    headers: { 'content-type': 'application/json' },
  });
  server.register('/api/ps', {
    rawBody: JSON.stringify({ models: [{ name: S1 }, { name: S2 }] }),
    headers: { 'content-type': 'application/json' },
  });
  // The Agent validates tool support via /api/show before starting the loop.
  server.register('/api/show', {
    rawBody: JSON.stringify({
      model: S2,
      details: {
        format: 'gguf',
        family: 'llama',
        parameter_size: '8B',
        quantization_level: 'Q4_0',
      },
      capabilities: ['tools', 'completion'],
    }),
    headers: { 'content-type': 'application/json' },
  });
  server.register('/v1/systemone', {
    responder: (record) => {
      const body = record.body as { questions: Record<string, { type: string }> };
      const q = body.questions.decision;
      if (!q) throw new Error('unexpected question shape');
      let answer: unknown;
      if (q.type === 'choice') {
        answer = {
          type: 'choice',
          choice: setup.routeChoice,
          probabilities: { market_data: 0.1, backtest: 0.1, direct_reply: 0.1 },
          confidence: setup.routeConfidence,
        };
      } else {
        // noul — used by verify()
        answer = { type: 'noul', noul: setup.verifyNoul };
      }
      return {
        rawBody: JSON.stringify({
          model: S1,
          answers: { decision: answer },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        headers: { 'content-type': 'application/json' },
      };
    },
  });
  server.register('/api/chat', {
    rawBody: JSON.stringify({
      model: S2,
      message: {
        role: 'assistant',
        content: setup.chatContent,
        ...(setup.chatToolCalls ? { tool_calls: setup.chatToolCalls } : {}),
      },
      done: true,
    }),
    headers: { 'content-type': 'application/json' },
  });
  return server;
}

describe('CoHostedAgentHarness', () => {
  let server: ReturnType<typeof createMockOllamaServer>;

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('routes to direct_reply and bypasses the tool loop + verification', async () => {
    server = makeMockServer({
      routeChoice: 'direct_reply',
      routeConfidence: 0.9,
      verifyNoul: 0,
      chatContent: 'General answer — no tools needed.',
    });
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const harness = new CoHostedAgentHarness(client, pinnedConfig(), {
      market_data: testRegistry(),
      backtest: testRegistry(),
    });
    const result = await harness.runTurn('What is 2+2?');
    expect(result.route).toBe('direct_reply');
    expect(result.answer).toBe('General answer — no tools needed.');
    expect(result.iterations).toBe(0);
    expect(result.verified).toBe(true);
    expect(result.verifyProbability).toBe(0);
  });

  it('runs the full 3-stage flow when routed to market_data (no tool calls)', async () => {
    await server.stop();
    server = makeMockServer({
      routeChoice: 'market_data',
      routeConfidence: 0.9,
      verifyNoul: 0.95,
      chatContent: 'BTC is trending up based on the klines.',
    });
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const harness = new CoHostedAgentHarness(client, pinnedConfig(), {
      market_data: testRegistry(),
      backtest: testRegistry(),
    });
    const result = await harness.runTurn('Fetch BTCUSDT klines and summarize.');
    expect(result.route).toBe('market_data');
    expect(result.routeConfident).toBe(true);
    expect(result.answer).toContain('BTC is trending up');
    expect(result.verified).toBe(true);
    expect(result.verifyProbability).toBeCloseTo(0.95);
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });

  it('throws VerificationGateError when System 1 rejects the answer', async () => {
    await server.stop();
    server = makeMockServer({
      routeChoice: 'market_data',
      routeConfidence: 0.9,
      verifyNoul: 0.3, // below the 0.85 threshold
      chatContent: 'I made up some numbers.',
    });
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const harness = new CoHostedAgentHarness(client, pinnedConfig(), {
      market_data: testRegistry(),
      backtest: testRegistry(),
    });
    await expect(harness.runTurn('Fetch klines.')).rejects.toThrow(VerificationGateError);
    try {
      await harness.runTurn('Fetch klines.');
    } catch (e) {
      expect(e).toBeInstanceOf(VerificationGateError);
      expect((e as VerificationGateError).probability).toBeCloseTo(0.3);
      expect((e as VerificationGateError).rejectedAnswer).toContain('made up');
    }
  });

  it('falls back to direct_reply when routing confidence is below the gate', async () => {
    await server.stop();
    server = makeMockServer({
      routeChoice: 'market_data', // model picked market_data
      routeConfidence: 0.3, // but with very low confidence
      verifyNoul: 0,
      chatContent: 'Low-confidence bypass answer.',
    });
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const harness = new CoHostedAgentHarness(client, pinnedConfig({ minRouteConfidence: 0.65 }), {
      market_data: testRegistry(),
      backtest: testRegistry(),
    });
    const result = await harness.runTurn('Ambiguous prompt.');
    expect(result.route).toBe('direct_reply');
    expect(result.routeConfident).toBe(false);
    expect(result.answer).toBe('Low-confidence bypass answer.');
  });

  it('verifyCoHosting reports which models are loaded', async () => {
    await server.stop();
    server = makeMockServer({
      routeChoice: 'direct_reply',
      routeConfidence: 0.9,
      verifyNoul: 0,
      chatContent: 'ok',
    });
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const harness = new CoHostedAgentHarness(client, pinnedConfig(), {
      market_data: testRegistry(),
      backtest: testRegistry(),
    });
    const status = await harness.verifyCoHosting();
    expect(status.systemOneLoaded).toBe(true);
    expect(status.systemTwoLoaded).toBe(true);
    expect(status.loaded).toContain(S1);
    expect(status.loaded).toContain(S2);
  });
});
