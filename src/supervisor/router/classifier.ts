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

import type { Backend } from '../inference/backend.js';
import { logger } from '../observability/logger.js';
import { Intent } from '../state/models.js';

export interface RouteDecision {
  intent: Intent;
  raw: string;
  /** True if the model output had to be repaired (loose parsing fallback). */
  repaired: boolean;
}

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

    if (r.parsed && typeof r.json === 'object' && r.json !== null) {
      const v = (r.json as { intent?: unknown }).intent;
      if (typeof v === 'string') {
        const normalized = v.toUpperCase().replace(/[\s-]+/g, '_');
        const parsed = Intent.safeParse(normalized);
        if (parsed.success) intent = parsed.data;
      }
    }

    if (!intent) {
      // Repair attempt: regex-extract any of the enum values from raw text.
      repaired = true;
      const m = raw.match(
        /\b(DATA_EXTRACTION|CODE_REVIEW|TOOL_EXECUTION|LOG_SUMMARIZATION|GENERAL_QUERY)\b/i,
      );
      if (m) {
        const parsed = Intent.safeParse(m[1]?.toUpperCase());
        if (parsed.success) intent = parsed.data;
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
