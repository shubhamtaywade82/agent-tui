import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as providers from '../src/providers.js';
import { parseTextToolCalls } from '../src/utils/text-tool-calls.js';

test('parses <function> tags with named parameters, trimming values', () => {
  const calls = parseTextToolCalls('<function name="run_shell"><param name="command"> ls -la </param></function>');
  assert.deepEqual(calls, [{ function: { name: 'run_shell', arguments: { command: 'ls -la' } } }]);
});

test('parses <tool_call> JSON and defaults missing arguments to an object', () => {
  const calls = parseTextToolCalls('<tool_call>{"name":"calculator"}</tool_call><tool_call>{"name":"read_files","arguments":{"paths":["a"]}}</tool_call>');
  assert.deepEqual(calls.map((c) => c.function), [
    { name: 'calculator', arguments: {} },
    { name: 'read_files', arguments: { paths: ['a'] } },
  ]);
});

test('drops malformed JSON and nameless <tool_call> blocks without throwing', () => {
  const calls = parseTextToolCalls('<tool_call>{not json}</tool_call><tool_call>{"arguments":{}}</tool_call>ok');
  assert.deepEqual(calls, []);
});

test('returns <function> calls before <tool_call> calls from one text', () => {
  const calls = parseTextToolCalls('<function name="a"></function><tool_call>{"name":"b"}</tool_call>');
  assert.deepEqual(calls.map((c) => c.function.name), ['a', 'b']);
});

test('providers re-exports the same parser, so the two call sites cannot diverge', () => {
  assert.equal(providers.parseTextToolCalls, parseTextToolCalls);
});
