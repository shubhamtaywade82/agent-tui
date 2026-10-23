import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCodeTool, runShellTool } from '../src/toolbox/code.js';

const run = (tool: { execute: (a: any, c: any) => unknown }, args: Record<string, unknown>) =>
  Promise.resolve(tool.execute(args, {} as never)).then(String);

test('run_code executes JavaScript and returns stdout with exit 0', async () => {
  const out = await run(runCodeTool, { code: 'console.log(6 * 7)', timeoutMs: 10_000 });
  assert.match(out, /^Exit: 0/);
  assert.match(out, /42/);
});

test('run_code reports a thrown error as a non-zero exit with stderr', async () => {
  const out = await run(runCodeTool, { code: 'throw new Error("boom-marker")', timeoutMs: 10_000 });
  assert.match(out, /^Exit: 1/);
  assert.match(out, /boom-marker/);
});

test('run_code cannot read API keys from the parent environment', async () => {
  process.env.OPENAI_API_KEY = 'sk-should-not-leak-0123456789abcdef';
  try {
    const out = await run(runCodeTool, { code: 'console.log(String(process.env.OPENAI_API_KEY))', timeoutMs: 10_000 });
    assert.match(out, /undefined/);
    assert.ok(!out.includes('sk-should-not-leak'), 'the key must not reach model-run code');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('run_shell returns stdout and exit 0', async () => {
  const out = await run(runShellTool, { command: 'echo hello-shell' });
  assert.match(out, /^Exit: 0/);
  assert.match(out, /hello-shell/);
});

test('run_shell reports a non-zero exit status', async () => {
  const out = await run(runShellTool, { command: 'exit 3' });
  assert.match(out, /^Exit: 3/);
});

test('run_shell reports a timeout as a timeout, not as a generic failure', async () => {
  const out = await run(runShellTool, { command: 'sleep 5', timeoutMs: 500 });
  assert.match(out, /^Exit: timeout/);
  assert.match(out, /Timed out after 500 ms/);
});

test('run_shell refuses a command the policy blocks, and runs nothing', async () => {
  const out = await run(runShellTool, { command: 'rm -rf ~' });
  assert.match(out, /^Blocked by command policy/);
});
