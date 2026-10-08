/**
 * Fastify route handlers. Each handler is a thin wrapper over the
 * supervisor engine — all heavy lifting happens in `engine.ts`.
 */
import type { FastifyInstance } from 'fastify';
import type { Supervisor } from '../engine.js';
import type { StateStore } from '../state/store.js';
import { ApprovalRequest, type MetricsResponse, RunRequest, type RunResponse } from './schemas.js';

export interface RouteDeps {
  supervisor: Supervisor;
  store: StateStore;
}

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
      errorTrace: state.errorTrace,
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

  // GET /v1/metrics — snapshot of supervisor metrics (§15.2)
  app.get('/v1/metrics', async (_req, reply) => {
    const m = deps.supervisor.metrics.snapshot();
    const body: MetricsResponse = {
      runsTotal: m.runsTotal,
      runsSucceeded: m.runsSucceeded,
      runsEscalated: m.runsEscalated,
      runsFailed: m.runsFailed,
      toolCallsTotal: m.toolCallsTotal,
      toolCallsValid: m.toolCallsValid,
      repairLoopInvocations: m.repairLoopInvocations,
      retrievalCallsTotal: m.retrievalCallsTotal,
      retrievalPrecisionAvg: m.retrievalPrecisionAvg,
      contextUtilizationAvg: m.contextUtilizationAvg,
      latencyAvgMs: m.latencyAvgMs,
      humanApprovalsRequested: m.humanApprovalsRequested,
      safetyViolations: m.safetyViolations,
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

  // GET /v1/healthz — liveness probe
  app.get('/v1/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));
}
