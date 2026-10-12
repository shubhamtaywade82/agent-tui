import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudWebClient, webTools, type CloudWebApi } from '../src/toolbox/web.js';
import { withEnv } from './helpers/stub-http.js';

function recordingCloud(): { api: CloudWebApi; calls: Array<{ method: string; args: unknown }> } {
  const calls: Array<{ method: string; args: unknown }> = [];
  const api: CloudWebApi = {
    async webSearch(args) {
      calls.push({ method: 'webSearch', args });
      return { results: [{ title: 'T', url: 'https://example.test', content: 'C' }] };
    },
    async webFetch(args) {
      calls.push({ method: 'webFetch', args });
      return { title: 'Page', content: 'body', links: [] };
    },
  };
  return { api, calls };
}

test('web_search and web_fetch are registered under the SDK tool names', () => {
  assert.deepEqual(webTools.map((t) => t.name), ['web_search', 'web_fetch']);
});

test('the search tool schema enforces the documented query and max_results bounds', () => {
  const [search] = webTools;
  assert.equal(search!.schema.safeParse({ query: '' }).success, false);
  assert.equal(search!.schema.safeParse({ query: 'rust', max_results: 11 }).success, false);
  assert.equal(search!.schema.safeParse({ query: 'rust', max_results: 3 }).success, true);
});

test('the adapter forwards only query and max_results to the cloud client', async () => {
  const { api, calls } = recordingCloud();
  const client = createCloudWebClient(() => api);
  const res = await client.webSearch({ query: 'ollama', max_results: 3, signal: new AbortController().signal, timeoutMs: 500 } as never);
  assert.equal(res.results[0]!.url, 'https://example.test');
  assert.deepEqual(calls, [{ method: 'webSearch', args: { query: 'ollama', max_results: 3 } }]);
});

test('the adapter omits max_results when the model did not set it', async () => {
  const { api, calls } = recordingCloud();
  await createCloudWebClient(() => api).webSearch({ query: 'ollama', signal: new AbortController().signal } as never);
  assert.deepEqual(calls[0]!.args, { query: 'ollama' });
});

test('the adapter forwards only url to the page fetch endpoint', async () => {
  const { api, calls } = recordingCloud();
  const res = await createCloudWebClient(() => api).webFetch({ url: 'https://example.test/a', signal: new AbortController().signal } as never);
  assert.equal(res.title, 'Page');
  assert.deepEqual(calls, [{ method: 'webFetch', args: { url: 'https://example.test/a' } }]);
});

test('web tools fail with a clear message when OLLAMA_API_KEY is missing', async () => {
  const [search, fetchTool] = webTools;
  await withEnv({ AGENT_LOG_LEVEL: 'silent', OLLAMA_API_KEY: undefined }, async () => {
    await assert.rejects(async () => search!.execute({ query: 'x' }, {} as never), /Web tools require OLLAMA_API_KEY/);
    await assert.rejects(async () => fetchTool!.execute({ url: 'https://example.test' }, {} as never), /Web tools require OLLAMA_API_KEY/);
  });
});
