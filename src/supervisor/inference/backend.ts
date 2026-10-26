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

export interface Backend {
  readonly name: string;
  invoke(req: InferenceRequest): Promise<InferenceResponse>;
  /** Liveness probe used by the API healthcheck. */
  health(): Promise<boolean>;
}

export type BackendFactory = (config: SupervisorConfig) => Backend;
