/**
 * src/transcript/callbacks.ts
 *
 * The callback contract that the agent engine consumes. The engine never
 * touches `dispatch(...)` directly — it goes through these methods, which
 * wrap `dispatch({ type, ... })`.
 *
 * Why a separate layer instead of just passing `dispatch` to the engine?
 *   1. Engine code stays decoupled from React. `useReducer`'s dispatch
 *      is a React-specific function; the engine should be testable and
 *      runnable without a React reconciler attached.
 *   2. The HTTP SSE server (already exists in src/server.ts) can implement
 *      the same `TranscriptCallbacks` interface and forward events to
 *      connected browsers. No engine change required.
 *   3. The engine stays dumb about ids — `add()` mints them via `nextId`,
 *      so engine code that streams thinking tokens doesn't have to do
 *      `const id = state.nextId; dispatch({type:'add', ev: {...}});` and
 *      risk racing with another concurrent dispatch.
 *
 * Usage from the engine:
 *   ```ts
 *   const thinkId = cb.nextId();
 *   cb.add({ kind: 'thinking', id: thinkId, text: '', streaming: true, timestamp: Date.now() });
 *   for await (const chunk of stream) {
 *     if (chunk.type === 'thinking') cb.append(thinkId, chunk.delta);
 *   }
 *   cb.finish(thinkId, Date.now() - startedAt);
 *   ```
 *
 * The engine reads `thinkId` once and uses it for the whole lifecycle of
 * that thinking event — no risk of dispatch ordering bugs.
 */
import type { Dispatch } from 'react';
import type { ElicitationChoice, ElicitationEvent, PlanStatus, ToolStatus, TranscriptEvent, UsageScope } from './types.js';
import type { TranscriptAction, TranscriptState } from './types.js';
import { mintId } from './types.js';

export interface TranscriptCallbacks {
  /** Mint the next event id from the state's counter. */
  nextId(): number;
  /** Append a new event to the transcript. */
  add(ev: TranscriptEvent): void;
  /** Append a text delta to an existing streaming event (thinking / assistant). Hot path. */
  append(id: number, delta: string): void;
  /** Merge a partial patch onto an existing event. Refuses to mutate `kind` or `id`. */
  patch(id: number, patch: Readonly<Record<string, unknown>>): void;
  /** Flip `streaming: false` on an event and stamp the duration. Idempotent. */
  finish(id: number, durationMs?: number): void;
  /** Drop events before `keepFromIndex`. Used by the context-compaction layer. */
  truncate(keepFromIndex: number): void;
  /** Reset the events array but preserve the id counter. */
  clear(): void;
}

/**
 * Build a `TranscriptCallbacks` from a React `dispatch` function plus a
 * state getter. The state getter is needed so `nextId()` can read the
 * current counter without making the engine wait for the next render.
 *
 * Typical wiring (in a hook):
 *   ```ts
 *   const [state, dispatch] = useReducer(transcriptReducer, initialTranscriptState);
 *   const cb = useMemo(() => createTranscriptCallbacks(dispatch, () => state), [dispatch, state]);
 *   ```
 */
export function createTranscriptCallbacks(
  dispatch: Dispatch<TranscriptAction>,
  getState: () => TranscriptState,
): TranscriptCallbacks {
  return {
    nextId() {
      return mintId(getState());
    },
    add(ev) {
      dispatch({ type: 'add', ev });
    },
    append(id, delta) {
      dispatch({ type: 'append', id, delta });
    },
    patch(id, patch) {
      dispatch({ type: 'patch', id, patch });
    },
    finish(id, durationMs) {
      dispatch({ type: 'finish', id, durationMs });
    },
    truncate(keepFromIndex) {
      dispatch({ type: 'truncate', keepFromIndex });
    },
    clear() {
      dispatch({ type: 'clear' });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Convenience factories
 *
 * These produce ready-to-dispatch TranscriptEvent objects. Engine code
 * usually wants the raw `{ kind, ... }` literal form for clarity, but
 * for the common shapes (plan, tool, error, usage, elicitation) the
 * factories cut boilerplate and ensure required fields are present.
 * ------------------------------------------------------------------ */

export function makeUserEvent(id: number, text: string): TranscriptEvent {
  return { kind: 'user', id, text, timestamp: Date.now() };
}

export function makeThinkingEvent(id: number): TranscriptEvent {
  return { kind: 'thinking', id, text: '', streaming: true, timestamp: Date.now() };
}

export function makeAssistantEvent(id: number): TranscriptEvent {
  return { kind: 'assistant', id, text: '', streaming: true, timestamp: Date.now() };
}

export function makePlanEvent(
  id: number,
  taskId: string,
  title: string,
  objective: string,
  maxAttempts = 3,
): TranscriptEvent {
  return {
    kind: 'plan',
    id,
    taskId,
    title,
    objective,
    status: 'pending',
    attempts: 0,
    maxAttempts,
    timestamp: Date.now(),
  };
}

export function makeToolEvent(
  id: number,
  name: string,
  args: Record<string, unknown>,
  toolCallId?: string,
): TranscriptEvent {
  return {
    kind: 'tool',
    id,
    name,
    arguments: args,
    status: 'running' as ToolStatus,
    timestamp: Date.now(),
    toolCallId,
  };
}

export function makeErrorEvent(id: number, category: string, message: string, detail?: string): TranscriptEvent {
  return { kind: 'error', id, category, message, timestamp: Date.now(), detail };
}

export function makeUsageEvent(id: number, scope: UsageScope, tokens: number, contextWindow: number): TranscriptEvent {
  return { kind: 'usage', id, scope, tokens, contextWindow, timestamp: Date.now() };
}

export function makeElicitationEvent(
  id: number,
  toolName: string,
  args: Record<string, unknown>,
  prompt: string,
): TranscriptEvent {
  return { kind: 'elicitation', id, toolName, arguments: args, prompt, timestamp: Date.now() };
}

/** Patch helper for resolving an elicitation — keeps the engine terse. */
export function makeElicitationResolutionPatch(choice: ElicitationChoice): Readonly<Record<string, unknown>> {
  return { choice, resolvedAt: Date.now() };
}

/** Patch helper for a plan status transition. */
export function makePlanStatusPatch(
  status: PlanStatus,
  extra: { failureReason?: string; note?: string; attempts?: number } = {},
): Readonly<Record<string, unknown>> {
  return { status, ...extra };
}

/**
 * Patch helper for a completed tool call.
 *
 * Status resolution:
 *   - If `statusOverride` is provided, use it directly (e.g. `'blocked'`
 *     when the ToolCallLedger short-circuits a duplicate call).
 *   - Otherwise: `error` is set → `'error'`, else → `'success'`.
 */
export function makeToolResultPatch(
  result: string,
  durationMs: number,
  error?: string,
  statusOverride?: 'success' | 'error' | 'blocked',
): Readonly<Record<string, unknown>> {
  const status = statusOverride
    ? (statusOverride as ToolStatus)
    : error
      ? ('error' as ToolStatus)
      : ('success' as ToolStatus);
  return {
    status,
    result,
    durationMs,
    ...(error ? { error } : {}),
  };
}

/** Type-guard helper — re-exported here so engine code can import everything from `transcript/`. */
export type { ElicitationEvent };
