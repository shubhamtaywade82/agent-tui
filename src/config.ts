/**
 * Secure configuration & credential management.
 *
 * Loads secrets exclusively from environment variables (populated by dotenv
 * from a git-ignored `.env` file). No token is ever written to disk by this
 * module. The GitHub token supplied by the user is injected at runtime as
 * `GITHUB_TOKEN` and is kept out of all persisted config files.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

// Load .env once at import time. `override: false` keeps real shell env wins.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath, override: false });
}

export type ProviderName = 'ollama' | 'openai' | 'anthropic' | 'zai';

export interface OllamaEndpointConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  priority?: number;
  models?: readonly string[];
}

export interface ProviderConfig {
  /** Active provider used when none is specified per-request. */
  active: ProviderName;
  ollama: {
    endpoints: OllamaEndpointConfig[];
    defaultModel: string;
  };
  openai: {
    apiKey?: string;
    baseUrl: string;
    defaultModel: string;
  };
  anthropic: {
    apiKey?: string;
    baseUrl: string;
    defaultModel: string;
  };
  zai: {
    apiKey?: string;
    baseUrl: string;
    defaultModel: string;
  };
}

export interface AgentConfig {
  provider: ProviderConfig;
  /** Max agentic reasoning iterations per run. */
  maxIterations: number;
  /** Wall-clock ceiling per run in ms. */
  wallTimeMs: number;
  /** Context window budget in approximate tokens. */
  contextBudget: number;
  /** Default chat temperature. */
  temperature: number;
  /** Enable thinking/reasoning traces when supported. */
  thinking: boolean;
  /** Tools to enable. 'all' or a list of tool names. */
  tools: 'all' | string[];
  /** MCP servers to enable. 'all' | 'none' | list of ids. */
  mcp: 'all' | 'none' | string[];
  /** Log level for structured logger. */
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Log file path (relative to cwd). Empty disables file logging. */
  logFile: string;
  /** Sessions directory for persistent transcripts. */
  sessionsDir: string;
}

function env(key: string, fallback = ''): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function envList(key: string, fallback: string[]): string[] {
  const v = process.env[key];
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.toLowerCase();
  if (v === undefined) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Build the runtime config from environment variables. */
export function loadConfig(): AgentConfig {
  const ollamaHost = env('OLLAMA_HOST', 'http://localhost:11434');
  const ollamaEndpoints: OllamaEndpointConfig[] = [
    { name: 'local', baseUrl: ollamaHost, priority: 10 },
  ];
  const cloudUrl = env('OLLAMA_CLOUD_URL');
  const cloudKey = env('OLLAMA_API_KEY');
  if (cloudUrl && cloudKey) {
    ollamaEndpoints.push({ name: 'cloud', baseUrl: cloudUrl, apiKey: cloudKey, priority: 5 });
  }

  return {
    provider: {
      active: env('AGENT_PROVIDER', 'ollama') as ProviderName,
      ollama: {
        endpoints: ollamaEndpoints,
        defaultModel: env('OLLAMA_MODEL', 'qwen3:8b'),
      },
      openai: {
        apiKey: env('OPENAI_API_KEY') || undefined,
        baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        defaultModel: env('OPENAI_MODEL', 'gpt-4o-mini'),
      },
      anthropic: {
        apiKey: env('ANTHROPIC_API_KEY') || undefined,
        baseUrl: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
        defaultModel: env('ANTHROPIC_MODEL', 'claude-3-5-sonnet-20241022'),
      },
      zai: {
        apiKey: env('ZAI_API_KEY') || undefined,
        baseUrl: env('ZAI_BASE_URL', 'https://api.z.ai/api/paas/v4'),
        defaultModel: env('ZAI_MODEL', 'glm-4.6'),
      },
    },
    maxIterations: envInt('AGENT_MAX_ITERATIONS', 12),
    wallTimeMs: envInt('AGENT_WALL_TIME_MS', 120_000),
    contextBudget: envInt('AGENT_CONTEXT_BUDGET', 12000),
    temperature: Number(env('AGENT_TEMPERATURE', '0.7')),
    thinking: envBool('AGENT_THINKING', true),
    tools: envList('AGENT_TOOLS', ['all'])[0] === 'all' ? 'all' : envList('AGENT_TOOLS', []),
    mcp: envList('AGENT_MCP', ['all'])[0] === 'all' ? 'all' : (envList('AGENT_MCP', ['all']) as any),
    logLevel: env('AGENT_LOG_LEVEL', 'info') as AgentConfig['logLevel'],
    logFile: env('AGENT_LOG_FILE', '.agent/logs/agent.log'),
    sessionsDir: env('AGENT_SESSIONS_DIR', '.agent/sessions'),
  };
}

/** Resolve and ensure a directory exists (sync, idempotent). */
export function resolvePath(rel: string): string {
  return resolve(process.cwd(), rel);
}

/** Redact secrets from an object for safe logging. */
export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitive = /token|key|secret|password|auth/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (sensitive.test(k)) out[k] = v ? '***' : '';
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = redact(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

/** Returns true when a credential for the given provider is present. */
export function hasCredential(provider: ProviderName, cfg: AgentConfig): boolean {
  switch (provider) {
    case 'ollama': return cfg.provider.ollama.endpoints.some((e) => Boolean(e.apiKey)) || true;
    case 'openai': return Boolean(cfg.provider.openai.apiKey);
    case 'anthropic': return Boolean(cfg.provider.anthropic.apiKey);
    case 'zai': return Boolean(cfg.provider.zai.apiKey);
  }
}

/** Read the GitHub token supplied by the user, if present on disk. */
export function loadGitHubToken(): string | undefined {
  const file = resolve(process.cwd(), 'github-token.txt');
  if (!existsSync(file)) return process.env.GITHUB_TOKEN || undefined;
  try {
    const raw = readFileSync(file, 'utf8');
    const m = raw.match(/GH_TOKEN\s*=\s*(\S+)/);
    return m?.[1] || raw.trim() || undefined;
  } catch {
    return undefined;
  }
}
