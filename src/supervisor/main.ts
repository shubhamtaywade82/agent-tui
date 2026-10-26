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
import { type SupervisorConfig, supervisorConfig } from './config.js';
import { CacheService } from './context/cache.js';
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
import { registerRetrievalAndMemoryTools } from './tools/builtin.js';

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

/**
 * Construct the fallback backend used when the router escalates (§13.1).
 * The fallback is an OpenAI-compatible endpoint — VllmBackend works for any
 * such endpoint (vLLM, OpenAI, Z.ai GLM, LM Studio, etc.). When unset, the
 * supervisor is constructed without a fallback and the engine fails loudly
 * on any escalation choice instead of silently invoking the local model.
 */
function makeFallbackBackend(): Backend | undefined {
  const url = supervisorConfig.escalation.fallbackBaseUrl;
  const key = supervisorConfig.escalation.fallbackApiKey;
  if (!url || !key) return undefined;
  // Reuse VllmBackend against the fallback URL by overriding config fields.
  // VllmBackend only reads `inference.vllmBaseUrl` / `inference.vllmApiKey`
  // and `context.budgetTokens`, so we synthesise a minimal config view.
  const fallbackConfig: SupervisorConfig = {
    ...supervisorConfig,
    inference: { ...supervisorConfig.inference, vllmBaseUrl: url, vllmApiKey: key },
  };
  return new VllmBackend(fallbackConfig);
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
  const fallback = makeFallbackBackend();
  if (fallback) {
    logger.info(
      {
        baseUrl: supervisorConfig.escalation.fallbackBaseUrl,
        model: supervisorConfig.escalation.fallbackModel,
      },
      'fallback backend configured — router escalations will invoke it',
    );
  } else if (supervisorConfig.escalation.fallbackModel) {
    logger.warn(
      { model: supervisorConfig.escalation.fallbackModel },
      'ESCALATION_FALLBACK_MODEL is set but ESCALATION_FALLBACK_BASE_URL/API_KEY are not — escalations will fail loudly',
    );
  }
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
    fallback,
  });

  // §8 + §13: register the validated retrieval + memory tools so the LLM
  // can call them like any other tool. Every call is gated by tenant scope,
  // permissions, filter validation, top_k limits, query length, rate limits,
  // memory type allowlist, content length, duplicate detection, and PII/secret
  // scanning (§12).
  registerRetrievalAndMemoryTools(supervisor.registry, {
    retriever,
    memory,
    permissions,
    embedFn: undefined, // wire a real embedder here in production
    embeddingModelVersion: 'default-v1',
  });

  // §11 cache service (prompt prefix + generation cache). Wired into the
  // engine via the backend wrapper in production; left as a standalone
  // instance here for observability and manual invalidation.
  const _cache = new CacheService();
  void _cache;
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
