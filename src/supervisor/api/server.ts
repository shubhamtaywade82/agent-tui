/**
 * Fastify server factory — §3 (Reference Architecture), §17 (Recommended
 * Infrastructure Stack).
 *
 * Constructs the Fastify instance, wires CORS + Swagger UI for the OpenAPI
 * docs (§3 API reference), and registers the route handlers.
 */

import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { supervisorConfig } from '../config.js';
import type { Supervisor } from '../engine.js';
import { logger } from '../observability/logger.js';
import type { StateStore } from '../state/store.js';
import { registerRoutes } from './routes.js';

export interface ServerDeps {
  supervisor: Supervisor;
  store: StateStore;
}

export async function createServer(deps: ServerDeps) {
  const app = Fastify({
    logger: false, // we use pino directly
    bodyLimit: 1024 * 1024,
  });

  await app.register(cors, { origin: true });
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

export async function startServer(deps: ServerDeps) {
  const app = await createServer(deps);
  await app.listen({
    host: supervisorConfig.http.host,
    port: supervisorConfig.http.port,
  });
  logger.info(
    { host: supervisorConfig.http.host, port: supervisorConfig.http.port },
    'MiniCPM5 Supervisor API listening — OpenAPI docs at /docs',
  );
  return app;
}
