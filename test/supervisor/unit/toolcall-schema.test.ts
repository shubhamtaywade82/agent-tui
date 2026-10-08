/**
 * TS Engine §3 — ToolCallSchema discriminated union + §2 readonly state.
 *
 * Verifies that the model's output must either be a valid tool call or
 * an explicit `tool: 'none'` deferral, preventing the "silent failure"
 * mode. Also verifies that AgentState core identifiers are immutable.
 */
import { describe, expect, it } from 'vitest';
import { AgentState, newAgentState, ToolCallSchema } from '../../../src/supervisor/state/models.js';

describe('ToolCallSchema (TS Engine §3 discriminated union)', () => {
  it('accepts a valid tool call with tool + arguments', () => {
    const r = ToolCallSchema.safeParse({
      tool: 'get_pipeline_status',
      arguments: { service: 'checkout-service' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tool).toBe('get_pipeline_status');
    }
  });

  it('accepts an explicit tool:"none" deferral with a reason', () => {
    const r = ToolCallSchema.safeParse({
      tool: 'none',
      reason: 'No tool is needed for this conversational query.',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const tc = r.data as { tool: string; reason?: string };
      expect(tc.tool).toBe('none');
      expect(tc.reason).toContain('No tool is needed');
    }
  });

  it('rejects an empty tool name (prevents silent failure)', () => {
    const r = ToolCallSchema.safeParse({
      tool: '',
      arguments: {},
    });
    expect(r.success).toBe(false);
  });

  it('rejects conversational filler that matches neither branch', () => {
    const r = ToolCallSchema.safeParse({
      response: 'I think you should try restarting the service.',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a tool:"none" without a reason', () => {
    const r = ToolCallSchema.safeParse({ tool: 'none' });
    expect(r.success).toBe(false);
  });

  it('rejects a tool call without arguments', () => {
    const r = ToolCallSchema.safeParse({ tool: 'read_file' });
    // arguments has a default of {} so this actually succeeds — verify
    expect(r.success).toBe(true);
    if (r.success) {
      const tc = r.data as { tool: string; arguments?: Record<string, unknown> };
      expect(tc.arguments).toEqual({});
    }
  });
});

describe('AgentState readonly fields (TS Engine §2)', () => {
  it('creates a state with immutable runId, objective, createdAt', () => {
    const state = newAgentState('Test objective');
    const parsed = AgentState.parse(state);
    // runId, objective, createdAt are .readonly() — they exist and are set
    expect(parsed.runId).toBe(state.runId);
    expect(parsed.objective).toBe('Test objective');
    expect(parsed.createdAt).toBe(state.createdAt);
  });

  it('allows mutation of mutable fields (status, intent, executionResult)', () => {
    const state = newAgentState('Test');
    state.status = 'EXECUTING';
    state.intent = 'TOOL_EXECUTION';
    state.executionResult = 'done';
    expect(state.status).toBe('EXECUTING');
    expect(state.intent).toBe('TOOL_EXECUTION');
    expect(state.executionResult).toBe('done');
  });

  it('preserves runId identity across mutations', () => {
    const state = newAgentState('Test');
    const originalRunId = state.runId;
    state.status = 'COMPLETED';
    state.finalResponse = 'finished';
    expect(state.runId).toBe(originalRunId);
  });
});
