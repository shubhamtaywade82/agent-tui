/**
 * Inference backend protocol — §13 (Model Routing and Escalation).
 *
 * The supervisor never calls an LLM directly. It calls a `Backend`
 * implementation, selected at runtime via `INFERENCE_BACKEND`. This indirection
 * lets us swap Ollama for vLLM (or a deterministic mock in tests) without
 * touching the orchestration engine.
 *
 * Each `Backend.invoke` call is wrapped by the supervisor in:
 *   1. Token-budget enforcement (§8)
 *   2. Telemetry span (§15.1)
 *   3. Retry with exponential backoff for transient errors (§1 §10.3)
 *   4. Strict JSON validation when `formatJson` is requested
 */
import type { SupervisorConfig } from '../config.js';

export interface InferenceRequest {
  /** The Ollama/vLLM model name, e.g. `minicpm5-router`. */
  model: string;
  /** User-side prompt. The SYSTEM prompt is sourced from the Modelfile. */
  prompt: string;
  /** When true, the backend must request JSON output and the supervisor will JSON.parse the result. */
  formatJson?: boolean;
  /** Override the global think mode for this single call (§13.3). */
  thinkMode?: 'think' | 'no-think';
  /**
   * Context-window size hint (Ollama `num_ctx`). Defaults to
   * `config.context.budgetTokens`. Set this ONLY when you want to shrink the
   * context window for a small JSON-output call (e.g. the router). Do NOT use
   * this to cap generation length — use `maxOutputTokens` for that.
   */
  contextTokens?: number;
  /**
   * Hard ceiling on the number of tokens the model may *generate*
   * (Ollama `num_predict`, vLLM/OpenAI `max_tokens`). When omitted, the
   * backend leaves the generation limit at the model's own default.
   */
  maxOutputTokens?: number;
  /**
   * @deprecated use `maxOutputTokens` (generation cap) or `contextTokens`
   * (context-window hint) instead. `maxTokens` was historically forwarded to
   * Ollama as `num_ctx`, which silently truncated the router model's context
   * to 512 tokens whenever a caller set `maxTokens: 512` intending to cap
   * generation. Kept only as a back-compat alias for `contextTokens` so older
   * callers continue to work; new callers should pass the explicit field.
   */
  maxTokens?: number;
  /** Low temperature for deterministic routing/classification; higher for prose. */
  temperature?: number;
  /** Optional timeout in ms. Defaults to 60_000. */
  timeoutMs?: number;
}

export interface InferenceResponse {
  /** The raw text the model produced (already trimmed). */
  content: string;
  /** Parsed JSON when `formatJson` was true and parsing succeeded; `undefined` otherwise. */
  json: unknown | undefined;
  /** True iff `formatJson` was requested and parsing succeeded. */
  parsed: boolean;
  /** Token accounting for telemetry and budget enforcement (§15.2). */
  tokens: { prompt: number; completion: number };
  /** Wall-clock latency in ms. */
  latencyMs: number;
  /** Model that actually served the request (may differ from `request.model` after escalation). */
  model: string;
}

/**
 * Streaming chunk emitted by `Backend.stream()`. A discriminated union
 * matching the OpenAI / Anthropic / Gemini / Ollama streaming event
 * shapes — backend-specific events are mapped into these four types so
 * the supervisor engine has one consumer path.
 *
 *   - `delta`: a text-content token. Concatenate `text` to build the
 *     final assistant message.
 *   - `thinking`: a reasoning-trace token (e.g. Anthropic's thinking
 *     blocks, Gemini's `includeThoughts`, Ollama's `ThinkingEvent`).
 *     Surfaced separately for live observability but not part of the
 *     final content.
 *   - `done`: the final chunk. Carries the total token usage and the
 *     model name (which may differ from `req.model` after escalation).
 *     Exactly one `done` chunk is emitted per stream, always last.
 *   - `error`: an unrecoverable error. The stream ends after this chunk.
 */
export type StreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'done';
      tokens: { prompt: number; completion: number };
      model: string;
      latencyMs: number;
    }
  | { type: 'error'; error: Error };

export interface Backend {
  readonly name: string;
  invoke(req: InferenceRequest): Promise<InferenceResponse>;
  /**
   * Streaming variant of `invoke()`. Returns an async iterable of
   * `StreamChunk` events. The supervisor engine consumes this to emit
   * live `model_token` events (§15.1 observability) and to surface
   * progress to the TUI without waiting for the full response.
   *
   * Backends that don't support streaming (e.g. the MockBackend in
   * tests) implement this by yielding a single `delta` chunk with the
   * full content, then a `done` chunk. The default non-streaming
   * `invoke()` is unchanged.
   *
   * The stream must emit exactly one `done` chunk last (or one `error`
   * chunk, after which the stream ends). Backends are responsible for
   * cleaning up their underlying SDK resources (closing iterators,
   * aborting on AbortSignal, etc.) on early termination by the caller.
   *
   * See docs/supervisor/adr/0011-streaming-backends.md.
   */
  stream(req: InferenceRequest): AsyncIterable<StreamChunk>;
  /** Liveness probe used by the API healthcheck. */
  health(): Promise<boolean>;
}

export type BackendFactory = (config: SupervisorConfig) => Backend;
