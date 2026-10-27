# ADR 0008: Real embedding provider for hybrid retrieval

**Status:** Proposed
**Date:** 2026-10-26
**Depends on:** ADR 0005 (vector DB and external memory), PR #31 (P0
orchestration correctness — `num_ctx` / `num_predict` split)

## Context

The hybrid retriever (`src/supervisor/context/retrieval.ts`) supports
both pgvector semantic search and PostgreSQL full-text search (TSV).
Results are merged via Reciprocal Rank Fusion. **But** the wiring in
`main.ts` passed `embedFn: undefined` to
`registerRetrievalAndMemoryTools`, which meant:

- The `retrieve_knowledge` tool called `retriever.retrieve()` without
  a `queryEmbedding` — the vector branch was skipped.
- The retriever silently fell back to keyword-only search.
- No health signal surfaced this degradation.

This was the biggest remaining functional gap called out by the
implementation spec: *"Without a supplied query embedding, the
retriever uses full-text search only."* A system that advertised
"hybrid retrieval" while only doing keyword search was not honest.

## Decision

Introduce an `OllamaEmbedder` that wraps Ollama's `/api/embed`
endpoint to produce query embeddings at retrieve time and chunk
embeddings at ingest time. Wire it into `main.ts` so the
`retrieve_knowledge` tool calls `embedAndRetrieve` → vector + FTS
when an embedder is available, and degrades to FTS-only when not —
with the degradation now visible on `GET /v1/healthz`.

### New module

- `src/supervisor/inference/embedder.ts` — `OllamaEmbedder`. Contract:
  - `embed(text)` returns a `number[]` of length `config.embedding.dimension`.
  - `embedBatch(texts[])` batches up to `config.embedding.batchSize`
    texts per `/api/embed` call. Larger batches are split.
  - On dimension mismatch (the model returned N≠expected dims),
    throws `EmbeddingDimensionMismatchError` — silently storing
    1024-dim vectors in a 768-dim column would corrupt the pgvector
    index.
  - On transport error, throws `EmbeddingTransportError`.
  - `health()` verifies the model is reachable and produces vectors
    of the expected dimension. Called by `main.ts` on boot.

### Configuration

New env vars:

| Var | Default | Purpose |
|---|---|---|
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model name |
| `EMBEDDING_DIMENSION` | `768` | Vector dimension; must match model output AND the chunks table schema |
| `EMBEDDING_BATCH_SIZE` | `32` | Max texts per `/api/embed` call |
| `EMBEDDING_TRUNCATE` | `true` | Truncate over-long inputs |
| `EMBEDDING_MODEL_VERSION` | `nomic-embed-text-v1` | Stable version label stored on each chunk at ingest time |

Common alternatives:

- `nomic-embed-text` — 768-dim, lightweight, the default. Matches the
  existing `vector(768)` chunks schema.
- `bge-m3` — 1024-dim, multilingual, higher quality but slower. Requires
  `EMBEDDING_DIMENSION=1024` and re-creating the chunks table.
- `mxbai-embed-large` — 1024-dim, top of the MTEB leaderboard for small
  models. Same constraint as `bge-m3`.

### Retriever changes

- `HybridRetrieverDeps` gains an optional `vectorDimension` (defaults
  to `config.embedding.dimension`). The chunks table DDL now uses
  `vector(${this.vectorDimension})` instead of the hardcoded
  `vector(768)`.
- `init()` validates the live schema's vector dimension against the
  configured one by querying `pg_attribute.atttypmod`. On mismatch,
  logs a warning but does NOT auto-migrate — the operator must drop
  and recreate the table explicitly. Silently re-creating would lose
  ingested data.
- `retrievalMode` getter reports `'hybrid'` when an embedder is wired,
  `'keyword-only'` otherwise. Surfaced on `GET /v1/healthz`.

### Wiring

`main.ts`:

1. Constructs `HybridRetriever({ vectorDimension: config.embedding.dimension })`.
2. When `INFERENCE_BACKEND=ollama`, constructs `OllamaEmbedder` and runs
   its `health()` check.
3. If the health check passes, passes `embedFn: (text) => embedder.embed(text)`
   to `registerRetrievalAndMemoryTools` and sets `retrievalMode: 'hybrid'`
   on the server.
4. If the health check fails (model not pulled, Ollama down), logs a
   warning with the `ollama pull` command and proceeds with
   `retrievalMode: 'keyword-only'` — the system stays usable.
5. Mock and vLLM backends skip the embedder entirely (no `/api/embed`
   endpoint).

### Health endpoint

`GET /v1/healthz` now returns:

```json
{ "ok": true, "ts": "...", "retrievalMode": "hybrid" }
```

or `"keyword-only"` when the embedder isn't wired. This is the honest
signal the spec demanded: a system that advertised hybrid retrieval
while doing keyword-only search was the failure mode this PR closes.

## Limitations

1. **Dimension change requires table re-creation.** Switching from
   `nomic-embed-text` (768) to `bge-m3` (1024) requires `DROP TABLE
   chunks` and re-ingesting all content. The retriever detects the
   mismatch and warns, but does not auto-migrate (data loss).
2. **No re-indexing on model swap.** When `EMBEDDING_MODEL_VERSION`
   changes, old chunks carry the old version label. The retriever
   does not yet filter by version — a follow-up could add a
   `embeddingModelVersion` filter to `RetrievalFilters` so queries
   only match chunks from the current embedder.
3. **Single Ollama instance.** The embedder shares the configured
   `OLLAMA_HOST` with the chat backend. A large embedding batch
   competes with chat requests for VRAM.
4. **No cross-encoder reranking.** The existing reranker is a
   weighted deterministic scorer, not a cross-encoder. The embedder
   improves the vector-retrieval step; reranking is unchanged.

## Alternatives considered

- **Cloud embedding API (OpenAI, Cohere).** Would require an API
  key, network egress, and per-call cost. Rejected for the local-first
  design — the user explicitly wants at most three local MiniCPM5
  variants, and a cloud embedder would violate that posture. Could be
  added as a config option later for deployments that prefer it.
- **In-process embedder (transformers.js, onnxruntime).** Would avoid
  the Ollama round-trip but adds a native dependency and a model
  download step. Ollama already manages model storage and VRAM; using
  it for embeddings too keeps one model-serving path.
- **Skip the dimension validation.** Rejected — silently storing
  wrong-dimension vectors would corrupt the pgvector index and
  produce garbage results. The dimension check is a correctness
  invariant, not a nicety.

## Consequences

- `main.ts` now constructs an `OllamaEmbedder` on boot when
  `INFERENCE_BACKEND=ollama`. The boot sequence includes a health
  check that hits `/api/embed` once; a failed model pull is logged
  with the `ollama pull` command.
- `GET /v1/healthz` gains a `retrievalMode` field. Existing health
  checks that asserted `{ ok: true, ts: ... }` continue to pass
  (the new field is additive).
- The `retrieve_knowledge` tool now produces vector-grounded results
  when an embedder is wired, instead of keyword-only. Existing tests
  that asserted keyword-only results are unaffected (the MockBackend
  path doesn't construct an embedder).
- The first embed call after boot pays the model-load cost (~1–3s
  on consumer hardware). Subsequent calls within the `keep_alive`
  window are fast-path.
