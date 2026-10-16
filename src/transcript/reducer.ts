/**
 * src/transcript/reducer.ts
 *
 * Pure reducer for the transcript state. No React, no rendering, no I/O —
 * trivially unit-testable. The hot path is `append` (per-token patches at
 * ~50/sec; proven smooth in scratch/transcript-poc.tsx).
 *
 * Design notes:
 * - The reducer NEVER synthesizes event ids — the engine mints ids via
 *   `mintId(state)` and constructs full TranscriptEvent objects before
 *   dispatching `add`. This keeps the reducer dumb and the engine smart.
 * - `patch` is intentionally permissive: it merges the patch onto the
 *   existing event, but it FORBIDS mutating `kind` or `id` (would break
 *   the discriminated union and the React `key` prop). Violations throw.
 * - `finish` flips `streaming: false` and stamps `durationMs` if provided.
 *   It's idempotent — calling it on a non-streaming event is a no-op.
 * - `truncate` keeps events from `keepFromIndex` onward. Used by the
 *   context-compaction layer (NOT the engine itself) to drop stale events
 *   when the transcript grows past the context window.
 */
import {
  initialTranscriptState,
  type TranscriptAction,
  type TranscriptEvent,
  type TranscriptState,
} from './types.js';

const PROTECTED_KEYS = new Set(['kind', 'id']);

function appendText(ev: TranscriptEvent, delta: string): TranscriptEvent {
  if (ev.kind === 'thinking' || ev.kind === 'assistant') {
    return { ...ev, text: ev.text + delta } as TranscriptEvent;
  }
  return ev;
}

function finishStreaming(ev: TranscriptEvent, durationMs?: number): TranscriptEvent {
  if (ev.kind === 'thinking' || ev.kind === 'assistant') {
    if (!ev.streaming && durationMs === undefined) return ev;
    const patch: Partial<TranscriptEvent> = { streaming: false };
    if (durationMs !== undefined) (patch as { durationMs?: number }).durationMs = durationMs;
    return { ...ev, ...patch } as TranscriptEvent;
  }
  return ev;
}

function applyPatch(ev: TranscriptEvent, patch: Readonly<Record<string, unknown>>): TranscriptEvent {
  for (const key of Object.keys(patch)) {
    if (PROTECTED_KEYS.has(key)) {
      throw new Error(`transcript/patch: refusing to mutate protected key "${key}" on event ${ev.id}`);
    }
  }
  return { ...ev, ...patch } as TranscriptEvent;
}

export function transcriptReducer(
  state: TranscriptState = initialTranscriptState,
  action: TranscriptAction,
): TranscriptState {
  switch (action.type) {
    case 'add': {
      // The engine is responsible for setting ev.id === state.nextId before dispatch.
      // We don't second-guess it; we just advance the counter past whatever it sent.
      const nextId = Math.max(state.nextId, action.ev.id + 1);
      return { ...state, events: [...state.events, action.ev], nextId };
    }

    case 'append': {
      // Hot path — runs per token. Avoid building intermediate arrays.
      // Early-return the same state reference when nothing changed, so
      // React's `useReducer` skips the re-render entirely.
      let changed = false;
      const events = state.events.map((ev) => {
        if (ev.id !== action.id) return ev;
        const next = appendText(ev, action.delta);
        if (next === ev) return ev; // non-streaming kind — no-op
        changed = true;
        return next;
      });
      return changed ? { ...state, events } : state;
    }

    case 'patch': {
      let changed = false;
      const events = state.events.map((ev) => {
        if (ev.id !== action.id) return ev;
        const next = applyPatch(ev, action.patch);
        changed = true;
        return next;
      });
      return changed ? { ...state, events } : state;
    }

    case 'finish': {
      let changed = false;
      const events = state.events.map((ev) => {
        if (ev.id !== action.id) return ev;
        const next = finishStreaming(ev, action.durationMs);
        if (next === ev) return ev; // already finished, or non-streaming kind
        changed = true;
        return next;
      });
      return changed ? { ...state, events } : state;
    }

    case 'truncate': {
      if (action.keepFromIndex <= 0) return state;
      if (action.keepFromIndex >= state.events.length) return initialTranscriptState;
      return { ...state, events: state.events.slice(action.keepFromIndex) };
    }

    case 'clear': {
      return { ...initialTranscriptState, nextId: state.nextId };
    }

    default: {
      // Exhaustiveness check — if a new action type is added to the union
      // without a case here, TypeScript flags this line at compile time.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
