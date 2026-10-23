/**
 * PatchWorkflow against real git repositories. The model-supplied inputs (paths,
 * branch name, commit message) are the attack surface, so each has a case.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PatchWorkflow } from '../../../src/supervisor/code/patch.js';
import type { SandboxExecutor } from '../../../src/supervisor/sandbox/executor.js';

const passingSandbox = { run: async () => ({ ok: true }) } as unknown as SandboxExecutor;

let base: string;
let repo: string;
const cleanupDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'patch-test-'));
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'branch', 'feature'); // created, not checked out, so a worktree can use it
});

afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

describe('PatchWorkflow.apply', () => {
  it('applies file changes in a worktree and returns the diff', async () => {
    const wf = new PatchWorkflow(passingSandbox);
    const r = await wf.apply({
      runId: 'r1',
      repoPath: repo,
      branch: 'feature',
      files: { 'src/a.ts': 'export const a = 2;\n', 'NEW.md': 'new file\n' },
      verifyCommands: [],
    });
    cleanupDirs.push(r.worktreePath);
    expect(r.ok).toBe(true);
    expect(r.diff).toContain('+export const a = 2;');
    expect(r.diff).toContain('+new file');
    await wf.cleanup(r.worktreePath, repo);
  });

  it('deletes a file when its content is empty', async () => {
    const wf = new PatchWorkflow(passingSandbox);
    const r = await wf.apply({
      runId: 'r2',
      repoPath: repo,
      branch: 'feature',
      files: { 'README.md': '' },
      verifyCommands: [],
    });
    cleanupDirs.push(r.worktreePath);
    expect(r.ok).toBe(true);
    expect(r.diff).toContain('-hello');
    await wf.cleanup(r.worktreePath, repo);
  });

  it('refuses a path that climbs out of the worktree and writes nothing outside it', async () => {
    const wf = new PatchWorkflow(passingSandbox);
    const r = await wf.apply({
      runId: 'r3',
      repoPath: repo,
      branch: 'feature',
      files: { '../escape.txt': 'x' },
      verifyCommands: [],
    });
    cleanupDirs.push(r.worktreePath);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsafe patch path|escapes the worktree/);
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
  });

  it('refuses an absolute path', async () => {
    const wf = new PatchWorkflow(passingSandbox);
    const target = join(base, 'abs-target.txt');
    const r = await wf.apply({
      runId: 'r4',
      repoPath: repo,
      branch: 'feature',
      files: { [target]: 'x' },
      verifyCommands: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsafe patch path/);
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a branch name that carries shell syntax or a leading dash, and runs nothing', async () => {
    const wf = new PatchWorkflow(passingSandbox);
    const injected = await wf.apply({
      runId: 'r5',
      repoPath: repo,
      branch: 'feature; touch PWNED-BRANCH',
      files: {},
      verifyCommands: [],
    });
    expect(injected.ok).toBe(false);
    expect(injected.error).toMatch(/invalid branch name/);
    const option = await wf.apply({
      runId: 'r6',
      repoPath: repo,
      branch: '--upload-pack=touch PWNED-OPT',
      files: {},
      verifyCommands: [],
    });
    expect(option.ok).toBe(false);
    expect(existsSync(join(repo, 'PWNED-BRANCH'))).toBe(false);
    expect(existsSync(join(repo, 'PWNED-OPT'))).toBe(false);
  });

  it('stores a commit message containing command substitution as literal text', async () => {
    const wf = new PatchWorkflow(passingSandbox);
    const message = 'fix: handle $(touch PWNED-MSG) and `touch PWNED-TICK` "quoted"';
    const r = await wf.apply({
      runId: 'r7',
      repoPath: repo,
      branch: 'feature',
      files: { 'src/a.ts': 'export const a = 3;\n' },
      verifyCommands: [],
      commitMessage: message,
    });
    cleanupDirs.push(r.worktreePath);
    expect(r.ok).toBe(true);
    expect(r.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(r.worktreePath, 'log', '-1', '--format=%B').trim()).toBe(message);
    expect(existsSync(join(repo, 'PWNED-MSG'))).toBe(false);
    expect(existsSync(join(r.worktreePath, 'PWNED-MSG'))).toBe(false);
    expect(existsSync(join(repo, 'PWNED-TICK'))).toBe(false);
    await wf.cleanup(r.worktreePath, repo);
  });

  it('refuses to write through a tracked symlink that points outside the worktree', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(repo, 'linkdir'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add symlink');
    git(repo, 'branch', '-f', 'feature', 'HEAD');

    const wf = new PatchWorkflow(passingSandbox);
    const r = await wf.apply({
      runId: 'r8',
      repoPath: repo,
      branch: 'feature',
      files: { 'linkdir/x.txt': 'x' },
      verifyCommands: [],
    });
    cleanupDirs.push(r.worktreePath);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/symlink/);
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
    await wf.cleanup(r.worktreePath, repo);
  });
});
