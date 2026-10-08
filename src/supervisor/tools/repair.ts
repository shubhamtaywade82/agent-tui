import { supervisorConfig } from '../config.js';
import type { Backend } from '../inference/backend.js';
import { logger } from '../observability/logger.js';
import type { ToolDefinition, ToolRegistry } from './registry.js';
import type { ToolValidator, ValidationResult } from './validator.js';

export interface RepairResult {
  ok: boolean;
  attempts: number;
  finalArgs?: Record<string, unknown>;
  finalValidation?: ValidationResult;
  history: Array<{ attempt: number; raw: string; errors: string[] }>;
}

export class RepairLoop {
  constructor(
    private readonly backend: Backend,
    private readonly registry: ToolRegistry,
    private readonly validator: ToolValidator,
    private readonly toolModel: string,
  ) {}

  async run(params: {
    toolName: string;
    originalPrompt: string;
    originalRawOutput: string;
    ctx: {
      userId?: string;
      projectId?: string;
      allowedPaths?: string[];
      approvalGranted?: boolean;
    };
    maxRetries?: number;
  }): Promise<RepairResult> {
    const maxRetries = params.maxRetries ?? supervisorConfig.escalation.maxRetries;
    const tool = this.registry.get(params.toolName);
    if (!tool) {
      return {
        ok: false,
        attempts: 0,
        history: [
          {
            attempt: 0,
            raw: params.originalRawOutput,
            errors: [`unknown tool: ${params.toolName}`],
          },
        ],
      };
    }

    const history: RepairResult['history'] = [];

    // Attempt 0: the original output
    let args = this.parseArgs(params.originalRawOutput);
    let validation = this.validator.validateWithTool(tool, args, params.ctx);
    history.push({ attempt: 0, raw: params.originalRawOutput, errors: validation.errors });

    if (validation.ok) {
      return {
        ok: true,
        attempts: 0,
        finalArgs: validation.parsedArgs,
        finalValidation: validation,
        history,
      };
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const repairPrompt = this.buildRepairPrompt(
        tool,
        params.originalPrompt,
        validation.errors,
        args,
      );
      const r = await this.backend.invoke({
        model: this.toolModel,
        prompt: repairPrompt,
        formatJson: true,
        temperature: 0.0,
        maxTokens: 1024,
      });

      args = this.parseArgs(r.content);
      validation = this.validator.validateWithTool(tool, args, params.ctx);
      history.push({ attempt, raw: r.content, errors: validation.errors });

      if (validation.ok) {
        logger.info({ tool: params.toolName, attempt }, 'tool call repaired');
        return {
          ok: true,
          attempts: attempt,
          finalArgs: validation.parsedArgs,
          finalValidation: validation,
          history,
        };
      }
    }

    logger.warn({ tool: params.toolName, attempts: maxRetries }, 'repair loop exhausted');
    return { ok: false, attempts: maxRetries, finalValidation: validation, history };
  }

  private parseArgs(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'arguments' in parsed) {
        return (parsed as { arguments: Record<string, unknown> }).arguments;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private buildRepairPrompt(
    tool: ToolDefinition,
    originalPrompt: string,
    errors: string[],
    previousArgs: Record<string, unknown>,
  ): string {
    return [
      `You previously produced an INVALID tool call. Repair it.`,
      ``,
      `Original task: ${originalPrompt}`,
      ``,
      `Tool: ${tool.name}`,
      `Description: ${tool.description}`,
      `Schema: ${JSON.stringify(tool.parametersSchema)}`,
      ``,
      `Previous (invalid) arguments: ${JSON.stringify(previousArgs)}`,
      ``,
      `Validation errors:`,
      ...errors.map((e) => `- ${e}`),
      ``,
      `Output ONLY a JSON object of the form {"arguments": { ... }} matching the schema exactly.`,
    ].join('\n');
  }
}
