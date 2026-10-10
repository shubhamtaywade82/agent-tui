/**
 * Unattended / "yolo" mode — auto-continue through plan steps and turn limits
 * without Y/N prompts in the TUI (and via env for any entry point).
 */

const AUTO_FLAGS = new Set(['--auto', '--yolo']);

export function argvHasAutoFlag(argv: readonly string[]): boolean {
  return argv.some((a) => AUTO_FLAGS.has(a));
}

export function isAutoMode(argv?: readonly string[]): boolean {
  if (argvHasAutoFlag(argv ?? process.argv)) return true;
  const v = process.env.AGENT_AUTO?.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function stripAutoFlags(argv: readonly string[]): string[] {
  return argv.filter((a) => !AUTO_FLAGS.has(a));
}

export function autoMaxChains(): number {
  const raw = process.env.AGENT_AUTO_MAX_CHAINS;
  if (!raw) return 50;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}
