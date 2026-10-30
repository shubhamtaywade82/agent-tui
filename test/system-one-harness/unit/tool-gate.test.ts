/**
 * Multi-axis tool-call gate. Tests the three gate outcomes:
 *   1. Approved — alignment high, injection low, blast radius below ceiling.
 *   2. Rejected — alignment below threshold (no human option).
 *   3. Human required — alignment high, no injection, but blast radius >= ceiling.
 *   4. Hard abort — injection probability exceeds the abort threshold (throws).
 *
 * Uses the SDK's createMockOllamaServer to serve /v1/systemone responses
 * with a responder that inspects the request's questions to route the
 * response correctly.
 */

import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { createMockOllamaServer } from '@nemesis-oss/ollama-sdk/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evaluateToolCallGate } from '../../../src/system-one-harness/tool-gate.js';

const MODEL = 'tev1:0.8b';

function makeServerWithGate(alignedNoul: number, injectionNoul: number, blastScore: number) {
  const server = createMockOllamaServer();
  server.register('/api/version', {
    rawBody: JSON.stringify({ version: '0.40.5' }),
    headers: { 'content-type': 'application/json' },
  });
  server.register('/v1/systemone', {
    rawBody: JSON.stringify({
      model: MODEL,
      answers: {
        is_aligned: { type: 'noul', noul: alignedNoul },
        injection_detected: { type: 'noul', noul: injectionNoul },
        blast_radius: {
          type: 'score',
          score: blastScore,
          legend: { '0': 'read-only', '1': 'temp write', '2': 'prod write' },
          probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 },
          confidence: 0.9,
        },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    headers: { 'content-type': 'application/json' },
  });
  return server;
}

describe('evaluateToolCallGate', () => {
  let server: ReturnType<typeof createMockOllamaServer>;
  let client: OllamaClient;

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('approves when alignment is high, injection is low, and blast radius is below the ceiling', async () => {
    server = makeServerWithGate(0.95, 0.05, 0.5);
    await server.start();
    client = new OllamaClient({ baseUrl: server.baseUrl });

    const result = await evaluateToolCallGate(
      client,
      MODEL,
      'fetch klines',
      'fetch_binance_klines',
      {
        symbol: 'BTCUSDT',
        interval: '1m',
        limit: 10,
      },
    );
    expect(result.approved).toBe(true);
    expect(result.riskScore).toBe(0.5);
    expect(result.alignmentProbability).toBeCloseTo(0.95);
    expect(result.injectionProbability).toBeCloseTo(0.05);
  });

  it('rejects when alignment is below the threshold', async () => {
    await server.stop();
    server = makeServerWithGate(0.4, 0.05, 0.5);
    await server.start();
    client = new OllamaClient({ baseUrl: server.baseUrl });

    const result = await evaluateToolCallGate(
      client,
      MODEL,
      'delete database',
      'fetch_binance_klines',
      {
        symbol: 'BTCUSDT',
      },
    );
    expect(result.approved).toBe(false);
    expect(result.requireHumanApproval).toBeUndefined();
    expect(result.reason).toContain('Low task alignment');
    expect(result.alignmentProbability).toBeCloseTo(0.4);
  });

  it('requires human approval when blast radius is at or above the ceiling but alignment is high', async () => {
    await server.stop();
    server = makeServerWithGate(0.9, 0.05, 1.8);
    await server.start();
    client = new OllamaClient({ baseUrl: server.baseUrl });

    const result = await evaluateToolCallGate(client, MODEL, 'place order', 'place_live_order', {
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: 0.1,
    });
    expect(result.approved).toBe(false);
    expect(result.requireHumanApproval).toBe(true);
    expect(result.riskScore).toBe(1.8);
  });

  it('hard-aborts (throws) when injection probability exceeds the abort threshold', async () => {
    await server.stop();
    server = makeServerWithGate(0.9, 0.5, 0.5);
    await server.start();
    client = new OllamaClient({ baseUrl: server.baseUrl });

    await expect(
      evaluateToolCallGate(client, MODEL, 'normal task', 'some_tool', {
        payload: '; DROP TABLE users; --',
      }),
    ).rejects.toThrow('Security Gate Abort');
  });

  it('honours custom thresholds passed in options', async () => {
    await server.stop();
    // With default thresholds (alignment 0.8), 0.75 would be rejected.
    // Lower the threshold to 0.7 and it should be approved.
    server = makeServerWithGate(0.75, 0.05, 0.5);
    await server.start();
    client = new OllamaClient({ baseUrl: server.baseUrl });

    const result = await evaluateToolCallGate(
      client,
      MODEL,
      'task',
      'tool',
      { x: 1 },
      {
        alignmentRejectThreshold: 0.7,
      },
    );
    expect(result.approved).toBe(true);
  });
});
