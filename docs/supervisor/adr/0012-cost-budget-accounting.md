# ADR 0012: Cost-budget accounting per cloud backend

- **Status:** Proposed
- **Date:** 2026-10-27
- **Supersedes:** none
- **Superseded by:** —
- **Related:** ADR 0009 (Multi-provider inference), ADR 0010 (Per-task model selection), ADR 0011 (Streaming backends)

## Context

ADR 0009 added five first-class cloud providers. With metered APIs (OpenAI,
Anthropic, Gemini), a single runaway goal — say a planner that auto-decomposes
into 50 CODE_CHANGE tasks, each invoking Claude — can cost tens of dollars
before anyone notices. The pre-ADR-0012 supervisor had no cost guardrails:

- Token counts were recorded per-invocation but never aggregated.
- No notion of per-run or per-goal caps.
- Local models (MiniCPM5, Ollama) reported $0 implicitly (no pricing table
  existed), but cloud models didn't have a pricing lookup at all.
- Operators couldn't see cumulative spend without scraping logs.

This ADR adds a `CostTracker` that accumulates spend per run + per goal,
computes USD cost from a built-in pricing table, and aborts the run when
the cap is exceeded.

## Decision

### Built-in pricing table

`src/supervisor/observability/cost-tracker.ts` exports `PRICING_TABLE` —
USD-per-1M-token rates for common production models across the five
first-class providers:

- **OpenAI**: gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-4, gpt-3.5-turbo,
  o1, o1-mini, o1-pro, o3, o3-mini, o4-mini, text-embedding-3-{small,large},
  text-embedding-ada-002.
- **Anthropic**: claude-3.5-sonnet/haiku, claude-3-opus/sonnet/haiku,
  claude-opus-4, claude-sonnet-4.
- **Google Gemini**: gemini-2.0-flash, gemini-2.0-flash-thinking,
  gemini-1.5-pro, gemini-1.5-flash, gemini-1.5-flash-8b.
- **DeepSeek** (via OpenAI-compat): deepseek-chat, deepseek-coder,
  deepseek-reasoner.
- **Local / self-hosted (0-cost)**: minicpm5-router/analyst/toolagent/
  summarizer, nomic-embed-text, bge-m3, mxbai-embed-large.

Each entry carries `inputPer1M`, `outputPer1M`, and optional
`cachedInputPer1M` (for providers that support prompt caching — OpenAI
prompt cache, Anthropic prompt cache, Gemini context cache).

Unknown models default to a conservative estimate ($1.00 per 1M input,
$3.00 per 1M output) — prevents runaway costs from a misconfigured model
name from going unnoticed. Override via `BUDGET_FALLBACK_INPUT_PER_1M` /
`BUDGET_FALLBACK_OUTPUT_PER_1M`.

### CostTracker class

```ts
class CostTracker {
  constructor(
    maxCostPerRunUsd: number = Infinity,
    maxCostPerGoalUsd: number = Infinity,
    fallbackPricing: ModelPricing = { inputPer1M: 1.0, outputPer1M: 3.0 },
    overrides: Record<string, ModelPricing> = {},
  ) {}

  lookupPricing(model: string): ModelPricing;
  computeCost(model, promptTokens, completionTokens, cachedPromptTokens?): number;
  recordUsage({ runId, goalId?, model, promptTokens, completionTokens, cachedPromptTokens? }): CostEntry;
  wouldExceedGoalBudget(goalId, additionalCostUsd): boolean;
  getRunCost(runId): CostLedgerSnapshot;
  getGoalCost(goalId): CostLedgerSnapshot;
  clearRun(runId): void;
  clearGoal(goalId): void;
}
```

- `recordUsage()` throws `BudgetExceededError` when the cumulative spend
  exceeds the per-run or per-goal cap.
- `wouldExceedGoalBudget()` is a non-throwing check used by the orchestrator
  before starting a new task to short-circuit before any tokens are spent.
- Per-run + per-goal ledgers are independent (one run can be in many
  goal-less; one goal can span many runs).

### BudgetExceededError

```ts
class BudgetExceededError extends Error {
  scope: 'run' | 'goal';
  goalId?: string;
  runId?: string;
  spentUsd: number;
  capUsd: number;
  model: string;
}
```

When thrown from `stepExecuteAnalyst`, the engine catches it, records the
message in `state.errorTrace`, transitions the run to FAILED, and
publishes `run_completed` with `outcome: 'FAILED'`. The orchestrator
then marks the task as FAILED_EXECUTION and cascades BLOCKED to dependents.

### Engine integration

`SupervisorDeps` gains an optional `costTracker?: CostTracker` field. When
omitted, the engine constructs one from env vars
(`createCostTrackerFromEnv()`).

`Supervisor.run()` gains an optional `goalId?: string` parameter. When
supplied, every model invocation in that run is recorded against both the
per-run ledger and the per-goal ledger.

After each `Backend.invoke()` / `Backend.stream()` call in
`stepExecuteAnalyst`, the engine calls `costTracker.recordUsage()`. The
`model_invoked` event payload now includes `costUsd: number` — the
cumulative spend for the run, post-invocation. This lets log scrapers
and TUI displays show the running spend alongside the model output.

### Config

New `budget` config block:

```ts
budget: z.object({
  maxCostPerRunUsd: z.coerce.number().positive().default(Infinity),
  maxCostPerGoalUsd: z.coerce.number().positive().default(Infinity),
  fallbackInputPer1M: z.coerce.number().nonnegative().default(1.0),
  fallbackOutputPer1M: z.coerce.number().nonnegative().default(3.0),
}),
```

Env vars:

- `BUDGET_MAX_COST_USD_PER_RUN` — hard cap per run.
- `BUDGET_MAX_COST_USD_PER_GOAL` — hard cap per goal.
- `BUDGET_FALLBACK_INPUT_PER_1M` / `BUDGET_FALLBACK_OUTPUT_PER_1M` — fallback pricing for unknown models.
- `BUDGET_PRICING_<MODEL>=<input>|<output>|<cached>` — per-model override. Underscores in the env var name are converted to dashes in the model name (e.g. `BUDGET_PRICING_GPT_4O_MINI` → `gpt-4o-mini`).

### Health endpoint

`GET /v1/healthz` now reports the configured caps so operators can verify
they're set in production:

```json
{
  "ok": true,
  "ts": "...",
  "retrievalMode": "hybrid",
  "costBudget": {
    "maxCostPerRunUsd": 1.0,
    "maxCostPerGoalUsd": 10.0
  }
}
```

### Local models

MiniCPM5 variants + Ollama embedders are 0-cost in the pricing table. A
pure-local deployment reports $0 spend — the caps are still enforced but
never triggered. This is the right behaviour: the operator pays for
hardware, not per-token, and the cost guardrails exist for metered APIs.

## Consequences

### Positive

- **Runaway-cost protection**: a misconfigured planner that loops or a
  model that hallucinates long outputs is bounded by the per-run cap.
  The run aborts with a clear error message; the operator sees the
  spend in the `model_invoked` event and the `BudgetExceededError`
  message.
- **Per-goal visibility**: the per-goal ledger lets operators see
  aggregate spend across all tasks in a goal — useful for cost-per-goal
  attribution and budget reporting.
- **Backwards-compatible**: defaults are Infinity (no cap) + 0-cost for
  MiniCPM5. Existing local deployments see no behaviour change. Cloud
  deployments get the guardrails by default if the operator sets the
  caps.
- **Pricing table is overridable**: the built-in table is a starting
  point; operators can override any model via env vars or extend the
  table in code. No upstream pricing changes break the tracker.
- **Honours prompt caching**: when the provider reports cached tokens
  (OpenAI prompt cache, Anthropic prompt cache, Gemini context cache),
  the cost computation uses the cached rate — accurate spend accounting
  for cached workloads.

### Negative

- **Pricing table needs maintenance**: prices change as providers update
  their catalogues. The table is sourced from public pricing pages at
  the time of writing (2026-Q4); operators should override with env vars
  when a price changes upstream.
- **In-memory ledger**: the cost ledger is per-process. A supervisor
  restart loses the in-flight goal's spend record. Mitigation: the
  per-run ledger is cleaned up when the run ends; the per-goal ledger
  is cleaned up when the orchestrator's goal completes. For long-running
  goals across restarts, operators should set conservative per-run caps
  (since per-goal accounting restarts).
- **Conservative fallback**: unknown models default to $1/$3 per 1M
  tokens, which is higher than most production models. This is
  intentional — better to over-estimate and trip the cap early than
  under-estimate and let costs run away. Operators who add a new model
  should add it to the table or override via env vars.

### Neutral

- The cost tracker is NOT wired into the `stepExecuteTool` step (tool
  calls don't invoke a model directly — they invoke a tool that may
  itself invoke a model via a separate backend). Tool-call cost is
  recorded when the tool's underlying model invocation happens through
  the supervisor engine. Direct backend calls outside the engine (e.g.
  the CodeChangeExecutor) are not yet tracked — that's a follow-up.
- Streaming vs non-streaming is irrelevant to cost — both paths
  produce the same `InferenceResponse.tokens` shape, which the
  tracker consumes.

## Alternatives considered

### Persist the cost ledger to Postgres

Rejected for the initial implementation — would require a new table +
migrations. The in-memory ledger is sufficient for the per-process cap
enforcement. A future enhancement can persist the `model_invoked` events
(which already include `costUsd`) to the existing events table for
post-hoc analysis.

### Compute cost only at the end of the run

Rejected. The whole point of the cap is to abort MID-run when spend
exceeds the budget. Computing cost after the run completes wouldn't
prevent runaway spend.

### Make the pricing table external (e.g. LiteLLM's pricing JSON)

Rejected for the initial implementation. The built-in table covers the
common production models and is overridable via env vars. An external
pricing source adds a runtime dependency and a freshness concern. A
future enhancement can add an optional external pricing source that
overrides the built-in table.

## Migration guide

Existing deployments are unaffected — caps default to Infinity.

To enable cost guardrails in a cloud deployment:

```bash
# Hard cap per run — aborts mid-generation if exceeded
BUDGET_MAX_COST_USD_PER_RUN=1.0

# Hard cap per goal — aborts the goal when exceeded
BUDGET_MAX_COST_USD_PER_GOAL=10.0

# Fallback pricing for models not in the built-in table
BUDGET_FALLBACK_INPUT_PER_1M=0.50
BUDGET_FALLBACK_OUTPUT_PER_1M=1.50

# Per-model override (model name with underscores → dashes)
# Format: input|output|cached
BUDGET_PRICING_GPT_4O_MINI=0.15|0.60|0.075
BUDGET_PRICING_CLAUDE_3_5_SONNET_20241022=3.00|15.00|0.30
```

The orchestrator automatically passes `goalId` to `Supervisor.run()` so
per-goal caps are enforced. The `model_invoked` event payload includes
`costUsd` — subscribe to it for live spend display:

```ts
supervisor.bus.subscribe((e) => {
  if (e.type === 'model_invoked') {
    console.log(`model=${e.payload.model} cost=$${e.payload.costUsd?.toFixed(4)}`);
  }
});
```

When a budget is exceeded, the run transitions to FAILED with
`BudgetExceededError` in the errorTrace. The orchestrator marks the task
as FAILED_EXECUTION and cascades BLOCKED to dependents.
