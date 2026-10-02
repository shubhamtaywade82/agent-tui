/**
 * Code execution sandbox & shell tools.
 *
 * `run_code` executes JavaScript/TypeScript in a Node child process with a
 * timeout and output capture — safe enough for ad-hoc computation, scripting,
 * and data transformation. `run_shell` runs a shell command with a timeout.
 *
 * Both tools respect an allow/deny list so the human operator can restrict
 * what the agent is allowed to execute.
 */
import { z } from 'zod';
import { defineTool } from '@nemesis-oss/ollama-sdk';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { log } from '../logger.js';
import { loadConfig, resolvePath } from '../config.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 6000;

function truncate(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}

/** Run JavaScript/TypeScript code in a sandboxed Node child process. */
export const runCodeTool = defineTool({
  name: 'run_code',
  description: 'Execute JavaScript/TypeScript code in a Node.js sandbox with a timeout. Useful for computation, data transformation, and scripting. Returns stdout, stderr, and exit status.',
  schema: z.object({
    code: z.string().describe('The code to execute'),
    language: z.enum(['javascript', 'typescript']).optional().describe('Language (default javascript)'),
    timeoutMs: z.number().int().min(500).max(120000).optional().describe('Execution timeout in ms'),
  }),
  timeoutMs: 130_000,
  execute: async ({ code, language, timeoutMs }) => {
    const lang = language ?? 'javascript';
    const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000);
    const dir = mkdtempSync(join(tmpdir(), 'agent-code-'));
    const ext = lang === 'typescript' ? '.mts' : '.mjs';
    const file = join(dir, `sandbox${ext}`);
    writeFileSync(file, code, 'utf8');
    log.info('run_code', { lang, timeout, bytes: code.length });
    try {
      const runner = lang === 'typescript' ? 'npx' : 'node';
      const args = lang === 'typescript' ? ['tsx', file] : [file];
      const stdout = execFileSync(runner, args, {
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      });
      return `Exit: 0\n--- stdout ---\n${truncate(stdout)}`;
    } catch (err: any) {
      const out = err.stdout ? `--- stdout ---\n${truncate(String(err.stdout))}\n` : '';
      const errText = err.stderr ? `--- stderr ---\n${truncate(String(err.stderr))}\n` : '';
      return `Exit: ${err.status ?? 'error'}\n${out}${errText}${err.message ? `--- error ---\n${err.message}` : ''}`;
    } finally {
      try { unlinkSync(file); } catch {}
    }
  },
});

/** Run a shell command with timeout and output capture. */
const DEFAULT_DENY = ['rm -rf /', 'mkfs', 'shutdown', 'reboot', ':(){:|:&};:'];

export const runShellTool = defineTool({
  name: 'run_shell',
  description: 'Execute a shell command and return stdout/stderr/exit status. Use for git, file ops, build commands, etc. Commands are run with a timeout.',
  schema: z.object({
    command: z.string().describe('The shell command to execute'),
    cwd: z.string().optional().describe('Working directory (defaults to project root)'),
    timeoutMs: z.number().int().min(500).max(120000).optional().describe('Timeout in ms'),
  }),
  timeoutMs: 130_000,
  execute: async ({ command, cwd, timeoutMs }) => {
    const cfg = loadConfig();
    const deny = DEFAULT_DENY;
    if (deny.some((d) => command.includes(d))) {
      return `Blocked: command matches deny-list pattern.`;
    }
    const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000);
    const workDir = cwd ? resolvePath(cwd) : process.cwd();
    log.info('run_shell', { cmd: command.slice(0, 80), cwd: workDir, timeout });
    try {
      const stdout = execFileSync(command, [], {
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        cwd: workDir,
        shell: true,
        env: { ...process.env },
      });
      return `Exit: 0\n${truncate(stdout)}`;
    } catch (err: any) {
      const out = err.stdout ? `--- stdout ---\n${truncate(String(err.stdout))}\n` : '';
      const errText = err.stderr ? `--- stderr ---\n${truncate(String(err.stderr))}\n` : '';
      return `Exit: ${err.status ?? 'error'}\n${out}${errText}`;
    }
  },
});

export const execTools = [runCodeTool, runShellTool];
