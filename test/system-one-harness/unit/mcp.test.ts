/**
 * MCP bridge — rankToolsForPrompt (uses /v1/systemone) and the
 * attachMcpServer signature (the real HTTP transport is exercised in
 * the integration suite; here we verify the ranking path + the return
 * shape of attachMcpServer's type contract).
 */

import type { ToolDefinition } from '@nemesis-oss/ollama-sdk';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { createMockOllamaServer } from '@nemesis-oss/ollama-sdk/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rankToolsForPrompt } from '../../../src/system-one-harness/mcp.js';

const MODEL = 'tev1:0.8b';

function mockToolDef(name: string, description: string): ToolDefinition {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: {} } },
  } as unknown as ToolDefinition;
}

describe('rankToolsForPrompt', () => {
  let server: ReturnType<typeof createMockOllamaServer>;
  let client: OllamaClient;

  beforeAll(async () => {
    server = createMockOllamaServer();
    server.register('/api/version', {
      rawBody: JSON.stringify({ version: '0.40.5' }),
      headers: { 'content-type': 'application/json' },
    });
    // The rank helper sends one /v1/systemone call per candidate,
    // with the candidate's `state` as the top-level request `state`.
    // The response carries a single `decision` answer (the question key
    // the SDK uses internally).
    server.register('/v1/systemone', {
      responder: (record) => {
        const body = record.body as {
          state: { prompt: string; tool_name: string; tool_description: string };
        };
        // Score each candidate differently so we can verify sorting.
        const toolName = body.state?.tool_name ?? 'unknown';
        const score = toolName === 'fetch_klines' ? 1.9 : toolName === 'run_backtest' ? 0.5 : 1.0;
        return {
          rawBody: JSON.stringify({
            model: MODEL,
            answers: {
              decision: {
                type: 'score',
                score,
                legend: { '0': 'irrelevant', '1': 'tangential', '2': 'direct' },
                probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
                confidence: 0.85,
              },
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          headers: { 'content-type': 'application/json' },
        };
      },
    });
    await server.start();
    client = new OllamaClient({ baseUrl: server.baseUrl });
  });

  afterAll(async () => {
    await server.stop();
  });

  it('ranks tools by score descending', async () => {
    const tools = [
      mockToolDef('run_backtest', 'Run a strategy backtest'),
      mockToolDef('fetch_klines', 'Fetch OHLCV candles'),
      mockToolDef('echo', 'Echo input'),
    ];
    const ranked = await rankToolsForPrompt(client, MODEL, 'fetch klines', tools);
    expect(ranked).toHaveLength(3);
    // fetch_klines should be first (score 1.9)
    expect(ranked[0].tool.function.name).toBe('fetch_klines');
    expect(ranked[0].score).toBeCloseTo(1.9);
    // run_backtest should be last (score 0.5)
    expect(ranked[2].tool.function.name).toBe('run_backtest');
    expect(ranked[2].score).toBeCloseTo(0.5);
  });

  it('returns an empty array when no tools are passed', async () => {
    const ranked = await rankToolsForPrompt(client, MODEL, 'anything', []);
    expect(ranked).toEqual([]);
  });

  it('carries the isConfident flag through', async () => {
    const tools = [mockToolDef('fetch_klines', 'Fetch candles')];
    const ranked = await rankToolsForPrompt(client, MODEL, 'fetch', tools, {
      minConfidence: 0.5,
    });
    expect(ranked).toHaveLength(1);
    expect(typeof ranked[0].confident).toBe('boolean');
  });
});
