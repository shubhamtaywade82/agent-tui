# ADR 0009: Multi-provider inference (OpenAI, Anthropic, Gemini, vLLM, Ollama)

- **Status:** Proposed
- **Date:** 2026-10-27
- **Supersedes:** none
- **Superseded by:** —
- **Related:** ADR 0004 (Model Routing), ADR 0006 (Model Pool), ADR 0008 (Embedding Provider)

## Context

The supervisor was originally built around MiniCPM5-2B variants running on a
local Ollama daemon. ADRs 0004–0008 documented that design: a single local
backend, a model pool that caps the resident variants to three, an Ollama
embedder for hybrid retrieval, and a router variant that classifies intent.

Since then three things have shifted:

1. **Production-grade cloud LLMs are now the cheapest high-quality option for
   many workloads.** A `gpt-4o-mini` router + `claude-3-5-sonnet` analyst is
   both cheaper and stronger than a local MiniCPM5-2B setup for most tasks.
2. **The supervisor's `Backend` interface (6 lines) has held up.** It has
   cleanly absorbed vLLM (any OpenAI-compatible endpoint), the model pool
   wrapper, and the patch workflow without leaking provider-specifics into
   the engine. The interface is provider-agnostic by construction.
3. **The wiring was not.** Only `ollama`, `vllm`, and `mock` were first-class
   `INFERENCE_BACKEND` values. The cloud providers were reachable only by
   pretending to be vLLM (`INFERENCE_BACKEND=vllm` + `VLLM_BASE_URL=` pointing
   at OpenAI's API), which worked but concealed which provider was in use from
   the logs, the config schema, and the health endpoint.

This ADR documents the addition of three first-class cloud backends
(`openai`, `anthropic`, `gemini`) and the corresponding generalisation of
the embedding provider selector.

## Decision

Add three new `Backend` implementations, each wrapping the official SDK:

| Backend | Module | Wire endpoint | SDK |
|---------|--------|---------------|-----|
| `openai` | `src/supervisor/inference/openai.ts` | `POST /v1/chat/completions` | `openai` |
| `anthropic` | `src/supervisor/inference/anthropic.ts` | `POST /v1/messages` | `@anthropic-ai/sdk` |
| `gemini` | `src/supervisor/inference/gemini.ts` | `POST :generateContent` | `@google/genai` |

Each is constructed when `INFERENCE_BACKEND` is set to its name; each
validates its own required env var (e.g. `OPENAI_API_KEY`) at construction
time and throws a clear error if missing.

### Capability matrix

| Capability | `ollama` | `vllm` | `openai` | `anthropic` | `gemini` |
|------------|----------|--------|----------|-------------|----------|
| JSON mode | prompt-level + Ollama `format: 'json'` | `response_format` flag | `response_format` flag | prompt-level + assistant prefill (`{`) | wire-level `responseMimeType: 'application/json'` |
| Generation cap | `num_predict` | `max_tokens` | `max_tokens` | `max_tokens` (required, default 4096) | `maxOutputTokens` |
| Context window | `num_ctx` | derived from served model | derived from deployed model | derived from model (200K for Claude 3.5+) | derived from model (1M for Gemini 1.5+) |
| Think mode | `think: bool` (MiniCPM5-specific) | `chat_template_kwargs.enable_thinking` (vLLM-specific) | ignored (reasoning models reason unconditionally) | `thinking: { type: 'enabled', budget_tokens }` | `thinkingConfig: { thinkingBudget, includeThoughts }` |
| Embeddings | `/api/embed` (via `OllamaEmbedder`) | not exposed | `/v1/embeddings` (via `OpenAIEmbedder`) | not exposed (use a separate embeddings provider) | not exposed (use a separate embeddings provider) |
| Model residency pool | applies when allowlist non-empty | not applicable | not applicable | not applicable | not applicable |
| Health probe | `GET /api/ps` | `GET /v1/models` | `GET /v1/models` | 1-token ping (`POST /v1/messages`) | `GET /v1beta/models` |

### Embedding provider selector

Generalise the Phase 4 embedder wiring from "Ollama-only" to a separate
selector, `EMBEDDING_PROVIDER`, with three values:

- `ollama` — `OllamaEmbedder` against `/api/embed`. Default when
  `INFERENCE_BACKEND=ollama`. Preserves the Phase 4 behaviour.
- `openai` — `OpenAIEmbedder` against `/v1/embeddings`. Works for OpenAI
  (`text-embedding-3-small/large`), Voyage, Cohere, Jina, Nomic, Azure OpenAI,
  Ollama's OpenAI-compat layer, and any self-hosted embeddings service that
  exposes the OpenAI shape.
- `none` — no embedder. The retriever degrades to keyword-only search;
  `/v1/healthz` reports `retrievalMode: 'keyword-only'`.

The embedder is now decoupled from the inference backend: you can run
`INFERENCE_BACKEND=anthropic` (Claude for chat) + `EMBEDDING_PROVIDER=openai`
(OpenAI for embeddings) + `EMBEDDING_OPENAI_API_KEY=...` in the same process.
The two API keys are independent.

### Config schema

Extend `inference.backend` enum: `['ollama', 'vllm', 'openai', 'anthropic', 'gemini', 'mock']`.

Add three provider-specific config blocks:

- `inference.openai` — `{ baseUrl, apiKey, organization, project }`
- `inference.anthropic` — `{ apiKey, version, baseUrl }`
- `inference.gemini` — `{ apiKey, baseUrl }`

Add the `embedding.provider` selector and the `embedding.openaiBaseUrl` /
`embedding.openaiApiKey` overrides (useful when chat and embeddings come from
different OpenAI-compatible providers).

### Wire-shape differences per backend (recorded so future maintainers don't
re-discover them)

- **OpenAI**: `chat.completions.create` accepts `response_format:
  { type: 'json_object' }` for native JSON mode. `max_tokens` is a generation
  cap. The SDK automatically retries 429s and 5xxs with exponential backoff.

- **Anthropic**: `messages.create` requires `max_tokens` (no default — the
  backend fills 4096 when the caller omits it). JSON mode is prompt-level:
  prefill the assistant turn with `{` so the model continues from there. The
  response is `{ content: [{ type: 'text', text }, ...] }` — multiple text
  blocks must be concatenated. The current SDK version does not expose
  `temperature` (it was deprecated); the server-side default applies.
  Reasoning models accept `thinking: { type: 'enabled', budget_tokens }` —
  we forward `thinkMode='think'` via that field; older Claude 3 models
  return 400 if `thinking` is set.

- **Gemini**: `models.generateContent` takes `contents` (string or Content[])
  + `config: { temperature, maxOutputTokens, responseMimeType, thinkingConfig }`.
  The SDK converts `contents: 'string'` to `[{ parts: [{text}], role: 'user' }]`
  on the wire and renames `config` → `generationConfig`. JSON mode is a
  wire-level mimetype (`responseMimeType: 'application/json'`). The model
  name in the URL is `models/<model>:generateContent` — bare `gemini-2.0-flash`
  must be prefixed with `models/`; the backend normalises. Token usage is
  `response.usageMetadata.{promptTokenCount, candidatesTokenCount}`.

### Fallback backend

The escalation fallback (`ESCALATION_FALLBACK_BASE_URL`) continues to use
`VllmBackend` against any OpenAI-compatible endpoint. This was the original
design and still holds — the fallback is provider-agnostic by design.
Existing behaviour is unchanged.

## Consequences

### Positive

- Five first-class inference providers, all reachable via `INFERENCE_BACKEND=`.
- The engine, router, planner, orchestrator, and patch workflow are unchanged
  — they call `Backend.invoke()` and never know which provider served the
  request.
- Cloud + local can be mixed: local Ollama for the router + cloud Claude for
  the analyst is a valid configuration pattern (escalation fallback).
- The capability matrix is now documented in one place, so future maintainers
  don't re-discover the wire-shape quirks per provider.
- The retrieval mode (`hybrid` vs `keyword-only`) is now decoupled from the
  inference backend. A Claude deployment can still get hybrid retrieval via
  OpenAI embeddings — the two API keys are independent.

### Negative

- Three new runtime dependencies (`openai` was already present;
  `@anthropic-ai/sdk` and `@google/genai` are new). Each adds ~200 KB to
  `node_modules`. The supervisor's cold-start time is unchanged (each backend
  imports lazily — only the constructed one's SDK is loaded).
- Three new code paths to maintain when a provider changes their API. The
  OpenAI SDK is reasonably stable; the Anthropic SDK has already deprecated
  `temperature` (we no longer pass it); the Gemini SDK's `thinkingConfig`
  shape may evolve. The capability matrix above records the current contract
  so a future SDK upgrade that breaks an assertion will be visible.
- The capability matrix shows real gaps: Anthropic and Gemini don't expose
  embeddings. A user wanting hybrid retrieval with `INFERENCE_BACKEND=anthropic`
  must configure `EMBEDDING_PROVIDER=openai` (or `ollama`) separately. This is
  documented in the env example and the ADR.

### Neutral

- The default backend remains `ollama` and the default embedder remains
  `ollama` — existing deployments see no behaviour change.

## Alternatives considered

### Use only `vllm` for all OpenAI-compatible providers

Rejected. The `vllm` backend forwards `chat_template_kwargs.enable_thinking`
to the wire request — that field is vLLM-specific and breaks OpenAI / Anthropic
/ Gemini endpoints that reject unknown fields. Also, `INFERENCE_BACKEND=vllm`
pointing at `api.openai.com` is misleading in logs and config — operators
couldn't tell at a glance whether they were running against vLLM, OpenAI, or a
proxy. The five-way enum is honest.

### Use LangChain or Vercel AI SDK for provider abstraction

Rejected. Both add ~5 MB of dependencies and their own abstraction layer.
The supervisor already has a 6-line `Backend` interface; adding a second
abstraction on top would be redundant and would couple us to upstream's
release cadence. Direct SDK calls keep the wire shape visible (which is what
the tests verify) and let each backend implement its own JSON mode / thinking
mode mapping faithfully.

### Make the embedding provider a sub-field of the inference backend

Rejected. The common production pattern is mixed providers: cheap local
router + cloud analyst + OpenAI embeddings. Coupling the embedder to the
inference backend would force either a single-provider lock-in or a
duplicate backend construction. The `EMBEDDING_PROVIDER` selector stays
independent.

## Migration guide

Existing deployments are unaffected — defaults are unchanged.

To switch from Ollama to OpenAI:

```bash
INFERENCE_BACKEND=openai
OPENAI_API_KEY=sk-...
MINICPM5_ROUTER_MODEL=gpt-4o-mini
MINICPM5_ANALYST_MODEL=gpt-4o
MINICPM5_TOOLAGENT_MODEL=gpt-4o
MINICPM5_SUMMARIZER_MODEL=gpt-4o-mini
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536
# Re-create the chunks table with vector(1536) before ingesting.
```

To switch to Anthropic Claude:

```bash
INFERENCE_BACKEND=anthropic
ANTHROPIC_API_KEY=sk-ant-...
MINICPM5_ROUTER_MODEL=claude-3-5-haiku-20241022
MINICPM5_ANALYST_MODEL=claude-3-5-sonnet-20241022
MINICPM5_TOOLAGENT_MODEL=claude-3-5-sonnet-20241022
MINICPM5_SUMMARIZER_MODEL=claude-3-5-haiku-20241022
# Claude doesn't expose embeddings — keep EMBEDDING_PROVIDER=openai or ollama
EMBEDDING_PROVIDER=openai
EMBEDDING_OPENAI_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536
```

To switch to Google Gemini:

```bash
INFERENCE_BACKEND=gemini
GEMINI_API_KEY=...
MINICPM5_ROUTER_MODEL=gemini-2.0-flash
MINICPM5_ANALYST_MODEL=gemini-2.0-flash
MINICPM5_TOOLAGENT_MODEL=gemini-2.0-flash
MINICPM5_SUMMARIZER_MODEL=gemini-2.0-flash
# Same as Claude — Gemini doesn't expose embeddings; use OpenAI or Ollama
EMBEDDING_PROVIDER=openai
EMBEDDING_OPENAI_API_KEY=sk-...
```

To mix local router + cloud analyst (escalation pattern):

```bash
INFERENCE_BACKEND=ollama
OLLAMA_HOST=http://localhost:11434
MINICPM5_ROUTER_MODEL=minicpm5-router
MINICPM5_ANALYST_MODEL=minicpm5-analyst
# Cloud escalation fallback when the router decides the local model can't handle the task
ESCALATION_FALLBACK_BASE_URL=https://api.anthropic.com/v1
ESCALATION_FALLBACK_API_KEY=sk-ant-...
ESCALATION_FALLBACK_MODEL=claude-3-5-sonnet-20241022
```
