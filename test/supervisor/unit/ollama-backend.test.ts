/**
 * OllamaBackend — §13. Drives the SDK client against an injected fetch so the
 * request wire shape, response mapping, timeout and health probe are verified
 * without a running Ollama server.
 */
import { describe, expect, it } from 'vitest';
import type { SupervisorConfig } from '../../../src/supervisor/config.js';
import { OllamaBackend } from '../../../src/supervisor/inference/ollama.js';

const HOST = 'http://ollama.test:11434';

function makeConfig(ollamaHost = HOST): SupervisorConfig {
  return {
    inference: { ollamaHost, defaultThinkMode: 'no-think' },
    context: { budgetTokens: 8192 },
  } as unknown as SupervisorConfig;
}

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      model: 'minicpm5-router',
      created_at: '2026-10-23T00:00:00Z',
      message: { role: 'assistant', content },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 12,
      eval_count: 5,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function recordingFetch(respond: (url: string) => Response): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    return respond(url);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('OllamaBackend.invoke', () => {
  it('sends a non-streaming JSON-format chat request with num_ctx and think=false', async () => {
    const { fetch, calls } = recordingFetch(() => chatResponse('{"intent":"TOOL_EXECUTION"}'));
    const backend = new OllamaBackend(makeConfig(), fetch);

    await backend.invoke({ model: 'minicpm5-router', prompt: 'ping', formatJson: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${HOST}/api/chat`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({
      model: 'minicpm5-router',
      messages: [{ role: 'user', content: 'ping' }],
      format: 'json',
      stream: false,
      think: false,
      options: { temperature: 0.1, num_ctx: 8192 },
    });
  });

  it('parses JSON output and maps token counts', async () => {
    const { fetch } = recordingFetch(() => chatResponse('  {"intent":"TOOL_EXECUTION"}  '));
    const backend = new OllamaBackend(makeConfig(), fetch);

    const r = await backend.invoke({
      model: 'minicpm5-router',
      prompt: 'ping',
      formatJson: true,
      thinkMode: 'think',
    });

    expect(r.content).toBe('{"intent":"TOOL_EXECUTION"}');
    expect(r.parsed).toBe(true);
    expect(r.json).toEqual({ intent: 'TOOL_EXECUTION' });
    expect(r.tokens).toEqual({ prompt: 12, completion: 5 });
    expect(r.model).toBe('minicpm5-router');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports parsed=false and json=undefined when formatJson output is not valid JSON', async () => {
    const { fetch } = recordingFetch(() => chatResponse('not json at all'));
    const backend = new OllamaBackend(makeConfig(), fetch);

    const r = await backend.invoke({ model: 'm', prompt: 'p', formatJson: true });

    expect(r.parsed).toBe(false);
    expect(r.json).toBeUndefined();
    expect(r.content).toBe('not json at all');
  });

  it('omits format and leaves json unset for free-text requests', async () => {
    const { fetch, calls } = recordingFetch(() => chatResponse('hello'));
    const backend = new OllamaBackend(makeConfig(), fetch);

    const r = await backend.invoke({
      model: 'm',
      prompt: 'p',
      contextTokens: 2048,
      maxOutputTokens: 256,
      temperature: 0.7,
    });

    expect(calls[0].body?.format).toBeUndefined();
    // num_ctx is the context-window hint, num_predict is the generation cap.
    // These are independent knobs and must NOT be derived from each other.
    expect(calls[0].body?.options).toMatchObject({
      temperature: 0.7,
      num_ctx: 2048,
      num_predict: 256,
    });
    expect(r.parsed).toBe(false);
    expect(r.json).toBeUndefined();
  });

  it('defaults num_ctx to config.context.budgetTokens when no hint is provided', async () => {
    const { fetch, calls } = recordingFetch(() => chatResponse('hello'));
    const backend = new OllamaBackend(makeConfig(), fetch);

    await backend.invoke({ model: 'm', prompt: 'p' });

    expect(calls[0].body?.options).toMatchObject({ num_ctx: 8192 });
    // num_predict must be omitted so the Modelfile default applies — the
    // previous code forwarded `maxTokens` as `num_ctx`, which silently
    // truncated the router model's context window to 512 tokens.
    expect(calls[0].body?.options).not.toHaveProperty('num_predict');
  });

  it('forwards maxOutputTokens as num_predict and never as num_ctx', async () => {
    const { fetch, calls } = recordingFetch(() => chatResponse('ok'));
    const backend = new OllamaBackend(makeConfig(), fetch);

    await backend.invoke({ model: 'm', prompt: 'p', maxOutputTokens: 100 });

    const options = calls[0].body?.options as Record<string, unknown>;
    expect(options.num_predict).toBe(100);
    // Critical regression guard: a generation cap must NEVER shrink the
    // context window. The router model's Modelfile ships with a much larger
    // num_ctx; conflating the two silently broke routing.
    expect(options.num_ctx).toBe(8192);
  });

  it('treats legacy `maxTokens` as a back-compat alias for contextTokens (num_ctx)', async () => {
    // Older callers (e.g. the previous router classifier) passed `maxTokens: 512`
    // intending to request a small JSON output. The legacy field is now an
    // alias for `contextTokens` (num_ctx), preserving the previous wire shape.
    // New callers should pass `maxOutputTokens` to cap generation length.
    const { fetch, calls } = recordingFetch(() => chatResponse('ok'));
    const backend = new OllamaBackend(makeConfig(), fetch);

    await backend.invoke({ model: 'm', prompt: 'p', maxTokens: 2048 });

    const options = calls[0].body?.options as Record<string, unknown>;
    expect(options.num_ctx).toBe(2048);
    expect(options).not.toHaveProperty('num_predict');
  });

  it('sends format requests to a docker-compose service-name host (regression: SDK 1.20.0 refused these)', async () => {
    const { fetch, calls } = recordingFetch(() => chatResponse('{"intent":"TOOL_EXECUTION"}'));
    const backend = new OllamaBackend(makeConfig('http://ollama:11434'), fetch);

    const r = await backend.invoke({ model: 'minicpm5-router', prompt: 'ping', formatJson: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://ollama:11434/api/chat');
    expect(r.parsed).toBe(true);
  });

  it('aborts the request when the per-call timeoutMs elapses', async () => {
    const hang = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      throw new Error('unreachable');
    }) as typeof fetch;
    const backend = new OllamaBackend(makeConfig(), hang);

    await expect(backend.invoke({ model: 'm', prompt: 'p', timeoutMs: 25 })).rejects.toThrow();
  });

  it('propagates transport failures to the caller instead of swallowing them', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const backend = new OllamaBackend(makeConfig(), down);

    await expect(backend.invoke({ model: 'm', prompt: 'p' })).rejects.toThrow();
  });
});

describe('OllamaBackend.health', () => {
  it('is true when the HEAD / liveness probe succeeds', async () => {
    const { fetch, calls } = recordingFetch(() => new Response(null, { status: 200 }));
    const backend = new OllamaBackend(makeConfig(), fetch);

    await expect(backend.health()).resolves.toBe(true);
    expect(calls[0]).toMatchObject({ url: HOST, method: 'HEAD' });
  });

  it('is false (never throws) when the server is unreachable', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const backend = new OllamaBackend(makeConfig(), down);

    await expect(backend.health()).resolves.toBe(false);
  });
});
