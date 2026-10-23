import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCloneInvocation } from '../src/toolbox/files.js';
import { runProcess } from '../src/toolbox/process.js';

const TOKEN = 'ghp_TESTTOKEN123';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

test('the token never appears in clone argv or the repository URL', () => {
  const inv = buildCloneInvocation('https://github.com/acme/private.git', '/tmp/dest', 'main', TOKEN);
  assert.ok(!inv.args.join(' ').includes(TOKEN));
  assert.ok(!inv.args.join(' ').includes(BASIC));
  assert.deepEqual(inv.args, ['clone', '-b', 'main', 'https://github.com/acme/private.git', '/tmp/dest']);
});

test('the token is sent as a github.com-scoped Basic header in the child environment', () => {
  const inv = buildCloneInvocation('https://github.com/acme/private.git', '/tmp/dest', undefined, TOKEN);
  assert.equal(inv.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraHeader');
  assert.equal(inv.env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${BASIC}`);
});

test('no token or a non-GitHub host means no credentials are attached', () => {
  assert.deepEqual(buildCloneInvocation('https://github.com/acme/public.git', '/d', undefined, undefined).env, {});
  // The header is scoped to github.com, so a token for any other host is not attached.
  assert.deepEqual(buildCloneInvocation('https://gitlab.example.com/acme/x.git', '/d', undefined, TOKEN).env, {});
});

test('git reads the scoped header from the environment we pass it', async () => {
  const inv = buildCloneInvocation('https://github.com/acme/private.git', '/tmp/dest', undefined, TOKEN);
  const r = await runProcess('git', ['config', '--get', 'http.https://github.com/.extraHeader'], {
    timeoutMs: 10_000,
    maxBufferBytes: 1 << 20,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...inv.env },
  });
  assert.equal(r.exitCode, 0, r.stderr || r.errorMessage);
  assert.equal(r.stdout.trim(), `Authorization: Basic ${BASIC}`);
});
