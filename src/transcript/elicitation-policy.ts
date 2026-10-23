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

/**
 * Tools that modify state (filesystem, shell, external systems) and
 * require user confirmation before execution. The elicitation gate
 * pauses tool execution until the user clicks Allow/Deny.
 *
 * Read-only tools (read_file, list_tree, web_search, etc.) skip the
 * elicitation gate entirely — they're safe to execute without confirmation.
 */
export const DANGEROUS_TOOLS = new Set([
  'write_file', 'write_files',
  'delete_path',
  'run_shell', 'run_code',
  'clone_repo',
  'edit_image',
  'generate_image',
  'index_document',
  'text_to_speech',
]);

export function isDangerousTool(name: string): boolean {
  // Exact match first
  if (DANGEROUS_TOOLS.has(name)) return true;
  // Heuristic: names containing write/delete/edit/run/clone/install are dangerous
  const lower = name.toLowerCase();
  return /\b(write|delete|edit|run|clone|install|remove|execute|shred|chmod|chown)\b/i.test(lower)
    || /\b(bash|sh|exec|cmd|rm)\b/i.test(lower);
}
