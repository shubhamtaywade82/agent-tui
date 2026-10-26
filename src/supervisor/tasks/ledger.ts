/**
 * Task ledger service — the high-level operations the orchestrator calls.
 *
 * The ledger owns the chain invariants:
 *   1. A task cannot transition to SUCCEEDED without a passing
 *      ValidationReport on its active attempt.
 *   2. commitTaskOutput is atomic — status transition, output commit,
 *      goal head update, and dependent unblock happen in one transaction.
 *   3. Every state-changing operation emits a TaskDomainEvent so the
 *      audit trail is complete.
 *   4. failTask cascades BLOCKED transitively to dependents.
 *
 * The ledger does NOT call the model — that's the orchestrator's job.
 * The ledger is the deterministic backbone; the orchestrator drives it
 * forward by feeding verified attempts in.
 */
import { logger } from '../observability/logger.js';
import type { AttemptOutcome, Goal, TaskDomainEvent, TaskNode, TaskType } from './models.js';
import {
  Goal as GoalSchema,
  TaskAttempt as TaskAttemptSchema,
  TaskNode as TaskNodeSchema,
} from './models.js';
import type { TaskStore } from './store.js';

export interface CreateGoalInput {
  userId?: string;
  projectId?: string;
  title: string;
  objective: string;
  acceptanceCriteria?: string[];
}

export interface CreateTaskInput {
  goalId: string;
  parentTaskId?: string;
  sequence: number;
  type: TaskType;
  title: string;
  objective: string;
  dependencies?: string[];
  inputArtifactIds?: string[];
  maxAttempts?: number;
}

export interface CommitAttemptInput {
  taskId: string;
  modelUsed: string;
  providerUsed?: string;
  rawOutput?: string;
  parsedProposal?: Record<string, unknown>;
  proposalValid: boolean;
  executionResult?: string;
  validationReport?: {
    passed: boolean;
    checks: Array<{
      id: string;
      required: boolean;
      status: 'PASSED' | 'FAILED' | 'SKIPPED' | 'NOT_APPLICABLE';
      message: string;
    }>;
    failureCodes: string[];
  };
  outcome: AttemptOutcome;
  latencyMs: number;
  tokens?: { prompt: number; completion: number };
}

export class TaskLedger {
  constructor(private readonly store: TaskStore) {}

  // ── Goal lifecycle ───────────────────────────────────────────────────

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    const now = new Date().toISOString();
    const goal = GoalSchema.parse({
      goalId: crypto.randomUUID(),
      userId: input.userId,
      projectId: input.projectId,
      title: input.title,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      status: 'ACTIVE',
      currentHeadTaskId: null,
      nextReadyTaskId: null,
      taskCount: 0,
      succeededTaskCount: 0,
      failedTaskCount: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    await this.store.createGoal(goal);
    await this.emit({
      type: 'goal_created',
      goalId: goal.goalId,
      payload: { title: goal.title, taskCount: 0 },
      occurredAt: now,
    });
    return goal;
  }

  async getGoal(goalId: string): Promise<Goal | null> {
    return this.store.getGoal(goalId);
  }

  async listGoals(opts?: {
    userId?: string;
    projectId?: string;
    status?: Goal['status'];
  }): Promise<Goal[]> {
    return this.store.listGoals(opts);
  }

  // ── Task lifecycle ───────────────────────────────────────────────────

  async createTask(input: CreateTaskInput): Promise<TaskNode> {
    const goal = await this.store.getGoal(input.goalId);
    if (!goal) throw new Error(`goal not found: ${input.goalId}`);
    if (goal.status !== 'ACTIVE') {
      throw new Error(`goal ${input.goalId} is ${goal.status} — cannot add tasks`);
    }
    const now = new Date().toISOString();
    // Root tasks (no dependencies) become READY immediately so the
    // orchestrator can pick them up.
    const deps = input.dependencies ?? (input.parentTaskId ? [input.parentTaskId] : []);
    const initialStatus = deps.length === 0 ? 'READY' : 'PENDING';
    const task = TaskNodeSchema.parse({
      taskId: crypto.randomUUID(),
      goalId: input.goalId,
      parentTaskId: input.parentTaskId ?? null,
      sequence: input.sequence,
      type: input.type,
      title: input.title,
      objective: input.objective,
      status: initialStatus,
      dependencies: deps,
      inputArtifactIds: input.inputArtifactIds ?? [],
      outputArtifactIds: [],
      evidenceIds: [],
      output: null,
      outputSummary: null,
      attempts: [],
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? 3,
      activeRunId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    await this.store.createTask(task);
    await this.emit({
      type: 'task_created',
      goalId: task.goalId,
      taskId: task.taskId,
      payload: { type: task.type, sequence: task.sequence, dependencies: task.dependencies },
      occurredAt: now,
    });
    if (initialStatus === 'READY') {
      await this.emit({
        type: 'task_status_changed',
        goalId: task.goalId,
        taskId: task.taskId,
        payload: { from: 'PENDING', to: 'READY', reason: 'no dependencies' },
        occurredAt: now,
      });
    }
    return task;
  }

  async getTask(taskId: string): Promise<TaskNode | null> {
    return this.store.getTask(taskId);
  }

  async listTasksByGoal(goalId: string): Promise<TaskNode[]> {
    return this.store.listTasksByGoal(goalId);
  }

  async listReadyTasks(goalId: string): Promise<TaskNode[]> {
    return this.store.listReadyTasks(goalId);
  }

  /**
   * Mark a task as RUNNING with an active runId (the Supervisor run
   * executing this task's attempt). Returns the updated task.
   */
  async markRunning(taskId: string, runId: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== 'READY' && task.status !== 'RETRYING' && task.status !== 'ESCALATED') {
      throw new Error(
        `task ${taskId} cannot transition from ${task.status} to RUNNING — only READY/RETRYING/ESCALATED may run`,
      );
    }
    const from = task.status;
    await this.store.updateTaskStatus(taskId, 'RUNNING', { activeRunId: runId });
    await this.emit({
      type: 'task_status_changed',
      goalId: task.goalId,
      taskId,
      runId,
      payload: { from, to: 'RUNNING', reason: 'orchestrator began attempt' },
      occurredAt: new Date().toISOString(),
    });
  }

  /**
   * Append an attempt to a task. Does NOT change task status — that's
   * done by commitAttempt / failAttempt. This lets the orchestrator
   * record the model invocation separately from the verification
   * decision.
   */
  async appendAttempt(
    taskId: string,
    input: CommitAttemptInput,
  ): Promise<TaskNode['attempts'][number]> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const now = new Date().toISOString();
    const attempt = TaskAttemptSchema.parse({
      attemptId: crypto.randomUUID(),
      taskId,
      attemptNumber: task.attemptCount + 1,
      modelUsed: input.modelUsed,
      providerUsed: input.providerUsed,
      rawOutput: input.rawOutput,
      parsedProposal: input.parsedProposal,
      proposalValid: input.proposalValid,
      executionResult: input.executionResult,
      validationReport: input.validationReport,
      outcome: input.outcome,
      latencyMs: input.latencyMs,
      tokens: input.tokens ?? { prompt: 0, completion: 0 },
      startedAt: now,
      finishedAt: now,
    });
    await this.store.appendAttempt(taskId, attempt);
    await this.emit({
      type: 'task_attempt_completed',
      goalId: task.goalId,
      taskId,
      attemptId: attempt.attemptId,
      runId: task.activeRunId ?? undefined,
      payload: { outcome: attempt.outcome ?? 'FAILED', latencyMs: attempt.latencyMs },
      occurredAt: now,
    });
    return attempt;
  }

  /**
   * Commit a verified task output. This is the ONLY path to SUCCEEDED.
   * Atomically:
   *   - sets task status = SUCCEEDED
   *   - sets output + outputSummary + evidenceIds + outputArtifactIds
   *   - sets goal.currentHeadTaskId = taskId
   *   - unblocks dependents (PENDING → READY)
   *   - emits task_output_committed + task_status_changed events
   *
   * Precondition: the active attempt's validationReport.passed === true.
   * The orchestrator must enforce this before calling — the ledger
   * double-checks but does not run the verifier itself.
   */
  async commitTaskOutput(
    taskId: string,
    output: Record<string, unknown>,
    outputSummary: string,
    evidenceIds: string[],
    artifactIds: string[],
  ): Promise<TaskNode> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const active = task.attempts.at(-1);
    if (!active) {
      throw new Error(`cannot commit task ${taskId}: no attempt recorded`);
    }
    if (!active.validationReport?.passed) {
      throw new Error(
        `cannot commit task ${taskId}: active attempt validationReport.passed is false ` +
          `— chain advancement is gated on verified output`,
      );
    }
    const from = task.status;
    await this.store.commitTaskOutput(taskId, output, outputSummary, evidenceIds, artifactIds);
    const now = new Date().toISOString();
    await this.emit({
      type: 'task_status_changed',
      goalId: task.goalId,
      taskId,
      runId: task.activeRunId ?? undefined,
      payload: { from, to: 'SUCCEEDED', reason: 'verification passed' },
      occurredAt: now,
    });
    await this.emit({
      type: 'task_output_committed',
      goalId: task.goalId,
      taskId,
      runId: task.activeRunId ?? undefined,
      payload: { outputSummary, artifactIds },
      occurredAt: now,
    });

    // Check goal completion: all tasks terminal and at least one succeeded.
    await this.maybeCompleteGoal(task.goalId);

    const updated = await this.store.getTask(taskId);
    return updated ?? task;
  }

  /**
   * Fail a task terminally. Cascades BLOCKED to all transitive
   * dependents. If the failed task is on the goal's critical path
   * (i.e. any non-terminal task depends transitively on it), the goal
   * itself transitions to FAILED.
   */
  async failTask(taskId: string, reason: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const from = task.status;
    await this.store.failTask(taskId, reason);
    const now = new Date().toISOString();
    await this.emit({
      type: 'task_status_changed',
      goalId: task.goalId,
      taskId,
      runId: task.activeRunId ?? undefined,
      payload: { from, to: 'FAILED', reason },
      occurredAt: now,
    });

    // Cascade event for each blocked dependent.
    const dependents = await this.listTransitiveDependents(task.goalId, taskId);
    for (const depId of dependents) {
      const dep = await this.store.getTask(depId);
      if (dep && dep.status === 'BLOCKED') {
        await this.emit({
          type: 'task_status_changed',
          goalId: task.goalId,
          taskId: depId,
          payload: { from: 'PENDING', to: 'BLOCKED', reason: `dependency ${taskId} failed` },
          occurredAt: now,
        });
      }
    }

    // Goal completion check — failed task may have terminalised the goal.
    await this.maybeCompleteGoal(task.goalId);
  }

  /**
   * Record a recoverable failure: bump attemptCount, transition the
   * task to RETRYING (the orchestrator will schedule the next attempt
   * or escalate after maxAttempts is hit). Does NOT cascade BLOCKED —
   * only failTask does that.
   */
  async markRetrying(taskId: string, reason: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.attemptCount >= task.maxAttempts) {
      // Budget exhausted — fail terminally instead of retrying.
      await this.failTask(taskId, `maxAttempts (${task.maxAttempts}) reached: ${reason}`);
      return;
    }
    const from = task.status;
    await this.store.updateTaskStatus(taskId, 'RETRYING', { activeRunId: null });
    await this.emit({
      type: 'task_status_changed',
      goalId: task.goalId,
      taskId,
      payload: { from, to: 'RETRYING', reason },
      occurredAt: new Date().toISOString(),
    });
  }

  /**
   * Record an escalation: the task has been handed off to a stronger
   * model. The orchestrator will create a new attempt with the
   * fallback model.
   */
  async markEscalated(taskId: string, reason: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const from = task.status;
    await this.store.updateTaskStatus(taskId, 'ESCALATED');
    await this.emit({
      type: 'task_status_changed',
      goalId: task.goalId,
      taskId,
      payload: { from, to: 'ESCALATED', reason },
      occurredAt: new Date().toISOString(),
    });
  }

  // ── Recovery ─────────────────────────────────────────────────────────

  /**
   * After a process restart, find any task that was RUNNING when the
   * process died and reconcile its state. A task left in RUNNING
   * without an active attempt that produced a verified output is
   * transitioned back to READY (or FAILED if its runId recorded a
   * FAILED outcome). The orchestrator calls this on boot.
   */
  async reconcileInFlight(goalId: string): Promise<{ reconciled: string[] }> {
    const tasks = await this.store.listTasksByGoal(goalId);
    const reconciled: string[] = [];
    for (const t of tasks) {
      if (t.status === 'RUNNING') {
        const active = t.attempts.at(-1);
        if (active?.validationReport?.passed === true) {
          // Verified but never committed — commit now.
          await this.store.commitTaskOutput(
            t.taskId,
            active.parsedProposal ?? {},
            '(reconciled after restart)',
            t.evidenceIds,
            t.outputArtifactIds,
          );
          reconciled.push(t.taskId);
        } else if (
          active?.outcome === 'FAILED' ||
          active?.outcome === 'FAILED_VALIDATION' ||
          active?.outcome === 'FAILED_EXECUTION'
        ) {
          // Last attempt failed terminally — fail the task.
          await this.store.failTask(t.taskId, 'reconciled: last attempt failed before restart');
          reconciled.push(t.taskId);
        } else {
          // In-flight without a verified outcome — return to READY.
          await this.store.updateTaskStatus(t.taskId, 'READY', { activeRunId: null });
          reconciled.push(t.taskId);
        }
      }
    }
    return { reconciled };
  }

  // ── Audit ─────────────────────────────────────────────────────────────

  async listTaskEvents(goalId: string): Promise<TaskDomainEvent[]> {
    return this.store.listTaskEvents(goalId);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async listTransitiveDependents(goalId: string, taskId: string): Promise<string[]> {
    const all = await this.store.listTasksByGoal(goalId);
    const result: string[] = [];
    const stack = [taskId];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      for (const t of all) {
        if (t.dependencies.includes(current) && !seen.has(t.taskId)) {
          result.push(t.taskId);
          stack.push(t.taskId);
        }
      }
    }
    return result;
  }

  private async maybeCompleteGoal(goalId: string): Promise<void> {
    const goal = await this.store.getGoal(goalId);
    if (goal?.status !== 'ACTIVE') return;
    const tasks = await this.store.listTasksByGoal(goalId);
    if (tasks.length === 0) return;
    const allTerminal = tasks.every(
      (t) =>
        t.status === 'SUCCEEDED' ||
        t.status === 'FAILED' ||
        t.status === 'BLOCKED' ||
        t.status === 'CANCELLED',
    );
    if (!allTerminal) return;
    const anyFailed = tasks.some((t) => t.status === 'FAILED' || t.status === 'BLOCKED');
    const newStatus: Goal['status'] = anyFailed ? 'FAILED' : 'SUCCEEDED';
    const now = new Date().toISOString();
    await this.store.updateGoalStatus(goalId, newStatus, { completedAt: now });
    await this.emit({
      type: 'goal_status_changed',
      goalId,
      payload: { from: 'ACTIVE', to: newStatus, reason: 'all tasks terminal' },
      occurredAt: now,
    });
    logger.info({ goalId, status: newStatus }, 'goal reached terminal status');
  }

  private async emit(event: TaskDomainEvent): Promise<void> {
    try {
      await this.store.appendTaskEvent(event);
    } catch (e) {
      // Event persistence failure must not break the chain — but it MUST
      // be visible. Log loudly; the test suite asserts events separately.
      logger.warn({ err: e, eventType: event.type }, 'task event persistence failed');
    }
  }
}
