/**
 * Cost tracking in the supervisor engine — ADR 0012.
 *
 * Verifies that:
 *   - The engine records cost after each model invocation.
 *   - The model_invoked event payload includes costUsd.
 *   - BudgetExceededError transitions the run to FAILED.
 */
import { describe, expect, it } from 'vitest';
import { Supervisor } from '../../../src/supervisor/engine.js';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import {
  BudgetExceededError,
  CostTracker,
} from '../../../src/supervisor/observability/cost-tracker.js';
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

describe('Supervisor engine — cost tracking integration', () => {
  it('records cost after the analyst step and surfaces it on model_invoked', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'response');

    const events: DomainEvent[] = [];
    const costTracker = new CostTracker();
    const s = new Supervisor({
      backend,
      store: new InMemoryStore(),
      costTracker,
    });
    s.bus.subscribe((e) => {
      if (e.type === 'model_invoked') events.push(e);
    });

    await s.run({ objective: 'p', goalId: 'goal-1' });

    // The mock backend models are 0-cost, but the event should still carry
    // the cumulative costUsd field (= 0 for MiniCPM5 variants).
    const modelInvoked = events.find((e) => e.type === 'model_invoked');
    expect(modelInvoked).toBeDefined();
    expect(modelInvoked?.payload).toHaveProperty('costUsd');
    expect((modelInvoked as { payload: { costUsd?: number } } | undefined)?.payload?.costUsd).toBe(
      0,
    );
  });

  it('records positive cost for a priced model', async () => {
    const backend = new MockBackend();
    // Use a priced model name (gpt-4o-mini: $0.15/1M input + $0.60/1M output)
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('gpt-4o-mini', () => 'response');

    const events: DomainEvent[] = [];
    const costTracker = new CostTracker();
    const s = new Supervisor({
      backend,
      store: new InMemoryStore(),
      costTracker,
    });
    s.bus.subscribe((e) => {
      if (e.type === 'model_invoked') events.push(e);
    });

    await s.run({ objective: 'p', analystModelOverride: 'gpt-4o-mini' });

    const modelInvoked = events.find((e) => e.type === 'model_invoked');
    expect(modelInvoked).toBeDefined();
    const cost =
      (modelInvoked as { payload: { costUsd?: number } } | undefined)?.payload?.costUsd ?? 0;
    // The mock's token accounting uses len(prompt)/4 and len(content)/4.
    // Even a short prompt produces some tokens, so cost should be > 0.
    expect(cost).toBeGreaterThan(0);
  });

  it('aborts the run when the budget is exceeded', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    // gpt-4o-mini: $0.15/1M input + $0.60/1M output
    // The mock's token estimate is prompt.length / 4. Use a large prompt
    // to trigger the cap on the first call.
    backend.enqueue('gpt-4o-mini', () => 'response');

    // Cap: $0.0001 per run — definitely exceeded by any priced model call.
    const costTracker = new CostTracker(0.0001);
    const s = new Supervisor({
      backend,
      store: new InMemoryStore(),
      costTracker,
    });

    const bigPrompt = 'x'.repeat(10_000);
    const r = await s.run({
      objective: bigPrompt,
      analystModelOverride: 'gpt-4o-mini',
    });

    // The run should fail with BudgetExceededError recorded in errorTrace.
    expect(r.status).toBe('FAILED');
    expect(r.errorTrace.some((e) => e.includes('budget exceeded'))).toBe(true);
  });

  it('does not throw on local MiniCPM5 variants (0-cost)', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'response');

    // Tight cap: $0.0001. MiniCPM5 is 0-cost so should NOT trip the cap.
    const costTracker = new CostTracker(0.0001);
    const s = new Supervisor({
      backend,
      store: new InMemoryStore(),
      costTracker,
    });

    const r = await s.run({ objective: 'p' });

    expect(r.status).not.toBe('FAILED');
    expect(r.errorTrace.some((e) => e.includes('budget exceeded'))).toBe(false);
  });

  it('wouldExceedGoalBudget can be inspected before a costly task', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('gpt-4o-mini', () => 'response');

    const costTracker = new CostTracker(Number.POSITIVE_INFINITY, /* per-goal cap */ 0.001);
    const s = new Supervisor({
      backend,
      store: new InMemoryStore(),
      costTracker,
    });

    await s.run({
      objective: 'p',
      analystModelOverride: 'gpt-4o-mini',
      goalId: 'goal-1',
    });

    // The first run recorded some cost against goal-1.
    const snapshot = costTracker.getGoalCost('goal-1');
    expect(snapshot.totalCostUsd).toBeGreaterThan(0);
    expect(costTracker.wouldExceedGoalBudget('goal-1', 0.01)).toBe(true);
  });

  it('exposes BudgetExceededError class for downstream consumers', () => {
    expect(BudgetExceededError).toBeDefined();
    const err = new BudgetExceededError('run', undefined, 'r1', 1.5, 1.0, 'gpt-4o');
    expect(err.message).toContain('budget exceeded');
    expect(err.message).toContain('gpt-4o');
    expect(err.scope).toBe('run');
    expect(err.spentUsd).toBe(1.5);
    expect(err.capUsd).toBe(1.0);
  });
});
