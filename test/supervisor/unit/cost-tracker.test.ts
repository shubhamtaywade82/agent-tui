/**
 * Cost tracker — ADR 0012.
 *
 * Verifies that:
 *   - The pricing table lookup resolves known + unknown models correctly.
 *   - Cost is computed per-call using the table's $/1M-token rates.
 *   - Per-run + per-goal ledgers accumulate correctly.
 *   - BudgetExceededError is thrown when the cap is exceeded.
 *   - Per-model env overrides take precedence over the built-in table.
 *   - The supervisor engine records cost after each invocation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  CostTracker,
  createCostTrackerFromEnv,
  loadPricingOverridesFromEnv,
  PRICING_TABLE,
} from '../../../src/supervisor/observability/cost-tracker.js';

describe('PRICING_TABLE', () => {
  it('includes common OpenAI models', () => {
    expect(PRICING_TABLE['gpt-4o']).toBeDefined();
    expect(PRICING_TABLE['gpt-4o']?.inputPer1M).toBeGreaterThan(0);
    expect(PRICING_TABLE['gpt-4o']?.outputPer1M).toBeGreaterThan(
      PRICING_TABLE['gpt-4o']?.inputPer1M ?? 0,
    );
  });

  it('includes common Anthropic models', () => {
    expect(PRICING_TABLE['claude-3-5-sonnet-20241022']).toBeDefined();
    expect(PRICING_TABLE['claude-3-5-sonnet-20241022']?.inputPer1M).toBeGreaterThan(0);
  });

  it('includes common Gemini models', () => {
    expect(PRICING_TABLE['gemini-2.0-flash']).toBeDefined();
    expect(PRICING_TABLE['gemini-1.5-pro']).toBeDefined();
  });

  it('marks MiniCPM5 variants as 0-cost (local models)', () => {
    expect(PRICING_TABLE['minicpm5-router']?.inputPer1M).toBe(0);
    expect(PRICING_TABLE['minicpm5-analyst']?.outputPer1M).toBe(0);
  });
});

describe('CostTracker — pricing lookup', () => {
  it('resolves known models from the built-in table', () => {
    const t = new CostTracker();
    expect(t.lookupPricing('gpt-4o').inputPer1M).toBe(2.5);
  });

  it('falls back to the default for unknown models (conservative estimate)', () => {
    const t = new CostTracker(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, {
      inputPer1M: 1.0,
      outputPer1M: 3.0,
      cachedInputPer1M: null,
    });
    const p = t.lookupPricing('unknown-model');
    expect(p.inputPer1M).toBe(1.0);
    expect(p.outputPer1M).toBe(3.0);
  });

  it('honours operator-provided overrides over the built-in table', () => {
    const t = new CostTracker(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      { inputPer1M: 1.0, outputPer1M: 3.0, cachedInputPer1M: null },
      { 'gpt-4o': { inputPer1M: 9.99, outputPer1M: 99.99 } },
    );
    expect(t.lookupPricing('gpt-4o').inputPer1M).toBe(9.99);
    expect(t.lookupPricing('gpt-4o').outputPer1M).toBe(99.99);
  });
});

describe('CostTracker — cost computation', () => {
  it('computes cost as input × rate + output × rate (per 1M tokens)', () => {
    const t = new CostTracker();
    // gpt-4o: $2.50/1M input + $10/1M output.
    // 1_000_000 input tokens + 500_000 output tokens
    //   = $2.50 + $5.00 = $7.50
    const cost = t.computeCost('gpt-4o', 1_000_000, 500_000);
    expect(cost).toBeCloseTo(7.5, 4);
  });

  it('computes 0 cost for local MiniCPM5 variants', () => {
    const t = new CostTracker();
    const cost = t.computeCost('minicpm5-analyst', 1_000_000, 500_000);
    expect(cost).toBe(0);
  });

  it('uses cached-prompt rate when the model supports it', () => {
    const t = new CostTracker();
    // gpt-4o: $2.50/1M input + $1.25/1M cached + $10/1M output.
    // 1_000_000 prompt + 500_000 cached + 100_000 completion
    //   = (1_000_000 - 500_000) × 2.50/1M + 500_000 × 1.25/1M + 100_000 × 10/1M
    //   = 1.25 + 0.625 + 1.0 = $2.875
    const cost = t.computeCost('gpt-4o', 1_000_000, 100_000, 500_000);
    expect(cost).toBeCloseTo(2.875, 4);
  });
});

describe('CostTracker — ledger accumulation', () => {
  it('accumulates cost per run', () => {
    const t = new CostTracker();
    t.recordUsage({
      runId: 'r1',
      model: 'gpt-4o',
      promptTokens: 1_000_000,
      completionTokens: 100_000,
    });
    t.recordUsage({
      runId: 'r1',
      model: 'gpt-4o',
      promptTokens: 500_000,
      completionTokens: 50_000,
    });

    const snapshot = t.getRunCost('r1');
    // Two calls: $2.50 + $1 + $1.25 + $0.5 = $5.25
    expect(snapshot.totalCostUsd).toBeCloseTo(5.25, 4);
    expect(snapshot.totalPromptTokens).toBe(1_500_000);
    expect(snapshot.totalCompletionTokens).toBe(150_000);
    expect(snapshot.entries).toHaveLength(2);
  });

  it('accumulates cost per goal across multiple runs', () => {
    const t = new CostTracker();
    t.recordUsage({
      runId: 'r1',
      goalId: 'g1',
      model: 'gpt-4o',
      promptTokens: 1_000_000,
      completionTokens: 100_000,
    });
    t.recordUsage({
      runId: 'r2',
      goalId: 'g1',
      model: 'gpt-4o',
      promptTokens: 500_000,
      completionTokens: 50_000,
    });

    const snapshot = t.getGoalCost('g1');
    expect(snapshot.totalCostUsd).toBeCloseTo(5.25, 4);
    expect(snapshot.entries).toHaveLength(2);
  });

  it('clearRun deletes the per-run ledger but not the per-goal ledger', () => {
    const t = new CostTracker();
    t.recordUsage({
      runId: 'r1',
      goalId: 'g1',
      model: 'gpt-4o',
      promptTokens: 1_000_000,
      completionTokens: 100_000,
    });

    t.clearRun('r1');
    expect(t.getRunCost('r1').entries).toHaveLength(0);
    expect(t.getGoalCost('g1').entries).toHaveLength(1);
  });
});

describe('CostTracker — budget enforcement', () => {
  it('throws BudgetExceededError when per-run cap is exceeded', () => {
    const t = new CostTracker(/* maxPerRun */ 1.0);
    // First call: $2.50 + $1 = $3.50 → exceeds $1.00 cap.
    expect(() =>
      t.recordUsage({
        runId: 'r1',
        model: 'gpt-4o',
        promptTokens: 1_000_000,
        completionTokens: 100_000,
      }),
    ).toThrow(BudgetExceededError);

    try {
      t.recordUsage({
        runId: 'r1',
        model: 'gpt-4o',
        promptTokens: 1_000_000,
        completionTokens: 100_000,
      });
    } catch (e) {
      const err = e as BudgetExceededError;
      expect(err.scope).toBe('run');
      expect(err.runId).toBe('r1');
      expect(err.capUsd).toBe(1.0);
      expect(err.model).toBe('gpt-4o');
    }
  });

  it('throws BudgetExceededError when per-goal cap is exceeded', () => {
    const t = new CostTracker(Number.POSITIVE_INFINITY, /* maxPerGoal */ 5.0);
    t.recordUsage({
      runId: 'r1',
      goalId: 'g1',
      model: 'gpt-4o',
      promptTokens: 1_000_000,
      completionTokens: 100_000,
    });
    // After first call: $3.50. Second call would push to $7.00 → exceeds $5.00.
    expect(() =>
      t.recordUsage({
        runId: 'r2',
        goalId: 'g1',
        model: 'gpt-4o',
        promptTokens: 1_000_000,
        completionTokens: 100_000,
      }),
    ).toThrow(BudgetExceededError);

    try {
      t.recordUsage({
        runId: 'r2',
        goalId: 'g1',
        model: 'gpt-4o',
        promptTokens: 1_000_000,
        completionTokens: 100_000,
      });
    } catch (e) {
      const err = e as BudgetExceededError;
      expect(err.scope).toBe('goal');
      expect(err.goalId).toBe('g1');
    }
  });

  it('does not throw when cumulative cost stays under the cap', () => {
    const t = new CostTracker(10.0);
    expect(() =>
      t.recordUsage({
        runId: 'r1',
        model: 'gpt-4o',
        promptTokens: 1_000_000,
        completionTokens: 100_000,
      }),
    ).not.toThrow();
  });

  it('wouldExceedGoalBudget returns true before starting a costly task', () => {
    const t = new CostTracker(Number.POSITIVE_INFINITY, 5.0);
    t.recordUsage({
      runId: 'r1',
      goalId: 'g1',
      model: 'gpt-4o',
      promptTokens: 1_000_000,
      completionTokens: 100_000,
    });
    // Spent $3.50; an additional $2.00 would push to $5.50 → exceeds $5.00 cap.
    expect(t.wouldExceedGoalBudget('g1', 2.0)).toBe(true);
    // An additional $1.00 would push to $4.50 → still under $5.00 cap.
    expect(t.wouldExceedGoalBudget('g1', 1.0)).toBe(false);
  });
});

describe('CostTracker — env loader', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env after each test.
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it('loads per-model pricing overrides from BUDGET_PRICING_<MODEL> env vars', () => {
    process.env.BUDGET_PRICING_CUSTOM_MODEL = '1.50|4.50|0.30';
    const overrides = loadPricingOverridesFromEnv();
    expect(overrides['custom-model']).toEqual({
      inputPer1M: 1.5,
      outputPer1M: 4.5,
      cachedInputPer1M: 0.3,
    });
  });

  it('parses overrides without a cached rate (2-part format)', () => {
    process.env.BUDGET_PRICING_SIMPLE = '0.5|1.5';
    const overrides = loadPricingOverridesFromEnv();
    expect(overrides.simple.inputPer1M).toBe(0.5);
    expect(overrides.simple.outputPer1M).toBe(1.5);
    expect(overrides.simple.cachedInputPer1M).toBeNull();
  });

  it('createCostTrackerFromEnv reads caps from BUDGET_MAX_COST_USD_*', () => {
    process.env.BUDGET_MAX_COST_USD_PER_RUN = '2.50';
    process.env.BUDGET_MAX_COST_USD_PER_GOAL = '25.0';
    process.env.BUDGET_FALLBACK_INPUT_PER_1M = '0.50';
    process.env.BUDGET_FALLBACK_OUTPUT_PER_1M = '1.50';
    const t = createCostTrackerFromEnv();
    // Verify caps via behaviour: a $2.50 cap trips when an unknown-model
    // call exceeds it. Fallback pricing is $0.50/1M input + $1.50/1M output.
    // 10M input + 1M output = $5 + $1.50 = $6.50 → exceeds $2.50.
    expect(() =>
      t.recordUsage({
        runId: 'r1',
        model: 'totally-unknown-model',
        promptTokens: 10_000_000,
        completionTokens: 1_000_000,
      }),
    ).toThrow(BudgetExceededError);
    // Verify the fallback pricing was applied (not the default $1/$3).
    expect(t.lookupPricing('totally-unknown-model').inputPer1M).toBe(0.5);
    expect(t.lookupPricing('totally-unknown-model').outputPer1M).toBe(1.5);
  });

  it('defaults to Infinity when caps are not set', () => {
    delete process.env.BUDGET_MAX_COST_USD_PER_RUN;
    delete process.env.BUDGET_MAX_COST_USD_PER_GOAL;
    const t = createCostTrackerFromEnv();
    // Verify default cap by recording a large usage that would exceed any
    // finite cap but should NOT throw with Infinity.
    expect(() =>
      t.recordUsage({
        runId: 'r1',
        model: 'gpt-4o',
        promptTokens: 100_000_000,
        completionTokens: 100_000_000,
      }),
    ).not.toThrow();
  });
});
