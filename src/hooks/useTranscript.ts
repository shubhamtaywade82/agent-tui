/**
 * src/hooks/useTranscript.ts
 *
 * React hook that wires the step-2 transcript event model + reducer +
 * callback contract into a live component. Returns `{ state, cb }`:
 *
 *   - `state` is the current `TranscriptState` (events + nextId).
 *   - `cb` is a `TranscriptCallbacks` instance that engine code
 *     (e.g. `runOllamaChat` from the step-3 bridge) calls to mutate
 *     the transcript. The hook's caller NEVER calls `dispatch`
 *     directly — it goes through `cb`.
 *
 * This hook is the only legitimate bridge between React and the
 * transcript. The engine code (Ollama bridge, future OpenAI bridge,
 * HTTP SSE server) is React-agnostic — it consumes
 * `TranscriptCallbacks`, which is a plain object.
 *
 * Usage:
 *   ```tsx
 *   const { state, cb } = useTranscript();
 *   // ...
 *   cb.add(makeUserEvent(cb.nextId(), 'hello'));
 *   await runOllamaChat(client, cb, { model, messages, ... });
 *   // state.events updates as the stream progresses.
 *   ```
 *
 * The `cb` object is memoized on `[dispatch, stateRef]` — `stateRef`
 * is a stable ref that always points at the latest state, so `cb`
 * stays referentially stable across renders (no consumer re-renders
 * caused by cb identity churn).
 */
import { useMemo, useReducer, useRef } from 'react';
import {
  createTranscriptCallbacks,
  initialTranscriptState,
  transcriptReducer,
  type TranscriptCallbacks,
  type TranscriptState,
} from '../transcript/index.js';

export interface UseTranscriptResult {
  readonly state: TranscriptState;
  readonly cb: TranscriptCallbacks;
  /** Reset the events array but preserve the id counter. */
  readonly clear: () => void;
}

export function useTranscript(): UseTranscriptResult {
  const [state, dispatch] = useReducer(transcriptReducer, initialTranscriptState);

  // Stable ref that always points at the latest state. This is what
  // `cb.nextId()` reads to mint new ids without forcing a re-render
  // every time state changes.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Memoize the callbacks object on dispatch + stateRef identity.
  // Both are stable: dispatch never changes (React guarantees this),
  // stateRef is a ref so its identity never changes.
  const cb = useMemo(
    () => createTranscriptCallbacks(dispatch, () => stateRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const clear = useMemo(() => () => dispatch({ type: 'clear' }), []);

  return { state, cb, clear };
}
