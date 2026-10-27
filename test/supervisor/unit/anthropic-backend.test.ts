/**
 * AnthropicBackend — verifies the wire shape of the Anthropic Messages API
 * request, the prompt-level JSON mode (assistant prefill), token accounting,
 * thinking-mode forwarding, and the health probe. Uses a recording fetch
 * injected via the SDK's `fetch` constructor option — no real API call.
 */
import { describe, expect, it } from 'vitest';
import type { SupervisorConfig } from '../../../src/supervisor/config.js';
import { AnthropicBackend } from '../../../src/supervisor/inference/anthropic.js';

const KEY = 'sk-ant-test-key-1234';

function makeConfig(
  overrides: Partial<SupervisorConfig['inference']['anthropic']> = {},
): SupervisorConfig {
  return {
    inference: {
      anthropic: { apiKey: KEY, ...overrides },
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

function messageResponse(text: string, model = 'claude-3-5-sonnet-20241022'): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('AnthropicBackend — construction', () => {
  it('throws when ANTHROPIC_API_KEY is missing', () => {
    expect(() => new AnthropicBackend(makeConfig({ apiKey: undefined }))).toThrowError(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('accepts a custom base URL', () => {
    expect(
      () => new AnthropicBackend(makeConfig({ baseUrl: 'https://proxy.example.com' })),
    ).not.toThrow();
  });
});

describe('AnthropicBackend.invoke', () => {
  it('sends a /v1/messages request with model + max_tokens + messages', async () => {
    const { fetch, calls } = recordingFetch(() => messageResponse('{"intent":"TOOL_EXECUTION"}'));
    const backend = new AnthropicBackend(makeConfig(), fetch);

    await backend.invoke({
      model: 'claude-3-5-sonnet-20241022',
      prompt: 'classify this intent',
      formatJson: true,
      maxOutputTokens: 256,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/v1/messages');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 256,
      // Anthropic JSON mode = prompt-level prefill. The assistant turn
      // starts with `{` so the model continues from there.
      messages: [
        { role: 'user', content: 'classify this intent' },
        { role: 'assistant', content: '{' },
      ],
    });
  });

  it('defaults max_tokens to 4096 when the caller omits maxOutputTokens', async () => {
    const { fetch, calls } = recordingFetch(() => messageResponse('ok'));
    const backend = new AnthropicBackend(makeConfig(), fetch);

    await backend.invoke({ model: 'claude-3-5-sonnet-20241022', prompt: 'p' });

    expect(calls[0].body).toMatchObject({ max_tokens: 4096 });
  });

  it('parses JSON output (with prefill reconstruction) and maps token counts', async () => {
    // Anthropic continues from the `{` prefill; the response is the rest of the JSON.
    const { fetch } = recordingFetch(() => messageResponse('"intent":"TOOL_EXECUTION"}'));
    const backend = new AnthropicBackend(makeConfig(), fetch);

    const r = await backend.invoke({
      model: 'claude-3-5-sonnet-20241022',
      prompt: 'p',
      formatJson: true,
    });

    expect(r.parsed).toBe(true);
    expect(r.json).toEqual({ intent: 'TOOL_EXECUTION' });
    expect(r.tokens).toEqual({ prompt: 12, completion: 5 });
    expect(r.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('marks parsed=false when JSON output is malformed', async () => {
    const { fetch } = recordingFetch(() => messageResponse('not json at all'));
    const backend = new AnthropicBackend(makeConfig(), fetch);

    const r = await backend.invoke({
      model: 'claude-3-5-sonnet-20241022',
      prompt: 'p',
      formatJson: true,
    });
    expect(r.parsed).toBe(false);
  });

  it('forwards thinking config when thinkMode=think', async () => {
    const { fetch, calls } = recordingFetch(() => messageResponse('ok'));
    const backend = new AnthropicBackend(makeConfig(), fetch);

    await backend.invoke({
      model: 'claude-3-5-sonnet-20241022',
      prompt: 'p',
      thinkMode: 'think',
      maxOutputTokens: 8192,
    });

    expect(calls[0].body).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });
  });

  it('does NOT forward thinking config when thinkMode=no-think', async () => {
    const { fetch, calls } = recordingFetch(() => messageResponse('ok'));
    const backend = new AnthropicBackend(makeConfig(), fetch);

    await backend.invoke({
      model: 'claude-3-5-sonnet-20241022',
      prompt: 'p',
      thinkMode: 'no-think',
    });

    expect(calls[0].body).not.toHaveProperty('thinking');
  });
});

describe('AnthropicBackend.health', () => {
  it('returns true when a 1-token ping succeeds', async () => {
    const { fetch } = recordingFetch(() => messageResponse('p'));
    const backend = new AnthropicBackend(makeConfig(), fetch);

    expect(await backend.health()).toBe(true);
  });

  it('returns true on 400 with model-not-found (API reachable, key valid)', async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'not_found_error', message: 'model not found' },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const backend = new AnthropicBackend(makeConfig(), fetch);

    expect(await backend.health()).toBe(true);
  });

  it('returns false on network error', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const backend = new AnthropicBackend(makeConfig(), down);

    expect(await backend.health()).toBe(false);
  });
});
