# ADR-0002 — Tool validation

## Status
Accepted — 2026-10-08

## Context
§10 of the reference architecture requires eight deterministic validation
gates before any tool call reaches the sandbox or an external API.
MiniCPM5-2B's tool-use score (66.6 on BFCL v4) is good for a 2.5B model
but not good enough to skip validation in production.

## Decision
- `ToolRegistry` holds the schema (zod), permissions, risk level,
  timeout, and an optional custom validator per tool.
- `ToolValidator` runs the eight gates from §10.2 in order:
  1. tool exists in registry
  2. arguments match zod schema
  3. caller has required permissions (§16 RBAC)
  4. resource path is within allowed scope
  5. command is not on the denylist (delegated to `CommandPolicy`)
  6. payload size ≤ 256 KiB
  7. no secrets in arguments (regex sweep)
  8. critical-risk tools require explicit approval (§9.4)
- `RepairLoop` feeds validation errors back to the tool model for up to
  `ESCALATION_MAX_RETRIES` rounds. After that, the run escalates or
  fails deterministically.

## Consequences
- **Positive:** the sandbox and external APIs only ever see schema-valid,
  permission-checked, secret-free calls; model mistakes are bounded and
  repairable; metrics can attribute failures to specific gates.
- **Negative:** the eight-gate pipeline adds ~1-3 ms per tool call. This
  is negligible next to the model's own latency.
- **Trade-off:** custom validators live next to the tool definition
  (single source of truth) rather than in a central policy file.
