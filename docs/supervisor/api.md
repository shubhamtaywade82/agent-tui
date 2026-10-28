# Agentic Supervisor — API Reference

Base URL: `http://localhost:7480` (or `SUPERVISOR_HTTP_PORT`).
OpenAPI spec: <http://localhost:7480/docs>.

The supervisor serves **any of five inference providers** (Ollama, vLLM /
OpenAI-compatible, OpenAI, Anthropic, Gemini — ADR 0009). The API surface
below is identical across providers; the backend is a config choice
(`INFERENCE_BACKEND`), not an API concern.

## Authentication

All endpoints accept an optional `X-User` header carrying a user id.
Permissions (§16) are enforced based on this header. In production,
replace this with JWT auth via `SUPERVISOR_JWT_SECRET`.

---

## POST `/v1/runs`

Kick off a synchronous agent run. Returns the final state when the run
reaches `COMPLETED`, `FAILED`, or `ESCALATED`.

### Request body
```json
{
  "objective": "Summarize these logs:\nERROR db refused",
  "userId": "alice",
  "projectId": "checkout-service",
  "context": "optional pre-injected context",
  "allowedPaths": ["/workspace/checkout-service"]
}
```

### Response 200
```json
{
  "runId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "status": "COMPLETED",
  "intent": "LOG_SUMMARIZATION",
  "finalResponse": "## Summary\nDB connection refused with retries.",
  "errorTrace": [],
  "createdAt": "2026-10-08T05:00:00.000Z",
  "updatedAt": "2026-10-08T05:00:02.317Z"
}
```

---

## GET `/v1/runs/:id`

Fetch a run by id. Returns the full AgentState.

---

## GET `/v1/runs`

List recent runs. Query params: `limit` (default 50, max 200), `offset`,
`status` (filter by `RunStatus`).

---

## GET `/v1/runs/:id/events`

Replay the full event stream for a run (§9.2 event sourcing). Useful
for debugging, audit, and regression analysis.

```json
{
  "events": [
    { "type": "run_created", "occurredAt": "...", "payload": {...} },
    { "type": "state_transitioned", "payload": { "from": "CREATED", "to": "PLANNING" } },
    { "type": "intent_classified", "payload": { "intent": "TOOL_EXECUTION" } },
    ...
    { "type": "run_completed", "payload": { "finalResponsePreview": "..." } }
  ]
}
```

---

## GET `/v1/runs/:id/next`

Returns the set of states reachable from the run's current status
(§9.4). Drives the approval-gate UX in front-ends.

---

## GET `/v1/runs/:id/checkpoints`

List the crash-recovery checkpoints recorded for a run (§8), newest
first. Requires the memory service (backed by Postgres). When the
supervisor boots without a reachable database the route returns
`501` rather than an empty lie — same honest-unavailable contract as
the other optional-dependency surfaces.

```json
{
  "runId": "...",
  "checkpoints": [
    {
      "checkpointId": "...",
      "stepId": "...",
      "status": "SUCCEEDED",
      "currentPlan": "...",
      "completedSteps": ["tool", "validate"],
      "activeConstraints": [],
      "workingFiles": ["src/a.ts"],
      "lastToolResultSummary": "...",
      "nextActions": ["summarize"],
      "tokenBudget": 8192,
      "createdAt": "..."
    }
  ]
}
```

---

## GET `/v1/runs/:id/snapshots`

List the context-assembly snapshots for a run (§4.5), oldest first —
the audit trail for what went into each prompt (token budget vs.
used, prompt hash, included memory/chunk ids). Same `501` contract
as above when the memory service is not configured.

```json
{
  "runId": "...",
  "snapshots": [
    {
      "snapshotId": "...",
      "stepId": "...",
      "tokenBudget": 8192,
      "usedTokens": 4096,
      "promptHash": "sha256:...",
      "includedMemoryIds": ["..."],
      "includedChunkIds": ["..."],
      "excludedChunkIds": [],
      "createdAt": "..."
    }
  ]
}
```

---

## POST `/v1/runs/:id/approve`

Human approval gate (§9.4). Required for any action listed in
`SUPERVISOR_REQUIRE_APPROVAL_FOR`. Emits a `human_approved` event.

### Request body
```json
{ "action": "production_deploy", "reason": "Change request CR-1234 approved" }
```

---

## GET `/v1/metrics`

Snapshot of the supervisor's twelve §15.2 production metrics:
`runsTotal`, `runsSucceeded`, `runsEscalated`, `runsFailed`,
`toolCallsTotal`, `toolCallsValid`, `repairLoopInvocations`,
`retrievalCallsTotal`, `retrievalPrecisionAvg`,
`contextUtilizationAvg`, `latencyAvgMs`, `humanApprovalsRequested`,
`safetyViolations`.

---

## GET `/v1/tools`

List all tools registered in the `ToolRegistry` (§10.1) with their
schemas, permissions, risk level, and timeout.

---

## GET `/v1/healthz`

Liveness probe. Returns `{ "ok": true, "ts": "<iso>", "retrievalMode": "hybrid" | "keyword-only", "costBudget": { "maxCostPerRunUsd": <num>, "maxCostPerGoalUsd": <num> } }`.

- `retrievalMode` (ADR 0008) — `hybrid` when a healthy embedding provider
  is wired (OllamaEmbedder or OpenAIEmbedder); `keyword-only` when
  retrieval silently degraded.
- `costBudget` (ADR 0012) — the configured USD caps. `Infinity` means no
  cap; production cloud deployments should set
  `BUDGET_MAX_COST_USD_PER_RUN` / `BUDGET_MAX_COST_USD_PER_GOAL`.
