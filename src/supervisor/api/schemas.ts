/**
 * HTTP API request/response schemas (TypeBox-style via zod). Used by
 * Fastify for input validation and by the OpenAPI generator for the
 * `/docs` endpoint.
 */
import { z } from 'zod';

export const RunRequest = z.object({
  objective: z.string().min(1).max(8192),
  userId: z.string().optional(),
  projectId: z.string().optional(),
  context: z.string().optional(),
  allowedPaths: z.array(z.string()).optional(),
});
export type RunRequest = z.infer<typeof RunRequest>;

export const RunResponse = z.object({
  runId: z.string().uuid(),
  status: z.string(),
  intent: z.string().optional(),
  finalResponse: z.string().optional(),
  errorTrace: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunResponse = z.infer<typeof RunResponse>;

export const ApprovalRequest = z.object({
  action: z.string(),
  reason: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const ApprovalResponse = z.object({
  approvalId: z.string().uuid(),
  status: z.enum(['GRANTED', 'DENIED', 'PENDING']),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponse>;

export const MetricsResponse = z.object({
  runsTotal: z.number(),
  runsSucceeded: z.number(),
  runsEscalated: z.number(),
  runsFailed: z.number(),
  toolCallsTotal: z.number(),
  toolCallsValid: z.number(),
  repairLoopInvocations: z.number(),
  retrievalCallsTotal: z.number(),
  retrievalPrecisionAvg: z.number(),
  contextUtilizationAvg: z.number(),
  latencyAvgMs: z.number(),
  humanApprovalsRequested: z.number(),
  safetyViolations: z.number(),
});
export type MetricsResponse = z.infer<typeof MetricsResponse>;
