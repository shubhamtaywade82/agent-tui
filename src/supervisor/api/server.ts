/**
 * Fastify server factory — §3 (Reference Architecture), §17 (Recommended
 * Infrastructure Stack).
 *
 * Constructs the Fastify instance, wires CORS + Swagger UI for the OpenAPI
 * docs (§3 API reference), and registers the route handlers.
 *
 * Security:
 *   - Every route except the liveness probe and the OpenAPI docs requires
 *     `Authorization: Bearer <SUPERVISOR_API_KEY>`. CORS preflights are exempt
 *     because they carry no credentials and return no data.
 *   - CORS is off unless SUPERVISOR_CORS_ORIGINS lists origins explicitly.
 *   - The server binds to 127.0.0.1 unless SUPERVISOR_HTTP_HOST says otherwise.
 *     A non-loopback bind refuses to start without an explicit key.
 */

import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { isBearerAuthorized, resolveBearerToken } from '../../utils/auth.js';
import { supervisorConfig } from '../config.js';
import type { Supervisor } from '../engine.js';
import { logger } from '../observability/logger.js';
import type { StateStore } from '../state/store.js';
import type { TaskLedger } from '../tasks/ledger.js';
import type { TaskOrchestrator } from '../tasks/orchestrator.js';
import { registerRoutes } from './routes.js';

export interface ServerDeps {
  supervisor: Supervisor;
  store: StateStore;
  /** Bearer token every protected route requires. */
  apiKey: string;
  /** Origins allowed to make cross-origin requests. Empty means CORS is off. */
  corsOrigins?: string[];
  /**
   * Task ledger — Phase 1 durable task chain. Optional: when omitted,
   * the /v1/goals routes return 501. Wired in `main.ts` for production.
   */
  taskLedger?: TaskLedger;
  taskOrchestrator?: TaskOrchestrator;
}

/** Routes that need no credentials: the liveness probe and the OpenAPI docs. */
const PUBLIC_PATHS = new Set(['/v1/healthz']);

function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return PUBLIC_PATHS.has(path) || path === '/docs' || path.startsWith('/docs/');
}

export async function createServer(deps: ServerDeps) {
  const app = Fastify({
    logger: false, // we use pino directly
    bodyLimit: 1024 * 1024,
  });

  // Registered before any plugin or route so it applies to all of them.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS' || isPublicPath(req.url)) return;
    if (!isBearerAuthorized(req.headers.authorization, deps.apiKey)) {
      return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' });
    }
  });

  const corsOrigins = deps.corsOrigins ?? [];
  await app.register(cors, { origin: corsOrigins.length > 0 ? corsOrigins : false });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'MiniCPM5 Supervisor API',
        description:
          'Deterministic orchestration layer over MiniCPM5-2B sub-agents. See docs/supervisor/README.md.',
        version: '1.0.0',
      },
      servers: [{ url: `http://localhost:${supervisorConfig.http.port}` }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await registerRoutes(app, deps);

  return app;
}

export async function startServer(
  deps: Pick<ServerDeps, 'supervisor' | 'store'> & {
    taskLedger?: TaskLedger;
    taskOrchestrator?: TaskOrchestrator;
  },
) {
  const { host, port, apiKey: configuredKey, corsOrigins } = supervisorConfig.http;
  // Resolve before listening: a non-loopback bind without a configured key must fail here.
  const auth = resolveBearerToken({
    host,
    configured: configuredKey,
    envName: 'SUPERVISOR_API_KEY',
  });
  const app = await createServer({ ...deps, apiKey: auth.token, corsOrigins });
  await app.listen({ host, port });
  logger.info(
    { host, port },
    'MiniCPM5 Supervisor API listening — OpenAPI docs at /docs (bearer auth required)',
  );
  if (auth.generated) {
    // The generated token goes to stderr only, never to the structured log.
    process.stderr.write(`MiniCPM5 Supervisor API bearer token for this run: ${auth.token}\n`);
  }
  return app;
}
