/**
 * Cost tracker — ADR 0012. Accumulates token usage per run and per goal,
 * computes USD cost from a built-in pricing table, and enforces hard
 * budget caps.
 *
 * The pricing table covers the common production models across the five
 * first-class providers (OpenAI, Anthropic, Gemini, vLLM/Ollama via 0-cost
 * for local models, Mock). Unknown models default to a conservative
 * per-1M-token estimate that the operator can override via env vars.
 *
 * Caps:
 *   - `BUDGET_MAX_COST_USD_PER_RUN` — aborts the current run mid-generation
 *     when the cumulative cost exceeds this. The run transitions to FAILED
 *     with a `budget_exceeded` reason.
 *   - `BUDGET_MAX_COST_USD_PER_GOAL` — aborts the goal when cumulative cost
 *     across all tasks in the goal exceeds this. Checked before each task
 *     starts.
 *
 * Both caps default to Infinity (no cap). Operators are encouraged to set
 * them in production cloud deployments to prevent runaway costs.
 *
 * Persistence: the cost ledger is in-memory only (per-process). A future
 * enhancement could persist to the events table so cost survives restarts.
 *
 * See docs/supervisor/adr/0012-cost-budget-accounting.md.
 */
import { logger } from '../observability/logger.js';

/**
 * Pricing entry — USD per 1,000,000 tokens. `cached` is the prompt-cache
 * rate (when the provider supports it); `null` means no separate cache rate.
 */
export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M cached input tokens, when the provider supports a cache (OpenAI prompt cache, Anthropic prompt cache). `null` = no cache rate. */
  cachedInputPer1M?: number | null;
}

/**
 * Built-in pricing table. Prices are USD per 1M tokens, sourced from
 * each provider's public pricing page at the time of writing (2026-Q4).
 * Operators can override per-model via env vars or extend this table in
 * code. Local models (Ollama, vLLM self-hosted) are 0-cost.
 *
 * Unknown models default to a conservative estimate
 * (inputPer1M=$1.00, outputPer1M=$3.00) — this prevents runaway costs
 * from a misconfigured model name from going unnoticed. Override via
 * `BUDGET_FALLBACK_INPUT_PER_1M` and `BUDGET_FALLBACK_OUTPUT_PER_1M`.
 */
export const PRICING_TABLE: Record<string, ModelPricing> = {
  // ── OpenAI ──────────────────────────────────────────────────────────
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10, cachedInputPer1M: 1.25 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 },
  'gpt-4-turbo': { inputPer1M: 10, outputPer1M: 30 },
  'gpt-4': { inputPer1M: 30, outputPer1M: 60 },
  'gpt-3.5-turbo': { inputPer1M: 0.5, outputPer1M: 1.5 },
  o1: { inputPer1M: 15, outputPer1M: 60, cachedInputPer1M: 7.5 },
  'o1-mini': { inputPer1M: 1.1, outputPer1M: 4.4, cachedInputPer1M: 0.55 },
  'o1-pro': { inputPer1M: 150, outputPer1M: 600 },
  o3: { inputPer1M: 10, outputPer1M: 40, cachedInputPer1M: 5 },
  'o3-mini': { inputPer1M: 1.1, outputPer1M: 4.4, cachedInputPer1M: 0.55 },
  'o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4, cachedInputPer1M: 0.55 },
  // OpenAI embeddings (used for the OpenAIEmbedder cost accounting).
  'text-embedding-3-small': { inputPer1M: 0.02, outputPer1M: 0 },
  'text-embedding-3-large': { inputPer1M: 0.13, outputPer1M: 0 },
  'text-embedding-ada-002': { inputPer1M: 0.1, outputPer1M: 0 },

  // ── Anthropic ────────────────────────────────────────────────────────
  'claude-3-5-sonnet-20241022': { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 },
  'claude-3-5-sonnet-20240620': { inputPer1M: 3, outputPer1M: 15 },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.8, outputPer1M: 4, cachedInputPer1M: 0.08 },
  'claude-3-opus-20240229': { inputPer1M: 15, outputPer1M: 75 },
  'claude-3-sonnet-20240229': { inputPer1M: 3, outputPer1M: 15 },
  'claude-3-haiku-20240307': { inputPer1M: 0.25, outputPer1M: 1.25 },
  'claude-opus-4-20250514': { inputPer1M: 15, outputPer1M: 75, cachedInputPer1M: 1.5 },
  'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 },

  // ── Google Gemini ────────────────────────────────────────────────────
  // Gemini 2.0 Flash is free tier (rate-limited) + paid tier — we list
  // the paid tier prices; the free tier is effectively 0-cost.
  'gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4, cachedInputPer1M: 0.025 },
  'gemini-2.0-flash-thinking': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gemini-1.5-pro': { inputPer1M: 1.25, outputPer1M: 5, cachedInputPer1M: 0.3125 },
  'gemini-1.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3, cachedInputPer1M: 0.01875 },
  'gemini-1.5-flash-8b': { inputPer1M: 0.0375, outputPer1M: 0.15 },

  // ── DeepSeek (via OpenAI-compatible API) ─────────────────────────────
  'deepseek-chat': { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.014 },
  'deepseek-coder': { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.014 },
  'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19 },

  // ── Local / self-hosted (0-cost) ─────────────────────────────────────
  // MiniCPM5 variants on Ollama / vLLM are 0-cost — the operator pays
  // for the hardware, not per-token. These defaults make the cost tracker
  // report $0 for local deployments.
  'minicpm5-router': { inputPer1M: 0, outputPer1M: 0 },
  'minicpm5-analyst': { inputPer1M: 0, outputPer1M: 0 },
  'minicpm5-toolagent': { inputPer1M: 0, outputPer1M: 0 },
  'minicpm5-summarizer': { inputPer1M: 0, outputPer1M: 0 },
  'nomic-embed-text': { inputPer1M: 0, outputPer1M: 0 },
  'bge-m3': { inputPer1M: 0, outputPer1M: 0 },
  'mxbai-embed-large': { inputPer1M: 0, outputPer1M: 0 },
};

const DEFAULT_FALLBACK: ModelPricing = {
  inputPer1M: 1.0,
  outputPer1M: 3.0,
  cachedInputPer1M: null,
};

export class BudgetExceededError extends Error {
  constructor(
    public readonly scope: 'run' | 'goal',
    public readonly goalId: string | undefined,
    public readonly runId: string | undefined,
    public readonly spentUsd: number,
    public readonly capUsd: number,
    public readonly model: string,
  ) {
    super(
      `budget exceeded (${scope}): spent $${spentUsd.toFixed(6)} on model ${model}, cap $${capUsd.toFixed(6)}. ` +
        `Run aborted to prevent runaway cost.`,
    );
    this.name = 'BudgetExceededError';
  }
}

export interface CostEntry {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  costUsd: number;
  timestamp: number;
}

export interface CostLedgerSnapshot {
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedPromptTokens: number;
  entries: CostEntry[];
}

/**
 * Cost tracker — accumulates usage per run + per goal, enforces caps.
 *
 * One tracker per process. Thread-safe via JS single-threaded execution
 * model (all mutations happen on the main event loop).
 */
export class CostTracker {
  /** Per-runId ledger. */
  private readonly runLedgers = new Map<string, CostEntry[]>();
  /** Per-goalId ledger (rolls up across runs in the same goal). */
  private readonly goalLedgers = new Map<string, CostEntry[]>();

  constructor(
    private readonly maxCostPerRunUsd: number = Number.POSITIVE_INFINITY,
    private readonly maxCostPerGoalUsd: number = Number.POSITIVE_INFINITY,
    private readonly fallbackPricing: ModelPricing = DEFAULT_FALLBACK,
    /** Optional override table (env-provided). Keys are model names. */
    private readonly overrides: Record<string, ModelPricing> = {},
  ) {}

  /**
   * Look up the pricing for a model. Resolution order:
   *   1. `overrides[model]` (env-provided)
   *   2. `PRICING_TABLE[model]` (built-in)
   *   3. `fallbackPricing` (default — conservative estimate)
   */
  lookupPricing(model: string): ModelPricing {
    return this.overrides[model] ?? PRICING_TABLE[model] ?? this.fallbackPricing;
  }

  /**
   * Compute the USD cost of a single inference call.
   */
  computeCost(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedPromptTokens: number = 0,
  ): number {
    const p = this.lookupPricing(model);
    const inputCost = ((promptTokens - cachedPromptTokens) * p.inputPer1M) / 1_000_000;
    const cachedCost =
      cachedPromptTokens > 0 && p.cachedInputPer1M != null
        ? (cachedPromptTokens * p.cachedInputPer1M) / 1_000_000
        : 0;
    const outputCost = (completionTokens * p.outputPer1M) / 1_000_000;
    return inputCost + cachedCost + outputCost;
  }

  /**
   * Record a usage event against a run (and optionally a goal). Throws
   * `BudgetExceededError` when the cumulative cost exceeds the configured
   * per-run or per-goal cap.
   */
  recordUsage(params: {
    runId: string;
    goalId?: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens?: number;
  }): CostEntry {
    const costUsd = this.computeCost(
      params.model,
      params.promptTokens,
      params.completionTokens,
      params.cachedPromptTokens ?? 0,
    );
    const entry: CostEntry = {
      model: params.model,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      cachedPromptTokens: params.cachedPromptTokens ?? 0,
      costUsd,
      timestamp: Date.now(),
    };

    // Append to per-run ledger.
    const runEntries = this.runLedgers.get(params.runId) ?? [];
    runEntries.push(entry);
    this.runLedgers.set(params.runId, runEntries);
    const runTotal = runEntries.reduce((s, e) => s + e.costUsd, 0);
    if (runTotal > this.maxCostPerRunUsd) {
      logger.error(
        { runId: params.runId, model: params.model, runTotal, cap: this.maxCostPerRunUsd },
        'cost budget exceeded for run — aborting',
      );
      throw new BudgetExceededError(
        'run',
        undefined,
        params.runId,
        runTotal,
        this.maxCostPerRunUsd,
        params.model,
      );
    }

    // Append to per-goal ledger when supplied.
    if (params.goalId) {
      const goalEntries = this.goalLedgers.get(params.goalId) ?? [];
      goalEntries.push(entry);
      this.goalLedgers.set(params.goalId, goalEntries);
      const goalTotal = goalEntries.reduce((s, e) => s + e.costUsd, 0);
      if (goalTotal > this.maxCostPerGoalUsd) {
        logger.error(
          { goalId: params.goalId, model: params.model, goalTotal, cap: this.maxCostPerGoalUsd },
          'cost budget exceeded for goal — aborting',
        );
        throw new BudgetExceededError(
          'goal',
          params.goalId,
          params.runId,
          goalTotal,
          this.maxCostPerGoalUsd,
          params.model,
        );
      }
    }

    return entry;
  }

  /**
   * Check whether a goal would exceed its budget if a hypothetical
   * additional cost were added. Used by the orchestrator before starting
   * a new task — returns true if the new cost would exceed the cap.
   */
  wouldExceedGoalBudget(goalId: string, additionalCostUsd: number): boolean {
    const entries = this.goalLedgers.get(goalId) ?? [];
    const current = entries.reduce((s, e) => s + e.costUsd, 0);
    return current + additionalCostUsd > this.maxCostPerGoalUsd;
  }

  /** Get the cumulative cost + token usage for a run. */
  getRunCost(runId: string): CostLedgerSnapshot {
    return this.snapshot(this.runLedgers.get(runId) ?? []);
  }

  /** Get the cumulative cost + token usage for a goal. */
  getGoalCost(goalId: string): CostLedgerSnapshot {
    return this.snapshot(this.goalLedgers.get(goalId) ?? []);
  }

  /** Clean up the per-run ledger after the run ends. */
  clearRun(runId: string): void {
    this.runLedgers.delete(runId);
  }

  /** Clean up the per-goal ledger after the goal completes. */
  clearGoal(goalId: string): void {
    this.goalLedgers.delete(goalId);
  }

  private snapshot(entries: CostEntry[]): CostLedgerSnapshot {
    return {
      totalCostUsd: entries.reduce((s, e) => s + e.costUsd, 0),
      totalPromptTokens: entries.reduce((s, e) => s + e.promptTokens, 0),
      totalCompletionTokens: entries.reduce((s, e) => s + e.completionTokens, 0),
      totalCachedPromptTokens: entries.reduce((s, e) => s + e.cachedPromptTokens, 0),
      entries,
    };
  }
}

/**
 * Singleton instance — constructed from env vars at module load time.
 * Production deployments should set:
 *   BUDGET_MAX_COST_USD_PER_RUN=1.0   (default: Infinity — no cap)
 *   BUDGET_MAX_COST_USD_PER_GOAL=10.0 (default: Infinity — no cap)
 *   BUDGET_FALLBACK_INPUT_PER_1M=1.00  (default: $1.00 per 1M input tokens)
 *   BUDGET_FALLBACK_OUTPUT_PER_1M=3.00 (default: $3.00 per 1M output tokens)
 *
 * Per-model overrides via `BUDGET_PRICING_<MODEL>=<input>|<output>|<cached>`
 * — see loadPricingOverridesFromEnv().
 */
export function loadPricingOverridesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ModelPricing> {
  const overrides: Record<string, ModelPricing> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('BUDGET_PRICING_')) continue;
    const model = key.slice('BUDGET_PRICING_'.length).toLowerCase().replace(/_/g, '-');
    const parts = (value ?? '').split('|').map((s) => Number.parseFloat(s.trim()));
    if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      overrides[model] = {
        inputPer1M: parts[0],
        outputPer1M: parts[1],
        cachedInputPer1M: parts[2] != null && !Number.isNaN(parts[2]) ? parts[2] : null,
      };
    }
  }
  return overrides;
}

export function createCostTrackerFromEnv(env: NodeJS.ProcessEnv = process.env): CostTracker {
  const maxPerRun = env.BUDGET_MAX_COST_USD_PER_RUN
    ? Number.parseFloat(env.BUDGET_MAX_COST_USD_PER_RUN)
    : Number.POSITIVE_INFINITY;
  const maxPerGoal = env.BUDGET_MAX_COST_USD_PER_GOAL
    ? Number.parseFloat(env.BUDGET_MAX_COST_USD_PER_GOAL)
    : Number.POSITIVE_INFINITY;
  const fallbackInput = env.BUDGET_FALLBACK_INPUT_PER_1M
    ? Number.parseFloat(env.BUDGET_FALLBACK_INPUT_PER_1M)
    : 1.0;
  const fallbackOutput = env.BUDGET_FALLBACK_OUTPUT_PER_1M
    ? Number.parseFloat(env.BUDGET_FALLBACK_OUTPUT_PER_1M)
    : 3.0;
  return new CostTracker(
    maxPerRun,
    maxPerGoal,
    { inputPer1M: fallbackInput, outputPer1M: fallbackOutput, cachedInputPer1M: null },
    loadPricingOverridesFromEnv(env),
  );
}
