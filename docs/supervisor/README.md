# MiniCPM5 Supervisor

A production-grade orchestration layer that wraps the MiniCPM5-2B family of
sub-agents in a deterministic state machine. The LLM is treated strictly
as a bounded reasoning worker — all state, memory, retrieval, file
abstraction, tool validation, and sandboxed execution live in the
surrounding TypeScript infrastructure.

> **Architectural principle** (§20 of the reference architecture):
> Use MiniCPM5-2B for compact, local, low-latency agent steps; use
> external infrastructure for truth, memory, state, security, and
> verification; use larger models only when task complexity exceeds the
> validated capability of the small model.

## Quick start

```bash
# 1. Boot the data services + Ollama + sandbox
docker compose --profile full up -d

# 2. Seed the four MiniCPM5 sub-agent models into Ollama
OLLAMA_HOST=http://localhost:11434 bash supervisor/scripts/seed-models.sh

# 3. Run the supervisor HTTP API on :7480
npm install
npm run supervisor:serve

# 4. Kick off a run
curl -sS http://localhost:7480/v1/runs \
  -H 'content-type: application/json' \
  -d '{"objective":"Summarize these logs:\nERROR db refused\nWARN retry"}' | jq
```

OpenAPI docs live at <http://localhost:7480/docs>.

## Reference architecture

```
User / API / IDE / CLI
        │
        ▼
Gateway + Authorization (§16)
        │
        ▼
Router / Planner (§13)
        │
        ▼
Context Builder (§8)
  ├─ State DB (§4)
  ├─ Memory DB (§7)
  ├─ Retrieval Index (§6)
  └─ Tool Registry (§10)
        │
        ▼
MiniCPM5 Inference (§13) ─── Ollama / vLLM / Mock
        │
        ▼
Output Parser + Validator (§10)
        │
        ▼
Action Executor (§11) ─── Docker sandbox
        │
        ▼
Result Normalizer + Evaluator (§12, §15)
        │
        ▼
State Store / Audit Log / Memory Writer (§4, §7, §9.2)
        │
        ▼
Next step, Retry, Escalate, or Complete
```

## Limitation → Infrastructure compensation map

| MiniCPM5-2B limitation               | Compensation in this repo                                                |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Weak long-horizon SWE               | `PatchWorkflow` (§12.3) + state machine (§9) break tasks into verified steps |
| Weak terminal work                  | `SandboxExecutor` (§11) + `CommandPolicy` allowlist/denylist             |
| KV-cache memory limits              | `ContextBuilder` (§8) with deterministic token budget; `HybridRetriever` (§6) |
| Hallucinated facts/file contents    | `HybridRetriever` (§6) + citation requirement in analyst Modelfile       |
| No cross-session memory             | `MemoryService` (§7) — seven tiers, persisted to Postgres                |
| Unreliable complex tool calls       | `ToolRegistry` + `ToolValidator` + `RepairLoop` (§10)                    |
| Cannot reason over large codebases  | `CodeIndexer` (§12) — tree-sitter symbol index                           |
| Limited frontier reasoning          | `ModelRouter` (§13) escalates to fallback model                          |
| Limited local VRAM for long context | Default 8K–32K context budget; retrieval on demand                       |

## Project layout

```
src/supervisor/
  engine.ts                  — deterministic ROUTE→EXECUTE→VALIDATE loop
  config.ts                  — zod env config (single source of truth)
  state/                     — §1, §4, §9  state machine, event sourcing, pg store
  inference/                 — §13         Backend protocol + Ollama/vLLM/Mock impls
  router/                    — §13         classifier, complexity, model router
  context/                   — §6, §7, §8  retriever, memory, context builder
  tools/                     — §10         registry, validator, repair loop
  sandbox/                   — §11         docker executor + command policy
  code/                      — §12         tree-sitter indexer + patch workflow
  evals/                     — §15         golden tasks + metrics
  observability/             — §15         pino logger + OpenTelemetry
  security/                  — §16         RBAC + secret resolver
  api/                       — §3          Fastify routes + OpenAPI
supervisor/
  drizzle/                   — SQL migrations
  modelfiles/                — 4 Ollama Modelfiles (router/tool/analyst/summarizer)
  scripts/seed-models.sh     — pull + create the four sub-agent models
docker-compose.yml           — single compose with dev/test/full profiles
Dockerfile.supervisor        — multi-stage production image
Dockerfile.sandbox           — read-only base with allowlisted dev tools
test/supervisor/             — unit, integration, and golden eval tests
docs/supervisor/             — ADRs, API reference, runbook, diagrams
```

## Testing

```bash
npm run supervisor:test          # vitest unit + evals
docker compose --profile test up -d
TEST_DATABASE_URL=postgres://supervisor:supervisor@localhost:55432/supervisor_test \
  npm run supervisor:test        # + integration tests
```

## Configuration

Every knob is exposed via environment variables — see
[`.env.supervisor.example`](../../.env.supervisor.example) for the full
list with comments. The supervisor reads `.env` once at boot and never
writes secrets to disk.

## Further reading

- [ADR-0001 — Supervisor state machine](adr/0001-supervisor-state-machine.md)
- [ADR-0002 — Tool validation](adr/0002-tool-validation.md)
- [ADR-0003 — Sandbox isolation](adr/0003-sandbox-isolation.md)
- [ADR-0004 — Model routing](adr/0004-model-routing.md)
- [API reference](api.md)
- [Runbook](runbook.md)
- [Architecture diagram](diagrams/architecture.mmd)
- [RAG flow diagram](diagrams/rag-flow.mmd)
- [Patch workflow diagram](diagrams/patch-workflow.mmd)
