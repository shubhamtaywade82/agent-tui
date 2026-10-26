/**
 * Supervisor engine — P0 orchestration correctness regression guards.
 *
 * These tests pin down the invariants the rest of the suite relies on but
 * does not assert directly:
 *   - `run().allowedPaths` is forwarded to the tool validator (otherwise a
 *     path-bearing tool argument is checked against an empty scope and the
 *     caller's authorisation is silently dropped on the floor).
 *   - A tool call with no executor available is reported honestly as
 *     SKIPPED / SIMULATED, never as SUCCEEDED / executed.
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
      // — that path is exercised separately below.
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

describe('Supervisor engine — SIMULATED_SUCCESS must not masquerade as SUCCEEDED', () => {
  it('records a SKIPPED step and a SIMULATED tool_executed event when no executor is available', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'TOOL_EXECUTION' } }));
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'get_pipeline_status', arguments: { service: 'checkout' } },
    }));

    const s = makeSupervisor(backend);
    // No `execute` hook on the tool definition — the engine has no sandbox
    // configured either (no `sandbox` dep on the Supervisor), so the
    // SIMULATED_SUCCESS path is the only one available.
    s.registry.register({
      name: 'get_pipeline_status',
      description: 'Check CI status',
      parametersSchema: z.object({ service: z.string() }),
      permissions: [],
      riskLevel: 'low',
      timeoutMs: 5000,
    });

    const events: DomainEvent[] = [];
    s.bus.subscribe((e) => {
      if (e.type === 'tool_executed') events.push(e);
    });

    const r = await s.run({ objective: 'Check the checkout pipeline status.' });

    // The observable string contract is preserved (golden evals rely on it).
    expect(r.finalResponse).toMatch(/SIMULATED_SUCCESS/);
    // But the honest signal says: nothing actually executed.
    const toolExecuted = events.find((e) => e.type === 'tool_executed');
    expect(toolExecuted).toBeDefined();
    expect(toolExecuted?.payload).toMatchObject({ status: 'SIMULATED' });
    // Step status is SKIPPED, NOT SUCCEEDED — that was the original sin.
    const execStep = r.steps.find((st) => st.stepType === 'EXECUTE_TOOL');
    expect(execStep?.status).toBe('SKIPPED');
    // Metrics counter is `simulated`, not `executed`.
    expect(s.metrics.snapshot().toolCallsSimulated).toBe(1);
    expect(s.metrics.snapshot().toolCallsExecuted).toBe(0);
  });

  it('records a SUCCEEDED step and a SUCCESS tool_executed event when an execute hook is present', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'TOOL_EXECUTION' } }));
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'echo', arguments: { msg: 'hi' } },
    }));

    const s = makeSupervisor(backend);
    s.registry.register({
      name: 'echo',
      description: 'Echo a message',
      parametersSchema: z.object({ msg: z.string() }),
      permissions: [],
      riskLevel: 'low',
      timeoutMs: 5000,
      execute: async (args) => ({ ok: true, output: `echo: ${args.msg}` }),
    });

    const events: DomainEvent[] = [];
    s.bus.subscribe((e) => {
      if (e.type === 'tool_executed') events.push(e);
    });

    const r = await s.run({ objective: 'Echo hi' });

    expect(r.finalResponse).toBe('echo: hi');
    const toolExecuted = events.find((e) => e.type === 'tool_executed');
    expect(toolExecuted?.payload).toMatchObject({ status: 'SUCCESS' });
    const execStep = r.steps.find((st) => st.stepType === 'EXECUTE_TOOL');
    expect(execStep?.status).toBe('SUCCEEDED');
    expect(s.metrics.snapshot().toolCallsSimulated).toBe(0);
    expect(s.metrics.snapshot().toolCallsExecuted).toBe(1);
  });
});

describe('Supervisor engine — router escalation must actually invoke the fallback', () => {
  it('routes escalated tasks to the configured fallback backend with the chosen model', async () => {
    const localBackend = new MockBackend();
    const fallbackBackend = new MockBackend();
    // Router classifies as CODE_REVIEW — the complexity scorer will mark a
    // multi-file refactor as 'escalate', so the router decides to escalate.
    localBackend.enqueue('minicpm5-router', () => ({ json: { intent: 'CODE_REVIEW' } }));
    // Fallback answers — must be invoked, NOT the local analyst model.
    fallbackBackend.enqueue('gpt-4o', () => 'Cloud review: looks good.');

    const s = new Supervisor({
      backend: localBackend,
      fallback: fallbackBackend,
      store: new InMemoryStore(),
    });
    // Override the router's escalation decision with one we control, since
    // the real router depends on env-configured ESCALATION_FALLBACK_MODEL.
    // We exercise the wiring end-to-end by overriding the router's `decide`
    // result through a run-model-choice stub:
    (s as unknown as { router: { decide: () => unknown } }).router.decide = () => ({
      kind: 'escalate',
      intent: 'CODE_REVIEW',
      reason: 'test override',
      fallbackModel: 'gpt-4o',
    });

    const events: DomainEvent[] = [];
    s.bus.subscribe((e) => {
      if (e.type === 'model_invoked' || e.type === 'model_escalated') events.push(e);
    });

    const r = await s.run({
      objective: 'Refactor the entire auth subsystem across all microservices.',
    });

    // The fallback was invoked with the chosen model name.
    const invoked = events.filter((e) => e.type === 'model_invoked');
    expect(invoked.length).toBeGreaterThan(0);
    expect(invoked[0]?.payload).toMatchObject({ model: 'gpt-4o' });
    // The local analyst model was NOT invoked.
    expect(invoked.some((e) => e.payload.model === 'minicpm5-analyst')).toBe(false);
    expect(r.finalResponse).toContain('Cloud review');
    // The escalation was recorded as an event too.
    expect(events.some((e) => e.type === 'model_escalated')).toBe(true);
    // Sanity: the fallback backend observed the call.
    const fallbackCalls = fallbackBackend.observedCalls();
    expect(fallbackCalls.length).toBe(1);
    expect(fallbackCalls[0]?.model).toBe('gpt-4o');
    // And the local backend only saw the router call.
    expect(localBackend.observedCalls().filter((c) => c.model === 'minicpm5-analyst')).toHaveLength(
      0,
    );
  });

  it('fails loudly when the router escalates but no fallback backend is configured', async () => {
    const localBackend = new MockBackend();
    localBackend.enqueue('minicpm5-router', () => ({ json: { intent: 'CODE_REVIEW' } }));

    // No fallback backend supplied.
    const s = new Supervisor({ backend: localBackend, store: new InMemoryStore() });
    (s as unknown as { router: { decide: () => unknown } }).router.decide = () => ({
      kind: 'escalate',
      intent: 'CODE_REVIEW',
      reason: 'test override',
      fallbackModel: 'gpt-4o',
    });

    const r = await s.run({
      objective: 'Refactor the entire auth subsystem across all microservices.',
    });

    // The previous behaviour silently invoked the local analyst and reported
    // COMPLETED. The P0 contract: escalation without a fallback is a hard
    // failure so an operator notices the misconfiguration immediately.
    expect(r.status).toBe('FAILED');
    expect(r.errorTrace.some((e) => e.includes('no fallback backend is configured'))).toBe(true);
  });
});

describe('Supervisor engine — COMPLETED must be gated on validation outcome', () => {
  it('transitions to FAILED when the tool execution produced an ERROR result', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'TOOL_EXECUTION' } }));
    // Model proposes an unknown tool — the engine records
    // `ERROR: tool call invalid after N repair attempts`.
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'nonexistent_tool', arguments: {} },
    }));

    const s = makeSupervisor(backend);

    const events: DomainEvent[] = [];
    s.bus.subscribe((e) => {
      if (e.type === 'run_completed') events.push(e);
    });

    const r = await s.run({ objective: 'Call a tool that does not exist.' });

    // The P0 contract: a failed tool execution must NOT end in COMPLETED.
    expect(r.status).toBe('FAILED');
    expect(r.validationOutcome?.ok).toBe(false);
    expect(r.validationOutcome?.validators).toContain('no-error-prefix');
    expect(r.errorTrace.some((e) => e.includes('validation failed'))).toBe(true);
    // The terminal event carries the honest outcome.
    const runCompleted = events.find((e) => e.type === 'run_completed');
    expect(runCompleted?.payload).toMatchObject({ outcome: 'FAILED' });
  });

  it('transitions to FAILED when the analyst declares insufficient_evidence', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () =>
      JSON.stringify({
        answer: 'I cannot answer this with the available evidence.',
        citations: [],
        confidence: 'low',
        insufficient_evidence: true,
      }),
    );

    const s = makeSupervisor(backend);

    const r = await s.run({ objective: 'What is the meaning of life?' });

    expect(r.status).toBe('FAILED');
    expect(r.validationOutcome?.ok).toBe(false);
    expect(r.validationOutcome?.reasons.some((m) => m.includes('insufficient_evidence'))).toBe(
      true,
    );
    // The analyst's answer is still surfaced for debugging — the run just
    // honestly reports that it didn't satisfy the success contract.
    expect(r.finalResponse).toContain('cannot answer');
  });

  it('transitions to FAILED when the analyst cites evidence that was not retrieved', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () =>
      JSON.stringify({
        answer: 'The deploy failed because of a config error.',
        citations: ['e9'],
        confidence: 'high',
        insufficient_evidence: false,
      }),
    );

    const s = makeSupervisor(backend);

    const r = await s.run({ objective: 'Why did the deploy fail?' });

    expect(r.status).toBe('FAILED');
    expect(r.validationOutcome?.validators).toContain('citation-grounding');
    expect(r.validationOutcome?.reasons.some((m) => m.includes('not grounded'))).toBe(true);
  });

  it('transitions to COMPLETED with outcome=SUCCEEDED for a clean analyst answer', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'GENERAL_QUERY' } }));
    backend.enqueue('minicpm5-analyst', () => 'Paris is the capital of France.');

    const s = makeSupervisor(backend);
    const events: DomainEvent[] = [];
    s.bus.subscribe((e) => {
      if (e.type === 'run_completed') events.push(e);
    });

    const r = await s.run({ objective: 'What is the capital of France?' });

    expect(r.status).toBe('COMPLETED');
    expect(r.validationOutcome?.ok).toBe(true);
    // Free-text answer — analyst-schema validator is correctly skipped.
    expect(r.validationOutcome?.validators).toEqual(['non-empty', 'no-error-prefix']);
    const runCompleted = events.find((e) => e.type === 'run_completed');
    expect(runCompleted?.payload).toMatchObject({ outcome: 'SUCCEEDED' });
  });

  it('transitions to COMPLETED with outcome=SIMULATED for a SIMULATED_SUCCESS path', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-router', () => ({ json: { intent: 'TOOL_EXECUTION' } }));
    backend.enqueue('minicpm5-toolagent', () => ({
      json: { tool: 'no_executor_tool', arguments: { x: 1 } },
    }));

    const s = makeSupervisor(backend);
    s.registry.register({
      name: 'no_executor_tool',
      description: 'A tool with no execute hook',
      parametersSchema: z.object({ x: z.number() }),
      permissions: [],
      riskLevel: 'low',
      timeoutMs: 5000,
    });

    const events: DomainEvent[] = [];
    s.bus.subscribe((e) => {
      if (e.type === 'run_completed') events.push(e);
    });

    const r = await s.run({ objective: 'Run no_executor_tool' });

    // The simulated path is allowed to complete (preserving the existing
    // observable contract), but the terminal event carries outcome=SIMULATED
    // so a downstream consumer cannot confuse it with a real success.
    expect(r.status).toBe('COMPLETED');
    expect(r.finalResponse).toMatch(/SIMULATED_SUCCESS/);
    const runCompleted = events.find((e) => e.type === 'run_completed');
    expect(runCompleted?.payload).toMatchObject({ outcome: 'SIMULATED' });
  });
});
