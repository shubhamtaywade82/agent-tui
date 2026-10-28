# Agentic Supervisor — Setup & Usage Guide

Everything you need to go from a fresh `git clone` to a working supervisor API,
with **any of five inference providers** — Ollama (local, default), vLLM
(any OpenAI-compatible endpoint), OpenAI, Anthropic, or Google Gemini.
Companion to [README.md](README.md) (architecture) and [runbook.md](runbook.md)
(operations). Commands in §3 were verified end-to-end on 2026-10-08 with
Node 24.19 / npm 11.17 / Docker 28 / Ollama 0.35.

## 1. Prerequisites

**All deployments** need:

| Requirement | Notes |
| --- | --- |
| Node.js ≥ 20 + npm ≥ 10 | Verified on Node 24.19, npm 11.17 (peer conflicts are enforced) |
| Docker + Compose v2 | Sandbox executor + the compose stack |
| PostgreSQL 16+ **with pgvector** | `CREATE EXTENSION vector` runs at boot |
| Redis 7 | Working-memory cache (`MemoryService`) |

**Per inference backend** (pick ONE row):

| Backend | Requirement | Disk / setup |
| --- | --- | --- |
| `ollama` (default) | Local Ollama daemon + MiniCPM5 base model | ~4 GB (`openbmb/minicpm5-2b` 1.6 GB + 4 sub-agent tags). See §5 |
| `vllm` | Any OpenAI-compatible endpoint: vLLM server, LM Studio, Together, Anyscale, Z.ai GLM, OpenRouter, LiteLLM proxy | 0 local disk; one URL + key |
| `openai` | `OPENAI_API_KEY` | 0 local disk |
| `anthropic` | `ANTHROPIC_API_KEY` | 0 local disk |
| `gemini` | `GEMINI_API_KEY` | 0 local disk |
| `mock` | Nothing — fully deterministic, no network | 0 (tests / offline dev) |

MinIO is **not** required: `OBJECT_STORE_KIND` is config-only today (no object
store client is wired yet).

**Embedding provider** (independent of the inference backend — see §4.1):
`ollama` (default when backend is `ollama`), `openai` (any
OpenAI-compatible `/v1/embeddings` — OpenAI, Voyage, Cohere, Jina, Nomic,
Azure), or `none` (keyword-only retrieval).

## 2. Install

```bash
git clone <repo> && cd agentic-tui
npm install
```

> If `npm install` fails with `ERESOLVE` on `tree-sitter`, you are on a commit
> before `b300540`. See §9 troubleshooting.

## 3. Data services

### 3.1 Clean machine — `docker compose` (recommended)

Binds `5432`, `6379`, `11434`, `9000/9001`, so those ports must be free.

```bash
docker compose --profile full up -d     # postgres + redis + minio + ollama + sandbox + supervisor
docker compose exec postgres pg_isready -U supervisor
```

`--profile full` starts the supervisor **container** too. To instead run the API
from source (this guide's default), use no profile for infra only:

```bash
docker compose up -d postgres redis ollama sandbox
```

> Cloud-only deployments don't need the `ollama` service — omit it:
> `docker compose up -d postgres redis sandbox`

### 3.2 Machine that already uses Postgres/Redis (what we did here)

If `5432`/`6379` are occupied by existing services, do **not** start the
compose stack — reuse them, but note the running Postgres must have pgvector:

```bash
# pgvector missing on a system Postgres and no root to apt-install it?
# Run the docs' own image on a free port instead:
docker run -d --name supervisor-postgres \
  -e POSTGRES_USER=supervisor -e POSTGRES_PASSWORD=supervisor -e POSTGRES_DB=supervisor \
  -p 5434:5432 -v supervisor-pgdata:/var/lib/postgresql/data \
  pgvector/pgvector:pg17

docker exec supervisor-postgres psql -U supervisor -d supervisor \
  -c "CREATE DATABASE supervisor_test OWNER supervisor"   # for integration tests
```

Point the app at it (see §4 for config precedence):

```bash
export DATABASE_URL=postgres://supervisor:supervisor@localhost:5434/supervisor
```

Make it permanent by putting that same line in `.env` — it is loaded at boot and
**nothing else in this repo reads `DATABASE_URL`** (only `TEST_DATABASE_URL`,
which belongs to integration tests), so plain `npm run supervisor:migrate` and
`npm run supervisor:serve` then do the right thing with no inline env.

> Skipping this is the classic failure: with no `DATABASE_URL` the default
> `localhost:5432` is used, `migrate` dies on `extension "vector" is not
> available`, and `serve` starts anyway with `retriever init failed` — the API
> looks healthy but retrieval is disabled.

## 4. Configuration

`src/supervisor/config.ts` (zod) is the single source of truth; **every value
has a working default** and is overridable via environment variables. `.env` is
loaded at boot and never written to.

Full annotated list: [`.env.supervisor.example`](../../.env.supervisor.example).

### 4.1 Pick your inference backend (ADR 0009)

| Variable | Default | Values |
| --- | --- | --- |
| `INFERENCE_BACKEND` | `ollama` | `ollama` \| `vllm` \| `openai` \| `anthropic` \| `gemini` \| `mock` |

**Local Ollama (default):**

```bash
export INFERENCE_BACKEND=ollama
export OLLAMA_HOST=http://localhost:11434
export MINICPM5_ROUTER_MODEL=minicpm5-router
export MINICPM5_ANALYST_MODEL=minicpm5-analyst
```

**OpenAI (hosted):**

```bash
export INFERENCE_BACKEND=openai
export OPENAI_API_KEY=sk-...
export MINICPM5_ROUTER_MODEL=gpt-4o-mini
export MINICPM5_ANALYST_MODEL=gpt-4o
export MINICPM5_TOOL_MODEL=gpt-4o
export MINICPM5_SUMMARIZER_MODEL=gpt-4o-mini
# Embeddings — switch to the OpenAI embedder so retrieval stays hybrid:
export EMBEDDING_PROVIDER=openai
export EMBEDDING_MODEL=text-embedding-3-small
export EMBEDDING_DIMENSION=1536
```

**Anthropic (hosted):**

```bash
export INFERENCE_BACKEND=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export MINICPM5_ROUTER_MODEL=claude-3-5-haiku-20241022
export MINICPM5_ANALYST_MODEL=claude-3-5-sonnet-20241022
# Claude doesn't expose /v1/embeddings — keep embeddings on OpenAI or Ollama:
export EMBEDDING_PROVIDER=openai
export EMBEDDING_OPENAI_API_KEY=sk-...
```

**Gemini (hosted):**

```bash
export INFERENCE_BACKEND=gemini
export GEMINI_API_KEY=...
export MINICPM5_ROUTER_MODEL=gemini-2.0-flash
export MINICPM5_ANALYST_MODEL=gemini-2.0-flash
export EMBEDDING_PROVIDER=openai    # same as Claude — Gemini has no embeddings
```

**Any OpenAI-compatible endpoint (vLLM / LM Studio / Together / Z.ai / OpenRouter / LiteLLM):**

```bash
export INFERENCE_BACKEND=vllm
export VLLM_BASE_URL=https://api.openrouter.ai/v1
export VLLM_API_KEY=your-key
export MINICPM5_ROUTER_MODEL=meta-llama/llama-3.1-8b-instruct
export MINICPM5_ANALYST_MODEL=anthropic/claude-3.5-sonnet
```

### 4.2 Per-task model overrides (ADR 0010)

Mix models per task type in the same deployment:

```bash
export TASK_MODEL_RETRIEVE=gpt-4o-mini          # cheap retrieval
export TASK_MODEL_ANALYZE=gpt-4o                # strong reasoning
export TASK_MODEL_CODE_CHANGE=anthropic/claude-3.5-sonnet
export TASK_MODEL_TEST=google/gemini-2.0-flash-001
```

When mixing models from multiple providers, deploy an OpenAI-compatible proxy
(LiteLLM, OpenRouter) and set `INFERENCE_BACKEND=vllm` + the proxy URL. All
`TASK_MODEL_*` env vars then route through the proxy.

### 4.3 Cost guardrails (ADR 0012)

Cloud metered APIs should set caps — the engine aborts runs that exceed them:

```bash
export BUDGET_MAX_COST_USD_PER_RUN=1.0
export BUDGET_MAX_COST_USD_PER_GOAL=10.0
```

MiniCPM5 variants + Ollama embedders are 0-cost in the built-in pricing table —
local deployments see $0 spend and never trip the caps.

### 4.4 Other key variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://supervisor:supervisor@localhost:5432/supervisor` | Postgres state + memory + retrieval |
| `REDIS_URL` | `redis://localhost:6379/0` | Cache / working memory |
| `SUPERVISOR_HTTP_PORT` | `7480` | API port (`/docs` = OpenAPI) |
| `SUPERVISOR_HTTP_HOST` | `127.0.0.1` | Bind address. Non-loopback needs `SUPERVISOR_API_KEY` |
| `SUPERVISOR_API_KEY` | _(unset)_ | Bearer token for all routes except `/v1/healthz` and `/docs`. At least 16 characters. Unset on loopback generates a token per run |
| `SUPERVISOR_CORS_ORIGINS` | _(empty)_ | Comma-separated browser origins allowed to call the API. Empty disables CORS |
| `SANDBOX_IMAGE` / `SANDBOX_NETWORK` | `supervisor-sandbox:latest` | Exec sandbox |

Prefer setting a value **once in `.env`** (loaded at boot, git-ignored); use an
inline prefix only for a one-off override — inline always wins.

## 5. Seed the MiniCPM5 sub-agent models (local `ollama` backend only)

Skip this section for `vllm` / `openai` / `anthropic` / `gemini` / `mock` —
those backends have no local models to seed.

```bash
OLLAMA_HOST=http://localhost:11434 bash supervisor/scripts/seed-models.sh
```

Idempotent — it skips anything that already exists (`ollama show`, no pipefail
greps). It pulls `openbmb/minicpm5-2b` only if absent, then runs
`ollama create` for `minicpm5-router`, `minicpm5-toolagent`, `minicpm5-analyst`
and `minicpm5-summarizer` from the Modelfiles in `supervisor/modelfiles/`.

Override the base with `BASE_MODEL=…` if your tag differs. Manual equivalent:

```bash
ollama create minicpm5-router -f supervisor/modelfiles/router.Modelfile
```

**Non-MiniCPM5 local models work too** — skip the Modelfiles entirely and point
the config at any model your Ollama daemon has pulled:

```bash
export INFERENCE_BACKEND=ollama
export MINICPM5_ROUTER_MODEL=qwen2.5:7b
export MINICPM5_ANALYST_MODEL=qwen2.5:14b
export MINICPM5_TOOL_MODEL=qwen2.5:7b
export MINICPM5_SUMMARIZER_MODEL=qwen2.5:7b
export EMBEDDING_MODEL=nomic-embed-text    # or bge-m3 / mxbai-embed-large
```

## 6. Create the schema

```bash
npm run supervisor:migrate
```

(No `DATABASE_URL=` prefix — that lives in `.env` from §3.2. Never paste a
placeholder as a real value: `pg` parses a bare `…` as **host `base`**, giving
`getaddrinfo ENOTFOUND base`.)

Safe to re-run (everything is `CREATE TABLE IF NOT EXISTS`). It runs each
subsystem's own DDL so schema and code cannot drift. Creates 10 tables and two
extensions:

```
runs, steps, events, tool_calls, artifacts, approvals   -- state store (§4)
chunks                                                  -- retrieval (§6)
memories, context_snapshots, checkpoints                -- memory (§7)
extensions: vector, pg_trm
```

The server also migrates itself on boot, so this is only needed for a clean DB
or CI.

## 7. Run it

```bash
npm run supervisor:serve
# → Supervisor API listening — OpenAPI docs at /docs
```

Smoke test:

```bash
curl -fsS http://localhost:7480/v1/healthz
# {"ok":true,"ts":"…","retrievalMode":"hybrid","costBudget":{"maxCostPerRunUsd":…,"maxCostPerGoalUsd":…}}

curl -sS http://localhost:7480/v1/runs -H "authorization: Bearer $SUPERVISOR_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"objective":"Summarize these logs:\nERROR db refused\nWARN retrying in 5s"}' | jq
# {"runId":"…","status":"COMPLETED","intent":"LOG_SUMMARIZATION","finalResponse":"## Summary\n…"}
```

A completed run means the whole chain worked: RouterClassifier classified the
intent (a real model call via whichever backend you configured),
ContextBuilder assembled the prompt, the analyst / summarizer model generated
the answer, the validator passed it, and the state machine persisted
`runs` + `events` + `steps`. Inspect it:

```bash
AUTH="authorization: Bearer $SUPERVISOR_API_KEY"
curl -sS -H "$AUTH" localhost:7480/v1/runs/$RUN_ID/events | jq
curl -sS -H "$AUTH" localhost:7480/v1/metrics | jq
curl -sS -H "$AUTH" localhost:7480/v1/tools | jq
```

Offline development (no model calls at all):

```bash
INFERENCE_BACKEND=mock npm run supervisor:serve
```

## 8. Everyday commands

| Command | What it does |
| --- | --- |
| `npm run supervisor:serve` | HTTP API on `:7480` (OpenAPI at `/docs`) |
| `npm run supervisor:migrate` | Idempotent schema bootstrap |
| `npm run supervisor:seed-models` | Create/refresh the four MiniCPM5 sub-agent models (local backend only) |
| `npm run supervisor:test` | Unit tests (vitest) |
| `npm run supervisor:evals` | Golden-task eval suite (`INFERENCE_BACKEND=mock` for no-model) |
| `npm run supervisor:lint` / `:lint:fix` | Biome over `src/supervisor` + `test/supervisor` |
| `npm run supervisor:typecheck` | `tsc --noEmit` |
| `npx tsx src/index.ts supervisor health` | Check the supervisor API from the main CLI (see §10) |

### Tests

```bash
npm run supervisor:test                 # unit + evals

# integration (real Postgres; needs TEST_DATABASE_URL)
docker compose --profile test up -d     # postgres-test :55432, redis-test :66379
TEST_DATABASE_URL=postgres://supervisor:supervisor@localhost:55432/supervisor_test \
  npx vitest run test/supervisor/integration
```

Without `TEST_DATABASE_URL` the integration directory is excluded (and the suite
self-skips), so plain `npm run supervisor:test` never needs Docker.

### Sandbox (optional — only for `TOOL_EXECUTION` runs that shell out)

The executor spawns a **fresh container per command** via `dockerode`, so it
needs the Docker socket and the image to exist:

```bash
docker build -f Dockerfile.sandbox -t supervisor-sandbox:latest .
docker network create supervisor-net   # only if you never started the compose stack
```

(Inside Docker, mount the socket: `-v /var/run/docker.sock:/var/run/docker.sock`,
as `docker-compose.yml` and `Dockerfile.supervisor` do.)

Without the image/network, sandbox tool calls fail and the run moves to
`RETRYING`/`FAILED` rather than hanging.

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm error ERESOLVE … tree-sitter-javascript` | Grammar peers want `tree-sitter@^0.21.1`, root declared `^0.22.4` | Update to commit `b300540`+ (aligned on `tree-sitter@^0.21.1`, `tree-sitter-python@0.23.4`). `tree-sitter-typescript@0.23.2` caps the runtime at `0.21.x`, so going *up* to 0.25 is not possible |
| `vitest: No test files found, exiting with code 1` | `vitest run --dir <path>` re-roots the include glob → 0 matches | Use path filters: `npx vitest run test/supervisor/unit` (fixed in `package.json` + CI) |
| `npm run supervisor:migrate` → module not found | Script pointed at `src/supervisor/db/migrate.ts`, which did not exist | File now exists and runs every subsystem's `init()` |
| `Error: pull model manifest: file does not exist` | Modelfiles used `FROM minicpm5:2b`, a tag that 404s in the registry | Base is now `openbmb/minicpm5-2b`; override with `BASE_MODEL=…` |
| `extension "vector" is not available` (migrate fails, serve boots anyway with `retriever init failed`) | `DATABASE_URL` fell through to its default `localhost:5432` — that Postgres has no pgvector | Set `DATABASE_URL` (§3.2), preferably in `.env`, and restart: check the `db:` line in the boot log |
| `getaddrinfo ENOTFOUND base` (migrate or serve) | You pasted a `…` placeholder as a real value: `DATABASE_URL=… npm run …` — `pg` reads it as host `base`, and an inline prefix beats `.env` | Drop the inline prefix; the URL already lives in `.env` (§3.2). Confirm via the boot log's `db:` line |
| `bind: address already in use` on 5432/6379 | Host services occupy the compose ports | Reuse them (§3.2) — don't start the compose data services |
| `ERROR Raw mode is not supported on the current process.stdin` | TUI (`npm start`) needs a TTY | Expected in CI/pipes; run in a real terminal |
| `intent_distribution` ≈ 90% `UNKNOWN` | Router model missing or prompts drifted | Local: check `supervisor:seed-models` output, then §3.2 of the runbook. Cloud: verify the model name is valid for your provider (e.g. `gpt-4o-mini`, `claude-3-5-haiku-20241022`) |
| Boot warns `retriever init failed` | DB unreachable / no pgvector | Fix `DATABASE_URL` and extensions, restart |
| `OpenAIBackend: OPENAI_API_KEY is required` | `INFERENCE_BACKEND=openai` without a key | Set `OPENAI_API_KEY` in the environment or `.env` |
| `AnthropicBackend: ANTHROPIC_API_KEY is required` | `INFERENCE_BACKEND=anthropic` without a key | Set `ANTHROPIC_API_KEY` |
| `GeminiBackend: GEMINI_API_KEY is required` | `INFERENCE_BACKEND=gemini` without a key | Set `GEMINI_API_KEY` |
| `retrievalMode: 'keyword-only'` on `/v1/healthz` | Embedder not wired or unhealthy | Local: `ollama pull $EMBEDDING_MODEL`. Cloud: set `EMBEDDING_PROVIDER=openai` + `EMBEDDING_OPENAI_API_KEY` |
| Run FAILED with `budget exceeded` in errorTrace | The cumulative USD spend crossed `BUDGET_MAX_COST_USD_*` | Raise the cap or switch to a cheaper model (`TASK_MODEL_*` per task type) |

## 10. Main-CLI integration

The supervisor is also reachable from the main `agent-tui` CLI (no separate
process needed for read-only inspection):

```bash
agent-tui supervisor health           # GET /v1/healthz — shows backend, retrieval mode, cost caps
agent-tui supervisor runs list        # recent runs
agent-tui supervisor runs show <id>   # one run's state + steps
agent-tui supervisor goals list      # goal chains with task statuses
agent-tui supervisor goals show <id>   # one goal's chain + events
```

These commands talk to the running supervisor over HTTP (host/port from
`SUPERVISOR_HTTP_HOST` / `SUPERVISOR_HTTP_PORT`, default `http://127.0.0.1:7480`,
auth from `SUPERVISOR_API_KEY`), so the supervisor must already be up:
`npm run supervisor:serve`.

To **start** the supervisor from the main CLI:

```bash
agent-tui supervisor serve            # same as npm run supervisor:serve
```

## 11. API quick reference

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/runs` | Start a run (`{"objective": "…"}`) |
| GET | `/v1/runs` / `/v1/runs/:id` | List / fetch a run |
| GET | `/v1/runs/:id/events` | Event-sourcing trail |
| GET | `/v1/runs/:id/next` | Next suggested step |
| POST | `/v1/runs/:id/approve` | Approve a high-risk action |
| GET | `/v1/runs/:id/checkpoints` · `/snapshots` | Memory checkpoints / context snapshots |
| POST | `/v1/goals` · `POST /v1/goals/:id/advance` | Goal chains (Phase 1–3) |
| GET | `/v1/metrics` · `/v1/tools` · `/v1/healthz` | Metrics, tool registry, liveness |

Details, payloads and auth: [api.md](api.md).

## 12. Minimal checklists (fresh clone → green)

### Local Ollama (default)

```bash
# 0. Skip if your Postgres IS the default localhost:5432 with pgvector; else:
#    echo 'DATABASE_URL=postgres://user:pass@host:5434/supervisor' >> .env   (§3.2)

npm install                                          # 1. deps resolve
bash supervisor/scripts/seed-models.sh               # 2. four minicpm5-* models exist
npm run supervisor:migrate                           # 3. "schema up to date", 10 tables
npm run supervisor:test                              # 4. green
npm run supervisor:lint && npm run supervisor:typecheck   # 5. 0 errors
npm run supervisor:serve                             # 6. /v1/healthz → ok
curl -sS localhost:7480/v1/runs -H 'content-type: application/json' \
  -d '{"objective":"Summarize these logs:\nERROR db refused"}' | jq   # 7. COMPLETED
```

### Cloud (OpenAI / Anthropic / Gemini / OpenAI-compatible)

```bash
npm install                                          # 1. deps resolve
export INFERENCE_BACKEND=openai                      # 2. pick provider (§4.1)
export OPENAI_API_KEY=sk-...
export MINICPM5_ROUTER_MODEL=gpt-4o-mini
export MINICPM5_ANALYST_MODEL=gpt-4o
export EMBEDDING_PROVIDER=openai                     # 3. hybrid retrieval
export EMBEDDING_MODEL=text-embedding-3-small
export EMBEDDING_DIMENSION=1536
export BUDGET_MAX_COST_USD_PER_RUN=1.0               # 4. cost guardrail (§4.3)
npm run supervisor:migrate                           # 5. schema
npm run supervisor:serve                             # 6. /v1/healthz → ok + retrievalMode: hybrid
curl -sS localhost:7480/v1/runs -H 'content-type: application/json' \
  -d '{"objective":"Summarize these logs:\nERROR db refused"}' | jq   # 7. COMPLETED
```

Sanity checks: step 5 prints `schema up to date` (not `extension "vector" is not
available`), and the boot log in step 6 shows the DB you expect in its `db:` line
with no `retriever init failed` warning. `/v1/healthz` should report
`retrievalMode: "hybrid"` and your configured `costBudget`.
