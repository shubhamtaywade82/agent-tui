import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProcess } from '../src/toolbox/process.js';

const NODE = process.execPath;

test('runProcess resolves with stdout and exit 0', async () => {
  const r = await runProcess(NODE, ['-e', 'process.stdout.write("hi")'], { timeoutMs: 10_000, maxBufferBytes: 1 << 20 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout, 'hi');
});

test('runProcess reports a non-zero exit code with stderr', async () => {
  const r = await runProcess(NODE, ['-e', 'process.stderr.write("boom"); process.exit(3)'], { timeoutMs: 10_000, maxBufferBytes: 1 << 20 });
  assert.equal(r.exitCode, 3);
  assert.equal(r.stderr, 'boom');
  assert.equal(r.timedOut, false);
});

test('runProcess kills a child that exceeds the timeout and flags it', async () => {
  const started = Date.now();
  const r = await runProcess(NODE, ['-e', 'setTimeout(() => {}, 30_000)'], { timeoutMs: 200, maxBufferBytes: 1 << 20 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.ok(Date.now() - started < 10_000, 'must not wait for the child to finish');
});

test('runProcess does not block the event loop while the child runs', async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  await runProcess(NODE, ['-e', 'setTimeout(() => {}, 300)'], { timeoutMs: 5_000, maxBufferBytes: 1 << 20 });
  clearInterval(timer);
  assert.ok(ticks >= 3, `event loop should keep ticking during the child (ticks=${ticks})`);
});

test('runProcess reports a missing binary as a spawn failure, not a timeout', async () => {
  const r = await runProcess('definitely-not-a-real-binary-xyz', [], { timeoutMs: 5_000, maxBufferBytes: 1 << 20 });
  assert.equal(r.exitCode, null);
  assert.equal(r.timedOut, false);
  assert.ok(r.errorMessage && r.errorMessage.length > 0);
});

test('runProcess runs through the shell only when asked', async () => {
  const shellRun = await runProcess('echo $((2+3))', [], { timeoutMs: 5_000, maxBufferBytes: 1 << 20, shell: true });
  assert.equal(shellRun.stdout.trim(), '5');
  const literal = await runProcess('echo $((2+3))', [], { timeoutMs: 5_000, maxBufferBytes: 1 << 20 });
  assert.notEqual(literal.stdout.trim(), '5');
});
