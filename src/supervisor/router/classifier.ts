/**
 * Router classifier — §13.1.
 *
 * Calls the `minicpm5-router` model to classify user intent into one of the
 * values of the `Intent` enum. The output is validated against the enum;
 * any unrecognized value collapses to `UNKNOWN` and the original raw text
 * is preserved in `raw` for debugging.
 *
 * This is the §1 validation gate: "If the minicpm5-router outputs an intent
 * not defined in the Intent Enum, the system catches the ValidationError
 * and defaults to UNKNOWN, preventing silent failures."
 */

import { z } from 'zod';
import type { Backend } from '../inference/backend.js';
import { logger } from '../observability/logger.js';
import { zodParseFailureCounter } from '../observability/telemetry.js';
import { Intent } from '../state/models.js';

export interface RouteDecision {
  intent: Intent;
  raw: string;
  /** True if the model output had to be repaired (loose parsing fallback). */
  repaired: boolean;
}

/**
 * RouterOutputSchema — TS Engine §1 (Runtime Validation) + Phase 3 audit.
 *
 * Uses zod's `.catch()` for graceful degradation: any malformed JSON,
 * missing `intent` key, or unrecognised intent value collapses to
 * `{ intent: 'UNKNOWN' }` without throwing. This is the contract the
 * directive specifies — more declarative and future-proof than manual
 * try/catch + regex repair.
 *
 * The `intent` field is preprocessed to normalise case + whitespace
 * before enum validation, so `'tool execution'` and `'Tool-Execution'`
 * both map to `TOOL_EXECUTION`.
 *
 * The `.catch()` handler also increments the drift-detection counter
 * (Phase 6) so Prometheus can alert on router drift.
 */
export const RouterOutputSchema = z
  .object({
    intent: z.preprocess(
      (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[\s-]+/g, '_') : v),
      Intent,
    ),
  })
  .catch((ctx) => {
    // Phase 6 drift detection — meter the catch-path invocation.
    zodParseFailureCounter.add(1, { model: 'minicpm5-router', schema: 'RouterOutputSchema' });
    logger.warn(
      { issue: ctx.error?.message ?? 'unknown' },
      'RouterOutputSchema.catch — defaulting to UNKNOWN',
    );
    return { intent: 'UNKNOWN' as const };
  });

const SYSTEM_GUARD = `Output ONLY a JSON object with the form {"intent": "<ONE_OF>"}.
<ONE_OF> must be one of: DATA_EXTRACTION, CODE_REVIEW, TOOL_EXECUTION, LOG_SUMMARIZATION, GENERAL_QUERY.
Do not include any prose, markdown, or commentary.`;

export class RouterClassifier {
  constructor(
    private readonly backend: Backend,
    private readonly routerModel: string,
  ) {}

  async classify(query: string): Promise<RouteDecision> {
    const prompt = `${SYSTEM_GUARD}\n\nQuery: ${query}`;
    const r = await this.backend.invoke({
      model: this.routerModel,
      prompt,
      formatJson: true,
      temperature: 0.1,
      maxTokens: 512,
    });

    const raw = r.content;
    let intent: Intent | undefined;
    let repaired = false;

    // Primary parse path — RouterOutputSchema.catch() handles malformed
    // JSON, missing keys, and unrecognised intent values, collapsing to
    // { intent: 'UNKNOWN' } and metering the failure via zodParseFailureCounter.
    if (r.parsed && typeof r.json === 'object' && r.json !== null) {
      const result = RouterOutputSchema.safeParse(r.json);
      if (result.success) {
        intent = result.data.intent;
        // If the catch handler fired, result.data.intent will be UNKNOWN
        // and the counter was already incremented. Mark as repaired.
        if (intent === 'UNKNOWN') {
          repaired = true;
        }
      }
    }

    // Secondary repair — regex-extract any enum value from raw text.
    // Only runs if the primary path produced UNKNOWN (or parsed nothing).
    if (!intent || intent === 'UNKNOWN') {
      // Mark as repaired if the primary path produced UNKNOWN (catch handler
      // fired) OR if the primary path didn't run at all (malformed JSON,
      // string output). Either way, we're deviating from the happy path.
      repaired = true;
      const m = raw.match(
        /\b(DATA_EXTRACTION|CODE_REVIEW|TOOL_EXECUTION|LOG_SUMMARIZATION|GENERAL_QUERY)\b/i,
      );
      if (m) {
        const parsed = Intent.safeParse(m[1]?.toUpperCase());
        if (parsed.success) {
          intent = parsed.data;
          // Successful regex repair — don't double-count the failure.
        }
      }
    }

    if (!intent) {
      logger.warn(
        { raw, model: this.routerModel },
        'router failed to parse intent — defaulting to UNKNOWN',
      );
      intent = 'UNKNOWN';
    }

    return { intent, raw, repaired };
  }
}
