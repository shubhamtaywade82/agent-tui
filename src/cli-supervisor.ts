/**
 * Supervisor CLI client — talks to a running Agentic Supervisor over HTTP
 * from the main `agent-tui` CLI (`agent-tui supervisor <sub>`).
 *
 * This is a thin read-mostly client: it surfaces the supervisor's runs,
 * goals, events, and health so operators don't need to remember the
 * supervisor's port / auth headers. Writing (creating goals, advancing
 * chains) stays on the supervisor's own API surface — this client exposes
 * the safe read paths plus `serve` (which just spawns `supervisor/main.ts`).
 *
 * Configuration comes from the same env vars the supervisor reads:
 *   SUPERVISOR_HTTP_HOST   default 127.0.0.1
 *   SUPERVISOR_HTTP_PORT   default 7480
 *   SUPERVISOR_API_KEY     optional bearer token (required when the
 *                          supervisor binds non-loopback)
 */

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7480;

/**
 * Base URL of the running supervisor. Reads the env at call time (not
 * module-load time) so tests and live config changes are honoured.
 */
export function supervisorBaseUrl(): string {
  const host = process.env.SUPERVISOR_HTTP_HOST || DEFAULT_HOST;
  const port = process.env.SUPERVISOR_HTTP_PORT || String(DEFAULT_PORT);
  return `http://${host}:${port}`;
}

function authHeaders(): Record<string, string> {
  const key = process.env.SUPERVISOR_API_KEY;
  return key ? { authorization: `Bearer ${key}` } : {};
}

export interface SupervisorFetchOptions {
  /** Timeout in ms. Default 5_000. */
  timeoutMs?: number;
}

/**
 * GET a JSON path from the supervisor. Throws a clear, operator-facing
 * error when the supervisor is down (connection refused) instead of a raw
 * fetch TypeError.
 */
export async function supervisorGet<T>(
  path: string,
  opts: SupervisorFetchOptions = {},
): Promise<T> {
  const url = `${supervisorBaseUrl()}${path}`;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { ...authHeaders(), accept: 'application/json' },
      signal: controller.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(
        `supervisor ${path} → HTTP ${r.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      );
    }
    return (await r.json()) as T;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`supervisor ${path} timed out after ${timeoutMs}ms`);
    }
    if (e instanceof TypeError) {
      throw new Error(
        `cannot reach supervisor at ${supervisorBaseUrl()} — is it running? ` +
          `Start it with: npm run supervisor:serve   (or: agent-tui supervisor serve)`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── Response shapes (subset of the supervisor's API — see docs/supervisor/api.md) ──

export interface HealthzResponse {
  ok: boolean;
  ts: string;
  retrievalMode?: 'hybrid' | 'keyword-only';
  costBudget?: { maxCostPerRunUsd: number; maxCostPerGoalUsd: number };
}

export interface RunSummary {
  runId: string;
  status: string;
  intent?: string;
  finalResponse?: string;
  errorTrace?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RunListResponse {
  runs: RunSummary[];
}

export interface RunEventsResponse {
  events: Array<{
    type: string;
    runId: string;
    payload: Record<string, unknown>;
    occurredAt: string;
  }>;
}

export interface GoalSummary {
  goalId: string;
  title: string;
  status: string;
  taskCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface GoalListResponse {
  goals: GoalSummary[];
}

export interface GoalDetailResponse {
  goal: GoalSummary & {
    objective?: string;
    acceptanceCriteria?: string[];
  };
  tasks: Array<{
    taskId: string;
    sequence: number;
    type: string;
    title: string;
    status: string;
    attemptCount?: number;
  }>;
}

// ── Convenience wrappers ────────────────────────────────────────────────────

export function getHealth(): Promise<HealthzResponse> {
  return supervisorGet<HealthzResponse>('/v1/healthz');
}

export function listRuns(limit = 20): Promise<RunListResponse> {
  // The supervisor's GET /v1/runs ignores unknown query params today; the
  // client truncates locally to keep the display bounded.
  return supervisorGet<RunListResponse>('/v1/runs').then((r) => ({
    ...r,
    runs: (r.runs ?? []).slice(0, limit),
  }));
}

export function getRun(runId: string): Promise<RunSummary> {
  return supervisorGet<RunSummary>(`/v1/runs/${runId}`);
}

export function getRunEvents(runId: string): Promise<RunEventsResponse> {
  return supervisorGet<RunEventsResponse>(`/v1/runs/${runId}/events`);
}

export function listGoals(limit = 20): Promise<GoalListResponse> {
  return supervisorGet<GoalListResponse>('/v1/goals').then((r) => ({
    ...r,
    goals: (r.goals ?? []).slice(0, limit),
  }));
}

export function getGoal(goalId: string): Promise<GoalDetailResponse> {
  return supervisorGet<GoalDetailResponse>(`/v1/goals/${goalId}`);
}
