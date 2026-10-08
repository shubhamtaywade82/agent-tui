/**
 * Retrieval eval metrics — Part 1 §13 (Evaluate Retrieval and Generation
 * Separately). Verifies the MetricsCollector's recordRetrievalEval and
 * recordGenerationEval methods produce correct aggregates.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MetricsCollector } from '../../../src/supervisor/evals/metrics.js';

describe('MetricsCollector §13 retrieval + generation metrics', () => {
  let m: MetricsCollector;

  beforeEach(() => {
    m = new MetricsCollector();
  });

  it('recall@k averages across multiple calls', () => {
    m.recordRetrievalEval({ retrievedIds: ['a', 'b'], relevantIds: ['a', 'b', 'c'], k: 2 });
    // recall = 2/3 ≈ 0.667
    m.recordRetrievalEval({ retrievedIds: ['x', 'y'], relevantIds: ['a'], k: 2 });
    // recall = 0/1 = 0
    const snap = m.snapshot();
    expect(snap.retrievalRecallAtK).toBeCloseTo((2 / 3 + 0) / 2, 2);
  });

  it('precision@k averages correctly', () => {
    m.recordRetrievalEval({ retrievedIds: ['a', 'b'], relevantIds: ['a'], k: 2 });
    // precision = 1/2 = 0.5
    expect(m.snapshot().retrievalPrecisionAtK).toBeCloseTo(0.5, 2);
  });

  it('MRR is 1/rank of first relevant hit', () => {
    m.recordRetrievalEval({ retrievedIds: ['x', 'a', 'b'], relevantIds: ['a'], k: 3 });
    // MRR = 1/2 = 0.5
    expect(m.snapshot().retrievalMrr).toBeCloseTo(0.5, 2);
  });

  it('nDCG is 1.0 when retrieval is perfect', () => {
    m.recordRetrievalEval({ retrievedIds: ['a', 'b'], relevantIds: ['a', 'b'], k: 2 });
    expect(m.snapshot().retrievalNdcg).toBeCloseTo(1.0, 2);
  });

  it('tracks ACL leakage rate', () => {
    m.recordRetrieval(0.5);
    m.recordRetrievalEval({ retrievedIds: ['a'], relevantIds: ['a'], k: 1, aclLeakedCount: 1 });
    expect(m.snapshot().retrievalAclLeakageRate).toBeGreaterThan(0);
  });

  it('tracks cache hit rate', () => {
    m.recordRetrievalEval({ retrievedIds: ['a'], relevantIds: ['a'], k: 1, cacheHit: true });
    m.recordRetrievalEval({ retrievedIds: ['a'], relevantIds: ['a'], k: 1, cacheHit: false });
    m.recordRetrievalEval({ retrievedIds: ['a'], relevantIds: ['a'], k: 1, cacheHit: true });
    expect(m.snapshot().retrievalCacheHitRate).toBeCloseTo(2 / 3, 2);
  });

  it('generation groundedness = cited / total claims', () => {
    m.recordGenerationEval({
      totalClaims: 4,
      citedClaims: 3,
      validCitations: 3,
      schemaValid: true,
    });
    expect(m.snapshot().generationGroundedness).toBeCloseTo(0.75, 2);
    expect(m.snapshot().generationCitationAccuracy).toBeCloseTo(1.0, 2);
    expect(m.snapshot().generationHallucinationRate).toBeCloseTo(0.25, 2);
    expect(m.snapshot().generationSchemaValidity).toBeCloseTo(1.0, 2);
  });

  it('hallucination rate = uncited / total claims', () => {
    m.recordGenerationEval({
      totalClaims: 5,
      citedClaims: 1,
      validCitations: 1,
      schemaValid: false,
    });
    expect(m.snapshot().generationHallucinationRate).toBeCloseTo(0.8, 2);
    expect(m.snapshot().generationSchemaValidity).toBeCloseTo(0.0, 2);
  });
});
