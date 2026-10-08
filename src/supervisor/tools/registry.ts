/**
 * Tool registry — §10 (Tool Calling and Action Validation).
 *
 * Holds the schema, permission, risk level, and timeout for every tool
 * the agent is allowed to call. The registry is the single source of
 * truth the validator consults before any tool call is dispatched to the
 * sandbox (§11) or any external API.
 *
 * §10.1 — each tool record carries: name, description, parameters schema,
 * permissions, risk_level, timeout_ms. §10.2 — every invocation is
 * validated against schema, permission, scope, denylist, size, secret
 * leakage, and risk policy before execution.
 */
import type { ZodTypeAny, z } from 'zod';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ToolDefinition<A extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  parametersSchema: A;
  permissions: string[]; // §16 permission codes required to invoke
  riskLevel: RiskLevel;
  timeoutMs: number;
  /** Idempotent tools can be safely retried after a transient failure (§9.3). */
  idempotent?: boolean;
  /** Custom validator hook — runs after schema validation (§10.2). */
  validate?: (args: z.infer<A>) => string | null;
  /** Executor hook — if omitted, the sandbox executes the call. */
  execute?: (args: z.infer<A>, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>;
}

export interface ToolExecutionContext {
  runId: string;
  stepId: string;
  workspacePath: string;
  userId?: string;
  projectId?: string;
}

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
  artifacts?: Array<{ path: string; checksum?: string }>;
  metadata?: Record<string, unknown>;
  error?: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<A extends ZodTypeAny>(def: ToolDefinition<A>): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Render tool definitions as a string for §8.2 P2 of the context builder. */
  renderForPrompt(): string {
    return [...this.tools.values()]
      .map(
        (t) =>
          `## ${t.name}\n${t.description}\nrisk: ${t.riskLevel} | timeout: ${t.timeoutMs}ms | permissions: ${t.permissions.join(', ') || 'none'}\nschema: ${JSON.stringify(t.parametersSchema)}`,
      )
      .join('\n\n');
  }
}
