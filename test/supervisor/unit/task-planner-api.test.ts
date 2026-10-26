/**
 * Task-planner HTTP API — Phase 3 surface.
 *
 * Exercises the autoPlan flag on POST /v1/goals and the dedicated
 * POST /v1/goals/:id/plan endpoint via Fastify's inject() against
 * an in-memory task store + mock backend.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../../src/supervisor/api/server.js';
import { Supervisor } from '../../../src/supervisor/engine.js';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import type { DomainEvent } from '../../../src/supervisor/state/events.js';
import type { AgentState } from '../../../src/supervisor/state/models.js';
import type { StateStore } from '../../../src/supervisor/state/store.js';
import { TaskLedger } from '../../../src/supervisor/tasks/ledger.js';
import { TaskPlanner } from '../../../src/supervisor/tasks/planner.js';
import { InMemoryTaskStore } from '../../../src/supervisor/tasks/store.js';

const API_KEY = 'task-planner-test-key-0123456789';
const AUTH = { authorization: `Bearer ${API_KEY}` };

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

describe('Task-planner HTTP API', () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let backend: MockBackend;

  beforeAll(async () => {
    backend = new MockBackend();
    const supervisor = new Supervisor({ backend, store: new InMemoryStore() });
    const taskStore = new InMemoryTaskStore();
    const taskLedger = new TaskLedger(taskStore);
    const taskPlanner = new TaskPlanner(backend, 'minicpm5-router');

    app = await createServer({
      supervisor,
      store: new InMemoryStore(),
      apiKey: API_KEY,
      taskLedger,
      taskPlanner,
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('POST /v1/goals with autoPlan=true invokes the planner and creates the emitted tasks', async () => {
    backend.enqueue('minicpm5-router', () => ({
      json: {
        tasks: [
          {
            type: 'RETRIEVE',
            title: 'Find files',
            objective: 'List relevant files.',
            dependencies: [],
          },
          { type: 'ANALYZE', title: 'Analyse', objective: 'Reason over them.', dependencies: [0] },
          { type: 'VERIFY', title: 'Verify', objective: 'Confirm acceptance.', dependencies: [1] },
        ],
      },
    }));

    const r = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: '/v1/goals',
      payload: {
        title: 'Auto-planned goal',
        objective: 'Add an authenticated endpoint.',
        acceptanceCriteria: ['endpoint responds 200'],
        autoPlan: true,
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      goalId: string;
      taskCount: number;
      tasks: unknown[];
      plannedByModel: boolean;
    };
    expect(body.taskCount).toBe(3);
    expect(body.plannedByModel).toBe(true);
  });

  it('POST /v1/goals with autoPlan=false (default) does NOT invoke the planner', async () => {
    const r = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: '/v1/goals',
      payload: {
        title: 'Manual goal',
        objective: 'Do something.',
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { taskCount: number; plannedByModel: boolean };
    expect(body.taskCount).toBe(0);
    expect(body.plannedByModel).toBe(false);
  });

  it('POST /v1/goals/:id/plan re-plans an existing ACTIVE goal', async () => {
    backend.enqueue('minicpm5-router', () => ({
      json: {
        tasks: [
          { type: 'PLAN', title: 'Plan', objective: 'Re-plan.', dependencies: [] },
          { type: 'SUMMARIZE', title: 'Summarise', objective: 'Wrap up.', dependencies: [0] },
        ],
      },
    }));

    // First, create an empty goal.
    const create = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: '/v1/goals',
      payload: { title: 'Re-plan target', objective: 'Original objective.' },
    });
    const { goalId } = create.json() as { goalId: string };

    // Then re-plan it.
    const r = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/v1/goals/${goalId}/plan`,
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { goalId: string; taskCount: number; plannedByModel: boolean };
    expect(body.goalId).toBe(goalId);
    expect(body.taskCount).toBe(2);
    expect(body.plannedByModel).toBe(true);
  });

  it('returns 501 on /v1/goals with autoPlan when planner is not wired', async () => {
    const localBackend = new MockBackend();
    const supervisor = new Supervisor({ backend: localBackend, store: new InMemoryStore() });
    const taskStore = new InMemoryTaskStore();
    const taskLedger = new TaskLedger(taskStore);
    // No taskPlanner supplied.
    const app2 = await createServer({
      supervisor,
      store: new InMemoryStore(),
      apiKey: API_KEY,
      taskLedger,
    });
    await app2.ready();

    const r = await app2.inject({
      headers: AUTH,
      method: 'POST',
      url: '/v1/goals',
      payload: { title: 'x', objective: 'y', autoPlan: true },
    });
    expect(r.statusCode).toBe(501);
    await app2.close();
  });

  it('returns 422 when the planner emits schema-invalid output', async () => {
    // Two invalid responses (free text).
    backend.enqueue('minicpm5-router', () => 'not json');
    backend.enqueue('minicpm5-router', () => 'still not json');

    const r = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: '/v1/goals',
      payload: { title: 'Bad plan', objective: 'Trigger planner failure.', autoPlan: true },
    });
    expect(r.statusCode).toBe(422);
    const body = r.json() as { error: string; errors: string[]; rawOutputCount: number };
    expect(body.error).toBe('task planner failed');
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.rawOutputCount).toBe(2);
  });
});
