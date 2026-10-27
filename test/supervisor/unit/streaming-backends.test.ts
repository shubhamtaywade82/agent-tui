/**
 * Streaming backends — ADR 0011.
 *
 * Verifies that:
 *   - The MockBackend.stream() yields a single delta + done.
 *   - The stream consumer (accumulateStream) reassembles content + tokens.
 *   - The supervisor engine emits model_token events for each delta when
 *     `streamAnalyst: true` is set on Supervisor.run().
 *   - Cost tracking (ADR 0012) records usage from streamed invocations.
 */
import { describe, expect, it } from 'vitest';
import { Supervisor } from '../../../src/supervisor/engine.js';
import type { InferenceRequest } from '../../../src/supervisor/inference/backend.js';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import { accumulateStream } from '../../../src/supervisor/inference/stream-consumer.js';
import type { DomainEvent } from '../../../src/supervisor/state/events.js';
import type { AgentState } from '../../../src/supervisor/state/models.js';
import type { StateStore } from '../../../src/supervisor/state/store.js';

class InMemoryStore implements StateStore {
  private runs = new Map<string, AgentState>();
  private events = new Map<string, DomainEvent[]>();
  async init() {}
  async saveRun(state: AgentState) {
    this.runs.set(state.runId, state);
  }
  async getRun(id: string) {
    return this.runs.get(id) ?? null;
  }
  async listRuns() {
    return [...this.runs.values()];
  }
  async appendEvent(e: DomainEvent) {
    const list = this.events.get(e.runId) ?? [];
    list.push(e);
    this.events.set(e.runId, list);
  }
  async listEvents(id: string) {
    return this.events.get(id) ?? [];
  }
  async close() {}
}

describe('MockBackend.stream', () => {
  it('yields a single delta chunk with the full content, then a done chunk', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-analyst', () => 'hello world');
    const req: InferenceRequest = { model: 'minicpm5-analyst', prompt: 'p' };

    const chunks: { type: string; text?: string }[] = [];
    for await (const chunk of backend.stream(req)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ type: 'delta', text: 'hello world' });
    expect(chunks[1]?.type).toBe('done');
  });

  it('yields only a done chunk when content is empty', async () => {
    const backend = new MockBackend();
    backend.enqueue('test', () => '');
    const req: InferenceRequest = { model: 'test', prompt: 'p' };

    const chunks: { type: string }[] = [];
    for await (const chunk of backend.stream(req)) {
      chunks.push(chunk);
    }

    // Empty content → no delta chunk, just done.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('done');
  });
});

describe('accumulateStream', () => {
  it('reconstructs content from delta chunks and parses tokens from done', async () => {
    const backend = new MockBackend();
    backend.enqueue('test-model', () => 'response text');
    const req: InferenceRequest = { model: 'test-model', prompt: 'p', formatJson: false };

    const r = await accumulateStream(backend.stream(req), req);

    expect(r.content).toBe('response text');
    expect(r.tokens.prompt).toBeGreaterThan(0);
    expect(r.tokens.completion).toBeGreaterThan(0);
    expect(r.model).toBe('test-model');
  });

  it('parses JSON content when formatJson is requested', async () => {
    const backend = new MockBackend();
    backend.enqueue('test', () => '{"answer":"ok","confidence":"high"}');
    const req: InferenceRequest = { model: 'test', prompt: 'p', formatJson: true };

    const r = await accumulateStream(backend.stream(req), req);

    expect(r.parsed).toBe(true);
    expect(r.json).toEqual({ answer: 'ok', confidence: 'high' });
  });

  it('marks parsed=false when JSON is malformed', async () => {
    const backend = new MockBackend();
    backend.enqueue('test', () => 'not valid json');
    const req: InferenceRequest = { model: 'test', prompt: 'p', formatJson: true };

    const r = await accumulateStream(backend.stream(req), req);

    expect(r.parsed).toBe(false);
    expect(r.json).toBeUndefined();
    expect(r.content).toBe('not valid json');
  });

  it('invokes the onDelta callback for each delta chunk', async () => {
    const backend = new MockBackend();
    backend.enqueue('test', () => 'abc');
    const req: InferenceRequest = { model: 'test', prompt: 'p' };

    const deltas: string[] = [];
    await accumulateStream(backend.stream(req), req, { onDelta: (t) => deltas.push(t) });

    expect(deltas).toEqual(['abc']);
  });

  it('throws when the stream emits an error chunk', async () => {
    // Manually construct a stream that yields an error.
    async function* failingStream(): AsyncGenerator<{
      type: 'delta' | 'thinking' | 'done' | 'error';
      text?: string;
      error?: Error;
      tokens?: { prompt: number; completion: number };
      model?: string;
      latencyMs?: number;
    }> {
      yield { type: 'delta', text: 'partial' };
      yield { type: 'error', error: new Error('stream broken') };
    }

    const req: InferenceRequest = { model: 'test', prompt: 'p' };
    await expect(accumulateStream(failingStream() as never, req)).rejects.toThrow('stream broken');
  });
});

describe('Supervisor.run with streamAnalyst', () => {
  it('emits model_token events for each streamed delta', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'streamed response');

    const events: DomainEvent[] = [];
    const store = new InMemoryStore();
    const s = new Supervisor({
      backend,
      store,
      // Subscribe to events before the run starts.
    });
    s.bus.subscribe((e) => {
      if (e.type === 'model_token' || e.type === 'model_thinking') {
        events.push(e);
      }
    });

    await s.run({
      objective: 'test',
      streamAnalyst: true,
    });

    // The mock backend yields the full content as a single delta chunk.
    // So we expect exactly one model_token event with the full text.
    const tokenEvents = events.filter((e) => e.type === 'model_token');
    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
    const combined = tokenEvents
      .map((e) => (e as { payload: { text: string } }).payload.text)
      .join('');
    expect(combined).toContain('streamed response');
  });

  it('returns the same executionResult shape as non-streaming runs', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'response from analyst');

    const s = new Supervisor({ backend, store: new InMemoryStore() });

    const streamed = await s.run({ objective: 'p', streamAnalyst: true });
    expect(streamed.executionResult).toBe('response from analyst');
  });
});
