# MiniCPM5 Supervisor — Runbook

Operational playbook for the supervisor service. §17 (Recommended
Infrastructure Stack) and §15 (Observability and Evaluation) underpin
every procedure here.

## 1. Boot sequence

```bash
# 1. Data services + sandbox + supervisor (full stack)
docker compose --profile full up -d

# 2. Wait for postgres to be healthy
docker compose exec postgres pg_isready -U supervisor

# 3. Seed the four MiniCPM5 sub-agent models (idempotent)
OLLAMA_HOST=http://localhost:11434 bash supervisor/scripts/seed-models.sh

# 4. Apply SQL migrations (the supervisor also runs CREATE TABLE IF NOT
#    EXISTS on boot, so this is only needed for clean databases)
npm run supervisor:migrate

# 5. Start the HTTP API
npm run supervisor:serve
```

## 2. Healthchecks

| Probe          | Command                                                        |
| -------------- | -------------------------------------------------------------- |
| HTTP liveness  | `curl -fsS http://localhost:7480/v1/healthz`                   |
| Postgres       | `docker compose exec postgres pg_isready -U supervisor`        |
| Redis          | `docker compose exec redis redis-cli ping`                    |
| MinIO          | `curl -fsS http://localhost:9000/minio/health/live`            |
| Ollama         | `curl -fsS http://localhost:11434/api/tags`                    |
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

1. Check the router Modelfile (`supervisor/modelfiles/router.Modelfile`).
   The system prompt is the contract — has it drifted?
2. Run the golden eval suite:
   ```bash
   INFERENCE_BACKEND=mock npm run supervisor:evals
   ```
3. If the evals pass but production still misroutes, the model is fine
   but the prompts in production are out of distribution. Add a few
   few-shot examples to the router Modelfile.

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
- **Ollama models**: stored in the `ollama-models` volume; the Modelfiles
  are in git, so a rebuild from `seed-models.sh` is sufficient.
