/**
 * Code-change executor — Phase 5.
 *
 * Handles CODE_CHANGE tasks end-to-end:
 *
 *   1. Ask the analyst model for a structured patch proposal
 *      (Zod-validated: files, branch, verifyCommands, commitMessage).
 *   2. Validate the proposal against PatchProposalSchema.
 *   3. Apply the patch via PatchWorkflow in an isolated git worktree.
 *   4. Run the configured verification commands in the sandbox.
 *   5. Only return success if verification passes — the model's claim
 *      that "tests passed" is NOT accepted as evidence. The actual
 *      exit codes from the sandbox are the authoritative signal.
 *
 * This closes the loop the implementation spec demanded: "a code
 * task can inspect, patch, test, repair, and verify within configured
 * boundaries, and a rejected or simulated action can never be
 * reported as real success."
 *
 * ## Why a separate executor (not the generic Supervisor.run path)
 *
 * The generic path runs the analyst and accepts its output as the
 * task's result. For CODE_CHANGE, the model's output is a PROPOSAL,
 * not a result — it must be executed and verified before the task
 * can be SUCCEEDED. Routing CODE_CHANGE through this executor keeps
 * the "model proposes, harness verifies" contract explicit.
 */
import { z } from 'zod';
import type { PatchWorkflow } from '../code/patch.js';
import { supervisorConfig } from '../config.js';
import type { Backend } from '../inference/backend.js';
import { logger } from '../observability/logger.js';
import { zodParseFailureCounter } from '../observability/telemetry.js';

/**
 * Structured patch proposal emitted by the analyst model.
 *
 * - `files`: relative path → new file content. Empty string = delete.
 * - `branch`: the git branch to base the worktree on.
 * - `verifyCommands`: commands to run after applying the patch
 *   (e.g. `npm test`). The configured `defaultVerifyCommands` are
 *   always appended — the model cannot skip verification.
 * - `commitMessage`: optional; if present, the patch is committed
 *   on the worktree's review branch.
 *
 * The model must NOT emit:
 *   - absolute paths (rejected by resolveInside in PatchWorkflow)
 *   - paths with `..` segments (rejected)
 *   - paths through symlinks (rejected at apply time)
 *   - shell commands in `verifyCommands` that bypass the sandbox
 *     policy (rejected by CommandPolicy)
 */
export const PatchProposalSchema = z
  .object({
    files: z.record(z.string(), z.string()),
    branch: z
      .string()
      .min(1)
      .max(128)
      .refine(
        // Git branch names: a letter or digit first, then letters, digits, ., _, -, /.
        (b) =>
          /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b) &&
          !b.includes('..') &&
          !b.endsWith('/') &&
          !b.endsWith('.lock'),
        'invalid git branch name',
      ),
    verifyCommands: z.array(z.string().min(1)).default([]),
    commitMessage: z.string().min(1).max(512).optional(),
    /** Human-readable rationale for the change — recorded for audit. */
    rationale: z.string().max(2048).optional(),
  })
  .superRefine((data, ctx) => {
    const fileCount = Object.keys(data.files).length;
    if (fileCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: 'at least one file must be changed',
      });
    }
    if (fileCount > supervisorConfig.patch.maxFilesPerPatch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: `patch touches more than ${supervisorConfig.patch.maxFilesPerPatch} files`,
      });
    }
    const totalBytes = Object.values(data.files).reduce(
      (sum: number, c) => sum + (typeof c === 'string' ? c.length : 0),
      0,
    );
    if (totalBytes > supervisorConfig.patch.maxPatchBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: `patch exceeds ${supervisorConfig.patch.maxPatchBytes} bytes`,
      });
    }
  });
export type PatchProposal = z.infer<typeof PatchProposalSchema>;

export interface CodeChangeRequest {
  /** The task objective (free-text, injected into the analyst's prompt). */
  objective: string;
  /** The runId that owns this attempt — recorded on the PatchWorkflow. */
  runId: string;
  /** Absolute path to the repository root. MUST be absolute. */
  repoPath: string;
  /** Caller-authorised filesystem scope (propagated from the goal). */
  allowedPaths?: string[];
  /** Caller identity (for audit). */
  userId?: string;
  projectId?: string;
}

export interface CodeChangeResult {
  /** True iff the patch was applied AND all verification commands passed. */
  ok: boolean;
  /** The structured proposal (validated). Undefined if the model emitted invalid output. */
  proposal?: PatchProposal;
  /** The diff produced by `git diff --cached` in the worktree. */
  diff: string;
  /** The commit SHA, if the patch was committed. */
  commitSha?: string;
  /** Per-command verification results (authoritative — NOT model-claimed). */
  verifyResults: Array<{
    command: string;
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
  }>;
  /** The raw model output (for diagnosis on failure). */
  rawOutput: string;
  /** Validation errors if the proposal failed schema validation. */
  errors: string[];
  /** Human-readable error message on failure. */
  error?: string;
}

const SYSTEM_PROMPT = `You are the MiniCPM5 code-change agent. Produce a structured patch proposal for the given objective.

Output ONLY a JSON object of the form:
{"files":{"<relative-path>":"<new content>"},"branch":"<git-branch>","verifyCommands":["<cmd>"],"commitMessage":"<msg>","rationale":"<why>"}

Rules:
- "files" maps relative paths (from the repo root) to their new content. Use an empty string to delete a file.
- Never emit absolute paths or paths with ".." segments — they will be rejected.
- "branch" is the git branch to base the worktree on (must already exist).
- "verifyCommands" are run after the patch is applied; the harness ALSO runs its own default commands, so you only need to add task-specific ones.
- The harness runs the actual verification — your claim that "tests pass" is not accepted as evidence.
- Do not include prose, markdown, or commentary outside the JSON object.`;

export class CodeChangeExecutor {
  constructor(
    private readonly backend: Backend,
    private readonly analystModel: string,
    private readonly patchWorkflow: PatchWorkflow,
  ) {}

  async execute(req: CodeChangeRequest): Promise<CodeChangeResult> {
    // 1. Ask the analyst for a structured patch proposal.
    const r = await this.backend.invoke({
      model: this.analystModel,
      prompt: `${SYSTEM_PROMPT}\n\n# Objective\n${req.objective}`,
      formatJson: true,
      temperature: 0.1,
      maxOutputTokens: 4096,
    });

    // 2. Validate the proposal against the schema.
    if (!r.parsed || typeof r.json !== 'object' || r.json === null) {
      return {
        ok: false,
        diff: '',
        verifyResults: [],
        rawOutput: r.content,
        errors: ['model output is not a JSON object'],
        error: 'model output is not a JSON object',
      };
    }
    const parseResult = PatchProposalSchema.safeParse(r.json);
    if (!parseResult.success) {
      zodParseFailureCounter.add(1, { model: this.analystModel, schema: 'PatchProposalSchema' });
      const errors = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return {
        ok: false,
        diff: '',
        verifyResults: [],
        rawOutput: r.content,
        errors,
        error: `patch proposal schema-invalid: ${errors.join('; ')}`,
      };
    }
    const proposal = parseResult.data;

    // 3. Merge the model's verifyCommands with the configured defaults.
    // The defaults ALWAYS run — the model cannot skip verification.
    const verifyCommands = [
      ...proposal.verifyCommands,
      ...supervisorConfig.patch.defaultVerifyCommands,
    ];

    // 4. Apply the patch via PatchWorkflow in an isolated git worktree.
    logger.info(
      { runId: req.runId, fileCount: Object.keys(proposal.files).length, branch: proposal.branch },
      'code-change: applying patch proposal',
    );
    const patchResult = await this.patchWorkflow.apply({
      runId: req.runId,
      repoPath: req.repoPath,
      branch: proposal.branch,
      files: proposal.files,
      verifyCommands,
      commitMessage: proposal.commitMessage,
    });

    // 5. Clean up the worktree (unless configured otherwise for debugging).
    if (supervisorConfig.patch.cleanupWorktree && patchResult.worktreePath) {
      await this.patchWorkflow
        .cleanup(patchResult.worktreePath, req.repoPath)
        .catch(() => undefined);
    }

    // 6. Map the authoritative verification results.
    const verifyResults = patchResult.verifyResults.map((v) => ({
      command: v.command,
      ok: v.result.ok,
      exitCode: v.result.exitCode,
      stdout: v.result.stdout,
      stderr: v.result.stderr,
      durationMs: v.result.durationMs,
      timedOut: v.result.timedOut,
    }));

    if (!patchResult.ok) {
      return {
        ok: false,
        proposal,
        diff: patchResult.diff,
        commitSha: patchResult.commitSha,
        verifyResults,
        rawOutput: r.content,
        errors: [],
        error: patchResult.error ?? 'patch verification failed',
      };
    }

    return {
      ok: true,
      proposal,
      diff: patchResult.diff,
      commitSha: patchResult.commitSha,
      verifyResults,
      rawOutput: r.content,
      errors: [],
    };
  }
}
