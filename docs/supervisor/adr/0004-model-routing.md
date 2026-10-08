# ADR-0004 — Model routing and escalation

## Status
Accepted — 2026-10-08

## Context
§13.1 of the reference architecture specifies explicit criteria for
when to handle a task locally with MiniCPM5-2B and when to escalate to
a larger fallback model. The §20 final recommendation is to use larger
models *only* when task complexity exceeds the validated capability of
the small model — we need a deterministic router to enforce that
boundary.

## Decision
Implement three cooperating components:

1. **`RouterClassifier`** — calls `minicpm5-router` to classify user
   intent into one of `DATA_EXTRACTION`, `CODE_REVIEW`,
   `TOOL_EXECUTION`, `LOG_SUMMARIZATION`, `GENERAL_QUERY`, or
   `UNKNOWN`. The output is validated against the enum; any
   unrecognised value collapses to `UNKNOWN` and is logged (§1
   validation gate).

2. **`ComplexityScorer`** — a cheap deterministic heuristic that flags
   tasks likely to exceed MiniCPM5-2B's capability ceiling. It bumps
   the score for: refactor/rewrite language, autonomy language,
   production-risk language, known hard benchmarks (SWE-bench,
   Terminal-Bench), distributed systems reasoning, formal reasoning,
   and long queries.

3. **`ModelRouter`** — combines intent + complexity + retry count +
   validation failure count into a `ModelChoice`. Returns either
   `{ kind: 'local', model, thinkMode }` or
   `{ kind: 'escalate', fallbackModel, reason }`. Hard escalation
   triggers (§13.1): 3+ validation failures, max retries exceeded,
   complexity ≥ 0.5.

The `thinkMode` field drives the §13.3 hybrid Think/No-Think behaviour:
- `no-think` for simple tool calls, classification, extraction
- `think` for code review, planning, debugging, patch generation

## Consequences
- **Positive:** escalation is deterministic and auditable — every
  escalation is recorded as a `model_escalated` event with the reason.
- **Positive:** the hybrid think mode saves latency and KV-cache memory
  on routine agent steps.
- **Negative:** the complexity scorer is heuristic and will
  occasionally over- or under-escalate. The §15.3 golden eval suite
  catches regressions; the scorer's weights are tuned there.
- **Future:** when a cross-encoder reranker is added to the retrieval
  pipeline (§6), the same pattern can be used to add a learned
  complexity classifier — same `ModelRouter` interface.
