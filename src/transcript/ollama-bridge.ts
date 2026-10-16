/**
 * src/transcript/ollama-bridge.ts
 *
 * The adapter between `OllamaClient.chatStream()` and the transcript
 * callback contract from step 2. Engine code calls `runOllamaChat()`
 * with a `TranscriptCallbacks` instance; the function drives the
 * Ollama stream and dispatches thinking / token / tool_call / usage
 * events into the transcript.
 *
 * Why this lives in `src/transcript/` and not in the engine: the
 * bridge is "SDK-shape → transcript-shape", and the transcript is the
 * thing that survives renderer swaps. The engine itself stays SDK-
 * agnostic — if you swap Ollama for an OpenAI-compatible endpoint
 * tomorrow, you write `openai-bridge.ts` next to this file and the
 * engine doesn't change.
 *
 * Lifecycle:
 *   1. `cb.add(makeUserEvent(...))` is the CALLER's job, not this
 *      function's — the engine knows the user message text, this
 *      function only consumes the model's reply.
 *   2. This function mints a thinking event id + an assistant event id
 *      via `cb.nextId()`, adds them, then iterates the stream.
 *   3. On `'thinking'` events → `cb.append(thinkId, delta)`.
 *   4. On `'token'` events → `cb.append(ansId, delta)`.
 *      The first token that arrives implicitly finishes thinking (a
 *      model that emits thinking then answer has a clean transition).
 *   5. On `'tool_call'` events → `cb.add(makeToolEvent(...))` and
 *      attach the id to the assistant event via `cb.patch(ansId, { toolCallIds })`.
 *   6. On `'done'` → read `usage` and emit a `usage` event; finish
 *      both thinking and assistant.
 *   7. On `'error'` → emit an `error` event and finish any pending
 *      streaming events so the UI doesn't show a dangling spinner.
 */
import type { OllamaClient, OllamaStream, ChatResponse, ChatStreamResult, Message } from '@nemesis-oss/ollama-sdk';
import type { OllamaStreamEvent } from '@nemesis-oss/ollama-sdk';
import {
  makeAssistantEvent,
  makeErrorEvent,
  makeThinkingEvent,
  makeToolEvent,
  makeUsageEvent,
  type TranscriptCallbacks,
} from './index.js';

export interface RunOllamaChatOptions {
  /** Model id, e.g. 'qwen3:8b'. */
  readonly model: string;
  /** Conversation history (caller includes the latest user message). */
  readonly messages: readonly Message[];
  /** Whether to enable thinking tokens (default true). */
  readonly think?: boolean;
  /** Optional AbortSignal to cancel the stream mid-flight. */
  readonly signal?: AbortSignal;
  /** Context window for the model — used to emit `usage` events. */
  readonly contextWindow?: number;
}

export interface RunOllamaChatResult {
  /** The transcript event id of the user-facing assistant message. */
  readonly assistantEventId: number;
  /** The transcript event id of the thinking message (if any). */
  readonly thinkingEventId: number;
  /** The final aggregated result from the Ollama stream. */
  readonly finalResult: ChatStreamResult;
  /** Wall-clock duration of the entire chat call. */
  readonly durationMs: number;
}

/**
 * Drive an Ollama chat stream into a `TranscriptCallbacks`. See file
 * header for the lifecycle contract.
 *
 * Errors are surfaced as `error` events in the transcript AND re-thrown
 * so the caller's `try/catch` can decide whether to retry, escalate
 * model, or report to the user.
 */
export async function runOllamaChat(
  client: OllamaClient,
  cb: TranscriptCallbacks,
  opts: RunOllamaChatOptions,
): Promise<RunOllamaChatResult> {
  const startedAt = Date.now();
  const thinkId = cb.nextId();
  cb.add(makeThinkingEvent(thinkId));
  const ansId = cb.nextId();
  cb.add(makeAssistantEvent(ansId));

  let stream: OllamaStream<ChatResponse, ChatStreamResult>;
  try {
    stream = await client.chatStream({
      model: opts.model,
      messages: opts.messages,
      think: opts.think ?? true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = err instanceof Error ? err.stack : undefined;
    cb.add(makeErrorEvent(cb.nextId(), 'ollama_unreachable', message, detail));
    cb.finish(thinkId, Date.now() - startedAt);
    cb.finish(ansId, Date.now() - startedAt);
    throw err;
  }

  let thinkingFinished = false;
  let finalResult: ChatStreamResult | undefined;
  let streamError: Error | undefined;
  const toolCallIds: number[] = [];

  try {
    for await (const ev of stream as AsyncIterable<OllamaStreamEvent<ChatResponse, ChatStreamResult>>) {
      switch (ev.type) {
        case 'thinking': {
          cb.append(thinkId, ev.data.delta);
          break;
        }
        case 'token': {
          // The first answer token implicitly finishes thinking — models
          // that emit thinking then answer have a clean transition, and
          // models that don't emit thinking at all are unaffected (the
          // thinking event stays empty and gets finished here too).
          if (!thinkingFinished) {
            cb.finish(thinkId, Date.now() - startedAt);
            thinkingFinished = true;
          }
          cb.append(ansId, ev.data.delta);
          break;
        }
        case 'tool_call': {
          const tc = ev.data.toolCall;
          const toolEventId = cb.nextId();
          cb.add(makeToolEvent(toolEventId, tc.function.name, tc.function.arguments, tc.id));
          toolCallIds.push(toolEventId);
          // Attach the new tool event id to the assistant event so the
          // renderer can show "this turn produced N tool calls".
          cb.patch(ansId, { toolCallIds: [...toolCallIds] });
          break;
        }
        case 'message': {
          // Raw chunk passthrough — we already handle 'token' for the
          // user-facing string. Ignore the raw message envelope here.
          break;
        }
        case 'done': {
          finalResult = ev.data.result;
          break;
        }
        case 'error': {
          streamError = ev.data.error;
          break;
        }
        default: {
          // Exhaustiveness check — if the SDK adds a new event type,
          // TypeScript flags this at compile time.
          const _exhaustive: never = ev;
          void _exhaustive;
        }
      }
    }
  } catch (err) {
    streamError = err instanceof Error ? err : new Error(String(err));
  }

  // Finish any still-streaming events — the UI must never be left with a
  // dangling spinner even if the stream errored mid-flight.
  if (!thinkingFinished) cb.finish(thinkId, Date.now() - startedAt);
  cb.finish(ansId, Date.now() - startedAt);

  // Emit usage event from the final result, if available.
  if (finalResult?.usage) {
    const u = finalResult.usage;
    const cw = opts.contextWindow ?? 32768;
    if (u.promptTokens > 0) cb.add(makeUsageEvent(cb.nextId(), 'input', u.promptTokens, cw));
    if (u.completionTokens > 0) cb.add(makeUsageEvent(cb.nextId(), 'output', u.completionTokens, cw));
    if (u.totalTokens > 0) cb.add(makeUsageEvent(cb.nextId(), 'total', u.totalTokens, cw));
  }

  if (streamError) {
    const message = streamError.message;
    const detail = streamError.stack;
    cb.add(makeErrorEvent(cb.nextId(), 'ollama_stream_error', message, detail));
    throw streamError;
  }

  if (!finalResult) {
    // Stream completed without a 'done' event — surface as an error.
    const err = new Error('Ollama stream completed without a done event');
    cb.add(makeErrorEvent(cb.nextId(), 'ollama_stream_incomplete', err.message));
    throw err;
  }

  return {
    assistantEventId: ansId,
    thinkingEventId: thinkId,
    finalResult,
    durationMs: Date.now() - startedAt,
  };
}
