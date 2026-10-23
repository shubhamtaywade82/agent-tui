/**
 * Async child-process runner for agent tools.
 *
 * Tools execute inside the Ink render loop and the HTTP API's event loop. A
 * synchronous spawn blocks both for the full timeout, so the UI freezes and
 * `/health` stops answering while a shell command runs. This wrapper resolves
 * with the outcome instead of throwing, so callers format output in one place.
 */
import { execFile } from 'node:child_process';

export interface RunProcessOptions {
  cwd?: string;
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
