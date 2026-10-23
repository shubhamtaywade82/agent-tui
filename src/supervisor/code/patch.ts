/**
 * Patch workflow — §12.2 (Code Change Validation) and §12.3 (Patch Workflow).
 *
 * Drives a deterministic flow for any code change proposed by the analyst
 * model:
 *   1. retrieve relevant files (§6)
 *   2. generate candidate patch (§13 analyst model)
 *   3. apply patch in a git worktree (sandboxed)
 *   4. run tests (§12.2 validators)
 *   5. if tests fail → repair patch (§10.3 repair loop)
 *   6. if tests pass → emit diff / open PR
 *   7. human review (§9.4) for high-risk changes
 *
 * §20 — "Use MiniCPM5-2B for compact, local, low-latency agent steps; use
 * external infrastructure for truth, memory, state, security, and
 * verification". This workflow is the verification half of that contract.
 *
 * Security: the paths, branch name and commit message come from model output.
 * Every git call therefore runs with argv through execFile, never a shell.
 * Paths are confined to the worktree, and writes through symlinks are refused.
 */
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { logger } from '../observability/logger.js';
import type { SandboxExecutor, SandboxResult } from '../sandbox/executor.js';

export interface PatchRequest {
  runId: string;
  repoPath: string;
  branch: string;
  /** Relative path → new file content. Use empty string to delete. */
  files: Record<string, string>;
  /** Validation commands to run after applying the patch (§12.2). */
  verifyCommands: string[];
  /** Optional commit message for the resulting commit. */
  commitMessage?: string;
}

export interface PatchResult {
  ok: boolean;
  worktreePath: string;
  diff: string;
  commitSha?: string;
  verifyResults: Array<{ command: string; result: SandboxResult }>;
  error?: string;
}

/** Git branch names: a letter or digit first, then letters, digits, `.`, `_`, `-`, `/`. No leading dash. */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Throws unless `branch` is a name git accepts and that cannot be read as an option. */
export function validateBranch(branch: string): void {
  if (
    !BRANCH_RE.test(branch) ||
    branch.includes('..') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock')
  ) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
  }
}

/**
 * Resolve a patch-relative path to an absolute path inside `root`. Rejects absolute
 * paths, NUL bytes, and any path that climbs out of `root`.
 */
export function resolveInside(root: string, relPath: string): string {
  if (!relPath || isAbsolute(relPath) || relPath.includes('\0')) {
    throw new Error(`unsafe patch path: ${JSON.stringify(relPath)}`);
  }
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`patch path escapes the worktree: ${relPath}`);
  }
  return abs;
}

/** True when `target` is `root` or lies beneath it. Both must be real paths. */
function isWithinRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** Real path of `p`, or of its nearest existing ancestor when `p` does not exist yet. */
async function realpathOfNearestAncestor(p: string): Promise<string> {
  let current = p;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error(`no existing ancestor for ${p}`);
      current = parent;
    }
  }
}

/** Runs git with argv through execFile. No shell ever parses an argument. */
function runGit(args: readonly string[], cwd?: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) fail(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim()}`));
        else done(String(stdout));
      },
    );
  });
}

export class PatchWorkflow {
  constructor(private readonly sandbox: SandboxExecutor) {}

  async apply(req: PatchRequest): Promise<PatchResult> {
    // Validate every model-supplied value before any filesystem or git side effect.
    try {
      validateBranch(req.branch);
      if (!isAbsolute(req.repoPath)) throw new Error(`repoPath must be absolute: ${req.repoPath}`);
      for (const relPath of Object.keys(req.files)) resolveInside('/patch-root', relPath);
    } catch (e) {
      return {
        ok: false,
        worktreePath: '',
        diff: '',
        verifyResults: [],
        error: (e as Error).message,
      };
    }

    // 1. Create a worktree on a temp branch
    const worktree = await mkdtemp(join(tmpdir(), 'supervisor-patch-'));
    try {
      await runGit([
        '-C',
        req.repoPath,
        'worktree',
        'add',
        '-b',
        `${req.branch}-review`,
        worktree,
        req.branch,
      ]);
      const realRoot = await realpath(worktree);

      // 2. Apply file changes, confined to the worktree and never through a symlink
      for (const [relPath, content] of Object.entries(req.files)) {
        const abs = resolveInside(worktree, relPath);
        if (content === '') {
          await rm(abs, { force: true });
          continue;
        }
        // Check the nearest existing ancestor before mkdir, because mkdir -p follows symlinks.
        const ancestor = await realpathOfNearestAncestor(dirname(abs));
        if (!isWithinRoot(realRoot, ancestor)) {
          throw new Error(`patch path resolves outside the worktree through a symlink: ${relPath}`);
        }
        await mkdir(dirname(abs), { recursive: true });
        const existing = await lstat(abs).catch(() => null);
        if (existing?.isSymbolicLink()) {
          throw new Error(`refusing to write through a symlink: ${relPath}`);
        }
        await writeFile(abs, content, 'utf8');
      }

      // 3. Stage all changes and produce a diff
      await runGit(['-C', worktree, 'add', '-A']);
      const diff = await runGit(['-C', worktree, 'diff', '--cached']);

      // 4. Optionally commit (still on the temp branch). The message is a single argv element.
      let commitSha: string | undefined;
      if (req.commitMessage) {
        await runGit([
          '-C',
          worktree,
          '-c',
          'user.email=supervisor-bot@local',
          '-c',
          'user.name=Supervisor',
          'commit',
          '-m',
          req.commitMessage,
        ]);
        commitSha = (await runGit(['-C', worktree, 'rev-parse', 'HEAD'])).trim();
      }

      // 5. Run validation commands in the sandbox against the worktree
      const verifyResults: PatchResult['verifyResults'] = [];
      let allOk = true;
      for (const cmd of req.verifyCommands) {
        const result = await this.sandbox.run({
          command: cmd,
          cwd: '/workspace',
          workspaceMounts: [{ host: worktree, container: '/workspace' }],
          idempotencyKey: `${req.runId}:${cmd}`,
          timeoutMs: 60_000,
        });
        verifyResults.push({ command: cmd, result });
        if (!result.ok) allOk = false;
      }

      if (!allOk) {
        logger.warn({ runId: req.runId }, 'patch verification failed');
        return {
          ok: false,
          worktreePath: worktree,
          diff,
          commitSha,
          verifyResults,
          error: 'one or more verification commands failed',
        };
      }

      return { ok: true, worktreePath: worktree, diff, commitSha, verifyResults };
    } catch (e) {
      const err = e as Error;
      return {
        ok: false,
        worktreePath: worktree,
        diff: '',
        verifyResults: [],
        error: err.message,
      };
    }
  }

  async cleanup(worktreePath: string, repoPath: string): Promise<void> {
    if (worktreePath) {
      try {
        await runGit(['-C', repoPath, 'worktree', 'remove', '--force', worktreePath]);
      } catch {
        // best effort
      }
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}
