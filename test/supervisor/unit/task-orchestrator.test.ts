/**
 * TaskOrchestrator — Phase 1 end-to-end chain advancement.
 *
 * Drives a 3-task linear chain through the existing Supervisor engine
 * (mocked backend) and asserts:
 *   - The chain advances only after each task's verification passes.
 *   - A failed task triggers retry, then terminal failure.
 *   - The next task sees the previous task's committed output in its
 *     objective context (the doubly-linked-list / chain-context
 *     property).
 *   - Restart reconciliation recovers a task left in RUNNING.
 */
import { describe, expect, it } from 'vitest';
import { Supervisor } from '../../../src/supervisor/engine.js';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import type { DomainEvent } from '../../../src/supervisor/state/events.js';
import type { AgentState } from '../../../src/supervisor/state/models.js';
import type { StateStore } from '../../../src/supervisor/state/store.js';
import { TaskLedger } from '../../../src/supervisor/tasks/ledger.js';
import { TaskOrchestrator } from '../../../src/supervisor/tasks/orchestrator.js';
import { InMemoryTaskStore } from '../../../src/supervisor/tasks/store.js';

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

describe('TaskOrchestrator — chain advancement', () => {
  it('advances a 3-task linear chain through the Supervisor engine, committing verified outputs', async () => {
    const backend = new MockBackend();
    // 3 tasks, each requiring a router call + an analyst call.
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'First task done. The answer is apple.');
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'Second task done. The answer is banana.');
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'Third task done. The answer is cherry.');

    const supervisor = makeSupervisor(backend);
    const taskStore = new InMemoryTaskStore();
    const ledger = new TaskLedger(taskStore);
    const orchestrator = new TaskOrchestrator(ledger, supervisor, taskStore);

    const goal = await ledger.createGoal({
      title: 'Three-step chain',
      objective: 'Demonstrate sequential chain advancement.',
      acceptanceCriteria: ['t1 SUCCEEDED', 't2 SUCCEEDED', 't3 SUCCEEDED'],
    });
    const t1 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'ANALYZE',
      title: 'Step 1',
      objective: 'Produce the first answer.',
    });
    const t2 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 1,
      type: 'ANALYZE',
      title: 'Step 2',
      objective: 'Produce the second answer, building on Step 1.',
      dependencies: [t1.taskId],
    });
    const t3 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 2,
      type: 'ANALYZE',
      title: 'Step 3',
      objective: 'Produce the third answer, building on Step 2.',
      dependencies: [t2.taskId],
    });

    // Advance one step at a time — each step should advance the chain
    // by exactly one task.
    const r1 = await orchestrator.advance(goal.goalId, { maxSteps: 1 });
    expect(r1.steps).toHaveLength(1);
    expect(r1.steps[0]?.advanced).toBe(true);
    expect((await ledger.getTask(t1.taskId))?.status).toBe('SUCCEEDED');

    const r2 = await orchestrator.advance(goal.goalId, { maxSteps: 1 });
    expect(r2.steps).toHaveLength(1);
    expect(r2.steps[0]?.advanced).toBe(true);
    expect((await ledger.getTask(t2.taskId))?.status).toBe('SUCCEEDED');

    const r3 = await orchestrator.advance(goal.goalId, { maxSteps: 1 });
    expect(r3.steps).toHaveLength(1);
    expect(r3.steps[0]?.advanced).toBe(true);
    expect((await ledger.getTask(t3.taskId))?.status).toBe('SUCCEEDED');

    // The goal itself is now SUCCEEDED because all tasks are terminal
    // and none FAILED/BLOCKED.
    const goalAfter = await ledger.getGoal(goal.goalId);
    expect(goalAfter?.status).toBe('SUCCEEDED');
    expect(goalAfter?.succeededTaskCount).toBe(3);

    // The chain-context property: t2's objective that was sent to the
    // Supervisor must include t1's committed output. Verify by inspecting
    // the MockBackend's observed calls — the second analyst call's
    // prompt must contain 'apple' (t1's output).
    const analystCalls = backend.observedCalls().filter((c) => c.model === 'minicpm5-analyst');
    expect(analystCalls.length).toBeGreaterThanOrEqual(3);
    expect(analystCalls[1]?.prompt).toContain('apple');
    expect(analystCalls[2]?.prompt).toContain('banana');
  });

  it('does NOT advance a chain when the active task fails verification', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'TOOL_EXECUTION' } }));
    // Unknown tool → repair loop exhausts → run ends in FAILED.
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'nonexistent_tool', arguments: {} },
    }));
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'nonexistent_tool', arguments: {} },
    }));
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'nonexistent_tool', arguments: {} },
    }));

    const supervisor = makeSupervisor(backend);
    const taskStore = new InMemoryTaskStore();
    const ledger = new TaskLedger(taskStore);
    const orchestrator = new TaskOrchestrator(ledger, supervisor, taskStore);

    const goal = await ledger.createGoal({ title: 'G', objective: 'O' });
    const t1 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'TOOL',
      title: 't1',
      objective: 'Call a nonexistent tool.',
      maxAttempts: 1, // fail terminally on the first failure
    });
    const t2 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 1,
      type: 'ANALYZE',
      title: 't2',
      objective: 'should never run',
      dependencies: [t1.taskId],
    });

    const r1 = await orchestrator.advance(goal.goalId, { maxSteps: 1 });
    expect(r1.steps).toHaveLength(1);
    expect(r1.steps[0]?.advanced).toBe(false);
    expect(r1.stoppedReason).toBe('task_failed');

    // t1 must be FAILED (maxAttempts=1 → terminal failure on first attempt).
    expect((await ledger.getTask(t1.taskId))?.status).toBe('FAILED');
    // t2 must be BLOCKED (transitive cascade).
    expect((await ledger.getTask(t2.taskId))?.status).toBe('BLOCKED');
    // Goal must be FAILED.
    const goalAfter = await ledger.getGoal(goal.goalId);
    expect(goalAfter?.status).toBe('FAILED');
  });

  it('reconciles a task left in RUNNING after a simulated restart', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'verified answer');

    const supervisor = makeSupervisor(backend);
    const taskStore = new InMemoryTaskStore();
    const ledger = new TaskLedger(taskStore);
    const orchestrator = new TaskOrchestrator(ledger, supervisor, taskStore);

    const goal = await ledger.createGoal({ title: 'G', objective: 'O' });
    const t1 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'ANALYZE',
      title: 't1',
      objective: 'first',
    });

    // Simulate a crash mid-run: mark t1 as RUNNING with a verified
    // attempt recorded but never committed.
    await ledger.markRunning(t1.taskId, crypto.randomUUID());
    await ledger.appendAttempt(t1.taskId, {
      taskId: t1.taskId,
      modelUsed: 'minicpm5-analyst',
      proposalValid: true,
      outcome: 'SUCCEEDED',
      validationReport: {
        passed: true,
        checks: [{ id: 'non-empty', required: true, status: 'PASSED', message: 'ok' }],
        failureCodes: [],
      },
      latencyMs: 1,
    });

    // Restart → reconcile.
    const recovery = await orchestrator.recover(goal.goalId);
    expect(recovery.reconciled).toContain(t1.taskId);

    // The verified-but-uncommitted attempt is now committed.
    const t1After = await ledger.getTask(t1.taskId);
    expect(t1After?.status).toBe('SUCCEEDED');
    expect(t1After?.outputSummary).toContain('reconciled');
  });

  it('advances multiple tasks in a single advance() call when maxSteps > 1', async () => {
    const backend = new MockBackend();
    for (let i = 0; i < 6; i++) {
      backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
      backend.enqueue('minicpm5-analyst', () => `Task ${i + 1} done.`);
    }

    const supervisor = makeSupervisor(backend);
    const taskStore = new InMemoryTaskStore();
    const ledger = new TaskLedger(taskStore);
    const orchestrator = new TaskOrchestrator(ledger, supervisor, taskStore);

    const goal = await ledger.createGoal({
      title: 'Bulk advance',
      objective: 'Run all 3 tasks in one call.',
    });
    const t1 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'ANALYZE',
      title: 't1',
      objective: 'first',
    });
    const t2 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 1,
      type: 'ANALYZE',
      title: 't2',
      objective: 'second',
      dependencies: [t1.taskId],
    });
    const t3 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 2,
      type: 'ANALYZE',
      title: 't3',
      objective: 'third',
      dependencies: [t2.taskId],
    });

    const r = await orchestrator.advance(goal.goalId, { maxSteps: 5 });
    expect(r.steps).toHaveLength(3);
    expect(r.stoppedReason).toBe('goal_terminal');
    expect((await ledger.getTask(t1.taskId))?.status).toBe('SUCCEEDED');
    expect((await ledger.getTask(t2.taskId))?.status).toBe('SUCCEEDED');
    expect((await ledger.getTask(t3.taskId))?.status).toBe('SUCCEEDED');
  });

  it('builds an objective that includes the previous task outputs as chain context', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'step 1 result: the meaning is 42');
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'step 2 result: confirmed');

    const supervisor = makeSupervisor(backend);
    const taskStore = new InMemoryTaskStore();
    const ledger = new TaskLedger(taskStore);
    const orchestrator = new TaskOrchestrator(ledger, supervisor, taskStore);

    const goal = await ledger.createGoal({
      title: 'Chain context',
      objective: 'Verify the orchestrator injects previous outputs.',
    });
    const t1 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'ANALYZE',
      title: 'Step A',
      objective: 'Compute the meaning of life.',
    });
    const _t2 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 1,
      type: 'ANALYZE',
      title: 'Step B',
      objective: 'Confirm Step A.',
      dependencies: [t1.taskId],
    });

    await orchestrator.advance(goal.goalId, { maxSteps: 2 });

    // The second analyst call (Step B) must include Step A's output
    // summary in its prompt — the doubly-linked-list / chain-context
    // property.
    const analystCalls = backend.observedCalls().filter((c) => c.model === 'minicpm5-analyst');
    expect(analystCalls[1]?.prompt).toContain('the meaning is 42');
  });
});
