/**
 * Supervisor orchestration engine — §1 (Core Agent Architecture), §2
 * (Limitation-to-Infrastructure Compensation Map), §9 (State Management).
 *
 * The engine is the deterministic state machine that wraps the
 * probabilistic MiniCPM5-2B. Its only public method is `run`, which
 * executes the full ROUTE → EXECUTE → VALIDATE loop:
 *
 *   1. ROUTE       — router model classifies intent (§13.1)
 *   2. PLAN        — complexity scorer + model router pick the sub-agent
 *                    and think mode (§13.2, §13.3) or escalate (§13.1)
 *   3. RETRIEVE    — hybrid retriever pulls evidence + memory + state (§6, §7)
 *   4. BUILD_CTX   — context builder assembles the prompt within budget (§8)
 *   5. INVOKE      — selected sub-agent model produces the response / tool call
 *   6. VALIDATE    — tool validator + repair loop (§10)
 *   7. EXECUTE     — sandbox runs the tool (§11) or the code patch workflow (§12)
 *   8. VALIDATE_OUT— run §12.2 validators on any produced artifacts
 *   9. FINALIZE    — emit `run_completed` event, persist final state
 *
 * Every step is wrapped in an OTel span (§15.1), recorded as a StepRecord
 * (§4.1), and emitted as a domain event (§9.2).
 */

import type { CodeIndexer } from './code/indexer.js';
import type { PatchWorkflow } from './code/patch.js';
import { supervisorConfig } from './config.js';
import { ContextBuilder } from './context/builder.js';
import type { MemoryRecord, MemoryService } from './context/memory.js';
import type { RetrievalResult } from './context/retrieval.js';
import { MetricsCollector } from './evals/metrics.js';
import type { Backend } from './inference/backend.js';
import { logger } from './observability/logger.js';
import { withSpan, zodParseFailureCounter } from './observability/telemetry.js';
import { RouterClassifier } from './router/classifier.js';
import { ComplexityScorer } from './router/complexity.js';
import { type ModelChoice, ModelRouter } from './router/router.js';
import { PermissionService } from './security/permissions.js';
import { SecretResolver } from './security/secrets.js';
import { type DomainEvent, EventBus } from './state/events.js';
import { StateMachine } from './state/machine.js';
import {
  type AgentState,
  type Intent,
  newAgentState,
  StepRecord,
  type StepType,
  ToolCallSchema,
} from './state/models.js';
import type { StateStore } from './state/store.js';
import { ToolRegistry } from './tools/registry.js';
import { RepairLoop } from './tools/repair.js';
import { ToolValidator } from './tools/validator.js';

/**
 * TS Engine §4 (Hexagonal Architecture) — Port interfaces.
 *
 * The supervisor knows nothing about PostgreSQL, Docker, or Qdrant. It
 * only knows about these interfaces. This allows swapping the sandbox
 * from Docker to AWS Lambda, or the vector DB from pgvector to Pinecone,
 * without modifying the orchestration logic.
 */
export interface IRetriever {
  retrieve(params: {
    query: string;
    queryEmbedding?: number[];
    namespace?: string;
    topK?: number;
    filters?: Record<string, unknown>;
  }): Promise<RetrievalResult[]>;
}

export interface ISandboxExecutor {
  run(req: {
    command: string;
    env?: Record<string, string>;
    cwd?: string;
    idempotencyKey?: string;
    timeoutMs?: number;
  }): Promise<{
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
  }>;
}

export interface SupervisorDeps {
  backend: Backend;
  store: StateStore;
  /** Retriever port — accepts any IRetriever impl (pgvector, Qdrant, mock). */
  retriever?: IRetriever;
  memory?: MemoryService;
  /** Sandbox port — accepts any ISandboxExecutor impl (Docker, gVisor, Lambda). */
  sandbox?: ISandboxExecutor;
  codeIndexer?: CodeIndexer;
  patchWorkflow?: PatchWorkflow;
  permissions?: PermissionService;
  secrets?: SecretResolver;
  /**
   * Stronger-model backend used when the router decides to escalate (§13.1).
   * When omitted, an escalation choice fails loudly instead of silently
   * degrading to the local model — the previous behaviour made the
   * `model_escalated` event a lie (the fallback model was never actually
   * invoked).
   */
  fallback?: Backend;
}

export class Supervisor {
  readonly bus = new EventBus();
  readonly machine = new StateMachine(this.bus);
  readonly registry = new ToolRegistry();
  readonly metrics = new MetricsCollector();
  readonly complexity = new ComplexityScorer();
  readonly router = new ModelRouter();
  readonly contextBuilder = new ContextBuilder();
  readonly permissions: PermissionService;
  readonly secrets: SecretResolver;
  private readonly classifier: RouterClassifier;
  private readonly validator: ToolValidator;
  private readonly repair: RepairLoop;

  // Transient per-run state — full evidence + memory objects, kept out of
  // the persisted AgentState (which stores only compact string summaries).
  // Keyed by runId so concurrent runs don't collide.
  private readonly runEvidence = new Map<string, RetrievalResult[]>();
  private readonly runMemory = new Map<string, MemoryRecord[]>();
  /**
   * Per-run model choice produced by `stepPlan`. Stored transiently so the
   * execute step knows whether to invoke the local sub-agent model or the
   * configured fallback. The router's `ModelChoice.escalate` was previously
   * used only to publish a `model_escalated` event — the fallback model was
   * never actually invoked, making escalation a no-op.
   */
  private readonly runModelChoice = new Map<string, ModelChoice>();
  /**
   * Per-run analyst-model override. When the orchestrator runs a task with
   * a per-task-type model (see `inference.taskModelMap`), it passes the
   * model name to `Supervisor.run({ analystModelOverride })`. The execute
   * step uses this in preference to `supervisorConfig.inference.analystModel`
   * so each task type can target a different specialist model — e.g.
   * CODE_CHANGE → Claude, ANALYZE → gpt-4o, RETRIEVE → gpt-4o-mini.
   *
   * The override is stored per-runId (not on AgentState) to avoid a DB
   * migration: it's a transient dispatch hint, not audit data. Escalation
   * still wins over this override — if the router escalates, the fallback
   * model is used regardless.
   */
  private readonly runAnalystModelOverride = new Map<string, string>();

  constructor(private readonly deps: SupervisorDeps) {
    this.permissions = deps.permissions ?? new PermissionService();
    this.secrets = deps.secrets ?? new SecretResolver();
    this.classifier = new RouterClassifier(deps.backend, supervisorConfig.inference.routerModel);
    this.validator = new ToolValidator(this.permissions);
    this.repair = new RepairLoop(
      deps.backend,
      this.registry,
      this.validator,
      supervisorConfig.inference.toolModel,
    );

    // Persist every domain event to the events table (§9.2)
    this.bus.subscribe(async (e: DomainEvent) => {
      try {
        await this.deps.store.appendEvent(e);
      } catch (err) {
        logger.warn({ err, type: e.type }, 'failed to persist event');
      }
    });
  }

  /**
   * Execute the full agentic loop for a single objective. Returns the
   * final AgentState (also persisted to the database).
   */
  async run(params: {
    objective: string;
    userId?: string;
    projectId?: string;
    context?: string;
    allowedPaths?: string[];
    /**
     * Override the analyst model for this run only. Used by the
     * TaskOrchestrator when `inference.taskModelMap[taskType]` is set —
     * each task type can target a different specialist model without
     * changing global config. Falls back to `analystModel` when omitted.
     * Escalation (if the router chose to escalate) still wins.
     */
    analystModelOverride?: string;
  }): Promise<AgentState> {
    const startedAt = Date.now();
    const state = newAgentState(params.objective, {
      userId: params.userId,
      projectId: params.projectId,
    });
    if (params.context) state.context = params.context;
    // Persist the caller-authorised filesystem scope so stepExecuteTool can
    // forward it to the validator (and the repair loop) on every tool-call
    // attempt. Without this, path-bearing tool arguments are checked against
    // an empty scope and `allowedPaths` from the API request is silently
    // dropped on the floor.
    if (params.allowedPaths && params.allowedPaths.length > 0) {
      state.allowedPaths = [...params.allowedPaths];
    }
    if (params.analystModelOverride) {
      this.runAnalystModelOverride.set(state.runId, params.analystModelOverride);
    }
    await this.deps.store.saveRun(state);
    await this.bus.publish({
      type: 'run_created',
      runId: state.runId,
      payload: { objective: state.objective, userId: params.userId, projectId: params.projectId },
      occurredAt: new Date().toISOString(),
    });

    try {
      // 1. ROUTE
      await this.machine.transition(state, 'PLANNING', 'route');
      await this.stepRoute(state);

      // 2. PLAN (complexity + model choice)
      await this.stepPlan(state);

      if (state.intent === 'UNKNOWN') {
        // Unknown intent: skip retrieval/execution, go straight to analyst
        await this.machine.transition(state, 'EXECUTING', 'unknown-fallback');
        await this.stepExecuteAnalyst(state);
      } else {
        // 3. RETRIEVE
        await this.machine.transition(state, 'RETRIEVING', 'gather-evidence');
        await this.stepRetrieve(state);

        // 4. EXECUTE
        await this.machine.transition(state, 'EXECUTING', 'execute');
        await this.stepExecute(state);
      }

      // 5. VALIDATE
      await this.machine.transition(state, 'VALIDATING', 'validate');
      await this.stepValidateOutput(state);

      // 6. §8 Checkpoint — persist progress for crash recovery. Only when
      // validation passed; a failed run does not get a recovery checkpoint
      // (it is not a positive example to resume from).
      if (state.validationOutcome?.ok && this.deps.memory) {
        try {
          await this.deps.memory.createCheckpoint({
            runId: state.runId,
            stepId: state.steps.at(-1)?.stepId,
            status: state.status,
            currentPlan: state.intent,
            completedSteps: state.steps.map((s) => s.stepType),
            activeConstraints: [],
            workingFiles: [],
            lastToolResultSummary: state.executionResult?.slice(0, 200),
            nextActions: [],
            tokenBudget: supervisorConfig.context.budgetTokens,
          });
        } catch (e) {
          logger.warn({ err: e }, 'checkpoint creation failed');
        }
      }

      // 7. FINALIZE — gate the terminal transition on the validation outcome.
      // A run whose validation failed must NOT transition to COMPLETED. The
      // previous code unconditionally moved to COMPLETED, so a failed tool
      // execution, an exhausted repair loop, or an analyst that declared
      // insufficient evidence all masqueraded as successful runs.
      const simulated = state.executionResult?.startsWith('SIMULATED_SUCCESS') ?? false;
      if (!state.validationOutcome?.ok) {
        await this.machine.transition(state, 'FAILED', 'validation failed');
        state.finalResponse = state.executionResult ?? '(no output)';
        await this.bus.publish({
          type: 'run_completed',
          runId: state.runId,
          payload: {
            finalResponsePreview: state.finalResponse.slice(0, 200),
            outcome: 'FAILED',
          },
          occurredAt: new Date().toISOString(),
        });
        this.metrics.recordRun('failed', Date.now() - startedAt, { prompt: 0, completion: 0 });
      } else {
        await this.machine.transition(state, 'COMPLETED', 'ok');
        state.finalResponse = state.executionResult ?? '(no output)';
        await this.bus.publish({
          type: 'run_completed',
          runId: state.runId,
          payload: {
            finalResponsePreview: state.finalResponse.slice(0, 200),
            outcome: simulated ? 'SIMULATED' : 'SUCCEEDED',
          },
          occurredAt: new Date().toISOString(),
        });
        this.metrics.recordRun('succeeded', Date.now() - startedAt, { prompt: 0, completion: 0 });

        // 8. §10 Consolidation — write an episodic memory of a successful
        // run. Failed runs do not consolidate (their finalResponse is not a
        // positive example worth remembering).
        if (this.deps.memory && state.projectId) {
          try {
            await this.deps.memory.consolidateRun({
              runId: state.runId,
              namespace: `project:${state.projectId}`,
              objective: state.objective,
              completedSteps: state.steps
                .filter((s) => s.status === 'SUCCEEDED')
                .map((s) => s.stepType),
              failedAttempts: state.steps.filter((s) => s.status === 'FAILED').length,
              constraints: [],
              summarizeFn: async (input) =>
                `Run ${state.runId} (${input.objective.slice(0, 80)}): completed ${input.completedSteps.length} steps, ${input.failedAttempts} failures. Final: ${state.finalResponse?.slice(0, 120) ?? '(none)'}`,
            });
          } catch (e) {
            logger.warn({ err: e }, 'memory consolidation failed');
          }
        }
      } // end SUCCEEDED else-branch
    } catch (e) {
      const err = e as Error;
      state.errorTrace = [...state.errorTrace, err.message];
      await this.machine.transition(state, 'FAILED', err.message).catch(() => undefined);
      this.metrics.recordRun('failed', Date.now() - startedAt, { prompt: 0, completion: 0 });
      logger.error({ err, runId: state.runId }, 'supervisor run failed');
    } finally {
      state.updatedAt = new Date().toISOString();
      await this.deps.store.saveRun(state);
      // Clean up transient per-run maps to avoid memory growth
      this.runEvidence.delete(state.runId);
      this.runMemory.delete(state.runId);
      this.runModelChoice.delete(state.runId);
      this.runAnalystModelOverride.delete(state.runId);
    }
    return state;
  }

  /**
   * Resolve which backend + model to invoke for this run. When the router
   * chose to escalate (§13.1) AND a fallback backend is configured, route
   * to the fallback with the router's `fallbackModel`. When the router
   * chose to escalate but NO fallback is configured, throw — the previous
   * behaviour silently invoked the local sub-agent model, which made the
   * `model_escalated` event a lie and defeated the entire point of having
   * an escalation pathway. The caller catches and records a FAILED run.
   */
  private selectBackend(
    state: AgentState,
    defaultLocalModel: string,
  ): { backend: Backend; model: string } {
    const choice = this.runModelChoice.get(state.runId);
    if (choice && choice.kind === 'escalate') {
      if (!this.deps.fallback) {
        throw new Error(
          `router escalated to ${choice.fallbackModel} (${choice.reason}) but no fallback backend is configured — ` +
            `set ESCALATION_FALLBACK_BASE_URL and ESCALATION_FALLBACK_API_KEY, or relax the escalation triggers`,
        );
      }
      return { backend: this.deps.fallback, model: choice.fallbackModel };
    }
    return { backend: this.deps.backend, model: defaultLocalModel };
  }

  // ─── Steps ──────────────────────────────────────────────────────────────

  private async stepRoute(state: AgentState): Promise<void> {
    await withSpan('supervisor.route', async () => {
      const r = await this.classifier.classify(state.query);
      state.intent = r.intent as Intent;
      await this.bus.publish({
        type: 'intent_classified',
        runId: state.runId,
        payload: { intent: r.intent, raw: r.raw, repaired: r.repaired },
        occurredAt: new Date().toISOString(),
      });
      this.recordStep(state, 'ROUTE', {
        status: 'SUCCEEDED',
        output: { intent: r.intent, raw: r.raw },
      });
    });
  }

  private async stepPlan(state: AgentState): Promise<void> {
    await withSpan('supervisor.plan', async () => {
      const complexity = this.complexity.score(state.query, state.intent ?? undefined);
      const choice = this.router.decide(state.intent ?? 'UNKNOWN', complexity);
      state.thinkMode = choice.kind === 'local' ? choice.thinkMode : 'think';
      // Stash the choice so the execute step can act on it. Previously the
      // choice was computed and then discarded — only an event was published.
      this.runModelChoice.set(state.runId, choice);

      await this.bus.publish({
        type: 'plan_generated',
        runId: state.runId,
        payload: {
          steps: ['route', 'retrieve', 'execute', 'validate'],
          thinkMode: state.thinkMode,
        },
        occurredAt: new Date().toISOString(),
      });

      if (choice.kind === 'escalate') {
        await this.bus.publish({
          type: 'model_escalated',
          runId: state.runId,
          payload: { from: 'minicpm5', to: choice.fallbackModel, reason: choice.reason },
          occurredAt: new Date().toISOString(),
        });
        this.metrics.recordRun('escalated' as never, 0, { prompt: 0, completion: 0 });
      }

      this.recordStep(state, 'PLAN', {
        status: 'SUCCEEDED',
        output: { choice, complexity },
      });
    });
  }

  private async stepRetrieve(state: AgentState): Promise<void> {
    await withSpan('supervisor.retrieve', async () => {
      const ns = state.projectId ? `project:${state.projectId}` : 'default';
      let evidence: RetrievalResult[] = [];
      if (this.deps.retriever) {
        try {
          evidence = await this.deps.retriever.retrieve({
            query: state.query,
            namespace: ns,
            topK: supervisorConfig.retrieval.topK,
            filters: { userId: state.userId, projectId: state.projectId },
          });
          this.metrics.recordRetrieval(evidence.length > 0 ? 1 : 0);
        } catch (e) {
          logger.warn({ err: e }, 'retrieval failed — proceeding without evidence');
        }
      }
      this.runEvidence.set(state.runId, evidence);
      state.retrievedEvidence = evidence.map((e) => `[${e.citation}] ${e.content}`);

      // Pull long-term memory (§6 selective read path)
      let mem: MemoryRecord[] = [];
      if (this.deps.memory) {
        try {
          mem = await this.deps.memory.read({
            namespace: ns,
            limit: 5,
            recencyBoost: true,
            userId: state.userId,
            projectId: state.projectId,
          });
        } catch (e) {
          logger.warn({ err: e }, 'memory read failed');
        }
      }
      this.runMemory.set(state.runId, mem);

      this.recordStep(state, 'RETRIEVE', {
        status: 'SUCCEEDED',
        output: { evidenceCount: evidence.length, memoryCount: mem.length },
        retrievalQuery: state.query,
        retrievedChunks: evidence.map((e) => e.citation),
      });
    });
  }

  private async stepExecute(state: AgentState): Promise<void> {
    if (state.intent === 'TOOL_EXECUTION') {
      await this.stepExecuteTool(state);
    } else if (state.intent === 'LOG_SUMMARIZATION') {
      await this.stepExecuteSummarizer(state);
    } else {
      await this.stepExecuteAnalyst(state);
    }
  }

  private async stepExecuteTool(state: AgentState): Promise<void> {
    await withSpan('supervisor.execute.tool', async () => {
      const prompt = `Determine the tool and arguments for:\n${state.query}\n\nAvailable tools:\n${this.registry.renderForPrompt()}`;
      const { backend, model } = this.selectBackend(state, supervisorConfig.inference.toolModel);
      const r = await backend.invoke({
        model,
        prompt,
        formatJson: true,
        thinkMode: state.thinkMode,
      });
      await this.bus.publish({
        type: 'model_invoked',
        runId: state.runId,
        payload: {
          model,
          thinkMode: state.thinkMode,
          latencyMs: r.latencyMs,
          tokens: r.tokens.prompt + r.tokens.completion,
        },
        occurredAt: new Date().toISOString(),
      });

      // Parse + validate via the TS Engine §3 ToolCallSchema discriminated
      // union. The model must either provide a valid tool + arguments, OR
      // explicitly declare `tool: 'none'` with a reason. Any other shape
      // triggers the repair loop (§10.3).
      let toolName = '';
      let rawArgs: unknown = {};
      if (r.parsed && typeof r.json === 'object' && r.json !== null) {
        const parseResult = ToolCallSchema.safeParse(r.json);
        if (parseResult.success) {
          const tc = parseResult.data;
          // Check for explicit deferral first (tool === 'none')
          if (tc.tool === 'none') {
            const reason = (tc as { reason: string }).reason;
            state.executionResult = `Skipped: no tool needed. Reason: ${reason}`;
            this.recordStep(state, 'EXECUTE_TOOL', {
              status: 'SKIPPED',
              output: { tool: 'none', reason },
            });
            return;
          }
          // Real tool call — extract tool name + arguments
          const exec = tc as { tool: string; arguments: Record<string, unknown> };
          toolName = exec.tool;
          rawArgs = exec.arguments;
        } else {
          // Phase 6 drift detection — meter the ToolCallSchema parse failure.
          zodParseFailureCounter.add(1, {
            model: supervisorConfig.inference.toolModel,
            schema: 'ToolCallSchema',
          });
          // Fall back to loose parsing for backwards compatibility
          const j = r.json as { tool?: string; name?: string; arguments?: unknown };
          toolName = j.tool ?? j.name ?? '';
          rawArgs = j.arguments ?? {};
        }
      }

      await this.bus.publish({
        type: 'tool_call_proposed',
        runId: state.runId,
        payload: { tool: toolName, arguments: rawArgs as Record<string, unknown> },
        occurredAt: new Date().toISOString(),
      });

      const tool = this.registry.get(toolName);
      const validationCtx = {
        userId: state.userId,
        projectId: state.projectId,
        // Forward the caller-authorised filesystem scope so the validator can
        // reject path arguments outside the run's approved scope. Previously
        // this was hardcoded to `undefined`, which meant `allowedPaths` from
        // the API request was enforced nowhere on the tool-call path.
        allowedPaths: state.allowedPaths,
      };
      let validation = tool
        ? this.validator.validateWithTool(tool, rawArgs, validationCtx)
        : {
            ok: false,
            errors: [`unknown tool: ${toolName}`],
          };

      let finalArgs = rawArgs as Record<string, unknown>;
      let attempts = 0;

      // Repair loop if invalid (covers unknown tools, schema mismatches,
      // permission failures, etc. — §10.3).
      if (!validation.ok) {
        this.metrics.recordRepairLoop();
        const repair = await this.repair.run({
          toolName,
          originalPrompt: state.query,
          originalRawOutput: r.content,
          ctx: {
            userId: state.userId,
            projectId: state.projectId,
            // Propagate the filesystem scope to the repair loop so repaired
            // arguments are still checked against the run's authorised scope.
            allowedPaths: state.allowedPaths,
          },
        });
        attempts = repair.attempts;
        if (repair.ok && repair.finalArgs) {
          finalArgs = repair.finalArgs;
          validation = repair.finalValidation ?? { ok: true, errors: [] };
          await this.bus.publish({
            type: 'tool_call_validated',
            runId: state.runId,
            payload: { tool: toolName, status: 'REPAIRED' },
            occurredAt: new Date().toISOString(),
          });
        } else {
          this.metrics.recordToolCall('invalid');
          state.executionResult = `ERROR: tool call invalid after ${attempts} repair attempts`;
          // Surface the validator's specific failure reasons so a caller (or
          // an operator reading the run's audit trail) can tell whether the
          // failure was a schema mismatch, a missing permission, a path
          // outside the authorised scope, or something else. The previous
          // generic `tool {name} validation failed` message made every
          // failure look identical.
          const detail = validation.errors.length > 0 ? validation.errors.join('; ') : 'no detail';
          state.errorTrace = [...state.errorTrace, `tool ${toolName} validation failed: ${detail}`];
          this.recordStep(state, 'EXECUTE_TOOL', {
            status: 'FAILED',
            error: `repair loop exhausted: ${detail}`,
            toolName,
            toolArguments: finalArgs,
          });
          return;
        }
      } else if (validation.ok) {
        this.metrics.recordToolCall('valid');
        await this.bus.publish({
          type: 'tool_call_validated',
          runId: state.runId,
          payload: { tool: toolName, status: 'VALID' },
          occurredAt: new Date().toISOString(),
        });
      }

      // Execute via tool's own hook, or fall back to the sandbox
      if (tool?.execute && validation?.parsedArgs) {
        const result = await tool.execute(validation.parsedArgs as never, {
          runId: state.runId,
          stepId: state.steps.at(-1)?.stepId ?? '',
          workspacePath: process.cwd(),
          userId: state.userId,
          projectId: state.projectId,
        });
        state.executionResult = result.ok
          ? result.output
          : `ERROR: ${result.error ?? 'tool failed'}`;
        this.metrics.recordToolCall('executed');
      } else if (this.deps.sandbox && finalArgs.command) {
        const sb = await this.deps.sandbox.run({
          command: String(finalArgs.command),
          idempotencyKey: `${state.runId}:${toolName}`,
        });
        state.executionResult = sb.ok ? sb.stdout : `ERROR (exit ${sb.exitCode}): ${sb.stderr}`;
        this.metrics.recordToolCall(sb.ok ? 'executed' : 'denied');
      } else {
        // No executor available — neither a registered `execute` hook on the
        // tool definition, nor a usable sandbox command (no `command` arg,
        // or no sandbox configured). The previous code recorded this as a
        // `SUCCEEDED` step with `recordToolCall('executed')`, which made a
        // never-executed tool call indistinguishable from a real one in
        // metrics, event stream, and the step audit trail.
        //
        // Honest contract: the tool was validated but NOT executed. The
        // executionResult keeps the `SIMULATED_SUCCESS` prefix so existing
        // consumers (golden evals) can still recognise the path, but the
        // metric counter, event payload, and step status now reflect
        // `SIMULATED` / `SKIPPED` — never `executed` / `SUCCEEDED`.
        state.executionResult = `SIMULATED_SUCCESS: tool ${toolName} validated with args ${JSON.stringify(finalArgs)} (no executor available)`;
        this.metrics.recordToolCall('simulated');
      }

      // Determine the honest execution outcome for downstream event/step
      // recording. A simulated call is NOT a success — it's a skipped
      // execution with a clear marker in the result string.
      const simulated = state.executionResult.startsWith('SIMULATED_SUCCESS');
      const failed = state.executionResult.startsWith('ERROR');
      const execStatus: 'SUCCESS' | 'FAILED' | 'SIMULATED' = simulated
        ? 'SIMULATED'
        : failed
          ? 'FAILED'
          : 'SUCCESS';

      await this.bus.publish({
        type: 'tool_executed',
        runId: state.runId,
        payload: {
          tool: toolName,
          status: execStatus,
          resultSummary: state.executionResult.slice(0, 200),
        },
        occurredAt: new Date().toISOString(),
      });

      this.recordStep(state, 'EXECUTE_TOOL', {
        status: simulated ? 'SKIPPED' : failed ? 'FAILED' : 'SUCCEEDED',
        output: { tool: toolName, args: finalArgs, attempts, executed: !simulated },
        toolName,
        toolArguments: finalArgs,
        executionResult: state.executionResult,
      });
    });
  }

  private async stepExecuteAnalyst(state: AgentState): Promise<void> {
    await withSpan('supervisor.execute.analyst', async () => {
      const evidence = this.runEvidence.get(state.runId) ?? [];
      const memory = this.runMemory.get(state.runId) ?? [];
      const built = this.contextBuilder.build({
        systemInstruction:
          'You are the MiniCPM5 analyst sub-agent. Answer ONLY using the provided evidence. If the evidence is insufficient, say "Insufficient evidence". Cite evidence IDs for every factual claim.',
        outputSchema:
          'Return JSON: {"answer": string, "citations": string[], "confidence": "high"|"medium"|"low", "insufficient_evidence": boolean}',
        toolDefinitions: this.registry.renderForPrompt(),
        task: state.query,
        stateSummary: `intent=${state.intent ?? 'UNKNOWN'} thinkMode=${state.thinkMode} runId=${state.runId}`,
        retrievedEvidence: evidence,
        fileSnippets: [],
        conversationHistory: [],
        longTermMemory: memory,
      });
      this.metrics.recordContext(built.budget.total, built.usedTokens);

      // §4.5 context snapshot — audit what was in the prompt
      if (this.deps.memory && state.steps.length > 0) {
        try {
          await this.deps.memory.saveContextSnapshot({
            runId: state.runId,
            stepId: state.steps.at(-1)?.stepId ?? state.runId,
            tokenBudget: built.budget.total,
            usedTokens: built.usedTokens,
            promptHash: built.promptHash,
            includedMemoryIds: built.includedMemoryIds,
            includedChunkIds: built.includedChunkIds,
            excludedChunkIds: built.excludedChunkIds,
          });
        } catch (e) {
          logger.warn({ err: e }, 'context snapshot save failed');
        }
      }

      await this.bus.publish({
        type: 'context_built',
        runId: state.runId,
        payload: {
          tokenBudget: built.budget.total,
          usedTokens: built.usedTokens,
          chunks: evidence.length,
        },
        occurredAt: new Date().toISOString(),
      });

      const defaultAnalystModel =
        this.runAnalystModelOverride.get(state.runId) ?? supervisorConfig.inference.analystModel;
      const { backend, model } = this.selectBackend(state, defaultAnalystModel);
      const r = await backend.invoke({
        model,
        prompt: built.prompt,
        thinkMode: state.thinkMode,
        // `maxTokens: budgetTokens` previously meant `num_ctx` on Ollama —
        // redundant with the backend default. Leaving it unset lets the
        // Modelfile's generation defaults apply and the configured
        // `context.budgetTokens` drive the context window.
      });
      state.executionResult = r.content;
      await this.bus.publish({
        type: 'model_invoked',
        runId: state.runId,
        payload: {
          model,
          thinkMode: state.thinkMode,
          latencyMs: r.latencyMs,
          tokens: r.tokens.prompt + r.tokens.completion,
        },
        occurredAt: new Date().toISOString(),
      });
      this.recordStep(state, 'INVOKE_MODEL', {
        status: 'SUCCEEDED',
        output: { model, tokens: r.tokens },
        modelName: model,
      });
    });
  }

  private async stepExecuteSummarizer(state: AgentState): Promise<void> {
    await withSpan('supervisor.execute.summarizer', async () => {
      const { backend, model } = this.selectBackend(
        state,
        supervisorConfig.inference.summarizerModel,
      );
      const r = await backend.invoke({
        model,
        prompt: `Summarize the following:\n${state.query}`,
        thinkMode: 'no-think',
      });
      state.executionResult = r.content;
      this.recordStep(state, 'INVOKE_MODEL', {
        status: 'SUCCEEDED',
        output: { model },
        modelName: model,
      });
    });
  }

  private async stepValidateOutput(state: AgentState): Promise<void> {
    await withSpan('supervisor.validate', async () => {
      // §12.2 validators. Previously this step checked ONLY non-emptiness and
      // did not gate the COMPLETED transition — an empty result recorded a
      // validation_failed event, but the run still moved to COMPLETED. The
      // run loop now branches on `state.validationOutcome.ok`.
      const reasons: string[] = [];
      const validators: string[] = [];

      // 1. non-empty
      validators.push('non-empty');
      if (!state.executionResult || state.executionResult.length === 0) {
        reasons.push('empty execution result');
      }

      // 2. no-error-prefix — a tool execution that produced `ERROR: …` or a
      // repair loop that exhausted both surface as ERROR-prefixed strings.
      // Treating those as validated successes was the original sin: the run
      // would transition to COMPLETED even though every observable signal
      // said the action failed.
      validators.push('no-error-prefix');
      if (state.executionResult?.startsWith('ERROR')) {
        reasons.push(`execution result is an ERROR: ${state.executionResult.slice(0, 120)}`);
      }

      // 3. analyst-schema + citation-grounding — only runs when the analyst
      // produced output that parses as JSON conforming to the documented
      // schema. Free-text answers (e.g. the golden eval mocks) skip this
      // validator so the existing happy path is preserved.
      if (
        state.intent === 'GENERAL_QUERY' ||
        state.intent === 'DATA_EXTRACTION' ||
        state.intent === 'CODE_REVIEW' ||
        state.intent === 'UNKNOWN'
      ) {
        const candidate = this.tryParseAnalystSchema(state.executionResult);
        if (candidate) {
          validators.push('analyst-schema');
          // Citation grounding — every cited evidence ID must resolve to a
          // retrieved chunk. This is a no-op when the run retrieved no
          // evidence (the analyst had nothing to cite against).
          if (candidate.citations.length > 0) {
            validators.push('citation-grounding');
            const known = new Set(
              state.retrievedEvidence.map((e) => e.replace(/^\[(.+)\].*$/, '$1').trim()),
            );
            const ungrounded = candidate.citations.filter((c) => !known.has(c));
            if (ungrounded.length > 0) {
              reasons.push(
                `${ungrounded.length} citation(s) not grounded in retrieved evidence: ${ungrounded.slice(0, 3).join(', ')}`,
              );
            }
          }
          if (candidate.insufficientEvidence) {
            // The analyst explicitly declared insufficient evidence. Treat
            // that as a soft failure — the run completes with a clear marker
            // in the finalResponse, but the validation outcome is honest
            // about the insufficiency.
            reasons.push('analyst declared insufficient_evidence');
          }
        }
      }

      const ok = reasons.length === 0;
      state.validationOutcome = { ok, reasons, validators };

      if (ok) {
        await this.bus.publish({
          type: 'validation_passed',
          runId: state.runId,
          payload: { validators },
          occurredAt: new Date().toISOString(),
        });
      } else {
        await this.bus.publish({
          type: 'validation_failed',
          runId: state.runId,
          payload: { validator: validators.join(','), error: reasons.join('; ') },
          occurredAt: new Date().toISOString(),
        });
        state.errorTrace = [...state.errorTrace, `validation failed: ${reasons.join('; ')}`];
      }

      this.recordStep(state, 'VALIDATE_OUTPUT', {
        status: ok ? 'SUCCEEDED' : 'FAILED',
        output: { result: state.executionResult?.slice(0, 200), validators, reasons },
      });
    });
  }

  /**
   * Best-effort parse of the analyst's output against the documented JSON
   * schema (`{answer, citations, confidence, insufficient_evidence}`).
   * Returns `null` when the output isn't JSON or doesn't match the schema —
   * the caller treats that as "free-text answer, skip schema validator".
   */
  private tryParseAnalystSchema(raw: string | undefined): {
    answer: string;
    citations: string[];
    confidence: 'high' | 'medium' | 'low';
    insufficientEvidence: boolean;
  } | null {
    if (!raw) return null;
    try {
      const j = JSON.parse(raw) as unknown;
      if (typeof j !== 'object' || j === null) return null;
      const o = j as Record<string, unknown>;
      if (typeof o.answer !== 'string') return null;
      const citations = Array.isArray(o.citations)
        ? o.citations.filter((c): c is string => typeof c === 'string')
        : [];
      const confidence =
        o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low'
          ? o.confidence
          : 'medium';
      const insufficientEvidence = o.insufficient_evidence === true;
      return { answer: o.answer, citations, confidence, insufficientEvidence };
    } catch {
      return null;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private recordStep(
    state: AgentState,
    stepType: StepType,
    opts: {
      status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'ESCALATED';
      output?: Record<string, unknown>;
      error?: string;
      toolName?: string;
      toolArguments?: Record<string, unknown>;
      executionResult?: string;
      retrievalQuery?: string;
      retrievedChunks?: string[];
      modelName?: string;
    },
  ): void {
    const now = new Date().toISOString();
    const step: StepRecord = StepRecord.parse({
      stepId: crypto.randomUUID(),
      runId: state.runId,
      stepType,
      status: opts.status,
      inputPayload: {},
      outputPayload: opts.output ?? {},
      modelName: opts.modelName,
      retrievalQuery: opts.retrievalQuery,
      retrievedChunks: opts.retrievedChunks ?? [],
      toolName: opts.toolName,
      toolArguments: opts.toolArguments ?? {},
      executionResult: opts.executionResult,
      error: opts.error,
      retryCount: 0,
      latencyMs: 0,
      tokenUsage: { prompt: 0, completion: 0 },
      startedAt: now,
      finishedAt: now,
    });
    state.steps.push(step);
    void this.bus.publish({
      type: 'step_recorded',
      runId: state.runId,
      payload: { stepType, status: opts.status, latencyMs: 0 },
      occurredAt: now,
    });
  }
}
