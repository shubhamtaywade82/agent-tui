/**
 * ComplexityScorer — §13.2.
 */
import { describe, expect, it } from 'vitest';
import { ComplexityScorer } from '../../../src/supervisor/router/complexity.js';

describe('ComplexityScorer', () => {
  const s = new ComplexityScorer();

  it('scores a trivial Q&A as low complexity', () => {
    const r = s.score('What is the capital of France?');
    expect(r.score).toBeLessThan(0.2);
    expect(r.recommendation).toBe('local');
  });

  it('flags multi-file refactor language', () => {
    const r = s.score('Refactor the entire auth subsystem across all microservices');
    expect(r.score).toBeGreaterThanOrEqual(0.5);
    expect(r.recommendation).toBe('escalate');
    expect(r.reasons.some((x) => x.includes('refactor'))).toBe(true);
  });

  it('flags production deploy language', () => {
    const r = s.score('Deploy the new payment service to production');
    expect(r.score).toBeGreaterThanOrEqual(0.3);
    expect(r.reasons.some((x) => x.includes('production'))).toBe(true);
  });

  it('flags autonomy language', () => {
    const r = s.score('Run an autonomous agent loop unattended for 24 hours');
    expect(r.score).toBeGreaterThanOrEqual(0.45);
  });

  it('flags distributed systems reasoning', () => {
    const r = s.score('Design a consensus algorithm using Raft for the new cluster');
    expect(r.score).toBeGreaterThanOrEqual(0.4);
  });

  it('long queries get a length bump', () => {
    const long = 'Explain in detail '.repeat(200);
    const r = s.score(long);
    expect(r.reasons.some((x) => x.includes('length'))).toBe(true);
  });

  it('security-sensitive code review bumps the score', () => {
    const r = s.score('Review this authentication code for security flaws', 'CODE_REVIEW');
    expect(r.score).toBeGreaterThanOrEqual(0.25);
    expect(r.reasons.some((x) => x.includes('security'))).toBe(true);
  });
});
