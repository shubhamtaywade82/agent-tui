/**
 * src/hooks/useElicitation.ts
 *
 * An async confirmation gate for dangerous tool calls. When the model
 * requests a tool that modifies the filesystem or executes commands,
 * the engine calls `requestElicitation(toolName, args, prompt)` which:
 *   1. Mints an elicitation event in the transcript (visible as a
 *      warning card with "Allow once" / "Allow session" / "Deny" buttons)
 *   2. Returns a Promise that RESOLVES only when the user clicks a
 *      response button in the TranscriptView
 *   3. The engine's `onToolCall` callback `await`s this promise — so
 *      tool execution is PAUSED until the user responds
 *
 * If the user denies, the engine returns a 'blocked' tool result without
 * executing the tool. If allowed, execution proceeds normally.
 *
 * The hook also tracks "allow_session" — once the user allows a tool
 * for the session, subsequent calls to the same tool name skip the
 * elicitation prompt entirely.
 *
 * Wiring:
 *   ```tsx
 *   const { requestElicitation, respondToElicitation, pendingCount } = useElicitation(cb);
 *
 *   // In the onToolCall callback:
 *   const onToolCall = async (tc) => {
 *     if (isDangerous(tc.function.name)) {
 *       const choice = await requestElicitation(tc.function.name, tc.function.arguments, `Allow ${tc.function.name}?`);
 *       if (choice === 'deny') return { result: 'User denied', status: 'blocked', durationMs: 0 };
 *     }
 *     // ... execute the tool
 *   };
 *
 *   // In TranscriptView:
 *   <TranscriptView onElicitationRespond={respondToElicitation} />
 *   ```
 */
import { useCallback, useRef, useState } from 'react';
import {
  makeElicitationEvent,
  makeElicitationResolutionPatch,
  type ElicitationChoice,
  type TranscriptCallbacks,
} from '../transcript/index.js';
import { canRememberForSession, effectiveChoice } from '../transcript/elicitation-policy.js';

/** A pending elicitation — the Deferred resolver is called when the user responds. */
interface PendingElicitation {
  readonly resolve: (choice: ElicitationChoice) => void;
  readonly createdAt: number;
  readonly toolName: string;
}

export interface UseElicitationResult {
  /**
   * Request user confirmation for a tool call. Creates an elicitation
   * event in the transcript and returns a Promise that resolves when the
   * user clicks a response button.
   *
   * If the user previously chose 'allow_session' for the same tool name,
   * the promise resolves immediately with 'allow_session' (no new event
   * is created — the session-level permission is cached).
   */
  readonly requestElicitation: (
    toolName: string,
    args: Record<string, unknown>,
    prompt: string,
  ) => Promise<ElicitationChoice>;

  /**
   * Pass this to TranscriptView's `onElicitationRespond` prop. Resolves
   * the pending promise + patches the elicitation event with the choice.
   */
  readonly respondToElicitation: (eventId: number, choice: ElicitationChoice) => void;

  /** Number of pending elicitations (for UI indicators). */
  readonly pendingCount: number;

  /** Reset the session-level permissions (e.g. on /clear). */
  readonly resetSessionPermissions: () => void;
}

export function useElicitation(cb: TranscriptCallbacks): UseElicitationResult {
  // Map: eventId → PendingElicitation (the resolver for that event)
  const pendingRef = useRef<Map<number, PendingElicitation>>(new Map());
  // Set of tool names the user chose to allow for the session
  const sessionAllowedRef = useRef<Set<string>>(new Set());
  // Counter for the pending count (triggers re-renders when changed)
  const [pendingCount, setPendingCount] = useState(0);

  const requestElicitation = useCallback(
    (
      toolName: string,
      args: Record<string, unknown>,
      prompt: string,
    ): Promise<ElicitationChoice> => {
      // Fast path: if the user already allowed this tool for the session,
      // skip the prompt entirely.
      if (canRememberForSession(toolName) && sessionAllowedRef.current.has(toolName)) {
        return Promise.resolve('allow_session' as ElicitationChoice);
      }

      // Create the elicitation event + add it to the transcript.
      const eventId = cb.nextId();
      cb.add(makeElicitationEvent(eventId, toolName, args, prompt));

      // Return a Promise that resolves when the user responds.
      return new Promise<ElicitationChoice>((resolve) => {
        pendingRef.current.set(eventId, {
          resolve,
          createdAt: Date.now(),
          toolName,
        });
        setPendingCount(pendingRef.current.size);
      });
    },
    [cb],
  );

  const respondToElicitation = useCallback(
    (eventId: number, choice: ElicitationChoice) => {
      // Look up the pending elicitation to get the tool name.
      const pending = pendingRef.current.get(eventId);
      // 'allow_session' applies only to tools that may be remembered; for the rest it is one call.
      const applied = pending ? effectiveChoice(pending.toolName, choice) : choice;

      // Patch the elicitation event with the choice that actually applies.
      cb.patch(eventId, makeElicitationResolutionPatch(applied));

      // Cache the permission so future calls to the same tool skip the prompt.
      if (applied === 'allow_session' && pending) {
        sessionAllowedRef.current.add(pending.toolName);
      }

      // Resolve the pending promise.
      if (pending) {
        pending.resolve(applied);
        pendingRef.current.delete(eventId);
        setPendingCount(pendingRef.current.size);
      }
    },
    [cb],
  );

  const resetSessionPermissions = useCallback(() => {
    sessionAllowedRef.current.clear();
    // Also reject any pending elicitations (they'll never resolve now)
    for (const [, pending] of pendingRef.current) {
      pending.resolve('deny' as ElicitationChoice);
    }
    pendingRef.current.clear();
    setPendingCount(0);
  }, []);

  return {
    requestElicitation,
    respondToElicitation,
    pendingCount,
    resetSessionPermissions,
  };
}
