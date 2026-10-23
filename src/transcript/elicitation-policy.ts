/**
 * Which tool approvals may cover the rest of the session.
 *
 * "Allow session" caches approval per tool name. Shell and code execution and
 * destructive file operations therefore always prompt. Otherwise one approval
 * would cover every later command the model derives from web or file content.
 * Other dangerous tools, such as image generation, keep the session option.
 */
import type { ElicitationChoice } from './types.js';

export const ALWAYS_CONFIRM_TOOLS: ReadonlySet<string> = new Set([
  'run_shell',
  'run_code',
  'write_file',
  'write_files',
  'delete_path',
  'clone_repo',
]);

export function canRememberForSession(toolName: string): boolean {
  return !ALWAYS_CONFIRM_TOOLS.has(toolName);
}

/** The choice that applies. 'allow_session' is downgraded to 'allow_once' for tools that cannot be remembered. */
export function effectiveChoice(toolName: string, choice: ElicitationChoice): ElicitationChoice {
  return choice === 'allow_session' && !canRememberForSession(toolName) ? 'allow_once' : choice;
}
