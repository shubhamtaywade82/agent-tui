/**
 * Supervisor entrypoint — `npm run supervisor:serve`.
 *
 * Boots the Fastify HTTP server with all infrastructure wired:
 *   - Postgres state store (§4)
 *   - Hybrid retriever (§6) and memory service (§7)
 *   - Sandbox executor (§11)
 *   - Inference backend selected by INFERENCE_BACKEND env var (§13)
 *   - Telemetry (§15.1)
 *
 * Run with `INFERENCE_BACKEND=mock` for local dev without an Ollama daemon.
 */

import { startServer } from './api/server.js';
import { CodeIndexer } from './code/indexer.js';
import { PatchWorkflow } from './code/patch.js';
import { supervisorConfig } from './config.js';
import { MemoryService } from './context/memory.js';
import { HybridRetriever } from './context/retrieval.js';
import { Supervisor } from './engine.js';
import type { Backend } from './inference/backend.js';
import { MockBackend } from './inference/mock.js';
import { OllamaBackend } from './inference/ollama.js';
import { VllmBackend } from './inference/vllm.js';
import { logger } from './observability/logger.js';
import { Telemetry } from './observability/telemetry.js';
import { SandboxExecutor } from './sandbox/executor.js';
import { PermissionService } from './security/permissions.js';
import { SecretResolver } from './security/secrets.js';
import { PgStateStore } from './state/store.js';

async function makeBackend(): Promise<Backend> {
  switch (supervisorConfig.inference.backend) {
    case 'ollama':
      return new OllamaBackend(supervisorConfig);
    case 'vllm':
      return new VllmBackend(supervisorConfig);
    case 'mock':
      return new MockBackend();
    default:
      throw new Error(`Unknown INFERENCE_BACKEND: ${supervisorConfig.inference.backend}`);
  }
}

async function main() {
  logger.info(
    {
      backend: supervisorConfig.inference.backend,
      db: supervisorConfig.database.url.replace(/:[^:@]+@/, ':***@'),
      http: `${supervisorConfig.http.host}:${supervisorConfig.http.port}`,
    },
    'booting MiniCPM5 Supervisor',
  );

  const store = new PgStateStore(supervisorConfig.database.url);
  await store.init();

  const retriever = new HybridRetriever();
  try {
    await retriever.init();
  } catch (e) {
    logger.warn({ err: e }, 'retriever init failed — continuing without retrieval');
  }

  const memory = new MemoryService();
  try {
    await memory.init();
  } catch (e) {
    logger.warn({ err: e }, 'memory init failed — continuing without memory');
  }

  const backend = await makeBackend();
  const sandbox = new SandboxExecutor();
  const codeIndexer = new CodeIndexer(retriever);
  const patchWorkflow = new PatchWorkflow(sandbox);
  const permissions = new PermissionService();
  const secrets = new SecretResolver();

  const supervisor = new Supervisor({
    backend,
    store,
    retriever,
    memory,
    sandbox,
    codeIndexer,
    patchWorkflow,
    permissions,
    secrets,
  });

  // Register a couple of built-in tools (§10.1) so /v1/tools is non-empty out of the box
  // Real deployments add their own tools via the registry.
  // (Skipped here to avoid pulling more deps; see docs/supervisor/api.md for examples.)

  const app = await startServer({ supervisor, store });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await store.close();
    await retriever.close();
    await memory.close();
    await Telemetry.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.error({ err: e }, 'fatal boot error');
  process.exit(1);
});
