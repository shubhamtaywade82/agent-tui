/**
 * ToolValidator — §10.2. Validation gates.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PermissionService } from '../../../src/supervisor/security/permissions.js';
import { type ToolDefinition, ToolRegistry } from '../../../src/supervisor/tools/registry.js';
import { ToolValidator } from '../../../src/supervisor/tools/validator.js';

describe('ToolValidator', () => {
  let registry: ToolRegistry;
  let permissions: PermissionService;
  let validator: ToolValidator;
  let tool: ToolDefinition;

  beforeEach(() => {
    registry = new ToolRegistry();
    permissions = new PermissionService();
    validator = new ToolValidator(permissions);
    tool = {
      name: 'read_file',
      description: 'Read a file',
      parametersSchema: z.object({
        path: z.string(),
        startLine: z.number().int().positive().optional(),
      }),
      permissions: ['workspace.read'],
      riskLevel: 'low',
      timeoutMs: 5000,
    };
    registry.register(tool);
    permissions.assignRole('alice', 'developer');
  });

  it('accepts a valid call', () => {
    const r = validator.validateWithTool(
      tool,
      { path: '/workspace/README.md' },
      { userId: 'alice' },
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects schema mismatches', () => {
    const r = validator.validateWithTool(tool, { path: 42 }, { userId: 'alice' });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects when required permission is missing', () => {
    const r = validator.validateWithTool(tool, { path: '/workspace/x' }, { userId: 'bob' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('permissions'))).toBe(true);
  });

  it('rejects paths outside allowed scope', () => {
    const r = validator.validateWithTool(
      tool,
      { path: '/etc/passwd' },
      { userId: 'alice', allowedPaths: ['/workspace'] },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('outside allowed scope'))).toBe(true);
  });

  it('rejects critical-risk tools without approval', () => {
    tool = { ...tool, riskLevel: 'critical' };
    const r = validator.validateWithTool(tool, { path: '/workspace/x' }, { userId: 'alice' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('approval'))).toBe(true);
  });

  it('allows critical-risk tools when approval was granted', () => {
    tool = { ...tool, riskLevel: 'critical' };
    const r = validator.validateWithTool(
      tool,
      { path: '/workspace/x' },
      { userId: 'alice', approvalGranted: true },
    );
    expect(r.ok).toBe(true);
  });

  it('rejects secret leakage in arguments', () => {
    const r = validator.validate(
      'read_file',
      { path: '/workspace/x', token: `ghp_${'a'.repeat(40)}` },
      { userId: 'alice' },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('secret'))).toBe(true);
  });

  it('rejects oversized payloads', () => {
    const huge = 'x'.repeat(300 * 1024);
    const r = validator.validate('read_file', { path: huge }, { userId: 'alice' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('payload exceeds'))).toBe(true);
  });
});
