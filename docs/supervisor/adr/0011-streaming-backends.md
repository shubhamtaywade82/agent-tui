# ADR 0011: Streaming backends

- **Status:** Proposed
- **Date:** 2026-10-27
- **Supersedes:** none
- **Superseded by:** —
- **Related:** ADR 0009 (Multi-provider inference), ADR 0012 (Cost-budget accounting)

## Context

All five first-class backends (Ollama, vLLM, OpenAI, Anthropic, Gemini)
historically exposed only `Backend.invoke()` — a non-streaming method that
returns the full `InferenceResponse` after the model finishes generating.

For long generations (analyst reasoning, code patches, document
summarisation), this means the supervisor blocks for 30+ seconds before
the first token reaches the consumer. The TUI's chat surface has its own
streaming path for Ollama via the SDK, but the supervisor engine — the
agentic loop that the orchestrator calls — was non-streaming only.

This ADR adds a streaming variant to the `Backend` interface and an
opt-in `streamAnalyst: true` flag on `Supervisor.run()` so consumers can
choose between latency-optimal batch (default) and live-progress streaming.

## Decision

### New `Backend.stream()` method

```ts
export type StreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'done'; tokens: { prompt: number; completion: number }; model: string; latencyMs: number }
  | { type: 'error'; error: Error };

export interface Backend {
  invoke(req: InferenceRequest): Promise<InferenceResponse>;   // existing
  stream(req: InferenceRequest): AsyncIterable<StreamChunk>;     // new
  health(): Promise<boolean>;                                    // existing
}
```

The chunk type is a discriminated union matching all four SDKs' streaming
event shapes:

- `delta` — a text-content token. Concatenate to build the final assistant
  message.
- `thinking` — a reasoning-trace token (Anthropic `thinking_delta`, Gemini
  thought parts, Ollama `ThinkingEvent`, OpenAI o-series `reasoning_content`).
  Surfaced separately for live observability but NOT part of the final
  content.
- `done` — final chunk. Carries the total token usage and the model name
  (which may differ from `req.model` after escalation). Exactly one per
  stream, always last.
- `error` — unrecoverable error. The stream ends after this chunk.

### Per-backend implementations

- **OllamaBackend** uses `client.chat({ stream: true })` which returns an
  `OllamaStream<ChatResponse, ChatStreamResult>`. Maps `token` → `delta`,
  `thinking` → `thinking`, `done` → `done`, `error` → `error`. The `message`
  event is skipped (the `token` event already carries the delta).

- **VllmBackend** + **OpenAIBackend** share a helper (`openai-stream.ts`)
  that consumes the OpenAI SDK's async iterable. Sets
  `stream_options: { include_usage: true }` so the final chunk carries
  token usage. Surfaces `delta.reasoning_content` (o-series) as `thinking`
  chunks via an unknown-key escape hatch (the SDK types don't include it
  yet).

- **AnthropicBackend** uses `messages.create({ stream: true })` which
  returns `Stream<RawMessageStreamEvent>`. Maps `content_block_delta` of
  type `text_delta` → `delta`, `thinking_delta` → `thinking`. Token usage
  is split: `input_tokens` arrives on `message_start`, `output_tokens` on
  `message_delta`.

- **GeminiBackend** uses `generateContentStream()` which returns an
  `AsyncGenerator<GenerateContentResponse>`. Each yielded response
  carries `candidates[0].content.parts[]` — text parts become `delta`
  chunks. The final response carries `usageMetadata` with cumulative
  token counts.

- **MockBackend** yields a single `delta` chunk with the full content
  (mock has no real token-by-token generation), then a `done` chunk. This
  makes streaming tests fully deterministic.

- **PooledOllamaBackend** wraps `inner.stream()` — acquires the model once
  at the start, releases in the `finally` block. The pin is held for the
  full duration of the stream so the pool doesn't evict the model
  mid-generation.

### Engine integration

`Supervisor.run()` gains a `streamAnalyst?: boolean` parameter. When true:

1. `stepExecuteAnalyst` calls `Backend.stream()` instead of `Backend.invoke()`.
2. A new `invokeStreaming()` helper consumes the stream, accumulating
   `delta` chunks into the final `content` and reading `done` for token
   accounting.
3. For each `delta` chunk, the engine emits a `model_token` domain event
   with `{ text: chunk.text }` payload. Subscribers (TUIs, log scrapers)
   accumulate these to display the assistant's output token-by-token.
4. For each `thinking` chunk, the engine emits a `model_thinking` event
   with the same payload shape. Consumers can choose to display or hide
   the reasoning trace.
5. The reconstructed `InferenceResponse` is identical in shape to the
   non-streaming path — downstream code doesn't branch.

### Stream consumer helper

`src/supervisor/inference/stream-consumer.ts` exports `accumulateStream()`
which consumes any `AsyncIterable<StreamChunk>` into an `InferenceResponse`,
handling JSON parsing when `formatJson` was requested. Used by the engine
internally; also reusable by tests that want to verify streaming behaviour
without instantiating the full supervisor.

## Consequences

### Positive

- **Live observability**: subscribers see tokens as they're generated
  rather than waiting for the full response. A 30-second analyst run shows
  progress every ~100ms instead of a single 30-second pause.
- **Reasoning trace visibility**: thinking chunks are surfaced as a
  separate event stream, so consumers can show the model's reasoning
  (Claude thinking, Gemini thoughts, o-series reasoning_content) without
  polluting the assistant's text output.
- **Same engine path**: the streaming result is reshaped to the existing
  `InferenceResponse`, so all downstream consumers (validator, repair
  loop, ledger commit) work unchanged.
- **Opt-in**: the default (`streamAnalyst: false`) preserves the
  non-streaming batch path — best for throughput-optimal workloads
  (golden evals, batch processing) where the extra event-publishing
  overhead would slow things down.

### Negative

- **One more code path**: backends now have `invoke()` AND `stream()`. The
  shared OpenAI helper (`openai-stream.ts`) avoids duplication between
  OpenAI and vLLM, but each backend still has its own stream-iteration
  logic.
- **Event-volume overhead**: each `delta` chunk publishes a `model_token`
  event. For a 10K-token response, that's ~10K events hitting the bus
  (and persisted to the events table). Operators should consider batching
  when streaming is enabled in production. Mitigation: the events are
  small (`{ text: string }`) and the persist is fire-and-forget; the
  subscriber that persists to Postgres uses a single INSERT per event,
  which Postgres handles fine at <100 inserts/sec.
- **Backpressure**: the engine's `invokeStreaming` consumes the stream
  greedily (no `for await ... of` backpressure). If a subscriber is slow,
  events queue up in the bus. Mitigation: the bus is in-process and the
  bus's `publish()` awaits each subscriber; a slow subscriber slows the
  whole run. This is the existing trade-off for all engine events.

### Neutral

- Streaming is **not used for the router step** (which is always a short
  JSON classification) or the summarizer step (always a short summary).
  The latency win is concentrated in the analyst step where generation
  length is unpredictable.
- The TUI's existing Ollama streaming path is unchanged — it streams
  via the SDK directly for chat, separate from the supervisor engine.
  The supervisor streaming is for orchestration runs.

## Alternatives considered

### Always stream

Rejected. Streaming adds event-publishing overhead per token. For batch
workloads (golden evals, automated pipelines, planner invocations), the
non-streaming path is faster. The opt-in flag lets callers choose.

### Make `stream()` a separate interface

Rejected. The discriminated union `StreamChunk` is small enough that
having it on the same `Backend` interface is cleaner. Backends that don't
natively support streaming (Mock) implement it by yielding a single
delta + done pair.

### Persist thinking chunks to the AgentState

Rejected. The thinking trace can be very large (10K+ tokens for o1
reasoning); persisting it would bloat the events table and the state
record. The events are emitted for live observability only; operators
who want a permanent trace can subscribe and persist to a separate
table.

## Migration guide

Existing deployments are unaffected — `streamAnalyst` defaults to false.

To enable streaming for a run (e.g. from the orchestrator or a TUI):

```ts
await supervisor.run({
  objective: 'Explain how async/await works',
  streamAnalyst: true,
  goalId: 'goal-123',
});
```

Subscribe to `model_token` events for live display:

```ts
supervisor.bus.subscribe((e) => {
  if (e.type === 'model_token') {
    process.stdout.write(e.payload.text);
  } else if (e.type === 'model_thinking') {
    // Optional: show reasoning trace
    process.stderr.write(`[thinking] ${e.payload.text}`);
  }
});
```

The final `AgentState.executionResult` is identical whether streaming was
enabled or not — the engine reconstructs it from the accumulated chunks.
