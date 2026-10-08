# CI/CD Required Checks

This document defines the required status checks for the `main` branch
and the workflow files that implement them.

## Required Status Checks

Configure in **Settings → Branches → Branch protection rules → main**:

| Check | Workflow File | Trigger |
|-------|---------------|---------|
| Lint + Typecheck | `.github/workflows/ci-supervisor.yml` | push + PR |
| Modelfile Validation | `.github/workflows/ci-supervisor.yml` + `.github/workflows/modelfiles.yml` | push + PR |
| Unit Tests | `.github/workflows/ci-supervisor.yml` | push + PR |
| Integration Tests (Postgres + pgvector) | `.github/workflows/ci-supervisor.yml` | push + PR |
| Docker Build Smoke Test | `.github/workflows/ci-supervisor.yml` + `.github/workflows/docker.yml` | push + PR |
| Invariant Verification (I1-I8) | `.github/workflows/ci-supervisor.yml` | push + PR |

## Branch Protection Settings

Enable on `main`:

- [x] Require a pull request before merging
  - Required approvals: **1**
  - Dismiss stale approvals on new push: **yes**
  - Require review from code owners: **yes**
- [x] Require status checks to pass before merging
  - Require branches to be up to date before merging: **yes**
  - Select all 6 checks from the table above
- [x] Require conversation resolution before merging
- [x] Require linear history: **yes**
- [x] Do not allow bypassing the above settings

## Workflow Overview

### `.github/workflows/ci-supervisor.yml`
The main CI pipeline. Runs on every push to `main`/`feat/**` and every
PR to `main`. Contains 6 jobs:

1. **lint-typecheck** — `biome check` + `tsc --noEmit`
2. **modelfile-validation** — verifies FROM base, temperature, num_ctx,
   stop sequences, SYSTEM prompts for all 4 Modelfiles
3. **unit-tests** — `vitest run` for unit + evals with `INFERENCE_BACKEND=mock`
4. **integration-tests** — `vitest run` for integration tests against a
   pgvector/pg16 Postgres service container
5. **docker-build** — builds both Docker images + smoke tests them
6. **invariant-check** — verifies all 8 audit invariants (I1-I8) via grep

### `.github/workflows/modelfiles.yml`
Lightweight (≤ 30s) Modelfile-only validation. Runs independently when
any file under `supervisor/modelfiles/` changes. Posts a summary table
to the GitHub Actions run page.

### `.github/workflows/docker.yml`
Builds and pushes both Docker images to `ghcr.io` on push to `main`.
On PRs, builds but does not push (smoke test only). Includes a
`compose-up` job that starts the data services (postgres, redis, minio,
ollama) and verifies they're healthy.

### `.github/workflows/release.yml`
Triggered by `git tag v*`. Builds the TypeScript dist, runs tests,
pushes Docker images with semver tags, and creates a GitHub Release
with the built artifacts.

### `.github/workflows/branch-protection.yml`
Verifies that all required workflow files + jobs exist. Posts a summary
of the required checks to configure in branch protection settings. Does
NOT modify branch protection rules (that's a manual admin step).

## Secrets Required

| Secret | Used By | Purpose |
|--------|---------|---------|
| `GITHUB_TOKEN` | docker.yml, release.yml | Auto-provided by GitHub Actions; used to push to ghcr.io |

No additional secrets are required. The `GITHUB_TOKEN` is automatically
available in all workflows with `permissions: packages: write`.

## Local CI Verification

Before pushing, verify the CI checks pass locally:

```bash
# Lint + typecheck
npx biome check src/supervisor test/supervisor
npx tsc --noEmit

# Unit + eval tests
INFERENCE_BACKEND=mock npx vitest run test/supervisor/unit test/supervisor/evals

# Modelfile validation (same grep checks as CI)
grep -c "PARAMETER stop" supervisor/modelfiles/*.Modelfile
grep "temperature" supervisor/modelfiles/*.Modelfile

# Invariant verification
grep -qE 'import.*(HybridRetriever|SandboxExecutor|PgStateStore|OllamaBackend)' src/supervisor/engine.ts && echo "I1 FAIL" || echo "I1 PASS"
grep "\.readonly()" src/supervisor/state/models.ts | wc -l  # should be 5

# Docker build
docker build -f Dockerfile.supervisor -t minicpm5-supervisor:ci .
docker build -f Dockerfile.sandbox -t supervisor-sandbox:ci .
```
