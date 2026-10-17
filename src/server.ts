/**
 * HTTP API server mode — exposes the agent as a REST + SSE endpoint so other
 * applications, scripts, or frontends can drive the agent over HTTP.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { runAgent, shutdownAgent } from './agent.js';
import { getProviderAsync } from './providers.js';
import { getToolRegistry } from './toolbox/index.js';
import { listSessions, loadSession } from './session.js';
import { loadConfig } from './config.js';
import { initLogger, log } from './logger.js';
import { randomUUID } from 'node:crypto';

// --- helpers ---------------------------------------------------------------

interface ChatRequest {
  prompt: string;
  provider?: string;
  model?: string;
  maxIterations?: number;
  noTools?: boolean;
  noThinking?: boolean;
  sessionId?: string;
  history?: Array<{ role: string; content: string }>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) reject(new Error('body too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  const json = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(json);
}

function sendSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  });
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// --- handlers -------------------------------------------------------------

async function handleChat(req: IncomingMessage, res: ServerResponse, stream = false): Promise<void> {
  const body = await readBody(req);
  let payload: ChatRequest;
  try { payload = JSON.parse(body); } catch { sendJson(res, 400, { error: 'invalid JSON body' }); return; }
  if (!payload.prompt) { sendJson(res, 400, { error: 'missing "prompt" field' }); return; }

  const cfg = loadConfig();
  const opts: Parameters<typeof runAgent>[0] extends ChatRequest ? AgentRunOptions : never = {
    provider: payload.provider, model: payload.model,
    maxIterations: payload.maxIterations, noTools: payload.noTools,
    noThinking: payload.noThinking, sessionId: payload.sessionId,
  };

  if (stream) {
    sendSseHeaders(res);
    const runId = randomUUID();
    sse(res, 'start', { runId, model: payload.model ?? cfg.providers[0].active.defaultModel });
    try {
      const result = await runAgent(payload.prompt, payload.history as any ?? [], opts);
      sse(res, 'done', { result });
    } catch (err: any) {
      sse(res, 'error', { error: err.message, stack: err.stack });
    }
  } else {
    sendJson(res, 200, { result: await runAgent(payload.prompt, payload.history as any ?? [], opts) });
  }
}

async function handleEmbed(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  try {
    const vectors = await runAgent(`Embed text: ${body}`, [], {
      onToken: (d) => sse(res, 'token', { delta: d }),
    });
    sendJson(res, 200, { vectors });
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const id = url.pathname.split('/sessions/')[1] ?? '';
  const session = await loadSession(id);
  if (!session) { sendJson(res, 404, { error: 'session not found' }); return; }
  sendJson(res, 200, { id: session.id, data: session.model, tools: session.tools });
}

async function handleHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = await loadConfig();
  const result = await getProviderAsync(cfg);
  sendJson(res, 200, { provider: result.provider, models: result.models, active: result.provider[result.provider.active].defaultModel });
}

async function handleTools(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = await loadConfig();
  const result = await getToolRegistry(cfg);
  sendJson(res, 200, { count: result.count, tools: result.tools });
}

async function handleSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = await loadConfig();
  const sessions = await listSessions(cfg);
  sendJson(res, 200, { sessions });
}

async function handleMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = await loadConfig();
  const active = cfg.providers[0].active;
  sendJson(res, 200, { models: active.defaultModel, openInterest: await openInterest(cfg) });
}

// --- main ---------------------------------------------------------------

const PORT = parseInt(process.env.SERVER_PORT || '8080', 10);
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    handleHealth(req, res);
  } else if (req.method === 'GET' && path === '/models') {
    const cfg = await loadConfig();
    const models = cfg.providers[0].models;
    sendJson(res, 200, { count: models.length, models });
  } else if (req.method === 'GET' && path === '/tools') {
    const cfg = await loadConfig();
    const result = await getToolRegistry(cfg);
    sendJson(res, 200, { count: result.count, tools: result.tools });
  } else if (req.method === 'GET' && path.startsWith('/sessions')) {
    const id = path.split('/sessions/')[1] ?? '';
    const session = await loadSession(id);
    if (!session) { sendJson(res, 404, { error: 'session not found' }); return; }
    sendJson(res, 200, { id: session.id, data: session.model, tools: session.tools });
  } else if (req.method === 'GET' && path === '/sessions') {
    const cfg = await loadConfig();
    const sessions = await listSessions(cfg);
    sendJson(res, 200, { sessions });
  } else if (req.method === 'GET' && path === '/metrics') {
    const cfg = await loadConfig();
    const active = cfg.providers[0].active;
    sendJson(res, 200, { models: active.defaultModel, openInterest: await openInterest(cfg) });
  } else if (req.method === 'POST' && path === '/chat') {
    handleChat(req, res, false);
  } else if (req.method === 'POST' && path === '/chat/stream') {
    handleChat(req, res, true);
  } else if (req.method === 'POST' && path === '/embed') {
    handleEmbed(req, res);
  } else {
    sendJson(res, 404, { error: `not found: ${path}` });
  }
});

server.listen(PORT, () => {
  log('server', `listening on :${PORT}`);
  log('server', `endpoints: health, models, tools, sessions, chat, embed, metrics`);
});

// --- graceful shutdown --------------------------------------------------

let shuttingDown = false;

async function gracefulShutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('server', 'received shutdown signal');
  server.close(() => {
    log('server', 'server closed');
  });
}

process.on('SIGINT', async () => gracefulShutdown().then(() => process.exit(0)));
process.on('SIGTERM', async () => gracefulShutdown().then(() => process.exit(0)));

export { gracefulShutdown };
