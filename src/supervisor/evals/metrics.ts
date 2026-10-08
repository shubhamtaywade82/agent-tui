/**
 * Metrics collector — §15.2 (Agent Metrics) + Part 1 §13 (Evaluate
 * Retrieval and Generation Separately).
 *
 * Tracks:
 *   - the twelve §15.2 production metrics
 *   - the §13 retrieval metrics (recall@k, precision@k, MRR, nDCG,
 *     ACL leakage rate, cache hit rate)
 *   - the §13 generation metrics (groundedness, citation accuracy,
 *     hallucination rate, schema validity)
 *
 * Snapshots are emitted after every run and can be ingested by any
 * OpenTelemetry-compatible backend (§15.1).
 */
export interface AgentMetrics {
  runsTotal: number;
  runsSucceeded: number;
  runsEscalated: number;
  runsFailed: number;
  runsCancelled: number;
  toolCallsTotal: number;
  toolCallsValid: number;
  toolCallsExecuted: number;
  toolCallsDenied: number;
  repairLoopInvocations: number;
  retrievalCallsTotal: number;
  retrievalPrecisionAvg: number;
  contextBudgetAvg: number;
  contextUtilizationAvg: number;
  latencyAvgMs: number;
  tokenCostTotal: { prompt: number; completion: number };
  humanApprovalsRequested: number;
  humanApprovalsGranted: number;
  safetyViolations: number;

  // §13 Retrieval metrics
  retrievalRecallAtK: number; // avg over calls with known-relevant set
  retrievalPrecisionAtK: number;
  retrievalMrr: number; // mean reciprocal rank
  retrievalNdcg: number; // normalised discounted cumulative gain
  retrievalAclLeakageRate: number; // chunks returned that should have been filtered
  retrievalCacheHitRate: number;

  // §13 Generation metrics
  generationGroundedness: number; // 0..1, fraction of claims with citations
  generationCitationAccuracy: number; // 0..1, citations that resolve to real chunks
  generationHallucinationRate: number; // 0..1, fraction of ungrounded claims
  generationSchemaValidity: number; // 0..1, fraction of outputs that parsed
}

export class MetricsCollector {
  private m: AgentMetrics = {
    runsTotal: 0,
    runsSucceeded: 0,
    runsEscalated: 0,
    runsFailed: 0,
    runsCancelled: 0,
    toolCallsTotal: 0,
    toolCallsValid: 0,
    toolCallsExecuted: 0,
    toolCallsDenied: 0,
    repairLoopInvocations: 0,
    retrievalCallsTotal: 0,
    retrievalPrecisionAvg: 0,
    contextBudgetAvg: 0,
    contextUtilizationAvg: 0,
    latencyAvgMs: 0,
    tokenCostTotal: { prompt: 0, completion: 0 },
    humanApprovalsRequested: 0,
    humanApprovalsGranted: 0,
    safetyViolations: 0,
    // §13 retrieval
    retrievalRecallAtK: 0,
    retrievalPrecisionAtK: 0,
    retrievalMrr: 0,
    retrievalNdcg: 0,
    retrievalAclLeakageRate: 0,
    retrievalCacheHitRate: 0,
    // §13 generation
    generationGroundedness: 0,
    generationCitationAccuracy: 0,
    generationHallucinationRate: 0,
    generationSchemaValidity: 0,
  };

  private latencySum = 0;
  private contextSum = 0;
  private contextCount = 0;
  private retrievalPrecisionSum = 0;
  private retrievalCount = 0;
  // §13 retrieval accumulators
  private recallSum = 0;
  private precisionAtKSum = 0;
  private mrrSum = 0;
  private ndcgSum = 0;
  private aclLeaks = 0;
  private cacheHits = 0;
  private cacheTotal = 0;
  private recallEvalCount = 0;
  // §13 generation accumulators
  private groundednessSum = 0;
  private citationAccuracySum = 0;
  private hallucinationSum = 0;
  private schemaValiditySum = 0;
  private generationEvalCount = 0;

  recordRun(
    outcome: 'succeeded' | 'escalated' | 'failed' | 'cancelled',
    latencyMs: number,
    tokens: { prompt: number; completion: number },
  ): void {
    this.m.runsTotal++;
    if (outcome === 'succeeded') this.m.runsSucceeded++;
    else if (outcome === 'escalated') this.m.runsEscalated++;
    else if (outcome === 'failed') this.m.runsFailed++;
    else if (outcome === 'cancelled') this.m.runsCancelled++;
    this.latencySum += latencyMs;
    this.m.latencyAvgMs = this.latencySum / this.m.runsTotal;
    this.m.tokenCostTotal.prompt += tokens.prompt;
    this.m.tokenCostTotal.completion += tokens.completion;
  }

  recordToolCall(kind: 'valid' | 'invalid' | 'executed' | 'denied'): void {
    this.m.toolCallsTotal++;
    if (kind === 'valid') this.m.toolCallsValid++;
    else if (kind === 'executed') this.m.toolCallsExecuted++;
    else if (kind === 'denied') this.m.toolCallsDenied++;
  }

  recordRepairLoop(): void {
    this.m.repairLoopInvocations++;
  }

  recordRetrieval(precision: number): void {
    this.m.retrievalCallsTotal++;
    this.retrievalCount++;
    this.retrievalPrecisionSum += precision;
    this.m.retrievalPrecisionAvg = this.retrievalPrecisionSum / this.retrievalCount;
  }

  /**
   * §13 retrieval evaluation. Call this when you have a known-relevant
   * ground-truth set (e.g. from the golden eval suite). Computes
   * recall@k, precision@k, MRR, nDCG, and tracks ACL leakage + cache
   * hit rate.
   */
  recordRetrievalEval(params: {
    retrievedIds: string[];
    relevantIds: string[];
    k: number;
    aclLeakedCount?: number;
    cacheHit?: boolean;
  }): void {
    const { retrievedIds, relevantIds, k } = params;
    const relSet = new Set(relevantIds);
    const topK = retrievedIds.slice(0, k);
    const hits = topK.filter((id) => relSet.has(id)).length;
    const recall = relevantIds.length === 0 ? 0 : hits / relevantIds.length;
    const precision = topK.length === 0 ? 0 : hits / topK.length;

    // MRR — reciprocal rank of the first relevant result
    let mrr = 0;
    for (let i = 0; i < topK.length; i++) {
      if (relSet.has(topK[i]!)) {
        mrr = 1 / (i + 1);
        break;
      }
    }

    // nDCG — discounted cumulative gain with binary relevance
    const dcg = topK.reduce((sum, id, i) => sum + (relSet.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
    const idealHits = Math.min(relevantIds.length, k);
    const idcg = Array.from({ length: idealHits }, (_, i) => 1 / Math.log2(i + 2)).reduce(
      (a, b) => a + b,
      0,
    );
    const ndcg = idcg === 0 ? 0 : dcg / idcg;

    this.recallEvalCount++;
    this.recallSum += recall;
    this.precisionAtKSum += precision;
    this.mrrSum += mrr;
    this.ndcgSum += ndcg;
    this.m.retrievalRecallAtK = this.recallSum / this.recallEvalCount;
    this.m.retrievalPrecisionAtK = this.precisionAtKSum / this.recallEvalCount;
    this.m.retrievalMrr = this.mrrSum / this.recallEvalCount;
    this.m.retrievalNdcg = this.ndcgSum / this.recallEvalCount;

    if (params.aclLeakedCount !== undefined) {
      this.aclLeaks += params.aclLeakedCount;
      this.m.retrievalAclLeakageRate =
        this.m.retrievalCallsTotal > 0 ? this.aclLeaks / (this.m.retrievalCallsTotal * 5) : 0;
    }
    if (params.cacheHit !== undefined) {
      this.cacheTotal++;
      if (params.cacheHit) this.cacheHits++;
      this.m.retrievalCacheHitRate = this.cacheTotal > 0 ? this.cacheHits / this.cacheTotal : 0;
    }
  }

  /**
   * §13 generation evaluation. Call this after the analyst produces an
   * answer to compute groundedness, citation accuracy, hallucination
   * rate, and schema validity.
   */
  recordGenerationEval(params: {
    totalClaims: number;
    citedClaims: number;
    validCitations: number;
    schemaValid: boolean;
  }): void {
    this.generationEvalCount++;
    const groundedness = params.totalClaims === 0 ? 1 : params.citedClaims / params.totalClaims;
    const citationAccuracy =
      params.citedClaims === 0 ? 1 : params.validCitations / params.citedClaims;
    const hallucination =
      params.totalClaims === 0 ? 0 : (params.totalClaims - params.citedClaims) / params.totalClaims;
    this.groundednessSum += groundedness;
    this.citationAccuracySum += citationAccuracy;
    this.hallucinationSum += hallucination;
    this.schemaValiditySum += params.schemaValid ? 1 : 0;
    this.m.generationGroundedness = this.groundednessSum / this.generationEvalCount;
    this.m.generationCitationAccuracy = this.citationAccuracySum / this.generationEvalCount;
    this.m.generationHallucinationRate = this.hallucinationSum / this.generationEvalCount;
    this.m.generationSchemaValidity = this.schemaValiditySum / this.generationEvalCount;
  }

  recordContext(budgetTokens: number, usedTokens: number): void {
    this.contextCount++;
    this.contextSum += budgetTokens;
    this.m.contextBudgetAvg = this.contextSum / this.contextCount;
    this.m.contextUtilizationAvg =
      (this.m.contextUtilizationAvg * (this.contextCount - 1) + usedTokens / budgetTokens) /
      this.contextCount;
  }

  recordApproval(granted: boolean): void {
    this.m.humanApprovalsRequested++;
    if (granted) this.m.humanApprovalsGranted++;
  }

  recordSafetyViolation(): void {
    this.m.safetyViolations++;
  }

  snapshot(): Readonly<AgentMetrics> {
    return { ...this.m };
  }

  reset(): void {
    this.m = {
      runsTotal: 0,
      runsSucceeded: 0,
      runsEscalated: 0,
      runsFailed: 0,
      runsCancelled: 0,
      toolCallsTotal: 0,
      toolCallsValid: 0,
      toolCallsExecuted: 0,
      toolCallsDenied: 0,
      repairLoopInvocations: 0,
      retrievalCallsTotal: 0,
      retrievalPrecisionAvg: 0,
      contextBudgetAvg: 0,
      contextUtilizationAvg: 0,
      latencyAvgMs: 0,
      tokenCostTotal: { prompt: 0, completion: 0 },
      humanApprovalsRequested: 0,
      humanApprovalsGranted: 0,
      safetyViolations: 0,
      retrievalRecallAtK: 0,
      retrievalPrecisionAtK: 0,
      retrievalMrr: 0,
      retrievalNdcg: 0,
      retrievalAclLeakageRate: 0,
      retrievalCacheHitRate: 0,
      generationGroundedness: 0,
      generationCitationAccuracy: 0,
      generationHallucinationRate: 0,
      generationSchemaValidity: 0,
    };
    this.latencySum = 0;
    this.contextSum = 0;
    this.contextCount = 0;
    this.retrievalPrecisionSum = 0;
    this.retrievalCount = 0;
    this.recallSum = 0;
    this.precisionAtKSum = 0;
    this.mrrSum = 0;
    this.ndcgSum = 0;
    this.aclLeaks = 0;
    this.cacheHits = 0;
    this.cacheTotal = 0;
    this.recallEvalCount = 0;
    this.groundednessSum = 0;
    this.citationAccuracySum = 0;
    this.hallucinationSum = 0;
    this.schemaValiditySum = 0;
    this.generationEvalCount = 0;
  }
}
