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
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../logger.js';
import { resolvePath } from '../config.js';
import { runProcess, sandboxEnv, type ProcessOutcome } from './process.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 6000;

function truncate(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}

/** Render a non-zero, timed-out, or failed-to-spawn outcome for the model. */
function formatFailure(r: ProcessOutcome, timeoutMs: number): string {
  const status = r.timedOut ? 'timeout' : (r.exitCode ?? 'error');
  const out = r.stdout ? `--- stdout ---\n${truncate(r.stdout)}\n` : '';
  const errText = r.stderr ? `--- stderr ---\n${truncate(r.stderr)}\n` : '';
  let detail = '';
  if (r.timedOut) detail = `--- error ---\nTimed out after ${timeoutMs} ms\n`;
  else if (r.exitCode === null && r.errorMessage) detail = `--- error ---\n${r.errorMessage}`;
  return `Exit: ${status}\n${out}${errText}${detail}`;
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
      const r = await runProcess(runner, args, {
        cwd: dir,
        env: sandboxEnv({ NODE_NO_WARNINGS: '1' }),
        timeoutMs: timeout,
        maxBufferBytes: 2 * 1024 * 1024,
      });
      if (r.exitCode === 0) return `Exit: 0\n--- stdout ---\n${truncate(r.stdout)}`;
      return formatFailure(r, timeout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

/**
 * Guardrail for `run_shell`. It catches the common destructive commands a model
 * produces, but it is not a security boundary: `$(...)`, backticks, aliases and
 * scripts it cannot see are not analysed. The human approval gate in the TUI is
 * the boundary. Returns the reason for a block, or null when the command passes.
 */
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'nohup', 'env', 'time', 'nice', 'builtin']);
const POWER_COMMANDS = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);
const HOME_TARGETS = new Set([
  '/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*', '${HOME}', '${HOME}/', '${HOME}/*',
]);

export function checkCommandPolicy(command: string): string | null {
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) return 'fork bomb';
  if (/\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|fish)\b/.test(command)) return 'download piped into a shell';
  if (/>\s*\/dev\/(sd[a-z]|hd[a-z]|nvme\d|disk\d|mmcblk)/.test(command)) return 'write to a block device';

  for (const segment of command.split(/&&|\|\||;|\||\n|&/)) {
    const tokens = segment.trim().split(/\s+/).map((t) => t.replace(/["']/g, '')).filter(Boolean);
    while (tokens.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!) || WRAPPERS.has(tokens[0]!.split('/').pop()!))) {
      tokens.shift();
    }
    if (tokens.length === 0) continue;
    const cmd = tokens[0]!.split('/').pop()!;
    const args = tokens.slice(1);
    const targets = args.filter((t) => !t.startsWith('-'));

    if (cmd.startsWith('mkfs')) return 'mkfs';
    if (POWER_COMMANDS.has(cmd)) return cmd;
    if (cmd === 'dd' && args.some((t) => t.startsWith('of=/dev/'))) return 'dd to a device';
    if (args.includes('--no-preserve-root')) return '--no-preserve-root';

    const shortFlags = args.filter((t) => /^-[A-Za-z]+$/.test(t)).join('');
    const recursive = /[rR]/.test(shortFlags) || args.includes('--recursive');
    if ((cmd === 'rm' || cmd === 'chmod' || cmd === 'chown') && recursive) {
      const hit = targets.find((t) => HOME_TARGETS.has(t));
      if (hit) return `recursive ${cmd} on ${hit}`;
    }
  }
  return null;
}

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
    const blocked = checkCommandPolicy(command);
    if (blocked) {
      log.warn('run_shell blocked', { reason: blocked, cmd: command.slice(0, 80) });
      return `Blocked by command policy (${blocked}).`;
    }
    const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000);
    const workDir = cwd ? resolvePath(cwd) : process.cwd();
    log.info('run_shell', { cmd: command.slice(0, 80), cwd: workDir, timeout });
    const r = await runProcess(command, [], {
      cwd: workDir,
      env: sandboxEnv(),
      timeoutMs: timeout,
      maxBufferBytes: 4 * 1024 * 1024,
      shell: true,
    });
    if (r.exitCode === 0) return `Exit: 0\n${truncate(r.stdout)}`;
    return formatFailure(r, timeout);
  },
});

export const execTools = [runCodeTool, runShellTool];
