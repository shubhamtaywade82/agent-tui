/**
 * Shared OpenAI-SDK streaming helper — used by both `VllmBackend` and
 * `OpenAIBackend` (both wrap the official `openai` SDK and share the
 * streaming wire shape).
 *
 * The OpenAI SDK returns an async iterable of `ChatCompletionChunk` events
 * when `stream: true` is set. Each chunk carries one or more choices with a
 * `delta.content` (text) or `delta.reasoning_content` (reasoning, on
 * OpenAI o-series models). The final chunk carries the `usage` object.
 *
 * This helper maps that into the supervisor's `StreamChunk` union.
 */
import type OpenAI from 'openai';
import type { InferenceRequest, StreamChunk } from './backend.js';

/**
 * Build the OpenAI chat.completions.create params from an InferenceRequest.
 * Shared between `invoke()` and `stream()` so the wire shape stays in sync.
 */
export function buildOpenAIChatParams(req: InferenceRequest, temperature: number) {
  return {
    model: req.model,
    messages: [{ role: 'user' as const, content: req.prompt }],
    temperature,
    ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
    response_format: req.formatJson ? { type: 'json_object' as const } : undefined,
  };
}

/**
 * Consume an OpenAI streaming iterator into the supervisor's `StreamChunk`
 * shape. Yields `delta` chunks for text content, `thinking` chunks for
 * reasoning content (when the model emits `delta.reasoning_content` — used by
 * o-series models), and a final `done` chunk with the token usage.
 *
 * The OpenAI SDK does NOT include `usage` on streamed responses by default
 * — the caller must pass `stream_options: { include_usage: true }`. We set
 * that here unconditionally; backends that don't support it (older vLLM)
 * silently ignore the option and report 0 tokens.
 */
export async function* consumeOpenAIStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  req: InferenceRequest,
  startedAt: number,
): AsyncGenerator<StreamChunk, void, undefined> {
  let promptTokens = 0;
  let completionTokens = 0;
  let model = req.model;

  for await (const chunk of stream) {
    if (chunk.model) model = chunk.model;

    // OpenAI o-series streaming can include a separate reasoning_content
    // field on the delta — surface as thinking chunks.
    const choice = chunk.choices?.[0];
    if (choice?.delta) {
      // Reasoning content (o-series) — extract via the unknown-key escape
      // hatch because the SDK types don't include reasoning_content yet.
      const reasoning = (choice.delta as unknown as { reasoning_content?: string })
        .reasoning_content;
      if (reasoning) {
        yield { type: 'thinking', text: reasoning };
      }
      if (choice.delta.content) {
        yield { type: 'delta', text: choice.delta.content };
      }
    }

    // The final chunk carries `usage` when `stream_options.include_usage`
    // was set. We unconditionally read it; if absent, we report 0.
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? 0;
      completionTokens = chunk.usage.completion_tokens ?? 0;
    }
  }

  yield {
    type: 'done',
    tokens: { prompt: promptTokens, completion: completionTokens },
    model,
    latencyMs: Date.now() - startedAt,
  };
}
