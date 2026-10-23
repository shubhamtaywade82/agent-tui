/**
 * Async child-process runner for agent tools.
 *
 * Tools execute inside the Ink render loop and the HTTP API's event loop. A
 * synchronous spawn blocks both for the full timeout, so the UI freezes and
 * `/health` stops answering while a shell command runs. This wrapper resolves
 * with the outcome instead of throwing, so callers format output in one place.
 */
import { execFile } from 'node:child_process';

/**
 * Variables a tool child may inherit. Everything else is withheld, so API keys
 * and tokens in the parent environment never reach model-generated commands.
 * Proxy variables stay because outbound HTTPS depends on them.
 */
const INHERITED_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'SHELL', 'PWD',
  'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
]);

/**
 * Environment for a tool child: the allowlist above, plus names listed in
 * AGENT_TOOL_ENV_PASSTHROUGH (comma-separated) for operators who need more, such
 * as SSH_AUTH_SOCK for git over SSH. `extra` is merged last.
 */
export function sandboxEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const passthrough = new Set(
    (process.env.AGENT_TOOL_ENV_PASSTHROUGH ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (INHERITED_ENV.has(upper) || upper.startsWith('LC_') || passthrough.has(upper)) env[key] = value;
  }
  return { ...env, ...extra };
}

export interface RunProcessOptions {
  cwd?: string;
  /** Child environment. Omitted means the child inherits the full parent environment; tools pass `sandboxEnv()`. */
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBufferBytes: number;
  /** Run `file` through the platform shell. Used by `run_shell` only. */
  shell?: boolean;
}

export interface ProcessOutcome {
  /** Exit code, or null when the process never exited normally (timeout, signal, spawn failure). */
  exitCode: number | null;
  /** True when the timeout fired and the child was killed. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Node's error message for failures without an exit code (ENOENT, maxBuffer exceeded). */
  errorMessage?: string;
}

/** Spawn `file` without blocking the event loop. Never rejects; failures are reported in the outcome. */
export function runProcess(
  file: string,
  args: readonly string[],
  opts: RunProcessOptions,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBufferBytes,
        encoding: 'utf8',
        shell: opts.shell ?? false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '');
        const errOut = String(stderr ?? '');
        if (!error) {
          resolve({ exitCode: 0, timedOut: false, stdout: out, stderr: errOut });
          return;
        }
        // A timeout kills the child and reports `killed` with a non-string code.
        // A maxBuffer overflow also kills it, but its code is a string
        // (ERR_CHILD_PROCESS_STDIO_MAXBUFFER), so it is not counted as a timeout.
        const e = error as NodeJS.ErrnoException & { killed?: boolean };
        resolve({
          exitCode: typeof e.code === 'number' ? e.code : null,
          timedOut: e.killed === true && typeof e.code !== 'string',
          stdout: out,
          stderr: errOut,
          errorMessage: e.message,
        });
      },
    );
  });
}
