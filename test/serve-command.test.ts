/**
 * `agent-tui serve` must stay up and answer requests. The process used to exit
 * right after listen() was called, before the socket bound. MCP is disabled so the
 * test does not depend on npx or uvx.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { test } from 'node:test';

const TOKEN = 'serve-test-token-0123456789';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('`serve` answers authenticated requests and keeps running', { timeout: 120_000 }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', 'serve', String(port)], {
    env: { ...process.env, AGENT_MCP: 'none', AGENT_API_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state: { exitCode: number | null | undefined } = { exitCode: undefined };
  child.on('exit', (code) => { state.exitCode = code; });
  const url = `http://127.0.0.1:${port}/health`;

  try {
    let status = 0;
    for (const deadline = Date.now() + 90_000; Date.now() < deadline && state.exitCode === undefined; ) {
      status = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.status, () => 0);
      if (status === 200) break;
      await sleep(250);
    }
    assert.equal(status, 200, `serve must answer an authenticated /health (exit code: ${state.exitCode})`);

    await sleep(1500);
    assert.equal(state.exitCode, undefined, 'serve must keep running after it starts listening');

    const unauthenticated = await fetch(url);
    assert.equal(unauthenticated.status, 401);
  } finally {
    child.kill('SIGTERM');
  }
});
