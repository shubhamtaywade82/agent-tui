/**
 * HTTP API server mode — exposes the agent as a REST + SSE endpoint so other
 * applications, scripts, or frontends can drive the agent over HTTP.
 *
 *   GET  /health              → provider/tool/MCP status
 *   GET  /models              → list available models
 *   GET  /tools               → list available tools
 *   GET  /sessions            → list saved sessions
 *   GET  /sessions/:id        → fetch a session
 *   POST /chat                → one-shot chat (JSON request → JSON response)
 *   POST /chat/stream         → SSE streaming chat (token-by-token)
 *   POST /embed               → embed text(s) into vectors
 *
 * Uses only the Node.js built-in http module — no extra framework dependency.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { runAgent, shutdownAgent, type AgentRunOptions } from './agent.js';
import { getProviderAsync } from './providers.js';
import { getToolRegistry } from './toolbox/index.js';
import { listSessions, loadSession } from './session.js';
import { loadConfig, type AgentConfig } from './config.js';
import { initLogger, log } from './logger.js';
import { randomUUID } from 'node:crypto';

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

async function streamChat(
  res: ServerResponse,
  payload: ChatRequest,
  opts: AgentRunOptions,
  defaultModel?: string,
): Promise<void> {
  sendSseHeaders(res);
  const runId = randomUUID();
  sse(res, 'start', { runId, model: payload.model ?? defaultModel });
  try {
    const result = await runAgent(payload.prompt, payload.history as any ?? [], {
      ...opts,
      onThinking: (d) => sse(res, 'thinking', { delta: d }),
      onToken: (d) => sse(res, 'token', { delta: d }),
      onToolCall: (name, args) => sse(res, 'tool_call', { name, args }),
      onToolResult: (name, output, success) => sse(res, 'tool_result', { name, output, success }),
      onPhase: (phase) => sse(res, 'phase', { phase }),
    });
    sse(res, 'done', {
      content: result.content,
      toolCalls: result.toolCalls.map((tc) => tc.function.name),
      iterations: result.iterations,
      metrics: result.metrics,
      sessionId: result.sessionId,
    });
  } catch (e: any) {
    sse(res, 'error', { message: e.message });
  } finally {
    res.end();
  }
}

async function unaryChat(
  res: ServerResponse,
  payload: ChatRequest,
  opts: AgentRunOptions,
): Promise<void> {
  try {
    const result = await runAgent(payload.prompt, payload.history as any ?? [], opts);
    sendJson(res, 200, {
      content: result.content,
      thinking: result.thinking,
      toolCalls: result.toolCalls.map((tc) => tc.function.name),
      iterations: result.iterations,
      metrics: result.metrics,
      sessionId: result.sessionId,
    });
  } catch (e: any) {
    sendJson(res, 500, { error: e.message });
  }
}

async function handleChat(req: IncomingMessage, res: ServerResponse, stream: boolean): Promise<void> {
  const body = await readBody(req);
  let payload: ChatRequest;
  try { payload = JSON.parse(body); } catch { sendJson(res, 400, { error: 'invalid JSON body' }); return; }
  if (!payload.prompt) { sendJson(res, 400, { error: 'missing "prompt" field' }); return; }

  const cfg = loadConfig();
  const opts: AgentRunOptions = {
    provider: payload.provider,
    model: payload.model,
    maxIterations: payload.maxIterations,
    noTools: payload.noTools,
    noThinking: payload.noThinking,
    sessionId: payload.sessionId,
  };

  if (stream) {
    await streamChat(res, payload, opts, cfg.provider[cfg.provider.active].defaultModel);
  } else {
    await unaryChat(res, payload, opts);
  }
}

async function handleEmbed(req: IncomingMessage, res: ServerResponse, cfg: AgentConfig): Promise<void> {
  const body = await readBody(req);
  const { input, model } = JSON.parse(body);
  const provider = await getProviderAsync(cfg);
  const targetModel = model ?? 'nomic-embed-text';
  const vecs = await provider.embed(targetModel, input);
  sendJson(res, 200, { embeddings: vecs, model: targetModel });
}

async function handleGet(
  res: ServerResponse,
  cfg: AgentConfig,
  path: string,
): Promise<boolean> {
  if (path === '/health') {
    const provider = await getProviderAsync(cfg).catch(() => null);
    const reg = await getToolRegistry(cfg).catch(() => null);
    sendJson(res, 200, {
      status: 'ok',
      provider: provider?.name ?? 'unavailable',
      model: cfg.provider[cfg.provider.active].defaultModel,
      tools: reg?.definitions().length ?? 0,
      uptime: process.uptime(),
    });
    return true;
  }
  if (path === '/models') {
    const provider = await getProviderAsync(cfg);
    sendJson(res, 200, { provider: provider.name, models: await provider.listModels() });
    return true;
  }
  if (path === '/tools') {
    const reg = await getToolRegistry(cfg);
    const defs = reg.definitions();
    sendJson(res, 200, { count: defs.length, tools: defs });
    return true;
  }
  if (path === '/sessions') {
    sendJson(res, 200, { sessions: listSessions() });
    return true;
  }
  if (path.startsWith('/sessions/')) {
    const s = loadSession(path.slice('/sessions/'.length));
    if (!s) sendJson(res, 404, { error: 'session not found' });
    else sendJson(res, 200, s);
    return true;
  }
  return false;
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AgentConfig,
  path: string,
): Promise<boolean> {
  if (path === '/chat') {
    await handleChat(req, res, false);
    return true;
  }
  if (path === '/chat/stream') {
    await handleChat(req, res, true);
    return true;
  }
  if (path === '/embed') {
    await handleEmbed(req, res, cfg);
    return true;
  }
  return false;
}

function createApiServer(cfg: AgentConfig, port: number) {
  return createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const path = url.pathname;
    try {
      const handled = req.method === 'GET'
        ? await handleGet(res, cfg, path)
        : req.method === 'POST'
        ? await handlePost(req, res, cfg, path)
        : false;
      if (!handled) sendJson(res, 404, { error: 'not found', path });
    } catch (e: any) {
      log.error('Request failed', { path, error: e.message });
      sendJson(res, 500, { error: e.message });
    }
  });
}

/** Start the HTTP API server on the given port. Returns the server instance. */
export async function startServer(port = 8787): Promise<void> {
  initLogger();
  const cfg = loadConfig();
  log.info('Server starting', { port, provider: cfg.provider.active });

  // Pre-warm provider and tool registry to fail fast if config or dependencies are broken
  await getProviderAsync(cfg).catch((e) => log.warn('Provider init failed', { error: e.message }));
  await getToolRegistry(cfg).catch((e) => log.warn('Tool registry init failed', { error: e.message }));

  const server = createApiServer(cfg, port);
  server.listen(port, () => {
    log.info('HTTP API server listening', { port });
    process.stderr.write(`\n\x1b[36m⚡ Agentic TUI API server\x1b[0m listening on http://localhost:${port}\n`);
    process.stderr.write(`   Endpoints: /health /models /tools /sessions /chat /chat/stream /embed\n\n`);
  });

  const shutdown = async () => {
    log.info('Server shutting down');
    await shutdownAgent().catch(() => {});
    server.close(() => process.exit(0));
    // Fallback exit if any active sockets don't drain within 3 seconds
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Direct invocation
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8787);
  startServer(port).catch((e) => { console.error(e); process.exit(1); });
}
