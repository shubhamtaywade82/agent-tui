import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { filterValidHistory, loadHistory, saveHistoryFile } from '../src/components/chat/history.js';
import { getMenuOptions } from '../src/components/chat/menu.js';
import { cleanContinuation, isPrematureStall } from '../src/components/chat/continuation.js';
import { prepareMessages } from '../src/components/chat/messages.js';
import { isDangerousTool } from '../src/transcript/elicitation-policy.js';
import { UNTRUSTED_CONTENT_RULE } from '../src/prompts.js';

test('filterValidHistory trims, drops entries of 3 characters or fewer, and removes duplicates', () => {
  assert.deepEqual(filterValidHistory(['  hello  ', 'hi', 'hello', 42 as unknown as string, 'bye now']), ['hello', 'bye now']);
});

test('input history round-trips through .history in the working directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hist-'));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    saveHistoryFile(['first prompt', 'second prompt']);
    assert.deepEqual(loadHistory(), ['first prompt', 'second prompt']);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getMenuOptions lists matching slash commands for a bare slash', () => {
  const names = getMenuOptions('/', []).map((o) => o.name);
  assert.ok(names.length > 0);
  assert.ok(names.every((n) => n.startsWith('/')));
});

test('getMenuOptions completes /model arguments from the model list', () => {
  const opts = getMenuOptions('/model qw', ['qwen3:8b', 'llama3:8b']);
  assert.deepEqual(opts.map((o) => o.name), ['/model qwen3:8b']);
});

test('getMenuOptions returns nothing for a one-character free-text prefix', () => {
  assert.deepEqual(getMenuOptions('a', ['x'], undefined, ['abc']), []);
});

test('getMenuOptions offers a history or template match for free text', () => {
  const opts = getMenuOptions('write unit', [], undefined, ['write unit tests for this function']);
  assert.equal(opts[0]?.name, 'write unit tests for this function');
});

test('cleanContinuation returns only the part the user has not typed yet', () => {
  assert.equal(cleanContinuation('tell me', 'tell me about rails'), 'about rails');
  assert.equal(cleanContinuation('same', 'same'), '');
});

test('isPrematureStall flags short narration that promises work instead of doing it', () => {
  assert.equal(isPrematureStall("Let me start by inspecting the repository."), true);
  assert.equal(isPrematureStall('Here is the summary you asked for. '.repeat(20)), false);
});

test('isDangerousTool classifies shell and write tools as dangerous and reads as safe', () => {
  assert.equal(isDangerousTool('run_shell'), true);
  assert.equal(isDangerousTool('write_file'), true);
  assert.equal(isDangerousTool('read_files'), false);
  assert.equal(isDangerousTool('calculator'), false);
});

test('prepareMessages puts the system prompt, with the untrusted-content rule, ahead of the history', () => {
  const out = prepareMessages([{ role: 'user', content: 'hi', timestamp: 1 }], undefined, 100000);
  const system = out.find((m) => m.role === 'system');
  assert.ok(system, 'a system message is added');
  assert.ok(String(system.content).includes(UNTRUSTED_CONTENT_RULE));
});
