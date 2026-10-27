/**
 * CodeChangeExecutor — Phase 5 patch workflow invariants.
 *
 * These tests pin down the contract the orchestrator relies on:
 *   - A schema-valid proposal is applied in an isolated git worktree.
 *   - Verification commands run in the sandbox; the model's claim
 *     that "tests passed" is NOT accepted as evidence.
 *   - Schema-invalid output (free-form text, missing files, bad
 *     branch name) is rejected before any filesystem side effect.
 *   - Bounds enforcement: too many files, too many bytes.
 *   - The diff and commit SHA are returned on success.
 *
 * All tests use a real git repository in a temp directory and a
 * stub SandboxExecutor that returns configurable results.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodeChangeExecutor,
  PatchProposalSchema,
} from '../../../src/supervisor/code/code-change-executor.js';
import { PatchWorkflow } from '../../../src/supervisor/code/patch.js';
import { MockBackend } from '../../../src/supervisor/inference/mock.js';
import type { SandboxExecutor, SandboxResult } from '../../../src/supervisor/sandbox/executor.js';

function makeSandbox(results: 'pass' | 'fail' | ((cmd: string) => boolean)): {
  sandbox: SandboxExecutor;
  calls: string[];
} {
  const calls: string[] = [];
  const sandbox = {
    run: async (req: { command: string }): Promise<SandboxResult> => {
      calls.push(req.command);
      const ok =
        results === 'pass' ? true : typeof results === 'function' ? results(req.command) : false;
      return {
        ok,
        exitCode: ok ? 0 : 1,
        stdout: ok ? 'ok' : '',
        stderr: ok ? '' : 'command failed',
        durationMs: 10,
        timedOut: false,
        containerId: 'test',
      };
    },
  } as unknown as SandboxExecutor;
  return { sandbox, calls };
}

let base: string;
let repo: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'code-change-test-'));
  repo = join(base, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  execFileSync('git', ['branch', 'feature'], { cwd: repo });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('CodeChangeExecutor — schema validation', () => {
  it('accepts a valid patch proposal and applies it', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-analyst', () => ({
      json: {
        files: { 'src/a.ts': 'export const a = 2;\n' },
        branch: 'feature',
        verifyCommands: ['npm test'],
        commitMessage: 'fix: update a',
        rationale: 'bumping the value',
      },
    }));
    const { sandbox } = makeSandbox('pass');
    const wf = new PatchWorkflow(sandbox);
    const executor = new CodeChangeExecutor(backend, 'minicpm5-analyst', wf);

    const r = await executor.execute({
      objective: 'Update a to 2',
      runId: 'r1',
      repoPath: repo,
    });

    expect(r.ok).toBe(true);
    expect(r.proposal?.files).toEqual({ 'src/a.ts': 'export const a = 2;\n' });
    expect(r.diff).toContain('+export const a = 2;');
    expect(r.commitSha).toBeDefined();
    expect(r.verifyResults).toHaveLength(1 + 3); // npm test + 3 defaults
    expect(r.errors).toEqual([]);
  });

  it('rejects free-form text output with errors', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-analyst', () => 'I think you should change the file.');
    const { sandbox } = makeSandbox('pass');
    const wf = new PatchWorkflow(sandbox);
    const executor = new CodeChangeExecutor(backend, 'minicpm5-analyst', wf);

    const r = await executor.execute({
      objective: 'Update a',
      runId: 'r2',
      repoPath: repo,
    });

    expect(r.ok).toBe(false);
    expect(r.errors).toContain('model output is not a JSON object');
    expect(r.diff).toBe('');
    expect(r.verifyResults).toEqual([]);
  });

  it('rejects a proposal with no files', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-analyst', () => ({
      json: { files: {}, branch: 'feature', verifyCommands: [] },
    }));
    const { sandbox } = makeSandbox('pass');
    const wf = new PatchWorkflow(sandbox);
    const executor = new CodeChangeExecutor(backend, 'minicpm5-analyst', wf);

    const r = await executor.execute({
      objective: 'Update a',
      runId: 'r3',
      repoPath: repo,
    });

    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('at least one file'))).toBe(true);
  });

  it('rejects an invalid git branch name', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-analyst', () => ({
      json: {
        files: { 'src/a.ts': 'export const a = 2;\n' },
        branch: '--evil', // starts with dash — option injection attempt
        verifyCommands: [],
      },
    }));
    const { sandbox } = makeSandbox('pass');
    const wf = new PatchWorkflow(sandbox);
    const executor = new CodeChangeExecutor(backend, 'minicpm5-analyst', wf);

    const r = await executor.execute({
      objective: 'Update a',
      runId: 'r4',
      repoPath: repo,
    });

    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('invalid git branch name'))).toBe(true);
  });
});

describe('CodeChangeExecutor — verification is authoritative', () => {
  it('returns ok=false when a verification command fails', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-analyst', () => ({
      json: {
        files: { 'src/a.ts': 'export const a = 2;\n' },
        branch: 'feature',
        verifyCommands: ['npm test'],
      },
    }));
    // Sandbox fails all commands.
    const { sandbox, calls } = makeSandbox('fail');
    const wf = new PatchWorkflow(sandbox);
    const executor = new CodeChangeExecutor(backend, 'minicpm5-analyst', wf);

    const r = await executor.execute({
      objective: 'Update a',
      runId: 'r5',
      repoPath: repo,
    });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('verification');
    expect(r.verifyResults.length).toBeGreaterThan(0);
    expect(r.verifyResults.every((v) => !v.ok)).toBe(true);
    // The default verify commands also ran (not just the model's).
    expect(calls.length).toBe(4); // 1 model + 3 defaults
  });

  it('runs the configured default verify commands even when the model proposes none', async () => {
    const backend = new MockBackend();
    backend.enqueue('minicpm5-analyst', () => ({
      json: {
        files: { 'src/a.ts': 'export const a = 2;\n' },
        branch: 'feature',
        verifyCommands: [],
      },
    }));
    const { sandbox, calls } = makeSandbox('pass');
    const wf = new PatchWorkflow(sandbox);
    const executor = new CodeChangeExecutor(backend, 'minicpm5-analyst', wf);

    const r = await executor.execute({
      objective: 'Update a',
      runId: 'r6',
      repoPath: repo,
    });

    expect(r.ok).toBe(true);
    // 3 default commands ran.
    expect(calls).toHaveLength(3);
    expect(calls).toContain('npm run supervisor:typecheck');
    expect(calls).toContain('npm run supervisor:lint');
    expect(calls).toContain('npm run supervisor:test');
  });
});

describe('CodeChangeExecutor — bounds enforcement', () => {
  it('rejects a patch that touches more than maxFilesPerPatch files', async () => {
    const backend = new MockBackend();
    // Emit 25 files; default cap is 20.
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) files[`src/file${i}.ts`] = `export const x${i} = ${i};\n`;
    backend.enqueue('minicpm5-analyst', () => ({
      json: { files, branch: 'feature', verifyCommands: [] },
    }));
    const { sandbox } = makeSandbox('pass');
    const wf = new PatchWorkflow(sandbox);
    const executor = new CodeChangeExecutor(backend, 'minicpm5-analyst', wf);

    const r = await executor.execute({
      objective: 'Add many files',
      runId: 'r7',
      repoPath: repo,
    });

    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('more than'))).toBe(true);
  });
});

describe('PatchProposalSchema — exports', () => {
  it('validates a minimal proposal', () => {
    const r = PatchProposalSchema.safeParse({
      files: { 'src/a.ts': 'content' },
      branch: 'main',
    });
    expect(r.success).toBe(true);
  });

  it('applies defaults for verifyCommands', () => {
    const r = PatchProposalSchema.safeParse({
      files: { 'src/a.ts': 'content' },
      branch: 'main',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.verifyCommands).toEqual([]);
    }
  });
});
