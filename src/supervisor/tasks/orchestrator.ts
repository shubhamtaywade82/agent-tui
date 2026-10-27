/**
 * Task orchestrator — drives the chain forward.
 *
 * The orchestrator is the bridge between the durable task ledger and
 * the existing Supervisor engine. For each advance:
 *
 *   1. Pick the next READY task (lowest sequence).
 *   2. Build context from the goal + the task's dependency outputs
 *      (the chain so far).
 *   3. Construct an objective string that the existing Supervisor
 *      engine can consume, plus a task-type hint that drives model
 *      selection.
 *   4. Call Supervisor.run({ objective, allowedPaths, ... }). The
 *      engine already enforces escalation, validation, and the
 *      COMPLETED-gating contract from PR #31.
 *   5. Map the Supervisor's RunOutcome back to a TaskAttempt + an
 *      AttemptOutcome. If SUCCEEDED, commit the verified output to
 *      the ledger (which unblocks dependents). If FAILED, mark the
 *      task as retrying or fail it terminally depending on attemptCount.
 *
 * The orchestrator does NOT call models directly. The Supervisor
 * engine is the only inference path. This keeps one policy path for
 * all model invocations — local and cloud — per the spec's "one policy
 * path for all providers" rule.
 *
 * Recovery: on boot, call `orchestrator.recover(goalId)` to reconcile
 * any task left in RUNNING by a crashed process.
 */

import type { CodeChangeExecutor } from '../code/code-change-executor.js';
import type { Supervisor } from '../engine.js';
import { logger } from '../observability/logger.js';
import type { AgentState } from '../state/models.js';
import type { TaskLedger } from './ledger.js';
import type { AttemptOutcome, Goal, TaskNode, TaskType } from './models.js';
import type { TaskStore } from './store.js';

export interface AdvanceOptions {
  /** Maximum number of tasks to advance in a single call. Default 1. */
  maxSteps?: number;
  /** Caller-authorised filesystem scope, propagated to the Supervisor engine. */
  allowedPaths?: string[];
  /** Caller identity, propagated to the Supervisor engine. */
  userId?: string;
  projectId?: string;
  /** Context to inject into each task's objective (free-text). */
  context?: string;
  /**
   * Phase 5 — absolute path to the repository root for CODE_CHANGE
   * tasks. When omitted, CODE_CHANGE tasks fail with a clear error
   * (the CodeChangeExecutor needs a real repo to apply patches against).
   */
  repoPath?: string;
}

export interface AdvanceStepResult {
  taskId: string;
  taskType: TaskType;
  /** The Supervisor runId that executed this task's attempt. */
  runId: string;
  /** Run-level outcome returned by the Supervisor engine. */
  runStatus: AgentState['status'];
  /** Task-level outcome mapped from the run. */
  outcome: AttemptOutcome;
  /** Whether the chain advanced (task SUCCEEDED → next READY). */
  advanced: boolean;
  /** Final-response preview from the run, for human display. */
  finalResponsePreview?: string;
}

/**
 * Map a Supervisor AgentState to a task-level AttemptOutcome.
 *
 * The Supervisor (post-PR #31) records:
 *   - status = COMPLETED + outcome = SUCCEEDED → real verified success
 *   - status = COMPLETED + outcome = SIMULATED → no executor; non-authoritative
 *   - status = COMPLETED + outcome = FAILED     → impossible post-PR #31
 *   - status = FAILED                          → validation failed
 *   - status = ESCALATED                       → handed to fallback
 *
 * ValidationReport is read from state.validationOutcome (populated by
 * the strengthened stepValidateOutput).
 */
function mapRunToOutcome(state: AgentState): AttemptOutcome {
  if (state.status === 'ESCALATED') return 'ESCALATED';
  if (state.status === 'FAILED') {
    if (state.validationOutcome && !state.validationOutcome.ok) {
      return 'FAILED_VALIDATION';
    }
    return 'FAILED_EXECUTION';
  }
  if (state.status === 'COMPLETED') {
    const simulated = state.executionResult?.startsWith('SIMULATED_SUCCESS') ?? false;
    if (simulated) return 'SIMULATED';
    return 'SUCCEEDED';
  }
  // Should not happen — the Supervisor reaches a terminal state before returning.
  return 'FAILED';
}

export class TaskOrchestrator {
  constructor(
    private readonly ledger: TaskLedger,
    private readonly supervisor: Supervisor,
    private readonly store: TaskStore,
    /**
     * Phase 5 — code-change executor. When omitted, CODE_CHANGE tasks
     * fail with a clear error rather than silently routing through
     * the generic Supervisor.run path (which would accept the model's
     * output as the result without applying or verifying any patch).
     */
    private readonly codeChangeExecutor?: CodeChangeExecutor,
  ) {}

  /**
   * Advance the chain by up to `maxSteps` tasks. Stops early if:
   *   - no READY task is available (chain blocked or all done)
   *   - a task fails terminally (cascade BLOCKED halts the goal)
   *   - a task requires escalation that can't be satisfied (FAILED)
   *
   * Each step is independent: a crash between steps leaves the chain
   * in a consistent state because the ledger commits each task's
   * output atomically.
   */
  async advance(
    goalId: string,
    opts: AdvanceOptions = {},
  ): Promise<{
    steps: AdvanceStepResult[];
    stoppedReason:
      | 'no_ready_task'
      | 'goal_terminal'
      | 'task_failed'
      | 'max_steps_reached'
      | 'error';
  }> {
    const maxSteps = opts.maxSteps ?? 1;
    const steps: AdvanceStepResult[] = [];

    for (let i = 0; i < maxSteps; i++) {
      const goal = await this.ledger.getGoal(goalId);
      if (!goal) {
        return { steps, stoppedReason: 'error' };
      }
      if (goal.status !== 'ACTIVE') {
        return { steps, stoppedReason: 'goal_terminal' };
      }

      const ready = await this.ledger.listReadyTasks(goalId);
      if (ready.length === 0) {
        return { steps, stoppedReason: 'no_ready_task' };
      }
      const task = ready[0];
      if (!task) break;

      const result = await this.runOneTask(task, goal, opts);
      steps.push(result);

      if (!result.advanced) {
        if (
          result.outcome === 'FAILED' ||
          result.outcome === 'FAILED_VALIDATION' ||
          result.outcome === 'FAILED_EXECUTION'
        ) {
          return { steps, stoppedReason: 'task_failed' };
        }
        // SIMULATED or ESCALATED without progression — stop and let the
        // caller decide whether to retry with a different configuration.
        return { steps, stoppedReason: 'task_failed' };
      }
    }

    return {
      steps,
      stoppedReason: maxSteps === steps.length ? 'max_steps_reached' : 'no_ready_task',
    };
  }

  private async runOneTask(
    task: TaskNode,
    goal: Goal,
    opts: AdvanceOptions,
  ): Promise<AdvanceStepResult> {
    // Phase 5 — CODE_CHANGE tasks route through the CodeChangeExecutor,
    // which applies a structured patch in an isolated git worktree and
    // runs verification commands. The generic Supervisor.run path would
    // accept the model's output as the result without applying or
    // verifying any patch — that's the failure mode this branch prevents.
    if (task.type === 'CODE_CHANGE') {
      return this.runCodeChangeTask(task, goal, opts);
    }
    return this.runGenericTask(task, goal, opts);
  }

  private async runCodeChangeTask(
    task: TaskNode,
    goal: Goal,
    opts: AdvanceOptions,
  ): Promise<AdvanceStepResult> {
    if (!this.codeChangeExecutor) {
      logger.error(
        { taskId: task.taskId, goalId: goal.goalId },
        'CODE_CHANGE task but no CodeChangeExecutor wired — failing loudly',
      );
      await this.ledger.failTask(task.taskId, 'CODE_CHANGE task but no CodeChangeExecutor wired');
      return {
        taskId: task.taskId,
        taskType: task.type,
        runId: '(none)',
        runStatus: 'FAILED',
        outcome: 'FAILED',
        advanced: false,
        finalResponsePreview: 'CODE_CHANGE task but no CodeChangeExecutor wired',
      };
    }
    if (!opts.repoPath) {
      logger.error(
        { taskId: task.taskId, goalId: goal.goalId },
        'CODE_CHANGE task but no repoPath supplied — failing loudly',
      );
      await this.ledger.failTask(task.taskId, 'CODE_CHANGE task but no repoPath supplied');
      return {
        taskId: task.taskId,
        taskType: task.type,
        runId: '(none)',
        runStatus: 'FAILED',
        outcome: 'FAILED',
        advanced: false,
        finalResponsePreview: 'CODE_CHANGE task but no repoPath supplied',
      };
    }

    const dependencyOutputs = await this.collectDependencyOutputs(task);
    const objective = this.buildObjective(task, goal, dependencyOutputs, opts.context);

    // Use the Supervisor engine to create a run record (for audit) but
    // don't run inference through it — the CodeChangeExecutor calls the
    // analyst model directly to get the structured patch proposal.
    const run = await this.supervisor.run({
      objective: `(code-change task setup) ${task.title}`,
      userId: opts.userId ?? goal.userId,
      projectId: opts.projectId ?? goal.projectId,
      allowedPaths: opts.allowedPaths ?? [],
      context: opts.context,
    });
    await this.ledger.markRunning(task.taskId, run.runId);

    const result = await this.codeChangeExecutor.execute({
      objective,
      runId: run.runId,
      repoPath: opts.repoPath,
      allowedPaths: opts.allowedPaths,
      userId: opts.userId ?? goal.userId,
      projectId: opts.projectId ?? goal.projectId,
    });

    // Map the CodeChangeExecutor's result to an AttemptOutcome + validationReport.
    const outcome: AttemptOutcome = result.ok ? 'SUCCEEDED' : 'FAILED_EXECUTION';
    const validationReport = {
      passed: result.ok,
      checks: [
        {
          id: 'patch-proposal-schema',
          required: true,
          status: (result.errors.length === 0 ? 'PASSED' : 'FAILED') as 'PASSED' | 'FAILED',
          message:
            result.errors.length === 0 ? 'patch proposal schema-valid' : result.errors.join('; '),
        },
        {
          id: 'patch-applied',
          required: true,
          status: (result.diff.length > 0 || result.ok ? 'PASSED' : 'FAILED') as
            | 'PASSED'
            | 'FAILED',
          message:
            result.diff.length > 0
              ? `diff produced (${result.diff.length} chars)`
              : (result.error ?? 'no diff'),
        },
        ...result.verifyResults.map((v) => ({
          id: `verify:${v.command}`,
          required: true,
          status: (v.ok ? 'PASSED' : 'FAILED') as 'PASSED' | 'FAILED',
          message: `exit ${v.exitCode}: ${v.stderr.slice(0, 120) || v.stdout.slice(0, 120)}`,
        })),
      ],
      failureCodes: result.ok ? [] : [result.error ?? 'verification failed'],
    };

    await this.ledger.appendAttempt(task.taskId, {
      taskId: task.taskId,
      modelUsed: this.codeChangeExecutor.constructor.name,
      providerUsed: undefined,
      rawOutput: result.rawOutput,
      parsedProposal: result.proposal as Record<string, unknown> | undefined,
      proposalValid: result.errors.length === 0,
      executionResult: result.ok
        ? `Patch applied. Diff: ${result.diff.length} chars. Commit: ${result.commitSha ?? '(none)'}`
        : (result.error ?? 'patch failed'),
      validationReport,
      outcome,
      latencyMs: 0,
      tokens: { prompt: 0, completion: 0 },
    });

    if (result.ok) {
      const output: Record<string, unknown> = {
        diff: result.diff,
        commitSha: result.commitSha,
        verifyResults: result.verifyResults,
        proposal: result.proposal,
      };
      await this.ledger.commitTaskOutput(
        task.taskId,
        output,
        `Patch applied: ${Object.keys(result.proposal?.files ?? {}).length} files, diff ${result.diff.length} chars`,
        [],
        [],
      );
      return {
        taskId: task.taskId,
        taskType: task.type,
        runId: run.runId,
        runStatus: run.status,
        outcome,
        advanced: true,
        finalResponsePreview: result.diff.slice(0, 200),
      };
    }

    // Failed — retry if budget allows, else fail terminally.
    const updated = await this.ledger.getTask(task.taskId);
    if (updated && updated.attemptCount >= updated.maxAttempts) {
      await this.ledger.failTask(task.taskId, `maxAttempts reached: ${result.error}`);
    } else {
      await this.ledger.markRetrying(task.taskId, result.error ?? 'patch failed');
    }
    return {
      taskId: task.taskId,
      taskType: task.type,
      runId: run.runId,
      runStatus: run.status,
      outcome,
      advanced: false,
      finalResponsePreview: result.error?.slice(0, 200),
    };
  }

  private async runGenericTask(
    task: TaskNode,
    goal: Goal,
    opts: AdvanceOptions,
  ): Promise<AdvanceStepResult> {
    // Build the objective the Supervisor engine will consume. The engine
    // runs the full ROUTE → EXECUTE → VALIDATE loop; the orchestrator
    // only feeds it a prompt + the chain context.
    const dependencyOutputs = await this.collectDependencyOutputs(task);
    const objective = this.buildObjective(task, goal, dependencyOutputs, opts.context);

    // The Supervisor creates a fresh run for each task attempt. The runId
    // is recorded on the task so the audit trail links task ↔ run.
    const run = await this.supervisor.run({
      objective,
      userId: opts.userId ?? goal.userId,
      projectId: opts.projectId ?? goal.projectId,
      allowedPaths: opts.allowedPaths ?? [],
      context: opts.context,
    });

    await this.ledger.markRunning(task.taskId, run.runId);

    const outcome = mapRunToOutcome(run);

    // Record the attempt on the task. The orchestrator treats the run's
    // validationOutcome as the attempt's validationReport.
    await this.ledger.appendAttempt(task.taskId, {
      taskId: task.taskId,
      modelUsed: run.steps.find((s) => s.modelName)?.modelName ?? 'unknown',
      providerUsed: undefined,
      rawOutput: run.executionResult,
      parsedProposal: undefined,
      proposalValid: run.validationOutcome?.ok ?? false,
      executionResult: run.executionResult,
      validationReport: (() => {
        const vo = run.validationOutcome;
        if (!vo) return undefined;
        return {
          passed: vo.ok,
          checks: vo.validators.map((v) => ({
            id: v,
            required: true,
            status: (vo.ok ? 'PASSED' : 'FAILED') as 'PASSED' | 'FAILED',
            message: vo.reasons.join('; ') || '(no detail)',
          })),
          failureCodes: vo.reasons,
        };
      })(),
      outcome,
      latencyMs: 0,
      tokens: { prompt: 0, completion: 0 },
    });

    if (outcome === 'SUCCEEDED' && run.validationOutcome?.ok) {
      // Commit the verified output. This atomically transitions the task
      // to SUCCEEDED, sets goal.currentHeadTaskId, and unblocks dependents.
      const output: Record<string, unknown> = {
        executionResult: run.executionResult ?? '',
        finalResponse: run.finalResponse ?? '',
        validationOutcome: run.validationOutcome,
      };
      await this.ledger.commitTaskOutput(
        task.taskId,
        output,
        (run.finalResponse ?? run.executionResult ?? '').slice(0, 240),
        [],
        [],
      );
      return {
        taskId: task.taskId,
        taskType: task.type,
        runId: run.runId,
        runStatus: run.status,
        outcome,
        advanced: true,
        finalResponsePreview: run.finalResponse?.slice(0, 200),
      };
    }

    if (outcome === 'SIMULATED') {
      // The Supervisor reported SIMULATED_SUCCESS — non-authoritative.
      // Treat as a recoverable failure: retry if budget allows, else fail.
      logger.warn(
        { taskId: task.taskId, runId: run.runId },
        'task attempt produced SIMULATED_SUCCESS — retrying or failing',
      );
      await this.ledger.markRetrying(task.taskId, 'simulated success is non-authoritative');
      return {
        taskId: task.taskId,
        taskType: task.type,
        runId: run.runId,
        runStatus: run.status,
        outcome,
        advanced: false,
        finalResponsePreview: run.finalResponse?.slice(0, 200),
      };
    }

    if (outcome === 'ESCALATED') {
      await this.ledger.markEscalated(task.taskId, 'supervisor escalated during attempt');
      return {
        taskId: task.taskId,
        taskType: task.type,
        runId: run.runId,
        runStatus: run.status,
        outcome,
        advanced: false,
        finalResponsePreview: run.finalResponse?.slice(0, 200),
      };
    }

    // FAILED_VALIDATION / FAILED_EXECUTION / FAILED → retry or fail terminally.
    const updated = await this.ledger.getTask(task.taskId);
    if (updated && updated.attemptCount >= updated.maxAttempts) {
      await this.ledger.failTask(
        task.taskId,
        `maxAttempts (${updated.maxAttempts}) reached — last outcome ${outcome}`,
      );
    } else {
      await this.ledger.markRetrying(task.taskId, `attempt failed: ${outcome}`);
    }
    return {
      taskId: task.taskId,
      taskType: task.type,
      runId: run.runId,
      runStatus: run.status,
      outcome,
      advanced: false,
      finalResponsePreview: run.finalResponse?.slice(0, 200),
    };
  }

  /**
   * Collect the verified outputs of a task's direct dependencies.
   * This is the "chain context" the next task sees — the
   * doubly-linked-list / DAG property: a task can read what its
   * predecessors produced, but only after they SUCCEEDED.
   */
  private async collectDependencyOutputs(task: TaskNode): Promise<
    Array<{
      taskId: string;
      type: TaskType;
      title: string;
      outputSummary: string | null;
      output: Record<string, unknown> | null;
    }>
  > {
    const outputs: Array<{
      taskId: string;
      type: TaskType;
      title: string;
      outputSummary: string | null;
      output: Record<string, unknown> | null;
    }> = [];
    for (const depId of task.dependencies) {
      const dep = await this.store.getTask(depId);
      if (dep && dep.status === 'SUCCEEDED') {
        outputs.push({
          taskId: dep.taskId,
          type: dep.type,
          title: dep.title,
          outputSummary: dep.outputSummary,
          output: dep.output,
        });
      }
    }
    return outputs;
  }

  private buildObjective(
    task: TaskNode,
    goal: Goal,
    dependencyOutputs: Array<{
      taskId: string;
      type: TaskType;
      title: string;
      outputSummary: string | null;
      output: Record<string, unknown> | null;
    }>,
    extraContext?: string,
  ): string {
    const lines: string[] = [
      `# Goal: ${goal.title}`,
      ``,
      goal.objective,
      ``,
      `# Current task (${task.sequence + 1}): ${task.title}`,
      ``,
      task.objective,
      ``,
    ];
    if (dependencyOutputs.length > 0) {
      lines.push(`# Verified outputs from previous tasks (chain context)`);
      for (const dep of dependencyOutputs) {
        lines.push(`## ${dep.title} (task #${dep.taskId.slice(0, 8)}, type ${dep.type})`);
        if (dep.outputSummary) lines.push(dep.outputSummary);
        if (dep.output && Object.keys(dep.output).length > 0) {
          lines.push('```json');
          lines.push(JSON.stringify(dep.output, null, 2));
          lines.push('```');
        }
        lines.push('');
      }
    }
    if (goal.acceptanceCriteria.length > 0) {
      lines.push(`# Goal acceptance criteria`);
      for (const c of goal.acceptanceCriteria) lines.push(`- ${c}`);
      lines.push('');
    }
    if (extraContext) {
      lines.push(`# Additional context`, extraContext, '');
    }
    lines.push(
      `# Your contract`,
      `Produce a structured, verifiable answer for THIS task only. Do not attempt the entire goal.`,
      `If the task requires a tool call, propose it; the harness will execute it and feed the result back.`,
      `If the previous task outputs are insufficient to proceed, say so explicitly — do not invent.`,
    );
    return lines.join('\n');
  }

  /**
   * Reconcile in-flight tasks after a process restart. Returns the
   * IDs of tasks whose state was changed by recovery.
   */
  async recover(goalId: string): Promise<{ reconciled: string[] }> {
    return this.ledger.reconcileInFlight(goalId);
  }
}
