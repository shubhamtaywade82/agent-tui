/**
 * Task-ledger HTTP API — Phase 1 surface.
 *
 * Exercises the new /v1/goals routes via Fastify's inject() against
 * an in-memory task store (no Postgres needed). Asserts the honest
 * 501 behaviour when the ledger is not wired, plus the happy path
 * for goal creation, advancement, and event replay.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../../src/supervisor/api/server.js';
import { Supervisor } from '../../../src/supervisor/engine.js';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import type { DomainEvent } from '../../../src/supervisor/state/events.js';
import type { AgentState } from '../../../src/supervisor/state/models.js';
import type { StateStore } from '../../../src/supervisor/state/store.js';
import { TaskLedger } from '../../../src/supervisor/tasks/ledger.js';
import { TaskOrchestrator } from '../../../src/supervisor/tasks/orchestrator.js';
import { InMemoryTaskStore } from '../../../src/supervisor/tasks/store.js';

const API_KEY = 'task-ledger-test-key-0123456789';
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

describe('Task-ledger HTTP API', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    const backend = new MockBackend();
    const supervisor = new Supervisor({ backend, store: new InMemoryStore() });
    const taskStore = new InMemoryTaskStore();
    const taskLedger = new TaskLedger(taskStore);
    const taskOrchestrator = new TaskOrchestrator(taskLedger, supervisor, taskStore);

    // Queue enough responses for several advance calls.
    for (let i = 0; i < 10; i++) {
      backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
      backend.enqueue('minicpm5-analyst', () => `Step ${i + 1} done.`);
    }

    app = await createServer({
      supervisor,
      store: new InMemoryStore(),
      apiKey: API_KEY,
      taskLedger,
      taskOrchestrator,
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('POST /v1/goals creates a goal with an initial task graph', async () => {
    const r = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: '/v1/goals',
      payload: {
        title: 'Test goal',
        objective: 'Verify the API surface works end to end.',
        acceptanceCriteria: ['t1 SUCCEEDED', 't2 SUCCEEDED'],
        tasks: [
          { type: 'ANALYZE', title: 'Step 1', objective: 'First analysis.' },
          {
            type: 'ANALYZE',
            title: 'Step 2',
            objective: 'Second analysis, building on Step 1.',
            dependencies: [0],
          },
        ],
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      goalId: string;
      status: string;
      taskCount: number;
      tasks: unknown[];
    };
    expect(body.goalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.status).toBe('ACTIVE');
    expect(body.taskCount).toBe(2);
    expect(body.tasks).toHaveLength(2);
  });

  it('GET /v1/goals/:id returns the goal with its task chain summary', async () => {
    const post = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: '/v1/goals',
      payload: {
        title: 'G2',
        objective: 'O2',
        tasks: [{ type: 'ANALYZE', title: 't1', objective: 'first' }],
      },
    });
    const { goalId } = post.json() as { goalId: string };

    const r = await app.inject({ headers: AUTH, method: 'GET', url: `/v1/goals/${goalId}` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { goalId: string; status: string; tasks: Array<{ status: string }> };
    expect(body.goalId).toBe(goalId);
    expect(body.status).toBe('ACTIVE');
    expect(body.tasks).toHaveLength(1);
    // The single root task should be READY immediately (no dependencies).
    expect(body.tasks[0]?.status).toBe('READY');
  });

  it('POST /v1/goals/:id/advance runs the next READY task', async () => {
    const post = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: '/v1/goals',
      payload: {
        title: 'Adv',
        objective: 'Advance once.',
        tasks: [{ type: 'ANALYZE', title: 't1', objective: 'one step' }],
      },
    });
    const { goalId } = post.json() as { goalId: string };

    const r = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/v1/goals/${goalId}/advance`,
      payload: { maxSteps: 1 },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { steps: Array<{ advanced: boolean }>; stoppedReason: string };
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]?.advanced).toBe(true);
  });

  it('GET /v1/goals/:id/events replays the task event stream', async () => {
    const post = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: '/v1/goals',
      payload: {
        title: 'Ev',
        objective: 'Event stream.',
        tasks: [{ type: 'ANALYZE', title: 't1', objective: 'first' }],
      },
    });
    const { goalId } = post.json() as { goalId: string };

    const r = await app.inject({ headers: AUTH, method: 'GET', url: `/v1/goals/${goalId}/events` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { events: Array<{ type: string }> };
    const types = body.events.map((e) => e.type);
    expect(types).toContain('goal_created');
    expect(types).toContain('task_created');
  });

  it('returns 501 on /v1/goals when the ledger is not wired', async () => {
    const backend = new MockBackend();
    const supervisor = new Supervisor({ backend, store: new InMemoryStore() });
    const app2 = await createServer({
      supervisor,
      store: new InMemoryStore(),
      apiKey: API_KEY,
      // No taskLedger / taskOrchestrator
    });
    await app2.ready();

    const r = await app2.inject({
      headers: AUTH,
      method: 'POST',
      url: '/v1/goals',
      payload: { title: 'x', objective: 'y' },
    });
    expect(r.statusCode).toBe(501);
    await app2.close();
  });
});
