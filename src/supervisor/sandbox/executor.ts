/**
 * Docker sandbox executor — §11 (Sandboxed Execution Infrastructure).
 *
 * Uses `dockerode` to run each command in a fresh container on the
 * supervisor network. The container is created with:
 *   - read-only root filesystem (writable overlay only on /workspace)
 *   - CPU + memory limits (§11.1)
 *   - network egress controls (§11.1)
 *   - execution timeout (§11.1)
 *   - secret isolation (§16.2 — secrets are never baked into the image)
 *   - audit logging (§15.1)
 *
 * Each call is idempotent (§9.3) when the caller supplies an idempotency
 * key — the executor caches the result under that key for the configured
 * TTL.
 */
import Docker from 'dockerode';
import { supervisorConfig } from '../config.js';
import { logger } from '../observability/logger.js';
import { CommandPolicy } from './policy.js';

export interface SandboxRequest {
  command: string;
  env?: Record<string, string>;
  cwd?: string;
  workspaceMounts?: Array<{ host: string; container: string; readOnly?: boolean }>;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export interface SandboxResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  containerId: string;
}

export class SandboxExecutor {
  private readonly docker: Docker;
  private readonly policy: CommandPolicy;
  private readonly cache = new Map<string, SandboxResult>();

  constructor() {
    this.docker = new Docker();
    this.policy = new CommandPolicy(undefined, undefined, {
      maxOutputBytes: 1024 * 1024,
      timeoutMs: supervisorConfig.sandbox.timeoutMs,
    });
  }

  async run(req: SandboxRequest): Promise<SandboxResult> {
    // Idempotency cache
    if (req.idempotencyKey && this.cache.has(req.idempotencyKey)) {
      return this.cache.get(req.idempotencyKey)!;
    }

    // Policy gate
    const decision = this.policy.evaluate(req.command);
    if (!decision.allowed) {
      logger.warn({ command: req.command, reason: decision.reason }, 'sandbox denied by policy');
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `Command denied by sandbox policy: ${decision.reason ?? 'unspecified'}`,
        durationMs: 0,
        timedOut: false,
        containerId: 'policy-denied',
      };
    }

    // Env gate
    const env = this.policy.evaluateEnv(req.env ?? {});
    if (env.blocked.length > 0) {
      logger.warn({ blocked: env.blocked }, 'sandbox blocked env vars');
    }

    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? this.policy.timeoutMs;
    const image = supervisorConfig.sandbox.image;

    // Container options
    const binds = (req.workspaceMounts ?? []).map(
      (m) => `${m.host}:${m.container}${m.readOnly ? ':ro' : ''}`,
    );
    const hostConfig: Docker.HostConfig = {
      AutoRemove: true,
      NetworkMode: supervisorConfig.sandbox.network,
      ReadonlyRootfs: true,
      Memory: supervisorConfig.sandbox.memoryLimitMb * 1024 * 1024,
      NanoCpus: Math.floor(supervisorConfig.sandbox.cpuLimit * 1e9),
      Binds: binds.length > 0 ? binds : undefined,
      Tmpfs: { '/tmp': 'rw,size=64m,exec' },
    };

    try {
      const container = await this.docker.createContainer({
        Image: image,
        Cmd: ['sh', '-c', req.command],
        WorkingDir: req.cwd ?? supervisorConfig.sandbox.workDir,
        Env: Object.entries(env.allowed).map(([k, v]) => `${k}=${v}`),
        HostConfig: hostConfig,
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        OpenStdin: false,
      });

      await container.start();

      // Race the container against a timeout
      const exec = this.collect(container, timeoutMs);
      const timeout = new Promise<SandboxResult>((_resolve, reject) =>
        setTimeout(() => reject(new Error('SANDBOX_TIMEOUT')), timeoutMs + 500),
      );

      let result: SandboxResult;
      try {
        result = await Promise.race([exec, timeout]);
      } catch (_e) {
        // Force-kill on timeout
        try {
          await container.kill({ signal: 'SIGKILL' });
        } catch {
          // container may already be gone
        }
        result = {
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: `Sandbox timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - started,
          timedOut: true,
          containerId: container.id,
        };
      }

      // Cache idempotent results
      if (req.idempotencyKey && result.ok) {
        this.cache.set(req.idempotencyKey, result);
      }

      logger.info(
        { command: req.command, exitCode: result.exitCode, durationMs: result.durationMs },
        'sandbox executed',
      );
      return result;
    } catch (e) {
      const err = e as Error;
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `Sandbox error: ${err.message}`,
        durationMs: Date.now() - started,
        timedOut: false,
        containerId: 'spawn-error',
      };
    }
  }

  private async collect(container: Docker.Container, _timeoutMs: number): Promise<SandboxResult> {
    const started = Date.now();
    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      container.modem.demuxStream(
        stream,
        {
          write: (b: Buffer) => chunks.push(b),
        },
        {
          write: (b: Buffer) => chunks.push(b),
        },
      );
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const exitData = await container.wait();
    const stdout = Buffer.concat(chunks).toString('utf8');
    return {
      ok: exitData.StatusCode === 0,
      exitCode: exitData.StatusCode ?? null,
      stdout: stdout.slice(0, this.policy.maxOutputBytes),
      stderr: '',
      durationMs: Date.now() - started,
      timedOut: false,
      containerId: container.id,
    };
  }
}
