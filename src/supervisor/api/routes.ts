/**
 * Fastify route handlers. Each handler is a thin wrapper over the
 * supervisor engine — all heavy lifting happens in `engine.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Supervisor } from '../engine.js';
import type { StateStore } from '../state/store.js';
import type { TaskLedger } from '../tasks/ledger.js';
import type { TaskOrchestrator } from '../tasks/orchestrator.js';
import type { TaskPlanner } from '../tasks/planner.js';
import { ApprovalRequest, type MetricsResponse, RunRequest, type RunResponse } from './schemas.js';

export interface RouteDeps {
  supervisor: Supervisor;
  store: StateStore;
  taskLedger?: TaskLedger;
  taskOrchestrator?: TaskOrchestrator;
  /**
   * Phase 3 — task planner. Optional: when omitted, the `autoPlan`
   * flag on POST /v1/goals is rejected with 501. Wired in `main.ts`
   * for production.
   */
  taskPlanner?: TaskPlanner;
}

// ── Task-ledger request schemas ────────────────────────────────────────────

const CreateGoalRequest = z.object({
  title: z.string().min(1).max(512),
  objective: z.string().min(1).max(16384),
  acceptanceCriteria: z.array(z.string()).default([]),
  userId: z.string().optional(),
  projectId: z.string().optional(),
  /**
   * Optional initial task graph. Each task becomes a node in the DAG.
   * Dependencies reference indices into this array (forward references
   * forbidden). When omitted AND `autoPlan` is true, the TaskPlanner
   * emits the initial graph via the router variant under tight schema
   * control.
   */
  tasks: z
    .array(
      z.object({
        type: z.enum([
          'PLAN',
          'RETRIEVE',
          'ANALYZE',
          'TOOL',
          'CODE_CHANGE',
          'TEST',
          'VERIFY',
          'SUMMARIZE',
        ]),
        title: z.string().min(1).max(512),
        objective: z.string().min(1).max(16384),
        dependencies: z.array(z.number().int().nonnegative()).default([]),
        maxAttempts: z.number().int().positive().default(3),
      }),
    )
    .default([]),
  /**
   * Phase 3 — when true and `tasks` is empty, invoke the TaskPlanner
   * to auto-decompose the objective into an initial task graph. The
   * planner's output is Zod-validated before any task is created; a
   * schema-invalid plan fails the request with a 422.
   */
  autoPlan: z.boolean().default(false),
});

const CreateTaskRequest = z.object({
  type: z.enum([
    'PLAN',
    'RETRIEVE',
    'ANALYZE',
    'TOOL',
    'CODE_CHANGE',
    'TEST',
    'VERIFY',
    'SUMMARIZE',
  ]),
  title: z.string().min(1).max(512),
  objective: z.string().min(1).max(16384),
  parentTaskId: z.string().uuid().optional(),
  dependencies: z.array(z.string().uuid()).default([]),
  maxAttempts: z.number().int().positive().default(3),
});

const AdvanceRequest = z.object({
  maxSteps: z.number().int().positive().max(20).default(1),
  allowedPaths: z.array(z.string()).default([]),
  context: z.string().optional(),
  /**
   * Phase 5 — absolute path to the repository root. Required when the
   * goal contains a CODE_CHANGE task (the CodeChangeExecutor needs a
   * real repo to apply patches against). When supplied, RETRIEVE /
   * CODE_CHANGE / ANALYZE / TEST tasks also get relevant file snippets
   * injected into their objective via the CodeIndexer.
   */
  repoPath: z.string().optional(),
});

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  // POST /v1/runs — kick off a new agent run synchronously
  app.post('/v1/runs', async (req, reply) => {
    const parsed = RunRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', issues: parsed.error.issues });
    }
    const state = await deps.supervisor.run({
      objective: parsed.data.objective,
      userId: parsed.data.userId,
      projectId: parsed.data.projectId,
      context: parsed.data.context,
      allowedPaths: parsed.data.allowedPaths,
    });
    const body: RunResponse = {
      runId: state.runId,
      status: state.status,
      intent: state.intent,
      finalResponse: state.finalResponse,
      // Spread to convert readonly string[] → string[] for the API response
      errorTrace: [...state.errorTrace],
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
    return reply.code(200).send(body);
  });

  // GET /v1/runs/:id — fetch a run by id
  app.get('/v1/runs/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const state = await deps.store.getRun(id);
    if (!state) return reply.code(404).send({ error: 'not found' });
    return reply.send({
      runId: state.runId,
      status: state.status,
      intent: state.intent,
      finalResponse: state.finalResponse,
      errorTrace: state.errorTrace,
      steps: state.steps.length,
      toolCalls: state.toolCalls.length,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  });

  // GET /v1/runs — list recent runs
  app.get('/v1/runs', async (req, reply) => {
    const q = req.query as { limit?: string; offset?: string; status?: string };
    const runs = await deps.store.listRuns({
      limit: q.limit ? Number(q.limit) : 50,
      offset: q.offset ? Number(q.offset) : 0,
      status: q.status as never,
    });
    return reply.send({
      runs: runs.map((s) => ({
        runId: s.runId,
        status: s.status,
        intent: s.intent,
        objective: s.objective.slice(0, 120),
        createdAt: s.createdAt,
      })),
    });
  });

  // GET /v1/runs/:id/events — replay the event stream (§9.2)
  app.get('/v1/runs/:id/events', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const events = await deps.store.listEvents(id);
    return reply.send({ events });
  });

  // GET /v1/runs/:id/states — list reachable next states (§9.4 approval UX)
  app.get('/v1/runs/:id/next', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const state = await deps.store.getRun(id);
    if (!state) return reply.code(404).send({ error: 'not found' });
    return reply.send({ reachable: deps.supervisor.machine.reachableFrom(state.status) });
  });

  // POST /v1/runs/:id/approve — human approval gate (§9.4)
  app.post('/v1/runs/:id/approve', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = ApprovalRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid approval', issues: parsed.error.issues });
    }
    const state = await deps.store.getRun(id);
    if (!state) return reply.code(404).send({ error: 'not found' });
    await deps.supervisor.bus.publish({
      type: 'human_approved',
      runId: id,
      payload: { approver: req.headers['x-user'] as string, reason: parsed.data.reason ?? '' },
      occurredAt: new Date().toISOString(),
    });
    deps.supervisor.metrics.recordApproval(true);
    return reply.code(200).send({ approvalId: crypto.randomUUID(), status: 'GRANTED' });
  });

  // GET /v1/metrics — snapshot of supervisor metrics (§15.2 + Part 1 §13)
  app.get('/v1/metrics', async (_req, reply) => {
    const m = deps.supervisor.metrics.snapshot();
    const body: MetricsResponse = {
      runsTotal: m.runsTotal,
      runsSucceeded: m.runsSucceeded,
      runsEscalated: m.runsEscalated,
      runsFailed: m.runsFailed,
      toolCallsTotal: m.toolCallsTotal,
      toolCallsValid: m.toolCallsValid,
      // Surface simulated tool calls so an operator can detect a non-zero
      // rate (which means the harness accepted a tool call but never
      // actually executed it).
      toolCallsSimulated: m.toolCallsSimulated,
      repairLoopInvocations: m.repairLoopInvocations,
      retrievalCallsTotal: m.retrievalCallsTotal,
      retrievalPrecisionAvg: m.retrievalPrecisionAvg,
      contextUtilizationAvg: m.contextUtilizationAvg,
      latencyAvgMs: m.latencyAvgMs,
      humanApprovalsRequested: m.humanApprovalsRequested,
      safetyViolations: m.safetyViolations,
      retrievalRecallAtK: m.retrievalRecallAtK,
      retrievalPrecisionAtK: m.retrievalPrecisionAtK,
      retrievalMrr: m.retrievalMrr,
      retrievalNdcg: m.retrievalNdcg,
      retrievalAclLeakageRate: m.retrievalAclLeakageRate,
      retrievalCacheHitRate: m.retrievalCacheHitRate,
      generationGroundedness: m.generationGroundedness,
      generationCitationAccuracy: m.generationCitationAccuracy,
      generationHallucinationRate: m.generationHallucinationRate,
      generationSchemaValidity: m.generationSchemaValidity,
    };
    return reply.send(body);
  });

  // GET /v1/tools — list registered tools (§10.1)
  app.get('/v1/tools', async (_req, reply) => {
    return reply.send({
      tools: deps.supervisor.registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        permissions: t.permissions,
        riskLevel: t.riskLevel,
        timeoutMs: t.timeoutMs,
      })),
    });
  });

  // GET /v1/runs/:id/checkpoints — list checkpoints for crash recovery (Part 2 §8)
  app.get('/v1/runs/:id/checkpoints', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    // The store interface doesn't expose checkpoints; the memory service
    // does. In production wire this through. For now return 501 if no
    // memory service is attached.
    return reply.code(501).send({
      error:
        'checkpoint listing not wired through store; query the memories.checkpoints table directly',
      runId: id,
    });
  });

  // GET /v1/runs/:id/snapshots — list context snapshots (Part 2 §4.5)
  app.get('/v1/runs/:id/snapshots', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    return reply.code(501).send({
      error:
        'snapshot listing not wired through store; query the memories.context_snapshots table directly',
      runId: id,
    });
  });

  // GET /v1/healthz — liveness probe
  app.get('/v1/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));

  // ── Task-ledger routes (Phase 1) ───────────────────────────────────────────
  //
  // POST   /v1/goals                       create a goal (optionally with initial task graph)
  // GET    /v1/goals                       list goals
  // GET    /v1/goals/:id                   fetch a goal with its task chain summary
  // POST   /v1/goals/:id/tasks             add a task to an existing goal
  // GET    /v1/goals/:id/tasks             list the goal's task chain
  // POST   /v1/goals/:id/advance          run the next READY task(s) via the Supervisor engine
  // GET    /v1/goals/:id/events            replay the task event stream
  // POST   /v1/goals/:id/recover           reconcile in-flight tasks after a restart
  //
  // When the taskLedger / taskOrchestrator are not wired (e.g. in the
  // mock backend dev path), every route below returns 501 so the API
  // surface is honest about what is reachable.
  app.post('/v1/goals', async (req, reply) => {
    if (!deps.taskLedger) {
      return reply.code(501).send({ error: 'task ledger not configured' });
    }
    const parsed = CreateGoalRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', issues: parsed.error.issues });
    }
    // Phase 3 — if the caller did not supply a task graph AND asked for
    // autoPlan, invoke the TaskPlanner to emit one under tight schema
    // control. The planner's output is Zod-validated before any task
    // is created; a schema-invalid plan fails the request with 422.
    let taskSpecs: Array<{
      type: z.infer<typeof CreateGoalRequest>['tasks'][number]['type'];
      title: string;
      objective: string;
      dependencies: number[];
      maxAttempts: number;
    }> = parsed.data.tasks;
    let plannedByModel = false;
    if (parsed.data.tasks.length === 0 && parsed.data.autoPlan) {
      if (!deps.taskPlanner) {
        return reply.code(501).send({ error: 'task planner not configured' });
      }
      try {
        const plan = await deps.taskPlanner.plan(parsed.data.objective, {
          userId: parsed.data.userId,
          projectId: parsed.data.projectId,
          acceptanceCriteria: parsed.data.acceptanceCriteria,
        });
        taskSpecs = plan.tasks.map((t) => ({
          type: t.type,
          title: t.title,
          objective: t.objective,
          dependencies: t.dependencies,
          maxAttempts: t.maxAttempts,
        }));
        plannedByModel = true;
      } catch (e) {
        const err = e as { errors?: string[]; rawOutputs?: string[]; message?: string };
        return reply.code(422).send({
          error: 'task planner failed',
          message: err.message,
          errors: err.errors ?? [],
          rawOutputCount: err.rawOutputs?.length ?? 0,
        });
      }
    }
    const goal = await deps.taskLedger.createGoal({
      title: parsed.data.title,
      objective: parsed.data.objective,
      acceptanceCriteria: parsed.data.acceptanceCriteria,
      userId: parsed.data.userId,
      projectId: parsed.data.projectId,
    });
    // Create the initial task graph (caller-supplied OR planner-emitted).
    // Dependencies are expressed as indices into the input array —
    // convert to taskIds now that the tasks are being created.
    const createdTasks: Array<{ taskId: string; sequence: number }> = [];
    for (let i = 0; i < taskSpecs.length; i++) {
      const spec = taskSpecs[i];
      if (!spec) continue;
      const depIds = spec.dependencies
        .map((idx) => createdTasks[idx]?.taskId)
        .filter((x): x is string => typeof x === 'string');
      const t = await deps.taskLedger.createTask({
        goalId: goal.goalId,
        sequence: i,
        type: spec.type,
        title: spec.title,
        objective: spec.objective,
        dependencies: depIds,
        maxAttempts: spec.maxAttempts,
      });
      createdTasks.push({ taskId: t.taskId, sequence: i });
    }
    return reply.code(201).send({
      goalId: goal.goalId,
      status: goal.status,
      taskCount: createdTasks.length,
      tasks: createdTasks,
      plannedByModel,
      createdAt: goal.createdAt,
    });
  });

  app.get('/v1/goals', async (req, reply) => {
    if (!deps.taskLedger) {
      return reply.code(501).send({ error: 'task ledger not configured' });
    }
    const q = req.query as {
      userId?: string;
      projectId?: string;
      status?: string;
      limit?: string;
    };
    const goals = await deps.taskLedger.listGoals({
      userId: q.userId,
      projectId: q.projectId,
      status: q.status as never,
    });
    const limit = q.limit ? Number(q.limit) : 50;
    return reply.send({
      goals: goals.slice(0, limit).map((g) => ({
        goalId: g.goalId,
        title: g.title,
        status: g.status,
        taskCount: g.taskCount,
        succeededTaskCount: g.succeededTaskCount,
        failedTaskCount: g.failedTaskCount,
        createdAt: g.createdAt,
      })),
    });
  });

  app.get('/v1/goals/:id', async (req, reply) => {
    if (!deps.taskLedger) {
      return reply.code(501).send({ error: 'task ledger not configured' });
    }
    const id = (req.params as { id: string }).id;
    const goal = await deps.taskLedger.getGoal(id);
    if (!goal) return reply.code(404).send({ error: 'not found' });
    const tasks = await deps.taskLedger.listTasksByGoal(id);
    return reply.send({
      goalId: goal.goalId,
      title: goal.title,
      objective: goal.objective,
      acceptanceCriteria: goal.acceptanceCriteria,
      status: goal.status,
      currentHeadTaskId: goal.currentHeadTaskId,
      nextReadyTaskId: goal.nextReadyTaskId,
      taskCount: goal.taskCount,
      succeededTaskCount: goal.succeededTaskCount,
      failedTaskCount: goal.failedTaskCount,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      completedAt: goal.completedAt,
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        sequence: t.sequence,
        type: t.type,
        title: t.title,
        status: t.status,
        attemptCount: t.attemptCount,
        maxAttempts: t.maxAttempts,
        dependencies: t.dependencies,
        outputSummary: t.outputSummary,
        completedAt: t.completedAt,
      })),
    });
  });

  app.post('/v1/goals/:id/tasks', async (req, reply) => {
    if (!deps.taskLedger) {
      return reply.code(501).send({ error: 'task ledger not configured' });
    }
    const id = (req.params as { id: string }).id;
    const goal = await deps.taskLedger.getGoal(id);
    if (!goal) return reply.code(404).send({ error: 'goal not found' });
    const parsed = CreateTaskRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', issues: parsed.error.issues });
    }
    const existing = await deps.taskLedger.listTasksByGoal(id);
    const sequence = existing.length;
    const task = await deps.taskLedger.createTask({
      goalId: id,
      sequence,
      type: parsed.data.type,
      title: parsed.data.title,
      objective: parsed.data.objective,
      parentTaskId: parsed.data.parentTaskId,
      dependencies: parsed.data.dependencies,
      maxAttempts: parsed.data.maxAttempts,
    });
    return reply.code(201).send({ taskId: task.taskId, status: task.status, sequence });
  });

  // POST /v1/goals/:id/plan — Phase 3: invoke the TaskPlanner against
  // an existing goal's objective. Useful when a strategy change means
  // the original task graph needs to be regenerated. The new tasks
  // are appended to the goal; existing tasks are NOT removed (the
  // caller can cancel them separately if desired).
  app.post('/v1/goals/:id/plan', async (req, reply) => {
    if (!deps.taskLedger || !deps.taskPlanner) {
      return reply.code(501).send({ error: 'task planner not configured' });
    }
    const id = (req.params as { id: string }).id;
    const goal = await deps.taskLedger.getGoal(id);
    if (!goal) return reply.code(404).send({ error: 'goal not found' });
    if (goal.status !== 'ACTIVE') {
      return reply.code(409).send({
        error: `goal is ${goal.status} — only ACTIVE goals can be re-planned`,
      });
    }
    try {
      const plan = await deps.taskPlanner.plan(goal.objective, {
        userId: goal.userId,
        projectId: goal.projectId,
        acceptanceCriteria: goal.acceptanceCriteria,
      });
      const existing = await deps.taskLedger.listTasksByGoal(id);
      const createdTasks: Array<{ taskId: string; sequence: number }> = [];
      for (let i = 0; i < plan.tasks.length; i++) {
        const spec = plan.tasks[i];
        if (!spec) continue;
        const depIds = spec.dependencies
          .map((idx) => createdTasks[idx]?.taskId)
          .filter((x): x is string => typeof x === 'string');
        const t = await deps.taskLedger.createTask({
          goalId: id,
          sequence: existing.length + i,
          type: spec.type,
          title: spec.title,
          objective: spec.objective,
          dependencies: depIds,
          maxAttempts: spec.maxAttempts,
        });
        createdTasks.push({ taskId: t.taskId, sequence: existing.length + i });
      }
      return reply.code(201).send({
        goalId: id,
        taskCount: createdTasks.length,
        tasks: createdTasks,
        plannedByModel: true,
      });
    } catch (e) {
      const err = e as { errors?: string[]; rawOutputs?: string[]; message?: string };
      return reply.code(422).send({
        error: 'task planner failed',
        message: err.message,
        errors: err.errors ?? [],
        rawOutputCount: err.rawOutputs?.length ?? 0,
      });
    }
  });

  app.get('/v1/goals/:id/tasks', async (req, reply) => {
    if (!deps.taskLedger) {
      return reply.code(501).send({ error: 'task ledger not configured' });
    }
    const id = (req.params as { id: string }).id;
    const tasks = await deps.taskLedger.listTasksByGoal(id);
    return reply.send({
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        sequence: t.sequence,
        type: t.type,
        title: t.title,
        status: t.status,
        attemptCount: t.attemptCount,
        maxAttempts: t.maxAttempts,
        dependencies: t.dependencies,
        outputSummary: t.outputSummary,
        completedAt: t.completedAt,
      })),
    });
  });

  app.post('/v1/goals/:id/advance', async (req, reply) => {
    if (!deps.taskLedger || !deps.taskOrchestrator) {
      return reply.code(501).send({ error: 'task ledger not configured' });
    }
    const id = (req.params as { id: string }).id;
    const goal = await deps.taskLedger.getGoal(id);
    if (!goal) return reply.code(404).send({ error: 'goal not found' });
    const parsed = AdvanceRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', issues: parsed.error.issues });
    }
    const result = await deps.taskOrchestrator.advance(id, {
      maxSteps: parsed.data.maxSteps,
      allowedPaths: parsed.data.allowedPaths,
      userId: goal.userId,
      projectId: goal.projectId,
      context: parsed.data.context,
      repoPath: parsed.data.repoPath,
    });
    return reply.send({
      steps: result.steps,
      stoppedReason: result.stoppedReason,
    });
  });

  app.get('/v1/goals/:id/events', async (req, reply) => {
    if (!deps.taskLedger) {
      return reply.code(501).send({ error: 'task ledger not configured' });
    }
    const id = (req.params as { id: string }).id;
    const events = await deps.taskLedger.listTaskEvents(id);
    return reply.send({ events });
  });

  app.post('/v1/goals/:id/recover', async (req, reply) => {
    if (!deps.taskLedger || !deps.taskOrchestrator) {
      return reply.code(501).send({ error: 'task ledger not configured' });
    }
    const id = (req.params as { id: string }).id;
    const result = await deps.taskOrchestrator.recover(id);
    return reply.send(result);
  });
}
