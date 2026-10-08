/**
 * Sandbox command policy — §11.2 (Terminal Command Policy).
 *
 * Allowlist/denylist + working directory + env var + output size + timeout
 * gates. The MiniCPM5 review explicitly calls out that MiniCPM5-2B is
 * weaker on long-horizon terminal work (Terminal-Bench v2.1 score 8.6);
 * the sandbox reduces the cost of model mistakes by validating every
 * command before execution (§11.3).
 */

const DEFAULT_ALLOWLIST = [
  /^ls(\s|$)/,
  /^cat(\s|$)/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
  /^grep(\s|$)/,
  /^rg(\s|$)/,
  /^find(\s|$)/,
  /^wc(\s|$)/,
  /^sort(\s|$)/,
  /^uniq(\s|$)/,
  /^diff(\s|$)/,
  /^git\s+(status|log|diff|show|branch| blame| stash list)/,
  /^pytest(\s|$)/,
  /^npm\s+(test|run\s+test|ci)/,
  /^node\s+--test(\s|$)/,
  /^tsc(\s|$)/,
  /^biome\s+check(\s|$)/,
  /^ruff(\s|$)/,
  /^mypy(\s|$)/,
  /^echo(\s|$)/,
  /^pwd(\s|$)/,
  /^env(\s|$)/,
];

const DEFAULT_DENYLIST = [
  /\brm\s+-rf?\s+/,
  /:\(\)\s*\{\s*:\|:&\s*\}\};:/, // fork bomb
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /curl\s+.*\|\s*(sh|bash|zsh)/,
  /\bwget\s+.*\|\s*(sh|bash|zsh)/,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bchown\s+-R\b/,
  /\bdocker\s+(push|rm|kill|stop|rmi)/,
  /\bkubectl\s+(delete|edit|apply)\b/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  />\/dev\/(sd|nvme|disk)/,
  /\bnc\s+-l\b/,
  /\bshutdown\b/,
  /\breboot\b/,
];

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  matchedAllow?: string;
  matchedDeny?: string;
}

export class CommandPolicy {
  constructor(
    private readonly allowlist: RegExp[] = DEFAULT_ALLOWLIST,
    private readonly denylist: RegExp[] = DEFAULT_DENYLIST,
    private readonly opts: {
      allowedCwd?: string;
      maxOutputBytes?: number;
      timeoutMs?: number;
      allowedEnvPrefixes?: string[];
    } = {},
  ) {}

  evaluate(command: string): PolicyDecision {
    const trimmed = command.trim();
    if (!trimmed) return { allowed: false, reason: 'empty command' };

    // Denylist first — deny always wins
    for (const re of this.denylist) {
      if (re.test(trimmed)) {
        return {
          allowed: false,
          matchedDeny: re.source,
          reason: `denylist match: ${re.source.slice(0, 60)}`,
        };
      }
    }

    // Allowlist
    let matchedAllow: string | undefined;
    const allowed = this.allowlist.some((re) => {
      if (re.test(trimmed)) {
        matchedAllow = re.source;
        return true;
      }
      return false;
    });
    if (!allowed) {
      return { allowed: false, reason: 'not on allowlist' };
    }
    return { allowed: true, matchedAllow };
  }

  /** Validate env vars before they reach the sandbox container. */
  evaluateEnv(env: Record<string, string>): { allowed: Record<string, string>; blocked: string[] } {
    const prefixes = this.opts.allowedEnvPrefixes ?? [
      'PATH',
      'HOME',
      'LANG',
      'LC_',
      'NODE_',
      'CI_',
    ];
    const allowed: Record<string, string> = {};
    const blocked: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      // A prefix matches if it equals the key OR the key starts with the prefix
      // (the prefix may or may not end with `_` — we don't double-append).
      if (prefixes.some((p) => k === p || k.startsWith(p))) {
        allowed[k] = v;
      } else {
        blocked.push(k);
      }
    }
    return { allowed, blocked };
  }

  get maxOutputBytes(): number {
    return this.opts.maxOutputBytes ?? 1024 * 1024;
  }

  get timeoutMs(): number {
    return this.opts.timeoutMs ?? 30_000;
  }

  get allowedCwd(): string | undefined {
    return this.opts.allowedCwd;
  }
}
