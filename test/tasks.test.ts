import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('task runtime persists tasks and enforces lifecycle limits', async () => {
  const originalDirectory = process.cwd();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'agent-tui-task-test-'));
  process.chdir(temporaryDirectory);

  try {
    const moduleUrl = new URL('../src/tasks.ts', import.meta.url).href;
    const { getTaskRuntime } = await import(moduleUrl);
    const runtime = getTaskRuntime();

    runtime.addTask({ id: 'complete-me', title: 'Complete task', objective: 'Verify completion' });
    runtime.addTask({ id: 'retry-me', title: 'Retry task', objective: 'Verify retry limit' });
    assert.throws(
      () => runtime.addTask({ id: 'complete-me', title: 'Duplicate', objective: 'Reject duplicate' }),
      /already exists/,
    );

    assert.equal(runtime.nextReady()?.id, 'complete-me');
    runtime.start('complete-me');
    runtime.complete('complete-me', { note: 'Reviewed and verified' });
    assert.equal(runtime.getTask('complete-me')?.status, 'completed');

    runtime.start('retry-me');
    assert.equal(runtime.fail('retry-me', 'First failure').status, 'pending');
    runtime.start('retry-me');
    assert.equal(runtime.fail('retry-me', 'Second failure').status, 'pending');
    runtime.start('retry-me');
    assert.equal(runtime.fail('retry-me', 'Final failure').status, 'blocked');
    assert.equal(runtime.nextReady(), undefined);

    const savedTasks = JSON.parse(readFileSync('.agent/tasks.json', 'utf8'));
    assert.equal(savedTasks.length, 2);
    assert.equal(savedTasks[0].note, 'Reviewed and verified');

    const { getTaskRuntime: reloadRuntime } = await import(`${moduleUrl}?reload`);
    assert.equal(reloadRuntime().getTask('retry-me')?.status, 'blocked');
  } finally {
    process.chdir(originalDirectory);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
