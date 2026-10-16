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
  ToolCall,
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

/* ------------------------------------------------------------------ *
 * Multi-turn tool execution (step 5 batch 4)
 * ------------------------------------------------------------------ */

describe('ollama-bridge — multi-turn tool execution', () => {
  /**
   * Fake client that returns a different stream each call. Useful for
   * simulating "first turn requests a tool, second turn gives the final
   * answer after seeing the tool result."
   */
  function makeMultiTurnClient(turns: readonly FakeStreamOptions[]): Pick<OllamaClient, 'chatStream'> {
    let call = 0;
    return {
      chatStream: async () => {
        const opts = turns[Math.min(call, turns.length - 1)]!;
        call++;
        return makeFakeStream(opts) as never;
      },
    };
  }

  /** A turn that requests a tool call. */
  function toolRequestTurn(toolName: string, args: Record<string, unknown>, toolCallId = 'tc-1') {
    return {
      events: [
        { type: 'token' as const, data: { delta: `Let me call ${toolName}.` } },
        {
          type: 'tool_call' as const,
          data: {
            toolCall: {
              id: toolCallId,
              function: { name: toolName, arguments: args },
            },
          },
        },
        {
          type: 'done' as const,
          data: {
            result: {
              message: {
                role: 'assistant' as const,
                content: `Let me call ${toolName}.`,
                tool_calls: [
                  { id: toolCallId, function: { name: toolName, arguments: args } },
                ],
              },
              model: 'fake',
              done: true,
              usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            } satisfies ChatStreamResult,
          },
        },
      ],
    } satisfies FakeStreamOptions;
  }

  /** A turn that gives the final answer (no tool calls). */
  function finalAnswerTurn(answer: string) {
    return {
      events: [
        { type: 'token' as const, data: { delta: answer } },
        {
          type: 'done' as const,
          data: {
            result: {
              message: { role: 'assistant' as const, content: answer },
              model: 'fake',
              done: true,
              usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
            } satisfies ChatStreamResult,
          },
        },
      ],
    } satisfies FakeStreamOptions;
  }

  test('executes tool calls and loops for a second turn', async () => {
    const { cb, getState } = makeTestState();
    const client = makeMultiTurnClient([
      toolRequestTurn('read_file', { path: '/etc/hosts' }, 'tc-1'),
      finalAnswerTurn('The file contains localhost entries.'),
    ]);
    const onToolCallCalls: string[] = [];
    const onToolCall = async (tc: { function: { name: string }; id?: string }) => {
      onToolCallCalls.push(tc.function.name);
      return {
        result: '127.0.0.1 localhost\n',
        durationMs: 8,
      };
    };

    const result = await runOllamaChat(client as unknown as OllamaClient, cb, {
      model: 'fake',
      messages: baseMessages,
      onToolCall,
    });

    // Two iterations: first requested the tool, second gave the final answer.
    assert.equal(result.iterations, 2);
    assert.equal(result.hitIterationLimit, false);
    assert.deepEqual(onToolCallCalls, ['read_file']);

    const events = getState().events;
    // Turn 1: thinking(2), assistant(3), tool(4)
    // Turn 2: thinking(5), assistant(6)
    // Plus usage events from each turn's finalResult
    const thinkEvents = events.filter((e) => e.kind === 'thinking');
    const assistantEvents = events.filter((e) => e.kind === 'assistant');
    const toolEvents = events.filter((e) => e.kind === 'tool');
    assert.equal(thinkEvents.length, 2, 'expected two thinking events (one per turn)');
    assert.equal(assistantEvents.length, 2, 'expected two assistant events (one per turn)');
    assert.equal(toolEvents.length, 1, 'expected one tool event');

    // The tool event should have been patched with the result + success status
    const tool = toolEvents[0] as { status: string; result: string; durationMs: number };
    assert.equal(tool.status, 'success');
    assert.equal(tool.result, '127.0.0.1 localhost\n');
    assert.equal(tool.durationMs, 8);

    // The final assistant event is the one returned in the result
    const finalAssistant = assistantEvents[1] as { text: string };
    assert.equal(finalAssistant.text, 'The file contains localhost entries.');
    assert.equal(result.assistantEventId, (assistantEvents[1] as { id: number }).id);
  });

  test('multiple tool calls in one turn are executed sequentially', async () => {
    const { cb, getState } = makeTestState();
    const client = makeMultiTurnClient([
      {
        events: [
          { type: 'token' as const, data: { delta: 'Checking both files.' } },
          {
            type: 'tool_call' as const,
            data: {
              toolCall: {
                id: 'tc-a',
                function: { name: 'read_file', arguments: { path: '/a' } },
              },
            },
          },
          {
            type: 'tool_call' as const,
            data: {
              toolCall: {
                id: 'tc-b',
                function: { name: 'read_file', arguments: { path: '/b' } },
              },
            },
          },
          {
            type: 'done' as const,
            data: {
              result: {
                message: {
                  role: 'assistant' as const,
                  content: 'Checking both files.',
                  tool_calls: [
                    { id: 'tc-a', function: { name: 'read_file', arguments: { path: '/a' } } },
                    { id: 'tc-b', function: { name: 'read_file', arguments: { path: '/b' } } },
                  ],
                },
                model: 'fake',
                done: true,
                usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
              } satisfies ChatStreamResult,
            },
          },
        ],
      },
      finalAnswerTurn('Both files exist.'),
    ]);

    const onToolCall = async (tc: ToolCall) => {
      const args = tc.function.arguments as { path?: string };
      return {
        result: `content of ${args.path ?? '/?'}`,
        durationMs: 5,
      };
    };

    const result = await runOllamaChat(client as unknown as OllamaClient, cb, {
      model: 'fake',
      messages: baseMessages,
      onToolCall,
    });

    assert.equal(result.iterations, 2);
    const toolEvents = getState().events.filter((e) => e.kind === 'tool');
    assert.equal(toolEvents.length, 2);
    const tool0 = toolEvents[0] as { result: string };
    const tool1 = toolEvents[1] as { result: string };
    assert.equal(tool0.result, 'content of /a');
    assert.equal(tool1.result, 'content of /b');
  });

  test('tool callback error is surfaced as a failed tool result + error event', async () => {
    const { cb, getState } = makeTestState();
    const client = makeMultiTurnClient([
      toolRequestTurn('run_shell', { command: 'rm -rf /' }, 'tc-bad'),
      finalAnswerTurn('Cannot proceed.'),
    ]);
    const onToolCall = async () => {
      throw new Error('Permission denied');
    };

    const result = await runOllamaChat(client as unknown as OllamaClient, cb, {
      model: 'fake',
      messages: baseMessages,
      onToolCall,
    });

    assert.equal(result.iterations, 2);
    const events = getState().events;
    const tool = events.find((e) => e.kind === 'tool') as { status: string; error: string };
    assert.equal(tool.status, 'error');
    assert.equal(tool.error, 'Permission denied');
    const errEvent = events.find((e) => e.kind === 'error') as { category: string };
    assert.equal(errEvent.category, 'tool_callback_threw');
  });

  test('maxToolIterations cuts off the agent loop and sets hitIterationLimit', async () => {
    const { cb } = makeTestState();
    // Each turn requests the same tool, so the loop never naturally ends.
    const client = makeMultiTurnClient([
      toolRequestTurn('loop_tool', {}),
      toolRequestTurn('loop_tool', {}),
      toolRequestTurn('loop_tool', {}),
    ]);
    const onToolCall = async () => ({ result: 'ok', durationMs: 1 });

    const result = await runOllamaChat(client as unknown as OllamaClient, cb, {
      model: 'fake',
      messages: baseMessages,
      onToolCall,
      maxToolIterations: 2,
    });

    assert.equal(result.iterations, 2);
    assert.equal(result.hitIterationLimit, true);
  });

  test('omitting onToolCall records tool_call events but does not execute', async () => {
    const { cb, getState } = makeTestState();
    const client = makeMultiTurnClient([toolRequestTurn('read_file', { path: '/x' })]);
    // No onToolCall — the bridge should record the tool call as an event
    // but NOT execute it or loop.
    const result = await runOllamaChat(client as unknown as OllamaClient, cb, {
      model: 'fake',
      messages: baseMessages,
    });
    assert.equal(result.iterations, 1);
    assert.equal(result.hitIterationLimit, false);
    const tool = getState().events.find((e) => e.kind === 'tool') as { status: string };
    // The tool event should remain in 'running' state since nothing executed it.
    assert.equal(tool.status, 'running');
  });

  test('final answer (no tool calls) does not loop', async () => {
    const { cb, getState } = makeTestState();
    const client = makeMultiTurnClient([finalAnswerTurn('Done.')]);
    const onToolCallCalls: string[] = [];
    const onToolCall = async (tc: { function: { name: string } }) => {
      onToolCallCalls.push(tc.function.name);
      return { result: 'unused', durationMs: 1 };
    };

    const result = await runOllamaChat(client as unknown as OllamaClient, cb, {
      model: 'fake',
      messages: baseMessages,
      onToolCall,
    });

    assert.equal(result.iterations, 1);
    assert.equal(onToolCallCalls.length, 0);
    // Only one thinking + one assistant event.
    const thinkEvents = getState().events.filter((e) => e.kind === 'thinking');
    const assistantEvents = getState().events.filter((e) => e.kind === 'assistant');
    assert.equal(thinkEvents.length, 1);
    assert.equal(assistantEvents.length, 1);
  });
});
