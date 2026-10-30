# ADR 0001: System One Decision Primitives

Date: 2026-10-30
Status: Accepted

## Context

The agent-tui supervisor already has a multi-provider inference layer (ADR 0009) and a per-task model router (ADR 0010). However, for certain workloads — particularly trading/market-data agents that co-host a fast controller alongside a larger reasoner — the supervisor's full task-ledger + orchestrator overhead is heavier than needed.

`@nemesis-oss/ollama-sdk` exposes Ollama's native `/v1/systemone` endpoint via `client.decision.*` ergonomic helpers (`route`, `choice`, `noul`, `verify`, `score`, `rank`) and the raw `client.systemOne()` for batched multi-question calls. This enables a lighter-weight pattern:

- **System 1** (<4B model, ~1 GB VRAM): fast, calibrated routing + verification
- **System 2** (any size): autonomous tool-loop reasoning via `Agent` + `ToolRegistry`

## Decision

Build a standalone `src/system-one-harness/` module that composes the SDK's primitives into a deterministic 3-stage turn:

1. **Route** — `client.decision.route()` with a confidence gate (default ≥ 0.65). Routes to a domain-scoped `ToolRegistry` or `direct_reply` (bypass).
2. **Agent** — `new Agent(client, { tools: registry }).run()` for the routed domain. Bypassed for `direct_reply` (uses `chatText` instead).
3. **Verify** — `client.decision.verify()` with a probability gate (default ≥ 0.85). Throws `VerificationGateError` on rejection.

### Model Catalog

System 1 supports any <4B model from a catalog (auto-picks the first locally available):

- `tev1:0.8b` (default — designed for `/v1/systemone`)
- `qwen2.5:1.5b`, `llama3.2:1b`, `gemma2:2b`, `phi3.5:3.8b`

System 2 accepts both large reasoners (`qwen3:8b`, `deepseek-coder:6.7b`, `glm-4.7:cloud`) and small ones (`tev1:4b`, `qwen2.5:3b`, `llama3.2:3b`) for operators on constrained GPUs.

### API Corrections from the Reference

The reference architecture's example code used several API shapes that don't match the real SDK. The implementation uses the real API:

| Reference (example) | Real SDK API |
|---|---|
| `keep_alive: -1` (snake_case on decision helpers) | `keepAlive: -1` (camelCase) |
| `routeResult.passed` / `routeResult.choice` | `routeResult.route` / `routeResult.isConfident` |
| `verification.passed` | `verification.verified` |
| `client.ps()` | `client.models.ps()` |
| `agentResult.content` | `agentResult.finalMessage.content` |
| `connection.bridge.register(registry)` | `new McpBridge(connection.client).register(registry)` |
| `rankResult.id` | `rankResult.candidate` |
| Raw JSON-schema `parameters` on tools | Zod `schema` via `defineTool()` |

### Multi-Axis Tool Gate

`evaluateToolCallGate()` uses the raw `client.systemOne()` (not a `decision.*` helper) to batch three questions — alignment (noul), injection (noul), blast radius (score) — into one forward pass. Injection above 0.30 hard-aborts (throws); low alignment rejects; high blast radius requires human approval.

### MCP Bridge

`attachMcpServer()` connects via `connectMcpHttpClient()` and wraps the `McpClientLike` in an `McpBridge` for tool registration. `rankToolsForPrompt()` uses `client.decision.rank()` to triage tools before handing the registry to an Agent.

## Consequences

- **Positive**: Lightweight, composable, and fully typed. The harness is ~230 lines of orchestration on top of the SDK's existing primitives. No new backend abstraction — it uses `OllamaClient` directly.
- **Positive**: Model-agnostic — any <4B model works for S1; any model works for S2. Auto-pick means operators don't change code when they swap models.
- **Positive**: Unit tests use the SDK's built-in `createMockOllamaServer` — no hand-rolled HTTP stubs, no GPU needed in CI.
- **Negative**: The harness is separate from the supervisor's backend abstraction (`src/supervisor/inference/`). Operators who want both would run two processes. A future ADR could bridge them.
- **Negative**: `Agent.run()` doesn't expose `keep_alive` — System 2 relies on the server default between turns. The `decision.*` and `chatText` calls DO pin via `keepAlive: -1`, so S1 stays resident and S2 is explicitly pinned on the bypass path.
