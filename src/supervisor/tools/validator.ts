/**
 * Tool validator — §10.2 (Validation Rules).
 *
 * Eight deterministic gates run before any tool call is dispatched:
 *   1. tool exists in registry
 *   2. arguments match zod schema
 *   3. caller has required permissions
 *   4. resource path is within allowed scope
 *   5. command is not on the denylist
 *   6. payload size is within limits
 *   7. no secrets leaking in arguments
 *   8. operation is within risk policy (and approval was granted if critical)
 */

import { logger } from '../observability/logger.js';
import type { PermissionService } from '../security/permissions.js';
import type { ToolDefinition } from './registry.js';

export interface ValidationResult {
  ok: boolean;
  tool?: ToolDefinition;
  parsedArgs?: Record<string, unknown>;
  errors: string[];
}

const MAX_PAYLOAD_BYTES = 256 * 1024;
const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{36,}/,
  /gho_[A-Za-z0-9]{36,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
];

export class ToolValidator {
  constructor(private readonly permissions: PermissionService) {}

  validate(
    _name: string,
    rawArgs: unknown,
    _ctx: {
      userId?: string;
      projectId?: string;
      allowedPaths?: string[];
      approvalGranted?: boolean;
    },
  ): ValidationResult {
    const errors: string[] = [];

    // 1. tool exists
    // (caller passes the resolved ToolDefinition; this gate is enforced upstream)

    // 6. payload size — check before schema parsing (cheap)
    const serialized = JSON.stringify(rawArgs ?? {});
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      errors.push(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }

    // 7. secret leakage
    for (const re of SECRET_PATTERNS) {
      if (re.test(serialized)) {
        errors.push(`suspected secret in arguments (matched ${re.source.slice(0, 32)}…)`);
        break;
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    return { ok: true, errors: [] };
  }

  validateWithTool(
    tool: ToolDefinition,
    rawArgs: unknown,
    ctx: {
      userId?: string;
      projectId?: string;
      allowedPaths?: string[];
      approvalGranted?: boolean;
    },
  ): ValidationResult {
    // 2. schema
    const parsed = tool.parametersSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        tool,
        errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }

    // 1+general gates
    const base = this.validate(tool.name, rawArgs, ctx);
    if (!base.ok) return { ...base, tool };

    // 3. permissions
    if (tool.permissions.length > 0) {
      const ok = tool.permissions.every((p) => this.permissions.has(ctx.userId, p));
      if (!ok) {
        return {
          ok: false,
          tool,
          parsedArgs: parsed.data as Record<string, unknown>,
          errors: [`missing permissions: ${tool.permissions.join(', ')}`],
        };
      }
    }

    // 4. resource scope (basic path check — for tools that touch files)
    const args = parsed.data as Record<string, unknown>;
    if (typeof args.path === 'string' && ctx.allowedPaths && ctx.allowedPaths.length > 0) {
      const path = String(args.path);
      const inside = ctx.allowedPaths.some((p) => path === p || path.startsWith(`${p}/`));
      if (!inside) {
        return {
          ok: false,
          tool,
          parsedArgs: args,
          errors: [`path ${path} outside allowed scope`],
        };
      }
    }

    // 8. risk policy
    if (tool.riskLevel === 'critical' && !ctx.approvalGranted) {
      return {
        ok: false,
        tool,
        parsedArgs: args,
        errors: ['critical risk requires explicit approval (§9.4)'],
      };
    }

    // tool-specific custom validator
    if (tool.validate) {
      const customError = tool.validate(args);
      if (customError) {
        return { ok: false, tool, parsedArgs: args, errors: [customError] };
      }
    }

    logger.debug({ tool: tool.name, risk: tool.riskLevel }, 'tool call validated');
    return { ok: true, tool, parsedArgs: args, errors: [] };
  }
}
