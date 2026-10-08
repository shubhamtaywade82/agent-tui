/**
 * Model router — §13.1 (Routing Criteria) and §13.2 (Router Design).
 *
 * Combines the intent classification (§13.1 from the router model) and the
 * complexity scorer (§13.2 deterministic heuristic) into a single
 * `ModelChoice`. The choice determines:
 *
 *   - which MiniCPM5 sub-agent model handles the task (or whether to skip
 *     MiniCPM5 entirely and escalate to the fallback model)
 *   - whether to engage "think" mode (§13.3) for deeper reasoning
 *
 * Escalation criteria mirror §13.1 verbatim:
 *   - multi-file architectural refactoring
 *   - repeated test failures
 *   - long-horizon terminal work
 *   - advanced scientific reasoning
 *   - high business risk
 *   - repeated validation failures
 *   - conflicting retrieval evidence
 *   - model-expressed uncertainty
 */

import { supervisorConfig } from '../config.js';
import type { Intent } from '../state/models.js';
import type { ComplexityScore } from './complexity.js';

export type ModelChoice =
  | {
      kind: 'local';
      intent: Intent;
      model: string; // one of the minicpm5-* models
      thinkMode: 'think' | 'no-think';
    }
  | {
      kind: 'escalate';
      intent: Intent;
      reason: string;
      fallbackModel: string;
    };

const INTENT_TO_MODEL: Record<
  Exclude<Intent, 'UNKNOWN'>,
  keyof typeof supervisorConfig.inference
> = {
  DATA_EXTRACTION: 'analystModel',
  CODE_REVIEW: 'analystModel',
  TOOL_EXECUTION: 'toolModel',
  LOG_SUMMARIZATION: 'summarizerModel',
  GENERAL_QUERY: 'analystModel',
};

export class ModelRouter {
  decide(
    intent: Intent,
    complexity: ComplexityScore,
    opts: { retryCount?: number; validationFailures?: number } = {},
  ): ModelChoice {
    const retryCount = opts.retryCount ?? 0;
    const validationFailures = opts.validationFailures ?? 0;

    // Hard escalation triggers first (§13.1 — "Escalate when…")
    if (validationFailures >= 3) {
      return this.escalate(intent, `validation failures: ${validationFailures}`);
    }
    if (retryCount >= supervisorConfig.escalation.maxRetries) {
      return this.escalate(intent, `max retries exceeded: ${retryCount}`);
    }
    if (complexity.recommendation === 'escalate') {
      return this.escalate(
        intent,
        `complexity ${complexity.score.toFixed(2)}: ${complexity.reasons.join('; ')}`,
      );
    }
    if (intent === 'UNKNOWN') {
      // Unknown intent is not an escalation per se; route to analyst with think mode.
      return {
        kind: 'local',
        intent,
        model: supervisorConfig.inference.analystModel,
        thinkMode: 'think',
      };
    }

    const modelKey = INTENT_TO_MODEL[intent];
    const model = supervisorConfig.inference[modelKey] as string;

    // §13.3 — choose think mode by intent and complexity
    const thinkMode: 'think' | 'no-think' =
      intent === 'CODE_REVIEW' || complexity.score >= 0.3
        ? 'think'
        : supervisorConfig.inference.defaultThinkMode;

    return { kind: 'local', intent, model, thinkMode };
  }

  private escalate(intent: Intent, reason: string): ModelChoice {
    const fallback = supervisorConfig.escalation.fallbackModel;
    if (!fallback) {
      // No fallback configured — degrade to local with think mode and warn.
      return {
        kind: 'local',
        intent,
        model: supervisorConfig.inference.analystModel,
        thinkMode: 'think',
      };
    }
    return { kind: 'escalate', intent, reason, fallbackModel: fallback };
  }
}
