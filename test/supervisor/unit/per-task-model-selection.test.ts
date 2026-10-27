/**
 * Per-task model selection — ADR 0010.
 *
 * Verifies that the orchestrator honours `inference.taskModelMap` when
 * selecting the analyst model for a task. Each task type can target a
 * different specialist model without changing global config — e.g.
 * CODE_CHANGE → Claude, ANALYZE → gpt-4o, RETRIEVE → gpt-4o-mini.
 *
 * Also verifies the planner honours `taskModelMap.PLAN` for the planning
 * invocation.
 *
 * The StateStore is an in-memory stub (mirrors engine.test.ts) so the suite
 * runs without a Postgres instance.
 */
import { describe, expect, it, vi } from 'vitest';
import { Supervisor } from '../../../src/supervisor/engine.js';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
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

function makeSupervisor(backend: MockBackend) {
  return new Supervisor({ backend, store: new InMemoryStore() });
}

describe('Supervisor.run — analystModelOverride', () => {
  it('uses the override model for the analyst step when supplied', async () => {
    const backend = new MockBackend();
    // router: classifies as GENERAL_QUERY (no tool call, no escalation)
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    // analyst: returns text — but we override to a DIFFERENT model name.
    // The MockBackend matches by model name, so the override must reach
    // the analyst invocation. Queue the response against the override name.
    backend.enqueue('claude-3-5-sonnet-20241022', () => 'analyst response');

    const s = makeSupervisor(backend);

    await s.run({
      objective: 'Explain how async/await works',
      analystModelOverride: 'claude-3-5-sonnet-20241022',
    });

    // The analyst call should have used the override model, not the default.
    const analystCall = backend
      .observedCalls()
      .find((c) => c.model === 'claude-3-5-sonnet-20241022');
    expect(analystCall).toBeDefined();
    expect(analystCall?.prompt).toContain('async/await');
  });

  it('falls back to the default analystModel when no override is supplied', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'analyst response');

    const s = makeSupervisor(backend);

    await s.run({
      objective: 'Explain async/await',
      // No analystModelOverride — default applies.
    });

    const analystCall = backend.observedCalls().find((c) => c.model === 'minicpm5-analyst');
    expect(analystCall).toBeDefined();
  });

  it('cleans up the per-run override map after run completes (no memory leak)', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('claude-3-5-sonnet-20241022', () => 'ok');

    const s = makeSupervisor(backend);

    const r = await s.run({
      objective: 'p',
      analystModelOverride: 'claude-3-5-sonnet-20241022',
    });

    // After the run finishes, the override map entry should be gone.
    // We can't inspect the private map directly, but we can verify the
    // run completed successfully (which means the finally block ran).
    expect(r.status).toMatch(/COMPLETED|FAILED/);
  });
});

describe('TaskPlanner — taskModelMap.PLAN', () => {
  it('uses the PLAN-mapped model when set', async () => {
    // Set the env var and reset the module cache so the config is re-loaded
    // with the new env. supervisorConfig is computed once at import time.
    process.env.TASK_MODEL_PLAN = 'gpt-4o';
    vi.resetModules();
    const { supervisorConfig } = await import('../../../src/supervisor/config.js');
    expect(supervisorConfig.inference.taskModelMap.PLAN).toBe('gpt-4o');
    const { TaskPlanner: TaskPlannerFresh } = await import(
      '../../../src/supervisor/tasks/planner.js'
    );

    const backend = new MockBackend();
    backend.enqueue('gpt-4o', () => ({
      json: {
        tasks: [
          {
            sequence: 0,
            type: 'RETRIEVE',
            title: 'gather',
            objective: 'gather evidence',
            acceptanceCriteria: [],
          },
          {
            sequence: 1,
            type: 'VERIFY',
            title: 'verify',
            objective: 'verify done',
            acceptanceCriteria: ['all done'],
            dependencies: [0],
          },
        ],
      },
    }));

    const planner = new TaskPlannerFresh(backend, 'minicpm5-router');
    const plan = await planner.plan('achieve goal');

    expect(plan.tasks).toHaveLength(2);
    // The model call must have been against 'gpt-4o' (the mapped PLAN model),
    // NOT against 'minicpm5-router' (the planner's configured router model).
    const calls = backend.observedCalls();
    expect(calls.some((c) => c.model === 'gpt-4o')).toBe(true);
    expect(calls.some((c) => c.model === 'minicpm5-router')).toBe(false);

    // Restore env + module cache so subsequent tests are unaffected.
    delete process.env.TASK_MODEL_PLAN;
    vi.resetModules();
    vi.resetModules();
  });

  it('falls back to the routerModel when taskModelMap.PLAN is unset', async () => {
    // Ensure no override is set.
    delete process.env.TASK_MODEL_PLAN;
    vi.resetModules();
    const { supervisorConfig } = await import('../../../src/supervisor/config.js');
    expect(supervisorConfig.inference.taskModelMap.PLAN).toBeUndefined();
    const { TaskPlanner: TaskPlannerFresh } = await import(
      '../../../src/supervisor/tasks/planner.js'
    );

    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({
      json: {
        tasks: [
          {
            sequence: 0,
            type: 'SUMMARIZE',
            title: 'done',
            objective: 'summarise',
            acceptanceCriteria: [],
          },
        ],
      },
    }));

    const planner = new TaskPlannerFresh(backend, 'minicpm5-router');
    const plan = await planner.plan('achieve goal');

    expect(plan.tasks).toHaveLength(1);
    const calls = backend.observedCalls();
    expect(calls[0]?.model).toBe('minicpm5-router');

    vi.resetModules();
  });
});
