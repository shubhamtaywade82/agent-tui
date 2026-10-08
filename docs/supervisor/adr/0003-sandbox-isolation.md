# ADR-0003 — Sandbox isolation

## Status
Accepted — 2026-10-08

## Context
§11 requires every terminal command produced by the agent to run inside
a container with: read-only root FS, writable /workspace overlay, CPU +
memory limits, network egress controls, execution timeout, and audit
logging. The MiniCPM5 review explicitly calls out that the model is
weaker on long-horizon terminal work (Terminal-Bench v2.1 score 8.6) —
sandboxing reduces the cost of model mistakes.

## Decision
- Use `dockerode` to spawn each command in a fresh container.
- Base image: `Dockerfile.sandbox` — slim Node image with ripgrep,
  pytest, ruff, biome, tsc pre-installed. No curl|bash pipeline tools.
- Each container runs with `ReadonlyRootfs: true`, `AutoRemove: true`,
  tmpfs at `/tmp`, explicit CPU/memory limits from config.
- Network: `supervisor-net` (compose network). Egress filtering is done
  at the Docker network level in production.
- `CommandPolicy` enforces an allowlist/denylist on the command string
  BEFORE the container is created. Denylist always wins.
- All commands run with a per-call timeout. On timeout, the container is
  SIGKILLed and the supervisor records a `tool_executed` event with
  status `TIMEOUT`.

## Consequences
- **Positive:** model mistakes (rm -rf, curl|bash, sudo, kubectl delete)
  are blocked before any container is spawned; even allowed commands
  cannot escape the read-only FS or the CPU/memory limits.
- **Negative:** requires Docker access on the supervisor host (we mount
  `/var/run/docker.sock`). In high-security deployments this should be
  replaced with gVisor or Firecracker — same `SandboxExecutor` interface.
- **Operational:** the sandbox image must be built before the supervisor
  is started. `docker compose --profile full up` handles this.
