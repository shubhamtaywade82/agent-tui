/**
 * test/ollama-bridge.test.ts — unit tests for the Ollama → transcript bridge.
 *
 * These tests do NOT hit a real Ollama daemon. They use a fake async
 * iterable that mimics the `OllamaStreamEvent` discriminated union,
 * so the bridge's event-handling logic is locked in without requiring
 * `localhost:11434` to be running.
 *
 * The fake client implements only `chatStream()` — that's the single
 * method the bridge touches.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createTranscriptCallbacks,
  initialTranscriptState,
  makeUserEvent,
  transcriptReducer,
  runOllamaChat,
} from '../src/transcript/index.js';
import type { Dispatch } from 'react';
import type {
  ChatResponse,
  ChatStreamResult,
  Message,
  OllamaStreamEvent,
  OllamaClient,
} from '@nemesis-oss/ollama-sdk';

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

interface FakeStreamOptions {
  readonly events: readonly OllamaStreamEvent<ChatResponse, ChatStreamResult>[];
  readonly finalResult?: ChatStreamResult;
}

/** Build a fake OllamaStream-like async iterable from a fixed event list. */
function makeFakeStream(opts: FakeStreamOptions) {
  const events = [...opts.events];
  const finalResult =
    opts.finalResult ??
    ({
      message: { role: 'assistant', content: '' },
      model: 'fake-model',
      done: true,
    } satisfies ChatStreamResult);

  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
    get finalResult() {
      return Promise.resolve(finalResult);
    },
    abort() {},
    on() {
      return this;
    },
    off() {
      return this;
    },
  };
  return stream;
}

/** Minimal fake OllamaClient that only implements chatStream(). */
function makeFakeClient(opts: FakeStreamOptions): Pick<OllamaClient, 'chatStream'> {
  return {
    // The fake stream implements AsyncIterable + finalResult + abort + on/off,
    // which is everything `runOllamaChat` actually touches. Cast to satisfy
    // the SDK's full OllamaStream class type.
    chatStream: async () => makeFakeStream(opts) as never,
  };
}

/** A reducer-driven state holder that records every action. */
function makeTestState() {
  let state: typeof initialTranscriptState = { ...initialTranscriptState };
  const calls: { type: string; id?: number; delta?: string; patch?: unknown }[] = [];
  const dispatch: Dispatch<{ type: string; id?: number; delta?: string; patch?: unknown }> = (action) => {
    calls.push(action);
    state = transcriptReducer(state, action as never);
  };
  const cb = createTranscriptCallbacks(dispatch as never, () => state);
  return { state, calls, cb, getState: () => state };
}

const baseMessages: Message[] = [{ role: 'user', content: 'hello' }];

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('ollama-bridge — happy path', () => {
  test('thinking tokens then answer tokens are appended to the right events', async () => {
    const { cb, getState } = makeTestState();
    const client = makeFakeClient({
      events: [
        { type: 'thinking', data: { delta: 'Reasoning...' } },
        { type: 'thinking', data: { delta: ' more.' } },
        { type: 'token', data: { delta: 'Answer' } },
        { type: 'token', data: { delta: ' text.' } },
        {
          type: 'done',
          data: {
            result: {
              message: { role: 'assistant', content: 'Answer text.' },
              model: 'fake',
              done: true,
              usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
            },
          },
        },
      ],
    });

    // Add a user event first so the transcript looks like a real conversation
    cb.add(makeUserEvent(cb.nextId(), 'hello'));

    const result = await runOllamaChat(client as unknown as OllamaClient, cb, {
      model: 'fake',
      messages: baseMessages,
      contextWindow: 32768,
    });

    assert.equal(result.thinkingEventId, 2);
    assert.equal(result.assistantEventId, 3);

    const events = getState().events;
    // 1 user + 1 thinking + 1 assistant + 3 usage = 6
    assert.equal(events.length, 6);
    assert.equal(events[0]?.kind, 'user');
    assert.equal(events[1]?.kind, 'thinking');
    assert.equal(events[2]?.kind, 'assistant');

    const think = events[1] as { text: string; streaming: boolean; durationMs?: number };
    assert.equal(think.text, 'Reasoning... more.');
    assert.equal(think.streaming, false);
    assert.equal(typeof think.durationMs, 'number');

    const ans = events[2] as { text: string; streaming: boolean; durationMs?: number };
    assert.equal(ans.text, 'Answer text.');
    assert.equal(ans.streaming, false);
    assert.equal(typeof ans.durationMs, 'number');

    // Usage events
    const usageEvents = events.filter((e) => e.kind === 'usage') as {
      scope: string;
      tokens: number;
    }[];
    assert.equal(usageEvents.length, 3);
    assert.deepEqual(
      usageEvents.map((u) => u.scope),
      ['input', 'output', 'total'],
    );
    assert.deepEqual(
      usageEvents.map((u) => u.tokens),
      [5, 3, 8],
    );
  });

  test('answer-only stream (no thinking tokens) finishes the empty thinking event cleanly', async () => {
    const { cb, getState } = makeTestState();
    const client = makeFakeClient({
      events: [
        { type: 'token', data: { delta: 'Hi' } },
        { type: 'token', data: { delta: ' there' } },
        {
          type: 'done',
          data: {
            result: {
              message: { role: 'assistant', content: 'Hi there' },
              model: 'fake',
              done: true,
              usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
            },
          },
        },
      ],
    });

    const result = await runOllamaChat(client as unknown as OllamaClient, cb, {
      model: 'fake',
      messages: baseMessages,
    });

    const events = getState().events;
    const think = events.find((e) => e.kind === 'thinking') as { text: string; streaming: boolean };
    assert.equal(think.text, '');
    assert.equal(think.streaming, false);

    const ans = events.find((e) => e.kind === 'assistant') as { text: string };
    assert.equal(ans.text, 'Hi there');

    assert.equal(result.thinkingEventId, 1);
    assert.equal(result.assistantEventId, 2);
  });
});

describe('ollama-bridge — tool calls', () => {
  test('tool_call events mint tool events and attach ids to the assistant event', async () => {
    const { cb, getState } = makeTestState();
    const client = makeFakeClient({
      events: [
        { type: 'token', data: { delta: 'Let me check.' } },
        {
          type: 'tool_call',
          data: {
            toolCall: {
              id: 'tc-1',
              function: { name: 'read_file', arguments: { path: '/etc/hosts' } },
            },
          },
        },
        {
          type: 'tool_call',
          data: {
            toolCall: {
              id: 'tc-2',
              function: { name: 'run_shell', arguments: { command: 'whoami' } },
            },
          },
        },
        { type: 'token', data: { delta: ' Done.' } },
        {
          type: 'done',
          data: {
            result: {
              message: { role: 'assistant', content: 'Let me check. Done.' },
              model: 'fake',
              done: true,
            },
          },
        },
      ],
    });

    const result = await runOllamaChat(client as unknown as OllamaClient, cb, {
      model: 'fake',
      messages: baseMessages,
    });

    const events = getState().events;
    const toolEvents = events.filter((e) => e.kind === 'tool');
    assert.equal(toolEvents.length, 2);
    assert.equal((toolEvents[0] as { name: string }).name, 'read_file');
    assert.equal((toolEvents[1] as { name: string }).name, 'run_shell');

    const ans = events.find((e) => e.kind === 'assistant') as { toolCallIds?: number[] };
    assert.deepEqual(ans.toolCallIds, [(events[2] as { id: number }).id, (events[3] as { id: number }).id]);
    assert.equal(result.assistantEventId, 2);
  });
});

describe('ollama-bridge — error paths', () => {
  test('chatStream() rejection emits an error event and finishes streaming events', async () => {
    const { cb, getState } = makeTestState();
    const client = {
      chatStream: async () => {
        throw new Error('Connection refused');
      },
    };

    await assert.rejects(
      () => runOllamaChat(client as unknown as OllamaClient, cb, { model: 'fake', messages: baseMessages }),
      /Connection refused/,
    );

    const events = getState().events;
    const think = events.find((e) => e.kind === 'thinking') as { streaming: boolean };
    const ans = events.find((e) => e.kind === 'assistant') as { streaming: boolean };
    const err = events.find((e) => e.kind === 'error') as { category: string; message: string };
    assert.equal(think.streaming, false);
    assert.equal(ans.streaming, false);
    assert.equal(err.category, 'ollama_unreachable');
    assert.equal(err.message, 'Connection refused');
  });

  test("stream 'error' event surfaces as an error event and re-throws", async () => {
    const { cb, getState } = makeTestState();
    const client = makeFakeClient({
      events: [
        { type: 'token', data: { delta: 'partial' } },
        {
          type: 'error',
          data: {
            error: new Error('Stream blew up') as unknown as never,
          },
        },
      ],
    });

    await assert.rejects(
      () => runOllamaChat(client as unknown as OllamaClient, cb, { model: 'fake', messages: baseMessages }),
      /Stream blew up/,
    );

    const events = getState().events;
    const err = events.find((e) => e.kind === 'error') as { category: string; message: string };
    assert.equal(err.category, 'ollama_stream_error');
    assert.equal(err.message, 'Stream blew up');

    // The partially-streamed assistant event still gets finished
    const ans = events.find((e) => e.kind === 'assistant') as { text: string; streaming: boolean };
    assert.equal(ans.text, 'partial');
    assert.equal(ans.streaming, false);
  });

  test('stream completing without a done event throws and emits an error', async () => {
    const { cb, getState } = makeTestState();
    const client = makeFakeClient({
      events: [{ type: 'token', data: { delta: 'orphan' } }],
      // Force an undefined finalResult — but the bridge reads it from the
      // 'done' event, not the stream's `.finalResult` property. So we just
      // omit the 'done' event entirely.
    });

    await assert.rejects(
      () => runOllamaChat(client as unknown as OllamaClient, cb, { model: 'fake', messages: baseMessages }),
      /completed without a done event/,
    );

    const events = getState().events;
    const err = events.find((e) => e.kind === 'error') as { category: string };
    assert.equal(err.category, 'ollama_stream_incomplete');
  });
});

describe('ollama-bridge — abort handling', () => {
  test('passes the AbortSignal through to chatStream', async () => {
    const { cb } = makeTestState();
    let receivedSignal: AbortSignal | undefined;
    const client = {
      chatStream: async (req: { signal?: AbortSignal }) => {
        receivedSignal = req.signal;
        return makeFakeStream({
          events: [
            {
              type: 'done',
              data: {
                result: {
                  message: { role: 'assistant', content: '' },
                  model: 'fake',
                  done: true,
                } satisfies ChatStreamResult,
              },
            },
          ],
        });
      },
    };

    const controller = new AbortController();
    await runOllamaChat(client as unknown as OllamaClient, cb, {
      model: 'fake',
      messages: baseMessages,
      signal: controller.signal,
    });
    assert.equal(receivedSignal, controller.signal);
  });
});
