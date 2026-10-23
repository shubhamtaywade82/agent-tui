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
 * Security model:
 *   - Every route requires `Authorization: Bearer <token>`. The token comes from
 *     AGENT_API_TOKEN, or is generated for the run and printed once to stderr.
 *   - The server binds to 127.0.0.1 unless AGENT_API_HOST says otherwise. A
 *     non-loopback bind refuses to start without an explicit AGENT_API_TOKEN.
 *   - No CORS headers are sent, so a web page cannot read responses. A page can
 *     still send a request, which is why the token is required.
 *   - Requests are authenticated operator requests. Tools run without the TUI's
 *     approval prompt, so restrict AGENT_TOOLS on deployments exposed beyond you.
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
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

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
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(json);
}

function sendSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

/** Constant-time check of an `Authorization: Bearer` header against the server token. */
export function isAuthorized(authorization: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1]!);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface ApiBinding {
  host: string;
  token: string;
  /** True when the token was generated for this run rather than configured. */
  tokenGenerated: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MIN_CONFIGURED_TOKEN_LENGTH = 16;

/**
 * Resolve the bind address and token from the environment. Throws before the
 * server starts if the configuration would expose an unauthenticated or weakly
 * authenticated API beyond this machine.
 */
export function resolveApiBinding(env: NodeJS.ProcessEnv = process.env): ApiBinding {
  const host = env.AGENT_API_HOST?.trim() || '127.0.0.1';
  const configured = env.AGENT_API_TOKEN?.trim() || undefined;
  if (configured && configured.length < MIN_CONFIGURED_TOKEN_LENGTH) {
    throw new Error(`AGENT_API_TOKEN must be at least ${MIN_CONFIGURED_TOKEN_LENGTH} characters.`);
  }
  if (!LOOPBACK_HOSTS.has(host) && !configured) {
    throw new Error(
      `AGENT_API_HOST=${host} exposes the API beyond this machine. Set AGENT_API_TOKEN to a strong secret first.`,
    );
  }
  if (configured) return { host, token: configured, tokenGenerated: false };
  return { host, token: randomBytes(24).toString('base64url'), tokenGenerated: true };
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

export function createApiServer(cfg: AgentConfig, opts: { port: number; token: string }) {
  return createServer(async (req, res) => {
    if (!isAuthorized(req.headers.authorization, opts.token)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
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
  // Validate the binding before any side effects, so a misconfigured host fails fast.
  const binding = resolveApiBinding();
  initLogger();
  const cfg = loadConfig();
  log.info('Server starting', { host: binding.host, port, provider: cfg.provider.active });

  // Pre-warm provider and tool registry to fail fast if config or dependencies are broken
  await getProviderAsync(cfg).catch((e) => log.warn('Provider init failed', { error: e.message }));
  await getToolRegistry(cfg).catch((e) => log.warn('Tool registry init failed', { error: e.message }));

  const server = createApiServer(cfg, { port, token: binding.token });
  server.listen(port, binding.host, () => {
    // The token is written to the terminal only, never to the log file.
    log.info('HTTP API server listening', { host: binding.host, port, tokenGenerated: binding.tokenGenerated });
    process.stderr.write(`\n\x1b[36m⚡ Agentic TUI API server\x1b[0m listening on http://${binding.host}:${port}\n`);
    if (binding.tokenGenerated) {
      process.stderr.write(`   Bearer token for this run: ${binding.token}\n`);
    }
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
