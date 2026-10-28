# Agentic Supervisor — Runbook

Operational playbook for the supervisor service. §17 (Recommended
Infrastructure Stack) and §15 (Observability and Evaluation) underpin
every procedure here. The supervisor supports **five inference
providers** (Ollama, vLLM/OpenAI-compatible, OpenAI, Anthropic, Gemini —
see ADR 0009); provider-specific steps are called out below.

## 1. Boot sequence

### 1a. Local Ollama backend (default)

```bash
# 1. Data services + sandbox + supervisor (full stack)
docker compose --profile full up -d

# 2. Wait for postgres to be healthy
docker compose exec postgres pg_isready -U supervisor

# 3. Seed the four MiniCPM5 sub-agent models (idempotent — local backend only)
OLLAMA_HOST=http://localhost:11434 bash supervisor/scripts/seed-models.sh

# 4. Apply SQL migrations (the supervisor also runs CREATE TABLE IF NOT
#    EXISTS on boot, so this is only needed for clean databases)
npm run supervisor:migrate

# 5. Start the HTTP API
npm run supervisor:serve
```

### 1b. Cloud backend (OpenAI / Anthropic / Gemini / OpenAI-compatible)

```bash
# 1. Data services (no Ollama needed — just Postgres + Redis + sandbox)
docker compose up -d postgres redis sandbox

# 2. Point at your provider + set cost guardrails (ADR 0012)
cat >> .env <<'EOF'
INFERENCE_BACKEND=openai
OPENAI_API_KEY=sk-...
MINICPM5_ROUTER_MODEL=gpt-4o-mini
MINICPM5_ANALYST_MODEL=gpt-4o
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536
BUDGET_MAX_COST_USD_PER_RUN=1.0
BUDGET_MAX_COST_USD_PER_GOAL=10.0
EOF

# 3. Migrations
npm run supervisor:migrate

# 4. Start the HTTP API
npm run supervisor:serve
```

Verify `/v1/healthz` reports `retrievalMode: "hybrid"` and the cost caps
you configured — see §2 below.

## 2. Healthchecks

| Probe          | Command                                                        |
| -------------- | -------------------------------------------------------------- |
| HTTP liveness  | `curl -fsS http://localhost:7480/v1/healthz` — also reports `retrievalMode` and `costBudget` |
| Postgres       | `docker compose exec postgres pg_isready -U supervisor`        |
| Redis          | `docker compose exec redis redis-cli ping`                    |
| MinIO          | `curl -fsS http://localhost:9000/minio/health/live`            |
| Ollama (local backend only) | `curl -fsS http://localhost:11434/api/tags`          |
| Cloud provider (cloud backends) | `curl -fsS http://localhost:7480/v1/healthz` reports the backend's health via the boot log; the OpenAI/Anthropic/Gemini SDKs also expose `health()` internally |
| Sandbox image  | `docker images supervisor-sandbox:latest`                     |

## 3. Common incidents

### 3.1 Run stuck in `EXECUTING` forever

1. `GET /v1/runs/:id/events` — find the last `tool_call_proposed` event.
2. Check the tool name. If it's a sandbox call, the sandbox container
   may be hung.
3. `docker ps | grep supervisor-sandbox` — find the stuck container.
4. `docker kill <id>` (the supervisor's `AutoRemove: true` cleans up).
5. The supervisor will time out and record a `tool_executed` event
   with status `TIMEOUT`. The run will transition to `RETRYING` or
   `FAILED` automatically.
6. If the run is truly stuck (no timeout fired), force-transition via
   `psql`:
   ```sql
   UPDATE runs SET status='FAILED', updated_at=now() WHERE run_id='<id>';
   ```

### 3.2 Router keeps misclassifying

Symptom: `intent_distribution` metrics show 90%+ `UNKNOWN`.

1. Check the router model's prompt contract:
   - **Local Ollama backend**: the Modelfile at
     `supervisor/modelfiles/router.Modelfile` is the system prompt — has it
     drifted?
   - **Cloud / vLLM backends**: the supervisor constructs the prompt in
     code (`RouterClassifier`); check `src/supervisor/router/classifier.ts`.
   - **Model name**: verify the router model name is valid for your
     provider (`gpt-4o-mini`, `claude-3-5-haiku-20241022`, `gemini-2.0-flash`…).
2. Run the golden eval suite:
   ```bash
   INFERENCE_BACKEND=mock npm run supervisor:evals
   ```
3. If the evals pass but production still misroutes, the model is fine
   but the prompts in production are out of distribution. Add a few
   few-shot examples to the router prompt (Modelfile for Ollama;
   `classifier.ts` for cloud).

### 3.2b Cost budget tripped (cloud backends)

Symptom: runs FAIL with `budget exceeded` in `errorTrace`.

1. Check cumulative spend: the `model_invoked` event payload carries
   `costUsd` (cumulative per run). `GET /v1/healthz` reports the caps.
2. Find the most expensive task types:
   ```sql
   SELECT jsonb_array_elements(steps)->>'modelName' AS model, count(*),
          sum((jsonb_array_elements(steps)->'output'->>'tokens'->>'completion')::int) AS completion_tokens
     FROM runs GROUP BY 1 ORDER BY 3 DESC LIMIT 20;
   ```
3. Mitigate: raise `BUDGET_MAX_COST_USD_*`, or switch hot task types to a
   cheaper model via `TASK_MODEL_*` overrides (ADR 0010) — e.g.
   `TASK_MODEL_RETRIEVE=gpt-4o-mini` while keeping
   `TASK_MODEL_CODE_CHANGE=claude-3-5-sonnet-20241022`.

### 3.3 Sandbox denials spike

Symptom: `toolCallsDenied` metric jumps.

1. Check the denylist in `src/supervisor/sandbox/policy.ts`.
2. Identify the most-recently-denied commands:
   ```sql
   SELECT tool_name, error, count(*)
     FROM tool_calls
    WHERE execution_status = 'DENIED'
    GROUP BY tool_name, error
    ORDER BY count DESC LIMIT 20;
   ```
3. If a legitimate command is being denied, add it to `DEFAULT_ALLOWLIST`
   in `policy.ts`. Otherwise, fix the upstream tool agent prompt that's
   producing the bad command.

### 3.4 Postgres out of disk

The `events` and `steps` tables grow fast. Retention policy:

```sql
-- Keep 30 days of events
DELETE FROM events WHERE occurred_at < now() - interval '30 days';
-- Keep 90 days of completed runs
DELETE FROM runs WHERE status IN ('COMPLETED','FAILED','CANCELLED')
  AND updated_at < now() - interval '90 days';
```

Automate this via a cron worker or pg_cron extension.

## 4. Adding a new tool

1. Register it in `src/supervisor/main.ts` (or a dedicated `tools.ts`):
   ```ts
   supervisor.registry.register({
     name: 'get_pipeline_status',
     description: 'Check the status of a CI/CD pipeline.',
     parametersSchema: z.object({ service: z.string() }),
     permissions: ['workspace.read'],
     riskLevel: 'low',
     timeoutMs: 10_000,
     execute: async (args) => {
       const r = await fetch(`https://ci.internal/api/${args.service}/status`);
       return { ok: r.ok, output: await r.text() };
     },
   });
   ```
2. Restart the supervisor.
3. Verify it appears in `GET /v1/tools`.
4. Add a golden task to `src/supervisor/evals/golden.ts` covering it.

## 5. Rotating secrets

Secrets are resolved via `SecretResolver` (§16.2) — never baked into
images. To rotate:

1. Update the env var or external secret manager.
2. `POST /v1/admin/secrets/refresh` (TODO) or restart the supervisor.
   `SecretResolver.clearCache()` is called on boot.
3. Verify with a tool call that uses the secret reference.

## 6. Backups

- **Postgres**: `pg_dump` daily, retained 14 days.
- **MinIO**: bucket versioning + cross-region replication.
- **Ollama models (local backend only)**: stored in the `ollama-models`
  volume; the Modelfiles are in git, so a rebuild from `seed-models.sh`
  is sufficient.
- **Cloud provider keys**: rotate quarterly via `SecretResolver`; never
  bake keys into images.
- **Cost ledger**: the in-process `CostTracker` ledger is ephemeral — the
  durable record is the `events` table (`model_invoked` payloads carry
  `costUsd`). Include it in the Postgres backup; no separate backup needed.
