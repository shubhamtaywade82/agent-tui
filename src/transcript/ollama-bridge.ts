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
 * Lifecycle (single turn):
 *   1. `cb.add(makeUserEvent(...))` is the CALLER's job, not this
 *      function's — the engine knows the user message text, this
 *      function only consumes the model's reply.
 *   2. This function mints a thinking event id + an assistant event id
 *      via `cb.nextId()`, adds them, then iterates the stream.
 *   3. On `'thinking'` events → `cb.append(thinkId, delta)`.
 *   4. On `'token'` events → `cb.append(ansId, delta)`.
 *      The first token that arrives implicitly finishes thinking.
 *   5. On `'tool_call'` events → `cb.add(makeToolEvent(...))` and
 *      attach the id to the assistant event via `cb.patch(ansId, { toolCallIds })`.
 *   6. On `'done'` → read `usage` and emit a `usage` event; finish
 *      both thinking and assistant.
 *   7. On `'error'` → emit an `error` event and finish any pending
 *      streaming events so the UI doesn't show a dangling spinner.
 *
 * Multi-turn tool-use loop (step 5 batch 4):
 *   If `onToolCall` is provided AND the model emitted tool_calls, the
 *   bridge executes each call, patches the corresponding `tool` event
 *   with the result via `makeToolResultPatch`, builds Ollama-format
 *   tool result messages, and recursively calls itself with the
 *   extended message list. Each iteration mints fresh thinking +
 *   assistant events so the transcript shows the full agent loop:
 *
 *     user(1) → thinking(2) → assistant(3) → tool(4) → tool(5)
 *     → thinking(6) → assistant(7, final answer) → usage(8)
 *
 *   The loop stops when:
 *   - The model's response has no tool_calls (final answer), OR
 *   - `maxToolIterations` is reached (default 5), OR
 *   - `onToolCall` was not provided (tool calls are recorded as
 *     events but not executed — useful for dry-run / display-only
 *     modes).
 */
import type { OllamaClient, OllamaStream, ChatResponse, ChatStreamResult, Message, ToolCall } from '@nemesis-oss/ollama-sdk';
import type { OllamaStreamEvent } from '@nemesis-oss/ollama-sdk';
import {
  makeAssistantEvent,
  makeErrorEvent,
  makeThinkingEvent,
  makeToolEvent,
  makeToolResultPatch,
  makeUsageEvent,
  type TranscriptCallbacks,
} from './index.js';

/** Result of executing a single tool call. */
export interface ToolExecutionOutcome {
  /** The stringified result the model will see in the next turn. */
  readonly result: string;
  /** Short error reason if execution failed. */
  readonly error?: string;
  /** Wall-clock duration in ms. */
  readonly durationMs: number;
  /**
   * Optional status override. Default behavior: if `error` is set the
   * status is `'error'`, otherwise `'success'`. Set to `'blocked'`
   * when the engine short-circuits execution (e.g. the ToolCallLedger
   * detected a repeated identical call) — the tool event will render
   * with the `⊘` icon and a different color in TranscriptView.
   */
  readonly status?: 'success' | 'error' | 'blocked';
}

/**
 * Callback the engine provides to execute tool calls. Receives the
 * `ToolCall` the model emitted; returns the result + duration. The
 * bridge handles all transcript bookkeeping (patching the `tool` event
 * with the result, building the tool result message for the next turn).
 *
 * Implementations typically delegate to a `ToolRegistry`:
 *
 *   ```ts
 *   const onToolCall = async (tc) => {
 *     const startedAt = Date.now();
 *     const results = await registry.executeToolCalls([tc]);
 *     const r = results[0];
 *     return {
 *       result: r.outputString || (r.success ? 'Success' : 'Error'),
 *       error: r.success ? undefined : r.error.message,
 *       durationMs: Date.now() - startedAt,
 *     };
 *   };
 *   ```
 *
 * To short-circuit a call (e.g. via a ToolCallLedger that detects
 * duplicate calls and returns a cached "blocked" message), return:
 *
 *   ```ts
 *   const blocked = ledger.beforeExecute(name, args);
 *   if (blocked) {
 *     return { result: blocked, status: 'blocked', durationMs: 0 };
 *   }
 *   ```
 */
export type OnToolCall = (toolCall: ToolCall) => Promise<ToolExecutionOutcome>;

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
  /**
   * Optional tool execution callback. If provided, the bridge executes
   * each tool_call, patches the corresponding `tool` event with the
   * result, and recursively calls itself with the extended message
   * list (multi-turn agent loop). If omitted, tool calls are recorded
   * as events but NOT executed — the bridge returns after the first
   * model turn.
   */
  readonly onToolCall?: OnToolCall;
  /**
   * Maximum number of tool-use iterations before the loop stops.
   * Default 5. Includes the initial turn, so `maxToolIterations=1`
   * means "no tool use even if the model requests it".
   */
  readonly maxToolIterations?: number;
}

export interface RunOllamaChatResult {
  /** The transcript event id of the FINAL assistant message (last turn). */
  readonly assistantEventId: number;
  /** The transcript event id of the FINAL thinking message (last turn). */
  readonly thinkingEventId: number;
  /** The final aggregated result from the Ollama stream (last turn). */
  readonly finalResult: ChatStreamResult;
  /** Wall-clock duration of the entire chat call (all iterations). */
  readonly durationMs: number;
  /** How many model turns ran (1 = no tool use, 2 = one round of tool use, etc.). */
  readonly iterations: number;
  /** Whether the loop stopped because maxToolIterations was reached. */
  readonly hitIterationLimit: boolean;
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
  const maxIterations = opts.maxToolIterations ?? 5;
  const startedAt = Date.now();
  let iterations = 0;
  let hitIterationLimit = false;

  // The message list grows across iterations as we append the model's
  // tool_calls message and the tool result messages.
  let currentMessages = [...opts.messages];

  // Track the latest turn's event ids so we can return them at the end.
  let lastAssistantEventId = 0;
  let lastThinkingEventId = 0;
  let lastFinalResult: ChatStreamResult | undefined;

  // Loop: each iteration is one model turn. The first iteration is
  // always run. Subsequent iterations only run if (a) onToolCall is
  // provided AND (b) the previous turn produced tool_calls.
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    iterations++;
    const turnResult = await runSingleTurn(client, cb, {
      model: opts.model,
      messages: currentMessages,
      think: opts.think ?? true,
      signal: opts.signal,
      contextWindow: opts.contextWindow,
      startedAt,
    });
    lastAssistantEventId = turnResult.assistantEventId;
    lastThinkingEventId = turnResult.thinkingEventId;
    lastFinalResult = turnResult.finalResult;

    // If onToolCall is not provided OR the model didn't emit any tool
    // calls, the loop ends here — we have a final answer.
    if (!opts.onToolCall) break;
    const toolCalls = turnResult.toolCalls;
    if (!toolCalls || toolCalls.length === 0) break;

    // The model asked for tools — execute them, patch the tool events
    // with results, and extend the message list for the next turn.
    const toolResultMessages: Message[] = [];

    // First, append the assistant message that requested the tool calls
    // (so the model sees the full conversation including its own tool
    // request). Ollama's wire format requires this.
    toolResultMessages.push({
      role: 'assistant',
      content: turnResult.assistantContent || '',
      tool_calls: toolCalls,
    });

    // Execute each tool call. Sequential execution keeps the transcript
    // order stable (parallel would interleave append events confusingly).
    for (const tc of toolCalls) {
      const toolEventId = turnResult.toolCallToEventId.get(tc.id ?? tc.function.name) ?? -1;
      const execStartedAt = Date.now();
      try {
        const outcome = await opts.onToolCall(tc);
        // Patch the tool event with the result + duration + status.
        // `outcome.status` lets the engine signal 'blocked' (e.g. the
        // ToolCallLedger short-circuited a duplicate call) — the tool
        // event then renders with the ⊘ icon in TranscriptView.
        cb.patch(
          toolEventId,
          makeToolResultPatch(outcome.result, outcome.durationMs, outcome.error, outcome.status),
        );
        toolResultMessages.push({
          role: 'tool',
          content: outcome.result,
          tool_name: tc.function.name,
          tool_call_id: tc.id,
        } as Message);
      } catch (err) {
        // The onToolCall callback itself threw (unexpected). Surface
        // as a failed tool result + an error event in the transcript.
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - execStartedAt;
        cb.patch(
          toolEventId,
          makeToolResultPatch(`Execution threw: ${message}`, durationMs, message),
        );
        cb.add(makeErrorEvent(cb.nextId(), 'tool_callback_threw', message));
        toolResultMessages.push({
          role: 'tool',
          content: `Execution threw: ${message}`,
          tool_name: tc.function.name,
          tool_call_id: tc.id,
        } as Message);
      }
    }

    // Extend the running message list and loop.
    currentMessages = [...currentMessages, ...toolResultMessages];

    // If this was the last allowed iteration, mark the limit hit so
    // the caller knows the model was cut off mid-agent-loop.
    if (iteration === maxIterations - 1) {
      hitIterationLimit = true;
    }
  }

  if (!lastFinalResult) {
    // Should be unreachable — the loop runs at least one iteration.
    const err = new Error('runOllamaChat produced no final result');
    cb.add(makeErrorEvent(cb.nextId(), 'bridge_no_final_result', err.message));
    throw err;
  }

  return {
    assistantEventId: lastAssistantEventId,
    thinkingEventId: lastThinkingEventId,
    finalResult: lastFinalResult,
    durationMs: Date.now() - startedAt,
    iterations,
    hitIterationLimit,
  };
}

/* ------------------------------------------------------------------ *
 * Single-turn helper — drives one chatStream call into the transcript.
 * Internal; not exported. Returns the tool calls the model emitted
 * (if any) so the outer loop can decide whether to execute them.
 * ------------------------------------------------------------------ */

interface SingleTurnResult {
  readonly assistantEventId: number;
  readonly thinkingEventId: number;
  readonly finalResult: ChatStreamResult;
  /** Tool calls the model emitted this turn. */
  readonly toolCalls: readonly ToolCall[];
  /** The assistant message content (for appending to history on multi-turn). */
  readonly assistantContent: string;
  /** Maps each tool call's SDK id → the transcript tool event id. */
  readonly toolCallToEventId: Map<string, number>;
}

interface SingleTurnOptions {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly think: boolean;
  readonly signal?: AbortSignal;
  readonly contextWindow?: number;
  readonly startedAt: number;
}

async function runSingleTurn(
  client: OllamaClient,
  cb: TranscriptCallbacks,
  opts: SingleTurnOptions,
): Promise<SingleTurnResult> {
  const thinkId = cb.nextId();
  cb.add(makeThinkingEvent(thinkId));
  const ansId = cb.nextId();
  cb.add(makeAssistantEvent(ansId));

  let stream: OllamaStream<ChatResponse, ChatStreamResult>;
  try {
    stream = await client.chatStream({
      model: opts.model,
      messages: opts.messages,
      think: opts.think,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = err instanceof Error ? err.stack : undefined;
    cb.add(makeErrorEvent(cb.nextId(), 'ollama_unreachable', message, detail));
    cb.finish(thinkId, Date.now() - opts.startedAt);
    cb.finish(ansId, Date.now() - opts.startedAt);
    throw err;
  }

  let thinkingFinished = false;
  let finalResult: ChatStreamResult | undefined;
  let streamError: Error | undefined;
  const toolCallIds: number[] = [];
  const toolCallToEventId = new Map<string, number>();
  const collectedToolCalls: ToolCall[] = [];
  let assistantContent = '';

  try {
    for await (const ev of stream as AsyncIterable<OllamaStreamEvent<ChatResponse, ChatStreamResult>>) {
      switch (ev.type) {
        case 'thinking': {
          cb.append(thinkId, ev.data.delta);
          break;
        }
        case 'token': {
          if (!thinkingFinished) {
            cb.finish(thinkId, Date.now() - opts.startedAt);
            thinkingFinished = true;
          }
          cb.append(ansId, ev.data.delta);
          assistantContent += ev.data.delta;
          break;
        }
        case 'tool_call': {
          const tc = ev.data.toolCall;
          const toolEventId = cb.nextId();
          // Make up a stable id if the SDK didn't assign one — needed
          // to correlate the tool call with its event later.
          const callId = tc.id ?? `${tc.function.name}-${toolEventId}`;
          cb.add(makeToolEvent(toolEventId, tc.function.name, tc.function.arguments, callId));
          toolCallIds.push(toolEventId);
          toolCallToEventId.set(callId, toolEventId);
          collectedToolCalls.push({ id: callId, function: tc.function });
          cb.patch(ansId, { toolCallIds: [...toolCallIds] });
          break;
        }
        case 'message': {
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
          const _exhaustive: never = ev;
          void _exhaustive;
        }
      }
    }
  } catch (err) {
    streamError = err instanceof Error ? err : new Error(String(err));
  }

  if (!thinkingFinished) cb.finish(thinkId, Date.now() - opts.startedAt);
  cb.finish(ansId, Date.now() - opts.startedAt);

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
    const err = new Error('Ollama stream completed without a done event');
    cb.add(makeErrorEvent(cb.nextId(), 'ollama_stream_incomplete', err.message));
    throw err;
  }

  return {
    assistantEventId: ansId,
    thinkingEventId: thinkId,
    finalResult,
    toolCalls: collectedToolCalls,
    assistantContent,
    toolCallToEventId,
  };
}
