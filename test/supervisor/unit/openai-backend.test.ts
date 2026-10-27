/**
 * OpenAIBackend — verifies the wire shape of the OpenAI chat completions
 * request, the JSON-mode response handling, token accounting, and the
 * health probe. Uses a recording fetch injected via the SDK's `fetch`
 * constructor option — no real API call is made.
 */
import { describe, expect, it } from 'vitest';
import type { SupervisorConfig } from '../../../src/supervisor/config.js';
import { OpenAIBackend } from '../../../src/supervisor/inference/openai.js';

const BASE = 'https://api.openai.com/v1';
const KEY = 'sk-test-key-1234';

function makeConfig(
  overrides: Partial<SupervisorConfig['inference']['openai']> = {},
): SupervisorConfig {
  return {
    inference: {
      openai: { baseUrl: BASE, apiKey: KEY, ...overrides },
      defaultThinkMode: 'no-think',
    },
    context: { budgetTokens: 8192 },
  } as unknown as SupervisorConfig;
}

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function recordingFetch(respond: () => Response): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ url, method: init?.method ?? 'POST', body });
    return respond();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function chatCompletion(content: string, model = 'gpt-4o-mini'): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1730000000,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function modelsResponse(): Response {
  return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenAIBackend — construction', () => {
  it('throws when OPENAI_API_KEY is missing', () => {
    const cfg = makeConfig({ apiKey: undefined });
    expect(() => new OpenAIBackend(cfg)).toThrowError(/OPENAI_API_KEY/);
  });

  it('accepts an organisation and project header', () => {
    const cfg = makeConfig({ organization: 'org-123', project: 'proj_abc' });
    expect(() => new OpenAIBackend(cfg)).not.toThrow();
  });
});

describe('OpenAIBackend.invoke', () => {
  it('sends a chat.completions request with model + messages + temperature', async () => {
    const { fetch, calls } = recordingFetch(() => chatCompletion('{"intent":"TOOL_EXECUTION"}'));
    const backend = new OpenAIBackend(makeConfig(), fetch);

    await backend.invoke({
      model: 'gpt-4o-mini',
      prompt: 'classify this intent',
      formatJson: true,
      temperature: 0.2,
      maxOutputTokens: 256,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/chat/completions`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'classify this intent' }],
      temperature: 0.2,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    });
  });

  it('parses JSON output and maps token counts', async () => {
    const { fetch } = recordingFetch(() => chatCompletion('  {"intent":"TOOL_EXECUTION"}  '));
    const backend = new OpenAIBackend(makeConfig(), fetch);

    const r = await backend.invoke({ model: 'gpt-4o-mini', prompt: 'p', formatJson: true });

    expect(r.parsed).toBe(true);
    expect(r.json).toEqual({ intent: 'TOOL_EXECUTION' });
    expect(r.content).toBe('{"intent":"TOOL_EXECUTION"}');
    expect(r.tokens).toEqual({ prompt: 12, completion: 5 });
    expect(r.model).toBe('gpt-4o-mini');
  });

  it('marks parsed=false when JSON output is malformed', async () => {
    const { fetch } = recordingFetch(() => chatCompletion('not json at all'));
    const backend = new OpenAIBackend(makeConfig(), fetch);

    const r = await backend.invoke({ model: 'gpt-4o-mini', prompt: 'p', formatJson: true });

    expect(r.parsed).toBe(false);
    expect(r.json).toBeUndefined();
    expect(r.content).toBe('not json at all');
  });

  it('omits max_tokens when the caller does not set maxOutputTokens', async () => {
    const { fetch, calls } = recordingFetch(() => chatCompletion('ok'));
    const backend = new OpenAIBackend(makeConfig(), fetch);

    await backend.invoke({ model: 'gpt-4o-mini', prompt: 'p' });

    expect(calls[0].body).not.toHaveProperty('max_tokens');
  });

  it('omits response_format when formatJson is not requested', async () => {
    const { fetch, calls } = recordingFetch(() => chatCompletion('ok'));
    const backend = new OpenAIBackend(makeConfig(), fetch);

    await backend.invoke({ model: 'gpt-4o-mini', prompt: 'p' });

    expect(calls[0].body).not.toHaveProperty('response_format');
  });
});

describe('OpenAIBackend.health', () => {
  it('returns true when /models lists models', async () => {
    const { fetch } = recordingFetch(modelsResponse);
    const backend = new OpenAIBackend(makeConfig(), fetch);

    expect(await backend.health()).toBe(true);
  });

  it('returns false on network error', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const backend = new OpenAIBackend(makeConfig(), down);

    expect(await backend.health()).toBe(false);
  });
});
