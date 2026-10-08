/**
 * RepairLoop — §10.3. MockBackend-driven happy + failure paths.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import { PermissionService } from '../../../src/supervisor/security/permissions.js';
import { ToolRegistry } from '../../../src/supervisor/tools/registry.js';
import { RepairLoop } from '../../../src/supervisor/tools/repair.js';
import { ToolValidator } from '../../../src/supervisor/tools/validator.js';

describe('RepairLoop', () => {
  let backend: MockBackend;
  let registry: ToolRegistry;
  let permissions: PermissionService;
  let repair: RepairLoop;

  beforeEach(() => {
    backend = new MockBackend();
    registry = new ToolRegistry();
    permissions = new PermissionService();
    permissions.assignRole('alice', 'developer');
    const validator = new ToolValidator(permissions);
    registry.register({
      name: 'send_email',
      description: 'Send an email',
      parametersSchema: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
      permissions: ['workspace.write'],
      riskLevel: 'medium',
      timeoutMs: 5000,
    });
    repair = new RepairLoop(backend, registry, validator, 'minicpm5-toolagent');
  });

  it('returns immediately when the original output is valid', async () => {
    const valid = JSON.stringify({
      tool: 'send_email',
      arguments: { to: 'team@example.com', subject: 'deploy failed', body: 'please investigate' },
    });
    const r = await repair.run({
      toolName: 'send_email',
      originalPrompt: 'Send an email',
      originalRawOutput: valid,
      ctx: { userId: 'alice' },
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(0);
  });

  it('repairs on the first retry when the model produces valid JSON', async () => {
    const invalid = JSON.stringify({
      tool: 'send_email',
      arguments: { to: 'not-an-email', subject: 'x', body: 'y' },
    });
    const fixed = JSON.stringify({
      tool: 'send_email',
      arguments: { to: 'team@example.com', subject: 'deploy failed', body: 'please investigate' },
    });
    backend.enqueue('minicpm5-toolagent', () => fixed);
    const r = await repair.run({
      toolName: 'send_email',
      originalPrompt: 'Send an email',
      originalRawOutput: invalid,
      ctx: { userId: 'alice' },
      maxRetries: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it('gives up after maxRetries', async () => {
    const invalid = JSON.stringify({ tool: 'send_email', arguments: { to: 'still-bad' } });
    backend.enqueue('minicpm5-toolagent', () => invalid);
    backend.enqueue('minicpm5-toolagent', () => invalid);
    backend.enqueue('minicpm5-toolagent', () => invalid);
    const r = await repair.run({
      toolName: 'send_email',
      originalPrompt: 'Send an email',
      originalRawOutput: invalid,
      ctx: { userId: 'alice' },
      maxRetries: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.history.length).toBe(3);
  });

  it('rejects unknown tools immediately', async () => {
    const r = await repair.run({
      toolName: 'nonexistent_tool',
      originalPrompt: 'x',
      originalRawOutput: '{}',
      ctx: { userId: 'alice' },
    });
    expect(r.ok).toBe(false);
  });
});
