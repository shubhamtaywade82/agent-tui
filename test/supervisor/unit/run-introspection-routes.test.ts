/**
 * Run-introspection routes — GET /v1/runs/:id/checkpoints and
 * GET /v1/runs/:id/snapshots.
 *
 * These were 501 stubs until the memory service was wired through
 * RouteDeps (PR #45). Exercises the wired happy path against a fake
 * MemoryService, the empty-list shape, and the honest 501 behaviour
 * when the dep is absent (e.g. memory init failed at boot).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../../src/supervisor/api/server.js';
import type { MemoryService } from '../../../src/supervisor/context/memory.js';
import { Supervisor } from '../../../src/supervisor/engine.js';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import type { DomainEvent } from '../../../src/supervisor/state/events.js';
import type { AgentState } from '../../../src/supervisor/state/models.js';
import type { StateStore } from '../../../src/supervisor/state/store.js';

const API_KEY = 'run-introspection-test-key-0123456789';
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

/** Captures what the routes actually call, returns canned rows. */
class FakeMemoryService {
  checkpointCalls: string[] = [];
  snapshotCalls: string[] = [];

  async listCheckpoints(runId: string): Promise<unknown[]> {
    this.checkpointCalls.push(runId);
    return [
      {
        checkpointId: 'cp-2',
        stepId: 'step-b',
        status: 'SUCCEEDED',
        currentPlan: 'plan b',
        completedSteps: ['tool', 'validate'],
        activeConstraints: [],
        workingFiles: ['src/a.ts'],
        lastToolResultSummary: 'ok',
        nextActions: ['summarize'],
        tokenBudget: 8192,
        createdAt: '2026-10-28T01:02:03.000Z',
      },
      {
        checkpointId: 'cp-1',
        stepId: undefined,
        status: 'RUNNING',
        currentPlan: undefined,
        completedSteps: [],
        activeConstraints: [],
        workingFiles: [],
        lastToolResultSummary: undefined,
        nextActions: [],
        tokenBudget: 8192,
        createdAt: '2026-10-28T01:01:03.000Z',
      },
    ];
  }

  async listContextSnapshots(runId: string): Promise<unknown[]> {
    this.snapshotCalls.push(runId);
    return [
      {
        snapshotId: 'snap-1',
        stepId: 'step-a',
        tokenBudget: 8192,
        usedTokens: 4096,
        promptHash: 'sha256:abc',
        includedMemoryIds: ['mem-1'],
        includedChunkIds: ['chunk-1'],
        excludedChunkIds: [],
        createdAt: '2026-10-28T01:00:00.000Z',
      },
    ];
  }
}

function makeServer(withMemory: boolean) {
  const backend = new MockBackend();
  const supervisor = new Supervisor({ backend, store: new InMemoryStore() });
  return createServer({
    supervisor,
    store: new InMemoryStore(),
    apiKey: API_KEY,
    ...(withMemory ? { memoryService: new FakeMemoryService() as unknown as MemoryService } : {}),
  });
}

describe('run-introspection routes (checkpoints + snapshots)', () => {
  describe('with the memory service wired', () => {
    let app: Awaited<ReturnType<typeof createServer>>;

    beforeAll(async () => {
      app = await makeServer(true);
      await app.ready();
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    it('GET /v1/runs/:id/checkpoints returns the mapped checkpoint list', async () => {
      const r = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/v1/runs/run-42/checkpoints',
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.runId).toBe('run-42');
      expect(body.checkpoints).toHaveLength(2);
      expect(body.checkpoints[0]).toMatchObject({
        checkpointId: 'cp-2',
        status: 'SUCCEEDED',
        completedSteps: ['tool', 'validate'],
      });
      // Row mapping never leaks raw DB column names.
      expect(body.checkpoints[0]).not.toHaveProperty('created_at');
      expect(body.checkpoints[0]).not.toHaveProperty('token_budget');
    });

    it('GET /v1/runs/:id/snapshots returns the mapped snapshot list', async () => {
      const r = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/v1/runs/run-42/snapshots',
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.runId).toBe('run-42');
      expect(body.snapshots).toHaveLength(1);
      expect(body.snapshots[0]).toMatchObject({
        snapshotId: 'snap-1',
        stepId: 'step-a',
        promptHash: 'sha256:abc',
      });
      expect(body.snapshots[0]).not.toHaveProperty('prompt_hash');
    });

    it('requires bearer auth like every other protected route', async () => {
      const r = await app.inject({ method: 'GET', url: '/v1/runs/run-42/checkpoints' });
      expect(r.statusCode).toBe(401);
    });
  });

  describe('without the memory service (honest 501)', () => {
    let app: Awaited<ReturnType<typeof createServer>>;

    beforeAll(async () => {
      app = await makeServer(false);
      await app.ready();
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    it('checkpoints route reports 501 with a clear reason', async () => {
      const r = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/v1/runs/run-42/checkpoints',
      });
      expect(r.statusCode).toBe(501);
      const body = r.json();
      expect(body.runId).toBe('run-42');
      expect(body.error).toContain('memory service not configured');
    });

    it('snapshots route reports 501 with a clear reason', async () => {
      const r = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/v1/runs/run-42/snapshots',
      });
      expect(r.statusCode).toBe(501);
      const body = r.json();
      expect(body.runId).toBe('run-42');
      expect(body.error).toContain('memory service not configured');
    });
  });
});
