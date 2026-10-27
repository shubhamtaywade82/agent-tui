# Minimum end-to-end acceptance suite

**Status:** Implemented — `test/supervisor/acceptance/acceptance.test.ts`
**Source:** Implementation spec §10 ("Minimum end-to-end acceptance suite")
**Gate:** "The system should not be considered ready until the following tests pass."

All 15 tests (13 required behaviours, with model residency and approval
each split into two cases) run in CI without Postgres or a real Ollama
daemon. The Postgres-backed persistence and real-model behaviour are
covered by the integration suite (`test/supervisor/integration/`).

## Test status

| # | Required behaviour (spec §10) | Implementation status | Where tested |
|---|---|---|---|
| 1 | **Model residency** — three variants may be resident; a fourth requires controlled eviction or an explicit failure | ✅ Complete — LRU eviction of non-pinned residents; `ModelPoolExhaustedError` when all pinned | acceptance tests 1a (eviction) + 1b (exhaustion) |
| 2 | **Concurrent loading** — concurrent requests cannot race past the residency limit | ✅ Complete — mutex serialises `acquire()`; only one load for N concurrent acquires of the same model | acceptance test 2 |
| 3 | **Dependency ordering** — a task cannot start before all required dependencies succeed | ✅ Complete — PENDING until deps SUCCEEDED; READY only after | acceptance test 3 |
| 4 | **Persisted model output** — a valid proposal and its model/version metadata survive a restart | ✅ Complete (data model) — attempts persist model, provider, raw output, parsed proposal, tokens; Postgres round-trip in integration suite | acceptance test 4 |
| 5 | **Invalid output** — schema-invalid output cannot be committed as a successful task result | ✅ Complete — verification gate blocks COMPLETED; `commitTaskOutput` rejects unverified attempts | acceptance test 5 |
| 6 | **Tool failure** — a failed tool invocation creates a persisted failure observation and triggers bounded recovery | ✅ Complete — attempt records the failure; task goes RETRYING (bounded by maxAttempts) | acceptance test 6 |
| 7 | **No progress** — repeated equivalent failures terminate or escalate instead of looping indefinitely | ✅ Complete (bounded) — terminates at maxAttempts; ⚠️ fingerprint-based equivalence detection (spec §10.4) is a follow-up | acceptance test 7 |
| 8 | **Model escalation** — the fallback endpoint is actually called, and the new model identity is recorded | ✅ Complete — fallback backend receives the call; `model_invoked` event carries the fallback model | acceptance test 8 |
| 9 | **Crash recovery** — restarting a process does not lose task state or blindly repeat a non-idempotent side effect | ✅ Complete (task state) — verified-but-uncommitted attempts commit; unverified return to READY; ⚠️ side-effect idempotency receipts are a follow-up | acceptance test 9 |
| 10 | **Approval** — a protected action waits for approval; granting approval resumes the correct pending action | ⚠️ Partial — critical-risk actions are blocked without approval and permitted with it; the approval decision persists as a `human_approved` event. Full pause-and-resume (an AWAITING_APPROVAL run that re-executes the exact pending action) is a follow-up. | acceptance tests 10a (gate) + 10b (event) |
| 11 | **Memory isolation** — a task cannot retrieve another user's or project's restricted artifacts | ✅ Complete (ACL layer) — tenant isolation + user/role grant filtering; Postgres end-to-end in integration suite | acceptance test 11 |
| 12 | **Goal completion** — the goal succeeds only after its required acceptance criteria have been verified | ✅ Complete — goal stays ACTIVE until all tasks terminal; SUCCEEDED only when none FAILED/BLOCKED | acceptance test 12 |
| 13 | **Long-task continuity** — a multi-stage task can resume using persisted task artifacts and a bounded context window | ✅ Complete — later task's prompt includes prior task's committed output (chain context); recover() resumes from the ledger | acceptance test 13 |

## Bugs the acceptance suite caught (and fixed)

Writing this suite surfaced two real defects in the Phase 1 task ledger
that unit tests missed:

1. **RETRYING tasks were never retried.** `listReadyTasks` filtered
   `status === 'READY'` only, so a task marked RETRYING after a failed
   attempt was silently never picked up again — bounded recovery
   stalled. `markRunning` accepts READY/RETRYING/ESCALATED, but nothing
   transitioned RETRYING back to a runnable state. Fixed in both
   `InMemoryTaskStore` and `PgTaskStore`: `listReadyTasks` now returns
   READY **and** RETRYING tasks.

2. **`InMemoryTaskStore.createTask` didn't check dependency
   satisfaction.** A task created after its dependency had already
   SUCCEEDED stayed PENDING forever — `commitTaskOutput` only unblocks
   tasks that exist at commit time. `PgTaskStore.createTask` already
   checked (`areDependenciesSatisfiedTx`); the in-memory store didn't.
   Fixed: parity with the Postgres store.

## Known gaps (documented, not hidden)

- **Approval pause-and-resume.** The current system blocks critical-risk
  actions at the validator gate and records approval events, but a run
  does not pause in AWAITING_APPROVAL and resume on grant. The spec
  requires the resume path to revalidate the action digest before
  executing — a follow-up feature, tracked separately.
- **Non-progress fingerprints.** Termination is bounded by maxAttempts,
  but the spec's richer fingerprint-based detection (identical
  normalized tool calls, repeated failure signatures, artifact-hash
  stagnation) is a follow-up.
- **Side-effect idempotency receipts.** Task state survives restarts;
  non-idempotent external side effects still need execution receipts
  and reconciliation per the spec's §9.3.

## Running

```bash
npm run supervisor:test                       # includes the acceptance suite
npx vitest run test/supervisor/acceptance     # acceptance suite only
```
