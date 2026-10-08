/**
 * Complexity scorer — §13.1 (Routing Criteria) and §13.2 (Router Design).
 *
 * A cheap heuristic that flags tasks likely to exceed MiniCPM5-2B's
 * validated capability ceiling. Combined with the intent classification,
 * this drives the model-router's escalation decision (§13.1).
 *
 * The heuristic is intentionally conservative: when in doubt, escalate.
 * That matches the §20 final recommendation — "use larger models only
 * when task complexity exceeds the validated capability of the small model".
 */
import type { Intent } from '../state/models.js';

export interface ComplexityScore {
  /** 0..1 — probability this task is too complex for MiniCPM5-2B alone. */
  score: number;
  /** Human-readable rationale for telemetry. */
  reasons: string[];
  /** Recommended action: handle locally, or escalate to the fallback model. */
  recommendation: 'local' | 'escalate';
}

const ESCALATION_TRIGGERS = [
  {
    re: /\b(refactor|rewrite|restructure|re-?architect|migration)\b/i,
    weight: 0.35,
    reason: 'multi-file refactor language',
  },
  {
    re: /\b(subsystem|microservice|monolith|codebase|repository)\b/i,
    weight: 0.2,
    reason: 'large-scope target language',
  },
  {
    re: /\b(autonomous|unattended|hands[- ]?off|self[- ]?healing)\b/i,
    weight: 0.45,
    reason: 'autonomy language',
  },
  {
    re: /\b(production|deploy|rollback|drop|delete)\b/i,
    weight: 0.3,
    reason: 'production-risk language',
  },
  {
    re: /\b(swe[- ]?bench|terminal[- ]?bench|long[- ]?horizon)\b/i,
    weight: 0.55,
    reason: 'known hard benchmark',
  },
  {
    re: /\b(distributed|consensus|raft|paxos|byzantine)\b/i,
    weight: 0.4,
    reason: 'distributed systems reasoning',
  },
  { re: /\b(prove|theorem|lemma|proof|formal)\b/i, weight: 0.35, reason: 'formal reasoning' },
];

const LENGTH_BUCKETS = [
  { max: 200, weight: 0.0 },
  { max: 600, weight: 0.05 },
  { max: 1500, weight: 0.15 },
  { max: Number.POSITIVE_INFINITY, weight: 0.25 },
];

export class ComplexityScorer {
  score(query: string, intent?: Intent | null): ComplexityScore {
    const reasons: string[] = [];
    let s = 0;

    for (const t of ESCALATION_TRIGGERS) {
      if (t.re.test(query)) {
        s += t.weight;
        reasons.push(t.reason);
      }
    }

    const len = query.length;
    const bucket = LENGTH_BUCKETS.find((b) => len <= b.max)!;
    if (bucket.weight > 0) {
      s += bucket.weight;
      reasons.push(`query length ${len}`);
    }

    // Intent-driven bumps: certain intents are inherently harder for a 2.5B model.
    if (
      intent === 'CODE_REVIEW' &&
      /\b(secur\w*|vulnerab\w*|cryptograph\w*|authn|authz)\b/i.test(query)
    ) {
      s += 0.25;
      reasons.push('security-sensitive code review');
    }
    if (
      intent === 'TOOL_EXECUTION' &&
      /\b(production|deploy|delete|drop|truncate)\b/i.test(query)
    ) {
      s += 0.3;
      reasons.push('destructive tool execution');
    }

    s = Math.min(s, 1);
    return {
      score: s,
      reasons,
      recommendation: s >= 0.5 ? 'escalate' : 'local',
    };
  }
}
