import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetMessages, resolveMessageTokenBudget } from '../src/utils/context.js';
import { ToolCallLedger, fingerprintToolCall } from '../src/utils/tool-loop-guard.js';

test('resolveMessageTokenBudget subtracts tool schema and reserve from numCtx', () => {
  const bigTools = [{ type: 'function', function: { name: 'x', description: 'y'.repeat(8000) } }];
  const withoutTools = resolveMessageTokenBudget({
    configuredBudget: 50000,
    numCtx: 8192,
    reserveTokens: 2048,
  });
  const withTools = resolveMessageTokenBudget({
    configuredBudget: 50000,
    numCtx: 8192,
    toolDefs: bigTools,
    reserveTokens: 2048,
  });
  assert.ok(withTools < withoutTools);
  assert.ok(withTools >= 2048);
});

test('budgetMessages appends compaction hint when window slides', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a'.repeat(4000) },
    { role: 'assistant', content: 'b'.repeat(4000) },
    { role: 'user', content: 'recent' },
  ];
  const out = budgetMessages(msgs, 500, '[Working set] read_files(foo.ts)×1');
  assert.match(out[0]!.content, /Working set/);
  assert.ok(out.length < msgs.length);
});

test('ToolCallLedger blocks duplicate read_files on same path', () => {
  const ledger = new ToolCallLedger({ repeatLimit: 2 });
  const args = { paths: ['src/agent.ts'] };
  assert.equal(ledger.beforeExecute('read_files', args), null);
  ledger.afterExecute('read_files', args, 'file contents');
  assert.equal(ledger.beforeExecute('read_files', args), null);
  ledger.afterExecute('read_files', args, 'file contents again');
  const blocked = ledger.beforeExecute('read_files', args);
  assert.ok(blocked?.includes('Loop guard'));
});

test('fingerprintToolCall normalizes paths', () => {
  const a = fingerprintToolCall('read_files', { paths: ['a.ts'] });
  const b = fingerprintToolCall('read_files', { path: 'a.ts' });
  assert.equal(a, b);
});
