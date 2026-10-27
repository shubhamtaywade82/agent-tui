# ADR 0010: Per-task-type model selection

- **Status:** Proposed
- **Date:** 2026-10-27
- **Supersedes:** none
- **Superseded by:** —
- **Related:** ADR 0004 (Model Routing), ADR 0009 (Multi-provider inference)

## Context

ADR 0009 added five first-class inference providers (`ollama`, `vllm`, `openai`,
`anthropic`, `gemini`). With multiple providers available, the obvious question
becomes: how do I use a cheap model for routing, a strong model for code
changes, and a different model for analysis — in the same deployment?

Today the supervisor has four model-selection points, all keyed off global
config:

1. **Router classifier** — `inference.routerModel` (used by `RouterClassifier`
   in `engine.ts`).
2. **Tool agent** — `inference.toolModel` (used by `RepairLoop`).
3. **Analyst** — `inference.analystModel` (used by `stepExecuteAnalyst`).
4. **Summarizer** — `inference.summarizerModel` (used by `stepExecuteSummarizer`).

The orchestrator runs tasks of 8 different types (`PLAN`, `RETRIEVE`, `ANALYZE`,
`TOOL`, `CODE_CHANGE`, `TEST`, `VERIFY`, `SUMMARIZE`) but every task uses the
same analyst model. A CODE_CHANGE task doesn't get to use Claude; a RETRIEVE
task doesn't get to use a cheap gpt-4o-mini.

This means multi-provider setups (ADR 0009) could pick *which provider* serves
the whole pipeline, but couldn't specialise per task type. The cost-optimisation
pattern — cheap router + capable analyst + specialised coder — required
multiple deployments.

## Decision

Add a per-task-type model override map at the orchestrator level. When a task
type has a mapped model, that model is used for the analyst step (and for
CODE_CHANGE, for the patch-proposal step). Task types not in the map fall back
to the global `analystModel`.

### Config

New field `inference.taskModelMap: Partial<Record<TaskType, string>>`:

```ts
inference: z.object({
  // ... existing fields ...
  taskModelMap: z.object({
    PLAN: z.string().optional(),
    RETRIEVE: z.string().optional(),
    ANALYZE: z.string().optional(),
    TOOL: z.string().optional(),
    CODE_CHANGE: z.string().optional(),
    TEST: z.string().optional(),
    VERIFY: z.string().optional(),
    SUMMARIZE: z.string().optional(),
  }).default({}),
})
```

Loaded from env vars:

```bash
TASK_MODEL_PLAN=gpt-4o
TASK_MODEL_RETRIEVE=gpt-4o-mini
TASK_MODEL_ANALYZE=gpt-4o
TASK_MODEL_CODE_CHANGE=claude-3-5-sonnet-20241022
TASK_MODEL_TEST=gemini-2.0-flash
```

All keys are optional. The default is an empty map — existing deployments are
unaffected.

### Engine

`Supervisor.run()` gains an `analystModelOverride?: string` parameter. When
set, the analyst step uses that model in preference to
`supervisorConfig.inference.analystModel`. Escalation still wins — if the
router chose to escalate, the fallback model is used regardless.

The override is stored on a per-runId map on the `Supervisor` instance
(`runAnalystModelOverride`), mirroring the existing `runModelChoice` pattern.
This avoids a DB migration: the override is a transient dispatch hint, not
audit data. The map entry is deleted in the `finally` block of `run()` to
avoid memory growth.

### Orchestrator

`TaskOrchestrator` gains a `resolveAnalystModel(taskType)` helper that consults
`supervisorConfig.inference.taskModelMap[taskType]` (returning the configured
default `analystModel` when the task type is unmapped).

Both `runCodeChangeTask` and `runGenericTask` call `resolveAnalystModel` and
pass the result to the executor / Supervisor:

- `runCodeChangeTask` passes it as `analystModelOverride` to
  `CodeChangeExecutor.execute()` (new optional field on `CodeChangeRequest`).
- `runGenericTask` passes it as `analystModelOverride` to `Supervisor.run()`.

### Planner

`TaskPlanner.plan()` consults `inference.taskModelMap.PLAN` (falling back to
the planner's configured `routerModel`). The planner is structurally a PLAN
task, so it honours the same map.

### CodeChangeExecutor

`CodeChangeExecutor.execute()` accepts an optional `analystModelOverride` on
its `CodeChangeRequest`. When set, it's used in preference to the executor's
constructor-configured `analystModel`. Backwards-compatible: existing callers
that don't set the override see no behaviour change.

## Consequences

### Positive

- **Cost optimisation**: pair a cheap router (`gpt-4o-mini`) with a capable
  coder (`claude-3-5-sonnet`) and a strong analyst (`gpt-4o`) in a single
  deployment. Each task type routes to the model that best fits its
  cost/quality tradeoff.
- **Specialisation**: CODE_CHANGE tasks can use a code-specialist model
  (Claude, DeepSeek-Coder) while ANALYZE tasks use a general-purpose
  reasoning model. The orchestrator's `task.type` field becomes the dispatch
  key.
- **Backwards-compatible**: empty map (default) preserves existing behaviour.
  No DB migration, no breaking API change.
- **Per-run isolation**: the override is stored per-runId (not on AgentState),
  so concurrent runs targeting different task types don't collide.
- **Escalation still wins**: if the router escalates a run, the fallback model
  is used regardless of the per-task override. The override doesn't bypass
  escalation policy.

### Negative

- **One more dispatch knob**: operators now have `routerModel` (router step),
  `toolModel` (tool step), `analystModel` (default analyst step),
  `summarizerModel` (summarizer step), AND `taskModelMap[taskType]` (per-task
  analyst override). The map is optional, but the surface area is wider.
- **Telemetry interpretation**: a `model_invoked` event for an analyst step
  can show different model names depending on which task type triggered the
  run. Operators reading logs need to know about `taskModelMap` to interpret
  the model name correctly. Mitigation: the event payload already carries
  `model`, and the orchestrator records `task.type` on `task_attempted`, so
  the linkage is recoverable.
- **Per-provider API key requirement**: if `taskModelMap.CODE_CHANGE=claude-3-5-sonnet`,
  the deployment needs an Anthropic API key (`ANTHROPIC_API_KEY` or set
  `INFERENCE_BACKEND=anthropic`). Mixing models from different providers in
  the same deployment requires either (a) one backend that supports all the
  mapped models (e.g. an OpenAI-compatible proxy), or (b) the escalation
  fallback backend to serve the per-task models. The simpler pattern is to
  use one provider per deployment and pick models within that provider's
  catalogue.

### Neutral

- The router step (`RouterClassifier`) and the tool step (`RepairLoop`) are
  NOT per-task-overridable. They run before/around the analyst step and
  their model is determined by the run's intent, not the task type. Adding
  per-task overrides for them would be possible but adds combinatorial
  complexity without clear value.

## Alternatives considered

### Add a separate model config per task type as top-level fields

```ts
inference: z.object({
  routerModel: ...,
  analystModel: ...,
  taskModelMap: { ... }, // rejected
  codeChangeModel: ...,
  analyzeModel: ...,
  retrieveModel: ...,
  ...
})
```

Rejected — adds 8 new top-level fields and doesn't scale when new task types
are added. The map is forward-compatible: a new TaskType automatically gets a
slot in the map without schema changes.

### Put the override on AgentState (persisted)

Rejected — would require a DB migration for a transient dispatch hint.
Stored per-runId on the Supervisor instance instead (mirrors `runModelChoice`).
The override is observable via the `model_invoked` event payload (which
carries the actual model used); there's no need to persist it on the run
record.

### Make the override a runtime parameter only (no config)

Rejected — operators want to set it via env vars in production, not by
modifying orchestrator call sites. The config + env var pattern matches the
rest of the supervisor's config story.

## Migration guide

Existing deployments are unaffected — `taskModelMap` defaults to empty.

To enable per-task-type model selection, set any combination of these env
vars:

```bash
# Use GPT-4o-mini for cheap routing tasks
TASK_MODEL_RETRIEVE=gpt-4o-mini
TASK_MODEL_PLAN=gpt-4o-mini

# Use GPT-4o for analysis (strong reasoning)
TASK_MODEL_ANALYZE=gpt-4o

# Use Claude for code changes (strong code generation)
TASK_MODEL_CODE_CHANGE=claude-3-5-sonnet-20241022

# Use Gemini Flash for tests (fast verification)
TASK_MODEL_TEST=gemini-2.0-flash
```

When using models from multiple providers (e.g. Claude + GPT-4o), you need
either:

- A single OpenAI-compatible proxy that fronts all providers (e.g. LiteLLM,
  OpenRouter), set as `INFERENCE_BACKEND=vllm` + `VLLM_BASE_URL=...`, OR
- The primary backend for one provider + the escalation fallback for the
  other (`ESCALATION_FALLBACK_BASE_URL=...`). The fallback is only invoked
  when the router escalates, so this works for occasional cross-provider
  calls but not for the per-task pattern.

For full per-task multi-provider routing, deploy an OpenAI-compatible proxy
(LiteLLM, OpenRouter) and set `INFERENCE_BACKEND=vllm` + the proxy URL. All
`TASK_MODEL_*` env vars then route through the proxy, which dispatches to
the underlying provider.
