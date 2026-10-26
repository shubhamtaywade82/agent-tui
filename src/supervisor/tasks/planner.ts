/**
 * Task planner — Phase 3 auto-decomposition.
 *
 * Asks the router variant to emit the initial task graph for a goal
 * under tight schema control. The model's output is parsed against a
 * Zod-validated discriminated union; free-form text or schema-invalid
 * output is rejected and (optionally) repaired once before terminal
 * failure.
 *
 * The planner does NOT call models directly outside the configured
 * router variant. It uses the existing Supervisor Backend
 * abstraction so the model pool (Phase 2), the verification gate
 * (PR #31), and the task ledger (PR #32) all apply. Its only job is
 * to turn a free-text objective into a structured, dependency-ordered
 * list of tasks the orchestrator can run.
 *
 * ## Contract
 *
 *   - `plan(objective, opts)` returns `{ tasks: PlannedTask[] }` or
 *     throws `TaskPlannerError` with the validation errors and the raw
 *     model output for diagnosis.
 *   - Every emitted task conforms to the discriminated union
 *     `PlannedTaskSchema`. Type is one of the eight TaskType values;
 *     `dependencies` reference indices into the returned array
 *     (forward references forbidden — a task may only depend on tasks
 *     emitted before it).
 *   - Bounds enforced post-parse:
 *       - `tasks.length <= config.planner.maxTasksPerGoal`
 *       - longest dependency chain <= `config.planner.maxDepth`
 *       - every dependency index in range
 *       - no cycles (DAG invariant)
 *   - On schema-invalid output, the planner retries up to
 *     `config.planner.maxRepairAttempts` times with the validation
 *     errors fed back into the prompt. After that, terminal failure.
 */
import { z } from 'zod';
import { supervisorConfig } from '../config.js';
import type { Backend } from '../inference/backend.js';
import { logger } from '../observability/logger.js';
import { zodParseFailureCounter } from '../observability/telemetry.js';
import type { TaskType } from './models.js';

/**
 * Single planned task. Mirrors the shape accepted by the existing
 * `POST /v1/goals` `tasks[]` array — the planner's output is a
 * drop-in replacement for the caller-supplied graph.
 *
 * `dependencies` are 0-indexed positions into the planned array
 * (NOT taskIds, which don't exist yet). The route handler converts
 * them to taskIds as it creates each task.
 */
export const PlannedTaskSchema = z.object({
  type: z.enum([
    'PLAN',
    'RETRIEVE',
    'ANALYZE',
    'TOOL',
    'CODE_CHANGE',
    'TEST',
    'VERIFY',
    'SUMMARIZE',
  ]),
  title: z.string().min(1).max(512),
  objective: z.string().min(1).max(16384),
  dependencies: z.array(z.number().int().nonnegative()).default([]),
  maxAttempts: z.number().int().positive().default(3),
});
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

/**
 * The full plan emitted by the model. The wrapper `{ tasks: [...] }`
 * shape (rather than a bare array) is intentional — it lets the
 * model emit additional metadata later (revision, rationale) without
 * breaking the discriminated union.
 */
export const PlanSchema = z.object({
  tasks: z.array(PlannedTaskSchema).min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

export interface PlanOptions {
  /** Caller identity propagated to the inference backend. */
  userId?: string;
  projectId?: string;
  /** Override the configured bounds for this call only. */
  maxTasksPerGoal?: number;
  maxDepth?: number;
  maxRepairAttempts?: number;
  /**
   * Optional acceptance criteria the caller already specified — the
   * planner includes them in the prompt so the model knows what
   * "done" looks like for the goal.
   */
  acceptanceCriteria?: string[];
}

export class TaskPlannerError extends Error {
  constructor(
    message: string,
    public readonly errors: string[],
    public readonly rawOutputs: string[],
  ) {
    super(message);
    this.name = 'TaskPlannerError';
  }
}

const SYSTEM_PROMPT = `You are the MiniCPM5 task planner. Decompose the user's goal into a bounded, dependency-ordered list of tasks the orchestrator will execute.

Output ONLY a JSON object of the form:
{"tasks":[{"type":"<TYPE>","title":"<short>","objective":"<specific>","dependencies":[<indices>],"maxAttempts":3}]}

Rules:
- <TYPE> is one of: PLAN, RETRIEVE, ANALYZE, TOOL, CODE_CHANGE, TEST, VERIFY, SUMMARIZE.
- Each task must be specific enough that a separate model invocation can complete it independently.
- "dependencies" is a list of 0-indexed positions in the tasks array (NOT taskIds). A task may only depend on tasks emitted before it.
- The dependency graph must be acyclic.
- Prefer fewer, well-scoped tasks over many trivial ones. Aim for 3-8 tasks unless the goal genuinely requires more.
- The LAST task should be a VERIFY or SUMMARIZE task that confirms the goal's acceptance criteria were met.
- Do NOT include prose, markdown, or commentary outside the JSON object.`;

export class TaskPlanner {
  constructor(
    private readonly backend: Backend,
    private readonly routerModel: string,
  ) {}

  async plan(objective: string, opts: PlanOptions = {}): Promise<Plan> {
    const maxTasks = opts.maxTasksPerGoal ?? supervisorConfig.planner.maxTasksPerGoal;
    const maxDepth = opts.maxDepth ?? supervisorConfig.planner.maxDepth;
    const maxRepair = opts.maxRepairAttempts ?? supervisorConfig.planner.maxRepairAttempts;

    const prompt = this.buildPrompt(objective, opts.acceptanceCriteria);
    const rawOutputs: string[] = [];

    // First attempt.
    let r = await this.backend.invoke({
      model: this.routerModel,
      prompt,
      formatJson: true,
      temperature: 0.1,
      maxOutputTokens: 2048,
    });
    rawOutputs.push(r.content);

    let parseResult = this.parseAndValidate(r, maxTasks, maxDepth);
    if (parseResult.ok) return parseResult.plan;

    // Repair attempts — feed the validation errors back into the prompt.
    for (let attempt = 1; attempt <= maxRepair; attempt++) {
      logger.warn(
        { attempt, errors: parseResult.errors },
        'task planner: schema-invalid output, repairing',
      );
      const repairPrompt = this.buildRepairPrompt(prompt, r.content, parseResult.errors);
      r = await this.backend.invoke({
        model: this.routerModel,
        prompt: repairPrompt,
        formatJson: true,
        temperature: 0.0,
        maxOutputTokens: 2048,
      });
      rawOutputs.push(r.content);
      parseResult = this.parseAndValidate(r, maxTasks, maxDepth);
      if (parseResult.ok) {
        logger.info(
          { attempt, taskCount: parseResult.plan.tasks.length },
          'task planner: repaired',
        );
        return parseResult.plan;
      }
    }

    zodParseFailureCounter.add(1, { model: this.routerModel, schema: 'PlanSchema' });
    throw new TaskPlannerError(
      `task planner failed after ${maxRepair + 1} attempt(s); last errors: ${parseResult.errors.join('; ')}`,
      parseResult.errors,
      rawOutputs,
    );
  }

  private buildPrompt(objective: string, acceptanceCriteria?: string[]): string {
    const lines = [SYSTEM_PROMPT, '', `# Goal`, objective, ''];
    if (acceptanceCriteria && acceptanceCriteria.length > 0) {
      lines.push('# Acceptance criteria (the goal is SUCCEEDED only when all are met)');
      for (const c of acceptanceCriteria) lines.push(`- ${c}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  private buildRepairPrompt(originalPrompt: string, rawOutput: string, errors: string[]): string {
    return [
      originalPrompt,
      '',
      '# Your previous output was INVALID. Repair it.',
      '',
      'Previous output:',
      '```json',
      rawOutput,
      '```',
      '',
      'Validation errors:',
      ...errors.map((e) => `- ${e}`),
      '',
      'Output ONLY a corrected JSON object conforming to the schema. Do not include prose.',
    ].join('\n');
  }

  private parseAndValidate(
    r: { content: string; json: unknown; parsed: boolean },
    maxTasks: number,
    maxDepth: number,
  ): { ok: true; plan: Plan } | { ok: false; errors: string[] } {
    if (!r.parsed || typeof r.json !== 'object' || r.json === null) {
      return { ok: false, errors: ['model output is not a JSON object'] };
    }
    const result = PlanSchema.safeParse(r.json);
    if (!result.success) {
      return {
        ok: false,
        errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }
    const plan = result.data;

    // Bounds: task count.
    if (plan.tasks.length > maxTasks) {
      return { ok: false, errors: [`plan has ${plan.tasks.length} tasks; cap is ${maxTasks}`] };
    }

    // Bounds: dependency indices must be in range and refer to earlier tasks.
    for (let i = 0; i < plan.tasks.length; i++) {
      const t = plan.tasks[i];
      if (!t) continue;
      for (const dep of t.dependencies) {
        if (dep >= i) {
          return {
            ok: false,
            errors: [
              `task ${i} (${t.title}) depends on index ${dep}, which is not before it (forward references forbidden)`,
            ],
          };
        }
      }
    }

    // Bounds: max depth (longest dependency chain).
    const depth = this.computeDepth(plan);
    if (depth > maxDepth) {
      return {
        ok: false,
        errors: [
          `dependency depth ${depth} exceeds cap ${maxDepth} — split the goal into sub-goals`,
        ],
      };
    }

    // Bounds: DAG invariant (no cycles). With the forward-reference
    // check above, cycles are impossible — but assert anyway for
    // defence in depth.
    const cycle = this.detectCycle(plan);
    if (cycle) {
      return { ok: false, errors: [`dependency cycle detected: ${cycle.join(' → ')}`] };
    }

    return { ok: true, plan };
  }

  /**
   * Longest chain in the dependency graph. Computed by memoised DFS
   * from each task. A task with no dependencies has depth 1; a task
   * depending on a depth-N task has depth N+1.
   */
  private computeDepth(plan: Plan): number {
    const memo = new Map<number, number>();
    const depth = (i: number): number => {
      if (memo.has(i)) return memo.get(i) ?? 0;
      const t = plan.tasks[i];
      if (!t || t.dependencies.length === 0) {
        memo.set(i, 1);
        return 1;
      }
      const max = Math.max(...t.dependencies.map((dep) => depth(dep)));
      memo.set(i, max + 1);
      return max + 1;
    };
    let overall = 0;
    for (let i = 0; i < plan.tasks.length; i++) overall = Math.max(overall, depth(i));
    return overall;
  }

  /**
   * Returns the cycle as an array of task indices, or null if acyclic.
   * DFS with three colours: white (unvisited), grey (on stack), black (done).
   */
  private detectCycle(plan: Plan): number[] | null {
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const colour = new Array(plan.tasks.length).fill(WHITE);
    const stack: number[] = [];

    const visit = (i: number): number[] | null => {
      if (colour[i] === GREY) {
        // Found a cycle — slice the stack from the first occurrence of i.
        const start = stack.indexOf(i);
        return [...stack.slice(start), i];
      }
      if (colour[i] === BLACK) return null;
      colour[i] = GREY;
      stack.push(i);
      const t = plan.tasks[i];
      if (t) {
        for (const dep of t.dependencies) {
          const cycle = visit(dep);
          if (cycle) return cycle;
        }
      }
      stack.pop();
      colour[i] = BLACK;
      return null;
    };

    for (let i = 0; i < plan.tasks.length; i++) {
      if (colour[i] === WHITE) {
        const cycle = visit(i);
        if (cycle) return cycle;
      }
    }
    return null;
  }
}

/**
 * Convert a planned task graph into the shape the TaskLedger.createTask
 * accepts. The planner emits `dependencies` as 0-indexed positions;
 * the ledger accepts `dependencies` as taskIds. This helper does the
 * translation, mirroring the same loop in the POST /v1/goals handler.
 *
 * Exported so the route handler can reuse it for both caller-supplied
 * and planner-emitted graphs.
 */
export function plannedTasksToCreateInputs(
  plan: Plan,
): Array<Omit<import('./ledger.js').CreateTaskInput, 'goalId' | 'sequence'>> {
  return plan.tasks.map((t) => ({
    type: t.type as TaskType,
    title: t.title,
    objective: t.objective,
    dependencies: [], // resolved to taskIds by the caller as tasks are created
    maxAttempts: t.maxAttempts,
  }));
}
