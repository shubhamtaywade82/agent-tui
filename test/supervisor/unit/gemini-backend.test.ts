/**
 * GeminiBackend — verifies the wire shape of the Google Gemini generateContent
 * request, the response handling, JSON-mode mimetype forwarding, token
 * accounting, and the health probe. Uses a recording fetch injected via the
 * SDK's `httpOptions.fetch` constructor option — no real API call.
 */
import { describe, expect, it } from 'vitest';
import type { SupervisorConfig } from '../../../src/supervisor/config.js';
import { GeminiBackend } from '../../../src/supervisor/inference/gemini.js';

const KEY = 'gemini-test-key-1234';

function makeConfig(
  overrides: Partial<SupervisorConfig['inference']['gemini']> = {},
): SupervisorConfig {
  return {
    inference: {
      gemini: { apiKey: KEY, ...overrides },
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

function generateContentResponse(text: string, model = 'gemini-2.0-flash'): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text }],
            role: 'model',
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 5,
        totalTokenCount: 17,
      },
      modelVersion: model,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('GeminiBackend — construction', () => {
  it('throws when GEMINI_API_KEY is missing', () => {
    expect(() => new GeminiBackend(makeConfig({ apiKey: undefined }))).toThrowError(
      /GEMINI_API_KEY/,
    );
  });

  it('accepts a custom base URL', () => {
    expect(
      () => new GeminiBackend(makeConfig({ baseUrl: 'https://generativelanguage.googleapis.com' })),
    ).not.toThrow();
  });
});

describe('GeminiBackend.invoke', () => {
  it('sends a generateContent request with model + contents', async () => {
    const { fetch, calls } = recordingFetch(() =>
      generateContentResponse('{"intent":"TOOL_EXECUTION"}'),
    );
    const backend = new GeminiBackend(makeConfig(), fetch);

    await backend.invoke({
      model: 'gemini-2.0-flash',
      prompt: 'classify this intent',
      formatJson: true,
      temperature: 0.2,
      maxOutputTokens: 256,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('generateContent');
    // The Gemini SDK converts `contents` from a string to a Content[] array
    // and renames `config` → `generationConfig` on the wire.
    expect(calls[0].body).toMatchObject({
      contents: [{ parts: [{ text: 'classify this intent' }], role: 'user' }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 256,
        responseMimeType: 'application/json',
      },
    });
  });

  it('normalises bare model names by prefixing with "models/"', async () => {
    const { fetch, calls } = recordingFetch(() => generateContentResponse('ok'));
    const backend = new GeminiBackend(makeConfig(), fetch);

    await backend.invoke({ model: 'gemini-1.5-pro', prompt: 'p' });

    expect(calls[0].url).toContain('models/gemini-1.5-pro:generateContent');
  });

  it('does NOT prefix models that already include a slash', async () => {
    const { fetch, calls } = recordingFetch(() => generateContentResponse('ok'));
    const backend = new GeminiBackend(makeConfig(), fetch);

    await backend.invoke({ model: 'tunedModels/abc123', prompt: 'p' });

    expect(calls[0].url).toContain('tunedModels/abc123:generateContent');
  });

  it('parses JSON output and maps token counts', async () => {
    const { fetch } = recordingFetch(() =>
      generateContentResponse('  {"intent":"TOOL_EXECUTION"}  '),
    );
    const backend = new GeminiBackend(makeConfig(), fetch);

    const r = await backend.invoke({ model: 'gemini-2.0-flash', prompt: 'p', formatJson: true });

    expect(r.parsed).toBe(true);
    expect(r.json).toEqual({ intent: 'TOOL_EXECUTION' });
    expect(r.content).toBe('{"intent":"TOOL_EXECUTION"}');
    expect(r.tokens).toEqual({ prompt: 12, completion: 5 });
    expect(r.model).toBe('gemini-2.0-flash');
  });

  it('marks parsed=false when JSON output is malformed', async () => {
    const { fetch } = recordingFetch(() => generateContentResponse('not json at all'));
    const backend = new GeminiBackend(makeConfig(), fetch);

    const r = await backend.invoke({ model: 'gemini-2.0-flash', prompt: 'p', formatJson: true });

    expect(r.parsed).toBe(false);
    expect(r.json).toBeUndefined();
  });

  it('omits responseMimeType when formatJson is not requested', async () => {
    const { fetch, calls } = recordingFetch(() => generateContentResponse('ok'));
    const backend = new GeminiBackend(makeConfig(), fetch);

    await backend.invoke({ model: 'gemini-2.0-flash', prompt: 'p' });

    const cfg = calls[0].body?.generationConfig as Record<string, unknown>;
    expect(cfg).not.toHaveProperty('responseMimeType');
  });

  it('forwards thinkingConfig when thinkMode=think', async () => {
    const { fetch, calls } = recordingFetch(() => generateContentResponse('ok'));
    const backend = new GeminiBackend(makeConfig(), fetch);

    await backend.invoke({
      model: 'gemini-2.0-flash',
      prompt: 'p',
      thinkMode: 'think',
      maxOutputTokens: 8192,
    });

    const cfg = calls[0].body?.generationConfig as Record<string, unknown>;
    expect(cfg).toHaveProperty('thinkingConfig');
  });

  it('does NOT forward thinkingConfig when thinkMode=no-think', async () => {
    const { fetch, calls } = recordingFetch(() => generateContentResponse('ok'));
    const backend = new GeminiBackend(makeConfig(), fetch);

    await backend.invoke({
      model: 'gemini-2.0-flash',
      prompt: 'p',
      thinkMode: 'no-think',
    });

    const cfg = (calls[0].body?.generationConfig ?? {}) as Record<string, unknown>;
    expect(cfg).not.toHaveProperty('thinkingConfig');
  });
});

describe('GeminiBackend.health', () => {
  it('returns true when models.list resolves', async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.0-flash' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const backend = new GeminiBackend(makeConfig(), fetch);

    expect(await backend.health()).toBe(true);
  });

  it('returns false on network error', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const backend = new GeminiBackend(makeConfig(), down);

    expect(await backend.health()).toBe(false);
  });
});
