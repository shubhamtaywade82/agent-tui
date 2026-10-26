# ADR 0006: Three-model residency pool

**Status:** Proposed
**Date:** 2026-10-26
**Depends on:** ADR 0004 (model routing), PR #31 (P0 orchestration correctness)

## Context

The user's design specifies that **at most three MiniCPM5-2B variants
should be resident in Ollama at any time**, with the harness deciding
which of the three is active for the current step. This addresses two
real constraints:

1. **VRAM is finite.** Each MiniCPM5-2B variant occupies ~2 GB at Q4
   quantization. On a 6 GB consumer GPU, three variants resident leaves
   no headroom for the context window; loading a fourth silently
   pushes the oldest model to system RAM and tanks inference latency.
2. **Ollama does not enforce a global cap.** `keep_alive` controls
   *how long* a model stays resident after its last use, but nothing
   in the daemon limits *how many* models may be resident
   simultaneously. Without application-level enforcement, an agent
   that requests four variants in quick succession will end up with
   all four loaded.

The repository's existing `OllamaBackend` calls `client.chat()` directly
with no residency awareness. A router that proposes `minicpm5-summarizer`
after a run that used `minicpm5-router`, `minicpm5-toolagent`, and
`minicpm5-analyst` would silently load a fourth variant.

## Decision

Introduce a `ModelPool` service that wraps the `OllamaBackend`. Every
`invoke()` call goes through `pool.acquire(model)` first and
`handle.release()` in a `finally` block. The pool enforces the
configured `maxResident` cap (default 3) by:

- **Polling `/api/ps`** to maintain a residency cache of currently-loaded
  models.
- **Pinning models during active inference.** A pinned model cannot be
  evicted — this prevents a concurrent `acquire()` for a different
  model from yanking the model out from under an in-flight request.
- **LRU eviction** of the non-pinned resident whose `expires_at` is
  soonest, when the pool is at capacity and a new model is requested.
- **Failing loudly** with `ModelPoolExhaustedError` when every resident
  is pinned at capacity. The pool never silently exceeds the cap;
  the caller (the engine) decides whether to retry, queue, or fail.
- **Allowlist filtering** so non-managed models (the cloud fallback,
  for example) pass through `acquire()` as a no-op and do not count
  toward the cap.
- **A serialising mutex** so concurrent `acquire()` calls cannot race
  past the cap by both observing an under-capacity state and both
  loading a model.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MODEL_POOL_MAX_RESIDENT` | `3` | Hard upper bound on resident managed models |
| `MODEL_POOL_KEEP_ALIVE_MS` | `300000` (5 min) | Ollama `keep_alive` after load |
| `MODEL_POOL_ALLOWLIST` | (empty — pool disabled) | Comma-separated model names the pool manages |
| `MODEL_POOL_ALWAYS_REFRESH` | `false` | Poll `/api/ps` on every `acquire()` (tests only) |

When the allowlist is empty, the pool is a no-op: every model passes
through `acquire()` and the `OllamaBackend` behaves exactly as before.
This is the default so existing deployments do not change behaviour
until the operator opts in.

### Ollama API usage

- `GET /api/ps` — list currently-loaded models with `expires_at`
  timestamps. Used to refresh the residency cache.
- `POST /api/generate { keep_alive: 0 }` — immediately unload a model.
  Used for eviction.
- `POST /api/generate { prompt: "", keep_alive: N }` — load a model
  into VRAM without generating anything. The `keep_alive` value
  controls how long Ollama holds the model after the (empty) response.

## Limitations

1. **No global enforcement.** The pool cannot prevent other
   applications from loading models into the same Ollama server. To
   enforce the cap reliably, route all model-loading traffic through
   agent-tui or give it a dedicated Ollama instance.
2. **No VRAM accounting.** `maxResident` is a count, not a byte
   budget. Three variants fit on a 6 GB GPU; four may not. Operators
   must size `maxResident` to their hardware.
3. **Eventually consistent cache.** With `MODEL_POOL_ALWAYS_REFRESH=false`
   (the production default), the pool trusts its in-memory view between
   `init()` and explicit `reconcile()` calls. A model evicted externally
   will appear resident to the pool until the next refresh. The
   wrapping `Backend` recovers gracefully — the next `invoke()` call
   against the missing model will trigger an Ollama-side reload — but
   the latency blip is observable.
4. **Single-process.** The pool's mutex is in-process. Multiple
   agent-tui instances sharing one Ollama server will not coordinate;
   each maintains its own view. For multi-process deployments, use a
   dedicated Ollama instance per process or accept the cap may be
   briefly exceeded during handoff.

## Alternatives considered

- **Ollama `OLLAMA_MAX_LOADED_MODELS` env var.** Documented but
  daemon-wide, not per-application. Useful as a defence-in-depth
  setting but not a substitute for application-level enforcement.
- **Sequential model use only.** Disable concurrency entirely so only
  one variant is ever resident. Too restrictive — the router and
  analyst variants are small enough to coexist, and serializing them
  would roughly double latency on every multi-step run.
- **Cloud-only escalation.** Skip the local pool by routing every
  request to a stronger cloud model. Rejects the user's explicit
  "at most three local variants" design constraint.

## Consequences

- `OllamaBackend` is wrapped in `PooledOllamaBackend` whenever the
  allowlist is non-empty. The engine and the rest of the system see
  no difference — same `Backend` interface.
- `acquire()` adds one `/api/ps` round-trip per inference call when
  `MODEL_POOL_ALWAYS_REFRESH=true`. Production defaults to `false`
  to avoid the overhead; tests use `true` for determinism.
- A model load takes ~1–3 seconds on consumer hardware. The first
  `acquire()` of each variant pays this cost; subsequent acquires
  within the `keep_alive` window are fast-path.
