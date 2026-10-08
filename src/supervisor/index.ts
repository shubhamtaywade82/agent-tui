/**
 * MiniCPM5 Supervisor — Module Barrel.
 *
 * Public entry point for the orchestration layer (§1, §3 of the reference
 * architecture). The supervisor is a deterministic state machine wrapped
 * around a probabilistic MiniCPM5-2B inference engine. All state, memory,
 * retrieval, file abstraction, and validation live OUTSIDE the model — the
 * LLM is treated strictly as a bounded reasoning worker.
 *
 * @packageDocumentation
 */

export { createServer } from './api/server.js';
export type { SymbolInfo } from './code/indexer.js';
export { CodeIndexer } from './code/indexer.js';
export type { PatchResult } from './code/patch.js';
export { PatchWorkflow } from './code/patch.js';
export type { SupervisorConfig } from './config.js';
export { supervisorConfig } from './config.js';
export type { BuiltContext, ContextBudget } from './context/builder.js';
export { ContextBuilder } from './context/builder.js';
export { CacheService } from './context/cache.js';
export type { MemoryRecord, MemoryStatus, MemoryTier, MemoryType } from './context/memory.js';
export { MEMORY_TYPES, MemoryService } from './context/memory.js';
export type {
  ChunkMetadata,
  DocumentType,
  RerankWeights,
  RetrievalFilters,
  RetrievalQuery,
  RetrievalResult,
} from './context/retrieval.js';
export { HybridRetriever } from './context/retrieval.js';
export { Supervisor } from './engine.js';
export { GoldenTaskSuite } from './evals/golden.js';
export type { AgentMetrics } from './evals/metrics.js';
export { MetricsCollector } from './evals/metrics.js';
export type {
  Backend,
  BackendFactory,
  InferenceRequest,
  InferenceResponse,
} from './inference/backend.js';
export { MockBackend } from './inference/mock.js';
export { OllamaBackend } from './inference/ollama.js';
export { VllmBackend } from './inference/vllm.js';
export { logger } from './observability/logger.js';
export { meter, Telemetry, tracer } from './observability/telemetry.js';
export type { RouteDecision } from './router/classifier.js';
export { RouterClassifier } from './router/classifier.js';
export { ComplexityScorer } from './router/complexity.js';
export type { ModelChoice } from './router/router.js';
export { ModelRouter } from './router/router.js';
export type { SandboxResult } from './sandbox/executor.js';
export { SandboxExecutor } from './sandbox/executor.js';
export { CommandPolicy } from './sandbox/policy.js';
export type { Permission } from './security/permissions.js';
export { PermissionService } from './security/permissions.js';
export { SecretResolver } from './security/secrets.js';
export type { DomainEvent } from './state/events.js';
export { EventBus } from './state/events.js';
export type { StateTransition } from './state/machine.js';
export { StateMachine } from './state/machine.js';
export { AgentState, Intent, RunStatus, StepStatus, StepType } from './state/models.js';
export type { StateStore } from './state/store.js';
export { PgStateStore } from './state/store.js';
export type { ToolDefinition } from './tools/registry.js';
export { ToolRegistry } from './tools/registry.js';
export { RepairLoop } from './tools/repair.js';
export type { ValidationResult } from './tools/validator.js';
export { ToolValidator } from './tools/validator.js';
