/**
 * Ollama backend — default inference engine (§13, §17).
 *
 * Uses `@nemesis-oss/ollama-sdk`, the same HTTP client the TUI runs on, so the
 * supervisor inherits the SDK's per-request timeout, retry/backoff (Retry-After
 * on 429s included) and typed error taxonomy instead of a second, unmanaged
 * transport. The SYSTEM prompt and runtime options (temperature, num_ctx) live
 * in the Modelfile; we only override per-call `temperature` and `think` here as
 * a failsafe.
 */
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import type { SupervisorConfig } from '../config.js';
import type { Backend, InferenceRequest, InferenceResponse } from './backend.js';

/** Matches the `timeoutMs` default documented on `InferenceRequest`. */
const DEFAULT_TIMEOUT_MS = 60_000;

export class OllamaBackend implements Backend {
  readonly name = 'ollama';
  private readonly client: OllamaClient;

  /** `fetchImpl` is the transport seam for tests; production uses the runtime's global fetch. */
  constructor(
    private readonly config: SupervisorConfig,
    fetchImpl?: typeof fetch,
  ) {
    this.client = new OllamaClient({
      baseUrl: config.inference.ollamaHost,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }

  async invoke(req: InferenceRequest): Promise<InferenceResponse> {
    const started = Date.now();
    const thinkMode = req.thinkMode ?? this.config.inference.defaultThinkMode;
    const temperature = req.temperature ?? 0.1;

    // Resolve context-window hint. `contextTokens` is the explicit knob; the
    // legacy `maxTokens` field is treated as a back-compat alias for it
    // (older callers used `maxTokens: 512` to mean "shrink the context window
    // for a small JSON output" — that was the bug we are correcting).
    const contextTokens = req.contextTokens ?? req.maxTokens ?? this.config.context.budgetTokens;

    // `num_predict` is the Ollama generation-length cap. Only set it when the
    // caller explicitly asked for one — otherwise leave it unset so the
    // model's own Modelfile default (or Ollama's built-in) applies.
    const options: Record<string, unknown> = { temperature, num_ctx: contextTokens };
    if (req.maxOutputTokens !== undefined) {
      options.num_predict = req.maxOutputTokens;
    }

    // `stream: false` selects the non-streaming overload so the response is a
    // plain ChatResponse rather than an OllamaStream.
    const response = await this.client.chat({
      model: req.model,
      messages: [{ role: 'user', content: req.prompt }],
      format: req.formatJson ? 'json' : undefined,
      options,
      think: thinkMode === 'think',
      stream: false,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    const content = (response.message?.content ?? '').trim();
    let json: unknown;
    let parsed = false;
    if (req.formatJson) {
      try {
        json = JSON.parse(content);
        parsed = true;
      } catch {
        parsed = false;
      }
    }

    return {
      content,
      json,
      parsed,
      tokens: {
        prompt: response.prompt_eval_count ?? 0,
        completion: response.eval_count ?? 0,
      },
      latencyMs: Date.now() - started,
      model: req.model,
    };
  }

  /** `ping()` resolves (never throws) with `healthy: false` on refused/timeout — a liveness datapoint. */
  async health(): Promise<boolean> {
    const { healthy } = await this.client.ping();
    return healthy;
  }
}
