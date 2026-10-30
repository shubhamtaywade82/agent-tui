/**
 * Configuration for the System One harness. All fields have sensible
 * defaults mirroring the reference architecture; every field is also
 * env-overridable via {@link loadHarnessConfigFromEnv} so operators can
 * tune thresholds without touching code.
 */

import { KEEP_ALIVE_INDEFINITE } from '@nemesis-oss/ollama-sdk';

import type { DomainRoute } from './types.js';

/**
 * Default System 1 (<4B) model catalog, in priority order. The harness
 * picks the first one that is locally available via `ollama list`. All
 * entries are real tags on https://ollama.com/library — verified
 * 2026-10-28. Override the whole list or pin a single model via
 * `SYSTEM_ONE_MODEL`.
 */
export const DEFAULT_SYSTEM_ONE_CATALOG = [
  'tev1:0.8b',
  'qwen2.5:1.5b',
  'llama3.2:1b',
  'gemma2:2b',
  'phi3.5:3.8b',
] as const;

/**
 * Default System 2 reasoner catalog. Per the operator's choice ("Either"),
 * the harness accepts both large reasoners (8B+, for an 8 GB+ GPU) and
 * small ones (<4B, for a constrained GPU). The auto-pick walks this list
 * in order and uses the first locally-available model.
 */
export const DEFAULT_SYSTEM_TWO_CATALOG = [
  // Large reasoners — preferred when VRAM allows.
  'qwen3:8b',
  'deepseek-coder:6.7b',
  'glm-4.7:cloud',
  // Small reasoners — fallback for 8 GB GPUs.
  'tev1:4b',
  'qwen2.5:3b',
  'llama3.2:3b',
] as const;

/**
 * Full harness configuration. Construct via {@link loadHarnessConfigFromEnv}
 * for production, or pass a literal object for tests.
 */
export interface HarnessConfig {
  /** Pinned System 1 model. When unset, the harness auto-picks from the catalog. */
  readonly systemOneModel?: string;
  /** Pinned System 2 model. When unset, the harness auto-picks from the catalog. */
  readonly systemTwoModel?: string;
  /** Ordered list of <4B candidates for System 1 auto-pick. */
  readonly systemOneCatalog: readonly string[];
  /** Ordered list of candidates for System 2 auto-pick. */
  readonly systemTwoCatalog: readonly string[];
  /** Ollama base URL. Defaults to `OLLAMA_HOST` or `http://localhost:11434`. */
  readonly baseUrl: string;
  /** Ollama Cloud API key (only needed for `:cloud` models). */
  readonly apiKey?: string;
  /**
   * Additional endpoints for HA failover. When set, the SDK's
   * `EndpointRegistry` round-robins on failure. Order = priority.
   */
  readonly endpoints?: readonly string[];
  /** Minimum routing confidence (0–1) below which the turn falls back to `direct_reply`. */
  readonly minRouteConfidence: number;
  /** Minimum routing probability (0–1) — kept for parity with the reference. */
  readonly minRouteProbability: number;
  /** Minimum verification probability (0–1) below which the answer is rejected. */
  readonly minVerifyProbability: number;
  /** Keep-alive for both models. `-1` (KEEP_ALIVE_INDEFINITE) pins them in VRAM. */
  readonly keepAlive: number;
  /** Context window cap (tokens) — keeps an 8 GB GPU from swapping. */
  readonly contextWindow: number;
  /** Sampling temperature for the System 2 reasoner. */
  readonly temperature: number;
  /** Maximum Agent iterations before the loop gives up. */
  readonly maxIterations: number;
  /** Maximum total tool calls across one Agent run. */
  readonly maxToolCalls: number;
  /**
   * Domains the harness routes between. Each must have a matching entry in
   * the registries map passed to {@link CoHostedAgentHarness}. Always
   * includes `direct_reply` as the bypass route.
   */
  readonly domains: readonly DomainRoute[];
}

/** Default thresholds — mirror the reference architecture in §2. */
export const DEFAULT_CONFIG: HarnessConfig = {
  systemOneCatalog: DEFAULT_SYSTEM_ONE_CATALOG,
  systemTwoCatalog: DEFAULT_SYSTEM_TWO_CATALOG,
  baseUrl: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  apiKey: process.env.OLLAMA_API_KEY,
  minRouteConfidence: 0.65,
  minRouteProbability: 0.6,
  minVerifyProbability: 0.85,
  keepAlive: KEEP_ALIVE_INDEFINITE,
  contextWindow: 4096,
  temperature: 0.2,
  maxIterations: 10,
  maxToolCalls: 20,
  domains: ['market_data', 'backtest', 'direct_reply'],
};

/**
 * Build a {@link HarnessConfig} from environment variables, falling back
 * to {@link DEFAULT_CONFIG} for anything unset. Recognized vars:
 *
 *   SYSTEM_ONE_MODEL         — pin S1, skip auto-pick
 *   SYSTEM_TWO_MODEL         — pin S2, skip auto-pick
 *   SYSTEM_ONE_CATALOG       — comma-separated S1 candidates (overrides default)
 *   SYSTEM_TWO_CATALOG       — comma-separated S2 candidates (overrides default)
 *   OLLAMA_HOST              — base URL
 *   OLLAMA_API_KEY           — cloud API key
 *   OLLAMA_ENDPOINTS         — comma-separated HA endpoints
 *   MIN_ROUTE_CONFIDENCE     — float 0–1
 *   MIN_ROUTE_PROBABILITY    — float 0–1
 *   MIN_VERIFY_PROBABILITY   — float 0–1
 *   KEEP_ALIVE               — seconds, -1 for indefinite
 *   CONTEXT_WINDOW           — tokens
 *   TEMPERATURE              — float
 *   MAX_ITERATIONS           — int
 *   MAX_TOOL_CALLS           — int
 */
export function loadHarnessConfigFromEnv(overrides?: Partial<HarnessConfig>): HarnessConfig {
  const env = process.env;
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? fallback : parsed;
  };
  const list = (key: string, fallback: readonly string[]): readonly string[] => {
    const raw = env[key];
    if (!raw) return fallback;
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };
  const endpoints = env.OLLAMA_ENDPOINTS
    ? env.OLLAMA_ENDPOINTS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  return {
    ...DEFAULT_CONFIG,
    systemOneModel: env.SYSTEM_ONE_MODEL || undefined,
    systemTwoModel: env.SYSTEM_TWO_MODEL || undefined,
    systemOneCatalog: list('SYSTEM_ONE_CATALOG', DEFAULT_CONFIG.systemOneCatalog),
    systemTwoCatalog: list('SYSTEM_TWO_CATALOG', DEFAULT_CONFIG.systemTwoCatalog),
    baseUrl: env.OLLAMA_HOST ?? DEFAULT_CONFIG.baseUrl,
    apiKey: env.OLLAMA_API_KEY ?? DEFAULT_CONFIG.apiKey,
    endpoints: endpoints && endpoints.length > 0 ? endpoints : undefined,
    minRouteConfidence: num('MIN_ROUTE_CONFIDENCE', DEFAULT_CONFIG.minRouteConfidence),
    minRouteProbability: num('MIN_ROUTE_PROBABILITY', DEFAULT_CONFIG.minRouteProbability),
    minVerifyProbability: num('MIN_VERIFY_PROBABILITY', DEFAULT_CONFIG.minVerifyProbability),
    keepAlive: num('KEEP_ALIVE', DEFAULT_CONFIG.keepAlive),
    contextWindow: num('CONTEXT_WINDOW', DEFAULT_CONFIG.contextWindow),
    temperature: num('TEMPERATURE', DEFAULT_CONFIG.temperature),
    maxIterations: num('MAX_ITERATIONS', DEFAULT_CONFIG.maxIterations),
    maxToolCalls: num('MAX_TOOL_CALLS', DEFAULT_CONFIG.maxToolCalls),
    ...overrides,
  };
}
