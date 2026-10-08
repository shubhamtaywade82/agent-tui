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
 */
import { exec } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../observability/logger.js';
import type { SandboxExecutor, SandboxResult } from '../sandbox/executor.js';

const execAsync = promisify(exec);

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

export class PatchWorkflow {
  constructor(private readonly sandbox: SandboxExecutor) {}

  async apply(req: PatchRequest): Promise<PatchResult> {
    // 1. Create a worktree on a temp branch
    const worktree = await mkdtemp(join(tmpdir(), 'supervisor-patch-'));
    try {
      await execAsync(
        `git -C ${req.repoPath} worktree add -b ${req.branch}-review ${worktree} ${req.branch}`,
      );

      // 2. Apply file changes
      for (const [relPath, content] of Object.entries(req.files)) {
        const abs = join(worktree, relPath);
        await mkdir(join(abs, '..'), { recursive: true });
        if (content === '') {
          await execAsync(`rm -f ${abs}`);
        } else {
          await writeFile(abs, content, 'utf8');
        }
      }

      // 3. Stage all changes and produce a diff
      await execAsync(`git -C ${worktree} add -A`);
      const { stdout: diff } = await execAsync(`git -C ${worktree} diff --cached`);

      // 4. Optionally commit (still on the temp branch)
      let commitSha: string | undefined;
      if (req.commitMessage) {
        await execAsync(
          `git -C ${worktree} -c user.email=supervisor-bot@local -c user.name=Supervisor commit -m ${JSON.stringify(req.commitMessage)}`,
        );
        const { stdout: sha } = await execAsync(`git -C ${worktree} rev-parse HEAD`);
        commitSha = sha.trim();
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
    try {
      await execAsync(`git -C ${repoPath} worktree remove --force ${worktreePath}`);
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
