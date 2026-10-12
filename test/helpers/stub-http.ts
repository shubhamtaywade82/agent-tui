/**
 * Local HTTP stub for provider and media tests. The official SDKs make real requests
 * to it, so tests assert on the exact method, path, headers, and body that went out.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface StubResponse {
  status?: number;
  headers?: Record<string, string>;
  body: Buffer | string;
}

export type Responder = (req: RecordedRequest) => StubResponse | Promise<StubResponse>;

export interface StubServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startStubServer(respond: Responder): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const record: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(record);
      const out = await respond(record);
      res.statusCode = out.status ?? 200;
      for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

export function json(body: unknown, status = 200): StubResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** Minimal OpenAI chat.completion payload. */
export function chatCompletion(message: Record<string, unknown>, usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) {
  return {
    id: 'cmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop', logprobs: null }],
    usage,
  };
}

/** Run `fn` with the given environment variables set (undefined deletes), then restore them. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
