# ADR 0007: Auto-decomposition of goals into tasks

**Status:** Proposed
**Date:** 2026-10-26
**Depends on:** ADR 0001 (supervisor state machine), ADR 0004 (model routing),
PR #32 (Phase 1 task ledger), PR #31 (P0 orchestration correctness)

## Context

PR #32 (Phase 1 task ledger) landed the durable task DAG, but the
caller had to supply the initial task graph manually via
`POST /v1/goals { tasks: [...] }`. The user's design specifies that
the system should "automatically handle everything" — a single
objective should produce a full task chain without the caller
decomposing it upfront.

Asking the model to emit free-form text and then parsing it ad-hoc
would defeat the verification gate PR #31 landed: a model that
generates `tasks: [{type: "ANALYZE", title: "..."}]` as prose could
not be distinguished from a model that emits a real plan. The
planner's output must be a Zod-validated discriminated union, with
malformed output rejected (and optionally repaired once) before any
task is created.

## Decision

Introduce a `TaskPlanner` service that asks the `minicpm5-router`
variant to emit the initial task graph for a goal under tight schema
control. The planner is the only path through which a free-text
objective becomes a structured task DAG; callers may still supply a
graph manually if they prefer.

### Schema

```ts
const PlannedTaskSchema = z.object({
  type: z.enum([
    'PLAN', 'RETRIEVE', 'ANALYZE', 'TOOL',
    'CODE_CHANGE', 'TEST', 'VERIFY', 'SUMMARIZE',
  ]),
  title: z.string().min(1).max(512),
  objective: z.string().min(1).max(16384),
  dependencies: z.array(z.number().int().nonnegative()).default([]),
  maxAttempts: z.number().int().positive().default(3),
});

const PlanSchema = z.object({ tasks: z.array(PlannedTaskSchema).min(1) });
```

The wrapper `{ tasks: [...] }` shape (rather than a bare array) is
intentional — it lets the model emit additional metadata later
(revision, rationale) without breaking the discriminated union.

### Bounds (post-parse, defence-in-depth)

The schema only checks shape. The planner additionally enforces:

1. **Task count** — `plan.tasks.length <= maxTasksPerGoal` (default 20).
2. **Forward-reference prohibition** — task `i` may only depend on
   indices `< i`. This makes cycles impossible by construction and
   keeps the planner's output deterministic.
3. **Depth cap** — the longest dependency chain must be `<= maxDepth`
   (default 5). Deeper chains indicate over-decomposition and should
   be split into sub-goals by the caller.
4. **Cycle detection** — DFS with three colours. With the
   forward-reference check this is unreachable in practice, but it
   runs anyway as defence in depth.

### Repair policy

On schema-invalid output, the planner retries up to
`maxRepairAttempts` (default 1) with the validation errors fed back
into the prompt. After that, terminal failure with
`TaskPlannerError` — the planner never silently accepts malformed
output.

### API surface

Two endpoints:

- `POST /v1/goals { autoPlan: true }` — when `tasks` is omitted and
  `autoPlan` is true, the planner runs first; the emitted graph is
  created atomically with the goal. The response carries
  `plannedByModel: true` so the caller knows the graph came from
  the model.
- `POST /v1/goals/:id/plan` — re-plan an existing ACTIVE goal. The
  new tasks are appended; existing tasks are NOT removed (the caller
  can cancel them separately). Returns 409 if the goal is not ACTIVE,
  422 on planner failure.

Both endpoints return 501 when the planner is not wired (e.g. older
config without `TaskPlanner` constructed in `main.ts`).

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PLANNER_MAX_TASKS_PER_GOAL` | `20` | Hard upper bound on tasks per plan |
| `PLANNER_MAX_DEPTH` | `5` | Longest dependency chain permitted |
| `PLANNER_MAX_REPAIR_ATTEMPTS` | `1` | Repair retries on schema-invalid output |

## Alternatives considered

- **Always require caller-supplied graph.** Rejects the user's
  explicit "automatically handle everything" requirement. The
  planner is opt-in (`autoPlan: false` is the default), so callers
  who prefer manual control keep it.
- **Plan via the Supervisor engine.** Would inherit the verification
  gate, but the engine's `run()` returns an `AgentState` (single
  task), not a task graph. Wrapping the planner in a run would
  conflate "produce a plan" with "execute a plan." The planner
  invokes the router variant directly via the existing `Backend`
  abstraction — the model pool (Phase 2) and the inference backend
  still apply, but the planner does not consume a Supervisor run.
- **Free-form text parsing.** Rejected — without a schema, the
  planner's output could not be distinguished from prose, defeating
  the verification gate PR #31 landed.

## Consequences

- `POST /v1/goals` gains an optional `autoPlan` flag (default
  `false`). Existing callers are unaffected — the flag is opt-in.
- The planner's output is observable via the `plannedByModel` field
  on the response, so an operator can tell which goals were
  auto-decomposed.
- A model that consistently emits schema-invalid output produces
  HTTP 422 responses with the validation errors and the raw output
  count for diagnosis. The drift counter
  (`zodParseFailureCounter`) is incremented on terminal failure.
- The planner does NOT verify semantic correctness of the emitted
  tasks — only schema shape, bounds, and DAG invariants. A plan
  that says "ANALYZE: count to ten" when the goal was "build an
  endpoint" will pass the planner and fail at the orchestrator's
  verification step. That's the correct division of responsibility:
  the planner proposes, the orchestrator verifies.
