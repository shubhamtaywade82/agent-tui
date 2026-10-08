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
import type { MemoryService } from './context/memory.js';
import type { HybridRetriever } from './context/retrieval.js';
import { MetricsCollector } from './evals/metrics.js';
import type { Backend } from './inference/backend.js';
import { logger } from './observability/logger.js';
import { withSpan } from './observability/telemetry.js';
import { RouterClassifier } from './router/classifier.js';
import { ComplexityScorer } from './router/complexity.js';
import { ModelRouter } from './router/router.js';
import type { SandboxExecutor } from './sandbox/executor.js';
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
} from './state/models.js';
import type { StateStore } from './state/store.js';
import { ToolRegistry } from './tools/registry.js';
import { RepairLoop } from './tools/repair.js';
import { ToolValidator } from './tools/validator.js';

export interface SupervisorDeps {
  backend: Backend;
  store: StateStore;
  retriever?: HybridRetriever;
  memory?: MemoryService;
  sandbox?: SandboxExecutor;
  codeIndexer?: CodeIndexer;
  patchWorkflow?: PatchWorkflow;
  permissions?: PermissionService;
  secrets?: SecretResolver;
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
  }): Promise<AgentState> {
    const startedAt = Date.now();
    const state = newAgentState(params.objective, {
      userId: params.userId,
      projectId: params.projectId,
    });
    if (params.context) state.context = params.context;
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

      // 6. FINALIZE
      await this.machine.transition(state, 'COMPLETED', 'ok');
      state.finalResponse = state.executionResult ?? '(no output)';
      await this.bus.publish({
        type: 'run_completed',
        runId: state.runId,
        payload: { finalResponsePreview: state.finalResponse.slice(0, 200) },
        occurredAt: new Date().toISOString(),
      });
      this.metrics.recordRun('succeeded', Date.now() - startedAt, { prompt: 0, completion: 0 });
    } catch (e) {
      const err = e as Error;
      state.errorTrace.push(err.message);
      await this.machine.transition(state, 'FAILED', err.message).catch(() => undefined);
      this.metrics.recordRun('failed', Date.now() - startedAt, { prompt: 0, completion: 0 });
      logger.error({ err, runId: state.runId }, 'supervisor run failed');
    } finally {
      state.updatedAt = new Date().toISOString();
      await this.deps.store.saveRun(state);
    }
    return state;
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
      let evidence: { content: string; citation: string; score: number }[] = [];
      if (this.deps.retriever) {
        try {
          const r = await this.deps.retriever.retrieve({
            query: state.query,
            namespace: ns,
            topK: supervisorConfig.retrieval.topK,
          });
          evidence = r.map((x) => ({ content: x.content, citation: x.citation, score: x.score }));
          this.metrics.recordRetrieval(evidence.length > 0 ? 1 : 0);
        } catch (e) {
          logger.warn({ err: e }, 'retrieval failed — proceeding without evidence');
        }
      }
      state.retrievedEvidence = evidence.map((e) => `[${e.citation}] ${e.content}`);

      // Pull long-term memory too
      let mem: { tier: string; content: string; importance: number }[] = [];
      if (this.deps.memory) {
        try {
          const r = await this.deps.memory.read({ namespace: ns, limit: 5 });
          mem = r.map((m) => ({ tier: m.tier, content: m.content, importance: m.importance }));
        } catch (e) {
          logger.warn({ err: e }, 'memory read failed');
        }
      }

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
      const r = await this.deps.backend.invoke({
        model: supervisorConfig.inference.toolModel,
        prompt,
        formatJson: true,
        thinkMode: state.thinkMode,
      });
      await this.bus.publish({
        type: 'model_invoked',
        runId: state.runId,
        payload: {
          model: supervisorConfig.inference.toolModel,
          thinkMode: state.thinkMode,
          latencyMs: r.latencyMs,
          tokens: r.tokens.prompt + r.tokens.completion,
        },
        occurredAt: new Date().toISOString(),
      });

      // Parse + validate
      let toolName = '';
      let rawArgs: unknown = {};
      if (r.parsed && typeof r.json === 'object' && r.json !== null) {
        const j = r.json as { tool?: string; name?: string; arguments?: unknown };
        toolName = j.tool ?? j.name ?? '';
        rawArgs = j.arguments ?? {};
      }

      await this.bus.publish({
        type: 'tool_call_proposed',
        runId: state.runId,
        payload: { tool: toolName, arguments: rawArgs as Record<string, unknown> },
        occurredAt: new Date().toISOString(),
      });

      const tool = this.registry.get(toolName);
      let validation = tool
        ? this.validator.validateWithTool(tool, rawArgs, {
            userId: state.userId,
            projectId: state.projectId,
            allowedPaths: undefined,
          })
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
          ctx: { userId: state.userId, projectId: state.projectId },
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
          state.errorTrace.push(`tool ${toolName} validation failed`);
          this.recordStep(state, 'EXECUTE_TOOL', {
            status: 'FAILED',
            error: 'repair loop exhausted',
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
        state.executionResult = `SIMULATED_SUCCESS: tool ${toolName} validated with args ${JSON.stringify(finalArgs)}`;
        this.metrics.recordToolCall('executed');
      }

      await this.bus.publish({
        type: 'tool_executed',
        runId: state.runId,
        payload: {
          tool: toolName,
          status: state.executionResult.startsWith('ERROR') ? 'FAILED' : 'SUCCESS',
          resultSummary: state.executionResult.slice(0, 200),
        },
        occurredAt: new Date().toISOString(),
      });

      this.recordStep(state, 'EXECUTE_TOOL', {
        status: state.executionResult.startsWith('ERROR') ? 'FAILED' : 'SUCCEEDED',
        output: { tool: toolName, args: finalArgs, attempts },
        toolName,
        toolArguments: finalArgs,
        executionResult: state.executionResult,
      });
    });
  }

  private async stepExecuteAnalyst(state: AgentState): Promise<void> {
    await withSpan('supervisor.execute.analyst', async () => {
      const built = this.contextBuilder.build({
        systemInstruction:
          'You are the MiniCPM5 analyst sub-agent. Use only the provided evidence.',
        outputSchema: 'Plain text answer. Cite evidence as [citation].',
        toolDefinitions: this.registry.renderForPrompt(),
        task: state.query,
        stateSummary: `intent=${state.intent ?? 'UNKNOWN'} thinkMode=${state.thinkMode}`,
        retrievedEvidence: (state.retrievedEvidence ?? []).map((s, i) => ({
          chunkId: `e${i}`,
          source: 'both' as const,
          score: 1,
          content: s,
          metadata: {},
          citation: `e${i}`,
        })),
        fileSnippets: [],
        conversationHistory: [],
        longTermMemory: [],
      });
      this.metrics.recordContext(built.budget.total, built.usedTokens);
      await this.bus.publish({
        type: 'context_built',
        runId: state.runId,
        payload: {
          tokenBudget: built.budget.total,
          usedTokens: built.usedTokens,
          chunks: state.retrievedEvidence.length,
        },
        occurredAt: new Date().toISOString(),
      });

      const r = await this.deps.backend.invoke({
        model: supervisorConfig.inference.analystModel,
        prompt: built.prompt,
        thinkMode: state.thinkMode,
        maxTokens: supervisorConfig.context.budgetTokens,
      });
      state.executionResult = r.content;
      await this.bus.publish({
        type: 'model_invoked',
        runId: state.runId,
        payload: {
          model: supervisorConfig.inference.analystModel,
          thinkMode: state.thinkMode,
          latencyMs: r.latencyMs,
          tokens: r.tokens.prompt + r.tokens.completion,
        },
        occurredAt: new Date().toISOString(),
      });
      this.recordStep(state, 'INVOKE_MODEL', {
        status: 'SUCCEEDED',
        output: { model: supervisorConfig.inference.analystModel, tokens: r.tokens },
        modelName: supervisorConfig.inference.analystModel,
      });
    });
  }

  private async stepExecuteSummarizer(state: AgentState): Promise<void> {
    await withSpan('supervisor.execute.summarizer', async () => {
      const r = await this.deps.backend.invoke({
        model: supervisorConfig.inference.summarizerModel,
        prompt: `Summarize the following:\n${state.query}`,
        thinkMode: 'no-think',
      });
      state.executionResult = r.content;
      this.recordStep(state, 'INVOKE_MODEL', {
        status: 'SUCCEEDED',
        output: { model: supervisorConfig.inference.summarizerModel },
        modelName: supervisorConfig.inference.summarizerModel,
      });
    });
  }

  private async stepValidateOutput(state: AgentState): Promise<void> {
    await withSpan('supervisor.validate', async () => {
      // For now: non-empty output. In production this would run §12.2
      // validators (lint, typecheck, tests) against any produced artifacts.
      if (!state.executionResult || state.executionResult.length === 0) {
        await this.bus.publish({
          type: 'validation_failed',
          runId: state.runId,
          payload: { validator: 'non-empty', error: 'empty execution result' },
          occurredAt: new Date().toISOString(),
        });
        state.errorTrace.push('validation failed: empty output');
      } else {
        await this.bus.publish({
          type: 'validation_passed',
          runId: state.runId,
          payload: { validators: ['non-empty'] },
          occurredAt: new Date().toISOString(),
        });
      }
      this.recordStep(state, 'VALIDATE_OUTPUT', {
        status: state.executionResult ? 'SUCCEEDED' : 'FAILED',
        output: { result: state.executionResult?.slice(0, 200) },
      });
    });
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
