/**
 * test/transcript.test.ts — unit tests for the transcript event model + reducer.
 *
 * These tests intentionally do NOT render anything. The whole point of
 * step 2 is that the event model is testable without React, so engine
 * behavior is locked in before any UI work begins.
 *
 * Run with: `npm test` (the package.json test script chains these into
 * `node --import tsx --test ...`).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createTranscriptCallbacks,
  initialTranscriptState,
  makeAssistantEvent,
  makeElicitationEvent,
  makeElicitationResolutionPatch,
  makeErrorEvent,
  makePlanEvent,
  makePlanStatusPatch,
  makeSystemEvent,
  makeThinkingEvent,
  makeToolEvent,
  makeToolResultPatch,
  makeUsageEvent,
  makeUserEvent,
  transcriptReducer,
} from '../src/transcript/index.js';
import type { Dispatch } from 'react';
import type { TranscriptAction, TranscriptState } from '../src/transcript/index.js';

describe('transcript reducer — add', () => {
  test('add appends an event and advances nextId past it', () => {
    const state0 = initialTranscriptState;
    const state1 = transcriptReducer(state0, {
      type: 'add',
      ev: makeUserEvent(1, 'hello'),
    });
    assert.equal(state1.events.length, 1);
    assert.equal(state1.events[0]?.kind, 'user');
    assert.equal(state1.nextId, 2);
  });

  test('add tolerates engine-supplied ids that jump ahead (e.g. concurrent dispatches)', () => {
    const state0 = initialTranscriptState;
    const state1 = transcriptReducer(state0, { type: 'add', ev: makeUserEvent(42, 'big id') });
    assert.equal(state1.nextId, 43);
  });
});

describe('transcript reducer — append (hot path)', () => {
  test('append concatenates delta onto a thinking event text', () => {
    let state: TranscriptState = initialTranscriptState;
    state = transcriptReducer(state, { type: 'add', ev: makeThinkingEvent(1) });
    state = transcriptReducer(state, { type: 'append', id: 1, delta: 'Hello' });
    state = transcriptReducer(state, { type: 'append', id: 1, delta: ' world' });
    assert.equal(state.events[0]?.kind, 'thinking');
    assert.equal((state.events[0] as { text: string }).text, 'Hello world');
    assert.equal((state.events[0] as { streaming: boolean }).streaming, true);
  });

  test('append concatenates delta onto an assistant event text', () => {
    let state: TranscriptState = initialTranscriptState;
    state = transcriptReducer(state, { type: 'add', ev: makeAssistantEvent(1) });
    state = transcriptReducer(state, { type: 'append', id: 1, delta: 'answer' });
    assert.equal((state.events[0] as { text: string }).text, 'answer');
  });

  test('append on a non-streaming event kind (user) is a silent no-op', () => {
    let state: TranscriptState = initialTranscriptState;
    state = transcriptReducer(state, { type: 'add', ev: makeUserEvent(1, 'fixed') });
    state = transcriptReducer(state, { type: 'append', id: 1, delta: ' ignored' });
    assert.equal((state.events[0] as { text: string }).text, 'fixed');
  });

  test('append with unknown id does not throw and does not mutate state', () => {
    const state0 = transcriptReducer(initialTranscriptState, { type: 'add', ev: makeUserEvent(1, 'a') });
    const state1 = transcriptReducer(state0, { type: 'append', id: 999, delta: 'x' });
    assert.equal(state1.events.length, 1);
    assert.equal(state1, state0); // referentially identical — no events array rebuild
  });
});

describe('transcript reducer — patch', () => {
  test('patch merges a partial update onto an existing event', () => {
    let state: TranscriptState = initialTranscriptState;
    state = transcriptReducer(state, { type: 'add', ev: makeToolEvent(1, 'read_file', { path: '/x' }) });
    state = transcriptReducer(state, { type: 'patch', id: 1, patch: makeToolResultPatch('file contents', 12) });
    const ev = state.events[0] as { status: string; result: string; durationMs: number };
    assert.equal(ev.status, 'success');
    assert.equal(ev.result, 'file contents');
    assert.equal(ev.durationMs, 12);
  });

  test('patch refuses to mutate protected keys (kind, id)', () => {
    let state: TranscriptState = initialTranscriptState;
    state = transcriptReducer(state, { type: 'add', ev: makeToolEvent(1, 'read_file', {}) });
    assert.throws(
      () => transcriptReducer(state, { type: 'patch', id: 1, patch: { kind: 'assistant' } }),
      /refusing to mutate protected key "kind"/,
    );
    assert.throws(
      () => transcriptReducer(state, { type: 'patch', id: 1, patch: { id: 999 } }),
      /refusing to mutate protected key "id"/,
    );
  });

  test('patch on unknown id is a no-op (returns same state reference)', () => {
    const state0 = transcriptReducer(initialTranscriptState, { type: 'add', ev: makeUserEvent(1, 'a') });
    const state1 = transcriptReducer(state0, { type: 'patch', id: 999, patch: { status: 'success' } });
    assert.equal(state0, state1);
  });
});

describe('transcript reducer — finish', () => {
  test('finish flips streaming=false and stamps durationMs', () => {
    let state: TranscriptState = initialTranscriptState;
    state = transcriptReducer(state, { type: 'add', ev: makeThinkingEvent(1) });
    state = transcriptReducer(state, { type: 'finish', id: 1, durationMs: 2500 });
    const ev = state.events[0] as { streaming: boolean; durationMs: number };
    assert.equal(ev.streaming, false);
    assert.equal(ev.durationMs, 2500);
  });

  test('finish is idempotent on a non-streaming event', () => {
    let state: TranscriptState = initialTranscriptState;
    state = transcriptReducer(state, { type: 'add', ev: makeThinkingEvent(1) });
    state = transcriptReducer(state, { type: 'finish', id: 1, durationMs: 100 });
    const state1 = state;
    state = transcriptReducer(state, { type: 'finish', id: 1 });
    // streaming already false; durationMs is set; second call is a no-op.
    assert.equal(state, state1);
  });

  test('finish on a non-streaming kind (user) is a no-op', () => {
    let state: TranscriptState = initialTranscriptState;
    state = transcriptReducer(state, { type: 'add', ev: makeUserEvent(1, 'fixed') });
    const state1 = state;
    state = transcriptReducer(state, { type: 'finish', id: 1, durationMs: 999 });
    assert.equal(state, state1);
  });
});

describe('transcript reducer — truncate & clear', () => {
  test('truncate drops events before the index', () => {
    let state: TranscriptState = initialTranscriptState;
    state = transcriptReducer(state, { type: 'add', ev: makeUserEvent(1, 'a') });
    state = transcriptReducer(state, { type: 'add', ev: makeThinkingEvent(2) });
    state = transcriptReducer(state, { type: 'add', ev: makeAssistantEvent(3) });
    state = transcriptReducer(state, { type: 'truncate', keepFromIndex: 2 });
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0]?.kind, 'assistant');
    // nextId is preserved — engine can still mint new ids without collisions
    assert.equal(state.nextId, 4);
  });

  test('clear empties events but preserves nextId', () => {
    let state: TranscriptState = initialTranscriptState;
    state = transcriptReducer(state, { type: 'add', ev: makeUserEvent(1, 'a') });
    state = transcriptReducer(state, { type: 'add', ev: makeThinkingEvent(2) });
    state = transcriptReducer(state, { type: 'clear' });
    assert.equal(state.events.length, 0);
    assert.equal(state.nextId, 3);
  });
});

describe('transcript callbacks — engine contract', () => {
  /** A minimal fake `Dispatch` that records every action for assertions. */
  function makeFakeDispatch(getState: () => TranscriptState): Dispatch<TranscriptAction> & { calls: TranscriptAction[] } {
    const calls: TranscriptAction[] = [];
    const dispatch = ((action: TranscriptAction) => {
      calls.push(action);
      // Mutate the captured state so getState() reflects the latest reducer output
      // — this mirrors React's `useReducer` behavior where dispatch is synchronous.
      Object.assign(getState(), transcriptReducer(getState(), action));
    }) as unknown as Dispatch<TranscriptAction>;
    return Object.assign(dispatch, { calls });
  }

  test('nextId reads the state counter', () => {
    let state: TranscriptState = { ...initialTranscriptState };
    const dispatch = makeFakeDispatch(() => state);
    const cb = createTranscriptCallbacks(dispatch, () => state);
    assert.equal(cb.nextId(), 1);
    cb.add(makeUserEvent(1, 'first'));
    assert.equal(cb.nextId(), 2);
    cb.add(makeUserEvent(5, 'big jump'));
    assert.equal(cb.nextId(), 6);
  });

  test('add dispatches the right action shape', () => {
    let state: TranscriptState = { ...initialTranscriptState };
    const dispatch = makeFakeDispatch(() => state);
    const cb = createTranscriptCallbacks(dispatch, () => state);
    cb.add(makeUserEvent(1, 'hello'));
    assert.equal(dispatch.calls.length, 1);
    assert.equal(dispatch.calls[0]?.type, 'add');
  });

  test('append dispatches the right action shape', () => {
    let state: TranscriptState = { ...initialTranscriptState };
    const dispatch = makeFakeDispatch(() => state);
    const cb = createTranscriptCallbacks(dispatch, () => state);
    cb.add(makeThinkingEvent(1));
    cb.append(1, 'token');
    assert.equal(dispatch.calls[1]?.type, 'append');
    assert.equal((dispatch.calls[1] as { id: number; delta: string }).id, 1);
    assert.equal((dispatch.calls[1] as { id: number; delta: string }).delta, 'token');
  });

  test('finish dispatches the right action shape with duration', () => {
    let state: TranscriptState = { ...initialTranscriptState };
    const dispatch = makeFakeDispatch(() => state);
    const cb = createTranscriptCallbacks(dispatch, () => state);
    cb.add(makeThinkingEvent(1));
    cb.finish(1, 2500);
    assert.equal(dispatch.calls[1]?.type, 'finish');
    assert.equal((dispatch.calls[1] as { id: number; durationMs: number }).durationMs, 2500);
  });

  test('full lifecycle — user → thinking → assistant → finish', () => {
    let state: TranscriptState = { ...initialTranscriptState };
    const dispatch = makeFakeDispatch(() => state);
    const cb = createTranscriptCallbacks(dispatch, () => state);

    const userId = cb.nextId();
    cb.add(makeUserEvent(userId, 'Fix the auth test'));
    const thinkId = cb.nextId();
    cb.add(makeThinkingEvent(thinkId));
    cb.append(thinkId, 'Inspecting auth.test.ts... ');
    cb.append(thinkId, 'Found the off-by-one. ');
    cb.finish(thinkId, 2500);
    const ansId = cb.nextId();
    cb.add(makeAssistantEvent(ansId));
    cb.append(ansId, 'The fix is to align both sides on `<=`. ');
    cb.append(ansId, 'After patching, run `npm test auth`.');
    cb.finish(ansId, 5800);

    assert.equal(state.events.length, 3);
    assert.equal(state.events[0]?.kind, 'user');
    assert.equal(state.events[1]?.kind, 'thinking');
    assert.equal((state.events[1] as { streaming: boolean }).streaming, false);
    assert.equal((state.events[1] as { text: string }).text, 'Inspecting auth.test.ts... Found the off-by-one. ');
    assert.equal(state.events[2]?.kind, 'assistant');
    assert.equal((state.events[2] as { streaming: boolean }).streaming, false);
    assert.equal((state.events[2] as { durationMs: number }).durationMs, 5800);
  });

  test('full lifecycle — tool call with patch to success', () => {
    let state: TranscriptState = { ...initialTranscriptState };
    const dispatch = makeFakeDispatch(() => state);
    const cb = createTranscriptCallbacks(dispatch, () => state);
    const id = cb.nextId();
    cb.add(makeToolEvent(id, 'read_file', { path: '/etc/hosts' }));
    cb.patch(id, makeToolResultPatch('127.0.0.1 localhost\n', 8));
    const ev = state.events[0] as { status: string; result: string; durationMs: number };
    assert.equal(ev.status, 'success');
    assert.equal(ev.result, '127.0.0.1 localhost\n');
    assert.equal(ev.durationMs, 8);
  });

  test('full lifecycle — plan create → fail → blocked', () => {
    let state: TranscriptState = { ...initialTranscriptState };
    const dispatch = makeFakeDispatch(() => state);
    const cb = createTranscriptCallbacks(dispatch, () => state);
    const id = cb.nextId();
    cb.add(makePlanEvent(id, 'auth-fix', 'Fix auth test', 'Align expiresAt comparison', 3));
    cb.patch(id, makePlanStatusPatch('in_progress', { attempts: 1 }));
    cb.patch(id, makePlanStatusPatch('blocked', { attempts: 3, failureReason: 'Still failing after 3 attempts' }));
    const ev = state.events[0] as { status: string; attempts: number; failureReason: string };
    assert.equal(ev.status, 'blocked');
    assert.equal(ev.attempts, 3);
    assert.equal(ev.failureReason, 'Still failing after 3 attempts');
  });

  test('full lifecycle — elicitation create → user denies', () => {
    let state: TranscriptState = { ...initialTranscriptState };
    const dispatch = makeFakeDispatch(() => state);
    const cb = createTranscriptCallbacks(dispatch, () => state);
    const id = cb.nextId();
    cb.add(makeElicitationEvent(id, 'write_file', { path: '/etc/passwd' }, 'Allow write to /etc/passwd?'));
    cb.patch(id, makeElicitationResolutionPatch('deny'));
    const ev = state.events[0] as { choice: string; resolvedAt: number };
    assert.equal(ev.choice, 'deny');
    assert.equal(typeof ev.resolvedAt, 'number');
  });

  test('usage event is emitted for context-window tracking', () => {
    let state: TranscriptState = { ...initialTranscriptState };
    const dispatch = makeFakeDispatch(() => state);
    const cb = createTranscriptCallbacks(dispatch, () => state);
    cb.add(makeUsageEvent(cb.nextId(), 'total', 12345, 32768));
    const ev = state.events[0] as { scope: string; tokens: number; contextWindow: number };
    assert.equal(ev.scope, 'total');
    assert.equal(ev.tokens, 12345);
    assert.equal(ev.contextWindow, 32768);
  });

  test('error event carries a category and message', () => {
    let state: TranscriptState = { ...initialTranscriptState };
    const dispatch = makeFakeDispatch(() => state);
    const cb = createTranscriptCallbacks(dispatch, () => state);
    cb.add(makeErrorEvent(cb.nextId(), 'ollama_unreachable', 'Failed to connect to localhost:11434'));
    const ev = state.events[0] as { category: string; message: string };
    assert.equal(ev.category, 'ollama_unreachable');
    assert.equal(ev.message, 'Failed to connect to localhost:11434');
  });

  test('system event surfaces UI-level messages (compaction, skill_loaded, model_switch)', () => {
    let state: TranscriptState = { ...initialTranscriptState };
    const dispatch = makeFakeDispatch(() => state);
    const cb = createTranscriptCallbacks(dispatch, () => state);

    cb.add(makeSystemEvent(cb.nextId(), 'compacted', '5 events dropped: user → thinking → assistant'));
    cb.add(makeSystemEvent(cb.nextId(), 'skill_loaded', 'Loaded skill: rails-architect'));
    cb.add(makeSystemEvent(cb.nextId(), 'model_switch', 'Switched to qwen3:8b'));

    assert.equal(state.events.length, 3);
    const evs = [...state.events] as { kind: string; category: string; message: string }[];
    assert.equal(evs[0]?.kind, 'system');
    assert.equal(evs[0]?.category, 'compacted');
    assert.ok(evs[0]?.message.includes('5 events dropped'));
    assert.equal(evs[1]?.category, 'skill_loaded');
    assert.ok(evs[1]?.message.includes('rails-architect'));
    assert.equal(evs[2]?.category, 'model_switch');
    assert.ok(evs[2]?.message.includes('qwen3:8b'));
  });
});
