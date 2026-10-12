import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { loadConfig, normalizeOpenAIBaseUrl } from '../src/config.js';
import { getProviderAsync, resetProvider, type LLMProvider, type ChatMessage, type ToolDefinition } from '../src/providers.js';
import { chatCompletion, json, startStubServer, withEnv, type StubServer } from './helpers/stub-http.js';

const BASE_ENV = { AGENT_LOG_LEVEL: 'silent', AGENT_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' };

/** Build the OpenAI-compatible provider with the given base URL, through the same loader the app uses. */
async function openaiProvider(env: Record<string, string | undefined> = {}): Promise<LLMProvider> {
  return withEnv({ ...BASE_ENV, OPENAI_MODEL: 'test-model', ...env }, async () => {
    resetProvider();
    return getProviderAsync(loadConfig());
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

test('normalizeOpenAIBaseUrl adds /v1 to a bare origin and keeps other paths', () => {
  assert.equal(normalizeOpenAIBaseUrl('https://api.openai.com'), 'https://api.openai.com/v1');
  assert.equal(normalizeOpenAIBaseUrl('https://api.openai.com/'), 'https://api.openai.com/v1');
  assert.equal(normalizeOpenAIBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(normalizeOpenAIBaseUrl('https://api.z.ai/api/paas/v4'), 'https://api.z.ai/api/paas/v4');
  assert.equal(normalizeOpenAIBaseUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000/v1');
  assert.equal(normalizeOpenAIBaseUrl('https://example.test/v1?api-version=2024-06-01'), 'https://example.test/v1?api-version=2024-06-01');
});

test('normalizeOpenAIBaseUrl rejects invalid and non-http URLs', () => {
  assert.throws(() => normalizeOpenAIBaseUrl(''), /Invalid OpenAI-compatible base URL/);
  assert.throws(() => normalizeOpenAIBaseUrl('not a url'), /Invalid OpenAI-compatible base URL/);
  assert.throws(() => normalizeOpenAIBaseUrl('ftp://example.test/v1'), /must use http or https/);
});

test('Z.ai-style base URL posts to /api/paas/v4/chat/completions with bearer auth', async () => {
  const s: StubServer = await startStubServer(() => json(chatCompletion({ content: 'pong' })));
  try {
    const provider = await openaiProvider({ OPENAI_API_KEY: 'zai-test-key', OPENAI_BASE_URL: `${s.baseUrl}/api/paas/v4`, OPENAI_MODEL: 'glm-4.6' });
    const res = await provider.chat({ messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(s.requests.length, 1);
    const [req] = s.requests;
    assert.equal(req!.method, 'POST');
    assert.equal(req!.path, '/api/paas/v4/chat/completions');
    assert.equal(req!.headers.authorization, 'Bearer zai-test-key');
    const body = JSON.parse(req!.body.toString('utf8'));
    assert.equal(body.model, 'glm-4.6');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'ping' }]);
    assert.equal(res.content, 'pong');
    assert.deepEqual(res.usage, { inputTokens: 5, outputTokens: 3 });
  } finally {
    await s.close();
  }
});

test('/v1 base URL posts once to /v1/chat/completions (no doubled /v1)', async () => {
  const s = await startStubServer(() => json(chatCompletion({ content: 'ok' })));
  try {
    const provider = await openaiProvider({ OPENAI_BASE_URL: `${s.baseUrl}/v1` });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(s.requests[0]!.path, '/v1/chat/completions');
  } finally {
    await s.close();
  }
});

test('bare-origin base URL is normalized to /v1 before the request', async () => {
  const s = await startStubServer(() => json(chatCompletion({ content: 'ok' })));
  try {
    const provider = await openaiProvider({ OPENAI_BASE_URL: s.baseUrl });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(s.requests[0]!.path, '/v1/chat/completions');
  } finally {
    await s.close();
  }
});

test('tools and tool results round-trip through the wire format', async () => {
  const s = await startStubServer(() => json(chatCompletion({
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2+2"}' } }],
  })));
  try {
    const provider = await openaiProvider({ OPENAI_BASE_URL: `${s.baseUrl}/v1` });
    const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'calculator', description: 'math', parameters: { type: 'object', properties: { expression: { type: 'string' } } } } }];
    const messages: ChatMessage[] = [
      { role: 'user', content: 'what is 2+2?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', function: { name: 'calculator', arguments: { expression: '1+1' } } }] },
      { role: 'tool', content: '2', tool_call_id: 'call_0' },
    ];
    const res = await provider.chat({ messages, tools });

    const body = JSON.parse(s.requests[0]!.body.toString('utf8'));
    assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'calculator', description: 'math', parameters: tools[0]!.function.parameters } }]);
    assert.deepEqual(body.messages[1], {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'calculator', arguments: '{"expression":"1+1"}' } }],
    });
    assert.deepEqual(body.messages[2], { role: 'tool', tool_call_id: 'call_0', content: '2' });

    assert.deepEqual(res.tool_calls, [{ id: 'call_1', function: { name: 'calculator', arguments: { expression: '2+2' } } }]);
  } finally {
    await s.close();
  }
});

test('a tool result without tool_call_id fails before any request is sent', async () => {
  const s = await startStubServer(() => json(chatCompletion({ content: 'unreachable' })));
  try {
    const provider = await openaiProvider({ OPENAI_BASE_URL: `${s.baseUrl}/v1` });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: 'orphan' }] }),
      /require tool_call_id/,
    );
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
  }
});

test('an assistant tool call without an id fails before any request is sent', async () => {
  const s = await startStubServer(() => json(chatCompletion({ content: 'unreachable' })));
  try {
    const provider = await openaiProvider({ OPENAI_BASE_URL: `${s.baseUrl}/v1` });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'calculator', arguments: {} } }] }] }),
      /has no id/,
    );
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
  }
});

test('empty tool-call arguments parse to an empty object and unparseable ones stay raw', async () => {
  const s = await startStubServer(() => json(chatCompletion({
    tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'now', arguments: '' } },
      { id: 'call_b', type: 'function', function: { name: 'calculator', arguments: '{"expr' } },
    ],
  })));
  try {
    const provider = await openaiProvider({ OPENAI_BASE_URL: `${s.baseUrl}/v1` });
    const res = await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(res.tool_calls?.map((t) => t.function.arguments), [{}, '{"expr']);
  } finally {
    await s.close();
  }
});

test('streaming assembles content, reasoning, and fragmented tool-call arguments', async () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const sse = [
    chunk({ role: 'assistant', reasoning_content: 'think' }),
    chunk({ content: 'Hel' }),
    chunk({ content: 'lo' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'calculator', arguments: '{"expr' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'ession":"2+2"}' } }] }),
    chunk({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ].join('');
  const s = await startStubServer(() => ({ headers: { 'content-type': 'text/event-stream' }, body: sse }));
  try {
    const provider = await openaiProvider({ OPENAI_BASE_URL: `${s.baseUrl}/v1` });
    const tokens: string[] = []; const thoughts: string[] = []; const calls: unknown[] = [];
    const res = await provider.chatStream({ messages: [{ role: 'user', content: 'x' }] }, {
      onToken: (t) => tokens.push(t),
      onThinking: (t) => thoughts.push(t),
      onToolCall: (tc) => calls.push(tc),
    });
    const body = JSON.parse(s.requests[0]!.body.toString('utf8'));
    assert.equal(body.stream, true);
    assert.equal(res.content, 'Hello');
    assert.equal(res.thinking, 'think');
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.deepEqual(thoughts, ['think']);
    assert.deepEqual(res.tool_calls, [{ id: 'call_9', function: { name: 'calculator', arguments: { expression: '2+2' } } }]);
    assert.equal(calls.length, 1);
  } finally {
    await s.close();
  }
});

test('embeddings and model listing map the SDK responses', async () => {
  const s = await startStubServer((req) => {
    if (req.path === '/v1/models') return json({ object: 'list', data: [{ id: 'm-a', object: 'model', created: 0, owned_by: 'x' }, { id: 'm-b', object: 'model', created: 0, owned_by: 'x' }] });
    return json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: 'e', usage: { prompt_tokens: 1, total_tokens: 1 } });
  });
  try {
    const provider = await openaiProvider({ OPENAI_BASE_URL: `${s.baseUrl}/v1` });
    assert.deepEqual(await provider.listModels(), ['m-a', 'm-b']);
    assert.deepEqual(await provider.embed('e', 'hello'), [[0.1, 0.2]]);
    const embedBody = JSON.parse(s.requests[1]!.body.toString('utf8'));
    assert.equal(embedBody.input, 'hello');
    assert.equal(embedBody.encoding_format, 'float');
  } finally {
    await s.close();
  }
});

test('an HTTP 401 from the server rejects with the status attached', async () => {
  const s = await startStubServer(() => json({ error: { message: 'bad key', type: 'invalid_request_error' } }, 401));
  try {
    const provider = await openaiProvider({ OPENAI_BASE_URL: `${s.baseUrl}/v1` });
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'x' }] }), (err: { status?: number }) => err.status === 401);
  } finally {
    await s.close();
  }
});

test('a malformed 200 body rejects instead of returning empty content', async () => {
  const s = await startStubServer(() => ({ headers: { 'content-type': 'application/json' }, body: '{"choices": [' }));
  try {
    const provider = await openaiProvider({ OPENAI_BASE_URL: `${s.baseUrl}/v1` });
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'x' }] }));
  } finally {
    await s.close();
  }
});

test('a refused connection rejects with a network error', async () => {
  const port = await freePort();
  const provider = await openaiProvider({ OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` });
  await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'x' }] }));
});

test('an aborted signal rejects without sending a request', async () => {
  const s = await startStubServer(() => json(chatCompletion({ content: 'unreachable' })));
  try {
    const provider = await openaiProvider({ OPENAI_BASE_URL: `${s.baseUrl}/v1` });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'x' }], signal: controller.signal }));
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
  }
});

test('a missing OPENAI_API_KEY fails with a clear message', async () => {
  await assert.rejects(
    openaiProvider({ OPENAI_API_KEY: undefined, OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' }),
    /requires OPENAI_API_KEY/,
  );
});

test('AGENT_PROVIDER=zai fails with the migration instructions', async () => {
  await assert.rejects(
    withEnv({ AGENT_LOG_LEVEL: 'silent', AGENT_PROVIDER: 'zai', ZAI_API_KEY: 'k' }, async () => {
      resetProvider();
      return getProviderAsync(loadConfig());
    }),
    /AGENT_PROVIDER=zai was removed[\s\S]*OPENAI_BASE_URL=https:\/\/api\.z\.ai\/api\/paas\/v4/,
  );
});

test('an unknown AGENT_PROVIDER fails with the list of supported providers', async () => {
  await assert.rejects(
    withEnv({ AGENT_LOG_LEVEL: 'silent', AGENT_PROVIDER: 'mystery' }, async () => {
      resetProvider();
      return getProviderAsync(loadConfig());
    }),
    /Unknown AGENT_PROVIDER "mystery"\. Expected ollama \| openai \| anthropic/,
  );
});
