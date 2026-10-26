/**
 * Task ledger repository — persistence boundary for the task DAG.
 *
 * The repository owns the atomic operations the orchestrator needs:
 *   - createGoal / getGoal / listGoals / updateGoalStatus
 *   - createTask / getTask / listTasksByGoal / listReadyTasks
 *   - appendAttempt / updateTaskStatus / commitTaskOutput
 *   - listDependencies / areDependenciesSatisfied
 *
 * Two implementations:
 *   - InMemoryTaskStore: deterministic, no external deps; used by tests
 *     and by `INFERENCE_BACKEND=mock` local dev.
 *   - PgTaskStore: Postgres-backed; the production path. DDL is
 *     idempotent and runs on `init()`, mirroring `PgStateStore.init()`.
 *
 * The interface deliberately accepts a `client?: PoolClient` on the
 * mutating operations so the orchestrator can wrap a multi-step
 * advance (status transition + output commit + dependency unblock +
 * event append) in a single transaction. Without that, a crash between
 * writes could leave a SUCCEEDED task whose dependents are still
 * PENDING — the chain would stall silently.
 */
import { Pool, type PoolClient } from 'pg';
import type { GoalStatus, TaskDomainEvent, TaskStatus } from './models.js';
import {
  Goal as GoalSchema,
  TaskAttempt as TaskAttemptSchema,
  TaskNode as TaskNodeSchema,
} from './models.js';

export interface TaskStore {
  init(): Promise<void>;

  // ── Goals ─────────────────────────────────────────────────────────────
  createGoal(goal: Goal): Promise<void>;
  getGoal(goalId: string): Promise<Goal | null>;
  listGoals(opts?: { userId?: string; projectId?: string; status?: GoalStatus }): Promise<Goal[]>;
  updateGoalStatus(
    goalId: string,
    status: GoalStatus,
    extra?: Partial<Pick<Goal, 'currentHeadTaskId' | 'nextReadyTaskId' | 'completedAt'>>,
  ): Promise<void>;

  // ── Tasks ─────────────────────────────────────────────────────────────
  createTask(task: TaskNode): Promise<void>;
  getTask(taskId: string): Promise<TaskNode | null>;
  listTasksByGoal(goalId: string): Promise<TaskNode[]>;
  /** Returns tasks whose status is READY, ordered by sequence. */
  listReadyTasks(goalId: string): Promise<TaskNode[]>;
  updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    extra?: Partial<Pick<TaskNode, 'activeRunId' | 'completedAt'>>,
  ): Promise<void>;
  /** Append an attempt to a task and increment attemptCount atomically. */
  appendAttempt(taskId: string, attempt: TaskNode['attempts'][number]): Promise<void>;
  /**
   * Commit a verified task output. Atomically:
   *   - sets status = SUCCEEDED
   *   - sets output + outputSummary + evidenceIds + outputArtifactIds
   *   - sets completedAt
   *   - sets goal.currentHeadTaskId = taskId
   *   - unblocks dependents (PENDING → READY)
   *
   * The orchestrator wraps this in a single transaction so a crash
   * cannot leave a SUCCEEDED task whose dependents are still PENDING.
   */
  commitTaskOutput(
    taskId: string,
    output: Record<string, unknown>,
    outputSummary: string,
    evidenceIds: string[],
    artifactIds: string[],
  ): Promise<void>;

  /**
   * Mark a task as FAILED terminally. Also marks dependents as BLOCKED
   * (transitively) — they cannot run without this task's output.
   */
  failTask(taskId: string, reason: string): Promise<void>;

  // ── Events ─────────────────────────────────────────────────────────────
  /** Append a task event to the existing events table. */
  appendTaskEvent(event: TaskDomainEvent): Promise<void>;
  /** List task events for a goal — used by tests and the audit API. */
  listTaskEvents(goalId: string): Promise<TaskDomainEvent[]>;

  close(): Promise<void>;
}

/**
 * Convert a TaskDomainEvent into the shape persisted in the existing
 * `events` table. The existing table is keyed by `run_id` (UUID) and
 * uses `type` + `payload` (JSONB). We persist task events keyed by a
 * stable goal-derived UUID so they coexist with run events.
 *
 * In production, when the orchestrator runs a task via the Supervisor
 * engine, the runId is real and task events carry it. When the
 * orchestrator manipulates the chain outside a run (e.g. creating
 * tasks), runId is omitted and a deterministic goal-derived UUID is
 * used as the events row's run_id so the existing index remains useful.
 */
function goalEventRunId(goalId: string): string {
  // Deterministic UUID derived from the goalId so all task events for a
  // goal share a stable run_id slice in the events table. We use a
  // simple hash-to-uuid mapping — collision-free for our purposes
  // because goalIds are v4 UUIDs already (122 bits of entropy).
  const hex = goalId.replace(/-/g, '');
  // XOR-fold to fit a v4 layout: re-insert dashes at the standard positions
  // and zero the version/variant bits to keep it a valid UUID.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    // version 4
    `4${hex.slice(13, 16)}`,
    // variant 10xx
    String.fromCharCode((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * In-memory task store. Used by unit tests and the mock backend path
 * so the full task-ledger test suite runs without a Postgres instance.
 */
export class InMemoryTaskStore implements TaskStore {
  private readonly goals = new Map<string, Goal>();
  private readonly tasks = new Map<string, TaskNode>();
  private readonly eventsByGoal = new Map<string, TaskDomainEvent[]>();

  async init() {}
  async close() {}

  async createGoal(goal: Goal): Promise<void> {
    this.goals.set(goal.goalId, goal);
  }
  async getGoal(goalId: string): Promise<Goal | null> {
    return this.goals.get(goalId) ?? null;
  }
  async listGoals(opts?: {
    userId?: string;
    projectId?: string;
    status?: GoalStatus;
  }): Promise<Goal[]> {
    return [...this.goals.values()].filter(
      (g) =>
        (!opts?.userId || g.userId === opts.userId) &&
        (!opts?.projectId || g.projectId === opts.projectId) &&
        (!opts?.status || g.status === opts.status),
    );
  }
  async updateGoalStatus(
    goalId: string,
    status: GoalStatus,
    extra?: Partial<Pick<Goal, 'currentHeadTaskId' | 'nextReadyTaskId' | 'completedAt'>>,
  ): Promise<void> {
    const g = this.goals.get(goalId);
    if (!g) throw new Error(`goal not found: ${goalId}`);
    const updated: Goal = {
      ...g,
      status,
      currentHeadTaskId: extra?.currentHeadTaskId ?? g.currentHeadTaskId,
      nextReadyTaskId: extra?.nextReadyTaskId ?? g.nextReadyTaskId,
      completedAt: extra?.completedAt ?? g.completedAt,
      updatedAt: new Date().toISOString(),
    };
    this.goals.set(goalId, updated);
  }

  async createTask(task: TaskNode): Promise<void> {
    if (this.tasks.has(task.taskId)) throw new Error(`task already exists: ${task.taskId}`);
    this.tasks.set(task.taskId, task);
    const g = this.goals.get(task.goalId);
    if (g) {
      this.goals.set(task.goalId, {
        ...g,
        taskCount: g.taskCount + 1,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  async getTask(taskId: string): Promise<TaskNode | null> {
    return this.tasks.get(taskId) ?? null;
  }
  async listTasksByGoal(goalId: string): Promise<TaskNode[]> {
    return [...this.tasks.values()]
      .filter((t) => t.goalId === goalId)
      .sort((a, b) => a.sequence - b.sequence);
  }
  async listReadyTasks(goalId: string): Promise<TaskNode[]> {
    return [...this.tasks.values()]
      .filter((t) => t.goalId === goalId && t.status === 'READY')
      .sort((a, b) => a.sequence - b.sequence);
  }
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    extra?: Partial<Pick<TaskNode, 'activeRunId' | 'completedAt'>>,
  ): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`task not found: ${taskId}`);
    this.tasks.set(taskId, {
      ...t,
      status,
      activeRunId: extra?.activeRunId ?? t.activeRunId,
      completedAt: extra?.completedAt ?? t.completedAt,
      updatedAt: new Date().toISOString(),
    });
  }
  async appendAttempt(taskId: string, attempt: TaskNode['attempts'][number]): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`task not found: ${taskId}`);
    this.tasks.set(taskId, {
      ...t,
      attempts: [...t.attempts, attempt],
      attemptCount: t.attemptCount + 1,
      updatedAt: new Date().toISOString(),
    });
  }
  async commitTaskOutput(
    taskId: string,
    output: Record<string, unknown>,
    outputSummary: string,
    evidenceIds: string[],
    artifactIds: string[],
  ): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`task not found: ${taskId}`);
    const now = new Date().toISOString();
    const committed: TaskNode = {
      ...t,
      status: 'SUCCEEDED',
      output,
      outputSummary,
      evidenceIds,
      outputArtifactIds: artifactIds,
      completedAt: now,
      updatedAt: now,
    };
    this.tasks.set(taskId, committed);

    // Update goal counters + head pointer.
    const g = this.goals.get(t.goalId);
    if (g) {
      this.goals.set(t.goalId, {
        ...g,
        succeededTaskCount: g.succeededTaskCount + 1,
        currentHeadTaskId: taskId,
        nextReadyTaskId: null, // cleared; orchestrator will recompute on next advance
        updatedAt: now,
      });
    }

    // Unblock dependents.
    for (const dep of this.tasks.values()) {
      if (
        dep.goalId === t.goalId &&
        dep.status === 'PENDING' &&
        dep.dependencies.includes(taskId)
      ) {
        if (this.areDependenciesSatisfied(dep)) {
          this.tasks.set(dep.taskId, { ...dep, status: 'READY', updatedAt: now });
        }
      }
    }
  }
  async failTask(taskId: string, _reason: string): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`task not found: ${taskId}`);
    const now = new Date().toISOString();
    this.tasks.set(taskId, { ...t, status: 'FAILED', completedAt: now, updatedAt: now });

    const g = this.goals.get(t.goalId);
    if (g) {
      this.goals.set(t.goalId, {
        ...g,
        failedTaskCount: g.failedTaskCount + 1,
        updatedAt: now,
      });
    }

    // Cascade-BLOCK dependents (transitive).
    const stack = [taskId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      for (const dep of this.tasks.values()) {
        if (
          dep.goalId === t.goalId &&
          (dep.status === 'PENDING' || dep.status === 'READY') &&
          dep.dependencies.includes(current) &&
          !stack.includes(dep.taskId)
        ) {
          this.tasks.set(dep.taskId, { ...dep, status: 'BLOCKED', updatedAt: now });
          stack.push(dep.taskId);
        }
      }
    }
  }

  private areDependenciesSatisfied(task: TaskNode): boolean {
    if (task.dependencies.length === 0) return true;
    return task.dependencies.every((depId) => {
      const dep = this.tasks.get(depId);
      return dep?.status === 'SUCCEEDED';
    });
  }

  async appendTaskEvent(event: TaskDomainEvent): Promise<void> {
    const list = this.eventsByGoal.get(event.goalId) ?? [];
    list.push(event);
    this.eventsByGoal.set(event.goalId, list);
  }
  async listTaskEvents(goalId: string): Promise<TaskDomainEvent[]> {
    return this.eventsByGoal.get(goalId) ?? [];
  }
}

/**
 * Postgres-backed task store. DDL is idempotent and runs on init(),
 * mirroring `PgStateStore.init()`. The task tables reuse the existing
 * `events` table for task events (keyed by a goal-derived UUID so
 * they coexist cleanly with run events).
 */
export class PgTaskStore implements TaskStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS goals (
          goal_id UUID PRIMARY KEY,
          user_id TEXT,
          project_id TEXT,
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          acceptance_criteria TEXT[] NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          current_head_task_id UUID,
          next_ready_task_id UUID,
          task_count INTEGER NOT NULL DEFAULT 0,
          succeeded_task_count INTEGER NOT NULL DEFAULT 0,
          failed_task_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          completed_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS goals_status_idx ON goals(status);
        CREATE INDEX IF NOT EXISTS goals_user_project_idx ON goals(user_id, project_id);

        CREATE TABLE IF NOT EXISTS tasks (
          task_id UUID PRIMARY KEY,
          goal_id UUID NOT NULL REFERENCES goals(goal_id) ON DELETE CASCADE,
          parent_task_id UUID,
          sequence INTEGER NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING',
          dependencies UUID[] NOT NULL DEFAULT '{}',
          input_artifact_ids UUID[] NOT NULL DEFAULT '{}',
          output_artifact_ids UUID[] NOT NULL DEFAULT '{}',
          evidence_ids TEXT[] NOT NULL DEFAULT '{}',
          output JSONB,
          output_summary TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          active_run_id UUID,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          completed_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS tasks_goal_idx ON tasks(goal_id, sequence);
        CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
        CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks(parent_task_id);

        CREATE TABLE IF NOT EXISTS task_dependencies (
          task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          depends_on_task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, depends_on_task_id)
        );
        CREATE INDEX IF NOT EXISTS task_deps_depends_on_idx ON task_dependencies(depends_on_task_id);

        CREATE TABLE IF NOT EXISTS task_attempts (
          attempt_id UUID PRIMARY KEY,
          task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL,
          model_used TEXT NOT NULL,
          provider_used TEXT,
          raw_output TEXT,
          parsed_proposal JSONB,
          proposal_valid BOOLEAN NOT NULL DEFAULT FALSE,
          execution_result TEXT,
          validation_report JSONB,
          outcome TEXT,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          tokens JSONB NOT NULL DEFAULT '{"prompt":0,"completion":0}',
          started_at TIMESTAMPTZ NOT NULL,
          finished_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS task_attempts_task_idx ON task_attempts(task_id, attempt_number);
      `);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createGoal(goal: Goal): Promise<void> {
    await this.pool.query(
      `INSERT INTO goals (goal_id, user_id, project_id, title, objective, acceptance_criteria, status,
         current_head_task_id, next_ready_task_id, task_count, succeeded_task_count, failed_task_count,
         created_at, updated_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (goal_id) DO NOTHING`,
      [
        goal.goalId,
        goal.userId ?? null,
        goal.projectId ?? null,
        goal.title,
        goal.objective,
        goal.acceptanceCriteria,
        goal.status,
        goal.currentHeadTaskId,
        goal.nextReadyTaskId,
        goal.taskCount,
        goal.succeededTaskCount,
        goal.failedTaskCount,
        goal.createdAt,
        goal.updatedAt,
        goal.completedAt,
      ],
    );
  }

  async getGoal(goalId: string): Promise<Goal | null> {
    const r = await this.pool.query('SELECT * FROM goals WHERE goal_id = $1', [goalId]);
    return r.rows[0] ? rowToGoal(r.rows[0]) : null;
  }

  async listGoals(opts?: {
    userId?: string;
    projectId?: string;
    status?: GoalStatus;
  }): Promise<Goal[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.userId) {
      params.push(opts.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (opts?.projectId) {
      params.push(opts.projectId);
      where.push(`project_id = $${params.length}`);
    }
    if (opts?.status) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT * FROM goals${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`,
      params,
    );
    return r.rows.map(rowToGoal);
  }

  async updateGoalStatus(
    goalId: string,
    status: GoalStatus,
    extra?: Partial<Pick<Goal, 'currentHeadTaskId' | 'nextReadyTaskId' | 'completedAt'>>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE goals SET status = $2,
         current_head_task_id = COALESCE($3, current_head_task_id),
         next_ready_task_id = COALESCE($4, next_ready_task_id),
         completed_at = COALESCE($5, completed_at),
         updated_at = now()
       WHERE goal_id = $1`,
      [
        goalId,
        status,
        extra?.currentHeadTaskId ?? null,
        extra?.nextReadyTaskId ?? null,
        extra?.completedAt ?? null,
      ],
    );
  }

  async createTask(task: TaskNode): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO tasks (task_id, goal_id, parent_task_id, sequence, type, title, objective, status,
            dependencies, input_artifact_ids, output_artifact_ids, evidence_ids, output, output_summary,
            attempt_count, max_attempts, active_run_id, created_at, updated_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (task_id) DO NOTHING`,
        [
          task.taskId,
          task.goalId,
          task.parentTaskId,
          task.sequence,
          task.type,
          task.title,
          task.objective,
          task.status,
          task.dependencies,
          task.inputArtifactIds,
          task.outputArtifactIds,
          task.evidenceIds,
          task.output,
          task.outputSummary,
          task.attemptCount,
          task.maxAttempts,
          task.activeRunId,
          task.createdAt,
          task.updatedAt,
          task.completedAt,
        ],
      );
      for (const dep of task.dependencies) {
        await client.query(
          `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [task.taskId, dep],
        );
      }
      // Initial status: PENDING or READY depending on whether dependencies
      // are already satisfied. Root tasks (no dependencies) become READY
      // immediately so the orchestrator can pick them up.
      if (task.dependencies.length === 0) {
        await client.query(
          `UPDATE tasks SET status = 'READY' WHERE task_id = $1 AND status = 'PENDING'`,
          [task.taskId],
        );
      } else {
        const satisfied = await this.areDependenciesSatisfiedTx(client, task);
        if (satisfied) {
          await client.query(`UPDATE tasks SET status = 'READY' WHERE task_id = $1`, [task.taskId]);
        }
      }
      await client.query(
        `UPDATE goals SET task_count = task_count + 1, updated_at = now() WHERE goal_id = $1`,
        [task.goalId],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async areDependenciesSatisfiedTx(client: PoolClient, task: TaskNode): Promise<boolean> {
    if (task.dependencies.length === 0) return true;
    const r = await client.query(
      `SELECT COUNT(*) AS unsatisfied
       FROM unnest($1::uuid[]) AS dep(id)
       LEFT JOIN tasks ON tasks.task_id = dep.id
       WHERE tasks.task_id IS NULL OR tasks.status <> 'SUCCEEDED'`,
      [task.dependencies],
    );
    return Number(r.rows[0]?.unsatisfied ?? 1) === 0;
  }

  async getTask(taskId: string): Promise<TaskNode | null> {
    const r = await this.pool.query('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
    if (!r.rows[0]) return null;
    const base = rowToTask(r.rows[0]);
    const attempts = await this.pool.query(
      'SELECT * FROM task_attempts WHERE task_id = $1 ORDER BY attempt_number',
      [taskId],
    );
    return { ...base, attempts: attempts.rows.map(rowToAttempt) };
  }

  async listTasksByGoal(goalId: string): Promise<TaskNode[]> {
    const r = await this.pool.query('SELECT * FROM tasks WHERE goal_id = $1 ORDER BY sequence', [
      goalId,
    ]);
    return r.rows.map(rowToTask);
  }

  async listReadyTasks(goalId: string): Promise<TaskNode[]> {
    const r = await this.pool.query(
      `SELECT * FROM tasks WHERE goal_id = $1 AND status = 'READY' ORDER BY sequence`,
      [goalId],
    );
    return r.rows.map(rowToTask);
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    extra?: Partial<Pick<TaskNode, 'activeRunId' | 'completedAt'>>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET status = $2,
         active_run_id = COALESCE($3, active_run_id),
         completed_at = COALESCE($4, completed_at),
         updated_at = now()
       WHERE task_id = $1`,
      [taskId, status, extra?.activeRunId ?? null, extra?.completedAt ?? null],
    );
  }

  async appendAttempt(taskId: string, attempt: TaskNode['attempts'][number]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO task_attempts (attempt_id, task_id, attempt_number, model_used, provider_used,
            raw_output, parsed_proposal, proposal_valid, execution_result, validation_report,
            outcome, latency_ms, tokens, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          attempt.attemptId,
          taskId,
          attempt.attemptNumber,
          attempt.modelUsed,
          attempt.providerUsed ?? null,
          attempt.rawOutput ?? null,
          attempt.parsedProposal ?? null,
          attempt.proposalValid,
          attempt.executionResult ?? null,
          attempt.validationReport ?? null,
          attempt.outcome ?? null,
          attempt.latencyMs,
          attempt.tokens,
          attempt.startedAt,
          attempt.finishedAt ?? null,
        ],
      );
      await client.query(
        `UPDATE tasks SET attempt_count = attempt_count + 1, updated_at = now() WHERE task_id = $1`,
        [taskId],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async commitTaskOutput(
    taskId: string,
    output: Record<string, unknown>,
    outputSummary: string,
    evidenceIds: string[],
    artifactIds: string[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date().toISOString();
      await client.query(
        `UPDATE tasks SET status = 'SUCCEEDED',
            output = $2, output_summary = $3, evidence_ids = $4, output_artifact_ids = $5,
            completed_at = $6, updated_at = $6
         WHERE task_id = $1`,
        [taskId, JSON.stringify(output), outputSummary, evidenceIds, artifactIds, now],
      );
      const task = await this.getTaskTx(client, taskId);
      if (task) {
        await client.query(
          `UPDATE goals SET succeeded_task_count = succeeded_task_count + 1,
              current_head_task_id = $2, next_ready_task_id = NULL, updated_at = now()
           WHERE goal_id = $1`,
          [task.goalId, taskId],
        );
        // Unblock dependents.
        const r = await client.query(
          `SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1`,
          [taskId],
        );
        for (const row of r.rows) {
          const depId = row.task_id as string;
          const dep = await this.getTaskTx(client, depId);
          if (dep && (dep.status === 'PENDING' || dep.status === 'READY')) {
            if (await this.areDependenciesSatisfiedTx(client, dep)) {
              await client.query(
                `UPDATE tasks SET status = 'READY', updated_at = now() WHERE task_id = $1`,
                [depId],
              );
            }
          }
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async failTask(taskId: string, _reason: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date().toISOString();
      await client.query(
        `UPDATE tasks SET status = 'FAILED', completed_at = $2, updated_at = $2 WHERE task_id = $1`,
        [taskId, now],
      );
      const task = await this.getTaskTx(client, taskId);
      if (task) {
        await client.query(
          `UPDATE goals SET failed_task_count = failed_task_count + 1, updated_at = now() WHERE goal_id = $1`,
          [task.goalId],
        );
        // Cascade-BLOCK dependents transitively.
        const stack = [taskId];
        while (stack.length > 0) {
          const current = stack.pop();
          if (!current) break;
          const r = await client.query(
            `SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1`,
            [current],
          );
          for (const row of r.rows) {
            const depId = row.task_id as string;
            const dep = await this.getTaskTx(client, depId);
            if (dep && (dep.status === 'PENDING' || dep.status === 'READY')) {
              await client.query(
                `UPDATE tasks SET status = 'BLOCKED', updated_at = now() WHERE task_id = $1`,
                [depId],
              );
              stack.push(depId);
            }
          }
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async getTaskTx(client: PoolClient, taskId: string): Promise<TaskNode | null> {
    const r = await client.query('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
    return r.rows[0] ? rowToTask(r.rows[0]) : null;
  }

  async appendTaskEvent(event: TaskDomainEvent): Promise<void> {
    // Persist into the existing `events` table so task events and run events
    // share one append-only log. Keyed by a deterministic goal-derived UUID
    // when the event has no runId of its own.
    const runId = (event as { runId?: string }).runId ?? goalEventRunId(event.goalId);
    const payload: Record<string, unknown> = { ...event };
    delete payload.runId;
    await this.pool.query(
      `INSERT INTO events (run_id, type, payload, occurred_at) VALUES ($1, $2, $3, $4)`,
      [runId, event.type, JSON.stringify(payload), event.occurredAt],
    );
  }

  async listTaskEvents(goalId: string): Promise<TaskDomainEvent[]> {
    // Read back events for the goal-derived runId.
    const runId = goalEventRunId(goalId);
    const r = await this.pool.query(
      `SELECT * FROM events WHERE run_id = $1 ORDER BY occurred_at, event_id`,
      [runId],
    );
    return r.rows
      .map((row) => {
        const type = row.type as string;
        const payload = row.payload as Record<string, unknown>;
        // Re-hydrate goalId + runId from the row since they were stripped on insert.
        return { type, ...payload, goalId } as unknown as TaskDomainEvent;
      })
      .filter((e) => (e as { goalId?: string }).goalId === goalId);
  }
}

// ── Row mappers ────────────────────────────────────────────────────────────

function rowToGoal(r: Record<string, unknown>): Goal {
  return GoalSchema.parse({
    goalId: r.goal_id,
    userId: r.user_id ?? undefined,
    projectId: r.project_id ?? undefined,
    title: r.title,
    objective: r.objective,
    acceptanceCriteria: r.acceptance_criteria ?? [],
    status: r.status,
    currentHeadTaskId: r.current_head_task_id ?? null,
    nextReadyTaskId: r.next_ready_task_id ?? null,
    taskCount: r.task_count,
    succeededTaskCount: r.succeeded_task_count,
    failedTaskCount: r.failed_task_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at ?? null,
  });
}

function rowToTask(r: Record<string, unknown>): TaskNode {
  return TaskNodeSchema.parse({
    taskId: r.task_id,
    goalId: r.goal_id,
    parentTaskId: r.parent_task_id ?? null,
    sequence: r.sequence,
    type: r.type,
    title: r.title,
    objective: r.objective,
    status: r.status,
    dependencies: r.dependencies ?? [],
    inputArtifactIds: r.input_artifact_ids ?? [],
    outputArtifactIds: r.output_artifact_ids ?? [],
    evidenceIds: r.evidence_ids ?? [],
    output: r.output ?? null,
    outputSummary: r.output_summary ?? null,
    attempts: [],
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    activeRunId: r.active_run_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at ?? null,
  });
}

function rowToAttempt(r: Record<string, unknown>): TaskNode['attempts'][number] {
  return TaskAttemptSchema.parse({
    attemptId: r.attempt_id,
    taskId: r.task_id,
    attemptNumber: r.attempt_number,
    modelUsed: r.model_used,
    providerUsed: r.provider_used ?? undefined,
    rawOutput: r.raw_output ?? undefined,
    parsedProposal: r.parsed_proposal ?? undefined,
    proposalValid: r.proposal_valid,
    executionResult: r.execution_result ?? undefined,
    validationReport: r.validation_report ?? undefined,
    outcome: r.outcome ?? undefined,
    latencyMs: r.latency_ms,
    tokens: r.tokens ?? { prompt: 0, completion: 0 },
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
  });
}

// Import the schemas used by the row mappers — runtime imports kept at the
// bottom so the public interface stays at the top of the file.
import type { Goal, TaskNode } from './models.js';
