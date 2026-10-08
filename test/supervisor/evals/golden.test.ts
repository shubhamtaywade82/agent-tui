/**
 * Golden task evals — §15.3.
 *
 * Runs each golden task against the MockBackend (no GPU required) and
 * asserts the supervisor's behaviour matches the recorded expectations.
 * This is the regression suite — change a prompt or a router rule and
 * this file tells you what broke.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Supervisor } from '../../../src/supervisor/engine.js';
import { type GoldenTask, GoldenTaskSuite } from '../../../src/supervisor/evals/golden.js';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import type { DomainEvent } from '../../../src/supervisor/state/events.js';
import type { AgentState } from '../../../src/supervisor/state/models.js';
import type { StateStore } from '../../../src/supervisor/state/store.js';

/** Look up a golden task, failing loudly if the id drifts out of the suite. */
function mustById(suite: GoldenTaskSuite, id: string): GoldenTask {
  const task = suite.byId(id);
  if (!task) throw new Error(`golden task not found: ${id}`);
  return task;
}

/** In-memory StateStore so evals don't need a Postgres instance. */
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

describe('Golden task evals', () => {
  const suite = new GoldenTaskSuite();

  function makeSupervisor(backend: MockBackend) {
    const store = new InMemoryStore();
    return new Supervisor({ backend, store });
  }

  it('qa-001: simple Q&A routes to analyst and answers', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'The capital of France is Paris. [e1]');
    const s = makeSupervisor(backend);
    const task = mustById(suite, 'qa-001');
    const r = await s.run({ objective: task.query });
    expect(r.intent).toBe('GENERAL_QUERY');
    expect(r.finalResponse?.toLowerCase()).toContain('paris');
    expect(r.status).toBe('COMPLETED');
  });

  it('sum-001: log summarisation routes to summarizer', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'LOG_SUMMARIZATION' } }));
    backend.enqueue('minicpm5-summarizer', () => '## Summary\nDB connection issue with retries.');
    const s = makeSupervisor(backend);
    const task = mustById(suite, 'sum-001');
    const r = await s.run({ objective: task.query });
    expect(r.intent).toBe('LOG_SUMMARIZATION');
    expect(r.finalResponse).toContain('DB');
    expect(r.status).toBe('COMPLETED');
  });

  it('review-001: security-sensitive code review engages think mode', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'CODE_REVIEW' } }));
    backend.enqueue('minicpm5-analyst', () => 'This is a SQL injection vulnerability.');
    const s = makeSupervisor(backend);
    const task = mustById(suite, 'review-001');
    const r = await s.run({ objective: task.query });
    expect(r.intent).toBe('CODE_REVIEW');
    expect(r.thinkMode).toBe('think');
    expect(r.finalResponse?.toLowerCase()).toContain('sql');
  });

  it('tool-001: tool execution produces a simulated tool call', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'TOOL_EXECUTION' } }));
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'get_pipeline_status', arguments: { service: 'checkout-service' } },
    }));
    const s = makeSupervisor(backend);
    // Register the tool so validation passes; no execute hook means the
    // supervisor emits a SIMULATED_SUCCESS string.
    s.registry.register({
      name: 'get_pipeline_status',
      description: 'Check the status of a CI/CD pipeline.',
      parametersSchema: z.object({ service: z.string() }),
      permissions: [],
      riskLevel: 'low',
      timeoutMs: 5000,
    });
    const task = mustById(suite, 'tool-001');
    const r = await s.run({ objective: task.query });
    expect(r.intent).toBe('TOOL_EXECUTION');
    expect(r.finalResponse).toMatch(/SIMULATED_SUCCESS|get_pipeline_status/);
  });

  it('unknown-001: ambiguous query collapses to UNKNOWN intent', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => 'I have no idea');
    backend.enqueue('minicpm5-analyst', () => 'Could you clarify your request?');
    const s = makeSupervisor(backend);
    const task = mustById(suite, 'unknown-001');
    const r = await s.run({ objective: task.query });
    expect(r.intent).toBe('UNKNOWN');
    expect(r.thinkMode).toBe('think'); // unknown intent always uses think
  });

  it('repair-001: invalid tool args trigger the repair loop', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'TOOL_EXECUTION' } }));
    // First call produces invalid args (missing required fields)
    backend.enqueue('minicpm5-toolagent', () => ({ json: { tool: 'send_email', arguments: {} } }));
    // Repair call produces valid args
    backend.enqueue('minicpm5-toolagent', () => ({
      json: {
        tool: 'send_email',
        arguments: { to: 'team@example.com', subject: 'deploy', body: 'failed' },
      },
    }));
    const s = makeSupervisor(backend);
    const r = await s.run({ objective: 'Send an email to the team about the failed deployment.' });
    expect(r.intent).toBe('TOOL_EXECUTION');
    // Even if the tool isn't registered, the repair loop should have been
    // invoked (metrics captured) and the run should still complete.
    expect(s.metrics.snapshot().repairLoopInvocations).toBeGreaterThan(0);
  });

  it('runs every task in the suite without throwing', async () => {
    // Smoke test: every task should at least reach a terminal state.
    for (const task of suite.all()) {
      const backend = new MockBackend();
      backend.enqueue('minicpm5-router', () => ({ json: { intent: task.expectedIntent } }));
      backend.enqueue('minicpm5-analyst', () => 'OK');
      backend.enqueue('minicpm5-summarizer', () => 'OK');
      backend.enqueue('minicpm5-toolagent', () => ({ json: { tool: '', arguments: {} } }));
      const s = makeSupervisor(backend);
      const r = await s.run({ objective: task.query });
      expect(['COMPLETED', 'FAILED', 'ESCALATED']).toContain(r.status);
    }
  });
});
