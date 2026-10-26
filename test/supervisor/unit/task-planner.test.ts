/**
 * TaskPlanner — Phase 3 auto-decomposition invariants.
 *
 * These tests pin down the contract the route handler and the
 * orchestrator rely on: schema-invalid output is rejected, free-form
 * text is never silently accepted, the configured bounds are enforced
 * post-parse, and the repair path produces a valid plan when the model
 * emits one on the second attempt.
 *
 * All tests use the MockBackend so no real Ollama daemon is needed.
 */
import { describe, expect, it } from 'vitest';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import {
  PlannedTaskSchema,
  PlanSchema,
  TaskPlanner,
  TaskPlannerError,
} from '../../../src/supervisor/tasks/planner.js';

describe('TaskPlanner — schema validation', () => {
  it('accepts a valid plan and returns it unchanged', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({
      json: {
        tasks: [
          {
            type: 'RETRIEVE',
            title: 'Find files',
            objective: 'List relevant files.',
            dependencies: [],
          },
          {
            type: 'ANALYZE',
            title: 'Analyse',
            objective: 'Reason over the files.',
            dependencies: [0],
          },
          {
            type: 'VERIFY',
            title: 'Verify',
            objective: 'Confirm acceptance criteria.',
            dependencies: [1],
          },
        ],
      },
    }));
    const planner = new TaskPlanner(backend, 'minicpm5-router');

    const plan = await planner.plan('Add an authenticated endpoint.');

    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks[0]?.type).toBe('RETRIEVE');
    expect(plan.tasks[1]?.dependencies).toEqual([0]);
    expect(plan.tasks[2]?.type).toBe('VERIFY');
    // The model was invoked exactly once (happy path, no repair).
    expect(backend.observedCalls()).toHaveLength(1);
  });

  it('rejects free-form text output with TaskPlannerError', async () => {
    const backend = new MockBackend();
    // Two free-text responses — the planner will try once + one repair.
    backend.enqueue('minicpm5-router', () => 'I think you should do the thing.');
    backend.enqueue('minicpm5-router', () => 'Still not JSON, sorry.');

    const planner = new TaskPlanner(backend, 'minicpm5-router');

    await expect(planner.plan('Add an endpoint.')).rejects.toBeInstanceOf(TaskPlannerError);
    // Both attempts were made.
    expect(backend.observedCalls()).toHaveLength(2);
  });

  it('rejects a plan with an invalid TaskType', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({
      json: {
        tasks: [{ type: 'NOT_A_REAL_TYPE', title: 'x', objective: 'y', dependencies: [] }],
      },
    }));
    backend.enqueue('minicpm5-router', () => ({
      json: {
        tasks: [{ type: 'ANALYZE', title: 'ok', objective: 'valid', dependencies: [] }],
      },
    }));

    const planner = new TaskPlanner(backend, 'minicpm5-router');

    const plan = await planner.plan('Do the thing.');
    // Repair succeeded.
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.type).toBe('ANALYZE');
  });

  it('rejects a plan that exceeds maxTasksPerGoal', async () => {
    const backend = new MockBackend();
    // Emit 25 tasks; cap is 20 (default).
    const tasks = Array.from({ length: 25 }, (_, i) => ({
      type: 'ANALYZE',
      title: `t${i}`,
      objective: 'x',
      dependencies: [],
    }));
    backend.enqueue('minicpm5-router', () => ({ json: { tasks } }));
    // Repair also over-budget.
    backend.enqueue('minicpm5-router', () => ({ json: { tasks } }));

    const planner = new TaskPlanner(backend, 'minicpm5-router');

    await expect(planner.plan('Huge goal.')).rejects.toThrow(/cap is 20/);
  });

  it('rejects a plan with a forward dependency reference', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({
      json: {
        tasks: [
          // Task 0 depends on task 1 — forward reference forbidden.
          { type: 'ANALYZE', title: 'a', objective: 'x', dependencies: [1] },
          { type: 'ANALYZE', title: 'b', objective: 'y', dependencies: [] },
        ],
      },
    }));
    backend.enqueue('minicpm5-router', () => ({
      json: {
        tasks: [
          { type: 'ANALYZE', title: 'a', objective: 'x', dependencies: [] },
          { type: 'ANALYZE', title: 'b', objective: 'y', dependencies: [0] },
        ],
      },
    }));

    const planner = new TaskPlanner(backend, 'minicpm5-router');

    const plan = await planner.plan('Two-step chain.');
    expect(plan.tasks[1]?.dependencies).toEqual([0]);
  });

  it('rejects a plan whose dependency depth exceeds maxDepth', async () => {
    const backend = new MockBackend();
    // A linear chain of 6 tasks — depth 6, exceeds default maxDepth=5.
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      type: 'ANALYZE',
      title: `t${i}`,
      objective: 'x',
      dependencies: i === 0 ? [] : [i - 1],
    }));
    backend.enqueue('minicpm5-router', () => ({ json: { tasks } }));
    backend.enqueue('minicpm5-router', () => ({ json: { tasks } }));

    const planner = new TaskPlanner(backend, 'minicpm5-router');

    await expect(planner.plan('Deep chain.')).rejects.toThrow(/depth 6 exceeds cap 5/);
  });

  it('repairs a schema-invalid plan on the second attempt and returns the repaired plan', async () => {
    const backend = new MockBackend();
    // First attempt: missing required `objective` field.
    backend.enqueue('minicpm5-router', () => ({
      json: {
        tasks: [{ type: 'ANALYZE', title: 't', dependencies: [] }],
      },
    }));
    // Second attempt: valid.
    backend.enqueue('minicpm5-router', () => ({
      json: {
        tasks: [{ type: 'ANALYZE', title: 't', objective: 'fixed', dependencies: [] }],
      },
    }));

    const planner = new TaskPlanner(backend, 'minicpm5-router');

    const plan = await planner.plan('Repair me.');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.objective).toBe('fixed');
    // Two model invocations: original + one repair.
    expect(backend.observedCalls()).toHaveLength(2);
  });

  it('throws TaskPlannerError after maxRepairAttempts exhausted', async () => {
    const backend = new MockBackend();
    // Two invalid responses: original + 1 repair attempt (default
    // maxRepairAttempts=1). The planner consumes exactly 2 invocations.
    backend.enqueue('minicpm5-router', () => ({ json: { tasks: [{ type: 'BAD' }] } }));
    backend.enqueue('minicpm5-router', () => ({ json: { tasks: [{ type: 'BAD' }] } }));

    const planner = new TaskPlanner(backend, 'minicpm5-router');

    const err = (await planner.plan('Never works.').catch((e) => e)) as TaskPlannerError;
    expect(err).toBeInstanceOf(TaskPlannerError);
    expect(err.errors.length).toBeGreaterThan(0);
    expect(err.rawOutputs).toHaveLength(2);
  });

  it('includes acceptance criteria in the prompt when supplied', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({
      json: {
        tasks: [{ type: 'VERIFY', title: 'v', objective: 'check', dependencies: [] }],
      },
    }));

    const planner = new TaskPlanner(backend, 'minicpm5-router');

    await planner.plan('Build it.', {
      acceptanceCriteria: ['all tests pass', 'lint clean'],
    });

    const call = backend.observedCalls()[0];
    expect(call?.prompt).toContain('all tests pass');
    expect(call?.prompt).toContain('lint clean');
  });
});

describe('TaskPlanner — schema exports', () => {
  it('PlanSchema validates a minimal plan', () => {
    const r = PlanSchema.safeParse({
      tasks: [{ type: 'ANALYZE', title: 't', objective: 'o' }],
    });
    expect(r.success).toBe(true);
  });

  it('PlanSchema rejects an empty tasks array', () => {
    const r = PlanSchema.safeParse({ tasks: [] });
    expect(r.success).toBe(false);
  });

  it('PlannedTaskSchema applies defaults for dependencies and maxAttempts', () => {
    const r = PlannedTaskSchema.safeParse({
      type: 'ANALYZE',
      title: 't',
      objective: 'o',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dependencies).toEqual([]);
      expect(r.data.maxAttempts).toBe(3);
    }
  });
});
