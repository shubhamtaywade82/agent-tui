/**
 * Supervisor configuration — single source of truth.
 *
 * All values come from environment variables (populated by dotenv). No
 * secrets are ever written to disk by this module. The configuration is
 * parsed once via zod and frozen — every other module imports the singleton
 * `supervisorConfig` rather than re-reading `process.env`.
 *
 * §17 (Recommended Infrastructure Stack) and §2 (Limitation-to-Infrastructure
 * Compensation Map) drive the structure of this object.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) dotenv.config({ path: envPath, override: false });

const schema = z.object({
  http: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.coerce.number().int().positive().default(7480),
  }),
  log: z.object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    format: z.enum(['pretty', 'json']).default('pretty'),
  }),
  inference: z.object({
    backend: z.enum(['ollama', 'vllm', 'mock']).default('ollama'),
    ollamaHost: z.string().url().default('http://localhost:11434'),
    vllmBaseUrl: z.string().url().default('http://localhost:8000/v1'),
    vllmApiKey: z.string().default('local'),
    routerModel: z.string().default('minicpm5-router'),
    toolModel: z.string().default('minicpm5-toolagent'),
    analystModel: z.string().default('minicpm5-analyst'),
    summarizerModel: z.string().default('minicpm5-summarizer'),
    defaultThinkMode: z.enum(['think', 'no-think']).default('no-think'),
  }),
  database: z.object({
    url: z.string().default('postgres://supervisor:supervisor@localhost:5432/supervisor'),
  }),
  redis: z.object({
    url: z.string().default('redis://localhost:6379/0'),
  }),
  objectStore: z.object({
    kind: z.enum(['local', 's3', 'minio']).default('minio'),
    endpoint: z.string().default('http://localhost:9000'),
    accessKey: z.string().default('minioadmin'),
    secretKey: z.string().default('minioadmin'),
    bucket: z.string().default('supervisor-artifacts'),
    region: z.string().default('us-east-1'),
  }),
  sandbox: z.object({
    image: z.string().default('supervisor-sandbox:latest'),
    network: z.string().default('supervisor-net'),
    cpuLimit: z.coerce.number().positive().default(1.0),
    memoryLimitMb: z.coerce.number().int().positive().default(512),
    timeoutMs: z.coerce.number().int().positive().default(30_000),
    workDir: z.string().default('/workspace'),
  }),
  context: z.object({
    budgetTokens: z.coerce.number().int().positive().default(8192),
    reserveTokens: z.coerce.number().int().positive().default(512),
  }),
  retrieval: z.object({
    topK: z.coerce.number().int().positive().default(5),
    rerank: z.boolean().default(true),
    minScore: z.coerce.number().min(0).max(1).default(0.35),
  }),
  memory: z.object({
    episodicTtlDays: z.coerce.number().int().positive().default(30),
    importanceThreshold: z.coerce.number().min(0).max(1).default(0.6),
  }),
  escalation: z.object({
    maxRetries: z.coerce.number().int().nonnegative().default(2),
    fallbackModel: z.string().optional(),
    fallbackBaseUrl: z.string().url().optional(),
    fallbackApiKey: z.string().optional(),
  }),
  security: z.object({
    jwtSecret: z.string().min(8).default('change-me-in-production'),
    requireApprovalFor: z
      .string()
      .default(
        'production_deploy,database_migration,external_payment,send_email,secret_access,privileged_terminal,irreversible_api',
      )
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    rateLimitPerMin: z.coerce.number().int().positive().default(120),
  }),
  observability: z.object({
    otelExporterOtlpEndpoint: z.string().optional(),
    otelServiceName: z.string().default('minicpm5-supervisor'),
    otelEnabled: z.boolean().default(false),
  }),
});

export type SupervisorConfig = z.infer<typeof schema>;

function loadConfig(): SupervisorConfig {
  const raw = {
    http: {
      host: process.env.SUPERVISOR_HTTP_HOST,
      port: process.env.SUPERVISOR_HTTP_PORT,
    },
    log: {
      level: process.env.SUPERVISOR_LOG_LEVEL,
      format: process.env.SUPERVISOR_LOG_FORMAT,
    },
    inference: {
      backend: process.env.INFERENCE_BACKEND,
      ollamaHost: process.env.OLLAMA_HOST,
      vllmBaseUrl: process.env.VLLM_BASE_URL,
      vllmApiKey: process.env.VLLM_API_KEY,
      routerModel: process.env.MINICPM5_ROUTER_MODEL,
      toolModel: process.env.MINICPM5_TOOL_MODEL,
      analystModel: process.env.MINICPM5_ANALYST_MODEL,
      summarizerModel: process.env.MINICPM5_SUMMARIZER_MODEL,
      defaultThinkMode: process.env.MINICPM5_DEFAULT_THINK_MODE,
    },
    database: { url: process.env.DATABASE_URL },
    redis: { url: process.env.REDIS_URL },
    objectStore: {
      kind: process.env.OBJECT_STORE_KIND,
      endpoint: process.env.MINIO_ENDPOINT,
      accessKey: process.env.MINIO_ACCESS_KEY,
      secretKey: process.env.MINIO_SECRET_KEY,
      bucket: process.env.MINIO_BUCKET,
      region: process.env.MINIO_REGION,
    },
    sandbox: {
      image: process.env.SANDBOX_IMAGE,
      network: process.env.SANDBOX_NETWORK,
      cpuLimit: process.env.SANDBOX_CPU_LIMIT,
      memoryLimitMb: process.env.SANDBOX_MEMORY_LIMIT_MB,
      timeoutMs: process.env.SANDBOX_TIMEOUT_MS,
      workDir: process.env.SANDBOX_WORK_DIR,
    },
    context: {
      budgetTokens: process.env.CONTEXT_BUDGET_TOKENS,
      reserveTokens: process.env.CONTEXT_RESERVE_TOKENS,
    },
    retrieval: {
      topK: process.env.RETRIEVAL_TOP_K,
      rerank: process.env.RETRIEVAL_RERANK,
      minScore: process.env.RETRIEVAL_MIN_SCORE,
    },
    memory: {
      episodicTtlDays: process.env.MEMORY_EPISODIC_TTL_DAYS,
      importanceThreshold: process.env.MEMORY_IMPORTANCE_THRESHOLD,
    },
    escalation: {
      maxRetries: process.env.ESCALATION_MAX_RETRIES,
      fallbackModel: process.env.ESCALATION_FALLBACK_MODEL,
      fallbackBaseUrl: process.env.ESCALATION_FALLBACK_BASE_URL,
      fallbackApiKey: process.env.ESCALATION_FALLBACK_API_KEY,
    },
    security: {
      jwtSecret: process.env.SUPERVISOR_JWT_SECRET,
      requireApprovalFor: process.env.SUPERVISOR_REQUIRE_APPROVAL_FOR,
      rateLimitPerMin: process.env.SUPERVISOR_RATE_LIMIT_PER_MIN,
    },
    observability: {
      otelExporterOtlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      otelServiceName: process.env.OTEL_SERVICE_NAME,
      otelEnabled: process.env.OTEL_ENABLED,
    },
  };

  // Strip undefined values so zod defaults apply
  const cleaned = JSON.parse(JSON.stringify(raw), (_k, v) => (v === undefined ? undefined : v));
  return schema.parse(cleaned);
}

export const supervisorConfig: SupervisorConfig = loadConfig();
Object.freeze(supervisorConfig);
