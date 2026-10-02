/**
 * Structured logger & observability — JSON lines to file + pretty console.
 * Replaces the unused utils/observability.ts stub with a real implementation.
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadConfig, resolvePath } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  extra: Record<string, unknown>;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10, info: 20, warn: 30, error: 40, silent: 100,
};

let _level: LogLevel = 'info';
let _file = '';

export function initLogger(level?: LogLevel, file?: string): void {
  const cfg = loadConfig();
  _level = level ?? cfg.logLevel;
  _file = file ?? cfg.logFile;
  if (_file) {
    const abs = resolvePath(_file);
    const dir = dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function write(level: LogLevel, msg: string, ctx: Record<string, unknown>): void {
  const full: LogEntry = { ts: new Date().toISOString(), level, msg, extra: ctx };
  if (LEVEL_ORDER[level] >= LEVEL_ORDER[_level]) {
    if (_file) {
      try { appendFileSync(resolvePath(_file), JSON.stringify(full) + '\n', 'utf8'); } catch {}
    }
    // Pretty console
    const color = level === 'error' ? '\x1b[31m'
      : level === 'warn' ? '\x1b[33m'
      : level === 'debug' ? '\x1b[90m'
      : '\x1b[36m';
    const reset = '\x1b[0m';
    const ctxStr = Object.keys(ctx)
      .map((k) => `${k}=${typeof ctx[k] === 'string' ? ctx[k] : JSON.stringify(ctx[k])}`)
      .join(' ');
    process.stderr.write(`${color}[${level}]${reset} ${msg}${ctxStr ? ` ${color}${ctxStr}${reset}` : ''}\n`);
  }
}

export const log = {
  debug: (msg: string, ctx: Record<string, unknown> = {}) => write('debug', msg, ctx),
  info: (msg: string, ctx: Record<string, unknown> = {}) => write('info', msg, ctx),
  warn: (msg: string, ctx: Record<string, unknown> = {}) => write('warn', msg, ctx),
  error: (msg: string, ctx: Record<string, unknown> = {}) => write('error', msg, ctx),
};

/** Lightweight metrics accumulator for a single agent run. */
export class RunMetrics {
  private start = Date.now();
  private _tokens = { input: 0, output: 0 };
  private _toolCalls = 0;
  private _iterations = 0;

  incIteration(): void { this._iterations++; }
  incToolCall(): void { this._toolCalls++; }
  addTokens(input: number, output: number): void { this._tokens.input += input; this._tokens.output += output; }

  summary(): Record<string, number> {
    return {
      durationMs: Date.now() - this.start,
      iterations: this._iterations,
      toolCalls: this._toolCalls,
      inputTokens: this._tokens.input,
      outputTokens: this._tokens.output,
    };
  }
}

export function redactForLog(s: string): string {
  return s.replace(/(ghp_[A-Za-z0-9]{20,})|(sk-[A-Za-z0-9]{20,})|(sk-ant-[A-Za-z0-9]{20,})/g, '***REDACTED***');
}
