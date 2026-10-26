/**
 * Task ledger module — public surface.
 *
 * The task ledger is the durable backbone for multi-step goals. The
 * orchestrator drives it forward by feeding verified attempts in; the
 * ledger enforces the chain invariants (no SUCCEEDED without a passing
 * ValidationReport; atomic commit + dependent unblock; cascade BLOCKED
 * on failure).
 *
 * See `models.ts` for the data model, `store.ts` for the persistence
 * boundary (in-memory + Postgres), `ledger.ts` for the high-level
 * operations, and `orchestrator.ts` for the runtime loop that bridges
 * the ledger to the existing Supervisor engine.
 */

export { TaskLedger } from './ledger.js';
export type {
  AttemptOutcome,
  Goal,
  GoalStatus,
  TaskAttempt,
  TaskDomainEvent,
  TaskNode,
  TaskStatus,
  TaskType,
} from './models.js';
export { TaskOrchestrator } from './orchestrator.js';
export { InMemoryTaskStore, PgTaskStore, type TaskStore } from './store.js';
