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
import { CodeChangeExecutor } from './code/code-change-executor.js';
import { CodeIndexer } from './code/indexer.js';
import { PatchWorkflow } from './code/patch.js';
import { type SupervisorConfig, supervisorConfig } from './config.js';
import { CacheService } from './context/cache.js';
import { MemoryService } from './context/memory.js';
import { HybridRetriever } from './context/retrieval.js';
import { Supervisor } from './engine.js';
import { AnthropicBackend } from './inference/anthropic.js';
import type { Backend } from './inference/backend.js';
import { OllamaEmbedder } from './inference/embedder.js';
import { GeminiBackend } from './inference/gemini.js';
import { MockBackend } from './inference/mock.js';
import { ModelPool } from './inference/model-pool.js';
import { OllamaBackend } from './inference/ollama.js';
import { OpenAIBackend } from './inference/openai.js';
import { OpenAIEmbedder } from './inference/openai-embedder.js';
import { PooledOllamaBackend } from './inference/pooled-ollama-backend.js';
import { VllmBackend } from './inference/vllm.js';
import { logger } from './observability/logger.js';
import { Telemetry } from './observability/telemetry.js';
import { SandboxExecutor } from './sandbox/executor.js';
import { PermissionService } from './security/permissions.js';
import { SecretResolver } from './security/secrets.js';
import { PgStateStore } from './state/store.js';
import { TaskLedger } from './tasks/ledger.js';
import { TaskOrchestrator } from './tasks/orchestrator.js';
import { TaskPlanner } from './tasks/planner.js';
import { InMemoryTaskStore, PgTaskStore, type TaskStore } from './tasks/store.js';
import { registerRetrievalAndMemoryTools } from './tools/builtin.js';

async function makeBackend(): Promise<Backend> {
  switch (supervisorConfig.inference.backend) {
    case 'ollama': {
      const inner = new OllamaBackend(supervisorConfig);
      // Phase 2 — wrap with the model residency pool when an allowlist
      // is configured. Without an allowlist, the pool is a no-op
      // (every model passes through acquire()).
      const allowlist = supervisorConfig.inference.pool.allowlist;
      if (allowlist.length === 0) {
        logger.info('model pool: allowlist empty — skipping residency management');
        return inner;
      }
      const pool = new ModelPool({
        ollamaHost: supervisorConfig.inference.ollamaHost,
        maxResident: supervisorConfig.inference.pool.maxResident,
        keepAliveMs: supervisorConfig.inference.pool.keepAliveMs,
        allowlist,
        alwaysRefresh: supervisorConfig.inference.pool.alwaysRefresh,
      });
      await pool.init();
      logger.info(
        { maxResident: supervisorConfig.inference.pool.maxResident, allowlist },
        'model pool: residency management active',
      );
      return new PooledOllamaBackend(inner, pool);
    }
    case 'vllm':
      return new VllmBackend(supervisorConfig);
    case 'openai':
      return new OpenAIBackend(supervisorConfig);
    case 'anthropic':
      return new AnthropicBackend(supervisorConfig);
    case 'gemini':
      return new GeminiBackend(supervisorConfig);
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

  const retriever = new HybridRetriever({
    vectorDimension: supervisorConfig.embedding.dimension,
  });
  try {
    await retriever.init();
  } catch (e) {
    logger.warn({ err: e }, 'retriever init failed — continuing without retrieval');
  }

  // Phase 4 — embedding provider. Decoupled from the inference backend:
  // pick the embedder via EMBEDDING_PROVIDER (defaults to `ollama` when
  // INFERENCE_BACKEND=ollama, otherwise `none`). When the chosen embedder
  // is unhealthy or unset, the retriever silently degrades to keyword-only
  // search — the pre-Phase-4 behaviour. The health endpoint reports the mode.
  const embedderProvider = supervisorConfig.embedding.provider;
  let embedder: OllamaEmbedder | OpenAIEmbedder | undefined;
  let retrievalMode: 'hybrid' | 'keyword-only' = 'keyword-only';

  const shouldUseOllamaEmbedder =
    embedderProvider === 'ollama' ||
    (embedderProvider === undefined && supervisorConfig.inference.backend === 'ollama');
  const shouldUseOpenAIEmbedder =
    embedderProvider === 'openai' ||
    (embedderProvider === undefined &&
      supervisorConfig.inference.backend === 'openai' &&
      !!supervisorConfig.inference.openai.apiKey);

  if (shouldUseOllamaEmbedder) {
    embedder = new OllamaEmbedder({ config: supervisorConfig });
    const h = await embedder.health();
    if (h.ok) {
      retrievalMode = 'hybrid';
      logger.info(
        { model: embedder.modelName, dimension: h.dimension, latencyMs: h.latencyMs },
        'OllamaEmbedder healthy — hybrid retrieval active',
      );
    } else {
      logger.warn(
        { model: embedder.modelName, latencyMs: h.latencyMs },
        'OllamaEmbedder health check failed — retriever will degrade to keyword-only search. ' +
          `Pull the model with \`ollama pull ${embedder.modelName}\` or set EMBEDDING_MODEL to a model that is pulled.`,
      );
      embedder = undefined;
    }
  } else if (shouldUseOpenAIEmbedder) {
    try {
      embedder = new OpenAIEmbedder({ config: supervisorConfig });
      const h = await embedder.health();
      if (h.ok) {
        retrievalMode = 'hybrid';
        logger.info(
          { model: embedder.modelName, dimension: h.dimension, latencyMs: h.latencyMs },
          'OpenAIEmbedder healthy — hybrid retrieval active',
        );
      } else {
        logger.warn(
          { model: embedder.modelName, latencyMs: h.latencyMs },
          'OpenAIEmbedder health check failed — retriever will degrade to keyword-only search. ' +
            'Set EMBEDDING_MODEL to a valid OpenAI embeddings model (text-embedding-3-small, etc.) or set EMBEDDING_PROVIDER=none to silence this warning.',
        );
        embedder = undefined;
      }
    } catch (e) {
      logger.warn(
        { err: e },
        'OpenAIEmbedder construction failed — retriever will degrade to keyword-only search. ' +
          'Set EMBEDDING_OPENAI_API_KEY (or OPENAI_API_KEY) to use OpenAI-compatible embeddings.',
      );
      embedder = undefined;
    }
  } else {
    logger.info(
      { provider: embedderProvider, inferenceBackend: supervisorConfig.inference.backend },
      'no embedding provider configured — keyword-only retrieval active. ' +
        'Set EMBEDDING_PROVIDER=ollama|openai to enable hybrid retrieval.',
    );
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
  // Phase 4 — when an embedder is wired (Ollama backend), the
  // retrieve_knowledge tool calls embedAndRetrieve → vector + FTS.
  // When undefined, the tool falls back to FTS-only and the health
  // endpoint reports retrievalMode: 'keyword-only'.
  const embedFn = embedder ? (text: string) => embedder.embed(text) : undefined;
  registerRetrievalAndMemoryTools(supervisor.registry, {
    retriever,
    memory,
    permissions,
    embedFn,
    embeddingModelVersion: embedder ? embedder.modelVersionLabel : 'default-v1',
  });

  // Phase 1 — durable task ledger. The same Postgres database backs the
  // task tables; an in-memory store is used when INFERENCE_BACKEND=mock so
  // local dev and unit tests run without a database instance.
  let taskStore: TaskStore;
  if (supervisorConfig.inference.backend === 'mock') {
    taskStore = new InMemoryTaskStore();
    logger.info('task ledger: in-memory store (mock backend)');
  } else {
    taskStore = new PgTaskStore(supervisorConfig.database.url);
    await taskStore.init();
    logger.info('task ledger: Postgres store initialised');
  }
  const taskLedger = new TaskLedger(taskStore);
  // Phase 5 — wire the CodeChangeExecutor and CodeIndexer into the
  // orchestrator so CODE_CHANGE tasks are applied in an isolated git
  // worktree and verified before the chain advances, and so RETRIEVE /
  // CODE_CHANGE / ANALYZE / TEST tasks get relevant file snippets
  // injected into their objective when a repoPath is supplied.
  const codeChangeExecutor = new CodeChangeExecutor(
    backend,
    supervisorConfig.inference.analystModel,
    patchWorkflow,
  );
  const taskOrchestrator = new TaskOrchestrator(
    taskLedger,
    supervisor,
    taskStore,
    codeChangeExecutor,
    codeIndexer,
  );
  // Phase 3 — task planner. Uses the same Backend the engine uses, so
  // the model pool (Phase 2) and the verification gate (PR #31) apply.
  // The planner invokes the router variant directly (not via the engine)
  // because it emits a structured plan, not a Supervisor run.
  const taskPlanner = new TaskPlanner(backend, supervisorConfig.inference.routerModel);

  // §11 cache service (prompt prefix + generation cache). Wired into the
  // engine via the backend wrapper in production; left as a standalone
  // instance here for observability and manual invalidation.
  const _cache = new CacheService();
  void _cache;
  // (Skipped here to avoid pulling more deps; see docs/supervisor/api.md for examples.)

  const app = await startServer({
    supervisor,
    store,
    taskLedger,
    taskOrchestrator,
    taskPlanner,
    retrievalMode,
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await store.close();
    await taskStore.close();
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
