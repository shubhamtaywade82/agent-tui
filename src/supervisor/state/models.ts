/**
 * State models for the supervisor — §1 (Core Agent Architecture) and §9
 * (State Management).
 *
 * These types are the single source of truth for what an agent run, step,
 * and tool call look like at runtime. The LLM is never allowed to mutate
 * these objects directly — only the deterministic state machine does.
 */
import { z } from 'zod';

/**
 * Classification of user intent. Produced by the `minicpm5-router` model
 * and validated against this enum. Any unrecognized value collapses to
 * UNKNOWN — preventing silent mis-routing (§1 validation gate).
 */
export const Intent = z.enum([
  'DATA_EXTRACTION',
  'CODE_REVIEW',
  'TOOL_EXECUTION',
  'LOG_SUMMARIZATION',
  'GENERAL_QUERY',
  'UNKNOWN',
]);
export type Intent = z.infer<typeof Intent>;

export const RunStatus = z.enum([
  'CREATED',
  'PLANNING',
  'RETRIEVING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'VALIDATING',
  'RETRYING',
  'ESCALATED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const StepType = z.enum([
  'ROUTE',
  'PLAN',
  'RETRIEVE',
  'BUILD_CONTEXT',
  'INVOKE_MODEL',
  'VALIDATE_TOOL',
  'EXECUTE_TOOL',
  'EXECUTE_SANDBOX',
  'VALIDATE_OUTPUT',
  'ESCALATE',
  'FINALIZE',
]);
export type StepType = z.infer<typeof StepType>;

export const StepStatus = z.enum([
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'ESCALATED',
]);
export type StepStatus = z.infer<typeof StepStatus>;

/**
 * Per-step record persisted to the `steps` table (§4.1). Every meaningful
 * state transition is captured here for auditability and crash recovery.
 */
export const StepRecord = z.object({
  stepId: z.string().uuid(),
  runId: z.string().uuid(),
  stepType: StepType,
  status: StepStatus,
  inputPayload: z.record(z.string(), z.unknown()).default({}),
  outputPayload: z.record(z.string(), z.unknown()).default({}),
  modelName: z.string().optional(),
  promptTemplateVersion: z.string().optional(),
  retrievalQuery: z.string().optional(),
  retrievedChunks: z.array(z.string()).default([]),
  toolName: z.string().optional(),
  toolArguments: z.record(z.string(), z.unknown()).default({}),
  validationResult: z.string().optional(),
  executionResult: z.string().optional(),
  error: z.string().optional(),
  retryCount: z.number().int().nonnegative().default(0),
  latencyMs: z.number().int().nonnegative().default(0),
  tokenUsage: z
    .object({
      prompt: z.number().int().nonnegative().default(0),
      completion: z.number().int().nonnegative().default(0),
    })
    .default({ prompt: 0, completion: 0 }),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
});
export type StepRecord = z.infer<typeof StepRecord>;

/**
 * Tool-call record persisted to the `tool_calls` table (§4.1).
 */
export const ToolCallRecord = z.object({
  toolCallId: z.string().uuid(),
  stepId: z.string().uuid(),
  runId: z.string().uuid(),
  toolName: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
  validationStatus: z.enum(['VALID', 'INVALID', 'REPAIRED']).default('VALID'),
  executionStatus: z
    .enum(['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'TIMEOUT', 'DENIED'])
    .default('PENDING'),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  idempotencyKey: z.string().optional(),
  retryCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

/**
 * The full runtime state of one agent run. This object is the only thing
 * the orchestration engine mutates; the LLM only sees an opaque snapshot.
 */
export const AgentState = z.object({
  runId: z.string().uuid(),
  userId: z.string().optional(),
  projectId: z.string().optional(),
  objective: z.string(),
  status: RunStatus.default('CREATED'),
  intent: Intent.optional(),
  thinkMode: z.enum(['think', 'no-think']).default('no-think'),
  query: z.string(),
  context: z.string().optional(),
  retrievedEvidence: z.array(z.string()).default([]),
  toolPayload: z.record(z.string(), z.unknown()).optional(),
  executionResult: z.string().optional(),
  finalResponse: z.string().optional(),
  errorTrace: z.array(z.string()).default([]),
  steps: z.array(StepRecord).default([]),
  toolCalls: z.array(ToolCallRecord).default([]),
  artifacts: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentState = z.infer<typeof AgentState>;

export function newAgentState(
  objective: string,
  opts: { userId?: string; projectId?: string } = {},
): AgentState {
  const now = new Date().toISOString();
  return AgentState.parse({
    runId: crypto.randomUUID(),
    userId: opts.userId,
    projectId: opts.projectId,
    objective,
    status: 'CREATED',
    thinkMode: 'no-think',
    query: objective,
    context: undefined,
    retrievedEvidence: [],
    toolPayload: undefined,
    executionResult: undefined,
    finalResponse: undefined,
    errorTrace: [],
    steps: [],
    toolCalls: [],
    artifacts: [],
    createdAt: now,
    updatedAt: now,
  });
}
