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
import type { Backend, InferenceRequest, InferenceResponse, StreamChunk } from './backend.js';

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

  /** Build the Ollama SDK chat request payload from an InferenceRequest. */
  private buildChatRequest(req: InferenceRequest, stream: boolean) {
    const thinkMode = req.thinkMode ?? this.config.inference.defaultThinkMode;
    const temperature = req.temperature ?? 0.1;

    // Resolve context-window hint. `contextTokens` is the explicit knob; the
    // legacy `maxTokens` field is treated as a back-compat alias for it.
    const contextTokens = req.contextTokens ?? req.maxTokens ?? this.config.context.budgetTokens;

    // `num_predict` is the Ollama generation-length cap. Only set it when the
    // caller explicitly asked for one.
    const options: Record<string, unknown> = { temperature, num_ctx: contextTokens };
    if (req.maxOutputTokens !== undefined) {
      options.num_predict = req.maxOutputTokens;
    }

    return {
      model: req.model,
      messages: [{ role: 'user' as const, content: req.prompt }],
      format: req.formatJson ? ('json' as const) : undefined,
      options,
      think: thinkMode === 'think',
      stream,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  async invoke(req: InferenceRequest): Promise<InferenceResponse> {
    const started = Date.now();
    // `stream: false` selects the non-streaming overload so the response is a
    // plain ChatResponse rather than an OllamaStream. The SDK's return type
    // is a union; we narrow via the `message` field that only ChatResponse has.
    const response = (await this.client.chat(this.buildChatRequest(req, false))) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };

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

  /**
   * Streaming variant — uses the Ollama SDK's `chat({ stream: true })`
   * overload which returns an `OllamaStream<ChatResponse, ChatStreamResult>`.
   * The SDK emits typed events (`token`, `thinking`, `done`, `error`) which
   * we map into `StreamChunk`.
   *
   * JSON mode: Ollama doesn't expose a streaming-JSON flag — the model
   * produces JSON-shaped text token-by-token and the caller (the stream
   * consumer) parses the concatenated content at the end.
   */
  async *stream(req: InferenceRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const started = Date.now();
    const ollamaStream = (await this.client.chat(
      this.buildChatRequest(req, true),
    )) as AsyncIterable<{
      type: 'token' | 'thinking' | 'message' | 'done' | 'error';
      data:
        | { delta: string; role?: string }
        | { chunk: unknown }
        | {
            result: {
              prompt_eval_count?: number;
              eval_count?: number;
              model?: string;
            };
          }
        | { error: { message: string } };
    }>;
    let promptTokens = 0;
    let completionTokens = 0;
    let model = req.model;

    for await (const event of ollamaStream) {
      switch (event.type) {
        case 'token':
          yield { type: 'delta', text: (event.data as { delta: string }).delta };
          break;
        case 'thinking':
          yield { type: 'thinking', text: (event.data as { delta: string }).delta };
          break;
        case 'message':
          // Ollama periodically yields intermediate chat chunks; the
          // assistant text content arrives via the `token` event above.
          break;
        case 'done': {
          const result = (
            event.data as {
              result: { prompt_eval_count?: number; eval_count?: number; model?: string };
            }
          ).result;
          promptTokens = result.prompt_eval_count ?? 0;
          completionTokens = result.eval_count ?? 0;
          model = result.model ?? req.model;
          break;
        }
        case 'error':
          yield {
            type: 'error',
            error: new Error((event.data as { error: { message: string } }).error.message),
          };
          return;
      }
    }

    yield {
      type: 'done',
      tokens: { prompt: promptTokens, completion: completionTokens },
      model,
      latencyMs: Date.now() - started,
    };
  }

  /** `ping()` resolves (never throws) with `healthy: false` on refused/timeout — a liveness datapoint. */
  async health(): Promise<boolean> {
    const { healthy } = await this.client.ping();
    return healthy;
  }
}
