/**
 * Deterministic state machine — §1 and §9.
 *
 * Implements a strict ROUTE → EXECUTE → VALIDATE loop with explicit
 * transitions for retrying, escalating, and awaiting human approval. The
 * machine is the only thing allowed to mutate `AgentState.status`. Every
 * transition is recorded as a domain event (§9.2 — event sourcing).
 *
 * Allowed transitions are encoded in `ALLOWED` so an illegal jump (e.g.
 * CREATED → COMPLETED) throws synchronously rather than silently corrupting
 * state. This compensates for the LLM's probabilistic nature by bounding it
 * within a deterministic software architecture (§1 final recommendation).
 */

import type { DomainEvent, EventBus } from './events.js';
import type { AgentState, RunStatus } from './models.js';

const ALLOWED: Record<RunStatus, RunStatus[]> = {
  CREATED: ['PLANNING', 'CANCELLED', 'FAILED'],
  PLANNING: ['RETRIEVING', 'AWAITING_APPROVAL', 'EXECUTING', 'ESCALATED', 'FAILED', 'CANCELLED'],
  RETRIEVING: ['AWAITING_APPROVAL', 'EXECUTING', 'ESCALATED', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['EXECUTING', 'CANCELLED', 'FAILED'],
  EXECUTING: ['VALIDATING', 'RETRYING', 'ESCALATED', 'FAILED', 'CANCELLED'],
  VALIDATING: ['EXECUTING', 'RETRYING', 'ESCALATED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  RETRYING: ['PLANNING', 'RETRIEVING', 'EXECUTING', 'ESCALATED', 'FAILED', 'CANCELLED'],
  ESCALATED: ['PLANNING', 'EXECUTING', 'FAILED', 'CANCELLED', 'COMPLETED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export interface StateTransition {
  from: RunStatus;
  to: RunStatus;
  reason: string;
  at: string;
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: RunStatus,
    public readonly to: RunStatus,
  ) {
    super(`Illegal state transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export class StateMachine {
  constructor(private readonly bus: EventBus) {}

  canTransition(from: RunStatus, to: RunStatus): boolean {
    return (ALLOWED[from] ?? []).includes(to);
  }

  /**
   * Apply a transition to the given state and emit a `state_transitioned`
   * domain event. Throws `IllegalTransitionError` if the move is not in
   * the `ALLOWED` table — this is the deterministic guard that prevents
   * the LLM from skipping validation or jumping to COMPLETED.
   */
  async transition(state: AgentState, to: RunStatus, reason = ''): Promise<AgentState> {
    const from = state.status;
    if (from === to) return state;
    if (!this.canTransition(from, to)) {
      throw new IllegalTransitionError(from, to);
    }

    const event: DomainEvent = {
      type: 'state_transitioned',
      runId: state.runId,
      payload: { from, to, reason, at: new Date().toISOString() },
      occurredAt: new Date().toISOString(),
    };

    state.status = to;
    state.updatedAt = new Date().toISOString();
    await this.bus.publish(event);
    return state;
  }

  /**
   * Returns the set of states reachable from the current status in one hop.
   * Useful for the API layer to expose "what can I do next" to a human
   * reviewer at an approval gate (§9.4).
   */
  reachableFrom(from: RunStatus): RunStatus[] {
    return [...(ALLOWED[from] ?? [])];
  }
}
