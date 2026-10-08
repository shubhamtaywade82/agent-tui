# ADR-0005 — Vector DB + External Memory Module

## Status
Accepted — 2026-10-08

## Context
The uploaded design guide ("Part 1 — Best Practices for Vector Database
Integration with MiniCPM5-2B" and "Part 2 — Designing an External Memory
Module for Long-Context State Management") specifies 31 concrete
recommendations across 14 + 17 sections. The initial PR (#3) implemented
the 20-section reference architecture but did not address every
recommendation in the design guide. This ADR documents the gap closure.

## Decision
Extend the supervisor with the following modules and behaviours to close
every gap identified in the design guide:

### Part 1 (Vector DB integration)
1. **§4 Structure-aware chunking** — `HybridRetriever.ingest()` now
   accepts `ChunkMetadata` with `documentId`, `chunkIndex`,
   `sectionPath`, `tokenCount`. The `CodeIndexer` already chunks on
   symbol boundaries; document indexers should follow the same pattern.
2. **§5 Rich metadata** — the `chunks` table has first-class columns for
   `workspace_id`, `tenant_id`, `owner_id`, `source_hash`,
   `document_type`, `language`, `section_path`,
   `embedding_model_version`, `quality_score`, `deprecated`. JSONB
   `metadata` holds extras.
3. **§6 Full hybrid pipeline** — query → metadata filter construction →
   vector retrieval → keyword retrieval → **Reciprocal Rank Fusion**
   → permission filtering → reranking → deduplication → top-k.
4. **§7 Weighted reranker** — `0.55*semantic + 0.20*keyword +
   0.10*recency + 0.10*source_authority + 0.05*quality`. Source
   authority: policy=1.0, runbook=0.9, code=0.7, memory=0.6,
   ticket=0.4, log=0.3. Recency: exponential decay, 90-day half-life.
5. **§8 Retrieval as a validated tool** — `retrieve_knowledge` tool
   registered with zod schema (query ≤512 chars, top_k 1..20), gated
   by `workspace.read` permission.
6. **§9 Grounded prompt** — `ContextBuilder` wraps each chunk in
   `[EVIDENCE-N source="..." section="..." score=...]...[/EVIDENCE-N]`
   tags. Output schema requires `answer`, `citations`, `confidence`,
   `insufficient_evidence`.
7. **§10 Token budget formula** — `max_prompt_tokens = max_model_len -
   max_generation_tokens - safety_margin`. `ContextBudget` interface
   carries `total`, `reserve`, `safetyMargin`, `usable`.
8. **§11 4-layer cache** — `CacheService` (prompt prefix + generation)
   + `HybridRetriever` (embedding + retrieval). TTLs: operational=60s,
   code=600s, default=300s. Index version in cache key for reindex
   invalidation.
9. **§12 Tenant isolation** — `RetrievalFilters` carries `tenantId`,
   `workspaceId`, `userId`, `aclContains`. `applyAclFilter()` enforces
   chunk-level ACLs before any result reaches the model.
10. **§13 Separate retrieval + generation metrics** —
    `MetricsCollector.recordRetrievalEval()` (recall@k, precision@k,
    MRR, nDCG, ACL leakage, cache hit) and `recordGenerationEval()`
    (groundedness, citation accuracy, hallucination, schema validity).

### Part 2 (External memory module)
11. **§3 Memory service API** — `write`, `read`, `get`, `update`,
    `delete`, `consolidateRun`, `createCheckpoint`, `getLatestCheckpoint`,
    `saveContextSnapshot`, `listContextSnapshots`, `sweepExpired`,
    `decayImportance`.
12. **§4.1 Full memory_items schema** — `tenant_id`, `user_id`,
    `project_id`, `memory_type` (10-value allowlist), `summary`,
    `importance`, `status` (active/superseded/archived/expired),
    `source_run_id`, `source_step_id`, `source_document_id`,
    `superseded_by`, `acl` JSONB, `metadata` JSONB, `token_count`,
    `expires_at`.
13. **§4.5 Context snapshots** — `context_snapshots` table with
    `prompt_hash`, `included_memory_ids[]`, `included_chunk_ids[]`,
    `excluded_chunk_ids[]`. Saved automatically by the engine after
    every analyst invocation.
14. **§6 Selective read path** — namespace + filters → recent →
    important → semantic → merge/dedup → ACL + expiration → rerank
    (importance + recency) → compress.
15. **§7 Context compaction** — `ContextBuilder` accepts a
    `runSummary`; when present, replaces raw conversation history with
    the summary. Oversized sections truncated in §10 priority order.
16. **§8 Checkpoints** — `checkpoints` table + `createCheckpoint` /
    `getLatestCheckpoint` API. Engine creates a checkpoint after every
    VALIDATE step for crash recovery.
17. **§10 Memory consolidation** — `consolidateRun()` summarises a
    completed run into an `episode_summary` memory. Engine calls it
    automatically on run completion when a projectId is set.
18. **§11 Forgetting** — TTL expiration (`sweepExpired`), importance
    decay (`decayImportance`), supersession (write with
    `supersedeMemoryId` marks old record `superseded` + sets
    `superseded_by`).
19. **§12 Memory security** — secret scanning (6 patterns: ghp_, sk-,
    AKIA, PEM, Bearer, postgres connection string) blocks writes. PII
    patterns (SSN, email, phone) logged as warnings. Right-to-delete
    via `delete()` which sets status to `archived`.
20. **§13 Memory tools** — `memory_search` and `memory_write` tools
    registered with zod schemas. `memory_write` gated by
    `workspace.write` permission + medium risk level. Validates:
    namespace, memory_type allowlist, content length (≤16 KiB),
    importance bounds, duplicate content hash, PII/secrets.
21. **§14 Runtime loop** — engine step 12 (summarise history if context
    exceeds threshold) handled by `ContextBuilder` compaction; step 13
    (write durable memory only if criteria met) handled by
    `consolidateRun` which respects the §5 importance threshold.

## Consequences
- **Positive:** every recommendation in the design guide now has a
  concrete code path. The golden eval suite can assert against the new
  metrics. The context_snapshots table makes every prompt auditable.
- **Positive:** crash recovery is real — a crashed run can be resumed
  from its last checkpoint via `getLatestCheckpoint`.
- **Negative:** the chunks table has more columns (slightly wider rows).
  Mitigated by partial indexes (`WHERE deprecated = false`) and the
  retrieval cache.
- **Trade-off:** the reranker is a deterministic heuristic, not a
  cross-encoder. The `RerankWeights` interface is the contract for
  swapping in a learned reranker later.
