/**
 * Postgres state store — §4.1 (Operational Database) and §9.2 (Event
 * Sourcing). Provides durable persistence for runs, steps, tool calls,
 * artifacts, and the append-only event log.
 *
 * The store is the system of record. If the supervisor crashes mid-run,
 * the next process can rehydrate the AgentState and resume from the last
 * persisted step. The LLM is never trusted to remember anything (§19.1).
 */
import { Pool, type PoolClient } from 'pg';
import type { DomainEvent } from './events.js';
import {
  AgentState,
  type Intent,
  type RunStatus,
  type StepRecord,
  type ToolCallRecord,
} from './models.js';

export interface StateStore {
  init(): Promise<void>;
  saveRun(state: AgentState): Promise<void>;
  getRun(runId: string): Promise<AgentState | null>;
  listRuns(opts?: { limit?: number; offset?: number; status?: RunStatus }): Promise<AgentState[]>;
  appendEvent(event: DomainEvent): Promise<void>;
  listEvents(runId: string): Promise<DomainEvent[]>;
  close(): Promise<void>;
}

export class PgStateStore implements StateStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS runs (
          run_id UUID PRIMARY KEY,
          user_id TEXT,
          project_id TEXT,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          intent TEXT,
          think_mode TEXT NOT NULL DEFAULT 'no-think',
          query TEXT NOT NULL,
          context TEXT,
          retrieved_evidence TEXT[] NOT NULL DEFAULT '{}',
          tool_payload JSONB,
          execution_result TEXT,
          final_response TEXT,
          error_trace TEXT[] NOT NULL DEFAULT '{}',
          artifacts TEXT[] NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
        CREATE INDEX IF NOT EXISTS runs_user_project_idx ON runs(user_id, project_id);

        CREATE TABLE IF NOT EXISTS steps (
          step_id UUID PRIMARY KEY,
          run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          step_type TEXT NOT NULL,
          status TEXT NOT NULL,
          input_payload JSONB NOT NULL DEFAULT '{}',
          output_payload JSONB NOT NULL DEFAULT '{}',
          model_name TEXT,
          prompt_template_version TEXT,
          retrieval_query TEXT,
          retrieved_chunks TEXT[] NOT NULL DEFAULT '{}',
          tool_name TEXT,
          tool_arguments JSONB NOT NULL DEFAULT '{}',
          validation_result TEXT,
          execution_result TEXT,
          error TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          token_usage JSONB NOT NULL DEFAULT '{"prompt":0,"completion":0}',
          started_at TIMESTAMPTZ NOT NULL,
          finished_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS steps_run_idx ON steps(run_id, started_at);

        CREATE TABLE IF NOT EXISTS tool_calls (
          tool_call_id UUID PRIMARY KEY,
          step_id UUID NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
          run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          tool_name TEXT NOT NULL,
          arguments JSONB NOT NULL DEFAULT '{}',
          validation_status TEXT NOT NULL DEFAULT 'VALID',
          execution_status TEXT NOT NULL DEFAULT 'PENDING',
          result_summary TEXT,
          error TEXT,
          idempotency_key TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL,
          finished_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS tool_calls_run_idx ON tool_calls(run_id, created_at);

        CREATE TABLE IF NOT EXISTS artifacts (
          artifact_id UUID PRIMARY KEY,
          run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          artifact_type TEXT NOT NULL,
          storage_uri TEXT NOT NULL,
          checksum TEXT NOT NULL,
          size_bytes BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS events (
          event_id BIGSERIAL PRIMARY KEY,
          run_id UUID NOT NULL,
          type TEXT NOT NULL,
          payload JSONB NOT NULL,
          occurred_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, occurred_at);
        CREATE INDEX IF NOT EXISTS events_type_idx ON events(type);

        CREATE TABLE IF NOT EXISTS approvals (
          approval_id UUID PRIMARY KEY,
          run_id UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          step_id UUID REFERENCES steps(step_id),
          action TEXT NOT NULL,
          approver TEXT,
          status TEXT NOT NULL DEFAULT 'PENDING',
          reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          decided_at TIMESTAMPTZ
        );
      `);
    } finally {
      client.release();
    }
  }

  async saveRun(state: AgentState): Promise<void> {
    const r = state;
    await this.pool.query(
      `INSERT INTO runs (run_id, user_id, project_id, objective, status, intent, think_mode, query, context,
         retrieved_evidence, tool_payload, execution_result, final_response, error_trace, artifacts, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (run_id) DO UPDATE SET
         status=EXCLUDED.status, intent=EXCLUDED.intent, think_mode=EXCLUDED.think_mode,
         context=EXCLUDED.context, retrieved_evidence=EXCLUDED.retrieved_evidence,
         tool_payload=EXCLUDED.tool_payload, execution_result=EXCLUDED.execution_result,
         final_response=EXCLUDED.final_response, error_trace=EXCLUDED.error_trace,
         artifacts=EXCLUDED.artifacts, updated_at=EXCLUDED.updated_at`,
      [
        r.runId,
        r.userId ?? null,
        r.projectId ?? null,
        r.objective,
        r.status,
        r.intent ?? null,
        r.thinkMode,
        r.query,
        r.context ?? null,
        r.retrievedEvidence,
        r.toolPayload ?? null,
        r.executionResult ?? null,
        r.finalResponse ?? null,
        r.errorTrace,
        r.artifacts,
        r.createdAt,
        r.updatedAt,
      ],
    );

    // Persist steps and tool calls in a single transaction for atomicity
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.upsertSteps(client, r.runId, r.steps);
      await this.upsertToolCalls(client, r.runId, r.toolCalls);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async upsertSteps(client: PoolClient, runId: string, steps: StepRecord[]): Promise<void> {
    for (const s of steps) {
      await client.query(
        `INSERT INTO steps (step_id, run_id, step_type, status, input_payload, output_payload, model_name,
            prompt_template_version, retrieval_query, retrieved_chunks, tool_name, tool_arguments,
            validation_result, execution_result, error, retry_count, latency_ms, token_usage,
            started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (step_id) DO UPDATE SET
           status=EXCLUDED.status, output_payload=EXCLUDED.output_payload,
           validation_result=EXCLUDED.validation_result, execution_result=EXCLUDED.execution_result,
           error=EXCLUDED.error, retry_count=EXCLUDED.retry_count, latency_ms=EXCLUDED.latency_ms,
           token_usage=EXCLUDED.token_usage, finished_at=EXCLUDED.finished_at`,
        [
          s.stepId,
          runId,
          s.stepType,
          s.status,
          s.inputPayload,
          s.outputPayload,
          s.modelName ?? null,
          s.promptTemplateVersion ?? null,
          s.retrievalQuery ?? null,
          s.retrievedChunks,
          s.toolName ?? null,
          s.toolArguments,
          s.validationResult ?? null,
          s.executionResult ?? null,
          s.error ?? null,
          s.retryCount,
          s.latencyMs,
          s.tokenUsage,
          s.startedAt,
          s.finishedAt ?? null,
        ],
      );
    }
  }

  private async upsertToolCalls(
    client: PoolClient,
    _runId: string,
    calls: ToolCallRecord[],
  ): Promise<void> {
    for (const c of calls) {
      await client.query(
        `INSERT INTO tool_calls (tool_call_id, step_id, run_id, tool_name, arguments, validation_status,
            execution_status, result_summary, error, idempotency_key, retry_count, created_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (tool_call_id) DO UPDATE SET
           validation_status=EXCLUDED.validation_status, execution_status=EXCLUDED.execution_status,
           result_summary=EXCLUDED.result_summary, error=EXCLUDED.error,
           retry_count=EXCLUDED.retry_count, finished_at=EXCLUDED.finished_at`,
        [
          c.toolCallId,
          c.stepId,
          c.runId,
          c.toolName,
          c.arguments,
          c.validationStatus,
          c.executionStatus,
          c.resultSummary ?? null,
          c.error ?? null,
          c.idempotencyKey ?? null,
          c.retryCount,
          c.createdAt,
          c.finishedAt ?? null,
        ],
      );
    }
  }

  async getRun(runId: string): Promise<AgentState | null> {
    const client = await this.pool.connect();
    try {
      const r = await client.query('SELECT * FROM runs WHERE run_id = $1', [runId]);
      if (r.rowCount === 0) return null;
      const row = r.rows[0];
      const steps = (
        await client.query('SELECT * FROM steps WHERE run_id = $1 ORDER BY started_at', [runId])
      ).rows.map((s) => ({
        stepId: s.step_id,
        runId: s.run_id,
        stepType: s.step_type,
        status: s.status,
        inputPayload: s.input_payload,
        outputPayload: s.output_payload,
        modelName: s.model_name ?? undefined,
        promptTemplateVersion: s.prompt_template_version ?? undefined,
        retrievalQuery: s.retrieval_query ?? undefined,
        retrievedChunks: s.retrieved_chunks ?? [],
        toolName: s.tool_name ?? undefined,
        toolArguments: s.tool_arguments,
        validationResult: s.validation_result ?? undefined,
        executionResult: s.execution_result ?? undefined,
        error: s.error ?? undefined,
        retryCount: s.retry_count,
        latencyMs: s.latency_ms,
        tokenUsage: s.token_usage,
        startedAt: s.started_at.toISOString(),
        finishedAt: s.finished_at ? s.finished_at.toISOString() : undefined,
      }));
      const toolCalls = (
        await client.query('SELECT * FROM tool_calls WHERE run_id = $1 ORDER BY created_at', [
          runId,
        ])
      ).rows.map((c) => ({
        toolCallId: c.tool_call_id,
        stepId: c.step_id,
        runId: c.run_id,
        toolName: c.tool_name,
        arguments: c.arguments,
        validationStatus: c.validation_status,
        executionStatus: c.execution_status,
        resultSummary: c.result_summary ?? undefined,
        error: c.error ?? undefined,
        idempotencyKey: c.idempotency_key ?? undefined,
        retryCount: c.retry_count,
        createdAt: c.created_at.toISOString(),
        finishedAt: c.finished_at ? c.finished_at.toISOString() : undefined,
      }));
      return AgentState.parse({
        runId: row.run_id,
        userId: row.user_id ?? undefined,
        projectId: row.project_id ?? undefined,
        objective: row.objective,
        status: row.status,
        intent: (row.intent ?? undefined) as Intent | undefined,
        thinkMode: row.think_mode,
        query: row.query,
        context: row.context ?? undefined,
        retrievedEvidence: row.retrieved_evidence ?? [],
        toolPayload: row.tool_payload ?? undefined,
        executionResult: row.execution_result ?? undefined,
        finalResponse: row.final_response ?? undefined,
        errorTrace: row.error_trace ?? [],
        steps,
        toolCalls,
        artifacts: row.artifacts ?? [],
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      });
    } finally {
      client.release();
    }
  }

  async listRuns(
    opts: { limit?: number; offset?: number; status?: RunStatus } = {},
  ): Promise<AgentState[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;
    const params: unknown[] = [limit, offset];
    let where = '';
    if (opts.status) {
      params.push(opts.status);
      where = `WHERE status = $3`;
    }
    const r = await this.pool.query(
      `SELECT run_id FROM runs ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      params,
    );
    const out: AgentState[] = [];
    for (const row of r.rows) {
      const s = await this.getRun(row.run_id);
      if (s) out.push(s);
    }
    return out;
  }

  async appendEvent(event: DomainEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO events (run_id, type, payload, occurred_at) VALUES ($1,$2,$3,$4)`,
      [event.runId, event.type, JSON.stringify(event.payload), event.occurredAt],
    );
  }

  async listEvents(runId: string): Promise<DomainEvent[]> {
    const r = await this.pool.query(
      'SELECT type, payload, occurred_at FROM events WHERE run_id = $1 ORDER BY occurred_at, event_id',
      [runId],
    );
    return r.rows.map((row) => ({
      type: row.type,
      runId,
      payload: row.payload,
      occurredAt: row.occurred_at.toISOString(),
    })) as DomainEvent[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
