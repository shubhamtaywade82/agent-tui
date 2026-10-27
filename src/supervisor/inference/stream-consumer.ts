/**
 * Stream consumer — accumulates a `Backend.stream()` async iterable into an
 * `InferenceResponse`-shaped result. Used by the supervisor engine when a
 * caller opts into streaming (so the engine can still return a
 * `InferenceResponse` to its existing consumers) and by the streaming
 * backends themselves to provide a non-streaming `invoke()` from a
 * streaming `stream()` implementation.
 *
 * The consumer surfaces the `thinking` chunks separately (via the optional
 * `onThinking` callback) so the engine can emit live `model_thinking` events
 * without losing the trace. The `delta` chunks are concatenated into the
 * final `content`.
 */
import type { InferenceRequest, InferenceResponse, StreamChunk } from './backend.js';

export interface AccumulateOptions {
  /** Called for each `delta` chunk as it arrives (live token observability). */
  onDelta?: (text: string) => void;
  /** Called for each `thinking` chunk as it arrives. */
  onThinking?: (text: string) => void;
}

/**
 * Consume a stream into an `InferenceResponse`. Handles JSON parsing when
 * `req.formatJson` is set. Throws if the stream emits an `error` chunk.
 */
export async function accumulateStream(
  stream: AsyncIterable<StreamChunk>,
  req: InferenceRequest,
  opts: AccumulateOptions = {},
): Promise<InferenceResponse> {
  const parts: string[] = [];
  let tokens = { prompt: 0, completion: 0 };
  let model = req.model;
  let latencyMs = 0;

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'delta':
        parts.push(chunk.text);
        opts.onDelta?.(chunk.text);
        break;
      case 'thinking':
        opts.onThinking?.(chunk.text);
        break;
      case 'done':
        tokens = chunk.tokens;
        model = chunk.model;
        latencyMs = chunk.latencyMs;
        break;
      case 'error':
        throw chunk.error;
    }
  }

  const content = parts.join('').trim();
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

  return { content, json, parsed, tokens, latencyMs, model };
}
