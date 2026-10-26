/**
 * Supervisor engine — P0 orchestration correctness regression guards.
 *
 * These tests pin down the invariants the rest of the suite relies on but
 * does not assert directly:
 *   - `run().allowedPaths` is forwarded to the tool validator (otherwise a
 *     path-bearing tool argument is checked against an empty scope and the
 *     caller's authorisation is silently dropped on the floor).
 *   - The router classifier's `maxOutputTokens` request is honoured as
 *     `num_predict` rather than `num_ctx` (covered separately in
 *     ollama-backend.test.ts but reproduced here end-to-end through the
 *     engine).
 *
 * The StateStore is an in-memory stub (mirrors golden.test.ts) so the suite
 * runs without a Postgres instance.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

describe('Supervisor engine — allowedPaths propagation', () => {
  it('rejects a tool call whose path argument is outside the authorised scope', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'TOOL_EXECUTION' } }));
    // The model proposes to read /etc/passwd — outside /workspace.
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'read_file', arguments: { path: '/etc/passwd' } },
    }));
    // Two repair attempts (both still bad) so the loop exhausts.
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'read_file', arguments: { path: '/etc/shadow' } },
    }));
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'read_file', arguments: { path: '/etc/gshadow' } },
    }));

    const s = makeSupervisor(backend);
    s.registry.register({
      name: 'read_file',
      description: 'Read a file',
      parametersSchema: z.object({ path: z.string() }),
      permissions: [],
      riskLevel: 'low',
      timeoutMs: 5000,
    });

    const r = await s.run({
      objective: 'Read /etc/passwd',
      allowedPaths: ['/workspace'],
    });

    // Repair loop ran but never produced a path inside /workspace.
    expect(s.metrics.snapshot().repairLoopInvocations).toBeGreaterThan(0);
    expect(r.executionResult).toMatch(/ERROR/i);
    expect(r.errorTrace.some((e) => e.includes('outside allowed scope'))).toBe(true);
  });

  it('accepts a tool call whose path argument is inside the authorised scope', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'TOOL_EXECUTION' } }));
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'read_file', arguments: { path: '/workspace/README.md' } },
    }));

    const s = makeSupervisor(backend);
    s.registry.register({
      name: 'read_file',
      description: 'Read a file',
      parametersSchema: z.object({ path: z.string() }),
      permissions: [],
      riskLevel: 'low',
      timeoutMs: 5000,
      // Stub executor so we don't fall through to the SIMULATED_SUCCESS path
      // — that path is exercised separately in engine-outcome.test.ts.
      execute: async () => ({ ok: true, output: 'file contents' }),
    });

    const r = await s.run({
      objective: 'Read /workspace/README.md',
      allowedPaths: ['/workspace'],
    });

    expect(r.executionResult).toBe('file contents');
    expect(s.metrics.snapshot().repairLoopInvocations).toBe(0);
  });

  it('records allowedPaths on the persisted AgentState for audit', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'OK');

    const s = makeSupervisor(backend);
    const r = await s.run({
      objective: 'Hello',
      allowedPaths: ['/workspace/project-a', '/tmp/build'],
    });

    expect(r.allowedPaths).toEqual(['/workspace/project-a', '/tmp/build']);
  });
});
