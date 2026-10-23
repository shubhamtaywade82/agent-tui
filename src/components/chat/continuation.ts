/**
 * Decides what the chat offers to continue after a turn ends: the next ready task,
 * or a turn-limit continuation. Also cleans up the inline completion suggestion.
 */
import { buildTaskPrompt, getTaskRuntime } from '../../tasks.js';

export interface PendingContinuation { type: 'task' | 'turn_limit'; taskId?: string; label: string; detail?: string; prompt: string; }

export const isPrematureStall = (t: string): boolean =>
  t.length <= 300 && /(let me|i('ll| will))\s+(start|inspect|check|create|look|run|examine|verify|see|read|find)/i.test(t);
export const cleanContinuation = (inp: string, acc: string): string => {
  const norm = inp.trim().toLowerCase(); const c = acc.replace(/^["']|["']$/g, '').split('\n')[0]?.trim() || '';
  if (!c || norm.startsWith(c.toLowerCase())) return '';
  if (c.toLowerCase().startsWith(norm)) return c.slice(norm.length).trimStart();
  const inW = norm.split(/\s+/); const accW = c.toLowerCase().split(/\s+/);
  for (let i = Math.min(inW.length, accW.length); i > 0; i--) if (inW.slice(-i).join(' ') === accW.slice(0, i).join(' ')) return c.split(/\s+/).slice(i).join(' ');
  return c;
};

export function resolvePendingContinuation(isDone: boolean): PendingContinuation | null {
  const rt = getTaskRuntime();
  const next = rt.nextReady();
  if (next) {
    return {
      type: 'task',
      taskId: next.id,
      label: `Next Task: [${next.id}] ${next.title}`,
      detail: next.objective,
      prompt: buildTaskPrompt(next),
    };
  }
  if (!isDone) {
    return {
      type: 'turn_limit',
      label: 'Step Limit Reached with Pending Work',
      detail: 'Would you like to continue execution from where it left off?',
      prompt: 'Please continue execution directly from where you left off. Proceed with the remaining tasks and verify the implementation.',
    };
  }
  return null;
}
