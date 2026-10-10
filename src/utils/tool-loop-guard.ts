/**
 * Detects repeated identical tool calls (common when context compaction hides
 * prior results). Blocks re-execution and returns a short cached hint instead.
 */

import { truncateToolOutput } from './context.js';

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${k}:${stableJson(obj[k])}`).join(',')}}`;
}

function normalizePaths(args: Record<string, unknown>): string[] {
  const raw = args.paths ?? args.path ?? args.file ?? args.files ?? args.target_files;
  if (Array.isArray(raw)) return raw.map(String).sort();
  if (typeof raw === 'string') return [raw];
  return [];
}

/** Stable key for "same tool + same target" detection. */
export function fingerprintToolCall(name: string, args: unknown): string {
  const n = name.toLowerCase().replace(/^(functions?|tools?)\./, '');
  const a = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const paths = normalizePaths(a);
  if (paths.length) return `${n}@${paths.join('|')}`;
  if (n === 'read_skill' || n === 'list_skills') {
    return `${n}@${String(a.name ?? a.query ?? a.skill ?? '')}`;
  }
  if (n === 'create_task' || n === 'complete_task' || n === 'start_task') {
    return `${n}@${String(a.id ?? a.taskId ?? '')}`;
  }
  if (a.query ?? a.q) return `${n}@${String(a.query ?? a.q)}`;
  if (a.command ?? a.cmd) return `${n}@${String(a.command ?? a.cmd)}`;
  return `${n}@${stableJson(a)}`;
}

export interface ToolLoopGuardOptions {
  /** Allow this many successful runs before blocking duplicates (default 2). */
  repeatLimit?: number;
}

export class ToolCallLedger {
  private readonly repeatLimit: number;
  private counts = new Map<string, number>();
  private lastOutput = new Map<string, string>();
  private labels = new Map<string, string>();

  constructor(opts: ToolLoopGuardOptions = {}) {
    this.repeatLimit = opts.repeatLimit ?? 2;
  }

  /** If blocked, returns the tool message body to inject (no execution). */
  beforeExecute(name: string, args: unknown): string | null {
    const fp = fingerprintToolCall(name, args);
    const count = this.counts.get(fp) ?? 0;
    if (count < this.repeatLimit) return null;
    const cached = this.lastOutput.get(fp);
    const label = this.labels.get(fp) ?? name;
    const hint = cached
      ? `Last result (abbreviated):\n${cached}`
      : 'Prior result was compacted from context — do not re-fetch; continue with edits, tests, or complete_task.';
    return (
      `[Loop guard] Blocked duplicate tool call (${count}× already): ${label}. ` +
      `Context pressure often causes re-read loops — use a different action.\n${hint}`
    );
  }

  afterExecute(name: string, args: unknown, output: string): void {
    const fp = fingerprintToolCall(name, args);
    this.counts.set(fp, (this.counts.get(fp) ?? 0) + 1);
    this.lastOutput.set(fp, truncateToolOutput(output, 1200));
    this.labels.set(fp, this.describe(name, args));
  }

  private describe(name: string, args: unknown): string {
    const a = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
    const paths = normalizePaths(a);
    if (paths.length) return `${name}(${paths.join(', ')})`;
    if (a.id) return `${name}(${a.id})`;
    return name;
  }

  /** One-line digest for compaction system notes. */
  compactionNote(): string | null {
    if (!this.labels.size) return null;
    const parts: string[] = [];
    for (const [fp, label] of this.labels) {
      const n = this.counts.get(fp) ?? 0;
      if (n > 0) parts.push(`${label}×${n}`);
    }
    if (!parts.length) return null;
    return `[Working set] Tools already used this run: ${parts.slice(0, 24).join('; ')}.`;
  }
}
