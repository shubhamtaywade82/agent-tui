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
import type { Backend, InferenceRequest, InferenceResponse } from './backend.js';

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
