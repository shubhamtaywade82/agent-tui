# Agentic Supervisor

A production-grade orchestration layer that wraps **any LLM** — local
(MiniCPM5, Llama, Qwen, Mistral via Ollama or vLLM) or hosted
(OpenAI GPT-4o, Anthropic Claude, Google Gemini, DeepSeek) — in a
deterministic state machine. The LLM is treated strictly as a bounded
reasoning worker; all state, memory, retrieval, file abstraction, tool
validation, sandboxed execution, cost accounting, and verification live in
the surrounding TypeScript infrastructure.

> **Architectural principle** (§20 of the reference architecture):
> Use a small local model for compact, low-latency agent steps; use
> external infrastructure for truth, memory, state, security, and
> verification; use a stronger model — local or hosted — when task
> complexity exceeds the validated capability of the first-choice model.
>
> **Since ADR 0009**, the provider is a config choice, not a code
> constraint. Five backends are first-class: `ollama`, `vllm`,
> `openai`, `anthropic`, `gemini`. Switch with one env var. Mix them
> per task type with `TASK_MODEL_*` overrides (ADR 0010).

## Quick start — pick your provider

### A. Local Ollama (default; original target)

```bash
# 1. Boot the data services + Ollama + sandbox
docker compose --profile full up -d

# 2. Seed the MiniCPM5 sub-agent models into Ollama
OLLAMA_HOST=http://localhost:11434 bash supervisor/scripts/seed-models.sh

# 3. Run the supervisor HTTP API on :7480
npm install
npm run supervisor:serve

# 4. Kick off a run
curl -sS http://localhost:7480/v1/runs \
  -H 'content-type: application/json' \
  -d '{"objective":"Summarize these logs:\nERROR db refused\nWARN retry"}' | jq
```

### B. OpenAI (hosted; no local models required)

```bash
export INFERENCE_BACKEND=openai
export OPENAI_API_KEY=sk-...
export MINICPM5_ROUTER_MODEL=gpt-4o-mini
export MINICPM5_ANALYST_MODEL=gpt-4o
export MINICPM5_TOOL_MODEL=gpt-4o
export MINICPM5_SUMMARIZER_MODEL=gpt-4o-mini
# Embeddings stay hybrid — switch the embedding provider too:
export EMBEDDING_PROVIDER=openai
export EMBEDDING_MODEL=text-embedding-3-small
export EMBEDDING_DIMENSION=1536
npm run supervisor:serve
```

### C. Anthropic Claude (hosted)

```bash
export INFERENCE_BACKEND=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export MINICPM5_ROUTER_MODEL=claude-3-5-haiku-20241022
export MINICPM5_ANALYST_MODEL=claude-3-5-sonnet-20241022
export MINICPM5_TOOL_MODEL=claude-3-5-sonnet-20241022
export MINICPM5_SUMMARIZER_MODEL=claude-3-5-haiku-20241022
# Claude doesn't expose embeddings — use OpenAI or Ollama for retrieval:
export EMBEDDING_PROVIDER=openai
export EMBEDDING_OPENAI_API_KEY=sk-...
export EMBEDDING_MODEL=text-embedding-3-small
export EMBEDDING_DIMENSION=1536
npm run supervisor:serve
```

### D. Google Gemini (hosted)

```bash
export INFERENCE_BACKEND=gemini
export GEMINI_API_KEY=...
export MINICPM5_ROUTER_MODEL=gemini-2.0-flash
export MINICPM5_ANALYST_MODEL=gemini-2.0-flash
export MINICPM5_TOOL_MODEL=gemini-2.0-flash
export MINICPM5_SUMMARIZER_MODEL=gemini-2.0-flash
export EMBEDDING_PROVIDER=openai        # same as Claude — Gemini has no /embeddings
export EMBEDDING_OPENAI_API_KEY=sk-...
npm run supervisor:serve
```

### E. Any OpenAI-compatible endpoint (vLLM, LM Studio, Together, Z.ai, OpenRouter…)

```bash
export INFERENCE_BACKEND=vllm
export VLLM_BASE_URL=https://api.openrouter.ai/v1    # or your vLLM/LM Studio/Together host
export VLLM_API_KEY=your-key
export MINICPM5_ROUTER_MODEL=meta-llama/llama-3.1-8b-instruct
export MINICPM5_ANALYST_MODEL=anthropic/claude-3.5-sonnet
npm run supervisor:serve
```

### F. Mixed — cheap router + capable analyst + specialised coder (ADR 0010)

```bash
export INFERENCE_BACKEND=vllm                            # or any single backend
export VLLM_BASE_URL=https://api.openrouter.ai/v1
export VLLM_API_KEY=your-key
export TASK_MODEL_RETRIEVE=gpt-4o-mini                   # cheap retrieval
export TASK_MODEL_ANALYZE=gpt-4o                         # strong reasoning
export TASK_MODEL_CODE_CHANGE=anthropic/claude-3.5-sonnet  # code specialist
export TASK_MODEL_TEST=google/gemini-2.0-flash-001      # fast verification
npm run supervisor:serve
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
Inference Backend (§13) ─── Ollama / vLLM / OpenAI / Anthropic / Gemini / Mock
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

The map below applies to **any small model** — MiniCPM5-2B was the original
inspiration, but every local LLM in the 2B–9B class shares these limits.
Cloud models (GPT-4o, Claude, Gemini) hit the same walls at larger scales;
the same infrastructure compensates regardless of provider.

| Small-model limitation               | Compensation in this repo                                                |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Weak long-horizon SWE               | `PatchWorkflow` (§12.3) + state machine (§9) break tasks into verified steps |
| Weak terminal work                  | `SandboxExecutor` (§11) + `CommandPolicy` allowlist/denylist             |
| KV-cache memory limits              | `ContextBuilder` (§8) with deterministic token budget; `HybridRetriever` (§6) |
| Hallucinated facts/file contents    | `HybridRetriever` (§6) + citation requirement in the analyst prompt      |
| No cross-session memory             | `MemoryService` (§7) — seven tiers, persisted to Postgres                |
| Unreliable complex tool calls       | `ToolRegistry` + `ToolValidator` + `RepairLoop` (§10)                    |
| Cannot reason over large codebases  | `CodeIndexer` (§12) — tree-sitter symbol index                           |
| Limited frontier reasoning          | `ModelRouter` (§13) escalates to fallback model; per-task model map (ADR 0010) |
| Limited local VRAM for long context | Default 8K–32K context budget; retrieval on demand                       |
| Runaway cost on metered APIs        | `CostTracker` (ADR 0012) — hard caps per run + per goal                  |
| No live progress on long generations | Streaming backends (ADR 0011) — token-by-token events                |

## Project layout

```
src/supervisor/
  engine.ts                  — deterministic ROUTE→EXECUTE→VALIDATE loop
  config.ts                  — zod env config (single source of truth)
  state/                     — §1, §4, §9  state machine, event sourcing, pg store
  inference/                 — §13         Backend protocol + Ollama/vLLM/OpenAI/Anthropic/Gemini/Mock impls
  router/                    — §13         classifier, complexity, model router
  context/                   — §6, §7, §8  retriever, memory, context builder
  tools/                     — §10         registry, validator, repair loop
  sandbox/                   — §11         docker executor + command policy
  code/                      — §12         tree-sitter indexer + patch workflow
  evals/                     — §15         golden tasks + metrics
  observability/             — §15         pino logger + OpenTelemetry + CostTracker
  security/                  — §16         RBAC + secret resolver
  api/                       — §3          Fastify routes + OpenAPI
supervisor/
  drizzle/                   — SQL migrations
  modelfiles/                — Ollama Modelfiles (MiniCPM5 router/tool/analyst/summarizer + benchmark variants)
  scripts/seed-models.sh     — pull + create the MiniCPM5 sub-agent models (local backend only)
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

- [Setup & usage guide](usage.md)
- [ADR-0001 — Supervisor state machine](adr/0001-supervisor-state-machine.md)
- [ADR-0002 — Tool validation](adr/0002-tool-validation.md)
- [ADR-0003 — Sandbox isolation](adr/0003-sandbox-isolation.md)
- [ADR-0004 — Model routing](adr/0004-model-routing.md)
- [ADR-0005 — Vector DB + External Memory Module](adr/0005-vector-db-and-external-memory.md)
- [ADR-0006 — Model pool](adr/0006-model-pool.md)
- [ADR-0007 — Task planner](adr/0007-task-planner.md)
- [ADR-0008 — Embedding provider](adr/0008-embedding-provider.md)
- [ADR-0009 — Multi-provider inference](adr/0009-multi-provider-inference.md)
- [ADR-0010 — Per-task model selection](adr/0010-per-task-model-selection.md)
- [ADR-0011 — Streaming backends](adr/0011-streaming-backends.md)
- [ADR-0012 — Cost-budget accounting](adr/0012-cost-budget-accounting.md)
- [API reference](api.md)
- [Runbook](runbook.md)
- [Architecture diagram](diagrams/architecture.mmd)
- [RAG flow diagram](diagrams/rag-flow.mmd)
- [Patch workflow diagram](diagrams/patch-workflow.mmd)

## Design-guide compliance

Every recommendation in the uploaded design guide (Part 1 §1–§14 + Part 2
§1–§17) is addressed. See [ADR-0005](adr/0005-vector-db-and-external-memory.md)
for the full mapping. Summary:

| Guide § | Recommendation | Implementation |
| --- | --- | --- |
| P1 §4 | Structure-aware chunking | `ChunkMetadata` + `CodeIndexer` symbol-boundary chunking |
| P1 §5 | Rich chunk metadata | 12 first-class columns on `chunks` table + JSONB extras |
| P1 §6 | Full hybrid pipeline | RRF score fusion in `HybridRetriever.retrieve()` |
| P1 §7 | Weighted reranker | `0.55*sem + 0.20*kw + 0.10*recency + 0.10*authority + 0.05*quality` |
| P1 §8 | Retrieval as validated tool | `retrieve_knowledge` tool with zod schema + permission gate |
| P1 §9 | Grounded prompt | `[EVIDENCE-N source=... section=...]` tags + JSON output schema |
| P1 §10 | Token budget formula | `total - reserve - safetyMargin = usable` |
| P1 §11 | 4-layer cache | `CacheService` (prompt+gen) + `HybridRetriever` (emb+retrieval) |
| P1 §12 | Tenant isolation | `RetrievalFilters` + `applyAclFilter()` before model sees results |
| P1 §13 | Separate retrieval + generation metrics | `recordRetrievalEval` + `recordGenerationEval` |
| P2 §3 | Memory service API | write/read/get/update/delete/consolidate/checkpoint/snapshot/sweep/decay |
| P2 §4.1 | Full memory_items schema | 19 columns incl. `superseded_by`, `acl` JSONB, `source_run_id` |
| P2 §4.5 | Context snapshots | `context_snapshots` table, auto-saved by engine |
| P2 §6 | Selective read path | namespace → recent → important → semantic → ACL → rerank → compress |
| P2 §7 | Context compaction | `runSummary` replaces raw history; oversized sections truncated |
| P2 §8 | Checkpoints | `checkpoints` table + `createCheckpoint`/`getLatestCheckpoint` |
| P2 §10 | Memory consolidation | `consolidateRun()` auto-called on run completion |
| P2 §11 | Forgetting | TTL sweep + importance decay + supersession with `superseded_by` |
| P2 §12 | Memory security | 6 secret patterns block writes; PII patterns logged |
| P2 §13 | Memory tools | `memory_search` + `memory_write` with type allowlist + length limits |
| P2 §14 | Runtime loop steps 12–13 | Compaction in `ContextBuilder`; consolidation in engine finally |
