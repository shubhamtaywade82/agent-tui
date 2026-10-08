# ADR-0001 — Supervisor state machine

## Status
Accepted — 2026-10-08

## Context
MiniCPM5-2B is a probabilistic reasoning node. If we let it drive task
progress directly (e.g. "the model decided we're done"), we get silent
state corruption, skipped validation, and un-auditable runs. The §1 and
§9 sections of the reference architecture require an explicit
deterministic state machine to bound the LLM.

## Decision
Implement a single `StateMachine` class with an `ALLOWED` transition
table. The machine is the only thing allowed to mutate `AgentState.status`.
Illegal transitions throw `IllegalTransitionError` synchronously.

States:
```
CREATED → PLANNING → RETRIEVING → EXECUTING → VALIDATING → COMPLETED
                ↘ AWAITING_APPROVAL ↗
        ↘ ESCALATED → PLANNING/EXECUTING/COMPLETED/FAILED
RETRYING → PLANNING/RETRIEVING/EXECUTING/ESCALATED
```

Every transition emits a `state_transitioned` domain event persisted to
the `events` table (§9.2 event sourcing).

## Consequences
- **Positive:** runs are fully replayable from the event log; crashes
  can be recovered by rehydrating AgentState from the `runs` table and
  the last event; CI can assert that no code path reaches COMPLETED
  without going through VALIDATING.
- **Negative:** adding a new state requires updating the `ALLOWED` map
  and the `RunStatus` zod enum in lock-step. Tests cover both.
- **Mitigation:** the `reachableFrom()` method exposes the legal
  successor set, used by the API's `/v1/runs/:id/next` endpoint to
  drive approval UX.
