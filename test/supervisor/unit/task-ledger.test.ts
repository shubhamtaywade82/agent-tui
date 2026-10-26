/**
 * TaskLedger — Phase 1 chain invariants.
 *
 * These tests pin down the contract the orchestrator and the API rely
 * on: dependency ordering is enforced, no SUCCEEDED without a passing
 * ValidationReport, failTask cascades BLOCKED transitively, and the
 * audit event stream reflects every transition.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { TaskLedger } from '../../../src/supervisor/tasks/ledger.js';
import { InMemoryTaskStore } from '../../../src/supervisor/tasks/store.js';

describe('TaskLedger — chain invariants', () => {
  let store: InMemoryTaskStore;
  let ledger: TaskLedger;

  beforeEach(() => {
    store = new InMemoryTaskStore();
    ledger = new TaskLedger(store);
  });

  it('creates a root task in READY state (no dependencies to wait for)', async () => {
    const goal = await ledger.createGoal({
      title: 'Test goal',
      objective: 'Verify chain ordering',
    });
    const t = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'ANALYZE',
      title: 'First task',
      objective: 'Do the first thing',
    });
    expect(t.status).toBe('READY');
    expect(t.dependencies).toEqual([]);
  });

  it('creates a dependent task in PENDING state until its dependency SUCCEEDS', async () => {
    const goal = await ledger.createGoal({ title: 'G', objective: 'O' });
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
    expect(t2.status).toBe('PENDING');

    // List READY — only t1 should appear.
    const ready = await ledger.listReadyTasks(goal.goalId);
    expect(ready.map((t) => t.taskId)).toEqual([t1.taskId]);
  });

  it('does NOT allow committing a task whose active attempt has no passing validationReport', async () => {
    const goal = await ledger.createGoal({ title: 'G', objective: 'O' });
    const t = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'ANALYZE',
      title: 't',
      objective: 'first',
    });

    // Attempt without a passing validationReport.
    await ledger.appendAttempt(t.taskId, {
      taskId: t.taskId,
      modelUsed: 'minicpm5-analyst',
      proposalValid: false,
      outcome: 'FAILED_VALIDATION',
      latencyMs: 10,
    });

    await expect(
      ledger.commitTaskOutput(t.taskId, { answer: 'x' }, 'summary', [], []),
    ).rejects.toThrow(/validationReport.passed is false/);

    // The task is still not SUCCEEDED.
    const after = await ledger.getTask(t.taskId);
    expect(after?.status).not.toBe('SUCCEEDED');
  });

  it('commits a verified output, atomically unblocking dependents and updating goal head', async () => {
    const goal = await ledger.createGoal({ title: 'G', objective: 'O' });
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

    // Record a verified attempt on t1.
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
      latencyMs: 10,
    });

    // Commit t1's output — should atomically unblock t2.
    const committed = await ledger.commitTaskOutput(
      t1.taskId,
      { result: 'first done' },
      't1 produced first done',
      [],
      [],
    );
    expect(committed.status).toBe('SUCCEEDED');

    const afterGoal = await ledger.getGoal(goal.goalId);
    expect(afterGoal?.currentHeadTaskId).toBe(t1.taskId);
    expect(afterGoal?.succeededTaskCount).toBe(1);

    const t2after = await ledger.getTask(t2.taskId);
    expect(t2after?.status).toBe('READY');
  });

  it('failTask cascades BLOCKED transitively to all dependents', async () => {
    const goal = await ledger.createGoal({ title: 'G', objective: 'O' });
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

    await ledger.failTask(t1.taskId, 'irrecoverable');

    expect((await ledger.getTask(t1.taskId))?.status).toBe('FAILED');
    expect((await ledger.getTask(t2.taskId))?.status).toBe('BLOCKED');
    expect((await ledger.getTask(t3.taskId))?.status).toBe('BLOCKED');

    // Goal transitions to FAILED because all tasks are terminal and at
    // least one FAILED/BLOCKED.
    const goalAfter = await ledger.getGoal(goal.goalId);
    expect(goalAfter?.status).toBe('FAILED');
  });

  it('emits task_created, task_status_changed, task_output_committed, goal_status_changed events', async () => {
    const goal = await ledger.createGoal({
      title: 'G',
      objective: 'O',
      acceptanceCriteria: ['t1 SUCCEEDED'],
    });
    const t1 = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'ANALYZE',
      title: 't1',
      objective: 'first',
    });
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
    await ledger.commitTaskOutput(t1.taskId, { x: 1 }, 'done', [], []);

    const events = await ledger.listTaskEvents(goal.goalId);
    const types = events.map((e) => e.type);
    expect(types).toContain('goal_created');
    expect(types).toContain('task_created');
    expect(types.some((t) => t === 'task_status_changed')).toBe(true);
    expect(types).toContain('task_output_committed');
    expect(types).toContain('goal_status_changed');
    // The final goal_status_changed must transition to SUCCEEDED.
    const goalEvents = events.filter((e) => e.type === 'goal_status_changed');
    const finalGoalEvent = goalEvents.at(-1);
    expect(finalGoalEvent?.payload).toMatchObject({ to: 'SUCCEEDED' });
  });

  it('rejects createTask on a non-ACTIVE goal', async () => {
    const goal = await ledger.createGoal({ title: 'G', objective: 'O' });
    await ledger.failTask(
      (
        await ledger.createTask({
          goalId: goal.goalId,
          sequence: 0,
          type: 'ANALYZE',
          title: 't',
          objective: 'first',
        })
      ).taskId,
      'boom',
    );
    // Goal is now FAILED (all tasks terminal, one FAILED).
    const failedGoal = await ledger.getGoal(goal.goalId);
    expect(failedGoal?.status).toBe('FAILED');

    await expect(
      ledger.createTask({
        goalId: goal.goalId,
        sequence: 1,
        type: 'ANALYZE',
        title: 'should fail',
        objective: 'nope',
      }),
    ).rejects.toThrow(/FAILED/);
  });

  it('markRetrying transitions to RETRYING; fails terminally after maxAttempts', async () => {
    const goal = await ledger.createGoal({ title: 'G', objective: 'O' });
    const t = await ledger.createTask({
      goalId: goal.goalId,
      sequence: 0,
      type: 'ANALYZE',
      title: 't',
      objective: 'first',
      maxAttempts: 2,
    });
    await ledger.markRunning(t.taskId, crypto.randomUUID());
    await ledger.appendAttempt(t.taskId, {
      taskId: t.taskId,
      modelUsed: 'minicpm5-analyst',
      proposalValid: false,
      outcome: 'FAILED_VALIDATION',
      latencyMs: 1,
    });

    // attemptCount is 1; maxAttempts is 2; should retry.
    await ledger.markRetrying(t.taskId, 'attempt 1 failed');
    expect((await ledger.getTask(t.taskId))?.status).toBe('RETRYING');

    await ledger.markRunning(t.taskId, crypto.randomUUID());
    await ledger.appendAttempt(t.taskId, {
      taskId: t.taskId,
      modelUsed: 'minicpm5-analyst',
      proposalValid: false,
      outcome: 'FAILED_VALIDATION',
      latencyMs: 1,
    });

    // attemptCount is now 2 — equals maxAttempts. markRetrying must
    // fail terminally instead of retrying.
    await ledger.markRetrying(t.taskId, 'attempt 2 failed');
    expect((await ledger.getTask(t.taskId))?.status).toBe('FAILED');
  });
});
