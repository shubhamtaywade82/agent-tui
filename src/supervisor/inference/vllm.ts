/**
 * vLLM backend — alternate inference engine for server-side deployments
 * with larger GPUs (§17 recommended stack). vLLM exposes an
 * OpenAI-compatible API, so we use the official `openai` SDK pointed at
 * the vLLM base URL.
 *
 * Tool-call parsing in vLLM converts XML outputs into OpenAI-shaped
 * `tool_calls` — that conversion happens upstream and is consumed by the
 * tool validator (§10). This backend only handles raw text/JSON inference.
 */
import OpenAI from 'openai';
import type { SupervisorConfig } from '../config.js';
import type { Backend, InferenceRequest, InferenceResponse, StreamChunk } from './backend.js';
import { buildOpenAIChatParams, consumeOpenAIStream } from './openai-stream.js';

export class VllmBackend implements Backend {
  readonly name = 'vllm';
  protected readonly client: OpenAI;

  constructor(protected readonly config: SupervisorConfig) {
    this.client = new OpenAI({
      baseURL: config.inference.vllmBaseUrl,
      apiKey: config.inference.vllmApiKey,
    });
  }

  async invoke(req: InferenceRequest): Promise<InferenceResponse> {
    const started = Date.now();
    const thinkMode = req.thinkMode ?? this.config.inference.defaultThinkMode;
    const temperature = req.temperature ?? 0.1;

    // vLLM supports a `chat_template_kwargs` field for toggling think mode
    // when the served model exposes one (e.g. MiniCPM5's `enable_thinking`).
    //
    // `max_tokens` (OpenAI/vLLM) is a generation-length cap, NOT a
    // context-window hint — vLLM derives the context window from the served
    // model. Forward only the new `maxOutputTokens` field. The legacy
    // `maxTokens` field is intentionally NOT forwarded here, because every
    // prior caller that set it (e.g. the router with `maxTokens: 512`) was
    // doing so to request a small JSON output, not to constrain generation
    // length.
    const completion = await this.client.chat.completions.create({
      ...buildOpenAIChatParams(req, temperature),
      // @ts-expect-error - chat_template_kwargs is supported by vLLM but not in the OpenAI SDK types
      chat_template_kwargs: { enable_thinking: thinkMode === 'think' },
    });

    const content = (completion.choices[0]?.message?.content ?? '').trim();
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
        prompt: completion.usage?.prompt_tokens ?? 0,
        completion: completion.usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      model: completion.model ?? req.model,
    };
  }

  /**
   * Streaming variant — uses the OpenAI SDK's `stream: true` overload.
   * vLLM streams via SSE; the SDK exposes the chunks as an async iterable.
   *
   * JSON mode is forwarded via `response_format`; vLLM forwards it to the
   * served model's chat template. Reasoning content (o-series or models that
   * emit `delta.reasoning_content`) is surfaced as `thinking` chunks.
   */
  async *stream(req: InferenceRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const started = Date.now();
    const temperature = req.temperature ?? 0.1;
    const stream = await this.client.chat.completions.create({
      ...buildOpenAIChatParams(req, temperature),
      stream: true,
      // Include usage on the final chunk — without this the OpenAI SDK
      // omits `usage` from streamed responses and we'd report 0 tokens.
      stream_options: { include_usage: true },
    });
    yield* consumeOpenAIStream(stream, req, started);
  }

  async health(): Promise<boolean> {
    try {
      const r = await this.client.models.list();
      return Array.isArray(r.data);
    } catch {
      return false;
    }
  }
}
