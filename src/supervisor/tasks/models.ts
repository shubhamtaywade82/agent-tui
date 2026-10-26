/**
 * Task ledger domain models — Phase 1 of the persistent task chain.
 *
 * A Goal is the top-level objective the user wants to accomplish. It
 * decomposes into a directed acyclic graph (DAG) of TaskNodes. Each
 * TaskNode is a verifiable unit of work: classify, retrieve, analyze,
 * propose a tool, execute, observe, verify, summarize. A TaskAttempt
 * records one model invocation against a task (with its proposal,
 * execution result, and validation report).
 *
 * The chain advances only after the active task's verification passes.
 * The model never decides "the goal is done" — only the harness does,
 * after the goal's acceptance criteria have been met by verified task
 * outputs.
 *
 * Persistence: goals, tasks, task_dependencies, task_attempts, and
 * task_events are stored in Postgres. An in-memory implementation is
 * provided for tests and the mock backend so the suite runs without a
 * database instance.
 */
import { z } from 'zod';

/**
 * Lifecycle of a single task node. Mirrors the run-level status but is
 * finer-grained: a task moves through PENDING → READY → RUNNING →
 * (RETRYING | AWAITING_APPROVAL | ESCALATED) → SUCCEEDED | FAILED |
 * BLOCKED | CANCELLED.
 *
 * A task is READY when every dependency has SUCCEEDED. A task is BLOCKED
 * when a dependency has FAILED or has been CANCELLED — it cannot make
 * progress without external intervention.
 */
export const TaskStatus = z.enum([
  'PENDING', // created but dependencies not yet satisfied
  'READY', // all dependencies SUCCEEDED; eligible to run
  'RUNNING', // an attempt is in flight
  'RETRYING', // last attempt failed recoverably; another will run
  'AWAITING_APPROVAL', // paused for human approval of a proposed action
  'ESCALATED', // handed off to a stronger model
  'SUCCEEDED', // verification passed; output committed
  'FAILED', // terminal: verification failed irrecoverably, or budget exhausted
  'BLOCKED', // terminal: a dependency failed; this task cannot run
  'CANCELLED', // terminal: user cancelled
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * The kind of work a task represents. Drives which specialist model is
 * selected and which validators run before the task can be SUCCEEDED.
 */
export const TaskType = z.enum([
  'PLAN', // decompose a goal into subtasks
  'RETRIEVE', // gather evidence from tools / retrieval / files
  'ANALYZE', // reason over evidence and produce a structured conclusion
  'TOOL', // propose and execute a single tool call
  'CODE_CHANGE', // propose and apply a structured patch
  'TEST', // run verification commands and capture results
  'VERIFY', // run task-specific acceptance checks
  'SUMMARIZE', // compress trajectory / output for downstream consumption
]);
export type TaskType = z.infer<typeof TaskType>;

/**
 * Outcome of a task attempt. Separate from TaskStatus because a single
 * task may have multiple attempts (retry, escalation), and the attempt
 * outcome drives the recovery policy.
 *
 * Mirrors the run-level RunOutcome contract from PR #31: a task cannot
 * be SUCCEEDED without a passing ValidationReport on its active attempt.
 */
export const AttemptOutcome = z.enum([
  'SUCCEEDED', // verification passed
  'FAILED_VALIDATION', // schema/semantic/citation validation failed
  'FAILED_EXECUTION', // tool/sandbox/patch execution failed
  'FAILED', // terminal failure (budget exhausted, irrecoverable)
  'SIMULATED', // executor reported SIMULATED_SUCCESS — not authoritative
  'ESCALATED', // attempt handed off to a stronger model
  'NEEDS_HUMAN', // paused awaiting human input
  'CANCELLED', // user cancelled
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

/**
 * A single model invocation against a task. Records the proposal,
 * execution result, and validation report. Multiple attempts may exist
 * for one task (retry, escalation, repair).
 */
export const TaskAttempt = z.object({
  attemptId: z.string().uuid(),
  taskId: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  /** Which model served this attempt. May differ across attempts (escalation). */
  modelUsed: z.string(),
  /** Provider that served this attempt — local ollama, fallback vllm, etc. */
  providerUsed: z.string().optional(),
  /** The raw model output (untrusted). */
  rawOutput: z.string().optional(),
  /** The parsed proposal (validated against the task's expected schema). */
  parsedProposal: z.record(z.string(), z.unknown()).optional(),
  /** Whether the parsed proposal passed schema validation. */
  proposalValid: z.boolean().default(false),
  /** The execution result, if a tool/patch was executed. */
  executionResult: z.string().optional(),
  /** The validation report produced by the verifier. */
  validationReport: z
    .object({
      passed: z.boolean(),
      checks: z.array(
        z.object({
          id: z.string(),
          required: z.boolean(),
          status: z.enum(['PASSED', 'FAILED', 'SKIPPED', 'NOT_APPLICABLE']),
          message: z.string(),
        }),
      ),
      failureCodes: z.array(z.string()).default([]),
    })
    .optional(),
  outcome: AttemptOutcome.optional(),
  /** Latency in ms for the model invocation itself. */
  latencyMs: z.number().int().nonnegative().default(0),
  /** Token usage for cost/budget tracking. */
  tokens: z
    .object({
      prompt: z.number().int().nonnegative().default(0),
      completion: z.number().int().nonnegative().default(0),
    })
    .default({ prompt: 0, completion: 0 }),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
});
export type TaskAttempt = z.infer<typeof TaskAttempt>;

/**
 * A node in the task DAG. Carries its input (from dependencies or
 * retrieval), its verified output (after SUCCEEDED), and references to
 * its attempts.
 *
 * The chain is "doubly-linked" via parentTaskId (the immediate
 * predecessor in a linear chain) and dependencies (the full set of
 * tasks that must SUCCEEDED before this one becomes READY). For a
 * pure linear chain, dependencies === [parentTaskId]. For a DAG,
 * dependencies may include tasks from multiple branches.
 */
export const TaskNode = z.object({
  taskId: z.string().uuid(),
  goalId: z.string().uuid(),
  /** Immediate predecessor in the chain. Null for the root task. */
  parentTaskId: z.string().uuid().nullable(),
  /** Sequence within the goal — for ordering and human-readable display. */
  sequence: z.number().int().nonnegative(),
  type: TaskType,
  title: z.string(),
  objective: z.string(),
  status: TaskStatus.default('PENDING'),
  /**
   * IDs of tasks that must SUCCEEDED before this task becomes READY.
   * For a linear chain this is `[parentTaskId]`. Normalised into the
   * task_dependencies table by the repository.
   */
  dependencies: z.array(z.string().uuid()).default([]),
  /** IDs of artifacts produced by dependency tasks that this task may consume. */
  inputArtifactIds: z.array(z.string()).default([]),
  /** IDs of artifacts this task has produced (populated after SUCCEEDED). */
  outputArtifactIds: z.array(z.string()).default([]),
  /** Citation IDs / file paths / tool results backing the task's output. */
  evidenceIds: z.array(z.string()).default([]),
  /** Verified structured output (populated after SUCCEEDED; null otherwise). */
  output: z.record(z.string(), z.unknown()).nullable().default(null),
  /** Free-text summary of the output for human display. */
  outputSummary: z.string().nullable().default(null),
  /** Attempts made against this task. The last one is the active attempt. */
  attempts: z.array(TaskAttempt).default([]),
  attemptCount: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  /** RunId of the Supervisor run executing the active attempt, if any. */
  activeRunId: z.string().uuid().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().default(null),
});
export type TaskNode = z.infer<typeof TaskNode>;

/**
 * The root objective. Carries acceptance criteria the harness checks
 * before declaring the goal SUCCEEDED. The goal persists across runs —
 * a single HTTP /v1/runs request may complete one task; the goal may
 * require many tasks across many runs.
 */
export const GoalStatus = z.enum([
  'ACTIVE', // chain in progress; at least one task not yet terminal
  'SUCCEEDED', // all required tasks SUCCEEDED and acceptance criteria met
  'FAILED', // a critical task FAILED terminally and cannot be bypassed
  'CANCELLED', // user cancelled the goal
  'PAUSED', // user paused; tasks remain PENDING/READY but orchestrator will not advance
]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const Goal = z.object({
  goalId: z.string().uuid(),
  userId: z.string().optional(),
  projectId: z.string().optional(),
  title: z.string(),
  objective: z.string(),
  /** Human-readable acceptance criteria — what must be true for the goal to be SUCCEEDED. */
  acceptanceCriteria: z.array(z.string()).default([]),
  status: GoalStatus.default('ACTIVE'),
  /** Pointer to the most recently SUCCEEDED task — the chain "head" for linear chains. */
  currentHeadTaskId: z.string().uuid().nullable().default(null),
  /** Pointer to the next READY task the orchestrator should advance to. */
  nextReadyTaskId: z.string().uuid().nullable().default(null),
  /** Counters for budget enforcement. */
  taskCount: z.number().int().nonnegative().default(0),
  succeededTaskCount: z.number().int().nonnegative().default(0),
  failedTaskCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().default(null),
});
export type Goal = z.infer<typeof Goal>;

/**
 * Event types emitted by the task ledger. Persisted to the existing
 * `events` table (keyed by goalId / taskId in the payload, with runId
 * carried when the event was produced during a Supervisor run).
 */
export type TaskDomainEvent =
  | {
      type: 'goal_created';
      goalId: string;
      runId?: string;
      payload: { title: string; taskCount: number };
      occurredAt: string;
    }
  | {
      type: 'task_created';
      goalId: string;
      taskId: string;
      runId?: string;
      payload: { type: TaskType; sequence: number; dependencies: string[] };
      occurredAt: string;
    }
  | {
      type: 'task_status_changed';
      goalId: string;
      taskId: string;
      runId?: string;
      payload: { from: TaskStatus; to: TaskStatus; reason: string };
      occurredAt: string;
    }
  | {
      type: 'task_attempt_started';
      goalId: string;
      taskId: string;
      attemptId: string;
      runId?: string;
      payload: { attemptNumber: number; modelUsed: string };
      occurredAt: string;
    }
  | {
      type: 'task_attempt_completed';
      goalId: string;
      taskId: string;
      attemptId: string;
      runId?: string;
      payload: { outcome: AttemptOutcome; latencyMs: number };
      occurredAt: string;
    }
  | {
      type: 'task_output_committed';
      goalId: string;
      taskId: string;
      runId?: string;
      payload: { outputSummary: string; artifactIds: string[] };
      occurredAt: string;
    }
  | {
      type: 'goal_status_changed';
      goalId: string;
      runId?: string;
      payload: { from: GoalStatus; to: GoalStatus; reason: string };
      occurredAt: string;
    };

/**
 * Result of attempting to advance the chain. The orchestrator uses
 * this to decide whether to keep going (next task became READY),
 * stop (terminal state reached), or wait (no progress possible
 * without external input).
 */
export type AdvanceResult =
  | { kind: 'advanced'; taskId: string; attemptId: string; outcome: AttemptOutcome }
  | { kind: 'no_ready_task'; reason: string }
  | { kind: 'goal_terminal'; goalStatus: GoalStatus }
  | { kind: 'error'; error: string };
