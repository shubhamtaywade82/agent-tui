import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiServer, resolveApiBinding } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { isBearerAuthorized } from '../src/utils/auth.js';

const TOKEN = 'test-token-0123456789abcdef';

let server: Server;
let base: string;

before(async () => {
  server = createApiServer(loadConfig(), { port: 0, token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('requests without a token are rejected with 401 and a Bearer challenge', async () => {
  const res = await fetch(`${base}/tools`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('wrong tokens are rejected, including ones of a different length', async () => {
  const wrongSameLength = 'x'.repeat(TOKEN.length);
  for (const bad of [wrongSameLength, 'short', `${TOKEN}extra`]) {
    const res = await fetch(`${base}/tools`, { headers: { authorization: `Bearer ${bad}` } });
    assert.equal(res.status, 401, `token ${bad.slice(0, 6)}… should be rejected`);
  }
});

test('a valid token gets past auth and reaches routing', async () => {
  const res = await fetch(`${base}/no-such-route`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 404);
});

test('no response carries CORS headers, and a cross-origin preflight is not granted', async () => {
  const headers = { origin: 'https://evil.example', authorization: `Bearer ${TOKEN}` };
  const ok = await fetch(`${base}/no-such-route`, { headers });
  assert.equal(ok.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${base}/chat`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.status, 401);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('isBearerAuthorized accepts the Bearer scheme case-insensitively and rejects other schemes', () => {
  assert.equal(isBearerAuthorized(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(isBearerAuthorized(`Basic ${TOKEN}`, TOKEN), false);
  assert.equal(isBearerAuthorized(undefined, TOKEN), false);
  assert.equal(isBearerAuthorized('Bearer', TOKEN), false);
});

test('resolveApiBinding defaults to loopback with a generated token', () => {
  const b = resolveApiBinding({});
  assert.equal(b.host, '127.0.0.1');
  assert.equal(b.tokenGenerated, true);
  assert.ok(b.token.length >= 32);
  assert.notEqual(resolveApiBinding({}).token, b.token, 'each run gets a fresh token');
});

test('resolveApiBinding refuses a non-loopback bind without an explicit token', () => {
  assert.throws(() => resolveApiBinding({ AGENT_API_HOST: '0.0.0.0' }), /exposes the API beyond this machine/);
  assert.throws(() => resolveApiBinding({ AGENT_API_HOST: '192.168.1.20' }), /AGENT_API_TOKEN/);
});

test('resolveApiBinding accepts a non-loopback bind with a strong configured token', () => {
  const b = resolveApiBinding({ AGENT_API_HOST: '0.0.0.0', AGENT_API_TOKEN: 'a-configured-secret-value' });
  assert.equal(b.host, '0.0.0.0');
  assert.equal(b.tokenGenerated, false);
  assert.equal(b.token, 'a-configured-secret-value');
});

test('resolveApiBinding rejects a short configured token', () => {
  assert.throws(() => resolveApiBinding({ AGENT_API_TOKEN: 'short' }), /at least 16 characters/);
});
