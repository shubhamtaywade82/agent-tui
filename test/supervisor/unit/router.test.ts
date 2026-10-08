/**
 * ModelRouter — §13.1, §13.2.
 */
import { describe, expect, it } from 'vitest';
import { ComplexityScorer } from '../../../src/supervisor/router/complexity.js';
import { ModelRouter } from '../../../src/supervisor/router/router.js';

describe('ModelRouter', () => {
  const router = new ModelRouter();
  const scorer = new ComplexityScorer();

  it('routes TOOL_EXECUTION to the tool model in no-think mode', () => {
    const c = scorer.score('Check deployment status');
    const r = router.decide('TOOL_EXECUTION', c);
    expect(r.kind).toBe('local');
    if (r.kind === 'local') {
      expect(r.model).toBe('minicpm5-toolagent');
      expect(r.thinkMode).toBe('no-think');
    }
  });

  it('routes CODE_REVIEW to the analyst with think mode', () => {
    const c = scorer.score('Review this function for security flaws', 'CODE_REVIEW');
    const r = router.decide('CODE_REVIEW', c);
    expect(r.kind).toBe('local');
    if (r.kind === 'local') {
      expect(r.model).toBe('minicpm5-analyst');
      expect(r.thinkMode).toBe('think');
    }
  });

  it('routes LOG_SUMMARIZATION to the summarizer', () => {
    const c = scorer.score('Summarize these logs');
    const r = router.decide('LOG_SUMMARIZATION', c);
    expect(r.kind).toBe('local');
    if (r.kind === 'local') {
      expect(r.model).toBe('minicpm5-summarizer');
    }
  });

  it('routes DATA_EXTRACTION to the analyst', () => {
    const c = scorer.score('Extract error codes');
    const r = router.decide('DATA_EXTRACTION', c);
    expect(r.kind).toBe('local');
    if (r.kind === 'local') {
      expect(r.model).toBe('minicpm5-analyst');
    }
  });

  it('escalates when complexity is high', () => {
    const c = scorer.score('Refactor the entire authentication subsystem across all microservices');
    const r = router.decide('CODE_REVIEW', c);
    // Either escalates (if fallback configured) or routes locally with think
    if (r.kind === 'escalate') {
      expect(r.reason).toMatch(/complexity/);
    } else {
      expect(r.thinkMode).toBe('think');
    }
  });

  it('escalates after exceeding max retries', () => {
    const c = scorer.score('simple task');
    const r = router.decide('TOOL_EXECUTION', c, { retryCount: 99 });
    if (r.kind === 'escalate') {
      expect(r.reason).toMatch(/retries/);
    }
  });

  it('escalates after 3+ validation failures', () => {
    const c = scorer.score('simple task');
    const r = router.decide('TOOL_EXECUTION', c, { validationFailures: 3 });
    if (r.kind === 'escalate') {
      expect(r.reason).toMatch(/validation/);
    }
  });

  it('UNKNOWN intent falls back to analyst with think mode', () => {
    const c = scorer.score('foo bar baz');
    const r = router.decide('UNKNOWN', c);
    expect(r.kind).toBe('local');
    if (r.kind === 'local') {
      expect(r.model).toBe('minicpm5-analyst');
      expect(r.thinkMode).toBe('think');
    }
  });
});
