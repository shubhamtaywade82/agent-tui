/**
 * Domain events — §9.2 (Event Sourcing).
 *
 * Every meaningful state transition in the supervisor emits a domain event.
 * Events are persisted to an `events` table (append-only) so the full
 * trajectory of any run can be replayed for debugging, audit, or evaluation
 * regressions (§15.3).
 */
import type { Intent, RunStatus, StepStatus, StepType } from './models.js';

export type DomainEvent =
  | {
      type: 'run_created';
      runId: string;
      payload: { objective: string; userId?: string; projectId?: string };
      occurredAt: string;
    }
  | {
      type: 'state_transitioned';
      runId: string;
      payload: { from: RunStatus; to: RunStatus; reason: string; at: string };
      occurredAt: string;
    }
  | {
      type: 'intent_classified';
      runId: string;
      payload: { intent: Intent; raw: string; repaired: boolean };
      occurredAt: string;
    }
  | {
      type: 'plan_generated';
      runId: string;
      payload: { steps: string[]; thinkMode: 'think' | 'no-think' };
      occurredAt: string;
    }
  | {
      type: 'context_built';
      runId: string;
      payload: { tokenBudget: number; usedTokens: number; chunks: number };
      occurredAt: string;
    }
  | {
      type: 'model_invoked';
      runId: string;
      payload: {
        model: string;
        thinkMode: 'think' | 'no-think';
        latencyMs: number;
        tokens: number;
      };
      occurredAt: string;
    }
  | {
      type: 'tool_call_proposed';
      runId: string;
      payload: { tool: string; arguments: Record<string, unknown> };
      occurredAt: string;
    }
  | {
      type: 'tool_call_validated';
      runId: string;
      payload: { tool: string; status: 'VALID' | 'INVALID' | 'REPAIRED'; error?: string };
      occurredAt: string;
    }
  | {
      type: 'tool_executed';
      runId: string;
      payload: {
        tool: string;
        status: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'DENIED';
        resultSummary?: string;
      };
      occurredAt: string;
    }
  | {
      type: 'validation_passed';
      runId: string;
      payload: { validators: string[] };
      occurredAt: string;
    }
  | {
      type: 'validation_failed';
      runId: string;
      payload: { validator: string; error: string };
      occurredAt: string;
    }
  | {
      type: 'human_approved';
      runId: string;
      payload: { approver: string; reason: string };
      occurredAt: string;
    }
  | {
      type: 'model_escalated';
      runId: string;
      payload: { from: string; to: string; reason: string };
      occurredAt: string;
    }
  | {
      type: 'artifact_saved';
      runId: string;
      payload: { artifactType: string; storageUri: string; checksum: string };
      occurredAt: string;
    }
  | {
      type: 'step_recorded';
      runId: string;
      payload: { stepType: StepType; status: StepStatus; latencyMs: number };
      occurredAt: string;
    }
  | {
      type: 'run_completed';
      runId: string;
      payload: { finalResponsePreview: string };
      occurredAt: string;
    };

export type EventType = DomainEvent['type'];

/**
 * In-process event bus. Subscribers are notified synchronously in
 * subscription order. Persisting events to the database is itself a
 * subscriber — added by the store on bootstrap (§4.1).
 */
export class EventBus {
  private readonly subscribers: Array<(e: DomainEvent) => void | Promise<void>> = [];

  subscribe(fn: (e: DomainEvent) => void | Promise<void>): () => void {
    this.subscribers.push(fn);
    return () => {
      const i = this.subscribers.indexOf(fn);
      if (i >= 0) this.subscribers.splice(i, 1);
    };
  }

  async publish(event: DomainEvent): Promise<void> {
    for (const fn of this.subscribers) {
      try {
        await fn(event);
      } catch {
        // subscribers must not break the orchestrator; log elsewhere
      }
    }
  }
}
