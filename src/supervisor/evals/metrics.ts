/**
 * Metrics collector — §15.2 (Agent Metrics).
 *
 * Tracks the twelve production metrics called out in §15.2:
 *   task success rate, tool-call validity rate, tool execution success
 *   rate, retry rate, escalation rate, hallucination rate, retrieval
 *   precision, context utilization, average latency, token cost, human
 *   intervention rate, safety violation rate.
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
  };

  private latencySum = 0;
  private contextSum = 0;
  private contextCount = 0;
  private retrievalPrecisionSum = 0;
  private retrievalCount = 0;

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
    };
    this.latencySum = 0;
    this.contextSum = 0;
    this.contextCount = 0;
    this.retrievalPrecisionSum = 0;
    this.retrievalCount = 0;
  }
}
