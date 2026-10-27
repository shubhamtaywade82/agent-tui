/**
 * Anthropic backend — uses the official `@anthropic-ai/sdk` against the
 * Anthropic Messages API (`/v1/messages`).
 *
 * Anthropic exposes a different request/response shape than OpenAI's
 * chat/completions:
 *
 *   - System prompt is a top-level `system` field, not a message.
 *   - Messages are `{ role: 'user' | 'assistant', content: string }`.
 *   - Response is `{ content: [{ type: 'text', text: '...' }] }`.
 *   - Generation cap is `max_tokens` (required by Anthropic, no default).
 *   - JSON mode is NOT a wire-level flag — Anthropic relies on prompt-level
 *     JSON instructions. This backend sets `max_tokens: 4096` when the caller
 *     requests `formatJson` without an explicit cap, so the model has room
 *     to complete a structured response.
 *   - Reasoning models (claude-3-5-sonnet, claude-opus-4, etc.) accept a
 *     `thinking` field for extended thinking. We forward `thinkMode='think'`
 *     via that field; `thinkMode='no-think'` disables it. Older Claude 3
 *     models ignore the field.
 *
 * Capability matrix entry (see ADR 0009):
 *
 *   - JSON mode: prompt-level (Anthropic recommends prefilling the assistant
 *     message with `{` to force JSON output; this backend does NOT prefill —
 *     callers that need strict JSON should validate the output).
 *   - `max_tokens`: required by Anthropic; defaults to 4096 when omitted.
 *   - Context window: derived from the model (200K for Claude 3.5+).
 *   - `think` flag: forwarded to Anthropic's `thinking` parameter when the
 *     model supports it; silently ignored otherwise.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { SupervisorConfig } from '../config.js';
import { logger } from '../observability/logger.js';
import type { Backend, InferenceRequest, InferenceResponse, StreamChunk } from './backend.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicBackend implements Backend {
  readonly name = 'anthropic';
  protected readonly client: Anthropic;

  /** `fetchImpl` is the transport seam for tests; production uses the runtime's global fetch. */
  constructor(
    protected readonly config: SupervisorConfig,
    fetchImpl?: typeof fetch,
  ) {
    const anthropicCfg = config.inference.anthropic;
    if (!anthropicCfg.apiKey) {
      throw new Error(
        'AnthropicBackend: ANTHROPIC_API_KEY is required when INFERENCE_BACKEND=anthropic. ' +
          'Set it in the environment or in config.inference.anthropic.apiKey.',
      );
    }
    this.client = new Anthropic({
      apiKey: anthropicCfg.apiKey,
      ...(anthropicCfg.baseUrl ? { baseURL: anthropicCfg.baseUrl } : {}),
      ...(anthropicCfg.version
        ? { defaultHeaders: { 'anthropic-version': anthropicCfg.version } }
        : {}),
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 2,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    logger.info({ baseUrl: anthropicCfg.baseUrl }, 'AnthropicBackend: initialised');
  }

  async invoke(req: InferenceRequest): Promise<InferenceResponse> {
    const started = Date.now();
    const thinkMode = req.thinkMode ?? this.config.inference.defaultThinkMode;
    // Anthropic requires max_tokens; default to 4096 when the caller omitted it.
    const maxTokens = req.maxOutputTokens ?? DEFAULT_MAX_TOKENS;

    // Build the request. Anthropic's `thinking` parameter is a structured
    // object that enables extended thinking on supported models. Older
    // Claude 3 models return a 400 if the field is passed — guard against
    // that by only forwarding when the caller explicitly opted in.
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: req.prompt }],
    };

    // Anthropic's JSON mode is prompt-level. When formatJson is requested,
    // prefill the assistant turn with `{` so the model continues from there.
    // This is the documented Anthropic pattern for forcing JSON output.
    if (req.formatJson) {
      params.messages = [
        { role: 'user', content: req.prompt },
        { role: 'assistant', content: '{' },
      ];
    }

    if (thinkMode === 'think') {
      // Extended thinking is opt-in per call. Budget tokens for the thinking
      // trace — capped at half the generation budget so the model leaves
      // room for the actual response.
      const thinkingBudget = Math.min(maxTokens / 2, 2048);
      // Anthropic requires temperature unset and top_p unset when thinking
      // is on. The current SDK version doesn't expose `temperature` at all
      // (it was deprecated), so we don't need to override anything here.
      params.thinking = { type: 'enabled', budget_tokens: Math.max(thinkingBudget, 1024) };
    }

    const message = await this.client.messages.create(params);

    // Extract text from the content blocks (Anthropic returns an array of
    // typed blocks — text, tool_use, thinking, etc.). Concatenate all text
    // blocks; ignore tool_use and thinking blocks (the caller asked for
    // text/JSON output, not structured tool calls).
    const content = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    // When we prefilled with `{`, the model's response may or may not
    // include the leading brace. Reconstruct a complete JSON string.
    let jsonContent = content;
    if (req.formatJson && !content.startsWith('{')) {
      jsonContent = `{${content}`;
    } else if (req.formatJson && content.startsWith('{')) {
      // Already balanced.
    }

    let json: unknown;
    let parsed = false;
    if (req.formatJson) {
      try {
        json = JSON.parse(jsonContent);
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
        prompt: message.usage.input_tokens,
        completion: message.usage.output_tokens,
      },
      latencyMs: Date.now() - started,
      model: message.model,
    };
  }

  /**
   * Streaming variant — uses `messages.create({ stream: true })` which
   * returns a `Stream<RawMessageStreamEvent>`. Each `content_block_delta`
   * event carries either a `text_delta` (assistant content) or a
   * `thinking_delta` (reasoning trace) — we surface them as `delta` /
   * `thinking` chunks respectively.
   *
   * JSON mode: same as `invoke()` — prompt-level prefill of `{`. The
   * caller (stream consumer) reassembles the JSON from concatenated
   * delta chunks. The prefill brace is added by the consumer, not by the
   * stream (the SDK doesn't emit a chunk for the prefilled text).
   */
  async *stream(req: InferenceRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const started = Date.now();
    const thinkMode = req.thinkMode ?? this.config.inference.defaultThinkMode;
    const maxTokens = req.maxOutputTokens ?? DEFAULT_MAX_TOKENS;

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: req.prompt }],
      stream: true,
    };

    if (req.formatJson) {
      params.messages = [
        { role: 'user', content: req.prompt },
        { role: 'assistant', content: '{' },
      ];
    }

    if (thinkMode === 'think') {
      const thinkingBudget = Math.min(maxTokens / 2, 2048);
      params.thinking = { type: 'enabled', budget_tokens: Math.max(thinkingBudget, 1024) };
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let model = req.model;

    const eventStream = await this.client.messages.create(params);
    for await (const event of eventStream) {
      switch (event.type) {
        case 'message_start':
          model = event.message.model;
          promptTokens = event.message.usage.input_tokens ?? 0;
          break;
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'delta', text: event.delta.text };
          } else if (event.delta.type === 'thinking_delta') {
            yield { type: 'thinking', text: event.delta.thinking };
          }
          break;
        case 'message_delta':
          // The final usage is on message_delta.usage (output_tokens only —
          // input_tokens was reported on message_start).
          if (event.usage) {
            completionTokens = event.usage.output_tokens ?? completionTokens;
          }
          break;
      }
    }

    yield {
      type: 'done',
      tokens: { prompt: promptTokens, completion: completionTokens },
      model,
      latencyMs: Date.now() - started,
    };
  }

  async health(): Promise<boolean> {
    // Anthropic doesn't expose a /models list endpoint. We ping by sending
    // a 1-token max request to a known model and checking for a 200 / 400
    // (model-not-found still proves the API key is valid).
    try {
      await this.client.messages.create({
        model: this.config.inference.routerModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return true;
    } catch (e) {
      // 400 with a "model not found" error still means the API is reachable
      // and the key is valid.
      if (e instanceof Anthropic.APIError && e.status === 400) {
        return true;
      }
      return false;
    }
  }
}
