import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initLogger, log } from '../src/logger.js';
import { redactText, redactValue } from '../src/utils/redact.js';

const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
const OPENAI = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
const ANTHROPIC = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';

test('redactText removes provider tokens wherever they appear', () => {
  for (const secret of [GH, OPENAI, ANTHROPIC]) {
    assert.ok(!redactText(`echo ${secret} | tee out`).includes(secret), `leaked ${secret.slice(0, 6)}`);
  }
});

test('redactText removes bearer and basic authorization credentials', () => {
  assert.ok(!redactText('curl -H "Authorization: Bearer abcDEF123456xyz" https://api').includes('abcDEF123456xyz'));
  assert.ok(!redactText('curl -H "authorization: basic dXNlcjpwYXNz"').includes('dXNlcjpwYXNz'));
});

test('redactText removes credentials embedded in URLs', () => {
  const clone = redactText(`git clone https://x-access-token:${GH}@github.com/acme/app.git`);
  assert.ok(!clone.includes(GH));
  assert.ok(!redactText('psql postgres://admin:hunter2@db:5432/x').includes('hunter2'));
});

test('redactText removes secret assignments and flags', () => {
  assert.ok(!redactText('GITHUB_TOKEN=abc123xyz node run.js').includes('abc123xyz'));
  assert.ok(!redactText('OLLAMA_API_KEY=ollama-live-value run').includes('ollama-live-value'));
  assert.ok(!redactText('tool --token=supersecretvalue').includes('supersecretvalue'));
  assert.ok(!redactText('tool --password hunter2 --verbose').includes('hunter2'));
  assert.equal(redactText('ls -la /tmp'), 'ls -la /tmp', 'ordinary commands are left alone');
});

test('redactValue masks secret-named keys and keeps token counts', () => {
  const out = redactValue({
    inputTokens: 1234,
    outputTokens: 56,
    apiKey: 'live-key-value',
    githubToken: 'g-value',
    accessKey: 'minio-access',
    nested: { password: 'p', ok: 'fine' },
    cmd: `echo ${GH}`,
    list: [`see ${OPENAI}`, 7],
    empty: '',
  }) as Record<string, unknown>;
  assert.equal(out.inputTokens, 1234);
  assert.equal(out.outputTokens, 56);
  assert.equal(out.apiKey, '***');
  assert.equal(out.githubToken, '***');
  assert.equal(out.accessKey, '***');
  assert.deepEqual(out.nested, { password: '***', ok: 'fine' });
  assert.ok(!String(out.cmd).includes(GH));
  assert.ok(!String((out.list as unknown[])[0]).includes(OPENAI));
  assert.equal((out.list as unknown[])[1], 7);
  assert.equal(out.empty, '', 'empty secrets are not masked, so the log shows that none was set');
});

test('the logger writes redacted entries to disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redact-log-'));
  const file = join(dir, 'agent.log');
  try {
    initLogger('debug', file);
    log.info('run_shell', { cmd: `curl -H "Authorization: Bearer ${GH}" https://x`, apiKey: OPENAI });
    const written = readFileSync(file, 'utf8');
    assert.ok(written.includes('run_shell'), 'the entry is still written');
    assert.ok(!written.includes(GH), 'the token must not reach the log file');
    assert.ok(!written.includes(OPENAI), 'the key must not reach the log file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
